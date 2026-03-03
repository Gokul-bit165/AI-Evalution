'use strict';

const express = require('express');
const fetch = require('node-fetch');
const pino = require('pino');
const { spawn } = require('child_process');
const path = require('path');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// =============================================================================
// CONFIGURATION
// =============================================================================

const CONFIG = Object.freeze({
  PORT: parseInt(process.env.PORT, 10) || 3000,
  HOST: process.env.HOST || '127.0.0.1',
  API_KEY: process.env.API_KEY,
  OLLAMA_URL: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL || 'qwen2.5:14b',
  REQUEST_TIMEOUT_MS: parseInt(process.env.REQUEST_TIMEOUT_MS, 10) || 60000,
  MAX_BODY_SIZE: process.env.MAX_BODY_SIZE || '2mb',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  NODE_ENV: process.env.NODE_ENV || 'development',
});

// Validate required configuration
if (!CONFIG.API_KEY || CONFIG.API_KEY.length < 32) {
  console.error('FATAL: API_KEY must be set and at least 32 characters');
  process.exit(1);
}

// =============================================================================
// LOGGER
// =============================================================================

const logger = pino({
  level: CONFIG.LOG_LEVEL,
  transport:
    CONFIG.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  base: { pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

// =============================================================================
// CONCURRENCY GUARD
// =============================================================================

class ConcurrencyGuard {
  constructor(maxConcurrent = 1) {
    this.maxConcurrent = maxConcurrent;
    this.activeRequests = 0;
    this.totalProcessed = 0;
    this.totalRejected = 0;
  }

  tryAcquire() {
    if (this.activeRequests >= this.maxConcurrent) {
      this.totalRejected++;
      return false;
    }
    this.activeRequests++;
    return true;
  }

  release() {
    if (this.activeRequests > 0) {
      this.activeRequests--;
      this.totalProcessed++;
    }
  }

  getStats() {
    return {
      active: this.activeRequests,
      maxConcurrent: this.maxConcurrent,
      totalProcessed: this.totalProcessed,
      totalRejected: this.totalRejected,
    };
  }
}

const concurrencyGuard = new ConcurrencyGuard(1);

// =============================================================================
// REQUEST METRICS TRACKER
// =============================================================================

class RequestMetrics {
  constructor() {
    this.totalProcessed = 0;
    this.totalFailed = 0;
    this.responseTimes = [];
    this.maxSamples = 1000; // rolling window
  }

  recordSuccess(durationMs) {
    this.totalProcessed++;
    this._pushDuration(durationMs);
  }

  recordFailure(durationMs) {
    this.totalFailed++;
    if (durationMs != null) this._pushDuration(durationMs);
  }

  _pushDuration(ms) {
    this.responseTimes.push(ms);
    if (this.responseTimes.length > this.maxSamples) {
      this.responseTimes.shift();
    }
  }

  getAverageResponseTime() {
    if (this.responseTimes.length === 0) return 0;
    const sum = this.responseTimes.reduce((a, b) => a + b, 0);
    return Math.round(sum / this.responseTimes.length);
  }

  getStats() {
    return {
      totalProcessed: this.totalProcessed,
      totalFailed: this.totalFailed,
      averageResponseTime: this.getAverageResponseTime(),
      sampleCount: this.responseTimes.length,
    };
  }
}

const requestMetrics = new RequestMetrics();

// =============================================================================
// GPU METRICS COLLECTOR (spawn-based, no memory buffering)
// =============================================================================

const GPU_NULL_RESPONSE = Object.freeze({
  gpuUtilization: null,
  memoryUsedMB: null,
  memoryTotalMB: null,
  temperatureC: null,
});

function getGpuMetrics() {
  return new Promise((resolve) => {
    let output = '';
    let killed = false;

    const proc = spawn('nvidia-smi', [
      '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu',
      '--format=csv,noheader,nounits',
    ]);

    const timeout = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
      logger.warn('nvidia-smi killed after 5s timeout');
      resolve({ error: 'nvidia-smi timeout', ...GPU_NULL_RESPONSE });
    }, 5000);

    proc.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      logger.debug({ stderr: chunk.toString() }, 'nvidia-smi stderr');
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      logger.warn({ error: err.message }, 'nvidia-smi spawn failed');
      resolve({ error: err.message, ...GPU_NULL_RESPONSE });
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (killed) return; // already resolved

      if (code !== 0 || !output.trim()) {
        logger.warn({ code }, 'nvidia-smi exited with non-zero code');
        return resolve({ error: 'GPU metrics unavailable', ...GPU_NULL_RESPONSE });
      }

      try {
        const parts = output.trim().split(',').map((s) => s.trim());
        if (parts.length < 4) throw new Error('Unexpected nvidia-smi output format');

        const [util, memUsed, memTotal, temp] = parts.map((v) => parseFloat(v));

        if ([util, memUsed, memTotal, temp].some((v) => isNaN(v))) {
          throw new Error('Non-numeric value in nvidia-smi output');
        }

        resolve({
          gpuUtilization: Math.round(util),
          memoryUsedMB: Math.round(memUsed),
          memoryTotalMB: Math.round(memTotal),
          temperatureC: Math.round(temp),
        });
      } catch (parseError) {
        logger.warn({ error: parseError.message, raw: output.slice(0, 200) }, 'nvidia-smi parse failed');
        resolve({ error: parseError.message, ...GPU_NULL_RESPONSE });
      }
    });
  });
}

// =============================================================================
// GPU METRICS CACHE (prevents nvidia-smi query storms)
// =============================================================================

const GPU_CACHE_TTL_MS = 3000;
let gpuCache = null;
let gpuCacheTime = 0;

async function getCachedGpuMetrics() {
  const now = Date.now();
  if (gpuCache && now - gpuCacheTime < GPU_CACHE_TTL_MS) {
    return gpuCache;
  }
  gpuCache = await getGpuMetrics();
  gpuCacheTime = now;
  return gpuCache;
}

// =============================================================================
// RESPONSE PARSER
// =============================================================================

const REQUIRED_FIELDS = [
  'code_quality',
  'key_requirements',
  'output_correctness',
  'best_practices',
  'final_score',
  'major_issues',
  'feedback',
];

function extractJSON(text) {
  // Try to find JSON in the response
  const jsonPatterns = [
    // Match ```json ... ``` blocks
    /```json\s*([\s\S]*?)\s*```/,
    // Match ``` ... ``` blocks
    /```\s*([\s\S]*?)\s*```/,
    // Match raw JSON object
    /(\{[\s\S]*\})/,
  ];

  for (const pattern of jsonPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      try {
        return JSON.parse(match[1].trim());
      } catch {
        continue;
      }
    }
  }

  // Try parsing the entire response as JSON
  try {
    return JSON.parse(text.trim());
  } catch {
    return null;
  }
}

function validateGradingResponse(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { valid: false, error: 'Response is not an object' };
  }

  const missing = REQUIRED_FIELDS.filter((field) => !(field in parsed));
  if (missing.length > 0) {
    return { valid: false, error: `Missing fields: ${missing.join(', ')}` };
  }

  // Validate numeric fields
  const numericFields = [
    'code_quality',
    'key_requirements',
    'output_correctness',
    'best_practices',
    'final_score',
  ];

  for (const field of numericFields) {
    if (typeof parsed[field] !== 'number' || isNaN(parsed[field])) {
      return { valid: false, error: `Field '${field}' must be a number` };
    }
  }

  // Validate major_issues is an array
  if (!Array.isArray(parsed.major_issues)) {
    return { valid: false, error: "'major_issues' must be an array" };
  }

  // Validate feedback is a string
  if (typeof parsed.feedback !== 'string') {
    return { valid: false, error: "'feedback' must be a string" };
  }

  return { valid: true, data: parsed };
}

// =============================================================================
// OLLAMA CLIENT
// =============================================================================

async function callOllama(prompt, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${CONFIG.OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.OLLAMA_MODEL,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0,
          num_predict: 4096,
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`Ollama returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    if (!data.response) {
      throw new Error('Ollama response missing "response" field');
    }

    return { success: true, response: data.response, stats: data };
  } catch (error) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      return { success: false, error: 'Request timeout', code: 'TIMEOUT' };
    }

    if (error.code === 'ECONNREFUSED') {
      return { success: false, error: 'Ollama not reachable', code: 'CONNECTION_ERROR' };
    }

    return { success: false, error: error.message, code: 'OLLAMA_ERROR' };
  }
}

// =============================================================================
// EXPRESS APP
// =============================================================================

const app = express();

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Cache-Control', 'no-store');
  res.removeHeader('X-Powered-By');
  next();
});

// Body parser with size limit
app.use(express.json({ limit: CONFIG.MAX_BODY_SIZE }));

// Request logging
app.use((req, res, next) => {
  const startTime = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip || req.connection.remoteAddress,
    });
  });
  next();
});

// =============================================================================
// AUTHENTICATION MIDDLEWARE
// =============================================================================

function authenticate(req, res, next) {
  const apiKey = req.headers['x-api-key'];

  if (!apiKey) {
    logger.warn({ ip: req.ip }, 'Missing API key');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing x-api-key header',
    });
  }

  // Constant-time comparison to prevent timing attacks
  if (apiKey.length !== CONFIG.API_KEY.length) {
    logger.warn({ ip: req.ip }, 'Invalid API key length');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key',
    });
  }

  let mismatch = 0;
  for (let i = 0; i < apiKey.length; i++) {
    mismatch |= apiKey.charCodeAt(i) ^ CONFIG.API_KEY.charCodeAt(i);
  }

  if (mismatch !== 0) {
    logger.warn({ ip: req.ip }, 'Invalid API key');
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid API key',
    });
  }

  next();
}

// =============================================================================
// ROUTES
// =============================================================================

// Health check (no auth required)
app.get('/health', (req, res) => {
  const stats = concurrencyGuard.getStats();
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    concurrency: stats,
  });
});

// Main evaluation endpoint
app.post('/evaluate', authenticate, async (req, res) => {
  const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  logger.info({ requestId }, 'Evaluation request received');

  // Validate request body
  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Request body must be a JSON object',
      requestId,
    });
  }

  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Missing or invalid "prompt" field',
      requestId,
    });
  }

  if (prompt.length < 10) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Prompt too short',
      requestId,
    });
  }

  if (prompt.length > 100000) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Prompt exceeds maximum length (100KB)',
      requestId,
    });
  }

  // Concurrency check
  if (!concurrencyGuard.tryAcquire()) {
    logger.warn({ requestId }, 'Concurrency limit reached');
    return res.status(503).json({
      error: 'Service Unavailable',
      message: 'Server busy, please retry',
      retryAfter: 5,
      requestId,
    });
  }

  const evalStart = Date.now();

  try {
    logger.info({ requestId, promptLength: prompt.length }, 'Calling Ollama');

    const ollamaResult = await callOllama(prompt, CONFIG.REQUEST_TIMEOUT_MS);
    const duration = Date.now() - evalStart;

    if (!ollamaResult.success) {
      logger.error(
        { requestId, error: ollamaResult.error, code: ollamaResult.code, duration },
        'Ollama call failed'
      );
      requestMetrics.recordFailure(duration);

      const statusCode = ollamaResult.code === 'TIMEOUT' ? 504 : 502;
      return res.status(statusCode).json({
        error: ollamaResult.code === 'TIMEOUT' ? 'Gateway Timeout' : 'Bad Gateway',
        message: ollamaResult.error,
        requestId,
      });
    }

    logger.info({ requestId, duration }, 'Ollama responded');

    // Parse response
    const parsed = extractJSON(ollamaResult.response);
    if (!parsed) {
      logger.error(
        { requestId, rawResponse: ollamaResult.response.slice(0, 500) },
        'Failed to extract JSON from response'
      );
      requestMetrics.recordFailure(duration);
      return res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to parse LLM response as JSON',
        requestId,
      });
    }

    // Validate response structure
    const validation = validateGradingResponse(parsed);
    if (!validation.valid) {
      logger.error({ requestId, validationError: validation.error }, 'Invalid response structure');
      requestMetrics.recordFailure(duration);
      return res.status(500).json({
        error: 'Internal Server Error',
        message: `Invalid response structure: ${validation.error}`,
        requestId,
      });
    }

    logger.info({ requestId, finalScore: validation.data.final_score, duration }, 'Evaluation complete');
    requestMetrics.recordSuccess(duration);

    return res.json(validation.data);
  } catch (error) {
    const duration = Date.now() - evalStart;
    logger.error({ requestId, error: error.message, stack: error.stack, duration }, 'Unexpected error');
    requestMetrics.recordFailure(duration);
    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'An unexpected error occurred',
      requestId,
    });
  } finally {
    concurrencyGuard.release();
  }
});

// =============================================================================
// INTERNAL MONITORING ROUTES
// =============================================================================

// Rate limiter: max 20 requests per 15s window per IP
const internalLimiter = rateLimit({
  windowMs: 15 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'Too Many Requests',
    message: 'Rate limit exceeded for monitoring endpoints',
  },
});

app.use('/internal', internalLimiter);

// Server status
app.get('/internal/status', authenticate, (req, res) => {
  const guard = concurrencyGuard.getStats();
  const metrics = requestMetrics.getStats();

  res.json({
    activeRequests: guard.active,
    maxConcurrent: guard.maxConcurrent,
    uptimeSeconds: Math.floor(process.uptime()),
    totalProcessed: metrics.totalProcessed,
    totalFailed: metrics.totalFailed,
    averageResponseTime: metrics.averageResponseTime,
    totalRejected: guard.totalRejected,
    memoryUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    timestamp: new Date().toISOString(),
  });
});

// GPU metrics (cached — 3s TTL prevents nvidia-smi storms)
app.get('/internal/gpu', authenticate, async (req, res) => {
  try {
    const gpu = await getCachedGpuMetrics();
    res.json(gpu);
  } catch (error) {
    logger.error({ error: error.message }, 'GPU metrics error');
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve GPU metrics',
    });
  }
});

// Dashboard (served as static HTML — auth checked by frontend via API calls)
app.get('/internal/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// Global error handler
app.use((err, req, res, next) => {
  // Handle body-parser errors
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Payload Too Large',
      message: `Request body exceeds ${CONFIG.MAX_BODY_SIZE} limit`,
    });
  }

  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      error: 'Bad Request',
      message: 'Invalid JSON in request body',
    });
  }

  logger.error({ error: err.message, stack: err.stack }, 'Unhandled error');
  res.status(500).json({
    error: 'Internal Server Error',
    message: 'An unexpected error occurred',
  });
});

// =============================================================================
// SERVER STARTUP
// =============================================================================

const server = app.listen(CONFIG.PORT, CONFIG.HOST, () => {
  logger.info(
    {
      host: CONFIG.HOST,
      port: CONFIG.PORT,
      model: CONFIG.OLLAMA_MODEL,
      timeout: CONFIG.REQUEST_TIMEOUT_MS,
      env: CONFIG.NODE_ENV,
    },
    'GPU Inference API started'
  );
});

// Graceful shutdown
const shutdown = async (signal) => {
  logger.info({ signal }, 'Shutdown signal received');

  server.close(() => {
    logger.info('HTTP server closed');

    // Wait for active requests to complete (max 10s)
    const checkInterval = setInterval(() => {
      const stats = concurrencyGuard.getStats();
      if (stats.active === 0) {
        clearInterval(checkInterval);
        logger.info('All requests completed, exiting');
        process.exit(0);
      }
    }, 100);

    setTimeout(() => {
      clearInterval(checkInterval);
      logger.warn('Forcing exit after timeout');
      process.exit(1);
    }, 10000);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
});

module.exports = app;

# GPU Inference API - Setup Guide

Production-ready GPU inference microservice for enterprise grading system.

---

## Folder Structure

```
gpu-api/
├── server.js           # Main application
├── package.json        # Dependencies
├── ecosystem.config.js # PM2 configuration
├── .env                # Environment variables (create from .env.example)
├── .env.example        # Environment template
├── logs/               # Log files (auto-created)
│   ├── out.log
│   └── error.log
└── SETUP.md            # This file
```

---

## 1. Prerequisites

### Windows 11

```powershell
# Verify Node.js (v18+)
node --version

# Verify Ollama is running
curl http://127.0.0.1:11434/api/version

# Verify model is available
ollama list

# If model not present, pull it
ollama pull qwen2.5:14b

# Install PM2 globally
npm install -g pm2

# Windows: Install pm2-windows-startup for auto-start
npm install -g pm2-windows-startup
pm2-startup install
```

### Ubuntu 22.04

```bash
# Install Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify Node.js
node --version

# Install Ollama (if not installed)
curl -fsSL https://ollama.com/install.sh | sh

# Start Ollama service
sudo systemctl enable ollama
sudo systemctl start ollama

# Pull model
ollama pull qwen2.5:14b

# Install PM2 globally
sudo npm install -g pm2

# Configure PM2 startup
pm2 startup systemd -u $USER --hp $HOME
```

---

## 2. Install Dependencies

```bash
cd gpu-api
npm install
```

---

## 3. Configure Environment

```bash
# Copy example config
cp .env.example .env
```

Edit `.env` and set a secure API key:

```bash
# Generate secure API key (PowerShell)
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }) -as [byte[]])

# Generate secure API key (Bash)
openssl rand -base64 32
```

Update `.env`:

```env
API_KEY=your-generated-secure-key-here
PORT=3000
HOST=127.0.0.1
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:14b
REQUEST_TIMEOUT_MS=60000
MAX_BODY_SIZE=2mb
LOG_LEVEL=info
NODE_ENV=production
```

---

## 4. Create Logs Directory

### Windows (PowerShell)

```powershell
New-Item -ItemType Directory -Force -Path .\logs
```

### Ubuntu

```bash
mkdir -p logs
```

---

## 5. Run with PM2

### Start the service

```bash
pm2 start ecosystem.config.js
```

### Save PM2 process list

```bash
pm2 save
```

### Useful PM2 Commands

```bash
# View logs
pm2 logs gpu-inference-api

# Monitor in real-time
pm2 monit

# Restart
pm2 restart gpu-inference-api

# Stop
pm2 stop gpu-inference-api

# Delete from PM2
pm2 delete gpu-inference-api

# View status
pm2 status
```

---

## 6. Cloudflare Tunnel Setup

### Install cloudflared

#### Windows

```powershell
# Using winget
winget install Cloudflare.cloudflared

# Or download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

#### Ubuntu

```bash
curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared.deb
```

### Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

### Create Tunnel

```bash
# Create tunnel
cloudflared tunnel create gpu-inference

# Note the tunnel ID from output (e.g., a1b2c3d4-e5f6-...)
```

### Configure Tunnel

Create `~/.cloudflared/config.yml` (Linux) or `%USERPROFILE%\.cloudflared\config.yml` (Windows):

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /path/to/credentials.json

ingress:
  - hostname: gpu-api.yourdomain.com
    service: http://127.0.0.1:3000
    originRequest:
      noTLSVerify: false
  - service: http_status:404
```

### Add DNS Record

```bash
cloudflared tunnel route dns gpu-inference gpu-api.yourdomain.com
```

### Run Tunnel

#### Windows (as service)

```powershell
cloudflared service install
net start cloudflared
```

#### Ubuntu (as service)

```bash
sudo cloudflared service install
sudo systemctl enable cloudflared
sudo systemctl start cloudflared
```

#### Manual run (for testing)

```bash
cloudflared tunnel run gpu-inference
```

---

## 7. Test the API

### Health Check

```bash
curl http://127.0.0.1:3000/health
```

### Evaluation Request (Local)

```bash
curl -X POST http://127.0.0.1:3000/evaluate \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{
    "prompt": "Grade the following code submission. Return JSON only with these fields: code_quality (0-100), key_requirements (0-100), output_correctness (0-100), best_practices (0-100), final_score (0-100), major_issues (array of strings), feedback (string).\n\nCode:\ndef hello():\n    print(\"Hello World\")\n\nEvaluate this as a basic hello world implementation."
  }'
```

### Evaluation Request via Tunnel (PowerShell)

```powershell
$headers = @{
    "Content-Type" = "application/json"
    "x-api-key" = "YOUR_API_KEY"
}

$body = @{
    prompt = "Grade the following code submission. Return JSON only with these fields: code_quality (0-100), key_requirements (0-100), output_correctness (0-100), best_practices (0-100), final_score (0-100), major_issues (array of strings), feedback (string).`n`nCode:`ndef hello():`n    print('Hello World')`n`nEvaluate this as a basic hello world implementation."
} | ConvertTo-Json

Invoke-RestMethod -Uri "https://gpu-api.yourdomain.com/evaluate" -Method Post -Headers $headers -Body $body
```

### Expected Response

```json
{
  "code_quality": 75,
  "key_requirements": 100,
  "output_correctness": 100,
  "best_practices": 60,
  "final_score": 84,
  "major_issues": ["No docstring", "No type hints"],
  "feedback": "Basic implementation that meets requirements but lacks documentation."
}
```

---

## 8. GPU Monitoring

### Real-time GPU Stats

```bash
# Continuous monitoring (refreshes every 1 second)
nvidia-smi -l 1

# GPU utilization only
nvidia-smi --query-gpu=utilization.gpu,utilization.memory,memory.used,memory.total --format=csv -l 1

# Watch GPU memory during inference
watch -n 1 nvidia-smi
```

### PowerShell GPU Monitoring Script

```powershell
while ($true) {
    Clear-Host
    nvidia-smi --query-gpu=timestamp,name,utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu --format=csv
    Start-Sleep -Seconds 2
}
```

### Check VRAM Usage

```bash
nvidia-smi --query-gpu=memory.used,memory.total --format=csv
```

---

## 9. Security Best Practices Checklist

### ✅ Network Security

- [x] Server binds to `127.0.0.1` only (not `0.0.0.0`)
- [x] Ollama port 11434 never exposed publicly
- [x] HTTPS enforced via Cloudflare Tunnel
- [x] API key required for all endpoints except health

### ✅ Authentication

- [x] API key minimum 32 characters
- [x] Constant-time comparison prevents timing attacks
- [x] API key in header, not URL parameters
- [x] Failed auth attempts logged

### ✅ Input Validation

- [x] Request body size limited (2MB)
- [x] Prompt length validated (10 - 100KB)
- [x] JSON parsing with error handling
- [x] Malformed requests return 400

### ✅ Resource Protection

- [x] Concurrency limited to 1 (GPU protection)
- [x] 60-second request timeout
- [x] AbortController cancels hung requests
- [x] 503 returned when busy (with retry-after)

### ✅ Error Handling

- [x] Structured error responses
- [x] Request IDs for tracing
- [x] No stack traces in production responses
- [x] Graceful shutdown handling

### ✅ Headers & Responses

- [x] X-Content-Type-Options: nosniff
- [x] X-Frame-Options: DENY
- [x] X-XSS-Protection enabled
- [x] Cache-Control: no-store
- [x] X-Powered-By removed

### ✅ Logging & Monitoring

- [x] Structured JSON logging (pino)
- [x] Request duration tracking
- [x] Error logging with context
- [x] PM2 process monitoring

### ✅ Process Management

- [x] PM2 for process management
- [x] Auto-restart on crash
- [x] Memory limit (1GB)
- [x] Startup persistence

---

## 10. Firewall Configuration

### Windows Firewall (Block Ollama externally)

```powershell
# Block inbound connections to Ollama
New-NetFirewallRule -DisplayName "Block Ollama External" -Direction Inbound -LocalPort 11434 -Protocol TCP -Action Block -RemoteAddress Any

# Allow only localhost
New-NetFirewallRule -DisplayName "Allow Ollama Localhost" -Direction Inbound -LocalPort 11434 -Protocol TCP -Action Allow -RemoteAddress 127.0.0.1
```

### Ubuntu UFW

```bash
# Enable UFW
sudo ufw enable

# Default deny incoming
sudo ufw default deny incoming

# Allow SSH
sudo ufw allow ssh

# Block Ollama from external access (it binds to localhost by default)
# No rule needed if Ollama binds to 127.0.0.1

# Allow cloudflared outbound (no rule needed, outbound allowed by default)
```

---

## 11. Troubleshooting

### Ollama not responding

```bash
# Check if Ollama is running
curl http://127.0.0.1:11434/api/version

# Windows: Restart Ollama
# Close Ollama from system tray, then restart

# Ubuntu: Restart Ollama service
sudo systemctl restart ollama
```

### Model not loaded

```bash
# List models
ollama list

# Pull model if missing
ollama pull qwen2.5:14b

# Test model directly
ollama run qwen2.5:14b "Hello"
```

### Out of VRAM

```bash
# Check GPU memory
nvidia-smi

# Kill other GPU processes if needed
# Reduce model size or use quantized version
ollama pull qwen2.5:14b-q4_K_M
```

### PM2 Issues

```bash
# View logs
pm2 logs gpu-inference-api --lines 100

# Check status
pm2 status

# Full restart
pm2 delete gpu-inference-api
pm2 start ecosystem.config.js
pm2 save
```

---

## 12. Production Checklist

Before going live:

1. [ ] Strong API key generated and set
2. [ ] `.env` file permissions restricted (chmod 600)
3. [ ] Firewall configured
4. [ ] Cloudflare Tunnel running as service
5. [ ] PM2 startup configured
6. [ ] Health check endpoint accessible
7. [ ] Test evaluation request works
8. [ ] Logs being written correctly
9. [ ] GPU memory sufficient for model
10. [ ] Backend server has correct API key configured

---

## 13. Integration with Backend

The backend server should call:

```
POST https://gpu-api.yourdomain.com/evaluate
Headers:
  Content-Type: application/json
  x-api-key: YOUR_SECURE_API_KEY

Body:
{
  "prompt": "FULL_GRADING_PROMPT_WITH_INSTRUCTIONS_AND_CODE"
}
```

Handle response codes:

- `200` - Success, parse JSON body
- `400` - Bad request, check payload
- `401` - Invalid API key
- `503` - Server busy, retry after delay
- `504` - Timeout, retry or fail gracefully
- `500` - Server error, log and alert

---

## Support

For issues:

1. Check PM2 logs: `pm2 logs gpu-inference-api`
2. Check Ollama: `curl http://127.0.0.1:11434/api/version`
3. Check GPU: `nvidia-smi`
4. Check health: `curl http://127.0.0.1:3000/health`

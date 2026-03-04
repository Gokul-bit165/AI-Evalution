# 🚀 GPU API - Quick Start Guide

Your `.env` file is now configured. Here's how to run everything.

---

## ✅ Step 1: Verify Prerequisites

### Windows (PowerShell)

```powershell
# Check Node.js
node --version    # Should be v18+

# Check Ollama is running
curl http://127.0.0.1:11434/api/version

# Check model exists
ollama list       # Should see qwen2.5:14b

# If missing, pull it:
ollama pull qwen2.5:14b

# Install Node dependencies
npm install
```

---

## ✅ Step 2: Update GPU_API_KEY (Required)

Your `.env` file needs a **real, strong API key** (min 32 characters).

Replace:
```env
API_KEY=super_secret_gpu_key_min_32_chars_required_here
```

With something like:
```env
API_KEY=sk-gpu-prod-2026-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
```

Then save and restart the server.

---

## ✅ Step 3: Run the GPU Server

### Option A: Development Mode
```powershell
npm run dev
```

This runs with file watching enabled.

### Option B: Production Mode (PM2)

```powershell
# Start with PM2
npm run pm2:start

# View logs
npm run pm2:logs

# Restart if needed
npm run pm2:restart
```

PM2 auto-starts on system reboot.

### Option C: Direct Run
```powershell
npm start
```

---

## ✅ Step 4: Verify Server is Running

```powershell
# Health check (no auth)
curl http://127.0.0.1:5000/health

# Should return:
# {
#   "status": "ok",
#   "timestamp": "2026-03-04T...",
#   "uptime": 12.345,
#   "concurrency": {...}
# }
```

---

## ✅ Step 5: Test the Evaluation Endpoint

Create a test payload (`test.json`):

```json
{
  "prompt": "Evaluate this code:\n\nHTML: <div>Hello</div>\nCSS: body{margin:0;}\nJS: console.log('test');\n\nScore it 1-100."
}
```

Test the endpoint:

```powershell
curl -X POST http://127.0.0.1:5000/evaluate `
  -H "x-api-key: sk-gpu-prod-2026-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6" `
  -H "Content-Type: application/json" `
  -d @test.json
```

Expected response:
```json
{
  "code_quality": 75,
  "key_requirements": 80,
  "output_correctness": 85,
  "best_practices": 70,
  "final_score": 77,
  "major_issues": ["Minor style issues"],
  "feedback": "Good basic implementation..."
}
```

---

## ✅ Step 6: Connect CPU Portal Backend

In your CPU portal backend's `.env`:

```env
GPU_API_URL=http://127.0.0.1:5000/evaluate
GPU_API_KEY=sk-gpu-prod-2026-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
```

Then restart the CPU worker:

```bash
npm run worker
```

---

## 🔌 For Remote GPU Machine

If GPU server is on a different machine:

```env
# On GPU machine
GPU_API_URL=http://192.168.1.50:5000/evaluate
GPU_API_KEY=sk-gpu-prod-2026-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6
```

Start server with public bind:

```powershell
[Environment]::SetEnvironmentVariable("HOST", "0.0.0.0", "Process")
npm start
```

Or edit `.env`:
```env
HOST=0.0.0.0
```

---

## 🐛 Troubleshooting

| Issue | Fix |
|-------|-----|
| `ERROR: API_KEY must be set and at least 32 characters` | Update `.env` and restart |
| `Connection refused to Ollama` | Ensure Ollama is running: `ollama serve` |
| `Model not found` | Pull it: `ollama pull qwen2.5:14b` |
| `Port 5000 already in use` | Change `PORT=6000` in `.env` |
| `x-api-key header missing` | Add header to request |

---

## ✅ Architecture Status

Your system now:

```
CPU Portal Worker
    ↓ (POST /evaluate with x-api-key)
    ↓ (60s timeout)
GPU API Server (Node.js)
    ↓ (validates prompt)
    ↓ (calls Ollama)
Ollama + qwen2.5:14b
    ↓ (LLM inference)
    ↓ (strict JSON response)
GPU API Server
    ↓ (validates JSON schema)
CPU Portal Worker
    ↓ (stores result in DB)
✅ Complete
```

---

## 📊 Monitor Server Health

```powershell
# View full server status (requires auth)
curl -X GET http://127.0.0.1:5000/internal/status `
  -H "x-api-key: sk-gpu-prod-2026-a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"
```

This shows:
- Concurrency stats
- Request metrics
- GPU metrics (if nvidia-smi available)
- Ollama connection status

---

## 🔐 Security Checklist

- [ ] `.env` file is in `.gitignore` (never commit secrets)
- [ ] API_KEY is strong (min 32 chars, no simple patterns)
- [ ] Firewall restricts port 5000 (only internal access)
- [ ] HTTPS in production (reverse proxy via nginx)
- [ ] Rate limiting enabled (built-in)
- [ ] Concurrency max 1 (prevents GPU overload)
- [ ] Request timeout 60s (prevents hanging)

---

## 📚 More Info

See `SETUP.md` for detailed production deployment guides, including:
- Docker containerization
- Systemd service setup
- Nginx reverse proxy
- SSL/TLS configuration
- Auto-scaling with PM2 Cluster mode


# ClawdX Plugin for Clawdbot

Track token usage, conversations, costs, and user analytics across all your Clawdbot agents — powered by [ClawdX](https://getclawdx.vercel.app).

## Overview

The ClawdX Plugin monitors your Clawdbot session JSONL files in real-time and sends usage data to the ClawdX dashboard. It tracks:

- **Token usage** — input, output, cache read/write tokens per request
- **Costs** — automatic cost calculation based on model pricing
- **Conversations** — full message content (user + assistant)
- **Users** — auto-detected from Telegram, WhatsApp, Discord, Signal, etc.
- **Sessions** — grouped by session key for conversation threading

## Quick Start

### 1. Get your API key

Sign up at [getclawdx.vercel.app](https://getclawdx.vercel.app) and create a connection under **Settings → Connections**. Copy the API key (starts with `sk_`).

### 2. Configure environment

Create or edit `~/.clawdbot/.env`:

```env
DASHBOARD_URL=https://getclawdx.vercel.app
DASHBOARD_API_KEY=sk_your_api_key_here
```

### 3. Enable the plugin

In your `~/.clawdbot/clawdbot.json`:

```json
{
  "plugins": {
    "entries": {
      "billing-tracker": {
        "enabled": true
      }
    }
  }
}
```

### 4. Restart Clawdbot

```bash
clawdbot gateway stop && clawdbot gateway start
```

### 5. Verify

Check the connection status:

```bash
curl -H "Authorization: Bearer sk_your_api_key" \
  https://getclawdx.vercel.app/api/ingest/ping
```

Expected response:
```json
{"ok": true, "connection": {"name": "...", "status": "active"}}
```

## How It Works

```
Clawdbot Agents → JSONL session files → ClawdX Plugin → Dashboard API → Neon PostgreSQL
```

1. Clawdbot writes session events to JSONL files in `~/.clawdbot/agents/<id>/sessions/`
2. The plugin watches these files for new entries
3. Usage records and messages are batched and sent to the ClawdX API every 10 seconds
4. File positions are tracked in `~/.clawdbot/billing-tracker-positions.json` to avoid duplicates

## Configuration

### Environment Variables (`~/.clawdbot/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `DASHBOARD_URL` | Yes | ClawdX dashboard URL |
| `DASHBOARD_API_KEY` | Yes | API key from your ClawdX connection |

### Plugin Config (`clawdbot.json`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the plugin |
| `botId` | string | auto | Bot identifier (auto-detected from agent ID) |
| `agents` | string[] | `[]` | Agent IDs to track (empty = all agents) |

## Multi-Bot Setup

If you run multiple Clawdbot agents (e.g., different Telegram bots), each agent is automatically tracked as a separate bot in ClawdX:

```json
{
  "agents": {
    "list": [
      { "id": "main", "name": "Main Bot" },
      { "id": "support", "name": "Support Bot" },
      { "id": "sales", "name": "Sales Bot" }
    ]
  }
}
```

Each agent's sessions are monitored independently. Users, costs, and conversations are tracked per bot.

## API Endpoints

The plugin sends data to these ClawdX API endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/ingest/ping` | GET | Test connection |
| `/api/ingest/usage` | POST | Token usage & cost records |
| `/api/ingest/messages` | POST | Conversation messages |

## Supported Models & Cost Tracking

Automatic cost calculation for:

- **Anthropic** — Claude Opus, Sonnet, Haiku (all versions)
- **OpenAI** — GPT-4o, GPT-4, GPT-3.5
- **Google** — Gemini Pro, Flash
- **DeepSeek** — Chat, Coder

Costs are calculated based on input/output/cache token counts and current model pricing.

## Troubleshooting

### Check plugin logs
```bash
journalctl --user -n 50 | grep billing-tracker
```

### Common issues

**"No backend configured"**
- Ensure `DASHBOARD_URL` and `DASHBOARD_API_KEY` are set in `~/.clawdbot/.env`

**"Usage flush failed: 401"**
- API key is invalid or disabled. Check your connection in the ClawdX dashboard.

**"Usage flush failed: 404"**
- Dashboard URL is wrong. Verify with `curl <URL>/api/ingest/ping`.

**Data not updating after restart**
- Run `clawdbot gateway stop && clawdbot gateway start` (not just restart)
- Check that the process actually restarted: `ps aux | grep clawdbot`

**Duplicate data after reinstall**
- Delete `~/.clawdbot/billing-tracker-positions.json` to reset file positions
- Note: this will re-process all existing JSONL files

## File Structure

```
~/.clawdbot/
├── .env                              # DASHBOARD_URL + DASHBOARD_API_KEY
├── billing-tracker-positions.json    # File position tracker (auto-managed)
├── clawdbot.json                     # Plugin enabled here
└── extensions/
    └── billing-tracker/
        ├── index.ts                  # Plugin source
        ├── dist/index.js             # Compiled plugin
        ├── clawdbot.plugin.json      # Plugin manifest
        └── package.json
```

## Developed By

[SparkLabs](https://sparklabs.digital) — Building the infrastructure for AI businesses.

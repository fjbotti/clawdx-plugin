# Billing Tracker Plugin for Clawdbot

Track token usage per user/agent for billing and monetization purposes.

## Features

- 📊 **Automatic tracking** - Watches session files and extracts token usage
- 💾 **SQLite storage** - Persistent usage data per user/agent
- 💬 **Chat command** - `/consumo` to check personal usage
- 🔌 **RPC API** - Query usage programmatically

## Installation

1. Copy this folder to `~/.clawdbot/extensions/billing-tracker/`
2. Install dependencies:
   ```bash
   cd ~/.clawdbot/extensions/billing-tracker
   npm install
   ```
3. Restart Clawdbot gateway

## Configuration

Add to your `~/.clawdbot/clawdbot.json`:

```json5
{
  plugins: {
    entries: {
      "billing-tracker": {
        enabled: true,
        config: {
          dbPath: "~/.clawdbot/billing.db",  // Optional, this is the default
          agents: ["tarifar", "visabot"]      // Optional, empty = track all
        }
      }
    }
  }
}
```

## Usage

### Chat Commands

- `/consumo` - Shows your personal token usage

### RPC Methods

```bash
# Get user usage
clawdbot gateway call billing.user_usage --params '{"userId": "telegram:1234567890"}'

# Get agent usage
clawdbot gateway call billing.agent_usage --params '{"agentId": "tarifar"}'
```

## Database Schema

```sql
-- Token usage per request
usage_logs (
  id, timestamp, agent_id, session_key, user_id,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  model, provider, created_at
)

-- User credit balances (for future use)
user_credits (
  user_id, credits, updated_at
)

-- File position tracking (internal)
file_positions (
  file_path, byte_position, updated_at
)
```

## How It Works

1. Plugin starts a background service
2. Service watches `~/.clawdbot/agents/*/sessions/*.jsonl` using `fs.watch()`
3. When session files change, it parses new entries
4. Assistant messages with `usage` data are extracted and stored in SQLite
5. User ID is resolved from `sessions.json` metadata

## Limitations

- Relies on file watching (see GitHub issue for proposed `response:complete` hook)
- Only tracks agents with existing session files
- Requires gateway restart to pick up new agents

## Future Improvements

- [ ] Native `response:complete` hook (proposed to Clawdbot)
- [ ] Credit system with prepaid balance
- [ ] Payment integration (Stripe/MercadoPago)
- [ ] Usage alerts and limits
- [ ] Dashboard UI

## License

MIT

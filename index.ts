/**
 * Billing Tracker Plugin for Clawdbot (PostgreSQL Version)
 * 
 * Tracks token usage per user/agent by watching session JSONL files.
 * Stores usage data in PostgreSQL (Neon) for billing/monetization purposes.
 */

import { watch, FSWatcher } from "fs";
import { readFile, readdir, stat } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import pg from "pg";

const { Pool } = pg;

// Types
interface PluginApi {
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  config: {
    agents?: { list?: Array<{ id: string }> };
  };
  registerService: (service: {
    id: string;
    start: () => void | Promise<void>;
    stop: () => void | Promise<void>;
  }) => void;
  registerGatewayMethod: (
    name: string,
    handler: (ctx: { params: Record<string, unknown>; respond: (ok: boolean, data: unknown) => void }) => void
  ) => void;
  registerCommand: (cmd: {
    name: string;
    description: string;
    handler: (ctx: { senderId?: string }) => { text: string } | Promise<{ text: string }>;
  }) => void;
}

interface PluginConfig {
  enabled?: boolean;
  databaseUrl?: string;
  botId?: string;
  watchIntervalMs?: number;
  agents?: string[];
}

interface UsageRecord {
  timestamp: number;
  agentId: string;
  sessionKey: string;
  userId: string;
  channel: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
  provider: string;
  costUsd: number;
}

interface SessionEntry {
  type?: string;
  message?: {
    role?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      // Alternative formats
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    model?: string;
  };
  // Legacy flat format
  role?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  model?: string;
}

// Pricing (per million tokens)
const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-sonnet-4-20250514": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-opus-4-20250514": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4, cacheRead: 0.08 },
  "default": { input: 3, output: 15, cacheRead: 0.3 },
};

function calculateCost(model: string, inputTokens: number, outputTokens: number, cacheReadTokens: number): number {
  const pricing = PRICING[model] ?? PRICING["default"];
  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheReadTokens / 1_000_000) * pricing.cacheRead
  );
}

// Database
let pool: pg.Pool | null = null;
let defaultBotId: string = "unknown";

// Map agent IDs to bot IDs (can be configured or default to same)
const agentToBotMap: Map<string, string> = new Map();

// File positions cache (in-memory to reduce DB calls)
const filePositions: Map<string, number> = new Map();

async function initDatabase(databaseUrl: string) {
  pool = new Pool({ 
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30000,
  });
  
  // Test connection
  const client = await pool.connect();
  client.release();
  
  return pool;
}

interface UserInfo {
  externalId: string;
  channel: string;
  displayName?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
}

async function getOrCreateUser(userInfo: UserInfo, forBotId: string): Promise<number> {
  if (!pool) throw new Error("Database not initialized");
  
  const result = await pool.query(`
    INSERT INTO users (external_id, channel, bot_id, display_name, username, first_name, last_name)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (external_id, channel, bot_id) 
    DO UPDATE SET 
      updated_at = NOW(), 
      display_name = COALESCE(EXCLUDED.display_name, users.display_name),
      username = COALESCE(EXCLUDED.username, users.username),
      first_name = COALESCE(EXCLUDED.first_name, users.first_name),
      last_name = COALESCE(EXCLUDED.last_name, users.last_name)
    RETURNING id
  `, [userInfo.externalId, userInfo.channel, forBotId, userInfo.displayName, userInfo.username, userInfo.firstName, userInfo.lastName]);
  
  return result.rows[0].id;
}

// Parse user label like "F B (@dinjarin5) id:1840436008" or "Gonza Lopez (@gonza18lopez) id:1301157295"
function parseUserLabel(label: string): { displayName?: string; username?: string } {
  const usernameMatch = label.match(/@(\w+)/);
  const nameMatch = label.match(/^([^(@]+)/);
  
  return {
    displayName: nameMatch ? nameMatch[1].trim() : undefined,
    username: usernameMatch ? usernameMatch[1] : undefined,
  };
}

function getBotIdForAgent(agentId: string): string {
  return agentToBotMap.get(agentId) ?? agentId;
}

async function insertUsage(record: UsageRecord, userInfo?: UserInfo) {
  if (!pool) return;
  
  // Get bot ID for this agent
  const recordBotId = getBotIdForAgent(record.agentId);
  
  // Get or create user
  let userId: number;
  if (userInfo) {
    userId = await getOrCreateUser(userInfo, recordBotId);
  } else {
    const [externalId, channel] = parseUserId(record.userId);
    userId = await getOrCreateUser({ externalId, channel }, recordBotId);
  }
  
  await pool.query(`
    INSERT INTO usage_logs (user_id, bot_id, session_key, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, provider, cost_usd, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11 / 1000.0))
  `, [
    userId,
    recordBotId,
    record.sessionKey,
    record.inputTokens,
    record.outputTokens,
    record.cacheReadTokens,
    record.cacheWriteTokens,
    record.model,
    record.provider,
    record.costUsd,
    record.timestamp,
  ]);
}

function parseUserId(userId: string): [string, string] {
  // Parse "telegram:1840436008" format
  const parts = userId.split(":");
  if (parts.length === 2) {
    return [parts[1], parts[0]];
  }
  return [userId, "unknown"];
}

async function getFilePosition(filePath: string): Promise<number> {
  // Check cache first
  if (filePositions.has(filePath)) {
    return filePositions.get(filePath)!;
  }
  
  if (!pool) return 0;
  
  try {
    const result = await pool.query(
      "SELECT byte_position FROM file_positions WHERE file_path = $1",
      [filePath]
    );
    const position = result.rows[0]?.byte_position ?? 0;
    filePositions.set(filePath, position);
    return position;
  } catch {
    return 0;
  }
}

async function setFilePosition(filePath: string, position: number) {
  filePositions.set(filePath, position);
  
  if (!pool) return;
  
  await pool.query(`
    INSERT INTO file_positions (file_path, byte_position, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (file_path) DO UPDATE SET byte_position = $2, updated_at = NOW()
  `, [filePath, position]);
}

async function getUserUsage(externalId: string, forBotId?: string): Promise<{ total_input: number; total_output: number; total_requests: number; total_cost: number }> {
  if (!pool) return { total_input: 0, total_output: 0, total_requests: 0, total_cost: 0 };
  
  let query: string;
  let params: string[];
  
  if (forBotId) {
    query = `
      SELECT 
        COALESCE(SUM(ul.input_tokens), 0)::int as total_input,
        COALESCE(SUM(ul.output_tokens), 0)::int as total_output,
        COUNT(*)::int as total_requests,
        COALESCE(SUM(ul.cost_usd), 0)::float as total_cost
      FROM usage_logs ul
      JOIN users u ON ul.user_id = u.id
      WHERE u.external_id = $1 AND ul.bot_id = $2
    `;
    params = [externalId, forBotId];
  } else {
    // All bots
    query = `
      SELECT 
        COALESCE(SUM(ul.input_tokens), 0)::int as total_input,
        COALESCE(SUM(ul.output_tokens), 0)::int as total_output,
        COUNT(*)::int as total_requests,
        COALESCE(SUM(ul.cost_usd), 0)::float as total_cost
      FROM usage_logs ul
      JOIN users u ON ul.user_id = u.id
      WHERE u.external_id = $1
    `;
    params = [externalId];
  }
  
  const result = await pool.query(query, params);
  return result.rows[0];
}

async function getBotUsage(forBotId: string): Promise<{ total_input: number; total_output: number; total_requests: number; unique_users: number; total_cost: number }> {
  if (!pool) return { total_input: 0, total_output: 0, total_requests: 0, unique_users: 0, total_cost: 0 };
  
  const result = await pool.query(`
    SELECT 
      COALESCE(SUM(input_tokens), 0)::int as total_input,
      COALESCE(SUM(output_tokens), 0)::int as total_output,
      COUNT(*)::int as total_requests,
      COUNT(DISTINCT user_id)::int as unique_users,
      COALESCE(SUM(cost_usd), 0)::float as total_cost
    FROM usage_logs 
    WHERE bot_id = $1
  `, [forBotId]);
  
  return result.rows[0];
}

async function getAllBotsUsage(): Promise<Array<{ bot_id: string; total_input: number; total_output: number; total_requests: number; unique_users: number; total_cost: number }>> {
  if (!pool) return [];
  
  const result = await pool.query(`
    SELECT 
      bot_id,
      COALESCE(SUM(input_tokens), 0)::int as total_input,
      COALESCE(SUM(output_tokens), 0)::int as total_output,
      COUNT(*)::int as total_requests,
      COUNT(DISTINCT user_id)::int as unique_users,
      COALESCE(SUM(cost_usd), 0)::float as total_cost
    FROM usage_logs 
    GROUP BY bot_id
  `);
  
  return result.rows;
}

// Session file watcher
class SessionWatcher {
  private watchers: Map<string, FSWatcher> = new Map();
  private logger: PluginApi["logger"];
  private agentsDir: string;
  private trackedAgents: string[];
  
  constructor(logger: PluginApi["logger"], trackedAgents: string[] = []) {
    this.logger = logger;
    this.agentsDir = join(homedir(), ".clawdbot", "agents");
    this.trackedAgents = trackedAgents;
  }
  
  async start() {
    this.logger.info(`[billing-tracker] Starting session watcher for agents: ${this.trackedAgents.length > 0 ? this.trackedAgents.join(", ") : "all"}`);
    await this.scanAgents();
  }
  
  async stop() {
    this.logger.info("[billing-tracker] Stopping session watcher...");
    for (const [, watcher] of this.watchers) {
      watcher.close();
    }
    this.watchers.clear();
  }
  
  private async scanAgents() {
    try {
      const agents = await readdir(this.agentsDir);
      
      for (const agentId of agents) {
        // Skip if we have a filter and this agent isn't in it
        if (this.trackedAgents.length > 0 && !this.trackedAgents.includes(agentId)) {
          continue;
        }
        
        const sessionsDir = join(this.agentsDir, agentId, "sessions");
        
        try {
          const stats = await stat(sessionsDir);
          if (stats.isDirectory()) {
            this.watchSessionsDir(agentId, sessionsDir);
          }
        } catch {
          // Sessions dir doesn't exist yet
        }
      }
    } catch (err) {
      this.logger.error(`[billing-tracker] Error scanning agents: ${err}`);
    }
  }
  
  private watchSessionsDir(agentId: string, sessionsDir: string) {
    if (this.watchers.has(sessionsDir)) return;
    
    this.logger.info(`[billing-tracker] Watching ${agentId} sessions...`);
    
    const watcher = watch(sessionsDir, async (eventType, filename) => {
      if (!filename || !filename.endsWith(".jsonl")) return;
      
      const filePath = join(sessionsDir, filename);
      await this.processSessionFile(agentId, filePath);
    });
    
    this.watchers.set(sessionsDir, watcher);
    
    // Process existing files
    this.processExistingFiles(agentId, sessionsDir);
  }
  
  private async processExistingFiles(agentId: string, sessionsDir: string) {
    try {
      const files = await readdir(sessionsDir);
      
      for (const file of files) {
        if (file.endsWith(".jsonl")) {
          const filePath = join(sessionsDir, file);
          await this.processSessionFile(agentId, filePath);
        }
      }
    } catch (err) {
      this.logger.error(`[billing-tracker] Error processing existing files: ${err}`);
    }
  }
  
  private async processSessionFile(agentId: string, filePath: string) {
    try {
      const content = await readFile(filePath, "utf-8");
      const lastPosition = await getFilePosition(filePath);
      
      // Only process new content
      const newContent = content.slice(lastPosition);
      if (!newContent.trim()) return;
      
      const lines = newContent.split("\n").filter(line => line.trim());
      let processedCount = 0;
      
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as SessionEntry;
          
          // Handle nested message format (type: "message") or flat format
          const msg = entry.message ?? entry;
          const role = msg.role;
          const usage = msg.usage;
          const model = msg.model;
          
          // Only process assistant messages with usage
          if (role === "assistant" && usage) {
            const sessionKey = basename(filePath, ".jsonl");
            
            // Extract user info from session metadata
            const userInfo = await this.getUserInfoForSession(agentId, sessionKey);
            
            if (userInfo) {
              // Handle both field naming conventions
              const inputTokens = usage.input ?? usage.input_tokens ?? 0;
              const outputTokens = usage.output ?? usage.output_tokens ?? 0;
              const cacheReadTokens = usage.cacheRead ?? usage.cache_read_input_tokens ?? 0;
              const cacheWriteTokens = usage.cacheWrite ?? usage.cache_creation_input_tokens ?? 0;
              const modelName = model ?? "unknown";
              
              await insertUsage({
                timestamp: Date.now(),
                agentId,
                sessionKey,
                userId: `${userInfo.channel}:${userInfo.externalId}`,
                channel: userInfo.channel,
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheWriteTokens,
                model: modelName,
                provider: "anthropic",
                costUsd: calculateCost(modelName, inputTokens, outputTokens, cacheReadTokens),
              }, userInfo);
              processedCount++;
            }
          }
        } catch {
          // Skip malformed lines
        }
      }
      
      // Update file position
      await setFilePosition(filePath, content.length);
      
      if (processedCount > 0) {
        this.logger.info(`[billing-tracker] Processed ${processedCount} usage records from ${agentId}`);
      }
    } catch {
      // File might not exist yet
    }
  }
  
  private async getUserInfoForSession(agentId: string, sessionId: string): Promise<UserInfo | null> {
    try {
      const sessionsJsonPath = join(this.agentsDir, agentId, "sessions", "sessions.json");
      const content = await readFile(sessionsJsonPath, "utf-8");
      const sessions = JSON.parse(content);
      
      // Find session by ID
      for (const [, session] of Object.entries(sessions)) {
        const s = session as { 
          sessionId?: string; 
          origin?: { from?: string; label?: string } 
        };
        if (s.sessionId === sessionId && s.origin?.from) {
          const [externalId, channel] = parseUserId(s.origin.from);
          const labelInfo = s.origin.label ? parseUserLabel(s.origin.label) : {};
          
          return {
            externalId,
            channel,
            displayName: labelInfo.displayName,
            username: labelInfo.username,
          };
        }
      }
    } catch {
      // Sessions file doesn't exist or is malformed
    }
    return null;
  }
}

// Ensure file_positions table exists
async function ensureFilePositionsTable() {
  if (!pool) return;
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS file_positions (
      file_path TEXT PRIMARY KEY,
      byte_position INTEGER DEFAULT 0,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

// Main plugin export
export default function billingTrackerPlugin(api: PluginApi) {
  const config: PluginConfig = (api.config as { plugins?: { entries?: { "billing-tracker"?: { config?: PluginConfig } } } })
    ?.plugins?.entries?.["billing-tracker"]?.config ?? {};
  
  if (config.enabled === false) {
    api.logger.info("[billing-tracker] Plugin disabled");
    return;
  }
  
  // Try multiple sources for database URL
  let databaseUrl = config.databaseUrl ?? process.env.BILLING_DATABASE_URL;
  
  // Fallback: read from .env file
  if (!databaseUrl) {
    try {
      const envPath = join(homedir(), ".clawdbot", ".env");
      const envContent = require("fs").readFileSync(envPath, "utf-8");
      const match = envContent.match(/BILLING_DATABASE_URL=(.+)/);
      if (match) {
        databaseUrl = match[1].trim();
      }
    } catch {}
  }
  
  if (!databaseUrl) {
    api.logger.error("[billing-tracker] No databaseUrl configured. Set BILLING_DATABASE_URL in ~/.clawdbot/.env");
    return;
  }
  
  defaultBotId = config.botId ?? "unknown";
  const trackedAgents = config.agents ?? [];
  
  // Set up agent to bot mapping (default: agent ID = bot ID)
  for (const agent of trackedAgents) {
    agentToBotMap.set(agent, agent);
  }
  
  let watcher: SessionWatcher | null = null;
  
  api.logger.info(`[billing-tracker] Registering service with DB URL: ${databaseUrl ? 'found' : 'missing'}`);
  
  // Register background service
  api.registerService({
    id: "billing-tracker",
    start: async () => {
      api.logger.info(`[billing-tracker] Service start() called`);
      try {
        api.logger.info(`[billing-tracker] Connecting to database...`);
        await initDatabase(databaseUrl);
        await ensureFilePositionsTable();
        api.logger.info(`[billing-tracker] Connected to PostgreSQL`);
        
        api.logger.info(`[billing-tracker] Starting session watcher for ${trackedAgents.length || 'all'} agents`);
        watcher = new SessionWatcher(api.logger, trackedAgents);
        await watcher.start();
        api.logger.info(`[billing-tracker] Session watcher started`);
      } catch (err) {
        api.logger.error(`[billing-tracker] Failed to start: ${err}`);
      }
    },
    stop: async () => {
      if (watcher) {
        await watcher.stop();
        watcher = null;
      }
      if (pool) {
        await pool.end();
        pool = null;
      }
    },
  });
  
  // Register RPC methods
  api.registerGatewayMethod("billing.user_usage", async ({ params, respond }) => {
    const userId = params.userId as string;
    const forBotId = params.botId as string | undefined;
    if (!userId) {
      respond(false, { error: "userId required" });
      return;
    }
    try {
      const usage = await getUserUsage(userId, forBotId);
      respond(true, usage);
    } catch (err) {
      respond(false, { error: String(err) });
    }
  });
  
  api.registerGatewayMethod("billing.bot_usage", async ({ params, respond }) => {
    const forBotId = params.botId as string;
    if (!forBotId) {
      respond(false, { error: "botId required" });
      return;
    }
    try {
      const usage = await getBotUsage(forBotId);
      respond(true, usage);
    } catch (err) {
      respond(false, { error: String(err) });
    }
  });
  
  api.registerGatewayMethod("billing.all_bots_usage", async ({ params, respond }) => {
    try {
      const usage = await getAllBotsUsage();
      respond(true, usage);
    } catch (err) {
      respond(false, { error: String(err) });
    }
  });
  
  // Register chat commands
  api.registerCommand({
    name: "consumo",
    description: "Ver tu consumo de tokens",
    handler: async (ctx) => {
      const senderId = ctx.senderId;
      if (!senderId) {
        return { text: "❌ No pude identificar tu usuario" };
      }
      
      // Parse sender ID (e.g., "telegram:1840436008" -> "1840436008")
      const [externalId] = parseUserId(senderId);
      
      try {
        // Get usage across all bots for this user
        const usage = await getUserUsage(externalId);
        const totalTokens = usage.total_input + usage.total_output;
        
        if (usage.total_requests === 0) {
          return { text: "📊 No hay consumo registrado aún." };
        }
        
        return {
          text: `📊 **Tu consumo:**\n\n` +
            `• Requests: ${usage.total_requests}\n` +
            `• Input tokens: ${usage.total_input.toLocaleString()}\n` +
            `• Output tokens: ${usage.total_output.toLocaleString()}\n` +
            `• **Total: ${totalTokens.toLocaleString()} tokens**\n` +
            `• 💵 Costo: $${usage.total_cost.toFixed(4)} USD`
        };
      } catch (err) {
        return { text: `❌ Error: ${err}` };
      }
    },
  });
  
  // Add more API methods for dashboard
  api.registerGatewayMethod("billing.all_users", async ({ params, respond }) => {
    if (!pool) {
      respond(false, { error: "Database not connected" });
      return;
    }
    try {
      const result = await pool.query(`
        SELECT 
          u.id, u.external_id, u.channel, u.bot_id, u.display_name, u.enabled, u.created_at,
          COALESCE(SUM(ul.input_tokens + ul.output_tokens), 0)::int as total_tokens,
          COALESCE(SUM(ul.cost_usd), 0)::float as total_cost,
          COUNT(ul.id)::int as total_requests
        FROM users u
        LEFT JOIN usage_logs ul ON u.id = ul.user_id
        GROUP BY u.id
        ORDER BY total_tokens DESC
      `);
      respond(true, result.rows);
    } catch (err) {
      respond(false, { error: String(err) });
    }
  });
  
  api.registerGatewayMethod("billing.all_bots", async ({ params, respond }) => {
    if (!pool) {
      respond(false, { error: "Database not connected" });
      return;
    }
    try {
      const result = await pool.query(`
        SELECT 
          b.id, b.bot_id, b.name, b.description, b.enabled, b.created_at,
          COALESCE(SUM(ul.input_tokens), 0)::int as total_input,
          COALESCE(SUM(ul.output_tokens), 0)::int as total_output,
          COALESCE(SUM(ul.cost_usd), 0)::float as total_cost,
          COUNT(DISTINCT ul.user_id)::int as unique_users
        FROM bots b
        LEFT JOIN usage_logs ul ON b.bot_id = ul.bot_id
        GROUP BY b.id
        ORDER BY b.bot_id
      `);
      respond(true, result.rows);
    } catch (err) {
      respond(false, { error: String(err) });
    }
  });
  
  api.registerGatewayMethod("billing.recent_usage", async ({ params, respond }) => {
    if (!pool) {
      respond(false, { error: "Database not connected" });
      return;
    }
    const limit = (params.limit as number) || 100;
    try {
      const result = await pool.query(`
        SELECT 
          ul.id, ul.bot_id, ul.session_key, ul.input_tokens, ul.output_tokens, 
          ul.cache_read_tokens, ul.model, ul.provider, ul.cost_usd, ul.created_at,
          u.external_id, u.channel, u.display_name
        FROM usage_logs ul
        JOIN users u ON ul.user_id = u.id
        ORDER BY ul.created_at DESC
        LIMIT $1
      `, [limit]);
      respond(true, result.rows);
    } catch (err) {
      respond(false, { error: String(err) });
    }
  });
  
  api.logger.info("[billing-tracker] Plugin loaded (PostgreSQL mode)");
}

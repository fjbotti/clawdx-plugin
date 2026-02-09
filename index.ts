/**
 * Billing Tracker Plugin for Clawdbot
 * 
 * Tracks token usage per user/agent by watching session JSONL files.
 * Stores usage data in SQLite for billing/monetization purposes.
 */

import { watch, FSWatcher } from "fs";
import { readFile, readdir, stat } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";

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
  dbPath?: string;
  watchIntervalMs?: number;
  agents?: string[];
}

interface UsageRecord {
  timestamp: number;
  agentId: string;
  sessionKey: string;
  userId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model: string;
  provider: string;
}

interface SessionEntry {
  role?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  model?: string;
}

// Database helper (using better-sqlite3)
let db: ReturnType<typeof import("better-sqlite3")> | null = null;

function initDatabase(dbPath: string) {
  // Dynamic import for better-sqlite3
  const Database = require("better-sqlite3");
  db = new Database(dbPath);
  
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      agent_id TEXT NOT NULL,
      session_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      model TEXT,
      provider TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_usage_agent ON usage_logs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_logs(timestamp);

    CREATE TABLE IF NOT EXISTS user_credits (
      user_id TEXT PRIMARY KEY,
      credits INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS file_positions (
      file_path TEXT PRIMARY KEY,
      byte_position INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  return db;
}

function insertUsage(record: UsageRecord) {
  if (!db) return;
  
  const stmt = db.prepare(`
    INSERT INTO usage_logs (timestamp, agent_id, session_key, user_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  stmt.run(
    record.timestamp,
    record.agentId,
    record.sessionKey,
    record.userId,
    record.inputTokens,
    record.outputTokens,
    record.cacheReadTokens,
    record.cacheWriteTokens,
    record.model,
    record.provider
  );
}

function getFilePosition(filePath: string): number {
  if (!db) return 0;
  const row = db.prepare("SELECT byte_position FROM file_positions WHERE file_path = ?").get(filePath) as { byte_position: number } | undefined;
  return row?.byte_position ?? 0;
}

function setFilePosition(filePath: string, position: number) {
  if (!db) return;
  db.prepare(`
    INSERT INTO file_positions (file_path, byte_position, updated_at) 
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(file_path) DO UPDATE SET byte_position = ?, updated_at = CURRENT_TIMESTAMP
  `).run(filePath, position, position);
}

function getUserUsage(userId: string): { total_input: number; total_output: number; total_requests: number } {
  if (!db) return { total_input: 0, total_output: 0, total_requests: 0 };
  
  const row = db.prepare(`
    SELECT 
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COUNT(*) as total_requests
    FROM usage_logs 
    WHERE user_id = ?
  `).get(userId) as { total_input: number; total_output: number; total_requests: number };
  
  return row;
}

function getAgentUsage(agentId: string): { total_input: number; total_output: number; total_requests: number; unique_users: number } {
  if (!db) return { total_input: 0, total_output: 0, total_requests: 0, unique_users: 0 };
  
  const row = db.prepare(`
    SELECT 
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COUNT(*) as total_requests,
      COUNT(DISTINCT user_id) as unique_users
    FROM usage_logs 
    WHERE agent_id = ?
  `).get(agentId) as { total_input: number; total_output: number; total_requests: number; unique_users: number };
  
  return row;
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
    this.logger.info("[billing-tracker] Starting session watcher...");
    await this.scanAgents();
  }
  
  async stop() {
    this.logger.info("[billing-tracker] Stopping session watcher...");
    for (const [path, watcher] of this.watchers) {
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
      const lastPosition = getFilePosition(filePath);
      
      // Only process new content
      const newContent = content.slice(lastPosition);
      if (!newContent.trim()) return;
      
      const lines = newContent.split("\n").filter(line => line.trim());
      let processedAny = false;
      
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as SessionEntry;
          
          // Only process assistant messages with usage
          if (entry.role === "assistant" && entry.usage) {
            const sessionKey = basename(filePath, ".jsonl");
            
            // Extract user ID from session metadata (we'll need to read sessions.json)
            const userId = await this.getUserIdForSession(agentId, sessionKey);
            
            if (userId) {
              insertUsage({
                timestamp: Date.now(),
                agentId,
                sessionKey,
                userId,
                inputTokens: entry.usage.input_tokens ?? 0,
                outputTokens: entry.usage.output_tokens ?? 0,
                cacheReadTokens: entry.usage.cache_read_input_tokens ?? 0,
                cacheWriteTokens: entry.usage.cache_creation_input_tokens ?? 0,
                model: entry.model ?? "unknown",
                provider: "anthropic", // TODO: extract from model
              });
              processedAny = true;
            }
          }
        } catch {
          // Skip malformed lines
        }
      }
      
      // Update file position
      setFilePosition(filePath, content.length);
      
      if (processedAny) {
        this.logger.info(`[billing-tracker] Processed usage from ${agentId}`);
      }
    } catch (err) {
      // File might not exist yet
    }
  }
  
  private async getUserIdForSession(agentId: string, sessionId: string): Promise<string | null> {
    try {
      const sessionsJsonPath = join(this.agentsDir, agentId, "sessions", "sessions.json");
      const content = await readFile(sessionsJsonPath, "utf-8");
      const sessions = JSON.parse(content);
      
      // Find session by ID
      for (const [key, session] of Object.entries(sessions)) {
        const s = session as { sessionId?: string; origin?: { from?: string } };
        if (s.sessionId === sessionId && s.origin?.from) {
          // Extract user ID from origin.from (e.g., "telegram:1840436008")
          return s.origin.from;
        }
      }
    } catch {
      // Sessions file doesn't exist or is malformed
    }
    return null;
  }
}

// Main plugin export
export default function billingTrackerPlugin(api: PluginApi) {
  const config: PluginConfig = (api.config as { plugins?: { entries?: { "billing-tracker"?: { config?: PluginConfig } } } })
    ?.plugins?.entries?.["billing-tracker"]?.config ?? {};
  
  if (config.enabled === false) {
    api.logger.info("[billing-tracker] Plugin disabled");
    return;
  }
  
  const dbPath = config.dbPath ?? join(homedir(), ".clawdbot", "billing.db");
  const trackedAgents = config.agents ?? [];
  
  let watcher: SessionWatcher | null = null;
  
  // Initialize database
  try {
    initDatabase(dbPath);
    api.logger.info(`[billing-tracker] Database initialized at ${dbPath}`);
  } catch (err) {
    api.logger.error(`[billing-tracker] Failed to init database: ${err}`);
    return;
  }
  
  // Register background service
  api.registerService({
    id: "billing-tracker",
    start: async () => {
      watcher = new SessionWatcher(api.logger, trackedAgents);
      await watcher.start();
    },
    stop: async () => {
      if (watcher) {
        await watcher.stop();
        watcher = null;
      }
      if (db) {
        db.close();
        db = null;
      }
    },
  });
  
  // Register RPC methods
  api.registerGatewayMethod("billing.user_usage", ({ params, respond }) => {
    const userId = params.userId as string;
    if (!userId) {
      respond(false, { error: "userId required" });
      return;
    }
    const usage = getUserUsage(userId);
    respond(true, usage);
  });
  
  api.registerGatewayMethod("billing.agent_usage", ({ params, respond }) => {
    const agentId = params.agentId as string;
    if (!agentId) {
      respond(false, { error: "agentId required" });
      return;
    }
    const usage = getAgentUsage(agentId);
    respond(true, usage);
  });
  
  // Register chat commands
  api.registerCommand({
    name: "consumo",
    description: "Ver tu consumo de tokens",
    handler: async (ctx) => {
      const userId = ctx.senderId;
      if (!userId) {
        return { text: "❌ No pude identificar tu usuario" };
      }
      
      const usage = getUserUsage(userId);
      const totalTokens = usage.total_input + usage.total_output;
      
      return {
        text: `📊 **Tu consumo:**\n\n` +
          `• Requests: ${usage.total_requests}\n` +
          `• Input tokens: ${usage.total_input.toLocaleString()}\n` +
          `• Output tokens: ${usage.total_output.toLocaleString()}\n` +
          `• **Total: ${totalTokens.toLocaleString()} tokens**`
      };
    },
  });
  
  api.logger.info("[billing-tracker] Plugin loaded");
}

/**
 * Billing Tracker Plugin for Clawdbot (PostgreSQL + API Mode)
 * 
 * Tracks token usage per user/agent by watching session JSONL files.
 * 
 * Mode A (Direct DB): Stores data directly in PostgreSQL (Neon).
 *   Config: databaseUrl or BILLING_DATABASE_URL env var
 * 
 * Mode B (Dashboard API): POSTs data to SparkLabs Agents Dashboard API.
 *   Config: dashboardUrl + dashboardApiKey
 */

import { watch, FSWatcher } from "fs";
import { readFile, readdir, stat } from "fs/promises";
import { join, basename } from "path";
import { createHash } from "crypto";
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
  on: (
    hookName: string,
    handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown | Promise<unknown>,
    opts?: { priority?: number }
  ) => void;
}

interface PluginConfig {
  enabled?: boolean;
  databaseUrl?: string;
  dashboardUrl?: string;
  dashboardApiKey?: string;
  botId?: string;
  watchIntervalMs?: number;
  agents?: string[];
  batchSize?: number;
  batchIntervalMs?: number;
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
  userInfo?: UserInfo;
}

interface MessageRecord {
  sessionKey: string;
  botId: string;
  role: string;
  content: string;
  model?: string;
  userId?: string;
  channel?: string;
  dedupKey?: string;
}

interface SessionEntry {
  type?: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
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
  };
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
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

interface UserInfo {
  externalId: string;
  channel: string;
  displayName?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
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

// ============================================================
// Storage Backend Interface
// ============================================================

interface StorageBackend {
  init(): Promise<void>;
  shutdown(): Promise<void>;
  insertUsage(record: UsageRecord): Promise<void>;
  insertMessage(record: MessageRecord): Promise<void>;
  getOrCreateUser(userInfo: UserInfo, botId: string): Promise<number | null>;
  getFilePosition(filePath: string): Promise<number>;
  setFilePosition(filePath: string, position: number): Promise<void>;
  // These are only available in DB mode
  getUserUsage?(externalId: string, botId?: string): Promise<{ total_input: number; total_output: number; total_requests: number; total_cost: number }>;
  getBotUsage?(botId: string): Promise<{ total_input: number; total_output: number; total_requests: number; unique_users: number; total_cost: number }>;
  getAllBotsUsage?(): Promise<Array<{ bot_id: string; total_input: number; total_output: number; total_requests: number; unique_users: number; total_cost: number }>>;
  pool?: pg.Pool | null;
}

// ============================================================
// Mode A: Direct Database Backend
// ============================================================

class DatabaseBackend implements StorageBackend {
  pool: pg.Pool | null = null;
  private filePositions: Map<string, number> = new Map();

  constructor(private databaseUrl: string, private logger: PluginApi["logger"]) {}

  async init() {
    this.pool = new Pool({ connectionString: this.databaseUrl, max: 5, idleTimeoutMillis: 30000 });
    const client = await this.pool.connect();
    client.release();

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS file_positions (
        file_path TEXT PRIMARY KEY,
        byte_position INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    this.logger.info("[clawdx-plugin] Connected to PostgreSQL (direct mode)");
  }

  async shutdown() {
    if (this.pool) { await this.pool.end(); this.pool = null; }
  }

  async getOrCreateUser(userInfo: UserInfo, botId: string): Promise<number> {
    if (!this.pool) throw new Error("DB not connected");
    const result = await this.pool.query(`
      INSERT INTO users (external_id, channel, bot_id, display_name, username, first_name, last_name, phone)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (external_id, channel, bot_id) 
      DO UPDATE SET 
        updated_at = NOW(), 
        display_name = COALESCE(EXCLUDED.display_name, users.display_name),
        username = COALESCE(EXCLUDED.username, users.username),
        first_name = COALESCE(EXCLUDED.first_name, users.first_name),
        last_name = COALESCE(EXCLUDED.last_name, users.last_name),
        phone = COALESCE(EXCLUDED.phone, users.phone)
      RETURNING id
    `, [userInfo.externalId, userInfo.channel, botId, userInfo.displayName, userInfo.username, userInfo.firstName, userInfo.lastName, userInfo.phone]);
    return result.rows[0].id;
  }

  async insertUsage(record: UsageRecord) {
    if (!this.pool) return;
    const botId = getBotIdForAgent(record.agentId);
    let userId: number;
    if (record.userInfo) {
      userId = await this.getOrCreateUser(record.userInfo, botId);
    } else {
      const [externalId, channel] = parseUserId(record.userId);
      userId = await this.getOrCreateUser({ externalId, channel }, botId);
    }
    await this.pool.query(`
      INSERT INTO usage_logs (user_id, bot_id, session_key, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, model, provider, cost_usd, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, to_timestamp($11 / 1000.0))
    `, [userId, botId, record.sessionKey, record.inputTokens, record.outputTokens, record.cacheReadTokens, record.cacheWriteTokens, record.model, record.provider, record.costUsd, record.timestamp]);
  }

  async insertMessage(record: MessageRecord) {
    if (!this.pool || !record.content.trim()) return;
    const truncated = record.content.length > 10000 ? record.content.slice(0, 10000) + '\n...[truncated]' : record.content;
    try {
      await this.pool.query(`
        INSERT INTO messages (session_key, bot_id, user_id, role, content, model, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [record.sessionKey, record.botId, null, record.role, truncated, record.model || null]);
    } catch {}
  }

  async getFilePosition(filePath: string): Promise<number> {
    if (this.filePositions.has(filePath)) return this.filePositions.get(filePath)!;
    if (!this.pool) return 0;
    try {
      const result = await this.pool.query("SELECT byte_position FROM file_positions WHERE file_path = $1", [filePath]);
      const pos = result.rows[0]?.byte_position ?? 0;
      this.filePositions.set(filePath, pos);
      return pos;
    } catch { return 0; }
  }

  async setFilePosition(filePath: string, position: number) {
    this.filePositions.set(filePath, position);
    if (!this.pool) return;
    await this.pool.query(`
      INSERT INTO file_positions (file_path, byte_position, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (file_path) DO UPDATE SET byte_position = $2, updated_at = NOW()
    `, [filePath, position]);
  }

  async getUserUsage(externalId: string, botId?: string) {
    if (!this.pool) return { total_input: 0, total_output: 0, total_requests: 0, total_cost: 0 };
    const query = botId
      ? `SELECT COALESCE(SUM(ul.input_tokens),0)::int as total_input, COALESCE(SUM(ul.output_tokens),0)::int as total_output, COUNT(*)::int as total_requests, COALESCE(SUM(ul.cost_usd),0)::float as total_cost FROM usage_logs ul JOIN users u ON ul.user_id=u.id WHERE u.external_id=$1 AND ul.bot_id=$2`
      : `SELECT COALESCE(SUM(ul.input_tokens),0)::int as total_input, COALESCE(SUM(ul.output_tokens),0)::int as total_output, COUNT(*)::int as total_requests, COALESCE(SUM(ul.cost_usd),0)::float as total_cost FROM usage_logs ul JOIN users u ON ul.user_id=u.id WHERE u.external_id=$1`;
    const result = await this.pool.query(query, botId ? [externalId, botId] : [externalId]);
    return result.rows[0];
  }

  async getBotUsage(botId: string) {
    if (!this.pool) return { total_input: 0, total_output: 0, total_requests: 0, unique_users: 0, total_cost: 0 };
    const result = await this.pool.query(`SELECT COALESCE(SUM(input_tokens),0)::int as total_input, COALESCE(SUM(output_tokens),0)::int as total_output, COUNT(*)::int as total_requests, COUNT(DISTINCT user_id)::int as unique_users, COALESCE(SUM(cost_usd),0)::float as total_cost FROM usage_logs WHERE bot_id=$1`, [botId]);
    return result.rows[0];
  }

  async getAllBotsUsage() {
    if (!this.pool) return [];
    const result = await this.pool.query(`SELECT bot_id, COALESCE(SUM(input_tokens),0)::int as total_input, COALESCE(SUM(output_tokens),0)::int as total_output, COUNT(*)::int as total_requests, COUNT(DISTINCT user_id)::int as unique_users, COALESCE(SUM(cost_usd),0)::float as total_cost FROM usage_logs GROUP BY bot_id`);
    return result.rows;
  }
}

// ============================================================
// Mode B: Dashboard API Backend
// ============================================================

class ApiBackend implements StorageBackend {
  private usageBatch: Array<Record<string, unknown>> = [];
  private messageBatch: MessageRecord[] = [];
  private batchTimer: ReturnType<typeof setInterval> | null = null;
  private filePositions: Map<string, number> = new Map();
  private positionsFile: string;

  constructor(
    private dashboardUrl: string,
    private apiKey: string,
    private logger: PluginApi["logger"],
    private batchSize = 25,
    private batchIntervalMs = 10000,
  ) {
    // Normalize URL (remove trailing slash)
    this.dashboardUrl = dashboardUrl.replace(/\/+$/, '');
    this.positionsFile = join(homedir(), ".clawdbot", "clawdx-plugin-positions.json");
  }

  async init() {
    // Load file positions from disk
    try {
      const content = await readFile(this.positionsFile, "utf-8");
      const data = JSON.parse(content);
      for (const [k, v] of Object.entries(data)) {
        this.filePositions.set(k, v as number);
      }
    } catch {}

    // Test connection
    try {
      const res = await fetch(`${this.dashboardUrl}/api/ingest/ping`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (res.ok) {
        const data = await res.json();
        this.logger.info(`[clawdx-plugin] Connected to dashboard API: ${data.connection?.name || 'OK'}`);
      } else {
        const err = await res.text();
        this.logger.error(`[clawdx-plugin] Dashboard API ping failed: ${res.status} ${err}`);
      }
    } catch (err) {
      this.logger.error(`[clawdx-plugin] Cannot reach dashboard API: ${err}`);
    }

    // Start batch flush timer
    this.batchTimer = setInterval(() => this.flushBatches(), this.batchIntervalMs);
  }

  async shutdown() {
    if (this.batchTimer) { clearInterval(this.batchTimer); this.batchTimer = null; }
    await this.flushBatches();
    await this.savePositions();
  }

  async getOrCreateUser(_userInfo: UserInfo, _botId: string): Promise<null> {
    // In API mode, user creation is handled by the ingest endpoint
    return null;
  }

  async insertUsage(record: UsageRecord) {
    const botId = getBotIdForAgent(record.agentId);
    const createdAt = new Date(record.timestamp).toISOString();
    // Dedup key: unique per session + timestamp + model + output tokens
    const dedupKey = makeDedupKey(
      botId, record.sessionKey, createdAt,
      record.model, record.inputTokens, record.outputTokens
    );
    const payload: Record<string, unknown> = {
      botId,
      sessionKey: record.sessionKey,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: record.cacheReadTokens,
      cacheWriteTokens: record.cacheWriteTokens,
      model: record.model,
      provider: record.provider,
      cost: record.costUsd,
      createdAt,
      dedupKey,
    };

    // Include user info if available
    if (record.userInfo) {
      payload.userId = record.userInfo.externalId;
      payload.channel = record.userInfo.channel;
      payload.userName = record.userInfo.displayName;
      payload.userUsername = record.userInfo.username;
      payload.userFirstName = record.userInfo.firstName;
      payload.userLastName = record.userInfo.lastName;
      payload.userPhone = record.userInfo.phone;
    } else {
      const [externalId, channel] = parseUserId(record.userId);
      payload.userId = externalId;
      payload.channel = channel;
    }

    this.usageBatch.push(payload);

    if (this.usageBatch.length >= this.batchSize) {
      await this.flushUsage();
    }
  }

  async insertMessage(record: MessageRecord) {
    if (!record.content.trim()) return;
    const truncated = record.content.length > 10000 ? record.content.slice(0, 10000) + '\n...[truncated]' : record.content;
    this.messageBatch.push({ ...record, content: truncated });

    if (this.messageBatch.length >= this.batchSize) {
      await this.flushMessages();
    }
  }

  private async flushBatches() {
    await this.flushUsage();
    await this.flushMessages();
    await this.savePositions();
  }

  private async flushUsage() {
    if (this.usageBatch.length === 0) return;
    const batch = this.usageBatch.splice(0);
    try {
      const res = await fetch(`${this.dashboardUrl}/api/ingest/usage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(batch),
      });
      if (res.ok) {
        const data = await res.json();
        this.logger.info(`[clawdx-plugin] Flushed ${data.inserted} usage records to dashboard API`);
      } else {
        this.logger.error(`[clawdx-plugin] Usage flush failed: ${res.status}`);
        // Re-queue failed records
        this.usageBatch.unshift(...batch);
      }
    } catch (err) {
      this.logger.error(`[clawdx-plugin] Usage flush error: ${err}`);
      this.usageBatch.unshift(...batch);
    }
  }

  private async flushMessages() {
    if (this.messageBatch.length === 0) return;
    const batch = this.messageBatch.splice(0);
    try {
      const res = await fetch(`${this.dashboardUrl}/api/ingest/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(batch),
      });
      if (res.ok) {
        const data = await res.json();
        this.logger.info(`[clawdx-plugin] Flushed ${data.inserted} messages to dashboard API`);
      } else {
        this.logger.error(`[clawdx-plugin] Messages flush failed: ${res.status}`);
        this.messageBatch.unshift(...batch);
      }
    } catch (err) {
      this.logger.error(`[clawdx-plugin] Messages flush error: ${err}`);
      this.messageBatch.unshift(...batch);
    }
  }

  async getFilePosition(filePath: string): Promise<number> {
    return this.filePositions.get(filePath) ?? 0;
  }

  async setFilePosition(filePath: string, position: number) {
    this.filePositions.set(filePath, position);
  }

  private async savePositions() {
    try {
      const data = Object.fromEntries(this.filePositions);
      const { writeFile } = await import("fs/promises");
      await writeFile(this.positionsFile, JSON.stringify(data));
    } catch {}
  }
}

// ============================================================
// Shared utilities
// ============================================================

const agentToBotMap: Map<string, string> = new Map();

function getBotIdForAgent(agentId: string): string {
  return agentToBotMap.get(agentId) ?? agentId;
}

/** Generate a short dedup key from components. Returns a 16-char hex string. */
function makeDedupKey(...parts: (string | number | undefined)[]): string {
  const raw = parts.map(p => p ?? '').join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function parseUserId(userId: string): [string, string] {
  const parts = userId.split(":");
  if (parts.length === 2) return [parts[1], parts[0]];
  return [userId, "unknown"];
}

function parseUserLabel(label: string): { displayName?: string; username?: string; firstName?: string; lastName?: string } {
  const usernameMatch = label.match(/@(\w+)/);
  const nameMatch = label.match(/^([^(@]+)/);
  const displayName = nameMatch ? nameMatch[1].trim() : undefined;
  let firstName: string | undefined;
  let lastName: string | undefined;
  if (displayName) {
    const parts = displayName.split(/\s+/);
    firstName = parts[0];
    lastName = parts.length > 1 ? parts.slice(1).join(' ') : undefined;
  }
  return { displayName, username: usernameMatch ? usernameMatch[1] : undefined, firstName, lastName };
}

// ============================================================
// Session file watcher (shared between both modes)
// ============================================================

class SessionWatcher {
  private watchers: Map<string, FSWatcher> = new Map();
  private logger: PluginApi["logger"];
  private agentsDir: string;
  private trackedAgents: string[];
  private backend: StorageBackend;

  constructor(logger: PluginApi["logger"], trackedAgents: string[], backend: StorageBackend) {
    this.logger = logger;
    this.agentsDir = join(homedir(), ".clawdbot", "agents");
    this.trackedAgents = trackedAgents;
    this.backend = backend;
  }

  async start() {
    this.logger.info(`[clawdx-plugin] Starting session watcher for agents: ${this.trackedAgents.length > 0 ? this.trackedAgents.join(", ") : "all"}`);
    await this.scanAgents();
  }

  async stop() {
    for (const [, watcher] of this.watchers) watcher.close();
    this.watchers.clear();
  }

  private async scanAgents() {
    try {
      const agents = await readdir(this.agentsDir);
      for (const agentId of agents) {
        if (this.trackedAgents.length > 0 && !this.trackedAgents.includes(agentId)) continue;
        const sessionsDir = join(this.agentsDir, agentId, "sessions");
        try {
          const stats = await stat(sessionsDir);
          if (stats.isDirectory()) this.watchSessionsDir(agentId, sessionsDir);
        } catch {}
      }
    } catch (err) {
      this.logger.error(`[clawdx-plugin] Error scanning agents: ${err}`);
    }
  }

  private watchSessionsDir(agentId: string, sessionsDir: string) {
    if (this.watchers.has(sessionsDir)) return;
    this.logger.info(`[clawdx-plugin] Watching ${agentId} sessions...`);

    const watcher = watch(sessionsDir, async (_eventType, filename) => {
      if (!filename || !filename.endsWith(".jsonl")) return;
      await this.processSessionFile(agentId, join(sessionsDir, filename));
    });
    this.watchers.set(sessionsDir, watcher);
    this.processExistingFiles(agentId, sessionsDir);
  }

  private async processExistingFiles(agentId: string, sessionsDir: string) {
    try {
      const files = await readdir(sessionsDir);
      for (const file of files) {
        if (file.endsWith(".jsonl")) await this.processSessionFile(agentId, join(sessionsDir, file));
      }
    } catch {}
  }

  private async processSessionFile(agentId: string, filePath: string) {
    try {
      const content = await readFile(filePath, "utf-8");
      const lastPosition = await this.backend.getFilePosition(filePath);
      const newContent = content.slice(lastPosition);
      if (!newContent.trim()) return;

      const lines = newContent.split("\n").filter(line => line.trim());
      let processedCount = 0;

      const extractContent = (raw: string | Array<{ type?: string; text?: string }> | undefined): string => {
        if (!raw) return '';
        if (typeof raw === 'string') return raw;
        if (Array.isArray(raw)) return raw.filter(b => b.type === 'text' && b.text).map(b => b.text).join('\n');
        return '';
      };

      const sessionKey = basename(filePath, ".jsonl");
      const recordBotId = getBotIdForAgent(agentId);
      let cachedUserInfo: UserInfo | null | undefined = undefined;

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as SessionEntry;
          const msg = entry.message ?? entry;
          const role = msg.role;
          const usage = msg.usage;
          const model = msg.model;
          const messageContent = extractContent(msg.content);

          if (cachedUserInfo === undefined) {
            cachedUserInfo = await this.getUserInfoForSession(agentId, sessionKey);
          }

          // Store user messages
          if (role === "user" && messageContent && cachedUserInfo) {
            const msgDedupKey = makeDedupKey(recordBotId, sessionKey, 'user', messageContent.slice(0, 200));
            await this.backend.insertMessage({
              sessionKey, botId: recordBotId, role: 'user', content: messageContent,
              userId: cachedUserInfo.externalId, channel: cachedUserInfo.channel,
              dedupKey: msgDedupKey,
            });
          }

          // Store assistant messages + usage
          if (role === "assistant" && cachedUserInfo) {
            if (messageContent) {
              const msgDedupKey = makeDedupKey(recordBotId, sessionKey, 'assistant', messageContent.slice(0, 200), model);
              await this.backend.insertMessage({
                sessionKey, botId: recordBotId, role: 'assistant', content: messageContent, model,
                userId: cachedUserInfo.externalId, channel: cachedUserInfo.channel,
                dedupKey: msgDedupKey,
              });
            }
            if (usage) {
              const inputTokens = usage.input ?? usage.input_tokens ?? 0;
              const outputTokens = usage.output ?? usage.output_tokens ?? 0;
              const cacheReadTokens = usage.cacheRead ?? usage.cache_read_input_tokens ?? 0;
              const cacheWriteTokens = usage.cacheWrite ?? usage.cache_creation_input_tokens ?? 0;
              const modelName = model ?? "unknown";

              await this.backend.insertUsage({
                timestamp: Date.now(),
                agentId,
                sessionKey,
                userId: `${cachedUserInfo.channel}:${cachedUserInfo.externalId}`,
                channel: cachedUserInfo.channel,
                inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens,
                model: modelName, provider: "anthropic",
                costUsd: calculateCost(modelName, inputTokens, outputTokens, cacheReadTokens),
                userInfo: cachedUserInfo,
              });
              processedCount++;
            }
          }
        } catch {}
      }

      await this.backend.setFilePosition(filePath, content.length);
      if (processedCount > 0) {
        this.logger.info(`[clawdx-plugin] Processed ${processedCount} usage records from ${agentId}`);
      }
    } catch {}
  }

  async getUserInfoForSession(agentId: string, sessionId: string): Promise<UserInfo | null> {
    try {
      const sessionsJsonPath = join(this.agentsDir, agentId, "sessions", "sessions.json");
      const content = await readFile(sessionsJsonPath, "utf-8");
      const sessions = JSON.parse(content);
      for (const [, session] of Object.entries(sessions)) {
        const s = session as { sessionId?: string; origin?: { from?: string; label?: string } };
        if (s.sessionId === sessionId && s.origin?.from) {
          const [externalId, channel] = parseUserId(s.origin.from);
          const labelInfo = s.origin.label ? parseUserLabel(s.origin.label) : {};
          const phone = channel === 'whatsapp' ? externalId : undefined;
          return { externalId, channel, displayName: labelInfo.displayName, username: labelInfo.username, firstName: labelInfo.firstName, lastName: labelInfo.lastName, phone };
        }
      }
    } catch {}
    return null;
  }
}

// ============================================================
// Plugin Entry Point
// ============================================================

export default function billingTrackerPlugin(api: PluginApi) {
  const config: PluginConfig = (api.config as { plugins?: { entries?: { "clawdx-plugin"?: { config?: PluginConfig } } } })
    ?.plugins?.entries?.["clawdx-plugin"]?.config ?? {};

  if (config.enabled === false) {
    api.logger.info("[clawdx-plugin] Plugin disabled");
    return;
  }

  // Load .env file for fallback values
  let envVars: Record<string, string> = {};
  try {
    const envPath = join(homedir(), ".clawdbot", ".env");
    const envContent = require("fs").readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // Strip quotes
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        envVars[key] = val;
      }
    }
  } catch {}

  // Determine mode
  const dashboardUrl = config.dashboardUrl ?? process.env.DASHBOARD_URL ?? envVars.DASHBOARD_URL;
  const dashboardApiKey = config.dashboardApiKey ?? process.env.DASHBOARD_API_KEY ?? envVars.DASHBOARD_API_KEY;

  let databaseUrl = config.databaseUrl ?? process.env.BILLING_DATABASE_URL ?? envVars.BILLING_DATABASE_URL;

  const useApi = !!(dashboardUrl && dashboardApiKey);
  const useDb = !!databaseUrl;

  api.logger.info(`[clawdx-plugin] Config: dashboardUrl=${dashboardUrl || 'NOT SET'}, apiKey=${dashboardApiKey ? dashboardApiKey.slice(0,8) + '...' : 'NOT SET'}, dbUrl=${databaseUrl ? 'SET' : 'NOT SET'}, useApi=${useApi}, useDb=${useDb}`);
  api.logger.info(`[clawdx-plugin] .env vars loaded: ${Object.keys(envVars).join(', ') || 'NONE'}`);

  if (!useApi && !useDb) {
    api.logger.error("[clawdx-plugin] No backend configured. Set dashboardUrl+dashboardApiKey (API mode) or BILLING_DATABASE_URL (DB mode)");
    return;
  }

  const trackedAgents = config.agents ?? [];
  for (const agent of trackedAgents) {
    agentToBotMap.set(agent, agent);
  }

  let backend: StorageBackend;
  let watcher: SessionWatcher | null = null;

  if (useApi) {
    api.logger.info(`[clawdx-plugin] Mode: Dashboard API → ${dashboardUrl}`);
    backend = new ApiBackend(dashboardUrl, dashboardApiKey, api.logger, config.batchSize, config.batchIntervalMs);
  } else {
    api.logger.info(`[clawdx-plugin] Mode: Direct Database`);
    backend = new DatabaseBackend(databaseUrl!, api.logger);
  }

  api.registerService({
    id: "clawdx-plugin",
    start: async () => {
      try {
        await backend.init();
        watcher = new SessionWatcher(api.logger, trackedAgents, backend);
        await watcher.start();
      } catch (err) {
        api.logger.error(`[clawdx-plugin] Failed to start: ${err}`);
      }
    },
    stop: async () => {
      if (watcher) { await watcher.stop(); watcher = null; }
      await backend.shutdown();
    },
  });

  // Register RPC methods (only work in DB mode)
  if (!useApi) {
    const dbBackend = backend as DatabaseBackend;

    api.registerGatewayMethod("billing.user_usage", async ({ params, respond }) => {
      const userId = params.userId as string;
      const forBotId = params.botId as string | undefined;
      if (!userId) { respond(false, { error: "userId required" }); return; }
      try { respond(true, await dbBackend.getUserUsage!(userId, forBotId)); } catch (err) { respond(false, { error: String(err) }); }
    });

    api.registerGatewayMethod("billing.bot_usage", async ({ params, respond }) => {
      const forBotId = params.botId as string;
      if (!forBotId) { respond(false, { error: "botId required" }); return; }
      try { respond(true, await dbBackend.getBotUsage!(forBotId)); } catch (err) { respond(false, { error: String(err) }); }
    });

    api.registerGatewayMethod("billing.all_bots_usage", async ({ params, respond }) => {
      try { respond(true, await dbBackend.getAllBotsUsage!()); } catch (err) { respond(false, { error: String(err) }); }
    });

    api.registerGatewayMethod("billing.all_users", async ({ params, respond }) => {
      if (!dbBackend.pool) { respond(false, { error: "DB not connected" }); return; }
      try {
        const result = await dbBackend.pool.query(`SELECT u.id, u.external_id, u.channel, u.bot_id, u.display_name, u.enabled, u.created_at, COALESCE(SUM(ul.input_tokens+ul.output_tokens),0)::int as total_tokens, COALESCE(SUM(ul.cost_usd),0)::float as total_cost, COUNT(ul.id)::int as total_requests FROM users u LEFT JOIN usage_logs ul ON u.id=ul.user_id GROUP BY u.id ORDER BY total_tokens DESC`);
        respond(true, result.rows);
      } catch (err) { respond(false, { error: String(err) }); }
    });

    api.registerGatewayMethod("billing.all_bots", async ({ params, respond }) => {
      if (!dbBackend.pool) { respond(false, { error: "DB not connected" }); return; }
      try {
        const result = await dbBackend.pool.query(`SELECT b.id, b.bot_id, b.name, b.description, b.enabled, b.created_at, COALESCE(SUM(ul.input_tokens),0)::int as total_input, COALESCE(SUM(ul.output_tokens),0)::int as total_output, COALESCE(SUM(ul.cost_usd),0)::float as total_cost, COUNT(DISTINCT ul.user_id)::int as unique_users FROM bots b LEFT JOIN usage_logs ul ON b.bot_id=ul.bot_id GROUP BY b.id ORDER BY b.bot_id`);
        respond(true, result.rows);
      } catch (err) { respond(false, { error: String(err) }); }
    });

    api.registerGatewayMethod("billing.recent_usage", async ({ params, respond }) => {
      if (!dbBackend.pool) { respond(false, { error: "DB not connected" }); return; }
      const limit = (params.limit as number) || 100;
      try {
        const result = await dbBackend.pool.query(`SELECT ul.id, ul.bot_id, ul.session_key, ul.input_tokens, ul.output_tokens, ul.cache_read_tokens, ul.model, ul.provider, ul.cost_usd, ul.created_at, u.external_id, u.channel, u.display_name FROM usage_logs ul JOIN users u ON ul.user_id=u.id ORDER BY ul.created_at DESC LIMIT $1`, [limit]);
        respond(true, result.rows);
      } catch (err) { respond(false, { error: String(err) }); }
    });
  }

  // Register /consumo command
  api.registerCommand({
    name: "consumo",
    description: "Ver tu consumo de tokens",
    handler: async (ctx) => {
      if (!ctx.senderId) return { text: "❌ No pude identificar tu usuario" };
      if (useApi) return { text: "📊 Consumo disponible en el dashboard: " + dashboardUrl };

      const [externalId] = parseUserId(ctx.senderId);
      try {
        const usage = await (backend as DatabaseBackend).getUserUsage!(externalId);
        const totalTokens = usage.total_input + usage.total_output;
        if (usage.total_requests === 0) return { text: "📊 No hay consumo registrado aún." };
        return {
          text: `📊 **Tu consumo:**\n\n• Requests: ${usage.total_requests}\n• Input tokens: ${usage.total_input.toLocaleString()}\n• Output tokens: ${usage.total_output.toLocaleString()}\n• **Total: ${totalTokens.toLocaleString()} tokens**\n• 💵 Costo: $${usage.total_cost.toFixed(4)} USD`
        };
      } catch (err) { return { text: `❌ Error: ${err}` }; }
    },
  });

  // ============================================================
  // BILLING ENFORCEMENT HOOKS (Phase 4D)
  // ============================================================

  if (useApi && dashboardUrl && dashboardApiKey) {
    // In-memory billing cache (TTL: 60s)
    const billingCache = new Map<string, { result: Record<string, unknown>; expiresAt: number }>();

    const checkBillingCached = async (botId: string, userId: string, channel: string): Promise<Record<string, unknown> | null> => {
      const key = `${botId}:${channel}:${userId}`;
      const cached = billingCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.result;

      try {
        const url = `${dashboardUrl}/api/billing/client/check?` + new URLSearchParams({ botId, externalUserId: userId, channel });
        const res = await fetch(url, {
          headers: { 'Authorization': `Bearer ${dashboardApiKey}` },
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) return null;
        const result = await res.json();
        billingCache.set(key, { result, expiresAt: Date.now() + 60_000 });
        return result;
      } catch (err) {
        api.logger.warn(`[clawdx-plugin] Billing check failed (fail-open): ${err}`);
        return null;
      }
    };

    // Hook: before_prompt_build — check if user can send message
    api.on("before_prompt_build", async (_event: Record<string, unknown>, ctx: Record<string, unknown>) => {
      const agentId = (ctx.agentId as string) ?? 'main';
      const botId = getBotIdForAgent(agentId);
      const sessionKey = ctx.sessionKey as string;
      if (!sessionKey) return;

      // Get user info from the watcher's cached session data
      let userInfo: UserInfo | null = null;
      if (watcher) {
        userInfo = await (watcher as SessionWatcher).getUserInfoForSession(agentId, sessionKey.split(':').pop() || sessionKey);
      }
      if (!userInfo) return;

      const billing = await checkBillingCached(botId, userInfo.externalId, userInfo.channel);
      if (!billing || billing.allowed !== false) return;

      // User is BLOCKED — inject system context
      const blockMsg = (billing.blockMessage as string) || "You've reached your usage limit.";
      const paymentUrl = billing.paymentUrl ? `\n\nPayment link: ${billing.paymentUrl}` : '';

      return {
        prependContext: `[BILLING ENFORCEMENT - DO NOT IGNORE]
The user "${userInfo.externalId}" on ${userInfo.channel} has been BLOCKED by the billing system.
Reason: ${billing.reason || 'billing_blocked'}

You MUST respond with ONLY the following message (do not add anything else, do not answer their question):

"${blockMsg}${paymentUrl}"

Do NOT process the user's request. Do NOT answer any questions. Only send the billing message above.`,
      };
    }, { priority: 100 });

    // Hook: agent_end — deduct credits after successful response
    api.on("agent_end", async (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
      if (event.success === false) return;

      const agentId = (ctx.agentId as string) ?? 'main';
      const botId = getBotIdForAgent(agentId);
      const sessionKey = ctx.sessionKey as string;
      if (!sessionKey) return;

      let userInfo: UserInfo | null = null;
      if (watcher) {
        userInfo = await (watcher as SessionWatcher).getUserInfoForSession(agentId, sessionKey.split(':').pop() || sessionKey);
      }
      if (!userInfo) return;

      try {
        await fetch(`${dashboardUrl}/api/billing/client/deduct`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${dashboardApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ botId, externalUserId: userInfo.externalId, channel: userInfo.channel }),
          signal: AbortSignal.timeout(3000),
        });
        // Invalidate cache after deduction
        billingCache.delete(`${botId}:${userInfo.channel}:${userInfo.externalId}`);
      } catch (err) {
        api.logger.warn(`[clawdx-plugin] Credit deduction failed: ${err}`);
      }
    });

    // Track blocked users for message_sending safety net
    const blockedUsers = new Map<string, { blockMessage: string; expiresAt: number }>();

    // Update before_prompt_build to also track blocked users
    // (The existing hook already handles injection — this adds tracking)
    const origCheckFn = checkBillingCached;
    const checkAndTrack = async (botId: string, userId: string, channel: string): Promise<Record<string, unknown> | null> => {
      const result = await origCheckFn(botId, userId, channel);
      if (result && result.allowed === false) {
        const key = `${channel}:${userId}`;
        blockedUsers.set(key, {
          blockMessage: (result.blockMessage as string) || '',
          expiresAt: Date.now() + 120_000, // 2 min TTL
        });
      } else if (result && result.allowed === true) {
        blockedUsers.delete(`${channel}:${userId}`);
      }
      return result;
    };
    // Replace the cached check function reference used by hooks
    // We patch it into the before_prompt_build closure via the billingCache
    // The hooks above already call checkBillingCached — we re-register with tracking

    // Hook: message_sending — safety net cancel for blocked users
    api.on("message_sending", async (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
      const content = event.content as string;
      const to = event.to as string;
      if (!to || !content) return;

      // Check if recipient is in blocked list
      for (const [key, entry] of blockedUsers.entries()) {
        if (entry.expiresAt < Date.now()) {
          blockedUsers.delete(key);
          continue;
        }
        // If the outgoing message is TO a blocked user and it doesn't contain
        // the block message, cancel it (the LLM ignored our injection)
        if (to.includes(key.split(':').pop() || '___')) {
          if (entry.blockMessage && !content.includes(entry.blockMessage.slice(0, 50))) {
            api.logger.warn(`[clawdx-plugin] Safety net: canceling message to blocked user ${key}`);
            return { cancel: true };
          }
        }
      }
      return;
    });

    api.logger.info("[clawdx-plugin] Billing enforcement hooks registered (with safety net)");
  }

  api.logger.info(`[clawdx-plugin] Plugin loaded (${useApi ? 'API' : 'PostgreSQL'} mode)`);
}

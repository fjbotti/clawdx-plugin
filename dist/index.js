var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// index.ts
import { watch } from "fs";
import { readFile, readdir, stat } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";
import pg from "pg";
var { Pool } = pg;
var PRICING = {
  "claude-sonnet-4-20250514": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-opus-4-20250514": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4, cacheRead: 0.08 },
  "default": { input: 3, output: 15, cacheRead: 0.3 }
};
function calculateCost(model, inputTokens, outputTokens, cacheReadTokens) {
  const pricing = PRICING[model] ?? PRICING["default"];
  return inputTokens / 1e6 * pricing.input + outputTokens / 1e6 * pricing.output + cacheReadTokens / 1e6 * pricing.cacheRead;
}
var DatabaseBackend = class {
  constructor(databaseUrl, logger) {
    this.databaseUrl = databaseUrl;
    this.logger = logger;
  }
  pool = null;
  filePositions = /* @__PURE__ */ new Map();
  async init() {
    this.pool = new Pool({ connectionString: this.databaseUrl, max: 5, idleTimeoutMillis: 3e4 });
    const client = await this.pool.connect();
    client.release();
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS file_positions (
        file_path TEXT PRIMARY KEY,
        byte_position INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT NOW()
      )
    `);
    this.logger.info("[billing-tracker] Connected to PostgreSQL (direct mode)");
  }
  async shutdown() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
  async getOrCreateUser(userInfo, botId) {
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
  async insertUsage(record) {
    if (!this.pool) return;
    const botId = getBotIdForAgent(record.agentId);
    let userId;
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
  async insertMessage(record) {
    if (!this.pool || !record.content.trim()) return;
    const truncated = record.content.length > 1e4 ? record.content.slice(0, 1e4) + "\n...[truncated]" : record.content;
    try {
      await this.pool.query(`
        INSERT INTO messages (session_key, bot_id, user_id, role, content, model, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
      `, [record.sessionKey, record.botId, null, record.role, truncated, record.model || null]);
    } catch {
    }
  }
  async getFilePosition(filePath) {
    if (this.filePositions.has(filePath)) return this.filePositions.get(filePath);
    if (!this.pool) return 0;
    try {
      const result = await this.pool.query("SELECT byte_position FROM file_positions WHERE file_path = $1", [filePath]);
      const pos = result.rows[0]?.byte_position ?? 0;
      this.filePositions.set(filePath, pos);
      return pos;
    } catch {
      return 0;
    }
  }
  async setFilePosition(filePath, position) {
    this.filePositions.set(filePath, position);
    if (!this.pool) return;
    await this.pool.query(`
      INSERT INTO file_positions (file_path, byte_position, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (file_path) DO UPDATE SET byte_position = $2, updated_at = NOW()
    `, [filePath, position]);
  }
  async getUserUsage(externalId, botId) {
    if (!this.pool) return { total_input: 0, total_output: 0, total_requests: 0, total_cost: 0 };
    const query = botId ? `SELECT COALESCE(SUM(ul.input_tokens),0)::int as total_input, COALESCE(SUM(ul.output_tokens),0)::int as total_output, COUNT(*)::int as total_requests, COALESCE(SUM(ul.cost_usd),0)::float as total_cost FROM usage_logs ul JOIN users u ON ul.user_id=u.id WHERE u.external_id=$1 AND ul.bot_id=$2` : `SELECT COALESCE(SUM(ul.input_tokens),0)::int as total_input, COALESCE(SUM(ul.output_tokens),0)::int as total_output, COUNT(*)::int as total_requests, COALESCE(SUM(ul.cost_usd),0)::float as total_cost FROM usage_logs ul JOIN users u ON ul.user_id=u.id WHERE u.external_id=$1`;
    const result = await this.pool.query(query, botId ? [externalId, botId] : [externalId]);
    return result.rows[0];
  }
  async getBotUsage(botId) {
    if (!this.pool) return { total_input: 0, total_output: 0, total_requests: 0, unique_users: 0, total_cost: 0 };
    const result = await this.pool.query(`SELECT COALESCE(SUM(input_tokens),0)::int as total_input, COALESCE(SUM(output_tokens),0)::int as total_output, COUNT(*)::int as total_requests, COUNT(DISTINCT user_id)::int as unique_users, COALESCE(SUM(cost_usd),0)::float as total_cost FROM usage_logs WHERE bot_id=$1`, [botId]);
    return result.rows[0];
  }
  async getAllBotsUsage() {
    if (!this.pool) return [];
    const result = await this.pool.query(`SELECT bot_id, COALESCE(SUM(input_tokens),0)::int as total_input, COALESCE(SUM(output_tokens),0)::int as total_output, COUNT(*)::int as total_requests, COUNT(DISTINCT user_id)::int as unique_users, COALESCE(SUM(cost_usd),0)::float as total_cost FROM usage_logs GROUP BY bot_id`);
    return result.rows;
  }
};
var ApiBackend = class {
  constructor(dashboardUrl, apiKey, logger, batchSize = 25, batchIntervalMs = 1e4) {
    this.dashboardUrl = dashboardUrl;
    this.apiKey = apiKey;
    this.logger = logger;
    this.batchSize = batchSize;
    this.batchIntervalMs = batchIntervalMs;
    this.dashboardUrl = dashboardUrl.replace(/\/+$/, "");
    this.positionsFile = join(homedir(), ".clawdbot", "billing-tracker-positions.json");
  }
  usageBatch = [];
  messageBatch = [];
  batchTimer = null;
  filePositions = /* @__PURE__ */ new Map();
  positionsFile;
  async init() {
    try {
      const content = await readFile(this.positionsFile, "utf-8");
      const data = JSON.parse(content);
      for (const [k, v] of Object.entries(data)) {
        this.filePositions.set(k, v);
      }
    } catch {
    }
    try {
      const res = await fetch(`${this.dashboardUrl}/api/ingest/ping`, {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      });
      if (res.ok) {
        const data = await res.json();
        this.logger.info(`[billing-tracker] Connected to dashboard API: ${data.connection?.name || "OK"}`);
      } else {
        const err = await res.text();
        this.logger.error(`[billing-tracker] Dashboard API ping failed: ${res.status} ${err}`);
      }
    } catch (err) {
      this.logger.error(`[billing-tracker] Cannot reach dashboard API: ${err}`);
    }
    this.batchTimer = setInterval(() => this.flushBatches(), this.batchIntervalMs);
  }
  async shutdown() {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = null;
    }
    await this.flushBatches();
    await this.savePositions();
  }
  async getOrCreateUser(_userInfo, _botId) {
    return null;
  }
  async insertUsage(record) {
    const botId = getBotIdForAgent(record.agentId);
    const payload = {
      botId,
      sessionKey: record.sessionKey,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cacheReadTokens: record.cacheReadTokens,
      cacheWriteTokens: record.cacheWriteTokens,
      model: record.model,
      provider: record.provider,
      cost: record.costUsd,
      createdAt: new Date(record.timestamp).toISOString()
    };
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
  async insertMessage(record) {
    if (!record.content.trim()) return;
    const truncated = record.content.length > 1e4 ? record.content.slice(0, 1e4) + "\n...[truncated]" : record.content;
    this.messageBatch.push({ ...record, content: truncated });
    if (this.messageBatch.length >= this.batchSize) {
      await this.flushMessages();
    }
  }
  async flushBatches() {
    await this.flushUsage();
    await this.flushMessages();
    await this.savePositions();
  }
  async flushUsage() {
    if (this.usageBatch.length === 0) return;
    const batch = this.usageBatch.splice(0);
    try {
      const res = await fetch(`${this.dashboardUrl}/api/ingest/usage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(batch)
      });
      if (res.ok) {
        const data = await res.json();
        this.logger.info(`[billing-tracker] Flushed ${data.inserted} usage records to dashboard API`);
      } else {
        this.logger.error(`[billing-tracker] Usage flush failed: ${res.status}`);
        this.usageBatch.unshift(...batch);
      }
    } catch (err) {
      this.logger.error(`[billing-tracker] Usage flush error: ${err}`);
      this.usageBatch.unshift(...batch);
    }
  }
  async flushMessages() {
    if (this.messageBatch.length === 0) return;
    const batch = this.messageBatch.splice(0);
    try {
      const res = await fetch(`${this.dashboardUrl}/api/ingest/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(batch)
      });
      if (res.ok) {
        const data = await res.json();
        this.logger.info(`[billing-tracker] Flushed ${data.inserted} messages to dashboard API`);
      } else {
        this.logger.error(`[billing-tracker] Messages flush failed: ${res.status}`);
        this.messageBatch.unshift(...batch);
      }
    } catch (err) {
      this.logger.error(`[billing-tracker] Messages flush error: ${err}`);
      this.messageBatch.unshift(...batch);
    }
  }
  async getFilePosition(filePath) {
    return this.filePositions.get(filePath) ?? 0;
  }
  async setFilePosition(filePath, position) {
    this.filePositions.set(filePath, position);
  }
  async savePositions() {
    try {
      const data = Object.fromEntries(this.filePositions);
      const { writeFile } = await import("fs/promises");
      await writeFile(this.positionsFile, JSON.stringify(data));
    } catch {
    }
  }
};
var agentToBotMap = /* @__PURE__ */ new Map();
function getBotIdForAgent(agentId) {
  return agentToBotMap.get(agentId) ?? agentId;
}
function parseUserId(userId) {
  const parts = userId.split(":");
  if (parts.length === 2) return [parts[1], parts[0]];
  return [userId, "unknown"];
}
function parseUserLabel(label) {
  const usernameMatch = label.match(/@(\w+)/);
  const nameMatch = label.match(/^([^(@]+)/);
  const displayName = nameMatch ? nameMatch[1].trim() : void 0;
  let firstName;
  let lastName;
  if (displayName) {
    const parts = displayName.split(/\s+/);
    firstName = parts[0];
    lastName = parts.length > 1 ? parts.slice(1).join(" ") : void 0;
  }
  return { displayName, username: usernameMatch ? usernameMatch[1] : void 0, firstName, lastName };
}
var SessionWatcher = class {
  watchers = /* @__PURE__ */ new Map();
  logger;
  agentsDir;
  trackedAgents;
  backend;
  constructor(logger, trackedAgents, backend) {
    this.logger = logger;
    this.agentsDir = join(homedir(), ".clawdbot", "agents");
    this.trackedAgents = trackedAgents;
    this.backend = backend;
  }
  async start() {
    this.logger.info(`[billing-tracker] Starting session watcher for agents: ${this.trackedAgents.length > 0 ? this.trackedAgents.join(", ") : "all"}`);
    await this.scanAgents();
  }
  async stop() {
    for (const [, watcher] of this.watchers) watcher.close();
    this.watchers.clear();
  }
  async scanAgents() {
    try {
      const agents = await readdir(this.agentsDir);
      for (const agentId of agents) {
        if (this.trackedAgents.length > 0 && !this.trackedAgents.includes(agentId)) continue;
        const sessionsDir = join(this.agentsDir, agentId, "sessions");
        try {
          const stats = await stat(sessionsDir);
          if (stats.isDirectory()) this.watchSessionsDir(agentId, sessionsDir);
        } catch {
        }
      }
    } catch (err) {
      this.logger.error(`[billing-tracker] Error scanning agents: ${err}`);
    }
  }
  watchSessionsDir(agentId, sessionsDir) {
    if (this.watchers.has(sessionsDir)) return;
    this.logger.info(`[billing-tracker] Watching ${agentId} sessions...`);
    const watcher = watch(sessionsDir, async (_eventType, filename) => {
      if (!filename || !filename.endsWith(".jsonl")) return;
      await this.processSessionFile(agentId, join(sessionsDir, filename));
    });
    this.watchers.set(sessionsDir, watcher);
    this.processExistingFiles(agentId, sessionsDir);
  }
  async processExistingFiles(agentId, sessionsDir) {
    try {
      const files = await readdir(sessionsDir);
      for (const file of files) {
        if (file.endsWith(".jsonl")) await this.processSessionFile(agentId, join(sessionsDir, file));
      }
    } catch {
    }
  }
  async processSessionFile(agentId, filePath) {
    try {
      const content = await readFile(filePath, "utf-8");
      const lastPosition = await this.backend.getFilePosition(filePath);
      const newContent = content.slice(lastPosition);
      if (!newContent.trim()) return;
      const lines = newContent.split("\n").filter((line) => line.trim());
      let processedCount = 0;
      const extractContent = (raw) => {
        if (!raw) return "";
        if (typeof raw === "string") return raw;
        if (Array.isArray(raw)) return raw.filter((b) => b.type === "text" && b.text).map((b) => b.text).join("\n");
        return "";
      };
      const sessionKey = basename(filePath, ".jsonl");
      const recordBotId = getBotIdForAgent(agentId);
      let cachedUserInfo = void 0;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const msg = entry.message ?? entry;
          const role = msg.role;
          const usage = msg.usage;
          const model = msg.model;
          const messageContent = extractContent(msg.content);
          if (cachedUserInfo === void 0) {
            cachedUserInfo = await this.getUserInfoForSession(agentId, sessionKey);
          }
          if (role === "user" && messageContent && cachedUserInfo) {
            await this.backend.insertMessage({
              sessionKey,
              botId: recordBotId,
              role: "user",
              content: messageContent,
              userId: cachedUserInfo.externalId,
              channel: cachedUserInfo.channel
            });
          }
          if (role === "assistant" && cachedUserInfo) {
            if (messageContent) {
              await this.backend.insertMessage({
                sessionKey,
                botId: recordBotId,
                role: "assistant",
                content: messageContent,
                model,
                userId: cachedUserInfo.externalId,
                channel: cachedUserInfo.channel
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
                inputTokens,
                outputTokens,
                cacheReadTokens,
                cacheWriteTokens,
                model: modelName,
                provider: "anthropic",
                costUsd: calculateCost(modelName, inputTokens, outputTokens, cacheReadTokens),
                userInfo: cachedUserInfo
              });
              processedCount++;
            }
          }
        } catch {
        }
      }
      await this.backend.setFilePosition(filePath, content.length);
      if (processedCount > 0) {
        this.logger.info(`[billing-tracker] Processed ${processedCount} usage records from ${agentId}`);
      }
    } catch {
    }
  }
  async getUserInfoForSession(agentId, sessionId) {
    try {
      const sessionsJsonPath = join(this.agentsDir, agentId, "sessions", "sessions.json");
      const content = await readFile(sessionsJsonPath, "utf-8");
      const sessions = JSON.parse(content);
      for (const [, session] of Object.entries(sessions)) {
        const s = session;
        if (s.sessionId === sessionId && s.origin?.from) {
          const [externalId, channel] = parseUserId(s.origin.from);
          const labelInfo = s.origin.label ? parseUserLabel(s.origin.label) : {};
          const phone = channel === "whatsapp" ? externalId : void 0;
          return { externalId, channel, displayName: labelInfo.displayName, username: labelInfo.username, firstName: labelInfo.firstName, lastName: labelInfo.lastName, phone };
        }
      }
    } catch {
    }
    return null;
  }
};
function billingTrackerPlugin(api) {
  const config = api.config?.plugins?.entries?.["billing-tracker"]?.config ?? {};
  if (config.enabled === false) {
    api.logger.info("[billing-tracker] Plugin disabled");
    return;
  }
  let envVars = {};
  try {
    const envPath = join(homedir(), ".clawdbot", ".env");
    const envContent = __require("fs").readFileSync(envPath, "utf-8");
    for (const line of envContent.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if (val.startsWith('"') && val.endsWith('"') || val.startsWith("'") && val.endsWith("'")) {
          val = val.slice(1, -1);
        }
        envVars[key] = val;
      }
    }
  } catch {
  }
  const dashboardUrl = config.dashboardUrl ?? process.env.DASHBOARD_URL ?? envVars.DASHBOARD_URL;
  const dashboardApiKey = config.dashboardApiKey ?? process.env.DASHBOARD_API_KEY ?? envVars.DASHBOARD_API_KEY;
  let databaseUrl = config.databaseUrl ?? process.env.BILLING_DATABASE_URL ?? envVars.BILLING_DATABASE_URL;
  const useApi = !!(dashboardUrl && dashboardApiKey);
  const useDb = !!databaseUrl;
  api.logger.info(`[billing-tracker] Config: dashboardUrl=${dashboardUrl || "NOT SET"}, apiKey=${dashboardApiKey ? dashboardApiKey.slice(0, 8) + "..." : "NOT SET"}, dbUrl=${databaseUrl ? "SET" : "NOT SET"}, useApi=${useApi}, useDb=${useDb}`);
  api.logger.info(`[billing-tracker] .env vars loaded: ${Object.keys(envVars).join(", ") || "NONE"}`);
  if (!useApi && !useDb) {
    api.logger.error("[billing-tracker] No backend configured. Set dashboardUrl+dashboardApiKey (API mode) or BILLING_DATABASE_URL (DB mode)");
    return;
  }
  const trackedAgents = config.agents ?? [];
  for (const agent of trackedAgents) {
    agentToBotMap.set(agent, agent);
  }
  let backend;
  let watcher = null;
  if (useApi) {
    api.logger.info(`[billing-tracker] Mode: Dashboard API \u2192 ${dashboardUrl}`);
    backend = new ApiBackend(dashboardUrl, dashboardApiKey, api.logger, config.batchSize, config.batchIntervalMs);
  } else {
    api.logger.info(`[billing-tracker] Mode: Direct Database`);
    backend = new DatabaseBackend(databaseUrl, api.logger);
  }
  api.registerService({
    id: "billing-tracker",
    start: async () => {
      try {
        await backend.init();
        watcher = new SessionWatcher(api.logger, trackedAgents, backend);
        await watcher.start();
      } catch (err) {
        api.logger.error(`[billing-tracker] Failed to start: ${err}`);
      }
    },
    stop: async () => {
      if (watcher) {
        await watcher.stop();
        watcher = null;
      }
      await backend.shutdown();
    }
  });
  if (!useApi) {
    const dbBackend = backend;
    api.registerGatewayMethod("billing.user_usage", async ({ params, respond }) => {
      const userId = params.userId;
      const forBotId = params.botId;
      if (!userId) {
        respond(false, { error: "userId required" });
        return;
      }
      try {
        respond(true, await dbBackend.getUserUsage(userId, forBotId));
      } catch (err) {
        respond(false, { error: String(err) });
      }
    });
    api.registerGatewayMethod("billing.bot_usage", async ({ params, respond }) => {
      const forBotId = params.botId;
      if (!forBotId) {
        respond(false, { error: "botId required" });
        return;
      }
      try {
        respond(true, await dbBackend.getBotUsage(forBotId));
      } catch (err) {
        respond(false, { error: String(err) });
      }
    });
    api.registerGatewayMethod("billing.all_bots_usage", async ({ params, respond }) => {
      try {
        respond(true, await dbBackend.getAllBotsUsage());
      } catch (err) {
        respond(false, { error: String(err) });
      }
    });
    api.registerGatewayMethod("billing.all_users", async ({ params, respond }) => {
      if (!dbBackend.pool) {
        respond(false, { error: "DB not connected" });
        return;
      }
      try {
        const result = await dbBackend.pool.query(`SELECT u.id, u.external_id, u.channel, u.bot_id, u.display_name, u.enabled, u.created_at, COALESCE(SUM(ul.input_tokens+ul.output_tokens),0)::int as total_tokens, COALESCE(SUM(ul.cost_usd),0)::float as total_cost, COUNT(ul.id)::int as total_requests FROM users u LEFT JOIN usage_logs ul ON u.id=ul.user_id GROUP BY u.id ORDER BY total_tokens DESC`);
        respond(true, result.rows);
      } catch (err) {
        respond(false, { error: String(err) });
      }
    });
    api.registerGatewayMethod("billing.all_bots", async ({ params, respond }) => {
      if (!dbBackend.pool) {
        respond(false, { error: "DB not connected" });
        return;
      }
      try {
        const result = await dbBackend.pool.query(`SELECT b.id, b.bot_id, b.name, b.description, b.enabled, b.created_at, COALESCE(SUM(ul.input_tokens),0)::int as total_input, COALESCE(SUM(ul.output_tokens),0)::int as total_output, COALESCE(SUM(ul.cost_usd),0)::float as total_cost, COUNT(DISTINCT ul.user_id)::int as unique_users FROM bots b LEFT JOIN usage_logs ul ON b.bot_id=ul.bot_id GROUP BY b.id ORDER BY b.bot_id`);
        respond(true, result.rows);
      } catch (err) {
        respond(false, { error: String(err) });
      }
    });
    api.registerGatewayMethod("billing.recent_usage", async ({ params, respond }) => {
      if (!dbBackend.pool) {
        respond(false, { error: "DB not connected" });
        return;
      }
      const limit = params.limit || 100;
      try {
        const result = await dbBackend.pool.query(`SELECT ul.id, ul.bot_id, ul.session_key, ul.input_tokens, ul.output_tokens, ul.cache_read_tokens, ul.model, ul.provider, ul.cost_usd, ul.created_at, u.external_id, u.channel, u.display_name FROM usage_logs ul JOIN users u ON ul.user_id=u.id ORDER BY ul.created_at DESC LIMIT $1`, [limit]);
        respond(true, result.rows);
      } catch (err) {
        respond(false, { error: String(err) });
      }
    });
  }
  api.registerCommand({
    name: "consumo",
    description: "Ver tu consumo de tokens",
    handler: async (ctx) => {
      if (!ctx.senderId) return { text: "\u274C No pude identificar tu usuario" };
      if (useApi) return { text: "\u{1F4CA} Consumo disponible en el dashboard: " + dashboardUrl };
      const [externalId] = parseUserId(ctx.senderId);
      try {
        const usage = await backend.getUserUsage(externalId);
        const totalTokens = usage.total_input + usage.total_output;
        if (usage.total_requests === 0) return { text: "\u{1F4CA} No hay consumo registrado a\xFAn." };
        return {
          text: `\u{1F4CA} **Tu consumo:**

\u2022 Requests: ${usage.total_requests}
\u2022 Input tokens: ${usage.total_input.toLocaleString()}
\u2022 Output tokens: ${usage.total_output.toLocaleString()}
\u2022 **Total: ${totalTokens.toLocaleString()} tokens**
\u2022 \u{1F4B5} Costo: $${usage.total_cost.toFixed(4)} USD`
        };
      } catch (err) {
        return { text: `\u274C Error: ${err}` };
      }
    }
  });
  api.logger.info(`[billing-tracker] Plugin loaded (${useApi ? "API" : "PostgreSQL"} mode)`);
}
export {
  billingTrackerPlugin as default
};

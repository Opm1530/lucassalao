/**
 * PostgreSQL persistence layer.
 * Tables: config, conversations, logs
 *
 * getConfig / getAllConfig remain SYNCHRONOUS via an in-memory cache
 * so that trinks.js / openai.js / etc. need no changes.
 * All conversation and log functions are ASYNC.
 *
 * Call db.init() at startup and await it before app.listen().
 */

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: false,
});

// ─── In-memory config cache (for sync reads) ──────────────────────────────────

const DEFAULTS = {
  openai_model: 'gpt-4o',
  bot_active: 'true',
  trinks_base_url: 'https://api.trinks.com',
  max_history: '20',
};

let configCache = { ...DEFAULTS };

// ─── Schema ───────────────────────────────────────────────────────────────────

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    phone       TEXT PRIMARY KEY,
    history     JSONB        NOT NULL DEFAULT '[]',
    stage       TEXT         NOT NULL DEFAULT 'novo',
    human_mode  BOOLEAN      NOT NULL DEFAULT FALSE,
    client_data JSONB,
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS logs (
    id         SERIAL      PRIMARY KEY,
    phone      TEXT        NOT NULL,
    direction  TEXT        NOT NULL,
    content    TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS logs_phone_idx          ON logs(phone);
  CREATE INDEX IF NOT EXISTS conversations_updated_idx ON conversations(updated_at DESC);
`;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await pool.query(SCHEMA);

  // Load all config rows into the in-memory cache
  const { rows } = await pool.query('SELECT key, value FROM config');
  for (const row of rows) {
    configCache[row.key] = row.value;
  }

  console.log('[DB] PostgreSQL conectado e schema aplicado.');
}

// ─── Config (SYNC reads, ASYNC writes) ───────────────────────────────────────

function getConfig(key) {
  return configCache[key] ?? null;
}

function getAllConfig() {
  return { ...configCache };
}

function setConfig(key, value) {
  configCache[key] = String(value);
  pool.query(
    'INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [key, String(value)]
  ).catch((err) => console.error('[DB] setConfig error:', err.message));
}

function setConfigs(obj) {
  for (const [k, v] of Object.entries(obj)) {
    setConfig(k, v);
  }
}

// ─── Conversations (ASYNC) ───────────────────────────────────────────────────

async function getConversation(phone) {
  const { rows } = await pool.query('SELECT * FROM conversations WHERE phone = $1', [phone]);
  if (rows.length === 0) {
    return { phone, history: [], stage: 'novo', client_data: null, human_mode: false };
  }
  const row = rows[0];
  return {
    phone: row.phone,
    history: row.history || [],
    stage: row.stage || 'novo',
    client_data: row.client_data || null,
    human_mode: row.human_mode === true,
  };
}

async function saveConversation(phone, history, stage, clientData = null, humanMode = null) {
  // If humanMode is null, keep the existing value
  if (humanMode === null) {
    await pool.query(
      `INSERT INTO conversations (phone, history, stage, client_data, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (phone) DO UPDATE SET
         history     = $2,
         stage       = $3,
         client_data = $4,
         updated_at  = NOW()`,
      [phone, JSON.stringify(history), stage, clientData ? JSON.stringify(clientData) : null]
    );
  } else {
    await pool.query(
      `INSERT INTO conversations (phone, history, stage, client_data, human_mode, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (phone) DO UPDATE SET
         history     = $2,
         stage       = $3,
         client_data = $4,
         human_mode  = $5,
         updated_at  = NOW()`,
      [phone, JSON.stringify(history), stage, clientData ? JSON.stringify(clientData) : null, humanMode]
    );
  }
}

async function setHumanMode(phone, active) {
  const stage = active ? 'humano' : 'novo';
  await pool.query(
    `INSERT INTO conversations (phone, history, stage, human_mode, updated_at)
     VALUES ($1, '[]', $2, $3, NOW())
     ON CONFLICT (phone) DO UPDATE SET
       human_mode = $3,
       stage      = $2,
       updated_at = NOW()`,
    [phone, stage, active]
  );
}

async function isHumanMode(phone) {
  const { rows } = await pool.query('SELECT human_mode FROM conversations WHERE phone = $1', [phone]);
  return rows[0]?.human_mode === true;
}

async function clearConversation(phone) {
  await pool.query('DELETE FROM conversations WHERE phone = $1', [phone]);
}

async function listConversations() {
  const { rows } = await pool.query(
    `SELECT phone, history, stage, human_mode, client_data, updated_at
     FROM conversations
     ORDER BY updated_at DESC
     LIMIT 50`
  );

  return rows.map((row) => {
    const hist = row.history || [];
    const lastMsg = hist.length > 0 ? hist[hist.length - 1].content : null;
    let last_message = null;
    if (lastMsg) {
      try {
        const parsed = JSON.parse(lastMsg);
        last_message = parsed.mensagens?.[0] || null;
      } catch {
        last_message = lastMsg;
      }
    }
    return {
      phone: row.phone,
      stage: row.stage,
      human_mode: row.human_mode || false,
      updated_at: row.updated_at ? Math.floor(new Date(row.updated_at).getTime() / 1000) : null,
      last_message,
    };
  });
}

// ─── Logs (ASYNC) ─────────────────────────────────────────────────────────────

async function addLog(phone, direction, content) {
  await pool.query(
    'INSERT INTO logs (phone, direction, content) VALUES ($1, $2, $3)',
    [phone, direction, content]
  );

  // Keep only last 5000 rows (async cleanup, non-blocking)
  pool.query(
    `DELETE FROM logs WHERE id IN (
       SELECT id FROM logs ORDER BY id DESC OFFSET 5000
     )`
  ).catch(() => {});
}

async function getLogs(phone, limit = 50) {
  const { rows } = await pool.query(
    `SELECT phone, direction, content,
            EXTRACT(EPOCH FROM created_at)::BIGINT AS created_at
     FROM logs
     WHERE phone = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [phone, limit]
  );
  return rows;
}

module.exports = {
  init,
  getConfig,
  getAllConfig,
  setConfig,
  setConfigs,
  getConversation,
  saveConversation,
  clearConversation,
  listConversations,
  setHumanMode,
  isHumanMode,
  addLog,
  getLogs,
};

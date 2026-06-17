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
  openai_model: 'gpt-4o-mini',
  bot_active: 'true',
  trinks_base_url: 'https://api.trinks.com',
  max_history: '12',
  // Limite diário de tokens da OpenAI — ao atingir, o bot para de responder até meia-noite
  // 0 = sem limite. 2M tokens/dia ≈ $0.30/dia no gpt-4o-mini ou $5/dia no gpt-4o
  openai_daily_token_limit: '2000000',
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

  CREATE TABLE IF NOT EXISTS aniversario_disparos (
    id         SERIAL PRIMARY KEY,
    cliente_id TEXT   NOT NULL,
    phone      TEXT   NOT NULL,
    nome       TEXT,
    data_envio DATE   NOT NULL,
    UNIQUE(cliente_id, data_envio)
  );

  CREATE TABLE IF NOT EXISTS confirmacao_disparos (
    id              SERIAL      PRIMARY KEY,
    agendamento_id  TEXT        NOT NULL,
    phone           TEXT        NOT NULL,
    cliente_nome    TEXT,
    servico         TEXT,
    data_agendamento TEXT,
    horario         TEXT,
    status          TEXT        NOT NULL DEFAULT 'enviado',
    enviado_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    respondido_em   TIMESTAMPTZ,
    UNIQUE(agendamento_id)
  );

  CREATE TABLE IF NOT EXISTS token_usage (
    dia       DATE  PRIMARY KEY,
    input     BIGINT NOT NULL DEFAULT 0,
    output    BIGINT NOT NULL DEFAULT 0,
    requests  INTEGER NOT NULL DEFAULT 0,
    custo_usd NUMERIC(10,4) NOT NULL DEFAULT 0
  );

  -- Log local de ações do bot (criação/cancelamento) para idempotência e sanidade
  -- Funciona como cache de curtíssimo prazo das ações do próprio bot.
  -- Limpeza automática: registros com mais de 7 dias são apagados pelo job.
  CREATE TABLE IF NOT EXISTS acoes_bot (
    id              SERIAL      PRIMARY KEY,
    tipo            TEXT        NOT NULL,  -- 'criado' | 'cancelado'
    trinks_id       TEXT,                  -- id do agendamento no Trinks
    phone           TEXT        NOT NULL,
    cliente_id      TEXT,
    servico         TEXT,
    data_agendamento DATE,
    horario         TEXT,
    profissional_id TEXT,
    criado_em       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_acoes_bot_lookup
    ON acoes_bot (phone, data_agendamento, horario, criado_em DESC);
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
    updated_at: row.updated_at || null,
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

// ─── Aniversários ─────────────────────────────────────────────────────────────

async function jaEnviouAniversarioHoje(clienteId) {
  const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
    .toISOString().split('T')[0];
  const { rows } = await pool.query(
    `SELECT 1 FROM aniversario_disparos WHERE cliente_id = $1 AND data_envio = $2 LIMIT 1`,
    [String(clienteId), hoje]
  );
  return rows.length > 0;
}

async function registrarAniversario(clienteId, phone, nome) {
  const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
    .toISOString().split('T')[0];
  await pool.query(
    `INSERT INTO aniversario_disparos (cliente_id, phone, nome, data_envio) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [String(clienteId), phone, nome, hoje]
  );
}

// ─── Confirmação de agendamentos ──────────────────────────────────────────────

async function registrarDisparo({ agendamentoId, phone, clienteNome, servico, dataAgendamento, horario }) {
  await pool.query(
    `INSERT INTO confirmacao_disparos (agendamento_id, phone, cliente_nome, servico, data_agendamento, horario)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (agendamento_id) DO NOTHING`,
    [String(agendamentoId), phone, clienteNome, servico, dataAgendamento, horario]
  );
}

async function jaEnviouDisparo(agendamentoId) {
  const { rows } = await pool.query(
    `SELECT 1 FROM confirmacao_disparos WHERE agendamento_id = $1 LIMIT 1`,
    [String(agendamentoId)]
  );
  return rows.length > 0;
}

async function atualizarStatusDisparo(agendamentoId, status) {
  await pool.query(
    `UPDATE confirmacao_disparos SET status = $1, respondido_em = NOW() WHERE agendamento_id = $2`,
    [status, String(agendamentoId)]
  );
}

async function getDisparoByPhone(phone) {
  const { rows } = await pool.query(
    `SELECT * FROM confirmacao_disparos WHERE phone = $1 AND status = 'enviado' ORDER BY enviado_em DESC LIMIT 1`,
    [phone]
  );
  return rows[0] || null;
}

async function listarDisparos(dataAgendamento) {
  const { rows } = await pool.query(
    `SELECT * FROM confirmacao_disparos WHERE data_agendamento = $1 ORDER BY horario ASC`,
    [dataAgendamento]
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
  jaEnviouAniversarioHoje,
  registrarAniversario,
  registrarDisparo,
  jaEnviouDisparo,
  atualizarStatusDisparo,
  getDisparoByPhone,
  listarDisparos,
  registrarUsoToken,
  getUsoTokenHoje,
  registrarAcaoBot,
  buscarAgendamentoRecente,
  limparAcoesAntigas,
};

// ─── Token usage (limite diário) ──────────────────────────────────────────────

function diaBrasilia() {
  // Retorna a data atual no fuso de Brasília no formato YYYY-MM-DD
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }))
    .toISOString().split('T')[0];
}

async function registrarUsoToken(input, output, custoUSD) {
  const dia = diaBrasilia();
  await pool.query(`
    INSERT INTO token_usage (dia, input, output, requests, custo_usd)
    VALUES ($1, $2, $3, 1, $4)
    ON CONFLICT (dia) DO UPDATE SET
      input = token_usage.input + EXCLUDED.input,
      output = token_usage.output + EXCLUDED.output,
      requests = token_usage.requests + 1,
      custo_usd = token_usage.custo_usd + EXCLUDED.custo_usd
  `, [dia, input, output, custoUSD]);
}

// ─── Ações do bot (idempotência local) ────────────────────────────────────────

/**
 * Registra uma ação do bot (criação ou cancelamento de agendamento).
 * Usado para detectar reprocessamentos e evitar duplicação.
 */
async function registrarAcaoBot({ tipo, trinksId, phone, clienteId, servico, dataAgendamento, horario, profissionalId }) {
  await pool.query(`
    INSERT INTO acoes_bot (tipo, trinks_id, phone, cliente_id, servico, data_agendamento, horario, profissional_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `, [tipo, trinksId, phone, clienteId, servico, dataAgendamento, horario, profissionalId]);
}

/**
 * Verifica se o bot já criou esse mesmo agendamento nos últimos N minutos.
 * Retorna o trinks_id do agendamento existente, ou null se não houver.
 * Janela padrão: 10 minutos (suficiente pra cobrir reprocessamentos de fila).
 */
async function buscarAgendamentoRecente({ phone, dataAgendamento, horario, servico }, minutosJanela = 10) {
  const { rows } = await pool.query(`
    SELECT trinks_id, criado_em FROM acoes_bot
    WHERE tipo = 'criado'
      AND phone = $1
      AND data_agendamento = $2
      AND horario = $3
      AND ($4::text IS NULL OR LOWER(servico) = LOWER($4))
      AND criado_em > NOW() - ($5 || ' minutes')::interval
    ORDER BY criado_em DESC
    LIMIT 1
  `, [phone, dataAgendamento, horario, servico || null, String(minutosJanela)]);
  return rows[0] || null;
}

/**
 * Limpa ações antigas (mais de 7 dias) — chamado periodicamente.
 */
async function limparAcoesAntigas() {
  await pool.query(`DELETE FROM acoes_bot WHERE criado_em < NOW() - INTERVAL '7 days'`);
}

async function getUsoTokenHoje() {
  const dia = diaBrasilia();
  const { rows } = await pool.query(
    'SELECT input, output, requests, custo_usd FROM token_usage WHERE dia = $1',
    [dia]
  );
  if (!rows[0]) return { input: 0, output: 0, total: 0, requests: 0, custo_usd: 0 };
  const r = rows[0];
  return {
    input: Number(r.input),
    output: Number(r.output),
    total: Number(r.input) + Number(r.output),
    requests: r.requests,
    custo_usd: Number(r.custo_usd),
  };
}

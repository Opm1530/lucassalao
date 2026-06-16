const express = require('express');
const router = express.Router();
const db = require('../db/database');
const evolutionService = require('../services/evolution');
const trinksService = require('../services/trinks');
const confirmacaoService = require('../services/confirmacao');

// ─── Config ───────────────────────────────────────────────────────────────────

router.get('/config', (req, res) => {
  const all = db.getAllConfig();
  // Mask secret fields for display
  const masked = { ...all };
  if (masked.openai_api_key) masked.openai_api_key = mask(masked.openai_api_key);
  if (masked.trinks_api_key) masked.trinks_api_key = mask(masked.trinks_api_key);
  if (masked.evolution_api_key) masked.evolution_api_key = mask(masked.evolution_api_key);
  res.json(masked);
});

router.get('/config/raw', (req, res) => {
  // Used internally by the frontend to populate form fields (with actual values)
  res.json(db.getAllConfig());
});

router.post('/config', (req, res) => {
  const allowed = [
    'bot_name',
    'salon_name',
    'openai_api_key',
    'openai_model',
    'trinks_api_key',
    'trinks_estabelecimento_id',
    'trinks_base_url',
    'evolution_url',
    'evolution_api_key',
    'evolution_instance',
    'bot_active',
    'max_history',
    'whatsapp_outros_servicos',
    'horario_fechamento',
    'openai_daily_token_limit',
  ];

  const toSave = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined && req.body[key] !== '') {
      toSave[key] = req.body[key];
    }
  }

  db.setConfigs(toSave);
  res.json({ success: true });
});

// ─── Endpoint público — QR Code (sem autenticação) ───────────────────────────

router.get('/public/qrcode', async (req, res) => {
  try {
    const state = await evolutionService.getConnectionState();
    if (state.state === 'open') {
      return res.json({ connected: true, state: 'open' });
    }
    const qr = await evolutionService.getQRCode();
    res.json({ connected: false, state: state.state, ...qr });
  } catch (err) {
    res.status(500).json({ connected: false, state: 'error', error: err.message });
  }
});

// ─── Status / WhatsApp ────────────────────────────────────────────────────────

router.get('/status', async (req, res) => {
  try {
    const state = await evolutionService.getConnectionState();
    res.json(state);
  } catch (err) {
    res.json({ state: 'error', error: err.message });
  }
});

router.get('/whatsapp/status', async (req, res) => {
  try {
    const state = await evolutionService.getConnectionState();
    // Evolution: 'open' = conectado; 'connecting' / 'close' = desconectado
    const connected = state.state === 'open';
    res.json({ connected, state: state.state });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

router.get('/qrcode', async (req, res) => {
  try {
    const qr = await evolutionService.getQRCode();
    res.json(qr);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/instances', async (req, res) => {
  try {
    const list = await evolutionService.listInstances();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/instance/create', async (req, res) => {
  try {
    const { instanceName } = req.body;
    if (!instanceName) return res.status(400).json({ error: 'instanceName obrigatório' });
    const result = await evolutionService.createInstance(instanceName);
    // Save the new instance name
    db.setConfig('evolution_instance', instanceName);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/instance/logout', async (req, res) => {
  try {
    await evolutionService.logoutInstance();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/webhook/set', async (req, res) => {
  try {
    const { webhookUrl } = req.body;
    if (!webhookUrl) return res.status(400).json({ error: 'webhookUrl obrigatório' });
    await evolutionService.setWebhook(webhookUrl);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bot control ─────────────────────────────────────────────────────────────

// Uso de tokens da OpenAI no dia atual + limite configurado
router.get('/openai/usage', async (req, res) => {
  try {
    const uso = await db.getUsoTokenHoje();
    const limite = parseInt(db.getConfig('openai_daily_token_limit') || '0', 10);
    res.json({
      ...uso,
      limite,
      percentual: limite > 0 ? Math.min(100, (uso.total / limite) * 100) : 0,
      bloqueado: limite > 0 && uso.total >= limite,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bot/toggle', (req, res) => {
  const current = db.getConfig('bot_active') === 'true';
  db.setConfig('bot_active', String(!current));
  res.json({ active: !current });
});

// Endpoint unificado para o painel do operador — retorna estado de todos os toggles
router.get('/operator-toggle/state', (req, res) => {
  res.json({
    bot_active: db.getConfig('bot_active') === 'true',
    confirmacao_automatica: db.getConfig('confirmacao_automatica') === 'true',
    aniversario_ativo: db.getConfig('aniversario_ativo') === 'true',
  });
});

// Alterna um toggle específico — usado pelo painel do operador
router.post('/operator-toggle/:key', (req, res) => {
  const allowed = ['bot_active', 'confirmacao_automatica', 'aniversario_ativo'];
  const key = req.params.key;
  if (!allowed.includes(key)) return res.status(400).json({ error: 'Chave inválida.' });
  const current = db.getConfig(key) === 'true';
  db.setConfig(key, String(!current));
  res.json({ key, active: !current });
});

// ─── Conversations ────────────────────────────────────────────────────────────

router.get('/conversations', async (req, res) => {
  try {
    const list = await db.listConversations();
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/conversations/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const conv = await db.getConversation(phone);
    const logs = await db.getLogs(phone, 100);
    res.json({ ...conv, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/conversations/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    await db.clearConversation(phone);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retornar conversa para o bot (sair do modo humano)
router.post('/conversations/:phone/bot-mode', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    await db.setHumanMode(phone, false);
    await db.addLog(phone, 'system', 'MODO_BOT_REATIVADO');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Forçar modo humano manualmente pelo dashboard
router.post('/conversations/:phone/human-mode', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    await db.setHumanMode(phone, true);
    await db.addLog(phone, 'system', 'MODO_HUMANO_ATIVADO_MANUAL');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retry: reprocessa mensagens do cliente que não tiveram resposta do bot
router.post('/conversations/:phone/retry', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const conv = await db.getConversation(phone);
    const history = conv.history || [];

    let textoFinal = null;
    let historyLimpo = history;

    // Estratégia 1: histórico termina com mensagens do cliente (fix novo)
    const lastMsg = history[history.length - 1];
    if (lastMsg?.role === 'user') {
      const mensagensCliente = [];
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'user') mensagensCliente.unshift(history[i].content);
        else break;
      }
      textoFinal = mensagensCliente.join('\n');
      historyLimpo = history.slice(0, history.length - mensagensCliente.length);
    }

    // Estratégia 2: histórico não tem as msgs (eram conversas antigas) — busca nos logs
    if (!textoFinal) {
      const logs = await db.getLogs(phone, 50);
      // Pega as mensagens consecutivas do cliente no final dos logs
      const logsNaoSistema = logs.filter(l => l.direction !== 'system');
      const lastLog = logsNaoSistema[logsNaoSistema.length - 1];
      if (!lastLog || lastLog.direction !== 'in') {
        return res.status(400).json({ error: 'Última mensagem já foi respondida pelo bot.' });
      }
      const msgsLogs = [];
      for (let i = logsNaoSistema.length - 1; i >= 0; i--) {
        if (logsNaoSistema[i].direction === 'in') msgsLogs.unshift(logsNaoSistema[i].content);
        else break;
      }
      textoFinal = msgsLogs.join('\n');
      // histórico permanece como está (não tem as msgs do cliente duplicadas)
    }

    if (!textoFinal) {
      return res.status(400).json({ error: 'Nenhuma mensagem do cliente encontrada.' });
    }

    // Salva histórico limpo (sem as msgs do cliente que serão reinseridas pelo processMessage)
    await db.saveConversation(phone, historyLimpo, conv.stage, conv.client_data);

    // Responde imediatamente e processa em background
    res.json({ success: true, mensagem: textoFinal });

    const { processMessageExternal } = require('./webhook');
    await processMessageExternal(phone, textoFinal);
  } catch (err) {
    console.error('[Retry] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Confirmação de agendamentos ─────────────────────────────────────────────

router.post('/confirmacoes/toggle', (req, res) => {
  const current = db.getConfig('confirmacao_automatica') === 'true';
  db.setConfig('confirmacao_automatica', String(!current));
  res.json({ confirmacao_automatica: !current });
});

router.post('/aniversario/toggle', (req, res) => {
  const current = db.getConfig('aniversario_ativo') === 'true';
  db.setConfig('aniversario_ativo', String(!current));
  res.json({ aniversario_ativo: !current });
});

// Listar agendamentos de uma data com status de disparo
router.get('/confirmacoes', async (req, res) => {
  try {
    const data = req.query.data || new Date().toISOString().split('T')[0];
    const [agendamentos, disparos] = await Promise.all([
      trinksService.listarAgendamentosPorData(data),
      db.listarDisparos(data),
    ]);
    const disparosMap = Object.fromEntries(disparos.map(d => [d.agendamento_id, d]));
    const resultado = agendamentos.map(ag => ({
      ...ag,
      disparo: disparosMap[String(ag.id)] || null,
    }));
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Disparar confirmações manualmente — data inteira ou IDs específicos
router.post('/confirmacoes/disparar', async (req, res) => {
  try {
    const { data, ids } = req.body;
    if (!data) return res.status(400).json({ error: 'Campo "data" obrigatório (YYYY-MM-DD)' });
    const resultados = await confirmacaoService.dispararConfirmacoes(data, ids || null);
    res.json({ success: true, resultados });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Prompt ───────────────────────────────────────────────────────────────────

router.get('/prompt', (req, res) => {
  const { SYSTEM_PROMPT } = require('../utils/prompt');
  const saved = db.getConfig('system_prompt');
  res.json({ prompt: saved || SYSTEM_PROMPT });
});

router.post('/prompt', (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Prompt não pode ser vazio.' });
  }
  db.setConfig('system_prompt', prompt.trim());
  res.json({ success: true });
});

router.post('/prompt/reset', (req, res) => {
  const { SYSTEM_PROMPT } = require('../utils/prompt');
  db.setConfig('system_prompt', SYSTEM_PROMPT);
  res.json({ success: true, prompt: SYSTEM_PROMPT });
});

// ─── Demo mode ───────────────────────────────────────────────────────────────

router.post('/demo/toggle', (req, res) => {
  const current = db.getConfig('demo_mode') === 'true';
  db.setConfig('demo_mode', String(!current));
  res.json({ demo: !current });
});

router.get('/demo/status', (req, res) => {
  res.json({ demo: db.getConfig('demo_mode') === 'true' });
});

// ─── Trinks test ─────────────────────────────────────────────────────────────

router.get('/trinks/test', async (req, res) => {
  try {
    const servicos = await trinksService.listarServicos();
    const profissionais = await trinksService.listarProfissionais();
    res.json({ ok: true, servicos: servicos.length, profissionais: profissionais.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mask(str) {
  if (!str || str.length < 8) return '****';
  return str.substring(0, 4) + '****' + str.substring(str.length - 4);
}

module.exports = router;

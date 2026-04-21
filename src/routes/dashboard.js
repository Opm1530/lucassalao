const express = require('express');
const router = express.Router();
const db = require('../db/database');
const evolutionService = require('../services/evolution');
const trinksService = require('../services/trinks');

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

// ─── Status / WhatsApp ────────────────────────────────────────────────────────

router.get('/status', async (req, res) => {
  try {
    const state = await evolutionService.getConnectionState();
    res.json(state);
  } catch (err) {
    res.json({ state: 'error', error: err.message });
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

router.post('/bot/toggle', (req, res) => {
  const current = db.getConfig('bot_active') === 'true';
  db.setConfig('bot_active', String(!current));
  res.json({ active: !current });
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

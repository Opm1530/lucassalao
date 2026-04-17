const axios = require('axios');
const db = require('../db/database');

function getClient() {
  const baseURL = db.getConfig('evolution_url');
  const apiKey = db.getConfig('evolution_api_key');

  if (!baseURL || !apiKey) {
    throw new Error('Evolution API não configurada. Configure a URL e a chave no dashboard.');
  }

  return axios.create({
    baseURL: baseURL.replace(/\/$/, ''),
    headers: {
      'apikey': apiKey,
      'Content-Type': 'application/json',
    },
    timeout: 15000,
  });
}

function getInstance() {
  const instance = db.getConfig('evolution_instance');
  if (!instance) throw new Error('Nome da instância Evolution não configurado.');
  return instance;
}

// ─── Mensagens ─────────────────────────────────────────────────────────────────

async function sendText(to, text) {
  const client = getClient();
  const instance = getInstance();

  // Remove @s.whatsapp.net if already present, then normalize
  const number = to.includes('@') ? to : `${to}@s.whatsapp.net`;

  const { data } = await client.post(`/message/sendText/${instance}`, {
    number,
    text,
  });

  return data;
}

async function markAsRead(remoteJid, messageId) {
  try {
    const client = getClient();
    const instance = getInstance();
    await client.post(`/message/markMessageAsRead/${instance}`, {
      readMessages: [{ remoteJid, id: messageId }],
    });
  } catch {
    // Non-critical — don't throw
  }
}

async function downloadMedia(message) {
  const client = getClient();
  const instance = getInstance();
  const { data } = await client.post(`/message/getBase64FromMediaMessage/${instance}`, {
    message,
    convertToMp4: false,
  });
  return { base64: data.base64, mimetype: data.mimetype };
}

async function sendMessages(to, messages) {
  for (const msg of messages) {
    if (!msg || !msg.trim()) continue;
    await sendText(to, msg);
    // Small delay between messages to preserve order
    await new Promise((r) => setTimeout(r, 400));
  }
}

// ─── Instância ─────────────────────────────────────────────────────────────────

async function getConnectionState() {
  try {
    const client = getClient();
    const instance = getInstance();
    const { data } = await client.get(`/instance/connectionState/${instance}`);
    return {
      state: data?.instance?.state ?? data?.state ?? 'unknown',
      instance,
    };
  } catch (err) {
    return { state: 'error', error: err.message };
  }
}

async function getQRCode() {
  const client = getClient();
  const instance = getInstance();
  const { data } = await client.get(`/instance/connect/${instance}`);
  return {
    base64: data?.base64 ?? data?.qrcode?.base64 ?? null,
    code: data?.code ?? data?.qrcode?.code ?? null,
  };
}

async function createInstance(instanceName) {
  const client = getClient();
  const { data } = await client.post('/instance/create', {
    instanceName,
    qrcode: true,
    integration: 'WHATSAPP-BAILEYS',
  });
  return data;
}

async function listInstances() {
  try {
    const client = getClient();
    const { data } = await client.get('/instance/fetchInstances');
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function logoutInstance() {
  const client = getClient();
  const instance = getInstance();
  await client.delete(`/instance/logout/${instance}`);
}

async function setWebhook(webhookUrl) {
  const client = getClient();
  const instance = getInstance();
  await client.post(`/webhook/set/${instance}`, {
    webhook: {
      enabled: true,
      url: webhookUrl,
      webhookByEvents: false,
      webhookBase64: false,
      events: ['MESSAGES_UPSERT'],
    },
  });
}

// ─── Parser de mensagens recebidas ────────────────────────────────────────────

function parseIncomingMessage(payload) {
  // Evolution v2 webhook payload
  const data = payload.data ?? payload;

  // Skip messages sent by the bot itself
  if (data?.key?.fromMe === true) return null;

  const remoteJid = data?.key?.remoteJid ?? '';

  // Only handle individual chats (not groups)
  if (remoteJid.endsWith('@g.us')) return null;
  if (!remoteJid) return null;

  const message = data?.message ?? {};

  // Detect audio
  const isAudio = !!(message.audioMessage || message.pttMessage);

  // Extract text from various message types
  const text =
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.ephemeralMessage?.message?.extendedTextMessage?.text ??
    message.editedMessage?.message?.protocolMessage?.editedMessage?.extendedTextMessage?.text ??
    null;

  // Accept only text or audio — ignore images, stickers, docs, etc.
  if (!text && !isAudio) return null;

  return {
    phone: remoteJid,
    text: text ? text.trim() : null,
    isAudio,
    messageData: isAudio ? data : null, // full data needed for download
    pushName: data?.pushName ?? '',
    messageId: data?.key?.id ?? '',
    instance: payload.instance ?? '',
  };
}

module.exports = {
  sendText,
  sendMessages,
  markAsRead,
  downloadMedia,
  getConnectionState,
  getQRCode,
  createInstance,
  listInstances,
  logoutInstance,
  setWebhook,
  parseIncomingMessage,
};

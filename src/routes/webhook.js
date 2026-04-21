const express = require('express');
const router = express.Router();
const db = require('../db/database');
const openaiService = require('../services/openai');
const trinksService = require('../services/trinks');
const evolutionService = require('../services/evolution');
const whisperService = require('../services/whisper');

// ─── Deduplicação ─────────────────────────────────────────────────────────────
const processedMessages = new Set();
setInterval(() => processedMessages.clear(), 60 * 60 * 1000);

// ─── Buffer de mensagens (debounce por telefone) ───────────────────────────────
// Aguarda BUFFER_DELAY ms após a ÚLTIMA mensagem antes de processar.
// Se o cliente mandar "Oi" + "quero agendar" + "um corte" em sequência,
// cada nova mensagem reinicia o timer — tudo chega junto.
const BUFFER_DELAY = 8000; // 8 segundos

const messageBuffers = new Map();

function bufferMessage(phone, text) {
  return new Promise((resolve) => {
    if (messageBuffers.has(phone)) {
      const entry = messageBuffers.get(phone);
      clearTimeout(entry.timer);
      entry.texts.push(text);
      entry.timer = setTimeout(() => {
        messageBuffers.delete(phone);
        resolve(entry.texts.join('\n'));
      }, BUFFER_DELAY);
    } else {
      const entry = { texts: [text], timer: null };
      entry.timer = setTimeout(() => {
        messageBuffers.delete(phone);
        resolve(entry.texts.join('\n'));
      }, BUFFER_DELAY);
      messageBuffers.set(phone, entry);
    }
  });
}

// ─── Fila de processamento por telefone ───────────────────────────────────────
// Garante que mensagens do mesmo número sejam processadas em sequência,
// nunca em paralelo — evita respostas duplicadas e race conditions no histórico.
const processingQueues = new Map(); // phone -> Promise

function enqueueProcess(phone, text) {
  const prev = processingQueues.get(phone) || Promise.resolve();
  let next;
  // isLatest() → true se nenhuma mensagem mais nova foi enfileirada depois desta
  const isLatest = () => processingQueues.get(phone) === next;
  next = prev
    .then(() => processMessage(phone, text, isLatest))
    .catch((err) => console.error('[Bot] Erro no processamento enfileirado:', err.message))
    .finally(() => {
      if (isLatest()) processingQueues.delete(phone);
    });
  processingQueues.set(phone, next);
}

// ─── Webhook principal ────────────────────────────────────────────────────────
router.post('/evolution', async (req, res) => {
  res.status(200).json({ status: 'ok' });
  console.log('[Webhook] Evento:', req.body?.event, '| fromMe:', req.body?.data?.key?.fromMe);

  try {
    if (db.getConfig('bot_active') !== 'true') return;

    const parsed = evolutionService.parseIncomingMessage(req.body);
    if (!parsed) {
      console.log('[Webhook] Ignorado — parseIncomingMessage retornou null');
      return;
    }

    const { phone, text, isAudio, messageData, messageId } = parsed;

    // Deduplicar
    if (processedMessages.has(messageId)) return;
    processedMessages.add(messageId);

    // Marcar como lida imediatamente (feedback visual para o cliente)
    evolutionService.markAsRead(phone, messageId).catch(() => {});

    // Verificar modo humano
    if (await db.isHumanMode(phone)) {
      console.log(`[Bot] ${phone} em modo humano — mensagem ignorada`);
      return;
    }

    // Transcrever áudio se necessário
    let finalText = text;
    if (isAudio) {
      finalText = await transcribeAudio(phone, messageData);
      if (!finalText) return; // falha silenciosa
    }

    // Buffer: aguarda mensagens quebradas antes de processar
    console.log(`[Bot] Bufferizando mensagem de ${phone}: "${finalText}"`);
    const combined = await bufferMessage(phone, finalText);
    console.log(`[Bot] Enfileirando mensagem de ${phone}: "${combined}"`);

    // Enfileira — se o bot ainda estiver respondendo à mensagem anterior,
    // esta vai aguardar na fila em vez de rodar em paralelo.
    enqueueProcess(phone, combined);
  } catch (err) {
    console.error('[Webhook] Erro:', err.message);
  }
});

// ─── Transcrição de áudio ─────────────────────────────────────────────────────
async function transcribeAudio(phone, messageData) {
  console.log(`[Bot] Transcrevendo áudio de ${phone}...`);
  try {
    const media = await evolutionService.downloadMedia(messageData);
    if (!media?.base64) throw new Error('Base64 vazio');
    const text = await whisperService.transcribe(media.base64, media.mimetype || 'audio/ogg');
    console.log(`[Bot] Transcrição: "${text}"`);
    return text;
  } catch (err) {
    console.error('[Bot] Erro ao transcrever áudio:', err.message);
    try {
      await evolutionService.sendText(phone, 'Não consegui entender o áudio. Pode digitar sua mensagem?');
    } catch {}
    return null;
  }
}

// ─── Processamento principal ──────────────────────────────────────────────────
async function processMessage(phone, text, isLatest = () => true) {
  const conv = await db.getConversation(phone);

  const MAX_HISTORY = parseInt(db.getConfig('max_history') || '20', 10);

  if (conv.history.length > MAX_HISTORY) {
    conv.history = conv.history.slice(conv.history.length - MAX_HISTORY);
  }

  conv.history.push({ role: 'user', content: text });
  await db.addLog(phone, 'in', text);

  // Contexto Trinks
  let context;
  try {
    const dateMatch = text.match(/\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?/);
    const requestedDate = dateMatch ? parseDate(dateMatch[0]) : null;
    context = await trinksService.buildContext(phone, requestedDate);
  } catch (err) {
    console.error('[Bot] Erro Trinks:', err.message);
    context = {
      isCustomer: false,
      lead: { clienteId: null, clienteNome: null, clienteWhatsApp: phone.replace('@s.whatsapp.net', ''), clienteEmail: null, agendamentos: [] },
      servicos: [], profissionais: [],
      loja: { estabelecimentoId: null, horariosOcupados: [] },
    };
  }

  if (conv.client_data) {
    context.isCustomer = true;
    context.lead.clienteNome  = conv.client_data.nome;
    context.lead.clienteWhatsApp = conv.client_data.whatsapp;
    context.lead.clienteEmail = conv.client_data.email;
    context.lead.clienteId   = conv.client_data.clienteId;
  }

  // OpenAI
  let aiResponse;
  try {
    aiResponse = await openaiService.chat(conv.history, context);
    console.log(`[Bot] ${phone} → acao: ${aiResponse?.acao} | mensagens: ${aiResponse?.mensagens?.length}`);
  } catch (err) {
    console.error('[Bot] Erro OpenAI:', err.message);
    try { await evolutionService.sendText(phone, 'Desculpe, tive um problema interno. Tente novamente em instantes.'); } catch {}
    return;
  }

  conv.history.push({ role: 'assistant', content: JSON.stringify(aiResponse) });

  const { acao, mensagens = [], novoStage, agendamento, agendamento_cancelar, cliente, encaminharHumano } = aiResponse;

  // ── Ações Trinks ──────────────────────────────────────────────────────────
  if (acao === 'criar_cliente') {
    try {
      const result = await trinksService.criarCliente({
        nome: cliente?.nome,
        email: cliente?.email,
        whatsapp: cliente?.whatsapp || phone,
        dataNascimento: cliente?.data_nascimento,
      });
      await db.saveConversation(phone, conv.history, novoStage || conv.stage, {
        clienteId: result.id,
        nome: cliente?.nome,
        whatsapp: cliente?.whatsapp || phone.replace('@s.whatsapp.net', ''),
        email: cliente?.email || null,
        dataNascimento: cliente?.data_nascimento || null,
      });
      console.log(`[Bot] Cliente criado na Trinks: id=${result.id}`);
    } catch (err) {
      console.error('[Bot] Erro ao criar cliente na Trinks:', err.message);
    }
  } else if (acao === 'gerar_agendamento' && agendamento?.length > 0) {
    const item = agendamento[0];

    // Normalizar data — aceita DD/MM/AAAA ou DD/MM (completa com ano corrente)
    // Rejeita apenas texto livre sem nenhum número de data
    let dataNormalizada = item.data || '';
    if (/^\d{1,2}\/\d{1,2}$/.test(dataNormalizada.trim())) {
      dataNormalizada = dataNormalizada.trim() + '/' + new Date().getFullYear();
    }
    // Normalizar partes para garantir dois dígitos
    const parteData = dataNormalizada.split('/');
    if (parteData.length === 3) {
      dataNormalizada = parteData[0].padStart(2,'0') + '/' + parteData[1].padStart(2,'0') + '/' + parteData[2];
    }
    item.data = dataNormalizada;

    const dataValida = /^\d{2}\/\d{2}\/\d{4}$/.test(item.data);
    if (!dataValida) {
      console.error(`[Bot] Data inválida recebida da IA: "${item.data}" — abortando agendamento`);
      await db.saveConversation(phone, conv.history, novoStage || conv.stage, conv.client_data);
      mensagens.length = 0;
      mensagens.push('Para confirmar o horário, preciso da data exata. Pode me informar o dia e mês? 📅');
    } else {
      let agendamentoOk = false;
      let erroMsg = null;

      try {
        let clienteId = context.lead.clienteId || conv.client_data?.clienteId;
        if (!clienteId) {
          const found = await trinksService.buscarClientePorTelefone(phone);
          clienteId = found?.id;
        }
        if (!clienteId) throw new Error('Cadastro não encontrado no sistema.');

        let profissionalId = item.profissionalId || null;
        if (!profissionalId && context.profissionais.length === 1) {
          profissionalId = context.profissionais[0].profissionalId;
        }

        const result = await trinksService.criarAgendamento({
          clienteId,
          servicoId: item.id,
          profissionalId,
          dataHora: buildISODate(item.data, item.horario),
          duracao: typeof item.duracao === 'number' ? item.duracao : parseInt(item.duracao, 10),
          valor: item.preco,
          observacoes: cliente?.observacao || null,
        });
        console.log(`[Bot] Agendamento criado: id=${result.id}`);
        agendamentoOk = true;
      } catch (err) {
        console.error('[Bot] Erro ao criar agendamento:', err.message);
        erroMsg = err.message;
      }

      await db.saveConversation(phone, conv.history, novoStage || conv.stage, conv.client_data);

      // Substituir mensagens da IA pelo resultado real — nunca deixar a IA confirmar algo que pode ter falhado
      mensagens.length = 0;
      if (agendamentoOk) {
        mensagens.push(`Seu horário com o Lucas está confirmado para ${item.data} às ${item.horario}. ✅`);

        // Link para outros serviços — só envia se for o primeiro agendamento da conversa
        const outroNumero = db.getConfig('whatsapp_outros_servicos');
        const jaEnviouLink = conv.history.some(m => m.role === 'assistant' && m.content?.includes('wa.me'));
        if (outroNumero && !jaEnviouLink) {
          const numeroLimpo = outroNumero.replace(/\D/g, '');
          mensagens.push(`Se quiser aproveitar e marcar outro serviço no mesmo horário com outro profissional do salão, é só entrar em contato por aqui 👇\nhttps://wa.me/${numeroLimpo}`);
        }

        mensagens.push('Se precisar de mais alguma coisa, é só avisar!');
      } else {
        mensagens.push('Tive um problema ao tentar registrar seu horário. 😔');
        mensagens.push('Pode tentar novamente ou, se preferir, fala com a gente diretamente que a gente resolve!');
      }
    }
  } else if (acao === 'cancelar_agendamento') {
    // Suporta cancelar um ou múltiplos: agendamento_cancelar pode ser objeto {id} ou array [{id},{id}]
    const ids = Array.isArray(agendamento_cancelar)
      ? agendamento_cancelar.map(a => a.id).filter(Boolean)
      : agendamento_cancelar?.id ? [agendamento_cancelar.id] : [];

    for (const id of ids) {
      try {
        await trinksService.cancelarAgendamento(id);
        console.log(`[Bot] Agendamento ${id} marcado como faltou`);
      } catch (err) {
        console.error(`[Bot] Erro ao cancelar agendamento ${id}:`, err.message);
      }
    }
    await db.saveConversation(phone, conv.history, novoStage || conv.stage, conv.client_data);
  } else if (acao !== 'criar_cliente') {
    await db.saveConversation(phone, conv.history, novoStage || conv.stage, conv.client_data);
  }

  // ── Modo humano ───────────────────────────────────────────────────────────
  if (encaminharHumano) {
    await db.setHumanMode(phone, true);
    await db.addLog(phone, 'system', 'MODO_HUMANO_ATIVADO');
    console.log(`[Bot] Modo humano ativado para ${phone}`);
  }

  // ── Enviar respostas ──────────────────────────────────────────────────────
  // Se chegou outra mensagem mais nova enquanto o bot processava esta,
  // descarta o envio (já há uma resposta mais atualizada vindo na fila).
  if (!isLatest()) {
    console.log(`[Bot] Resposta descartada para ${phone} — há mensagem mais recente na fila`);
    return;
  }

  // Fallback: OpenAI não gerou nenhuma mensagem (não deveria acontecer)
  if (mensagens.length === 0) {
    console.warn(`[Bot] OpenAI retornou mensagens vazias para ${phone} — ignorando`);
    return;
  }

  try {
    await evolutionService.sendMessages(phone, mensagens);
    for (const msg of mensagens) await db.addLog(phone, 'out', msg);
  } catch (err) {
    console.error('[Bot] Erro ao enviar mensagens:', err.message);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseDate(str) {
  const parts = str.split(/[\/\-]/);
  if (parts.length < 2) return null;
  const day   = parts[0].padStart(2, '0');
  const month = parts[1].padStart(2, '0');
  const year  = parts[2] ? (parts[2].length === 2 ? `20${parts[2]}` : parts[2]) : new Date().getFullYear().toString();
  return `${year}-${month}-${day}`;
}

function buildISODate(dataStr, horario) {
  let iso = dataStr.toLowerCase();
  const dateObj = new Date();

  if (iso === 'hoje') {
    iso = dateObj.toISOString().split('T')[0];
  } else if (iso === 'amanhã' || iso === 'amanha') {
    dateObj.setDate(dateObj.getDate() + 1);
    iso = dateObj.toISOString().split('T')[0];
  } else if (dataStr.includes('/')) {
    const parts = dataStr.split('/');
    const day   = parts[0].padStart(2, '0');
    const month = parts[1].padStart(2, '0');
    const year  = parts[2] ? (parts[2].length === 2 ? `20${parts[2]}` : parts[2]) : dateObj.getFullYear().toString();
    iso = `${year}-${month}-${day}`;
  }
  return `${iso}T${horario}:00`;
}

module.exports = router;

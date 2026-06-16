const express = require('express');
const router = express.Router();
const db = require('../db/database');
const openaiService = require('../services/openai');
const trinksService = require('../services/trinks');
const evolutionService = require('../services/evolution');
const whisperService = require('../services/whisper');
const confirmacaoService = require('../services/confirmacao');

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

    const { phone, text, isAudio, isUnsupportedMedia, messageData, messageId } = parsed;

    // MODO TESTE: quando ativo, IA só responde ao número configurado
    // Útil pra testar mudanças sem afetar clientes em produção
    if (db.getConfig('test_mode_active') === 'true') {
      const testPhone = (db.getConfig('test_mode_phone') || '').replace(/\D/g, '');
      const currentPhone = phone.replace('@s.whatsapp.net', '').replace(/\D/g, '');

      // Pega os últimos 8 dígitos (núcleo do número, ignora DDI, DDD e o "9" extra do celular)
      const tail8 = s => s.slice(-8);
      const match = testPhone && tail8(testPhone) === tail8(currentPhone);

      if (!match) {
        console.log(`[Bot] MODO TESTE ativo — ignorando ${currentPhone} (só responde a ${testPhone})`);
        return;
      }
      console.log(`[Bot] MODO TESTE — processando mensagem de teste de ${currentPhone}`);
    }

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

    // Áudio: transcrever e seguir como texto
    let finalTextOverride = null;
    if (isAudio) {
      const transcricao = await transcribeAudio(phone, messageData);
      if (!transcricao) return; // já avisou a cliente no helper
      console.log(`[Bot] Áudio transcrito (${phone}): "${transcricao}"`);
      finalTextOverride = transcricao;
    }

    // Recusar imagens, stickers, documentos e vídeos
    if (isUnsupportedMedia) {
      await evolutionService.sendText(phone, 'Por aqui realizamos atendimento apenas por mensagens escritas. Não conseguimos receber imagens, vídeos ou documentos. Poderia digitar o que precisa? 😊');
      return;
    }

    // Sem texto útil
    let finalText = finalTextOverride || text;
    if (!finalText) return;

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
  console.log(`[Bot] messageData keys:`, messageData ? Object.keys(messageData).join(',') : 'null');
  try {
    const media = await evolutionService.downloadMedia(messageData);
    console.log(`[Bot] Media baixada — base64 length: ${media?.base64?.length || 0}, mimetype: ${media?.mimetype}`);
    if (!media?.base64) throw new Error('Base64 vazio retornado pelo Evolution');
    const text = await whisperService.transcribe(media.base64, media.mimetype || 'audio/ogg');
    console.log(`[Bot] Transcrição OK: "${text}"`);
    return text;
  } catch (err) {
    console.error('[Bot] Erro ao transcrever áudio:', err.message);
    console.error('[Bot] Stack:', err.stack);
    if (err.response?.data) console.error('[Bot] Response:', JSON.stringify(err.response.data).slice(0, 500));
    try {
      await evolutionService.sendText(phone, 'Não consegui entender o áudio. Pode digitar sua mensagem?');
    } catch {}
    return null;
  }
}

// ─── Processamento principal ──────────────────────────────────────────────────
async function processMessage(phone, text, isLatest = () => true) {
  // Verificar se é resposta a uma mensagem de confirmação de agendamento
  const foiConfirmacao = await confirmacaoService.processarResposta(phone, text);
  if (foiConfirmacao) return; // resposta tratada — não passa para o fluxo normal do bot

  const conv = await db.getConversation(phone);

  const MAX_HISTORY = parseInt(db.getConfig('max_history') || '20', 10);

  if (conv.history.length > MAX_HISTORY) {
    conv.history = conv.history.slice(conv.history.length - MAX_HISTORY);
  }

  conv.history.push({ role: 'user', content: text, ts: Date.now() });
  await db.addLog(phone, 'in', text);

  // Salva a mensagem do cliente ANTES de chamar a OpenAI —
  // se falhar (ex: 429), o histórico já tem a mensagem registrada
  // e o botão de Retry no dashboard consegue detectar e reprocessar.
  await db.saveConversation(phone, conv.history, conv.stage, conv.client_data);

  // Contexto Trinks
  let context;
  try {
    // Tenta extrair data do texto (DD/MM ou DD/MM/AAAA)
    let requestedDate = null;
    const dateMatch = text.match(/\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?/);
    if (dateMatch) {
      requestedDate = parseDate(dateMatch[0]);
    } else {
      // Tenta detectar "25 de julho", "5 agosto", etc.
      requestedDate = parseDiaMes(text);
    }
    if (!requestedDate) {
      // Tenta detectar dia da semana no texto e converter para data
      requestedDate = parseDiaSemana(text);
    }
    context = await trinksService.buildContext(phone, requestedDate);
  } catch (err) {
    console.error('[Bot] Erro Trinks:', err.message);
    context = {
      isCustomer: false,
      lead: { clienteId: null, clienteNome: null, clienteWhatsApp: phone.replace('@s.whatsapp.net', ''), clienteEmail: null, agendamentos: [] },
      servicos: [], profissionais: [],
      loja: { estabelecimentoId: null, disponibilidade: {} },
    };
  }

  // Nova sessão = histórico existe mas última interação foi há mais de 4 horas
  const NEW_SESSION_THRESHOLD_MS = 4 * 60 * 60 * 1000;
  const lastInteraction = conv.updated_at ? new Date(conv.updated_at) : null;
  const hasHistory = conv.history.some(m => m.role === 'assistant');
  context.isNewSession = hasHistory && lastInteraction
    ? (Date.now() - lastInteraction.getTime()) > NEW_SESSION_THRESHOLD_MS
    : false;

  if (conv.client_data) {
    context.isCustomer = true;
    context.lead.clienteNome     = conv.client_data.nome;
    context.lead.clienteWhatsApp = conv.client_data.whatsapp;
    context.lead.clienteEmail    = conv.client_data.email;
    context.lead.clienteId       = conv.client_data.clienteId;
  } else if (context.isCustomer && context.lead.clienteId) {
    // Cliente foi encontrado no Trinks neste turno → salvar imediatamente em conv.client_data
    // pra próximos turnos não precisarem buscar de novo (e não esquecerem mesmo se Trinks der 429)
    conv.client_data = {
      clienteId: context.lead.clienteId,
      nome: context.lead.clienteNome,
      cpf: null,
      whatsapp: context.lead.clienteWhatsApp,
      email: context.lead.clienteEmail,
      dataNascimento: context.lead.dataNascimento || null,
    };
    await db.saveConversation(phone, conv.history, conv.stage, conv.client_data);
    console.log(`[Bot] Cliente Trinks (${context.lead.clienteNome}) salvo em conv.client_data para próximos turnos`);
  }

  // OpenAI
  let aiResponse;
  try {
    aiResponse = await openaiService.chat(conv.history, context);
    console.log(`[Bot] ${phone} → acao: ${aiResponse?.acao} | mensagens: ${aiResponse?.mensagens?.length}`);

    // ── VALIDAÇÃO DE HORÁRIOS — barra hallucination ────────────────────────
    // Coleta TODOS os slots válidos do contexto (todas datas, todos serviços)
    const slotsValidosGlobal = new Set();
    const dispMap = context.loja?.disponibilidade || {};
    for (const profSlots of Object.values(dispMap)) {
      for (const prof of profSlots) {
        for (const slots of Object.values(prof.horariosValidosPorServico || {})) {
          slots.forEach(h => slotsValidosGlobal.add(h));
        }
      }
    }

    // Procura horários nas mensagens da IA e verifica se cada um é válido
    const REGEX_HORA = /\b(\d{1,2}):(\d{2})\b/g;
    let temHorarioInvalido = false;
    const horariosInvalidos = [];
    for (const msg of (aiResponse.mensagens || [])) {
      const matches = String(msg).matchAll(REGEX_HORA);
      for (const m of matches) {
        const hh = m[1].padStart(2, '0');
        const mm = m[2];
        const horario = `${hh}:${mm}`;
        // Ignorar horários que parecem ser referência a um agendamento existente
        // (ex: "seu agendamento das 14:00 foi cancelado") — só validar se estiver oferecendo
        if (!slotsValidosGlobal.has(horario) && /(\d{1,2}:\d{2}).{0,40}(disponível|temos|prefere|pode|posso agendar|posso marcar|às)/i.test(msg)) {
          // Verifica também se não é um horário do agendamento do próprio cliente
          const éAgendamentoExistente = (context.lead?.agendamentos || []).some(ag => ag.horario === horario);
          if (!éAgendamentoExistente) {
            temHorarioInvalido = true;
            horariosInvalidos.push(horario);
          }
        }
      }
    }

    // ── VALIDAÇÃO DE PREÇOS ──────────────────────────────────────────────────
    // Extrai valores mencionados pela IA e compara com o catálogo de serviços
    const precosValidos = new Set();
    const precosMinPorServico = {}; // serviceName.toLowerCase() → menor preço
    for (const srv of (context.servicos || [])) {
      if (typeof srv.servicePrice === 'number' && srv.servicePrice > 0) {
        precosValidos.add(srv.servicePrice);
        const key = (srv.serviceName || '').toLowerCase();
        if (!precosMinPorServico[key] || srv.servicePrice < precosMinPorServico[key]) {
          precosMinPorServico[key] = srv.servicePrice;
        }
      }
    }

    // Regex para "R$ 123,45" ou "R$ 123" ou "R$ 123.45"
    const REGEX_PRECO = /R\$\s*(\d{1,4}(?:[.,]\d{2})?)/gi;
    let temPrecoInvalido = false;
    const precosInvalidos = [];

    for (const msg of (aiResponse.mensagens || [])) {
      const matches = String(msg).matchAll(REGEX_PRECO);
      for (const m of matches) {
        const valorStr = m[1].replace(',', '.');
        const valor = parseFloat(valorStr);
        if (isNaN(valor)) continue;
        // Tolerância: aceita preço se bate com algum do catálogo (ignora centavos)
        const valorInt = Math.floor(valor);
        const algumBate = [...precosValidos].some(p => Math.floor(p) === valorInt);
        if (!algumBate) {
          temPrecoInvalido = true;
          precosInvalidos.push(`R$ ${m[1]}`);
        }
      }
    }

    if (temPrecoInvalido) {
      console.warn(`[Bot] PREÇOS INVÁLIDOS detectados: ${precosInvalidos.join(', ')}. Forçando retry.`);
      const precosCatalogo = [...precosValidos].sort((a,b) => a-b).map(p => `R$ ${p.toFixed(2).replace('.',',')}`).join(', ');
      const nota = `SISTEMA: Sua última resposta mencionou os preços ${precosInvalidos.join(', ')} que NÃO ESTÃO no catálogo de serviços. Os preços VÁLIDOS são: ${precosCatalogo}. Reveja servicos[].servicePrice e use APENAS valores que estão lá. Quando um serviço tiver mais de um valor (servicos com mesmo nome mas valores diferentes), use SEMPRE a expressão "a partir de R$ X" com o menor valor.`;
      conv.history.push({ role: 'user', content: nota, ts: Date.now() });
      try {
        const respCorrigida = await openaiService.chat(conv.history, context);
        conv.history.push({ role: 'assistant', content: JSON.stringify(respCorrigida), ts: Date.now() });
        aiResponse = respCorrigida;
        console.log(`[Bot] Resposta corrigida após preços inválidos`);
      } catch (err) {
        console.error(`[Bot] Falha ao corrigir preços inválidos:`, err.message);
      }
    }

    // ── VALIDAÇÃO ANTI-CADASTRO DUPLICADO ─────────────────────────────────
    // Se o cliente JÁ está cadastrado (isCustomer=true) e a IA pediu dados de
    // cadastro mesmo assim, bloqueia e força regenerar.
    const textoCompletoCadastro = (aiResponse.mensagens || []).join(' ');
    const pediuCadastro = /(nome\s+completo|cpf|data\s+de\s+nascimento|me\s+(?:passa|envia|fala)\s+seu\s+(?:nome|cpf|email|e-mail))/i.test(textoCompletoCadastro);

    if (context.isCustomer && pediuCadastro) {
      console.warn(`[Bot] CADASTRO PEDIDO INDEVIDAMENTE — cliente já está cadastrado (${context.lead.clienteNome}). Forçando retry.`);
      const dadosCliente = {
        nome: context.lead.clienteNome,
        whatsapp: context.lead.clienteWhatsApp,
        email: context.lead.clienteEmail,
        dataNascimento: context.lead.dataNascimento,
      };
      const nota = `SISTEMA: A cliente JÁ ESTÁ CADASTRADA (isCustomer === true). Você NÃO deve pedir nenhum dado de cadastro.

Dados que já temos:
- Nome: ${dadosCliente.nome}
- WhatsApp: ${dadosCliente.whatsapp}
- E-mail: ${dadosCliente.email || '(não informado)'}
- Nascimento: ${dadosCliente.dataNascimento || '(não informado)'}

INSTRUÇÕES OBRIGATÓRIAS:
1. NÃO peça nome, CPF, e-mail, data de nascimento nem confirmação de WhatsApp.
2. Use os dados acima diretamente.
3. Se a cliente já escolheu o horário, dispare gerar_agendamento na próxima resposta com os dados já existentes.
4. Se ainda falta escolher serviço/data/horário, conduza o atendimento normalmente sem pedir cadastro.`;

      conv.history.push({ role: 'user', content: nota, ts: Date.now() });
      try {
        const respCorrigida = await openaiService.chat(conv.history, context);
        conv.history.push({ role: 'assistant', content: JSON.stringify(respCorrigida), ts: Date.now() });
        aiResponse = respCorrigida;
        console.log(`[Bot] Resposta corrigida após pedido indevido de cadastro: acao=${aiResponse?.acao}`);
      } catch (err) {
        console.error(`[Bot] Falha ao corrigir cadastro indevido:`, err.message);
      }
    }

    // ── VALIDAÇÃO REVERSA — IA diz "sem vagas" quando na verdade TEM ───────
    // Pega texto bruto da resposta
    const textoCompleto = (aiResponse.mensagens || []).join(' ').toLowerCase();
    const dizSemVagas = /preench(ido|ida)|sem hor[áa]rio|n[ãa]o (?:temos?|h[áa]) (?:hor[áa]rio|vagas?|disponibilidade)|indispon[íi]vel|n[ãa]o (?:temos?|h[áa]) vagas?/i.test(textoCompleto);

    if (dizSemVagas && slotsValidosGlobal.size > 0 && !temHorarioInvalido) {
      console.warn(`[Bot] IA disse "sem vagas" mas existem ${slotsValidosGlobal.size} slots no contexto. Forçando retry.`);

      // Resumo dos slots realmente disponíveis (todas as datas, por serviço)
      const resumoSlots = [];
      for (const [data, profSlots] of Object.entries(dispMap)) {
        for (const prof of profSlots) {
          for (const [servId, slots] of Object.entries(prof.horariosValidosPorServico || {})) {
            if (slots.length === 0) continue;
            const srv = (context.servicos || []).find(s => String(s.serviceId) === String(servId));
            const nomeServ = srv?.serviceName || `servico ${servId}`;
            resumoSlots.push(`${data} ${prof.profissionalNome} ${nomeServ}: ${slots.join(', ')}`);
          }
        }
      }

      const nota = `SISTEMA: Sua última resposta afirmou que não há horários disponíveis. ISSO É FALSO.

Horários REAIS disponíveis no contexto AGORA:
${resumoSlots.join('\n')}

INSTRUÇÕES OBRIGATÓRIAS:
1. Identifique a data que a cliente pediu (hoje, amanhã, quinta etc).
2. Procure essa data na lista acima e ofereça os horários listados para o serviço escolhido (ou para "Corte" se ainda não foi definido).
3. Se a data específica pedida não tem horários, mas OUTRAS datas têm → diga isso e ofereça as datas alternativas com slots disponíveis.
4. JAMAIS diga "preenchida" quando há slots listados acima para alguma data.`;

      conv.history.push({ role: 'user', content: nota, ts: Date.now() });
      try {
        const respCorrigida = await openaiService.chat(conv.history, context);
        conv.history.push({ role: 'assistant', content: JSON.stringify(respCorrigida), ts: Date.now() });
        aiResponse = respCorrigida;
        console.log(`[Bot] Resposta corrigida após "sem vagas" falso: acao=${aiResponse?.acao}`);
      } catch (err) {
        console.error(`[Bot] Falha ao corrigir "sem vagas" falso:`, err.message);
      }
    }

    if (temHorarioInvalido) {
      console.warn(`[Bot] HORÁRIOS INVÁLIDOS detectados na resposta: ${horariosInvalidos.join(', ')}. Forçando retry.`);

      // Resumo dos slots realmente disponíveis (todas as datas, por serviço)
      const resumoSlots = [];
      for (const [data, profSlots] of Object.entries(dispMap)) {
        for (const prof of profSlots) {
          for (const [servId, slots] of Object.entries(prof.horariosValidosPorServico || {})) {
            if (slots.length === 0) continue;
            const srv = (context.servicos || []).find(s => String(s.serviceId) === String(servId));
            const nomeServ = srv?.serviceName || `servico ${servId}`;
            resumoSlots.push(`${data} ${prof.profissionalNome} ${nomeServ}: ${slots.join(', ')}`);
          }
        }
      }
      const resumo = resumoSlots.length > 0
        ? `Horários REAIS disponíveis no contexto:\n${resumoSlots.join('\n')}`
        : 'Nenhum horário disponível em nenhuma data consultada — pode dizer que está preenchido.';

      const nota = `SISTEMA: Sua última resposta ofereceu os horários ${horariosInvalidos.join(', ')} que NÃO ESTÃO em horariosValidosPorServico. Isso foi alucinação.

${resumo}

INSTRUÇÕES OBRIGATÓRIAS para a próxima resposta:
1. Se HÁ horários reais disponíveis acima → OFEREÇA EXATAMENTE esses horários para a cliente. Não diga "preenchida" se existem horários listados.
2. Se NÃO HÁ nenhum horário → diga que a agenda está preenchida nesse dia (nunca "fechada") e ofereça outra data.
3. NUNCA invente horários fora da lista acima.`;
      conv.history.push({ role: 'user', content: nota, ts: Date.now() });
      try {
        const respCorrigida = await openaiService.chat(conv.history, context);
        conv.history.push({ role: 'assistant', content: JSON.stringify(respCorrigida), ts: Date.now() });
        aiResponse = respCorrigida;
        console.log(`[Bot] Resposta corrigida após hallucination: acao=${aiResponse?.acao}`);
      } catch (err) {
        console.error(`[Bot] Falha ao corrigir hallucination:`, err.message);
        // Como fallback, troca por mensagem segura
        aiResponse.mensagens = ['Deixa eu verificar a agenda direitinho e te respondo em alguns minutos. 😊'];
        aiResponse.acao = 'nenhuma';
      }
    }
  } catch (err) {
    console.error('[Bot] Erro OpenAI:', err.message);
    // Limite diário de tokens atingido — não responde, apenas loga
    // (evita ficar mandando "estamos fora do ar" pra todos os clientes do dia)
    if (err.limiteAtingido) {
      console.warn(`[Bot] Mensagem de ${phone} não processada — limite diário atingido`);
      return;
    }
    try { await evolutionService.sendText(phone, 'Desculpe, tive um problema interno. Tente novamente em instantes.'); } catch {}
    return;
  }

  conv.history.push({ role: 'assistant', content: JSON.stringify(aiResponse), ts: Date.now() });

  const { acao, mensagens = [], novoStage, agendamento, agendamento_cancelar, cliente, encaminharHumano } = aiResponse;
  console.log(`[Bot] acao=${acao} | agendamento_cancelar=${JSON.stringify(agendamento_cancelar)} | agendamento=${JSON.stringify(agendamento)?.slice(0,200)}`);

  // ── Ações Trinks ──────────────────────────────────────────────────────────
  if (acao === 'criar_cliente') {
    // RETRY: até 3 tentativas para criar o cliente em caso de erro de API
    let result = null;
    let lastErr = null;
    const MAX_RETRY_CLIENTE = 3;
    for (let tentativa = 1; tentativa <= MAX_RETRY_CLIENTE; tentativa++) {
      try {
        result = await trinksService.criarCliente({
          nome: cliente?.nome,
          cpf: cliente?.cpf,
          email: cliente?.email,
          whatsapp: cliente?.whatsapp || phone,
          dataNascimento: cliente?.data_nascimento,
        });
        if (result?.id) {
          console.log(`[Bot] Cliente criado na tentativa ${tentativa}: id=${result.id}`);
          break;
        }
        console.warn(`[Bot] Tentativa ${tentativa}/${MAX_RETRY_CLIENTE} de criar cliente: sem ID retornado`);
      } catch (err) {
        lastErr = err;
        console.warn(`[Bot] Tentativa ${tentativa}/${MAX_RETRY_CLIENTE} de criar cliente falhou: ${err.message}`);
        if (tentativa < MAX_RETRY_CLIENTE) {
          await new Promise(r => setTimeout(r, 2000 * tentativa));
        }
      }
    }

    if (result?.id) {
      await db.saveConversation(phone, conv.history, novoStage || conv.stage, {
        clienteId: result.id,
        nome: cliente?.nome,
        cpf: cliente?.cpf || null,
        whatsapp: cliente?.whatsapp || phone.replace('@s.whatsapp.net', ''),
        email: cliente?.email || null,
        dataNascimento: cliente?.data_nascimento || null,
      });
    } else {
      // Cliente não foi criado — substituir mensagens da IA por aviso honesto
      console.error(`[Bot] Cliente NÃO criado após ${MAX_RETRY_CLIENTE} tentativas:`, lastErr?.message);
      mensagens.length = 0;
      mensagens.push('Tive um problema no cadastro agora. 😔');
      mensagens.push('Vou pedir para o salão concluir esse passo manualmente — em instantes alguém entra em contato. Pode aguardar?');
      await db.saveConversation(phone, conv.history, novoStage || conv.stage, conv.client_data);
    }
  } else if (acao === 'gerar_agendamento' && agendamento?.length > 0) {
    // ── Normalizar datas de todos os itens ───────────────────────────────────
    for (const item of agendamento) {
      let dataNormalizada = item.data || '';
      if (/^\d{1,2}\/\d{1,2}$/.test(dataNormalizada.trim())) {
        dataNormalizada = dataNormalizada.trim() + '/' + new Date().getFullYear();
      }
      const parteData = dataNormalizada.split('/');
      if (parteData.length === 3) {
        dataNormalizada = parteData[0].padStart(2,'0') + '/' + parteData[1].padStart(2,'0') + '/' + parteData[2];
      }
      item.data = dataNormalizada;
    }

    const dataInvalida = agendamento.find(item => !/^\d{2}\/\d{2}\/\d{4}$/.test(item.data));
    if (dataInvalida) {
      console.error(`[Bot] Data inválida: "${dataInvalida.data}" — abortando agendamento`);
      await db.saveConversation(phone, conv.history, novoStage || conv.stage, conv.client_data);
      mensagens.length = 0;
      mensagens.push('Para confirmar o horário, preciso da data exata. Pode me informar o dia e mês? 📅');
    } else {
      // ── Resolver clienteId ────────────────────────────────────────────────
      let clienteId = context.lead.clienteId || conv.client_data?.clienteId;
      if (!clienteId) {
        const found = await trinksService.buscarClientePorTelefone(phone);
        clienteId = found?.id;
      }

      // ── Criar todos os agendamentos em sequência ──────────────────────────
      const resultados = [];
      for (const item of agendamento) {
        if (!clienteId) {
          resultados.push({ item, ok: false, erro: 'Cadastro não encontrado.' });
          continue;
        }
        let profissionalId = item.profissionalId || null;
        if (!profissionalId && context.profissionais.length === 1) {
          profissionalId = context.profissionais[0].profissionalId;
        }
        const dataHoraISO = buildISODate(item.data, item.horario);
        const duracaoNum = typeof item.duracao === 'number' ? item.duracao : parseInt(item.duracao, 10);

        // VERIFICAÇÃO DETERMINÍSTICA antes de marcar — checa em tempo real no Trinks
        // se o slot ainda está livre. Se não estiver, aborta sem passar pela IA.
        const checagem = await trinksService.verificarSlotLivre({
          profissionalId,
          dataHora: dataHoraISO,
          duracao: duracaoNum,
        });

        if (!checagem.livre) {
          console.warn(`[Bot] Slot ocupado detectado antes de marcar: ${item.data} ${item.horario} — ${checagem.motivo}`);
          resultados.push({ item, ok: false, isConflito: true, erro: checagem.motivo });
          continue;
        }

        // CRIAR AGENDAMENTO COM RETRY (até 3 tentativas em caso de erro de API)
        let result = null;
        let lastErr = null;
        const MAX_RETRY_AGENDAMENTO = 3;
        for (let tentativa = 1; tentativa <= MAX_RETRY_AGENDAMENTO; tentativa++) {
          try {
            result = await trinksService.criarAgendamento({
              clienteId,
              servicoId: item.id,
              profissionalId,
              dataHora: dataHoraISO,
              duracao: duracaoNum,
              valor: item.preco,
              observacoes: cliente?.observacao || null,
            });
            if (result?.id) {
              console.log(`[Bot] Agendamento criado na tentativa ${tentativa}: id=${result.id}`);
              break;
            }
            console.warn(`[Bot] Tentativa ${tentativa}/${MAX_RETRY_AGENDAMENTO}: Trinks não retornou ID`);
          } catch (err) {
            lastErr = err;
            if (err.isConflito) {
              // Conflito é determinístico — não adianta tentar de novo
              throw err;
            }
            console.warn(`[Bot] Tentativa ${tentativa}/${MAX_RETRY_AGENDAMENTO} falhou: ${err.message}`);
            if (tentativa < MAX_RETRY_AGENDAMENTO) {
              await new Promise(r => setTimeout(r, 2000 * tentativa)); // 2s, 4s, 6s
            }
          }
        }

        try {
          if (!result?.id) {
            console.error(`[Bot] Agendamento FALHOU após ${MAX_RETRY_AGENDAMENTO} tentativas: ${item.servico} ${item.data} ${item.horario}`);
            resultados.push({ item, ok: false, erro: lastErr?.message || 'sem ID após retries' });
            continue;
          }

          // Confirma que o slot agora está ocupado (proof of life do agendamento)
          const reCheck = await trinksService.verificarSlotLivre({
            profissionalId,
            dataHora: dataHoraISO,
            duracao: duracaoNum,
          });
          if (reCheck.livre) {
            console.warn(`[Bot] Agendamento id=${result.id} retornou ID mas o slot ${item.horario} ainda está livre no Trinks — possível falha silenciosa`);
            // Não considera sucesso — registra falha para a cliente saber
            resultados.push({ item, ok: false, erro: 'criação não confirmada pelo Trinks', isFalhaSilenciosa: true });
            continue;
          }

          console.log(`[Bot] Agendamento criado e verificado: id=${result.id} | ${item.servico} ${item.data} ${item.horario}`);
          resultados.push({ item, ok: true, agendamentoId: result.id });
        } catch (err) {
          console.error(`[Bot] Erro ao criar agendamento (${item.servico}):`, err.message);
          resultados.push({ item, ok: false, erro: err.message, isConflito: err.isConflito });
        }
      }

      await db.saveConversation(phone, conv.history, novoStage || conv.stage, conv.client_data);

      const sucessos = resultados.filter(r => r.ok);
      const falhas   = resultados.filter(r => !r.ok);

      mensagens.length = 0;
      if (sucessos.length > 0) {
        if (sucessos.length === 1) {
          const { item } = sucessos[0];
          mensagens.push(`Seu horário com o Lucas está confirmado para ${item.data} às ${item.horario}. ✅`);
        } else {
          mensagens.push('Seus horários com o Lucas estão confirmados! ✅');
          for (const { item } of sucessos) {
            mensagens.push(`${item.servico}: ${item.data} às ${item.horario}`);
          }
        }

        // Link para outros serviços — só envia uma vez por conversa
        const outroNumero = db.getConfig('whatsapp_outros_servicos');
        const jaEnviouLink = conv.history.some(m => m.role === 'assistant' && m.content?.includes('wa.me'));
        if (outroNumero && !jaEnviouLink) {
          const numeroLimpo = outroNumero.replace(/\D/g, '');
          mensagens.push(`Se quiser marcar outro serviço com um profissional diferente do salão, é só falar por aqui 👇\nhttps://wa.me/${numeroLimpo}`);
        }

        if (falhas.length > 0) {
          mensagens.push('Porém, tive um problema com um dos serviços. Entre em contato com o salão para resolver. 😔');
        } else {
          mensagens.push('Se precisar de mais alguma coisa, é só avisar!');
        }
      } else {
        // Verifica se alguma falha foi por conflito de horário
        const conflito = falhas.find(r => r.isConflito);
        if (conflito) {
          // Em vez de mensagem fixa, injeta no histórico e pede para a IA gerar
          // a resposta contextual (mais natural dentro da conversa)
          const nota = `SISTEMA: O horário ${conflito.item.horario} do dia ${conflito.item.data} para o serviço "${conflito.item.servico}" foi reservado por outra cliente no exato momento em que tentamos registrar. O agendamento NÃO foi criado. Avise a cliente de forma natural e empática, explicando que por se tratar de um atendimento automático, pode acontecer de outra cliente estar conversando ao mesmo tempo e acabar reservando o horário antes. Peça desculpa pelo inconveniente, peça que ela escolha outro horário, e mostre os horários disponíveis atualizados (consulte loja.disponibilidade novamente — está atualizada).`;
          conv.history.push({ role: 'user', content: nota, ts: Date.now() });

          // Reconsulta contexto (sem cache — vai trazer o slot atualizado)
          const novoContext = await trinksService.buildContext(phone, conflito.item.data.split('/').reverse().join('-'));
          if (conv.client_data) {
            novoContext.isCustomer = true;
            novoContext.lead.clienteNome = conv.client_data.nome;
            novoContext.lead.clienteWhatsApp = conv.client_data.whatsapp;
            novoContext.lead.clienteEmail = conv.client_data.email;
            novoContext.lead.clienteId = conv.client_data.clienteId;
          }

          try {
            const respConflito = await openaiService.chat(conv.history, novoContext);
            conv.history.push({ role: 'assistant', content: JSON.stringify(respConflito), ts: Date.now() });
            mensagens.length = 0;
            (respConflito.mensagens || []).forEach(m => mensagens.push(m));
          } catch (err) {
            console.error('[Bot] Erro ao gerar mensagem de conflito via IA:', err.message);
            mensagens.push(`Ops, o horário das ${conflito.item.horario} acabou de ser reservado por outra pessoa. 😕 Pode me dizer outro horário?`);
          }
        } else {
          // Falha silenciosa ou erro genérico — sempre avisar que o agendamento NÃO foi confirmado
          mensagens.push('Não consegui confirmar o seu agendamento agora. 😔');
          mensagens.push('Vou pedir para o salão entrar em contato direto com você para garantir o horário, tudo bem?');
        }
      }
    }
  } else if (acao === 'cancelar_agendamento') {
    const ids = Array.isArray(agendamento_cancelar)
      ? agendamento_cancelar.map(a => a.id).filter(Boolean)
      : agendamento_cancelar?.id ? [agendamento_cancelar.id] : [];

    let cancelouTodos = true;
    for (const id of ids) {
      try {
        await trinksService.cancelarAgendamento(id);
        console.log(`[Bot] Agendamento ${id} cancelado`);
      } catch (err) {
        console.error(`[Bot] Erro ao cancelar agendamento ${id}:`, err.message);
        cancelouTodos = false;
      }
    }

    await db.saveConversation(phone, conv.history, novoStage || conv.stage, conv.client_data);

    if (!cancelouTodos) {
      mensagens.length = 0;
      mensagens.push('Tive um problema ao tentar cancelar seu horário. 😔');
      mensagens.push('Por favor, entre em contato diretamente com o salão para garantir o cancelamento!');
    }
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

  // FILTRO ANTI-ESPERA — remove mensagens de espera que a IA insiste em mandar
  // mesmo com a regra explícita no prompt. Bloqueio em código (último recurso).
  const padroesEspera = [
    /um\s+momento/i,
    /aguarde/i,
    /vou\s+verificar/i,
    /vou\s+confirmar/i,
    /vou\s+buscar/i,
    /vou\s+(?:ver|checar|consultar)/i,
    /j[áa]\s+te\s+(?:informo|aviso|retorno)/i,
    /deixa?\s+eu\s+ver/i,
    /agora\s*,?\s*vamos\s+verificar/i,
    /s[óo]\s+um\s+(?:momento|minuto|segundo|instante)/i,
  ];
  let mensagensFiltradas = mensagens.filter(m => {
    const texto = String(m).trim();
    const ehEspera = padroesEspera.some(rx => rx.test(texto));
    if (ehEspera) console.warn(`[Bot] Mensagem de espera bloqueada: "${texto}"`);
    return !ehEspera;
  });

  // Se TODAS as mensagens foram bloqueadas, força a IA a responder de verdade
  // Injeta uma nota corretiva e chama a OpenAI novamente até ela gerar algo útil
  let tentativas = 0;
  const MAX_TENTATIVAS_ANTI_ESPERA = 1;

  while (mensagensFiltradas.length === 0 && tentativas < MAX_TENTATIVAS_ANTI_ESPERA) {
    tentativas++;
    console.warn(`[Bot] Todas as mensagens eram de espera (tentativa ${tentativas}). Forçando nova resposta...`);

    const notaCorretiva = `SISTEMA: Sua última resposta continha apenas mensagens de espera ("um momento", "vou verificar", etc.) que são PROIBIDAS. Você já tem todos os dados de loja.disponibilidade e horariosValidosPorServico no contexto AGORA. Responda IMEDIATAMENTE com a informação real que a cliente pediu, sem usar nenhuma frase de espera. Apresente os horários disponíveis (apenas horas cheias :00) direto na mensagem.`;

    conv.history.push({ role: 'user', content: notaCorretiva, ts: Date.now() });

    try {
      const novaResposta = await openaiService.chat(conv.history, context);
      conv.history.push({ role: 'assistant', content: JSON.stringify(novaResposta), ts: Date.now() });
      await db.saveConversation(phone, conv.history, novoStage || conv.stage, conv.client_data);

      const novasMsgs = novaResposta.mensagens || [];
      mensagensFiltradas = novasMsgs.filter(m => {
        const texto = String(m).trim();
        const ehEspera = padroesEspera.some(rx => rx.test(texto));
        if (ehEspera) console.warn(`[Bot] (Retry ${tentativas}) Mensagem de espera bloqueada: "${texto}"`);
        return !ehEspera;
      });
    } catch (err) {
      console.error(`[Bot] Erro no retry anti-espera:`, err.message);
      break;
    }
  }

  // Se mesmo após retries não saiu nada, manda uma resposta fallback genérica
  if (mensagensFiltradas.length === 0) {
    console.warn(`[Bot] Após ${tentativas} tentativas, ainda só temos mensagens de espera — enviando fallback`);
    mensagensFiltradas = [
      'Me dá um instante para olhar isso direitinho e já volto com a informação para você.',
    ];
  }

  // ─── Detectar serviços com múltiplos valores (precisam de "a partir de") ────
  const servicosComMultiValor = new Set();
  const contadorPorNome = {};
  for (const srv of (context?.servicos || [])) {
    const nome = (srv.serviceName || '').toLowerCase().trim();
    if (!nome) continue;
    contadorPorNome[nome] = (contadorPorNome[nome] || 0) + 1;
    if (contadorPorNome[nome] > 1) servicosComMultiValor.add(nome);
  }

  // Prefixar TODA mensagem com "*_Atendente Laís disse:_*" (negrito + itálico no WhatsApp)
  // Remove qualquer duplicação caso a IA tenha tentado adicionar a assinatura
  // Também substitui "agenda fechada" por "agenda preenchida" (vocabulário do salão)
  const mensagensComAssinatura = mensagensFiltradas.map(m => {
    let limpa = String(m)
      .replace(/^\s*\*?_?\s*atendente\s+la[íi]s\s+disse\s*:?\s*_?\*?\s*/i, '')
      .replace(/^\s*\*?\s*la[íi]s\s*:?\s*\*?\s*/i, '')
      .replace(/agenda\s+fechada/gi, 'agenda preenchida')
      .replace(/agendas?\s+est[aá]\s+fechadas?/gi, 'agenda está preenchida');

    // Se mencionar um serviço com múltiplos valores + R$, e NÃO tiver "a partir de",
    // injetar a expressão antes do valor
    for (const nomeServico of servicosComMultiValor) {
      const rxServicoComPreco = new RegExp(`(${nomeServico}[^.]*?)(R\\$\\s*\\d)`, 'gi');
      limpa = limpa.replace(rxServicoComPreco, (full, antes, preco) => {
        if (/a\s+partir\s+de/i.test(antes)) return full; // já tem
        console.log(`[Bot] Adicionando "a partir de" antes de "${preco}" (serviço "${nomeServico}")`);
        return `${antes}a partir de ${preco}`;
      });
    }

    return `*_Atendente Laís disse:_*\n${limpa.trim()}`;
  });

  try {
    await evolutionService.sendMessages(phone, mensagensComAssinatura);
    for (const msg of mensagensComAssinatura) await db.addLog(phone, 'out', msg);
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

// Detecta "DD de Mês" (ex: "25 de julho", "5 de agosto") no texto e retorna AAAA-MM-DD
function parseDiaMes(text) {
  const meses = {
    'janeiro': 1, 'fevereiro': 2, 'marco': 3, 'abril': 4, 'maio': 5, 'junho': 6,
    'julho': 7, 'agosto': 8, 'setembro': 9, 'outubro': 10, 'novembro': 11, 'dezembro': 12,
  };

  // Normaliza: minúsculas + remove acentos substituindo caracteres comuns
  const lower = text.toLowerCase()
    .replace(/[àáâãä]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõö]/g, 'o')
    .replace(/[ùúûü]/g, 'u')
    .replace(/[ç]/g, 'c');

  // Tenta "25 de julho" ou "25 julho"
  const match = lower.match(/(\d{1,2})\s+(?:de\s+)?([a-z]{4,})/);
  if (!match) return null;

  const dia = parseInt(match[1], 10);
  const mesNome = match[2];
  const mes = meses[mesNome];
  if (!mes || dia < 1 || dia > 31) return null;

  const ano = new Date().getFullYear();
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// Detecta dia da semana no texto e retorna a próxima ocorrência em AAAA-MM-DD
function parseDiaSemana(text) {
  const lower = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const dias = { 'segunda': 1, 'terca': 2, 'quarta': 3, 'quinta': 4, 'sexta': 5, 'sabado': 6, 'domingo': 0 };
  for (const [nome, diaSemana] of Object.entries(dias)) {
    if (lower.includes(nome)) {
      const hoje = new Date();
      const diff = (diaSemana - hoje.getDay() + 7) % 7 || 7; // próxima ocorrência (nunca hoje)
      const alvo = new Date(hoje);
      alvo.setDate(hoje.getDate() + diff);
      return alvo.toISOString().split('T')[0];
    }
  }
  return null;
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

// Permite chamar o processamento externamente (ex: retry pelo dashboard)
async function processMessageExternal(phone, text) {
  return processMessage(phone, text, () => true);
}

module.exports = router;
module.exports.processMessageExternal = processMessageExternal;

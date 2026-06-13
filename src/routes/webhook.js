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

  conv.history.push({ role: 'assistant', content: JSON.stringify(aiResponse), ts: Date.now() });

  const { acao, mensagens = [], novoStage, agendamento, agendamento_cancelar, cliente, encaminharHumano } = aiResponse;
  console.log(`[Bot] acao=${acao} | agendamento_cancelar=${JSON.stringify(agendamento_cancelar)} | agendamento=${JSON.stringify(agendamento)?.slice(0,200)}`);

  // ── Ações Trinks ──────────────────────────────────────────────────────────
  if (acao === 'criar_cliente') {
    try {
      const result = await trinksService.criarCliente({
        nome: cliente?.nome,
        cpf: cliente?.cpf,
        email: cliente?.email,
        whatsapp: cliente?.whatsapp || phone,
        dataNascimento: cliente?.data_nascimento,
      });
      await db.saveConversation(phone, conv.history, novoStage || conv.stage, {
        clienteId: result.id,
        nome: cliente?.nome,
        cpf: cliente?.cpf || null,
        whatsapp: cliente?.whatsapp || phone.replace('@s.whatsapp.net', ''),
        email: cliente?.email || null,
        dataNascimento: cliente?.data_nascimento || null,
      });
      console.log(`[Bot] Cliente criado na Trinks: id=${result.id}`);
    } catch (err) {
      console.error('[Bot] Erro ao criar cliente na Trinks:', err.message);
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

        try {
          const result = await trinksService.criarAgendamento({
            clienteId,
            servicoId: item.id,
            profissionalId,
            dataHora: dataHoraISO,
            duracao: duracaoNum,
            valor: item.preco,
            observacoes: cliente?.observacao || null,
          });

          // VERIFICAÇÃO PÓS-CRIAÇÃO — confirma que o agendamento existe de fato no Trinks
          if (!result?.id) {
            console.error(`[Bot] Trinks não retornou ID — agendamento NÃO confirmado: ${item.servico} ${item.data} ${item.horario}`);
            resultados.push({ item, ok: false, erro: 'sem ID de retorno' });
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

  // Prefixar TODA mensagem com "*_Atendente Laís disse:_*" (negrito + itálico no WhatsApp)
  // Remove qualquer duplicação caso a IA tenha tentado adicionar a assinatura
  const mensagensComAssinatura = mensagensFiltradas.map(m => {
    const limpa = String(m)
      .replace(/^\s*\*?_?\s*atendente\s+la[íi]s\s+disse\s*:?\s*_?\*?\s*/i, '')
      .replace(/^\s*\*?\s*la[íi]s\s*:?\s*\*?\s*/i, '')
      .trim();
    return `*_Atendente Laís disse:_*\n${limpa}`;
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

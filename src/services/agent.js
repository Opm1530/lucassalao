/**
 * Agente baseado em Tool Calling com FETCH SOB DEMANDA.
 *
 * Princípio: começa com contexto MÍNIMO (só cliente + data atual). Quando a IA
 * precisa de dados (catálogo de serviços, disponibilidade, agendamentos do cliente),
 * ela CHAMA UMA FERRAMENTA. Isso reduz drasticamente as chamadas ao Trinks.
 *
 * Ferramentas disponíveis:
 *   CONSULTA (read):
 *     - consultar_servicos(busca?)
 *     - consultar_disponibilidade(data)
 *     - consultar_meus_agendamentos()
 *   AÇÃO (write):
 *     - criar_cliente(...)
 *     - agendar(servicos[])
 *     - cancelar_agendamento(ids[])
 *   FLUXO:
 *     - enviar_mensagens(textos[])     ← SEMPRE para responder a cliente
 *     - finalizar_conversa()
 *     - encaminhar_humano(motivo)
 */

const OpenAI = require('openai');
const db = require('../db/database');
const trinksService = require('./trinks');
const { AGENT_PROMPT, buildAgentContext } = require('../utils/agent-prompt');

function getClient() {
  const apiKey = db.getConfig('openai_api_key');
  if (!apiKey) throw new Error('OpenAI API Key não configurada.');
  return new OpenAI({ apiKey });
}

// ─── Schemas das ferramentas para a OpenAI ────────────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'enviar_mensagens',
      description: 'Envia mensagens curtas para a cliente no WhatsApp. CADA item do array vira uma bolha separada. SEMPRE chame essa ferramenta quando quiser falar com a cliente.',
      parameters: {
        type: 'object',
        properties: {
          textos: { type: 'array', items: { type: 'string' } },
        },
        required: ['textos'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_servicos',
      description: 'Busca o catálogo de serviços oferecidos. Use quando a cliente perguntar preços, durações, ou quando precisar do serviceId para agendar. Pode filtrar por nome.',
      parameters: {
        type: 'object',
        properties: {
          busca: {
            type: ['string', 'null'],
            description: 'Termo opcional para filtrar serviços por nome (ex: "corte", "selagem"). Null = todos.',
          },
        },
        required: ['busca'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_disponibilidade',
      description: 'Busca horários disponíveis em uma data. IMPORTANTE: passe os NOMES de TODOS os serviços que a cliente quer fazer nesse dia — o sistema soma as durações e retorna apenas horários onde TODOS cabem antes do fechamento. Ex: progressiva + corte → só horários que comportam as duas durações somadas.',
      parameters: {
        type: 'object',
        properties: {
          data: { type: 'string', description: 'Data no formato AAAA-MM-DD' },
          servicos: {
            type: ['array', 'null'],
            items: { type: 'string' },
            description: 'Nomes dos serviços que a cliente quer fazer NESSE dia (ex: ["Progressiva", "Corte"]). O sistema soma as durações. Se null, retorna horas cheias sem filtro de duração.',
          },
        },
        required: ['data', 'servicos'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_meus_agendamentos',
      description: 'Busca os agendamentos ativos da cliente. Use quando a cliente perguntar sobre horários marcados, antes de cancelar ou remarcar.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agendar',
      description: 'Cria um ou mais agendamentos. SOMENTE após a cliente confirmar. Para cliente não cadastrada (isCustomer=false), chame criar_cliente ANTES. Você passa apenas o NOME do serviço, a data e o horário — o sistema resolve preço, duração e profissional automaticamente.',
      parameters: {
        type: 'object',
        properties: {
          servicos: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                servico: { type: 'string', description: 'Nome do serviço, ex: "Corte"' },
                data: { type: 'string', description: 'DD/MM/AAAA' },
                horario: { type: 'string', description: 'HH:MM (hora cheia)' },
              },
              required: ['servico', 'data', 'horario'],
              additionalProperties: false,
            },
          },
        },
        required: ['servicos'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancelar_agendamento',
      description: 'Cancela um ou mais agendamentos existentes. Use IDs vindos de consultar_meus_agendamentos.',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' } },
        },
        required: ['ids'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'criar_cliente',
      description: 'Cadastra cliente no Trinks. USE quando isCustomer=false e já coletou os dados.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string' },
          whatsapp: { type: 'string' },
          cpf: { type: ['string', 'null'] },
          email: { type: ['string', 'null'] },
          data_nascimento: { type: ['string', 'null'], description: 'DD/MM/AAAA ou null' },
        },
        required: ['nome', 'whatsapp', 'cpf', 'email', 'data_nascimento'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finalizar_conversa',
      description: 'Marca a conversa como finalizada. Use após despedida + feedback.',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'encaminhar_humano',
      description: 'Encaminha para humano. Use em vagas, parcerias, reclamações, fornecedores.',
      parameters: {
        type: 'object',
        properties: { motivo: { type: 'string' } },
        required: ['motivo'],
        additionalProperties: false,
      },
    },
  },
];

// ─── Implementação das ferramentas ───────────────────────────────────────────

async function execEnviarMensagens(args, state) {
  const textos = Array.isArray(args.textos) ? args.textos : [];
  // Defensivo: se a IA mandar um item que é JSON wrapper {"mensagens":[...]} ou
  // {"textos":[...]}, desempacotar pra não enviar o JSON cru pra cliente.
  const limpas = [];
  for (const t of textos) {
    if (!t || !String(t).trim()) continue;
    let texto = String(t).trim();

    // Remove aspas extras envolvendo
    if ((texto.startsWith('"') && texto.endsWith('"')) || (texto.startsWith("'") && texto.endsWith("'"))) {
      texto = texto.slice(1, -1);
    }

    // Tenta desempacotar JSON wrappers
    if (texto.startsWith('{') && texto.endsWith('}')) {
      try {
        const parsed = JSON.parse(texto);
        if (Array.isArray(parsed.mensagens)) {
          parsed.mensagens.forEach(m => m && limpas.push(String(m).trim()));
          continue;
        }
        if (Array.isArray(parsed.textos)) {
          parsed.textos.forEach(m => m && limpas.push(String(m).trim()));
          continue;
        }
      } catch { /* não era JSON, segue como texto */ }
    }
    limpas.push(texto);
  }
  state.mensagensParaEnviar.push(...limpas.filter(Boolean));
  return { ok: true };
}

async function execConsultarServicos(args, _state) {
  const servicos = await trinksService.listarServicos();
  const busca = (args.busca || '').toLowerCase().trim();
  const lista = busca
    ? servicos.filter(s => (s.serviceName || '').toLowerCase().includes(busca))
    : servicos;
  // Retorna versão enxuta
  return {
    ok: true,
    total: lista.length,
    servicos: lista.map(s => ({
      serviceId: s.serviceId,
      serviceName: s.serviceName,
      servicePrice: s.servicePrice,
      duracaoMinutos: s.duracaoMinutos,
      categoria: s.categoria,
    })),
  };
}

async function execConsultarDisponibilidade(args, _state) {
  const data = args.data;
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) {
    return { ok: false, erro: 'Data inválida. Use AAAA-MM-DD.' };
  }

  const horarioFechamento = db.getConfig('horario_fechamento') || '18:00';
  const profSlots = await trinksService.listarDisponibilidade(data);

  // Soma a duração de TODOS os serviços pedidos (progressiva + corte etc.)
  let duracaoTotal = 0;
  let nomesServicos = [];
  if (Array.isArray(args.servicos) && args.servicos.length > 0) {
    try {
      const catalogo = await trinksService.listarServicos();
      for (const nome of args.servicos) {
        const alvo = (nome || '').toLowerCase().trim();
        let srv = catalogo.find(s => (s.serviceName || '').toLowerCase().trim() === alvo);
        if (!srv) srv = catalogo.find(s => (s.serviceName || '').toLowerCase().includes(alvo));
        if (srv) {
          duracaoTotal += Number(srv.duracaoMinutos) || 0;
          nomesServicos.push(srv.serviceName);
        }
      }
    } catch { /* sem catálogo, segue sem filtro de duração */ }
  }

  // Filtra slots passados se for hoje
  const nowBrasilia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const todayStr = nowBrasilia.toISOString().split('T')[0];
  const currentTime = nowBrasilia.getHours() * 60 + nowBrasilia.getMinutes();

  const resultados = profSlots.map(prof => {
    let vagos = prof.horariosDisponiveis || [];
    if (data === todayStr) {
      vagos = vagos.filter(h => {
        const [hh, mm] = h.split(':').map(Number);
        return (hh * 60 + mm) > currentTime;
      });
    }

    let slotsValidos;
    if (duracaoTotal > 0) {
      // Filtra por duração TOTAL: blocos consecutivos livres + termina antes do fechamento
      slotsValidos = trinksService.filtrarSlotsPorDuracao(vagos, duracaoTotal, horarioFechamento)
        .filter(h => h.endsWith(':00'));
    } else {
      slotsValidos = vagos.filter(h => h.endsWith(':00'));
    }

    return {
      profissionalId: prof.profissionalId,
      profissionalNome: prof.profissionalNome,
      horariosDisponiveis: slotsValidos,
    };
  });

  const totalSlots = resultados.reduce((a, p) => a + p.horariosDisponiveis.length, 0);
  return {
    ok: true,
    data,
    horarioFechamento,
    servicosConsiderados: nomesServicos,
    duracaoTotalMinutos: duracaoTotal,
    totalSlotsDisponiveis: totalSlots,
    indisponivel: totalSlots === 0,
    profissionais: resultados,
  };
}

async function execConsultarMeusAgendamentos(_args, state) {
  const clienteId = state.context.lead?.clienteId || state.clienteCriadoId;
  if (!clienteId) {
    return { ok: true, total: 0, agendamentos: [], aviso: 'Cliente não cadastrado' };
  }
  const ags = await trinksService.listarAgendamentosCliente(clienteId);
  return {
    ok: true,
    total: ags.length,
    agendamentos: ags.map(a => ({
      id: a.id,
      servico: a.servico,
      profissional: a.profissional,
      data: a.data,
      horario: a.horario,
      duracao: a.duracao,
      status: a.status,
    })),
  };
}

function minToHHMM(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

async function execAgendar(args, state) {
  const servicos = Array.isArray(args.servicos) ? args.servicos : [];
  const { phone, context } = state;

  let clienteId = context.lead?.clienteId || state.clienteCriadoId;
  if (!clienteId) {
    return { ok: false, erro: 'Cliente não cadastrado. Chame criar_cliente antes de agendar.' };
  }

  // Carrega catálogo (cacheado) para resolver serviceId/preco/duracao por NOME
  const catalogo = await trinksService.listarServicos();

  // ── FASE 1: Resolver todos os serviços e ENCADEAR os horários ──────────────
  // O código calcula o início de cada serviço = fim do anterior. A IA só precisa
  // acertar o horário do PRIMEIRO serviço — o resto é calculado aqui.
  const itensResolvidos = [];
  let horarioCorrenteMin = null; // minutos do horário de início acumulado
  let dataComum = null;

  for (let i = 0; i < servicos.length; i++) {
    const item = servicos[i];
    const nomeServ = (item.servico || '').toLowerCase().trim();
    let srv = catalogo.find(s => (s.serviceName || '').toLowerCase().trim() === nomeServ);
    if (!srv) srv = catalogo.find(s => (s.serviceName || '').toLowerCase().includes(nomeServ));
    if (!srv) {
      itensResolvidos.push({ erroResolucao: `Serviço "${item.servico}" não encontrado no catálogo`, servicoNome: item.servico, data: item.data, horario: item.horario });
      continue;
    }

    const duracao = Number(srv.duracaoMinutos) || 30;
    const dataISO = (item.data || dataComum || '').split('/').reverse().join('-');
    dataComum = item.data || dataComum;

    // Define horário: o 1º serviço usa o horario informado; os seguintes encadeiam
    let horario;
    if (horarioCorrenteMin === null) {
      const [hh, mm] = (item.horario || '08:00').split(':').map(Number);
      horarioCorrenteMin = hh * 60 + mm;
      horario = minToHHMM(horarioCorrenteMin);
    } else {
      horario = minToHHMM(horarioCorrenteMin);
    }

    itensResolvidos.push({
      srv, duracao, dataISO, dataBR: item.data || dataComum, horario,
      servicoNome: srv.serviceName, preco: srv.servicePrice, serviceId: srv.serviceId,
    });

    horarioCorrenteMin += duracao; // próximo serviço começa quando este termina
  }

  // ── FASE 2: Criar cada agendamento já com o horário encadeado correto ──────
  const resultados = [];
  for (const it of itensResolvidos) {
    if (it.erroResolucao) {
      resultados.push({ servico: it.servicoNome, data: it.data, horario: it.horario, ok: false, motivo: it.erroResolucao });
      continue;
    }

    const { srv, duracao, dataISO, dataBR, horario } = it;
    const dataHoraISO = `${dataISO}T${horario}:00`;

    // IDEMPOTÊNCIA
    const acaoRecente = await db.buscarAgendamentoRecente({ phone, dataAgendamento: dataISO, horario, servico: srv.serviceName }, 10);
    if (acaoRecente) {
      resultados.push({ servico: srv.serviceName, data: dataBR, horario, ok: true, jaExistia: true, trinksId: acaoRecente.trinks_id });
      continue;
    }

    // Resolve profissional pela disponibilidade real
    const profSlots = await trinksService.listarDisponibilidade(dataISO);
    const profDisponivel = profSlots.find(p => (p.horariosDisponiveis || []).includes(horario));
    if (!profDisponivel) {
      resultados.push({ servico: srv.serviceName, data: dataBR, horario, ok: false, isConflito: true, motivo: `Horário ${horario} não está disponível em ${dataBR}` });
      continue;
    }
    const profissionalId = profDisponivel.profissionalId;

    // Verifica slot livre considerando a duração
    const checagem = await trinksService.verificarSlotLivre({ profissionalId, dataHora: dataHoraISO, duracao });
    if (!checagem.livre) {
      resultados.push({ servico: srv.serviceName, data: dataBR, horario, ok: false, isConflito: true, motivo: checagem.motivo });
      continue;
    }

    // Cria com retry
    let result = null, lastErr = null;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        result = await trinksService.criarAgendamento({
          clienteId, servicoId: srv.serviceId, profissionalId,
          dataHora: dataHoraISO, duracao, valor: srv.servicePrice, observacoes: null,
        });
        if (result?.id) break;
      } catch (err) {
        lastErr = err;
        if (err.isConflito) {
          resultados.push({ servico: srv.serviceName, data: dataBR, horario, ok: false, isConflito: true, motivo: err.message });
          result = null;
          break;
        }
        if (tentativa < 3) await new Promise(r => setTimeout(r, 2000 * tentativa));
      }
    }

    if (!result?.id) {
      resultados.push({ servico: srv.serviceName, data: dataBR, horario, ok: false, motivo: lastErr?.message || 'sem ID' });
      continue;
    }

    try {
      await db.registrarAcaoBot({
        tipo: 'criado', trinksId: String(result.id), phone, clienteId: String(clienteId),
        servico: srv.serviceName, dataAgendamento: dataISO, horario, profissionalId: String(profissionalId),
      });
    } catch { /* silencioso */ }

    state.agendamentosCriados.push({ id: result.id, servico: srv.serviceName, data: dataBR, horario, preco: srv.servicePrice });
    resultados.push({ servico: srv.serviceName, data: dataBR, horario, preco: srv.servicePrice, ok: true, trinksId: result.id });
  }

  // Marca se algum agendamento falhou (usado para decidir o envio do link de outros serviços)
  if (resultados.some(r => !r.ok)) state.algumAgendamentoFalhou = true;

  return { ok: resultados.every(r => r.ok), resultados };
}

async function execCancelar(args, state) {
  const { phone, context } = state;
  const idsPedidos = Array.isArray(args.ids) ? args.ids.map(String) : [];
  const clienteId = context.lead?.clienteId || state.clienteCriadoId;

  // VALIDAÇÃO: só cancela IDs que realmente pertencem ao cliente.
  // Evita o bug de a IA passar o clienteId no lugar do id do agendamento.
  let agsCliente = [];
  if (clienteId) {
    try {
      agsCliente = await trinksService.listarAgendamentosCliente(clienteId);
    } catch (err) {
      console.warn('[Agent] cancelar: falha ao listar agendamentos do cliente:', err.message);
    }
  }
  const idsValidos = new Set(agsCliente.map(a => String(a.id)));

  const resultados = [];
  for (const id of idsPedidos) {
    if (idsValidos.size > 0 && !idsValidos.has(id)) {
      console.warn(`[Agent] cancelar: id ${id} NÃO pertence ao cliente — ignorado. IDs válidos: ${[...idsValidos].join(',')}`);
      resultados.push({ id, ok: false, erro: 'ID não pertence aos agendamentos do cliente. Use consultar_meus_agendamentos para obter o ID correto.' });
      continue;
    }
    try {
      await trinksService.cancelarAgendamento(id);
      resultados.push({ id, ok: true });
      state.cancelamentosOk.push(id);
      try {
        await db.registrarAcaoBot({
          tipo: 'cancelado', trinksId: id, phone,
          clienteId: clienteId ? String(clienteId) : null,
          servico: null, dataAgendamento: null, horario: null, profissionalId: null,
        });
      } catch { /* silencioso */ }
    } catch (err) {
      resultados.push({ id, ok: false, erro: err.message });
    }
  }

  return { ok: resultados.every(r => r.ok), resultados };
}

async function execCriarCliente(args, state) {
  const { phone } = state;
  let result = null, lastErr = null;

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      result = await trinksService.criarCliente({
        nome: args.nome, cpf: args.cpf, email: args.email,
        whatsapp: args.whatsapp || phone, dataNascimento: args.data_nascimento,
      });
      if (result?.id) break;
    } catch (err) {
      lastErr = err;
      if (tentativa < 3) await new Promise(r => setTimeout(r, 2000 * tentativa));
    }
  }

  if (!result?.id) {
    return { ok: false, erro: lastErr?.message || 'falha ao criar cliente' };
  }

  state.clienteCriadoId = result.id;
  state.clienteCriado = {
    id: result.id, nome: args.nome, cpf: args.cpf, email: args.email,
    whatsapp: args.whatsapp || phone, data_nascimento: args.data_nascimento,
  };
  return { ok: true, clienteId: result.id };
}

async function execFinalizar(_args, state) { state.finalizar = true; return { ok: true }; }
async function execEncaminharHumano(args, state) {
  state.encaminharHumano = true; state.motivoHumano = args.motivo; return { ok: true };
}

const EXECUTORES = {
  enviar_mensagens: execEnviarMensagens,
  consultar_servicos: execConsultarServicos,
  consultar_disponibilidade: execConsultarDisponibilidade,
  consultar_meus_agendamentos: execConsultarMeusAgendamentos,
  agendar: execAgendar,
  cancelar_agendamento: execCancelar,
  criar_cliente: execCriarCliente,
  finalizar_conversa: execFinalizar,
  encaminhar_humano: execEncaminharHumano,
};

// ─── Loop principal do agente ────────────────────────────────────────────────

async function chat(history, context, phone) {
  // VERIFICAÇÃO DE LIMITE DIÁRIO DE TOKENS
  const limite = parseInt(db.getConfig('openai_daily_token_limit') || '0', 10);
  if (limite > 0) {
    const uso = await db.getUsoTokenHoje();
    if (uso.total >= limite) {
      const err = new Error(`Limite diário de tokens atingido (${uso.total}/${limite})`);
      err.limiteAtingido = true;
      throw err;
    }
  }

  const client = getClient();
  const model = db.getConfig('openai_model') || 'gpt-4o-mini';
  const isMini = model.includes('mini');

  const state = {
    phone, context,
    mensagensParaEnviar: [],
    agendamentosCriados: [],
    cancelamentosOk: [],
    clienteCriado: null,
    clienteCriadoId: null,
    finalizar: false,
    encaminharHumano: false,
    motivoHumano: null,
    algumAgendamentoFalhou: false,
  };

  // Limpa histórico: se mensagens passadas estão em JSON, extrai só o texto pra não confundir a IA
  function limparMensagemHistorico(content) {
    if (!content) return '';
    let txt = String(content).trim();
    if (txt.startsWith('{') && txt.endsWith('}')) {
      try {
        const parsed = JSON.parse(txt);
        if (Array.isArray(parsed.mensagens)) return parsed.mensagens.join('\n');
        if (Array.isArray(parsed.textos)) return parsed.textos.join('\n');
      } catch { /* não era JSON */ }
    }
    return txt;
  }
  const historyForApi = history.map(m => ({
    role: m.role,
    content: limparMensagemHistorico(m.content),
  }));
  const dateStr = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Sao_Paulo',
  });

  let messages = [
    { role: 'system', content: AGENT_PROMPT },
    { role: 'user', content: buildAgentContext(context, dateStr) },
    ...historyForApi,
  ];

  // Loop de até 5 rounds — cada round, IA pode chamar ferramentas, receber resultado, e continuar
  const MAX_ROUNDS = 5;
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const response = await client.chat.completions.create({
      model, messages, tools: TOOLS, tool_choice: 'auto',
      temperature: 0.3, max_tokens: 2000,
    });

    const usage = response.usage || {};
    const custoUSD = ((usage.prompt_tokens || 0) * (isMini ? 0.15 : 2.5) / 1_000_000)
                   + ((usage.completion_tokens || 0) * (isMini ? 0.60 : 10) / 1_000_000);
    console.log(`[Agent] R${round} | in=${usage.prompt_tokens || 0} out=${usage.completion_tokens || 0} | ~$${custoUSD.toFixed(4)}`);
    db.registrarUsoToken(usage.prompt_tokens || 0, usage.completion_tokens || 0, custoUSD).catch(() => {});

    const aiMessage = response.choices[0].message;
    const toolCalls = aiMessage.tool_calls || [];

    // Sem tool calls: AI quer só falar (ou nada)
    if (toolCalls.length === 0) {
      if (aiMessage.content && state.mensagensParaEnviar.length === 0) {
        state.mensagensParaEnviar.push(aiMessage.content);
      }
      break;
    }

    // Executa cada tool call
    const toolResults = [];
    let chamouEnviarMensagens = false;
    for (const tc of toolCalls) {
      const name = tc.function?.name;
      if (name === 'enviar_mensagens') chamouEnviarMensagens = true;

      let args = {};
      try { args = JSON.parse(tc.function?.arguments || '{}'); } catch (e) {
        console.warn(`[Agent] JSON inválido em ${name}:`, e.message);
      }

      const exec = EXECUTORES[name];
      let result;
      if (!exec) {
        result = { ok: false, erro: `Tool desconhecida: ${name}` };
      } else {
        try {
          result = await exec(args, state);
          console.log(`[Agent] R${round} tool ${name} → ok=${result.ok}`);
        } catch (err) {
          console.error(`[Agent] Erro em ${name}:`, err.message);
          result = { ok: false, erro: err.message };
        }
      }
      toolResults.push({ tool_call_id: tc.id, result });
    }

    // Se chamou enviar_mensagens, fim — não precisa mais rounds
    if (chamouEnviarMensagens) {
      break;
    }

    // Senão: insere resultados na conversa e continua loop
    messages.push(aiMessage);
    for (const tr of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: tr.tool_call_id,
        content: JSON.stringify(tr.result),
      });
    }
  }

  // Se chegou ao fim sem mensagem, FORÇA a IA a gerar uma resposta com base no que aconteceu
  if (state.mensagensParaEnviar.length === 0) {
    console.warn(`[Agent] Sem mensagem após ${MAX_ROUNDS} rounds — forçando enviar_mensagens`);
    try {
      const forced = await client.chat.completions.create({
        model,
        messages: [
          ...messages,
          { role: 'system', content: 'Gere AGORA a resposta para a cliente com base nos resultados das ferramentas acima. Se algo deu certo, confirme. Se algo falhou, explique de forma honesta e diga que vai pedir para o salão entrar em contato. NUNCA diga "vou verificar" ou "um momento". Chame enviar_mensagens.' },
        ],
        tools: [TOOLS[0]], // só enviar_mensagens
        tool_choice: { type: 'function', function: { name: 'enviar_mensagens' } },
        temperature: 0.3, max_tokens: 800,
      });
      const tc = (forced.choices[0].message.tool_calls || [])[0];
      if (tc) {
        const a = JSON.parse(tc.function.arguments || '{}');
        await execEnviarMensagens(a, state);
      }
    } catch (err) {
      console.error('[Agent] Falha ao forçar mensagem:', err.message);
    }
  }

  // Fallback final — só se ainda assim nada saiu. Baseado no que realmente aconteceu.
  if (state.mensagensParaEnviar.length === 0) {
    if (state.agendamentosCriados.length > 0) {
      const ag = state.agendamentosCriados[0];
      state.mensagensParaEnviar.push(`Seu horário está confirmado para ${ag.data} às ${ag.horario}. ✅`);
    } else if (state.cancelamentosOk.length > 0) {
      state.mensagensParaEnviar.push('Seu horário foi cancelado. 🗓️');
    } else {
      state.mensagensParaEnviar.push('Tive uma dificuldade técnica agora. 😔');
      state.mensagensParaEnviar.push('Vou pedir para o salão entrar em contato com você para garantir tudo certinho!');
    }
  }

  return {
    mensagens: state.mensagensParaEnviar,
    agendamentosCriados: state.agendamentosCriados,
    cancelamentosOk: state.cancelamentosOk,
    clienteCriado: state.clienteCriado,
    finalizar: state.finalizar,
    encaminharHumano: state.encaminharHumano,
    motivoHumano: state.motivoHumano,
    algumAgendamentoFalhou: state.algumAgendamentoFalhou,
  };
}

module.exports = { chat };

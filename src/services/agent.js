/**
 * Agente baseado em Tool Calling da OpenAI.
 *
 * Diferenças vs openai.js antigo:
 * - Em vez de a IA retornar JSON estruturado misturando ações e mensagens,
 *   ela chama ferramentas (functions) validadas pela própria OpenAI.
 * - Schema de cada ferramenta é estrito → impossível a IA mandar formato errado.
 * - Validação determinística acontece DENTRO da execução de cada ferramenta.
 * - Mensagens para a cliente são enviadas via tool `enviar_mensagens`.
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

// ─── Definição das ferramentas (schemas para a OpenAI) ───────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'enviar_mensagens',
      description: 'Envia uma ou mais mensagens curtas para a cliente no WhatsApp. CADA item do array vira uma bolha separada. SEMPRE chame essa ferramenta — é como você se comunica com a cliente.',
      parameters: {
        type: 'object',
        properties: {
          textos: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lista de frases curtas a enviar. Cada item = uma bolha no WhatsApp.',
          },
        },
        required: ['textos'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'agendar',
      description: 'Cria um ou mais agendamentos no Trinks. Use APENAS quando a cliente já confirmou explicitamente. Para cliente não cadastrada (isCustomer=false), chame criar_cliente ANTES.',
      parameters: {
        type: 'object',
        properties: {
          servicos: {
            type: 'array',
            description: 'Lista de agendamentos a criar (um ou mais serviços).',
            items: {
              type: 'object',
              properties: {
                serviceId: { type: 'string', description: 'ID do serviço do catálogo' },
                servico: { type: 'string', description: 'Nome do serviço (informativo)' },
                data: { type: 'string', description: 'Data no formato DD/MM/AAAA' },
                horario: { type: 'string', description: 'Horário HH:MM (hora cheia)' },
                duracao: { type: 'integer', description: 'Duração em minutos' },
                preco: { type: 'number', description: 'Valor em reais' },
                profissionalId: { type: 'string', description: 'ID do profissional' },
              },
              required: ['serviceId', 'servico', 'data', 'horario', 'duracao', 'preco', 'profissionalId'],
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
      description: 'Cancela um ou mais agendamentos existentes. Use os IDs presentes em lead.agendamentos.',
      parameters: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs dos agendamentos a cancelar',
          },
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
      description: 'Cadastra a cliente no Trinks. USE quando isCustomer=false e você já coletou os dados.',
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
      description: 'Marca a conversa como finalizada. Use após a mensagem de despedida + pedido de feedback.',
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
      name: 'encaminhar_humano',
      description: 'Encaminha a conversa para atendimento humano. Use para casos fora do escopo (vagas de emprego, parcerias, reclamações, fornecedores).',
      parameters: {
        type: 'object',
        properties: {
          motivo: { type: 'string' },
        },
        required: ['motivo'],
        additionalProperties: false,
      },
    },
  },
];

// ─── Implementação das ferramentas (lógica real) ─────────────────────────────

async function execEnviarMensagens(args, state) {
  const textos = Array.isArray(args.textos) ? args.textos : [];
  state.mensagensParaEnviar.push(...textos.filter(t => t && t.trim()));
  return { ok: true };
}

async function execAgendar(args, state) {
  const servicos = Array.isArray(args.servicos) ? args.servicos : [];
  const { phone, context } = state;

  let clienteId = context.lead?.clienteId || state.clienteCriadoId;
  if (!clienteId) {
    return { ok: false, erro: 'Cliente não cadastrado. Chame criar_cliente antes de agendar.' };
  }

  const resultados = [];
  for (const item of servicos) {
    const dataISO = item.data.split('/').reverse().join('-');
    const horario = item.horario;
    const dataHoraISO = `${dataISO}T${horario}:00`;
    const duracao = Number(item.duracao) || 30;

    // IDEMPOTÊNCIA: já criamos esse mesmo agendamento recentemente?
    const acaoRecente = await db.buscarAgendamentoRecente({
      phone,
      dataAgendamento: dataISO,
      horario,
      servico: item.servico,
    }, 10);
    if (acaoRecente) {
      resultados.push({ servico: item.servico, data: item.data, horario, ok: true, jaExistia: true, trinksId: acaoRecente.trinks_id });
      continue;
    }

    // Verifica slot livre antes de tentar criar
    const checagem = await trinksService.verificarSlotLivre({
      profissionalId: item.profissionalId,
      dataHora: dataHoraISO,
      duracao,
    });
    if (!checagem.livre) {
      resultados.push({ servico: item.servico, data: item.data, horario, ok: false, isConflito: true, motivo: checagem.motivo });
      continue;
    }

    // Cria no Trinks com retry
    let result = null;
    let lastErr = null;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      try {
        result = await trinksService.criarAgendamento({
          clienteId,
          servicoId: item.serviceId,
          profissionalId: item.profissionalId,
          dataHora: dataHoraISO,
          duracao,
          valor: item.preco,
          observacoes: null,
        });
        if (result?.id) break;
      } catch (err) {
        lastErr = err;
        if (err.isConflito) {
          resultados.push({ servico: item.servico, data: item.data, horario, ok: false, isConflito: true, motivo: err.message });
          result = null;
          break;
        }
        if (tentativa < 3) await new Promise(r => setTimeout(r, 2000 * tentativa));
      }
    }

    if (!result?.id) {
      resultados.push({ servico: item.servico, data: item.data, horario, ok: false, motivo: lastErr?.message || 'sem ID' });
      continue;
    }

    // Registra no log local
    try {
      await db.registrarAcaoBot({
        tipo: 'criado',
        trinksId: String(result.id),
        phone,
        clienteId: String(clienteId),
        servico: item.servico,
        dataAgendamento: dataISO,
        horario,
        profissionalId: String(item.profissionalId),
      });
    } catch { /* silencioso */ }

    state.agendamentosCriados.push({ id: result.id, ...item });
    resultados.push({ servico: item.servico, data: item.data, horario, ok: true, trinksId: result.id });
  }

  return { ok: resultados.every(r => r.ok), resultados };
}

async function execCancelar(args, state) {
  const { phone, context } = state;
  const ids = Array.isArray(args.ids) ? args.ids.map(String) : [];
  const resultados = [];

  for (const id of ids) {
    try {
      await trinksService.cancelarAgendamento(id);
      resultados.push({ id, ok: true });
      state.cancelamentosOk.push(id);
      try {
        await db.registrarAcaoBot({
          tipo: 'cancelado',
          trinksId: id,
          phone,
          clienteId: context.lead?.clienteId ? String(context.lead.clienteId) : null,
          servico: null,
          dataAgendamento: null,
          horario: null,
          profissionalId: null,
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
  let result = null;
  let lastErr = null;

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      result = await trinksService.criarCliente({
        nome: args.nome,
        cpf: args.cpf,
        email: args.email,
        whatsapp: args.whatsapp || phone,
        dataNascimento: args.data_nascimento,
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
  state.clienteCriado = { id: result.id, nome: args.nome, cpf: args.cpf, email: args.email, whatsapp: args.whatsapp || phone, data_nascimento: args.data_nascimento };
  return { ok: true, clienteId: result.id };
}

async function execFinalizar(_args, state) {
  state.finalizar = true;
  return { ok: true };
}

async function execEncaminharHumano(args, state) {
  state.encaminharHumano = true;
  state.motivoHumano = args.motivo;
  return { ok: true };
}

const EXECUTORES = {
  enviar_mensagens: execEnviarMensagens,
  agendar: execAgendar,
  cancelar_agendamento: execCancelar,
  criar_cliente: execCriarCliente,
  finalizar_conversa: execFinalizar,
  encaminhar_humano: execEncaminharHumano,
};

// ─── Loop principal do agente ────────────────────────────────────────────────

/**
 * Executa o agente para uma mensagem da cliente.
 * Retorna: { mensagens: string[], agendamentosCriados, cancelamentosOk, clienteCriado, finalizar, encaminharHumano }
 */
async function chat(history, context, phone) {
  const client = getClient();
  const model = db.getConfig('openai_model') || 'gpt-4o-mini';

  // Estado mutável que as ferramentas modificam
  const state = {
    phone,
    context,
    mensagensParaEnviar: [],
    agendamentosCriados: [],
    cancelamentosOk: [],
    clienteCriado: null,
    clienteCriadoId: null,
    finalizar: false,
    encaminharHumano: false,
    motivoHumano: null,
  };

  // Formata histórico — IMPORTANTE: usa só campos role + content (sem JSON exotico)
  const historyForApi = history.map(m => ({
    role: m.role,
    content: m.content || '',
  }));

  const dateStr = new Date().toLocaleDateString('pt-BR', {
    weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
    timeZone: 'America/Sao_Paulo',
  });

  const messages = [
    { role: 'system', content: AGENT_PROMPT },
    { role: 'user', content: buildAgentContext(context, dateStr) },
    ...historyForApi,
  ];

  // ── Round 1: AI planeja e executa ferramentas ──────────────────────────
  const response = await client.chat.completions.create({
    model,
    messages,
    tools: TOOLS,
    tool_choice: 'auto',
    temperature: 0.3,
    max_tokens: 2000,
  });

  const usage = response.usage || {};
  const isMini = model.includes('mini');
  const custoUSD = ((usage.prompt_tokens || 0) * (isMini ? 0.15 : 2.5) / 1_000_000)
                 + ((usage.completion_tokens || 0) * (isMini ? 0.60 : 10) / 1_000_000);
  console.log(`[Agent] R1 model=${model} | in=${usage.prompt_tokens || 0} out=${usage.completion_tokens || 0} | ~$${custoUSD.toFixed(4)}`);
  db.registrarUsoToken(usage.prompt_tokens || 0, usage.completion_tokens || 0, custoUSD).catch(() => {});

  const aiMessage = response.choices[0].message;
  const toolCalls = aiMessage.tool_calls || [];

  if (toolCalls.length === 0) {
    // AI não chamou nenhuma ferramenta — usa content como mensagem fallback
    if (aiMessage.content) {
      state.mensagensParaEnviar.push(aiMessage.content);
    }
    return finalizarEstado(state);
  }

  // Executa cada tool call e coleta resultados
  const toolResults = [];
  for (const tc of toolCalls) {
    const name = tc.function?.name;
    const argsRaw = tc.function?.arguments || '{}';
    let args = {};
    try { args = JSON.parse(argsRaw); } catch (e) {
      console.warn(`[Agent] JSON inválido em tool call ${name}:`, argsRaw);
    }
    const exec = EXECUTORES[name];
    let result;
    if (!exec) {
      console.warn(`[Agent] Tool desconhecida: ${name}`);
      result = { ok: false, erro: `Tool desconhecida: ${name}` };
    } else {
      try {
        result = await exec(args, state);
        console.log(`[Agent] Tool ${name} executada — ok=${result.ok}`);
      } catch (err) {
        console.error(`[Agent] Erro em tool ${name}:`, err.message);
        result = { ok: false, erro: err.message };
      }
    }
    toolResults.push({ tool_call_id: tc.id, name, result });
  }

  // Se já temos mensagens (AI chamou enviar_mensagens junto), encerra
  if (state.mensagensParaEnviar.length > 0) {
    return finalizarEstado(state);
  }

  // ── Round 2: AI vê os resultados e gera a mensagem para a cliente ──────
  console.log(`[Agent] Round 2: gerando resposta com base nos resultados das ferramentas`);

  const messagesR2 = [
    ...messages,
    aiMessage,
    ...toolResults.map(tr => ({
      role: 'tool',
      tool_call_id: tr.tool_call_id,
      content: JSON.stringify(tr.result),
    })),
  ];

  const response2 = await client.chat.completions.create({
    model,
    messages: messagesR2,
    tools: [TOOLS[0]], // só enviar_mensagens
    tool_choice: { type: 'function', function: { name: 'enviar_mensagens' } },
    temperature: 0.3,
    max_tokens: 1000,
  });

  const usage2 = response2.usage || {};
  const custoUSD2 = ((usage2.prompt_tokens || 0) * (isMini ? 0.15 : 2.5) / 1_000_000)
                  + ((usage2.completion_tokens || 0) * (isMini ? 0.60 : 10) / 1_000_000);
  console.log(`[Agent] R2 model=${model} | in=${usage2.prompt_tokens || 0} out=${usage2.completion_tokens || 0} | ~$${custoUSD2.toFixed(4)}`);
  db.registrarUsoToken(usage2.prompt_tokens || 0, usage2.completion_tokens || 0, custoUSD2).catch(() => {});

  const tcsR2 = response2.choices[0].message.tool_calls || [];
  for (const tc of tcsR2) {
    if (tc.function?.name === 'enviar_mensagens') {
      try {
        const args = JSON.parse(tc.function.arguments || '{}');
        await execEnviarMensagens(args, state);
      } catch (e) {
        console.warn(`[Agent] R2: erro parse enviar_mensagens:`, e.message);
      }
    }
  }

  // Fallback se nem R2 gerou mensagem
  if (state.mensagensParaEnviar.length === 0) {
    state.mensagensParaEnviar.push('Recebi sua mensagem! Em breve te respondo.');
  }

  return finalizarEstado(state);
}

function finalizarEstado(state) {
  return {
    mensagens: state.mensagensParaEnviar,
    agendamentosCriados: state.agendamentosCriados,
    cancelamentosOk: state.cancelamentosOk,
    clienteCriado: state.clienteCriado,
    finalizar: state.finalizar,
    encaminharHumano: state.encaminharHumano,
    motivoHumano: state.motivoHumano,
  };
}

module.exports = { chat };

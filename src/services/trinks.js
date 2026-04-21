const axios = require('axios');
const db = require('../db/database');

// ─── Modo demo ────────────────────────────────────────────────────────────────

function isDemoMode() {
  return db.getConfig('demo_mode') === 'true';
}

const DEMO_DATA = {
  servicos: [
    { serviceId: 1, serviceName: 'Corte Feminino', servicePrice: 120, serviceDuracao: '45 minutos', duracaoMinutos: 45, categoriaId: 1, categoria: 'Cabelo' },
    { serviceId: 2, serviceName: 'Escova Progressiva', servicePrice: 280, serviceDuracao: '120 minutos', duracaoMinutos: 120, categoriaId: 1, categoria: 'Cabelo' },
    { serviceId: 3, serviceName: 'Coloração', servicePrice: 200, serviceDuracao: '90 minutos', duracaoMinutos: 90, categoriaId: 1, categoria: 'Cabelo' },
    { serviceId: 4, serviceName: 'Hidratação', servicePrice: 80, serviceDuracao: '45 minutos', duracaoMinutos: 45, categoriaId: 1, categoria: 'Cabelo' },
    { serviceId: 5, serviceName: 'Corte Masculino', servicePrice: 60, serviceDuracao: '30 minutos', duracaoMinutos: 30, categoriaId: 1, categoria: 'Cabelo' },
  ],
  profissionais: [
    { profissionalId: 1, profissionalNome: 'Lucas Rocha', foto: null },
  ],
};

// Clientes criados durante a sessão de demo (em memória)
const demoClientes = new Map();
let demoClienteIdSeq = 100;

// Agendamentos criados durante a sessão de demo
const demoAgendamentos = [];
let demoAgendamentoIdSeq = 1000;

function demoGetContexto(phone) {
  const numero = phone.replace('@s.whatsapp.net', '').replace(/^55/, '');
  const cliente = demoClientes.get(numero) || null;
  const agendamentos = demoAgendamentos.filter(a => a.clientePhone === numero);
  return { cliente, agendamentos };
}

// ─── Fim modo demo ────────────────────────────────────────────────────────────

function getClient() {
  const baseURL = db.getConfig('trinks_base_url') || 'https://api.trinks.com';
  const apiKey = db.getConfig('trinks_api_key');
  const estabelecimentoId = db.getConfig('trinks_estabelecimento_id');

  if (!apiKey || !estabelecimentoId) {
    throw new Error('Trinks API não configurada. Configure a chave e o estabelecimentoId no dashboard.');
  }

  return axios.create({
    baseURL,
    headers: {
      'X-Api-Key': apiKey,
      'EstabelecimentoId': estabelecimentoId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    timeout: 15000,
  });
}

// Helper to ensure we always have an array from Trinks API response
function ensureArray(data) {
  if (!data) return [];
  
  // Se já for um array direto (ex: [ {id: 1, ...}, ... ])
  if (Array.isArray(data)) return data;
  
  // Se estiver em campos comuns (items, Items, data)
  if (Array.isArray(data.items)) return data.items;
  if (Array.isArray(data.Items)) return data.Items;
  if (Array.isArray(data.data)) return data.data;

  // Se for um objeto mas não encontramos a lista, vamos vasculhar erro ou outros campos
  if (data && typeof data === 'object') {
    const errorMsg = data.Mensagem || (Array.isArray(data.Erros) ? data.Erros.join(', ') : data.Erros) || data.error;
    if (errorMsg) throw new Error(errorMsg);

    // Tentar encontrar qualquer campo que seja um array (pode vir como "servicos", "profissionais", etc)
    for (const key in data) {
      if (Array.isArray(data[key])) {
        return data[key];
      }
    }
    
    // Log para debug no console do servidor (Node.js)
    console.log('[Trinks Debug] Resposta sem array detectado:', JSON.stringify(data));
  }

  return [];
}

// In-memory cache — serviços/profissionais: 5 min, disponibilidade: 10 min
const cache = new Map();
function fromCache(key, ttlMs = 5 * 60 * 1000) {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
  return null;
}
function toCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

// ─── Serviços ─────────────────────────────────────────────────────────────────

async function listarServicos() {
  if (isDemoMode()) return DEMO_DATA.servicos;

  const cached = fromCache('servicos');
  if (cached) return cached;

  const client = getClient();
  const { data } = await client.get('/v1/servicos', {
    params: { pageSize: 100, somenteVisiveisCliente: false },
  });

  const items = ensureArray(data);
  const servicos = items.map((s) => ({
    serviceId: s.id,
    serviceName: s.nome,
    servicePrice: s.valor ?? s.preco ?? 0,
    serviceDuracao: s.duracaoEmMinutos ? `${s.duracaoEmMinutos} minutos` : '60 minutos',
    duracaoMinutos: s.duracaoEmMinutos ?? 60,
    categoriaId: s.categoriaId ?? null,
    categoria: s.categoria?.nome ?? '',
  }));

  toCache('servicos', servicos);
  return servicos;
}

// ─── Profissionais ─────────────────────────────────────────────────────────────

async function listarProfissionais() {
  if (isDemoMode()) return DEMO_DATA.profissionais;

  const cached = fromCache('profissionais');
  if (cached) return cached;

  const client = getClient();
  const { data } = await client.get('/v1/profissionais', {
    params: { pageSize: 50 },
  });

  const items = ensureArray(data);
  const profissionais = items.map((p) => ({
    profissionalId: p.id,
    profissionalNome: p.nome,
    foto: p.foto ?? null,
  }));

  toCache('profissionais', profissionais);
  return profissionais;
}

// ─── Clientes ──────────────────────────────────────────────────────────────────

async function buscarClientePorTelefone(telefone) {
  const clean = telefone.replace('@s.whatsapp.net', '').replace(/^55/, '');
  
  const baseVariations = [clean];
  if (clean.length === 11 && clean[2] === '9') {
    baseVariations.push(clean.substring(0, 2) + clean.substring(3));
  } else if (clean.length === 10) {
    baseVariations.push(clean.substring(0, 2) + '9' + clean.substring(2));
  }

  const variations = [];
  baseVariations.forEach(v => {
    variations.push(v);
    variations.push('55' + v);
  });

  if (isDemoMode()) {
    for (const v of variations) {
      if (demoClientes.has(v)) return demoClientes.get(v);
    }
    return null;
  }

  const client = getClient();
  for (const v of variations) {
    try {
      const { data } = await client.get('/v1/clientes', {
        params: { telefone: v, pageSize: 5 },
      });
      const items = ensureArray(data);
      if (items.length > 0) return items[0];
    } catch (err) {
      console.warn(`[Trinks] Falha na busca por telefone (${v}):`, err.message);
    }
  }
  return null;
}

async function buscarClientePorEmail(email) {
  if (isDemoMode()) {
    return Array.from(demoClientes.values()).find(c => c.email === email) || null;
  }

  const client = getClient();
  try {
    const { data } = await client.get('/v1/clientes', {
      params: { email, pageSize: 1 }
    });
    const items = ensureArray(data);
    return items.length > 0 ? { id: items[0].id, nome: items[0].nome, email: items[0].email } : null;
  } catch {
    return null;
  }
}

async function criarCliente({ nome, email, whatsapp, dataNascimento }) {
  const numero = (whatsapp || '').replace('@s.whatsapp.net', '').replace(/^55/, '');

  if (isDemoMode()) {
    const id = ++demoClienteIdSeq;
    demoClientes.set(numero, { id, nome, email: email || null, telefone: numero });
    console.log(`[Demo] Cliente criado: id=${id} nome=${nome}`);
    return { id };
  }

  const client = getClient();
  try {
    const numeroCompleto = (whatsapp || '').replace('@s.whatsapp.net', '').replace(/^55/, '');
    
    const payload = {
      Nome: nome,
      Telefones: []
    };

    if (numeroCompleto.length >= 10) {
      payload.Telefones.push({
        Ddd: numeroCompleto.substring(0, 2),
        Numero: numeroCompleto.substring(2),
        TipoId: 3 // Celular
      });
    }

    if (email && email.includes('@')) {
      payload.Email = email;
    }

    if (dataNascimento) {
      // Converte DD/MM/AAAA para YYYY-MM-DD
      const parts = dataNascimento.split('/');
      if (parts.length === 3) {
        payload.DataNascimento = `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
      }
    }

    console.log(`[Trinks] Criando cliente com payload:`, JSON.stringify(payload));

    const { data } = await client.post('/v1/clientes', payload);
    return data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    
    // Se o e-mail já existe, tenta recuperar o cliente em vez de dar erro
    if (detail.includes('E-mail já está sendo usado') && email) {
      console.log(`[Trinks] E-mail já existente. Tentando recuperar cliente por e-mail: ${email}`);
      const existente = await buscarClientePorEmail(email);
      if (existente) {
        console.log(`[Trinks] Cliente recuperado com sucesso: id=${existente.id}`);
        return existente;
      }
    }

    console.error(`[Trinks API Error] Falha ao criar cliente:`, detail);
    throw new Error(detail);
  }
}

// ─── Agendamentos ──────────────────────────────────────────────────────────────

async function listarAgendamentosCliente(clienteId) {
  if (isDemoMode()) {
    return demoAgendamentos.filter(a => a.clienteId === clienteId);
  }

  const client = getClient();
  try {
    const hoje = new Date();
    const dataInicio = hoje.toISOString();
    const dataFim = new Date(hoje.setMonth(hoje.getMonth() + 3)).toISOString();

    const { data } = await client.get('/v1/agendamentos', {
      params: { clienteId, dataInicio, dataFim, pageSize: 20 },
    });

    const items = ensureArray(data);
    return items.map((a) => ({
      id: a.id,
      servico: a.servico?.nome ?? a.servicoNome ?? '',
      profissional: a.profissional?.nome ?? a.profissionalNome ?? '',
      data: a.dataHoraInicio ? a.dataHoraInicio.split('T')[0] : '',
      horario: a.dataHoraInicio ? a.dataHoraInicio.split('T')[1]?.substring(0, 5) : '',
      duracao: a.duracaoEmMinutos ?? 0,
      status: a.status ?? 'confirmado',
    }));
  } catch {
    return [];
  }
}

async function listarDisponibilidade(data) {
  const cacheKey = `disp_${data}`;
  const cached = fromCache(cacheKey, 10 * 60 * 1000); // cache 10 min
  if (cached) return cached;

  if (isDemoMode()) {
    const result = [{
      profissionalId: 1,
      profissionalNome: 'Lucas Rocha',
      horariosDisponiveis: ['09:00','09:30','10:00','10:30','11:00','14:00','14:30','15:00','15:30','16:00'],
      data,
    }];
    toCache(cacheKey, result);
    return result;
  }

  const client = getClient();
  try {
    const { data: resp } = await client.get(`/v1/agendamentos/profissionais/${data}`, {
      params: { pageSize: 100 },
    });

    const items = ensureArray(resp);
    const result = items.map(prof => ({
      profissionalId: prof.id,
      profissionalNome: prof.nome,
      horariosDisponiveis: prof.horariosVagos ?? [],
      data,
    }));
    toCache(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[Trinks] Erro ao buscar disponibilidade (${data}):`, err.response?.data ?? err.message);
    return [];
  }
}

async function criarAgendamento({ clienteId, servicoId, profissionalId, dataHora, duracao, valor, observacoes }) {
  if (isDemoMode()) {
    const id = ++demoAgendamentoIdSeq;
    const [data, horaCompleta] = dataHora.split('T');
    const horario = horaCompleta?.substring(0, 5) || '';
    const servico = DEMO_DATA.servicos.find(s => s.serviceId === servicoId);
    demoAgendamentos.push({ id, clienteId, servicoId, profissionalId, data, horario, duracao, valor, clientePhone: null });
    console.log(`[Demo] Agendamento criado: id=${id} serviço=${servico?.serviceName} ${data} ${horario}`);
    return { id };
  }

  const client = getClient();
  try {
    const payload = {
      ClienteId: clienteId,
      ServicoId: servicoId,
      ProfissionalId: profissionalId || null,
      DataHoraInicio: dataHora,
      DuracaoEmMinutos: duracao ? Number(duracao) : 0,
      Valor: valor ? Number(valor) : 0,
      Confirmado: true,
      Observacoes: observacoes || null,
    };

    console.log(`[Trinks] Criando agendamento com payload:`, JSON.stringify(payload));

    const { data } = await client.post('/v1/agendamentos', payload);
    return data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[Trinks API Error] Falha ao criar agendamento:`, detail);
    throw new Error(detail);
  }
}

async function cancelarAgendamento(agendamentoId) {
  if (isDemoMode()) {
    const idx = demoAgendamentos.findIndex(a => a.id === agendamentoId);
    if (idx !== -1) demoAgendamentos.splice(idx, 1);
    console.log(`[Demo] Agendamento ${agendamentoId} cancelado`);
    return;
  }

  const client = getClient();
  try {
    await client.patch(`/v1/agendamentos/${agendamentoId}/status/cancelado`, {
      Motivo: 'Cancelado pelo cliente via WhatsApp',
      QuemCancelou: 1, // 1 = cliente
    });
    console.log(`[Trinks] Agendamento ${agendamentoId} cancelado com sucesso`);
  } catch (err) {
    const status = err.response?.status;
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[Trinks] Falha ao cancelar agendamento ${agendamentoId} — HTTP ${status}:`, detail);
    throw new Error(`Cancelamento falhou (${status}): ${detail}`);
  }
}

// ─── Contexto completo para o OpenAI ──────────────────────────────────────────

async function buildContext(phone, requestedDate = null) {
  const [servicos, profissionais] = await Promise.all([
    listarServicos(),
    listarProfissionais(),
  ]);

  const cliente = await buscarClientePorTelefone(phone);

  let lead = {
    clienteId: null,
    clienteNome: null,
    clienteWhatsApp: phone.replace('@s.whatsapp.net', ''),
    clienteEmail: null,
    agendamentos: [],
  };

  if (cliente) {
    const agendamentos = await listarAgendamentosCliente(cliente.id);
    lead = {
      clienteId: cliente.id,
      clienteNome: cliente.nome,
      clienteWhatsApp: phone.replace('@s.whatsapp.net', ''),
      clienteEmail: cliente.email ?? null,
      agendamentos,
    };
  }

  // Busca disponibilidade: hoje + amanhã + data solicitada (sequencial para não exceder rate limit)
  const dates = new Set();
  for (let i = 0; i < 2; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    dates.add(d.toISOString().split('T')[0]);
  }
  if (requestedDate) dates.add(requestedDate);

  const disponibilidadeMap = {};
  for (const d of dates) {
    disponibilidadeMap[d] = await listarDisponibilidade(d);
  }

  return {
    isCustomer: !!cliente,
    lead,
    servicos,
    profissionais,
    loja: {
      estabelecimentoId: db.getConfig('trinks_estabelecimento_id'),
      disponibilidade: disponibilidadeMap,
    },
  };
}

module.exports = {
  listarServicos,
  listarProfissionais,
  buscarClientePorTelefone,
  criarCliente,
  listarAgendamentosCliente,
  listarDisponibilidade,
  criarAgendamento,
  cancelarAgendamento,
  buildContext,
};

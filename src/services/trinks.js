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

  const instance = axios.create({
    baseURL,
    headers: {
      'X-Api-Key': apiKey,
      'EstabelecimentoId': estabelecimentoId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    timeout: 30000, // 30s (com retry de 60s entre tentativas)
  });

  // Interceptor: retry automático em 429 (rate limit) — até 3 tentativas
  // Espera 60s entre tentativas (Trinks normalmente libera nesse intervalo)
  instance.interceptors.response.use(undefined, async (err) => {
    const config = err.config || {};
    if (err.response?.status !== 429) throw err;

    config._retryCount = config._retryCount || 0;
    if (config._retryCount >= 3) {
      console.error(`[Trinks] 429 após 3 tentativas — desistindo. URL: ${config.url}`);
      throw err;
    }

    config._retryCount++;
    const espera = 60000; // 60 segundos
    console.warn(`[Trinks] 429 Too Many Requests em ${config.url} — aguardando ${espera/1000}s antes de tentar novamente (${config._retryCount}/3)`);
    await new Promise(r => setTimeout(r, espera));
    return instance.request(config);
  });

  return instance;
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
  let allItems = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const { data } = await client.get('/v1/servicos', {
      params: { pageSize, page, somenteVisiveisCliente: false },
    });

    console.log(`[Trinks] Serviços página ${page}: totalPages=${data.totalPages ?? data.TotalPages ?? '?'} totalItems=${data.totalCount ?? data.TotalCount ?? '?'}`);

    const items = ensureArray(data);
    allItems = allItems.concat(items);

    const totalPages = data.totalPages ?? data.TotalPages ?? 1;
    if (page >= totalPages || items.length === 0) break;
    page++;
  }

  const servicos = allItems.map((s) => ({
    serviceId: s.id,
    serviceName: s.nome,
    serviceDescription: s.descricao ?? s.observacao ?? '',
    servicePrice: s.valor ?? s.preco ?? 0,
    serviceDuracao: s.duracaoEmMinutos ? `${s.duracaoEmMinutos} minutos` : '60 minutos',
    duracaoMinutos: s.duracaoEmMinutos ?? 60,
    categoriaId: s.categoriaId ?? null,
    categoria: s.categoria?.nome ?? '',
  }));

  console.log(`[Trinks] Total de serviços carregados: ${servicos.length}`);
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

async function criarCliente({ nome, cpf, email, whatsapp, dataNascimento }) {
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

    if (cpf) {
      payload.Cpf = cpf.replace(/\D/g, ''); // somente dígitos
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
  // SEM CACHE — disponibilidade é sempre consultada em tempo real no Trinks
  // para evitar oferecer horários já ocupados (especialmente quando o salão
  // marca agendamentos manualmente no painel do Trinks)

  if (isDemoMode()) {
    return [{
      profissionalId: 1,
      profissionalNome: 'Lucas Rocha',
      horariosDisponiveis: ['09:00','09:30','10:00','10:30','11:00','14:00','14:30','15:00','15:30','16:00'],
      data,
    }];
  }

  const client = getClient();
  try {
    const { data: resp } = await client.get(`/v1/agendamentos/profissionais/${data}`, {
      params: { pageSize: 100 },
    });

    const items = ensureArray(resp);
    return items.map(prof => ({
      profissionalId: prof.id,
      profissionalNome: prof.nome,
      horariosDisponiveis: prof.horariosVagos ?? [],
      data,
    }));
  } catch (err) {
    console.error(`[Trinks] Erro ao buscar disponibilidade (${data}):`, err.response?.data ?? err.message);
    return [];
  }
}

/**
 * Verifica em tempo real se um slot está livre para o profissional.
 * Checa todos os blocos de 30 min dentro da duração contra horariosVagos do Trinks.
 * Retorna { livre: true } ou { livre: false, motivo: '...' }
 */
async function verificarSlotLivre({ profissionalId, dataHora, duracao }) {
  if (isDemoMode()) return { livre: true };

  try {
    const data = dataHora.split('T')[0];
    const horaInicio = dataHora.split('T')[1].substring(0, 5);
    const [hh, mm] = horaInicio.split(':').map(Number);
    const inicioMin = hh * 60 + mm;
    const fimMin = inicioMin + Number(duracao || 30);

    const client = getClient();
    const { data: resp } = await client.get(`/v1/agendamentos/profissionais/${data}`, {
      params: { pageSize: 100 },
    });
    const items = ensureArray(resp);
    const prof = items.find(p => String(p.id) === String(profissionalId));
    if (!prof) return { livre: false, motivo: 'profissional não encontrado' };

    const vagos = new Set((prof.horariosVagos ?? []).map(h => {
      const [a, b] = h.split(':').map(Number);
      return a * 60 + b;
    }));

    // Todos os blocos de 30 min dentro da duração precisam estar vagos
    for (let t = inicioMin; t < fimMin; t += 30) {
      if (!vagos.has(t)) {
        return { livre: false, motivo: `bloco ${Math.floor(t/60)}:${String(t%60).padStart(2,'0')} ocupado` };
      }
    }
    return { livre: true };
  } catch (err) {
    console.error('[Trinks] Erro ao verificar slot livre:', err.message);
    // Em caso de erro na verificação, deixa passar (o Trinks vai rejeitar se houver conflito)
    return { livre: true };
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
      Confirmado: false, // aguardando confirmação do salão — cliente vê como criado normalmente
      Observacoes: observacoes || null,
    };

    console.log(`[Trinks] Criando agendamento com payload:`, JSON.stringify(payload));

    const { data } = await client.post('/v1/agendamentos', payload);

    // Invalida o cache de disponibilidade da data do agendamento
    // para que a próxima consulta reflita o horário já ocupado
    const dataStr = dataHora.split('T')[0];
    cache.delete(`disp_${dataStr}`);
    console.log(`[Trinks] Cache de disponibilidade invalidado para ${dataStr}`);

    return data;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[Trinks API Error] Falha ao criar agendamento:`, detail);

    // Sinaliza conflito de horário para o webhook tratar com mensagem amigável
    const isConflito =
      detail.toLowerCase().includes('conflict') ||
      detail.toLowerCase().includes('horário') ||
      detail.toLowerCase().includes('indisponível') ||
      detail.toLowerCase().includes('ocupado') ||
      err.response?.status === 409;

    const error = new Error(detail);
    if (isConflito) error.isConflito = true;
    throw error;
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

async function listarAgendamentosPorData(data) {
  if (isDemoMode()) {
    return demoAgendamentos
      .filter(a => a.data === data)
      .map(a => ({
        id: a.id,
        servico: DEMO_DATA.servicos.find(s => s.serviceId === a.servicoId)?.serviceName ?? '',
        profissional: 'Lucas Rocha',
        data: a.data,
        horario: a.horario,
        duracao: a.duracao,
        status: 'aguardando',
        clienteId: a.clienteId,
        clienteNome: null,
        clienteWhatsApp: a.clientePhone,
      }));
  }

  const client = getClient();
  try {
    const dataInicio = `${data}T00:00:00`;
    const dataFim    = `${data}T23:59:59`;
    const { data: resp } = await client.get('/v1/agendamentos', {
      params: { dataInicio, dataFim, pageSize: 100 },
    });
    const items = ensureArray(resp);

    // Status que indicam agendamento NÃO ativo — não devem receber confirmação
    const STATUS_INATIVO = new Set([
      'cancelado', 'cancelled', 'canceled',
      'faltou', 'faltou_automatico', 'no_show',
      'finalizado', 'concluido', 'concluído',
    ]);

    // Mapear agendamentos básicos — filtra quem já não é mais ativo
    const agendamentos = items
      .map(a => ({
        id: a.id,
        servico: a.servico?.nome ?? a.servicoNome ?? '',
        profissional: a.profissional?.nome ?? a.profissionalNome ?? '',
        data: a.dataHoraInicio ? a.dataHoraInicio.split('T')[0] : '',
        horario: a.dataHoraInicio ? a.dataHoraInicio.split('T')[1]?.substring(0, 5) : '',
        duracao: a.duracaoEmMinutos ?? 0,
        status: (a.status?.nome ?? a.statusNome ?? a.status ?? 'aguardando').toString().toLowerCase(),
        clienteId: a.cliente?.id ?? a.clienteId ?? null,
        clienteNome: a.cliente?.nome ?? a.clienteNome ?? null,
        clienteWhatsApp: a.cliente?.whatsapp ?? a.cliente?.telefone ?? a.clienteWhatsApp ?? null,
      }))
      .filter(a => {
        if (STATUS_INATIVO.has(a.status)) {
          console.log(`[Trinks] Pulando ag id=${a.id} (status=${a.status}) — não receberá confirmação`);
          return false;
        }
        return true;
      });

    // Buscar WhatsApp dos clientes que não vieram com o campo preenchido
    const semWpp = agendamentos.filter(a => !a.clienteWhatsApp && a.clienteId);
    const idsUnicos = [...new Set(semWpp.map(a => a.clienteId))];

    if (idsUnicos.length > 0) {
      const detalheMap = {};
      await Promise.all(idsUnicos.map(async (id) => {
        try {
          const { data: cliente } = await client.get(`/v1/clientes/${id}`);
          detalheMap[id] = cliente?.whatsapp ?? cliente?.telefone ?? null;
        } catch { /* silencioso */ }
      }));

      for (const ag of agendamentos) {
        if (!ag.clienteWhatsApp && detalheMap[ag.clienteId]) {
          ag.clienteWhatsApp = detalheMap[ag.clienteId];
        }
      }
    }

    return agendamentos;
  } catch (err) {
    console.error('[Trinks] Erro ao listar agendamentos por data:', err.message);
    return [];
  }
}

async function confirmarAgendamento(agendamentoId) {
  if (isDemoMode()) {
    console.log(`[Demo] Agendamento ${agendamentoId} confirmado`);
    return;
  }
  const client = getClient();
  try {
    await client.patch(`/v1/agendamentos/${agendamentoId}/status/confirmado`);
    console.log(`[Trinks] Agendamento ${agendamentoId} confirmado`);
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[Trinks] Falha ao confirmar agendamento ${agendamentoId}:`, detail);
    throw new Error(detail);
  }
}

async function marcarFaltou(agendamentoId) {
  if (isDemoMode()) {
    console.log(`[Demo] Agendamento ${agendamentoId} marcado como faltou`);
    return;
  }
  const client = getClient();
  try {
    await client.patch(`/v1/agendamentos/${agendamentoId}/status/faltou`);
    console.log(`[Trinks] Agendamento ${agendamentoId} marcado como faltou`);
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[Trinks] Falha ao marcar faltou ${agendamentoId}:`, detail);
    throw new Error(detail);
  }
}

async function buscarAniversariantesHoje() {
  const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const dia = String(hoje.getDate()).padStart(2, '0');
  const mes = String(hoje.getMonth() + 1).padStart(2, '0');

  if (isDemoMode()) return [];

  const client = getClient();
  try {
    const { data } = await client.get('/v1/clientes', {
      params: { diaNascimento: dia, mesNascimento: mes, pageSize: 100 },
    });
    const items = ensureArray(data);
    return items
      .filter(c => c.whatsapp || c.telefone)
      .map(c => ({
        id: c.id,
        nome: c.nome,
        whatsapp: c.whatsapp ?? c.telefone ?? null,
        email: c.email ?? null,
      }));
  } catch (err) {
    console.error('[Trinks] Erro ao buscar aniversariantes:', err.message);
    return [];
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
    // Normalizar data de nascimento para DD/MM
    let dataNascimento = null;
    const rawNasc = cliente.dataNascimento ?? cliente.data_nascimento ?? null;
    if (rawNasc) {
      const d = new Date(rawNasc);
      if (!isNaN(d)) {
        dataNascimento = `${String(d.getUTCDate()).padStart(2,'0')}/${String(d.getUTCMonth()+1).padStart(2,'0')}`;
      }
    }
    lead = {
      clienteId: cliente.id,
      clienteNome: cliente.nome,
      clienteWhatsApp: phone.replace('@s.whatsapp.net', ''),
      clienteEmail: cliente.email ?? null,
      dataNascimento,
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

  // Data e hora atual no fuso de Brasília
  const nowBrasilia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const todayStr = nowBrasilia.toISOString().split('T')[0];
  const currentTime = nowBrasilia.getHours() * 60 + nowBrasilia.getMinutes(); // minutos desde meia-noite

  const disponibilidadeMap = {};
  for (const d of dates) {
    const slots = await listarDisponibilidade(d);
    // Para o dia de hoje, remover horários que já passaram
    if (d === todayStr) {
      disponibilidadeMap[d] = slots.map(prof => ({
        ...prof,
        horariosDisponiveis: prof.horariosDisponiveis.filter(h => {
          const [hh, mm] = h.split(':').map(Number);
          return (hh * 60 + mm) > currentTime;
        }),
      }));
    } else {
      disponibilidadeMap[d] = slots;
    }
  }

  // Horário de fechamento configurável (padrão 18:00)
  const horarioFechamento = db.getConfig('horario_fechamento') || '18:00';

  // Para cada data e cada serviço, pré-calcular os slots válidos (consecutivos + fechamento)
  // Isso evita que o modelo liste horários que conflitam com outros agendamentos
  // Também filtra horários quebrados (só horas cheias HH:00) — REGRA DE NEGÓCIO
  const disponibilidadeMapFiltrado = {};
  for (const [data, profSlots] of Object.entries(disponibilidadeMap)) {
    disponibilidadeMapFiltrado[data] = profSlots.map(prof => {
      const slotsPorServico = {};
      for (const servico of servicos) {
        const dur = servico.duracaoMinutos || 60;
        const validos = filtrarSlotsPorDuracao(prof.horariosDisponiveis, dur, horarioFechamento);
        // FILTRO ADICIONAL: apenas horas cheias (08:00, 09:00, 10:00...)
        slotsPorServico[servico.serviceId] = validos.filter(h => h.endsWith(':00'));
      }
      return {
        profissionalId: prof.profissionalId,
        profissionalNome: prof.profissionalNome,
        data: prof.data,
        // NÃO incluímos mais horariosDisponiveis para evitar que a IA pegue
        // horários quebrados por engano. Apenas os slots já filtrados por serviço.
        horariosValidosPorServico: slotsPorServico,
      };
    });
  }

  return {
    isCustomer: !!cliente,
    lead,
    servicos,
    profissionais,
    loja: {
      estabelecimentoId: db.getConfig('trinks_estabelecimento_id'),
      horarioFechamento,
      disponibilidade: disponibilidadeMapFiltrado,
    },
  };
}

/**
 * Dado um array de slots vagos ("HH:MM") e a duração necessária em minutos,
 * retorna apenas os slots de início onde:
 * 1. Todos os blocos de 30 min dentro da duração também estão livres (sem conflito com outros clientes)
 * 2. O serviço termina até o horário de fechamento
 *
 * Exemplo: progressiva 90 min, slots vagos: [08:00, 08:30, 09:30, 10:00, 10:30]
 * → 08:00: precisa 08:00 ✅ + 08:30 ✅ + 09:00 ❌ (não está na lista) → inválido
 * → 09:30: precisa 09:30 ✅ + 10:00 ✅ + 10:30 ✅ → válido
 */
function filtrarSlotsPorDuracao(slots, duracaoTotalMinutos, horarioFechamento = '18:00') {
  const [fhh, fmm] = horarioFechamento.split(':').map(Number);
  const fechamento = fhh * 60 + fmm;

  // Conjunto de minutos disponíveis para lookup rápido
  const slotsEmMinutos = new Set(
    slots.map(h => {
      const [hh, mm] = h.split(':').map(Number);
      return hh * 60 + mm;
    })
  );

  // Granularidade dos slots do Trinks (30 min)
  const GRANULARIDADE = 30;

  return slots.filter(h => {
    const [hh, mm] = h.split(':').map(Number);
    const inicioMin = hh * 60 + mm;
    const fimMin = inicioMin + duracaoTotalMinutos;

    // 1. Não pode ultrapassar o fechamento
    if (fimMin > fechamento) return false;

    // 2. Todos os blocos intermediários precisam estar vagos
    for (let t = inicioMin; t < fimMin; t += GRANULARIDADE) {
      if (!slotsEmMinutos.has(t)) return false;
    }

    return true;
  });
}

module.exports = {
  listarServicos,
  listarProfissionais,
  buscarClientePorTelefone,
  criarCliente,
  listarAgendamentosCliente,
  listarAgendamentosPorData,
  confirmarAgendamento,
  marcarFaltou,
  buscarAniversariantesHoje,
  listarDisponibilidade,
  filtrarSlotsPorDuracao,
  verificarSlotLivre,
  criarAgendamento,
  cancelarAgendamento,
  buildContext,
};

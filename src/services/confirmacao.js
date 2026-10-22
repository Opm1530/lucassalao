/**
 * Serviço de confirmação de agendamentos.
 * Dispara mensagens via WhatsApp para clientes com agendamentos pendentes
 * e processa as respostas (confirmar no Trinks ou marcar como faltou).
 *
 * Regras de timing:
 * - Horários normais → disparo "antecedencia_disparo_horas" h antes, no MESMO dia (padrão 2h).
 * - Horários cedo (onde isso cairia antes das 08:00) → disparo na VÉSPERA às "hora_disparo_confirmacao" (padrão 18:00).
 * - Prazo para confirmar (marca faltou automático) → o próprio horário do agendamento.
 */

const db = require('../db/database');
const trinksService = require('./trinks');
const evolutionService = require('./evolution');

/**
 * Normaliza um número para o JID do WhatsApp: 55<DDD><numero>@s.whatsapp.net
 * Aceita variações como:
 *   - "11999998888"           → "5511999998888@s.whatsapp.net"
 *   - "1199999-8888"          → "5511999998888@s.whatsapp.net"
 *   - "+55 (11) 99999-8888"   → "5511999998888@s.whatsapp.net"
 *   - "5511999998888"         → "5511999998888@s.whatsapp.net"
 *   - já formatado JID        → retorna como está
 */
function normalizarPhoneJid(raw) {
  if (!raw) return null;
  if (String(raw).includes('@')) return raw; // já é JID

  let phone = String(raw).replace(/\D/g, '');

  // Se começa com 0 (chamada nacional antiga), remove
  if (phone.startsWith('0')) phone = phone.replace(/^0+/, '');

  // Se não tem 55 (DDI Brasil), adiciona
  if (!phone.startsWith('55')) {
    phone = '55' + phone;
  } else if (phone.length < 12) {
    // Começa com 55 mas é curto (provavelmente 55 é parte do DDD invertido)
    phone = '55' + phone.substring(2);
  }

  // Garantia mínima: 12 dígitos (55 + 2 DDD + 8 número) ou 13 (com 9 do celular)
  if (phone.length < 12 || phone.length > 13) {
    console.warn(`[Confirmação] Número com tamanho suspeito: ${raw} → ${phone}`);
  }

  return `${phone}@s.whatsapp.net`;
}

/**
 * TRAVA DE MODO TESTE para disparos de saída.
 * Quando test_mode_active=true, o bot SÓ pode enviar mensagens para o número de teste.
 * Isso impede que o job de confirmação vaze mensagens para clientes reais durante testes.
 * Retorna true se pode enviar para esse número, false se deve bloquear.
 */
function podeEnviarNoModoTeste(phoneRaw) {
  if (db.getConfig('test_mode_active') !== 'true') return true; // modo teste desligado → libera geral

  const testPhone = (db.getConfig('test_mode_phone') || '').replace(/\D/g, '');
  if (!testPhone) return false; // modo teste ligado mas sem número → bloqueia tudo por segurança

  const alvo = String(phoneRaw || '').replace(/\D/g, '');
  // Compara os últimos 8 dígitos (ignora DDI, DDD e o "9" extra do celular)
  const match = alvo.slice(-8) === testPhone.slice(-8);
  if (!match) {
    console.log(`[Confirmação] MODO TESTE ativo — disparo BLOQUEADO para ${alvo} (só o número de teste ${testPhone} recebe)`);
  }
  return match;
}

const MENSAGEM_CONFIRMACAO = (nome, servico, data, horario) => {
  const [ano, mes, dia] = data.split('-');
  const dataFormatada = `${dia}/${mes}/${ano}`;
  const primeiroNome = nome ? nome.split(' ')[0] : null;
  return `Oiê${primeiroNome ? ', ' + primeiroNome : ''}! 😊 Aqui é a Laís, secretária do Studio Lucas Rocha. ✂️\n\nDia ${dataFormatada}, às ${horario}, você tem um encontro marcado com o Lucas para ${servico}! 🌟\n\nPodemos confirmar seu agendamento? Responda *SIM* para confirmar ou *NÃO* caso precise cancelar. 💬`;
};

// Piso da manhã: não disparamos antes disso (acordaria a cliente de madrugada).
const PISO_MANHA_MIN = 8 * 60; // 08:00

/**
 * Calcula o momento em que a confirmação deve ser disparada.
 *
 * REGRA:
 * - Padrão: dispara "antecedencia_disparo_horas" horas ANTES do agendamento, no MESMO dia
 *   (configurável, padrão 2h). Ex: agendamento 14:00 → dispara 12:00.
 * - Exceção (horários cedo): se "X horas antes" cair antes das 08:00 (madrugada), dispara na
 *   VÉSPERA no horário de "hora_disparo_confirmacao" (padrão 18:00). Ex: agendamento 08:00 → véspera 18:00.
 */
function calcularMomentoDisparo(dataAgendamento, horario) {
  const [hh, mm] = horario.split(':').map(Number);
  const [ano, mes, dia] = dataAgendamento.split('-').map(Number);

  const antecedenciaH = parseInt(db.getConfig('antecedencia_disparo_horas') || '2', 10);
  const inicioMin = hh * 60 + mm;
  const disparoMin = inicioMin - antecedenciaH * 60;

  if (disparoMin >= PISO_MANHA_MIN) {
    // Mesmo dia, X horas antes
    return new Date(ano, mes - 1, dia, Math.floor(disparoMin / 60), disparoMin % 60, 0);
  }
  // Cedo demais → véspera no horário configurado (padrão 18:00)
  const horaVespera = parseInt(db.getConfig('hora_disparo_confirmacao') || '18', 10);
  const d = new Date(ano, mes - 1, dia, horaVespera, 0, 0);
  d.setDate(d.getDate() - 1);
  return d;
}

/**
 * Prazo limite para a cliente confirmar (usado para marcar faltou automático).
 * É o HORÁRIO DO AGENDAMENTO: se não confirmou até a hora marcada, marca faltou.
 * Assim a cliente tem desde o disparo até o horário para responder.
 */
function calcularPrazoConfirmacao(dataAgendamento, horario) {
  const [hh, mm] = horario.split(':').map(Number);
  const [ano, mes, dia] = dataAgendamento.split('-').map(Number);
  return new Date(ano, mes - 1, dia, hh, mm, 0); // o próprio horário do agendamento
}

function deveDisparar(dataAgendamento, horario, agora) {
  return agora >= calcularMomentoDisparo(dataAgendamento, horario);
}

function prazoExpirou(dataAgendamento, horario, agora) {
  return agora >= calcularPrazoConfirmacao(dataAgendamento, horario);
}

/**
 * Job principal — chamado a cada 30 minutos.
 * 1. Dispara confirmações no momento certo
 * 2. Marca como faltou quem não confirmou até o prazo
 */
async function verificarEDisparar() {
  if (db.getConfig('confirmacao_automatica') !== 'true') {
    console.log('[Confirmação] Job desativado — pulando verificação');
    return [];
  }
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const resultados = [];

  // Verificar agendamentos de hoje e amanhã
  for (let offset = 0; offset <= 1; offset++) {
    const dataAlvo = new Date(agora);
    dataAlvo.setDate(dataAlvo.getDate() + offset);
    const dataStr = dataAlvo.toISOString().split('T')[0];

    const agendamentos = await trinksService.listarAgendamentosPorData(dataStr);

    for (const ag of agendamentos) {
      if (!ag.clienteWhatsApp) continue;

      const jaEnviou = await db.jaEnviouDisparo(ag.id);

      // ── Disparar confirmação ──────────────────────────────────────────
      if (!jaEnviou && deveDisparar(ag.data, ag.horario, agora)) {
        const phoneJid = normalizarPhoneJid(ag.clienteWhatsApp);
        if (!phoneJid) {
          console.warn(`[Confirmação] Pulando ${ag.clienteNome} — número inválido: ${ag.clienteWhatsApp}`);
          continue;
        }
        // TRAVA DE MODO TESTE: não vaza confirmação para clientes reais durante testes
        if (!podeEnviarNoModoTeste(phoneJid)) continue;
        const mensagem = MENSAGEM_CONFIRMACAO(ag.clienteNome, ag.servico, ag.data, ag.horario);

        try {
          await evolutionService.sendText(phoneJid, mensagem);
          await db.registrarDisparo({
            agendamentoId: ag.id,
            phone: phoneJid,
            clienteNome: ag.clienteNome,
            servico: ag.servico,
            dataAgendamento: ag.data,
            horario: ag.horario,
          });
          resultados.push({ id: ag.id, status: 'enviado', clienteNome: ag.clienteNome });
          console.log(`[Confirmação] Disparo → ${ag.clienteNome} | ${ag.data} ${ag.horario}`);
        } catch (err) {
          resultados.push({ id: ag.id, status: 'erro', clienteNome: ag.clienteNome, erro: err.message });
          console.error(`[Confirmação] Erro ao enviar para ${ag.clienteNome}:`, err.message);
        }
      }

      // ── Marcar como faltou se prazo expirou sem confirmação (todos os horários) ──
      if (jaEnviou && prazoExpirou(ag.data, ag.horario, agora)) {
        const phoneJidVerif = normalizarPhoneJid(ag.clienteWhatsApp);
        const disparo = phoneJidVerif ? await db.getDisparoByPhone(phoneJidVerif) : null;
        if (disparo && disparo.status === 'enviado') {
          try {
            await trinksService.marcarFaltou(ag.id);
            await db.atualizarStatusDisparo(ag.id, 'faltou_automatico');
            resultados.push({ id: ag.id, status: 'faltou_automatico', clienteNome: ag.clienteNome });
            console.log(`[Confirmação] Faltou automático → ${ag.clienteNome} | ${ag.data} ${ag.horario}`);
          } catch (err) {
            console.error(`[Confirmação] Erro ao marcar faltou para ${ag.clienteNome}:`, err.message);
          }
        }
      }
    }
  }

  return resultados;
}

/**
 * Confirma automaticamente no ato do agendamento.
 * Usado quando cliente agenda após 18:00 para horários de 08:00 ou 09:00.
 */
async function confirmarAutomaticamente(agendamentoId, phone, clienteNome, servico, dataAgendamento, horario) {
  const [hh] = horario.split(':').map(Number);
  if (hh >= 10) return; // só para 08:00 e 09:00

  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  if (agora.getHours() < 18) return; // só após 18:00

  try {
    await trinksService.confirmarAgendamento(agendamentoId);
    await db.registrarDisparo({ agendamentoId, phone, clienteNome, servico, dataAgendamento, horario });
    await db.atualizarStatusDisparo(agendamentoId, 'confirmado_automatico');
    console.log(`[Confirmação] Auto-confirmado → ${clienteNome} | ${dataAgendamento} ${horario}`);
  } catch (err) {
    console.error(`[Confirmação] Erro ao auto-confirmar ${agendamentoId}:`, err.message);
  }
}

/**
 * Disparo manual para uma data específica — ignora regras de timing,
 * envia imediatamente para todos os agendamentos ainda não disparados.
 */
async function dispararConfirmacoes(dataAgendamento, ids = null) {
  const todos = await trinksService.listarAgendamentosPorData(dataAgendamento);
  // Se ids fornecidos, filtrar apenas os selecionados
  const agendamentos = ids ? todos.filter(a => ids.map(String).includes(String(a.id))) : todos;
  const resultados = [];

  for (const ag of agendamentos) {
    if (!ag.clienteWhatsApp) {
      resultados.push({ id: ag.id, status: 'sem_whatsapp', clienteNome: ag.clienteNome });
      continue;
    }
    if (await db.jaEnviouDisparo(ag.id)) {
      resultados.push({ id: ag.id, status: 'ja_enviado', clienteNome: ag.clienteNome });
      continue;
    }

    const phoneJid = normalizarPhoneJid(ag.clienteWhatsApp);
    if (!phoneJid) {
      resultados.push({ id: ag.id, status: 'sem_whatsapp', clienteNome: ag.clienteNome });
      continue;
    }
    // TRAVA DE MODO TESTE: bloqueia disparo manual para números que não são o de teste
    if (!podeEnviarNoModoTeste(phoneJid)) {
      resultados.push({ id: ag.id, status: 'bloqueado_modo_teste', clienteNome: ag.clienteNome });
      continue;
    }
    const mensagem = MENSAGEM_CONFIRMACAO(ag.clienteNome, ag.servico, ag.data, ag.horario);

    try {
      await evolutionService.sendText(phoneJid, mensagem);
      await db.registrarDisparo({
        agendamentoId: ag.id,
        phone: phoneJid,
        clienteNome: ag.clienteNome,
        servico: ag.servico,
        dataAgendamento: ag.data,
        horario: ag.horario,
      });
      resultados.push({ id: ag.id, status: 'enviado', clienteNome: ag.clienteNome, phone: phoneJid });
      console.log(`[Confirmação] Disparo manual → ${ag.clienteNome} (${phoneJid})`);
    } catch (err) {
      resultados.push({ id: ag.id, status: 'erro', clienteNome: ag.clienteNome, erro: err.message });
      console.error(`[Confirmação] Erro ao enviar para ${ag.clienteNome}:`, err.message);
    }
  }

  return resultados;
}

/**
 * Processa a resposta de uma cliente a uma mensagem de confirmação.
 * Chamado pelo webhook quando chega mensagem de um número que tem disparo pendente.
 * Retorna true se a mensagem foi tratada como resposta de confirmação.
 */
async function processarResposta(phone, texto) {
  const disparo = await db.getDisparoByPhone(phone);
  if (!disparo) return false;

  const resposta = texto.trim().toUpperCase();
  const confirmou = ['SIM', 'S', 'CONFIRMO', 'CONFIRMAR', 'OK', 'PODE', 'VOU', 'ESTAREI'].some(p => resposta.includes(p));
  const cancelou = ['NÃO', 'NAO', 'N', 'CANCELA', 'CANCELAR', 'NÃO VOU', 'NAO VOU'].some(p => resposta.includes(p));

  if (confirmou) {
    try {
      await trinksService.confirmarAgendamento(disparo.agendamento_id);
      await db.atualizarStatusDisparo(disparo.agendamento_id, 'confirmado');
      await evolutionService.sendText(phone,
        `Perfeito${disparo.cliente_nome ? ', ' + disparo.cliente_nome.split(' ')[0] : ''}! Seu horário está confirmado. Te esperamos no dia ${disparo.horario}. 😊`
      );
      console.log(`[Confirmação] Agendamento ${disparo.agendamento_id} confirmado por ${phone}`);
    } catch (err) {
      console.error(`[Confirmação] Erro ao confirmar no Trinks:`, err.message);
      await evolutionService.sendText(phone, 'Recebemos sua confirmação! Até lá. 😊');
    }
    return true;
  }

  if (cancelou) {
    try {
      await trinksService.marcarFaltou(disparo.agendamento_id);
      await db.atualizarStatusDisparo(disparo.agendamento_id, 'faltou');
      await evolutionService.sendText(phone,
        `Tudo bem! Registramos sua ausência. Quando quiser remarcar, é só falar com a gente. 😊`
      );
      console.log(`[Confirmação] Agendamento ${disparo.agendamento_id} marcado como faltou por ${phone}`);
    } catch (err) {
      console.error(`[Confirmação] Erro ao marcar faltou no Trinks:`, err.message);
      await evolutionService.sendText(phone, 'Entendido! Caso queira remarcar, estamos à disposição. 😊');
    }
    return true;
  }

  // Resposta ambígua — passa para o fluxo normal do bot
  return false;
}

module.exports = { dispararConfirmacoes, verificarEDisparar, confirmarAutomaticamente, processarResposta, podeEnviarNoModoTeste };

/**
 * Serviço de mensagens de aniversário.
 * Dispara automaticamente todo dia às 09:00 para clientes
 * que fazem aniversário no dia.
 */

const db = require('../db/database');
const trinksService = require('./trinks');
const evolutionService = require('./evolution');

const MENSAGEM_ANIVERSARIO = (nome) => {
  const primeiroNome = nome ? nome.split(' ')[0] : null;
  return `Oiê${primeiroNome ? ', ' + primeiroNome : ''}! 🎉🎂\n\nHoje é um dia muito especial — o seu dia! Toda a equipe do Studio Lucas Rocha deseja a você um feliz aniversário cheio de alegria, saúde e momentos incríveis! 🥳✨\n\nQue tal se presentear com um dia de cuidados? Estamos aqui para deixar você ainda mais linda nessa data tão especial! 😊💇‍♀️\n\nUm beijo da Laís e de todo o time! 🌸`;
};

async function dispararAniversarios() {
  if (db.getConfig('aniversario_ativo') !== 'true') return [];

  const aniversariantes = await trinksService.buscarAniversariantesHoje();
  const resultados = [];

  for (const cliente of aniversariantes) {
    const phone = String(cliente.whatsapp || '').replace(/\D/g, '');
    if (!phone) continue;

    const phoneJid = `${phone}@s.whatsapp.net`;

    if (await db.jaEnviouAniversarioHoje(cliente.id)) continue;

    try {
      await evolutionService.sendText(phoneJid, MENSAGEM_ANIVERSARIO(cliente.nome));
      await db.registrarAniversario(cliente.id, phoneJid, cliente.nome);
      resultados.push({ id: cliente.id, nome: cliente.nome, status: 'enviado' });
      console.log(`[Aniversário] Mensagem enviada → ${cliente.nome}`);
    } catch (err) {
      resultados.push({ id: cliente.id, nome: cliente.nome, status: 'erro', erro: err.message });
      console.error(`[Aniversário] Erro ao enviar para ${cliente.nome}:`, err.message);
    }
  }

  return resultados;
}

module.exports = { dispararAniversarios };

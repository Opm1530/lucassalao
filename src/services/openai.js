const OpenAI = require('openai');
const db = require('../db/database');
const { SYSTEM_PROMPT, buildContextMessage } = require('../utils/prompt');

function getClient() {
  const apiKey = db.getConfig('openai_api_key');
  if (!apiKey) throw new Error('OpenAI API Key não configurada. Configure no dashboard.');
  return new OpenAI({ apiKey });
}

async function chat(history, context) {
  const client = getClient();
  const model = db.getConfig('openai_model') || 'gpt-4o';

  // Use prompt saved in DB (editable via dashboard), fallback to hardcoded default
  const systemPrompt = db.getConfig('system_prompt') || SYSTEM_PROMPT;

  // Build messages array: system + context injection + conversation history
  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Sao_Paulo' });
  const contextMessage = buildContextMessage(context, dateStr);

  const messages = [
    { role: 'system', content: systemPrompt },
    // Inject context as first user turn so the AI can reference it
    {
      role: 'user',
      content: contextMessage,
    },
    {
      role: 'assistant',
      content: '{"mensagens":[],"novoStage":"novo","intencao":"outro","acao":"nenhuma","agendamento":[],"agendamento_cancelar":null,"cliente":null,"lojaSelecionada":null,"encaminharHumano":false}',
    },
    ...history,
  ];

  const response = await client.chat.completions.create({
    model,
    messages,
    response_format: { type: 'json_object' },
    temperature: 0.3,
    max_tokens: 1500,
  });

  const raw = response.choices[0].message.content;

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI retornou JSON inválido: ${raw}`);
  }
}

module.exports = { chat };

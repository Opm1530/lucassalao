const OpenAI = require('openai');
const db = require('../db/database');
const { SYSTEM_PROMPT, buildContextMessage } = require('../utils/prompt');

function getClient() {
  const apiKey = db.getConfig('openai_api_key');
  if (!apiKey) throw new Error('OpenAI API Key não configurada. Configure no dashboard.');
  return new OpenAI({ apiKey });
}

async function chat(history, context) {
  // VERIFICAÇÃO DE LIMITE DIÁRIO ANTES DE QUALQUER COISA
  const limite = parseInt(db.getConfig('openai_daily_token_limit') || '0', 10);
  if (limite > 0) {
    const uso = await db.getUsoTokenHoje();
    if (uso.total >= limite) {
      console.warn(`[OpenAI] LIMITE DIÁRIO ATINGIDO — ${uso.total}/${limite} tokens (${uso.requests} requests, ~$${uso.custo_usd.toFixed(2)})`);
      const err = new Error(`Limite diário de tokens atingido (${uso.total}/${limite})`);
      err.limiteAtingido = true;
      throw err;
    }
  }

  const client = getClient();
  const model = db.getConfig('openai_model') || 'gpt-4o-mini';

  // Use prompt saved in DB (editable via dashboard), fallback to hardcoded default
  const systemPrompt = db.getConfig('system_prompt') || SYSTEM_PROMPT;

  // Build messages array: system + context injection + conversation history
  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Sao_Paulo' });
  const contextMessage = buildContextMessage(context, dateStr);

  // Formata cada mensagem do histórico com prefixo de tempo legível para a IA
  // Ex: [hoje 14:32] / [ontem 19:00] / [3 dias atrás 10:00]
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const hojeStr = agora.toISOString().split('T')[0];
  const ontem = new Date(agora); ontem.setDate(ontem.getDate() - 1);
  const ontemStr = ontem.toISOString().split('T')[0];

  function formatarPrefixo(ts) {
    if (!ts) return '';
    const d = new Date(new Date(ts).toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const dStr = d.toISOString().split('T')[0];
    const dia = String(d.getDate()).padStart(2, '0');
    const mes = String(d.getMonth() + 1).padStart(2, '0');
    const ano = d.getFullYear();
    const dataBR = `${dia}/${mes}/${ano}`;
    const hora = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    if (dStr === hojeStr) return `[hoje ${dataBR} ${hora}] `;
    if (dStr === ontemStr) return `[ontem ${dataBR} ${hora}] `;
    const diffDias = Math.floor((agora - d) / (1000 * 60 * 60 * 24));
    if (diffDias < 7) return `[${diffDias} dias atrás ${dataBR} ${hora}] `;
    return `[${dataBR} ${hora}] `;
  }

  const historyComTempo = history.map(m => {
    const prefixo = formatarPrefixo(m.ts);
    // Para assistant, content é JSON — não prefixar (atrapalha o parse de exemplo)
    if (m.role === 'assistant') return { role: m.role, content: m.content };
    return { role: m.role, content: prefixo + m.content };
  });

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
    ...historyComTempo,
  ];

  // Retry com backoff para erros 429 (quota excedida) e 5xx (erro servidor)
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [5000, 15000, 30000]; // 5s, 15s, 30s

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages,
        response_format: { type: 'json_object' },
        temperature: 0.3,
        max_tokens: 1500,
      });

      // Log de uso de tokens — útil para auditar custos
      const usage = response.usage || {};
      const inputT = usage.prompt_tokens || 0;
      const outputT = usage.completion_tokens || 0;
      // Custo aproximado em USD
      // gpt-4o:      $2.50/1M in, $10.00/1M out
      // gpt-4o-mini: $0.15/1M in, $0.60/1M out
      const isMini = model.includes('mini');
      const inPrice = isMini ? 0.15 : 2.5;
      const outPrice = isMini ? 0.60 : 10;
      const custoUSD = (inputT * inPrice / 1_000_000) + (outputT * outPrice / 1_000_000);
      console.log(`[OpenAI] model=${model} | in=${inputT} out=${outputT} tokens | ~$${custoUSD.toFixed(4)}`);

      // Registra no contador diário (não bloqueia retorno em caso de erro)
      db.registrarUsoToken(inputT, outputT, custoUSD).catch(e => console.error('[OpenAI] Erro ao registrar uso:', e.message));

      const raw = response.choices[0].message.content;
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`OpenAI retornou JSON inválido: ${raw}`);
      }
    } catch (err) {
      lastError = err;
      const status = err?.status ?? err?.response?.status;
      const isRetryable = status === 429 || (status >= 500 && status < 600);

      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAYS[attempt];
        console.warn(`[OpenAI] Erro ${status} na tentativa ${attempt + 1}/${MAX_RETRIES + 1} — aguardando ${delay / 1000}s antes de tentar novamente...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw err;
      }
    }
  }

  throw lastError;
}

module.exports = { chat };

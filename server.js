require('dotenv').config();

// Prevent unhandled promise rejections from crashing the process
process.on('unhandledRejection', (reason) => {
  console.error('[Server] UnhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[Server] UncaughtException:', err.message);
});

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const cors = require('cors');
const path = require('path');

const db = require('./src/db/database');
const webhookRouter = require('./src/routes/webhook');
const dashboardRouter = require('./src/routes/dashboard');
const { requireAuth, authRoutes } = require('./src/middleware/auth');
const confirmacaoService = require('./src/services/confirmacao');
const aniversarioService = require('./src/services/aniversario');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Session (persisted in PostgreSQL — survives server restarts)
app.use(session({
  store: new pgSession({
    conString: process.env.DATABASE_URL,
    tableName: 'sessions',
    createTableIfMissing: true,
    ssl: false,
  }),
  secret: process.env.SESSION_SECRET || 'lais-secret-2024-studio-lucas',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 hours
}));

// Auth middleware — protects dashboard and API (webhook is exempt)
app.use(requireAuth);

// Static dashboard
app.use(express.static(path.join(__dirname, 'public')));

// Auth routes (login / logout)
authRoutes(app);

// Routes
app.use('/webhook', webhookRouter);
app.use('/api', dashboardRouter);

// Health check (public)
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Login page
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Página pública de conexão WhatsApp
app.get('/whatsapp-connect', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'whatsapp-connect.html'));
});

// Painel do operador (usuário não-admin)
app.get('/operador', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'operador.html'));
});

// Fallback to dashboard — operador é redirecionado para seu painel
app.get('*', (req, res) => {
  if (req.session?.authenticated && req.session?.role === 'operator') {
    return res.sendFile(path.join(__dirname, 'public', 'operador.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Job automático de confirmação de agendamentos ───────────────────────────
// Roda a cada 30 minutos e verifica quais agendamentos precisam de confirmação agora.
// Regras:
//   - 08:00 / 09:00 agendado antes das 18:00 → dispara às 18:00 do mesmo dia, prazo até 22:00
//   - 08:00 / 09:00 agendado após as 18:00   → confirmado automaticamente no ato do agendamento
//   - 10:00 em diante                         → dispara às 18:00 do dia anterior, prazo até 2h antes
//   - Qualquer horário sem confirmação no prazo → marcado automaticamente como faltou
function iniciarJobAniversario() {
  // Roda todo dia às 09:00 (horário de Brasília)
  const executar = async () => {
    try {
      const resultados = await aniversarioService.dispararAniversarios();
      const enviados = resultados.filter(r => r.status === 'enviado').length;
      if (enviados > 0) console.log(`[Aniversário] ${enviados} mensagens enviadas`);
    } catch (err) {
      console.error('[Aniversário] Erro no job:', err.message);
    }
  };

  const agendarProximo = () => {
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const proximo = new Date(agora);
    proximo.setHours(9, 0, 0, 0);
    if (proximo <= agora) proximo.setDate(proximo.getDate() + 1);
    const delay = proximo - agora;
    console.log(`[Aniversário] Próximo disparo em ${Math.round(delay / 60000)} minutos`);
    setTimeout(async () => { await executar(); agendarProximo(); }, delay);
  };

  agendarProximo();
}

function iniciarJobConfirmacao() {
  const INTERVALO = 30 * 60 * 1000; // 30 minutos

  const executar = async () => {
    try {
      const resultados = await confirmacaoService.verificarEDisparar();
      const enviados = resultados.filter(r => r.status === 'enviado').length;
      if (enviados > 0) console.log(`[Confirmação] Job: ${enviados} mensagens enviadas`);
    } catch (err) {
      console.error('[Confirmação] Erro no job automático:', err.message);
    }
  };

  executar(); // rodar imediatamente ao iniciar
  setInterval(executar, INTERVALO);
  console.log('[Confirmação] Job automático iniciado (intervalo: 30 min)');
}

// ─── Async startup: connect DB first, then listen ────────────────────────────
(async () => {
  try {
    await db.init();
    app.listen(PORT, () => {
      console.log(`\n🤖 Lais Bot rodando na porta ${PORT}`);
      console.log(`📊 Dashboard: http://localhost:${PORT}`);
      console.log(`🔗 Webhook Evolution: http://SEU_IP:${PORT}/webhook/evolution\n`);
    });
    iniciarJobConfirmacao();
    iniciarJobAniversario();
  } catch (err) {
    console.error('[Server] Falha ao conectar no banco de dados:', err.message);
    process.exit(1);
  }
})();

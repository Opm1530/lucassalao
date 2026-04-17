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

// Fallback to dashboard
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Async startup: connect DB first, then listen ────────────────────────────
(async () => {
  try {
    await db.init();
    app.listen(PORT, () => {
      console.log(`\n🤖 Lais Bot rodando na porta ${PORT}`);
      console.log(`📊 Dashboard: http://localhost:${PORT}`);
      console.log(`🔗 Webhook Evolution: http://SEU_IP:${PORT}/webhook/evolution\n`);
    });
  } catch (err) {
    console.error('[Server] Falha ao conectar no banco de dados:', err.message);
    process.exit(1);
  }
})();

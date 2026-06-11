/**
 * Simple dashboard authentication middleware.
 * Credentials are set via environment variables or fall back to defaults.
 *
 * DASHBOARD_USER=admin
 * DASHBOARD_PASS=minha_senha_aqui
 */

const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'lais2024';

// Usuário simples (não-admin): acesso limitado ao painel /operador
const OPERATOR_USER = process.env.OPERATOR_USER || 'operador';
const OPERATOR_PASS = process.env.OPERATOR_PASS || 'lucas2024';

// Paths that don't require authentication
const PUBLIC_PATHS = ['/login', '/login.html', '/api/auth/login', '/api/auth/logout', '/health', '/whatsapp-connect', '/whatsapp-connect.html', '/api/public/qrcode'];
// Webhook never requires auth
const WEBHOOK_PREFIX = '/webhook';

// Rotas do painel do operador (acessíveis pelo operador E admin)
const OPERATOR_ALLOWED_PATHS = [
  '/operador',
  '/operador.html',
];
const OPERATOR_ALLOWED_API_PREFIXES = [
  '/api/conversations',
  '/api/confirmacoes',
  '/api/aniversario',
  '/api/qrcode',
  '/api/whatsapp',
  '/api/auth/logout',
  '/api/auth/me',
  '/api/operator-toggle',
];

function isOperatorAllowed(reqPath) {
  if (OPERATOR_ALLOWED_PATHS.includes(reqPath)) return true;
  return OPERATOR_ALLOWED_API_PREFIXES.some(prefix => reqPath.startsWith(prefix));
}

function requireAuth(req, res, next) {
  // Always allow webhook (Evolution posts here)
  if (req.path.startsWith(WEBHOOK_PREFIX)) return next();

  // Always allow public paths
  if (PUBLIC_PATHS.includes(req.path)) return next();

  // Allow static assets (css, js, images) on login page
  if (req.path.match(/\.(css|js|png|jpg|ico|svg|woff2?)$/)) return next();

  // Não autenticado
  if (!req.session || !req.session.authenticated) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Não autenticado' });
    return res.redirect('/login');
  }

  // Operador: só pode acessar páginas/endpoints permitidos
  if (req.session.role === 'operator') {
    if (!isOperatorAllowed(req.path)) {
      if (req.path.startsWith('/api/')) return res.status(403).json({ error: 'Acesso restrito' });
      return res.redirect('/operador');
    }
  }

  return next();
}

function authRoutes(router) {
  router.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (username === DASHBOARD_USER && password === DASHBOARD_PASS) {
      req.session.authenticated = true;
      req.session.role = 'admin';
      return res.json({ success: true, role: 'admin', redirect: '/' });
    }
    if (username === OPERATOR_USER && password === OPERATOR_PASS) {
      req.session.authenticated = true;
      req.session.role = 'operator';
      return res.json({ success: true, role: 'operator', redirect: '/operador' });
    }
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  });

  router.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  // Retorna o papel atual do usuário (usado pelo frontend)
  router.get('/api/auth/me', (req, res) => {
    if (!req.session?.authenticated) return res.status(401).json({ error: 'Não autenticado' });
    res.json({ role: req.session.role || 'admin' });
  });
}

module.exports = { requireAuth, authRoutes, DASHBOARD_USER };

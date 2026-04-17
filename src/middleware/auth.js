/**
 * Simple dashboard authentication middleware.
 * Credentials are set via environment variables or fall back to defaults.
 *
 * DASHBOARD_USER=admin
 * DASHBOARD_PASS=minha_senha_aqui
 */

const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'lais2024';

// Paths that don't require authentication
const PUBLIC_PATHS = ['/login', '/login.html', '/api/auth/login', '/api/auth/logout', '/health'];
// Webhook never requires auth
const WEBHOOK_PREFIX = '/webhook';

function requireAuth(req, res, next) {
  // Always allow webhook (Evolution posts here)
  if (req.path.startsWith(WEBHOOK_PREFIX)) return next();

  // Always allow public paths
  if (PUBLIC_PATHS.includes(req.path)) return next();

  // Allow static assets (css, js, images) on login page
  if (req.path.match(/\.(css|js|png|jpg|ico|svg|woff2?)$/)) return next();

  // Check session
  if (req.session && req.session.authenticated) return next();

  // API calls get 401 instead of redirect
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Não autenticado' });
  }

  // Redirect to login page
  return res.redirect('/login');
}

function authRoutes(router) {
  router.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (username === DASHBOARD_USER && password === DASHBOARD_PASS) {
      req.session.authenticated = true;
      return res.json({ success: true });
    }
    return res.status(401).json({ error: 'Usuário ou senha incorretos.' });
  });

  router.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });
}

module.exports = { requireAuth, authRoutes, DASHBOARD_USER };

const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const auth = require('./src/auth/auth');
const modBot = require('./src/bot/mod-bot');
const ConfigManager = require('./src/config/config-manager');
const logger = require('./src/utils/logger');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── SSE Client Tracking ────────────────────────────────────
const sseClients = new Set();

function broadcastSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.res.write(payload); } catch (e) { sseClients.delete(client); }
  }
}

// Forward bot events to all connected dashboards
logger.onLog((entry) => broadcastSSE('log-entry', entry));
modBot.onStatus((status) => broadcastSSE('bot-status', status));

// ─── Middleware ──────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.use(express.json());
app.use(cookieParser());

// Login rate limiter — 10 attempts per 15 minutes
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

// Global API rate limiter — 200 req/min
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiLimiter);

// Serve static dashboard files
app.use('/dashboard', express.static(path.join(__dirname, 'src', 'dashboard')));

// ─── Auth Routes ────────────────────────────────────────────
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  const { password } = req.body;
  const valid = await auth.verifyPassword(password);
  if (!valid) return res.status(401).json({ error: 'Invalid password' });

  const token = auth.generateToken();
  res.cookie('cgg_token', token, auth.cookieOptions());
  res.json({ success: true });
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('cgg_token', { path: '/' });
  res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
  const token = req.cookies.cgg_token;
  if (!token || !auth.verifyToken(token)) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({ authenticated: true });
});

// ─── Auth Middleware ────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.cookies.cgg_token;
  if (!token || !auth.verifyToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── SSE Stream (real-time events) ──────────────────────────
app.get('/api/events', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Send initial heartbeat
  res.write('event: connected\ndata: {}\n\n');

  const client = { res };
  sseClients.add(client);

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    try { res.write('event: ping\ndata: {}\n\n'); } catch (e) { clearInterval(heartbeat); }
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
  });
});

// ─── Bot API ────────────────────────────────────────────────
app.post('/api/bot/start', requireAuth, async (req, res) => {
  const token = ConfigManager.getBotToken() || process.env.BOT_TOKEN || '';
  if (!token) return res.json({ success: false, error: 'No bot token configured. Set it in Settings or BOT_TOKEN env var.' });
  try {
    await modBot.start(token);
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.post('/api/bot/stop', requireAuth, async (req, res) => {
  try {
    await modBot.stop();
    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/api/bot/status', requireAuth, (req, res) => {
  res.json(modBot.getStatus());
});

// ─── Rules API ──────────────────────────────────────────────
app.get('/api/rules', requireAuth, (req, res) => {
  res.json(ConfigManager.getRules());
});

app.put('/api/rules/:id', requireAuth, (req, res) => {
  res.json(ConfigManager.updateRule(req.params.id, req.body));
});

app.put('/api/rules', requireAuth, (req, res) => {
  ConfigManager.setRules(req.body);
  res.json({ success: true });
});

// ─── Settings API ───────────────────────────────────────────
app.get('/api/settings', requireAuth, (req, res) => {
  res.json(ConfigManager.getSettings());
});

app.put('/api/settings', requireAuth, (req, res) => {
  res.json(ConfigManager.updateSettings(req.body));
});

app.get('/api/settings/token', requireAuth, (req, res) => {
  res.json({ token: ConfigManager.getBotToken() });
});

app.put('/api/settings/token', requireAuth, (req, res) => {
  ConfigManager.setBotToken(req.body.token);
  res.json({ success: true });
});

app.post('/api/config/reset', requireAuth, (req, res) => {
  ConfigManager.resetToDefaults();
  res.json({ success: true });
});

// ─── Logs API ───────────────────────────────────────────────
app.get('/api/logs', requireAuth, (req, res) => {
  res.json(logger.getLogs(req.query));
});

app.get('/api/logs/recent/:count', requireAuth, (req, res) => {
  res.json(logger.getRecentLogs(parseInt(req.params.count) || 100));
});

app.get('/api/stats', requireAuth, (req, res) => {
  res.json(logger.getStats());
});

app.delete('/api/logs', requireAuth, (req, res) => {
  logger.clearMemory();
  res.json({ success: true });
});

// ─── Summaries API ──────────────────────────────────────────
app.get('/api/summaries', requireAuth, (req, res) => {
  res.json(modBot.getSummaries());
});

// ─── Root Redirect ──────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/dashboard/index.html'));

// ─── 404 ────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Start Server ───────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║  🎨 ColorGG — AI Moderation Dashboard   ║');
  console.log(`  ║  Running on http://localhost:${String(PORT).padEnd(13)}║`);
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');

  if (!process.env.DASHBOARD_PASSWORD) {
    console.log('  ⚠️  WARNING: DASHBOARD_PASSWORD is not set!');
    console.log('  ⚠️  Set it as an environment variable to enable login.');
    console.log('');
  }

  // Auto-start bot if configured
  const botToken = ConfigManager.getBotToken() || process.env.BOT_TOKEN;
  if (botToken && process.env.AUTO_START === 'true') {
    console.log('  🤖 Auto-starting bot...');
    modBot.start(botToken).then(() => {
      console.log('  ✅ Bot started successfully');
    }).catch(err => {
      console.log(`  ❌ Bot auto-start failed: ${err.message}`);
    });
  }
});

// ─── Graceful Shutdown ──────────────────────────────────────
async function shutdown() {
  console.log('\n  Shutting down...');
  await modBot.stop();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import './db.js';
import apiRoutes from './routes/api.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import kometaRoutes from './routes/kometa.js';
import devRoutes from './routes/dev.js';
import webhookRoutes from './routes/webhook.js';
import { startScheduler } from './services/lifecycle.js';

const root = path.dirname(fileURLToPath(import.meta.url));

export const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(root, 'views'));

app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  });
  next();
});
app.use(express.json({ limit: '100kb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));
// Scripts are revalidated on every load (cheap 304s via ETag) so a rebuilt image is picked up immediately.
app.use('/public', express.static(path.join(root, '..', 'public'), {
  setHeaders: (res, file) => res.set('Cache-Control', /\.(js|css)$/.test(file) ? 'no-cache' : 'public, max-age=300'),
}));

app.get('/', (_req, res) => {
  res.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'");
  res.render('dashboard', { devMode: config.devMode, adminRun: config.adminRun, fakeLogin: config.fakeLogin, apiBase: process.env.API_BASE_PATH || '/api', assetBase: process.env.ASSET_BASE_PATH || '/public' });
});

if (config.fakeLogin) app.use('/api/dev', devRoutes);
app.use('/api/seerr-webhook', webhookRoutes);
app.use('/api/kometa', kometaRoutes);
app.use('/api/auth', authRoutes); // Plex login; must stay ahead of /api, which requires a session
app.use('/api/admin', adminRoutes);
app.use('/api', apiRoutes);

app.use((_req, _res, next) => next(Object.assign(new Error('Not found'), { status: 404, expose: true })));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status && err.status >= 400 ? err.status : 500;
  if (status >= 500) console.error(err);
  const body = { error: err.expose ? err.message : 'Internal server error' };
  if (err.remainingDays !== undefined) body.remainingDays = err.remainingDays;
  res.status(status).json(body);
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  app.listen(config.port, config.host, () => {
    console.log(`stewarrd listening on ${config.host}:${config.port}`);
  });
  startScheduler();
  if (config.devMode) {
    console.warn('DEV_MODE is ON: fake login and simulation endpoints are enabled. Never use this in production.');
  } else if (config.adminRun) {
    const only = config.seerrSyncUsers.size ? `limited to user ids ${[...config.seerrSyncUsers].join(', ')}` : 'for ALL users';
    console.warn(`ADMIN_RUN is ON: fake login is enabled and claim and purge change REAL Seerr requests ${only}. Radarr/Sonarr are disabled. Never use this in production.`);
  }
}

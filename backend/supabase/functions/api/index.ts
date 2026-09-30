import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { requireAuth } from './middleware/auth.ts';
import { buildAuthRoutes } from './routes/auth.ts';
import { buildPropertyRoutes } from './routes/properties.ts';
import { buildMaintenanceRoutes } from './routes/maintenance.ts';
import { buildCallRoutes } from './routes/calls.ts';
import { buildUrgencyRuleRoutes } from './routes/urgency-rules.ts';
import { buildMetricsRoutes } from './routes/metrics.ts';
import { buildMeRoutes } from './routes/me.ts';
import { buildKnowledgeBaseRoutes } from './routes/knowledge-bases.ts';
import type { AppEnv } from './lib/types.ts';

const app = new Hono<AppEnv>().basePath('/api');

// CORS: allow the static frontend origin(s). Auth is a Bearer JWT in the
// Authorization header (no cookies), so origin allow-listing is for hygiene, not
// the security boundary. We allow: localhost dev, any explicit ALLOWED_ORIGINS
// (comma-separated secret), and any *.onrender.com host (the Render static_site,
// incl. PR-preview subdomains) — so the deployed dashboard works without a secret.
const explicitOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use('*', cors({
  origin: (origin) => {
    if (!origin) return 'http://localhost:3000';
    if (origin === 'http://localhost:3000') return origin;
    if (explicitOrigins.includes(origin)) return origin;
    if (origin.endsWith('.onrender.com')) return origin;
    return null;
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

app.get('/health', (c) => c.json({ ok: true }));

// Public: login only. Everything else requires a valid bearer token.
app.route('/auth', buildAuthRoutes());
app.use('/properties/*', requireAuth);
app.use('/properties', requireAuth);
app.route('/properties', buildPropertyRoutes());

app.use('/maintenance', requireAuth);
app.use('/maintenance/*', requireAuth);
app.route('/maintenance', buildMaintenanceRoutes());

app.use('/calls', requireAuth);
app.use('/calls/*', requireAuth);
app.route('/calls', buildCallRoutes());

app.use('/urgency-rules', requireAuth);
app.use('/urgency-rules/*', requireAuth);
app.route('/urgency-rules', buildUrgencyRuleRoutes());

app.use('/metrics', requireAuth);
app.use('/metrics/*', requireAuth);
app.route('/metrics', buildMetricsRoutes());

app.use('/me', requireAuth);
app.use('/me/*', requireAuth);
app.route('/me', buildMeRoutes());

app.use('/knowledge-bases', requireAuth);
app.use('/knowledge-bases/*', requireAuth);
app.route('/knowledge-bases', buildKnowledgeBaseRoutes());

Deno.serve(app.fetch);

export default app;

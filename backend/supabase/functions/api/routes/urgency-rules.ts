import { Hono } from 'hono';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceClient } from '../lib/supabase.ts';

type ClientFactory = () => SupabaseClient;

export function buildUrgencyRuleRoutes(makeClient: ClientFactory = serviceClient) {
  const app = new Hono();

  // Ported from src/app/(dashboard)/settings/urgency-rules/page.tsx:
  //   supabase.from('urgency_rules').select('*').in('level', ['critical','high','medium'])
  app.get('/', async (c) => {
    const { data, error } = await makeClient()
      .from('urgency_rules').select('*').in('level', ['critical', 'high', 'medium']);
    if (error) {
      console.error('GET /urgency-rules failed:', error);
      return c.json({ error: 'Request failed.' }, 400);
    }
    return c.json(data ?? []);
  });

  // Update/reorder tiers. Mirrors saveUrgencyExamples in src/backend/urgency-rules.ts
  //   supabase.from('urgency_rules').update(patch).eq('id', ruleId)
  // applied once per rule. Body: { rules: [{ id, ...fields }] }; `id` is the row
  // key, never part of the update payload.
  app.put('/', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.rules)) {
      return c.json({ error: 'Invalid JSON body.' }, 400);
    }
    const sb = makeClient();
    for (const rule of body.rules) {
      if (!rule || typeof rule.id !== 'string') {
        return c.json({ error: 'Each rule needs an id.' }, 400);
      }
      const { id, ...patch } = rule;
      const { error } = await sb.from('urgency_rules').update(patch).eq('id', id);
      if (error) {
        console.error('PUT /urgency-rules update failed:', error);
        return c.json({ error: 'Request failed.' }, 400);
      }
    }
    return c.json({ ok: true });
  });

  return app;
}

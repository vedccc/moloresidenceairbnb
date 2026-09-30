import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by Supabase into
// every edge function — no `supabase secrets set` needed for these two.
export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}

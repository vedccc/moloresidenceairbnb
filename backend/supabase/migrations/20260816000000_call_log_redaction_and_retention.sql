-- Applied to the live project 2026-08-16 via MCP; committed here so the schema
-- history stays complete. See redact_expired_calls / redact_calls_for_number.
--
-- Retention: personal data (phone number + transcript) is removed 14 days after
-- a call. The ROW SURVIVES — started_at, duration_seconds, cost_usd, outcome,
-- mode and property_id are what the dashboard's stats are built from.

alter table call_logs
  add column if not exists redacted_at      timestamptz,
  add column if not exists redaction_reason text
    check (redaction_reason in ('retention', 'gdpr_request'));

create index if not exists call_logs_retention_idx
  on call_logs (started_at) where redacted_at is null;
create index if not exists call_logs_from_number_idx
  on call_logs (from_number) where from_number is not null;

create or replace function redact_expired_calls(retention_days int default 14)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update call_logs
     set from_number = null, summary = null,
         redacted_at = now(), redaction_reason = 'retention'
   where redacted_at is null
     and started_at < now() - make_interval(days => retention_days)
     and (from_number is not null or summary is not null);
  get diagnostics n = row_count;
  return n;
end; $$;

create or replace function redact_calls_for_number(target_phone text)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if target_phone is null or btrim(target_phone) = '' then return 0; end if;
  -- EVERY call from this number, not just the one that made the request.
  update call_logs
     set from_number = null, summary = null,
         redacted_at = now(), redaction_reason = 'gdpr_request'
   where from_number = target_phone;
  get diagnostics n = row_count;
  update booking_links set phone = null where phone = target_phone;
  return n;
end; $$;

-- Nightly sweep, inside Postgres — no external scheduler needed.
create extension if not exists pg_cron;
select cron.unschedule('redact-expired-calls')
where exists (select 1 from cron.job where jobname = 'redact-expired-calls');
select cron.schedule('redact-expired-calls', '15 3 * * *',
                     $$select redact_expired_calls(14)$$);

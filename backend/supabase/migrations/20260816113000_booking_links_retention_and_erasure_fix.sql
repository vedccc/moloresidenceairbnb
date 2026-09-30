-- Applied to the live project 2026-08-16 via MCP; committed here so the schema
-- history stays complete.
--
-- booking_links carries caller phone numbers (guest_name has never been
-- populated) but was outside the 14-day retention sweep, and phone/guest_name
-- are NOT NULL — so redact_calls_for_number's `set phone = null` would abort
-- the whole erasure transaction for any caller with a booking link. Redact to
-- '' (matching the rows the agent already inserts with an empty phone) and put
-- booking_links on the same 14-day clock as call_logs.

create or replace function redact_expired_calls(retention_days int default 14)
returns int language plpgsql security definer set search_path = public as $$
declare n int; m int;
begin
  update call_logs
     set from_number = null, summary = null,
         redacted_at = now(), redaction_reason = 'retention'
   where redacted_at is null
     and started_at < now() - make_interval(days => retention_days)
     and (from_number is not null or summary is not null);
  get diagnostics n = row_count;
  update booking_links
     set phone = '', guest_name = ''
   where sent_at < now() - make_interval(days => retention_days)
     and (phone <> '' or guest_name <> '');
  get diagnostics m = row_count;
  return n + m;
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
  update booking_links set phone = '', guest_name = '' where phone = target_phone;
  return n;
end; $$;

-- Clear the backlog immediately rather than waiting for tonight's cron run.
select redact_expired_calls(14);

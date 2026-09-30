-- Applied to the live project 2026-08-16 via MCP; committed here so the schema
-- history stays complete.
--
-- Two changes, both driven by the same complaint: the calls page could not say
-- what a call actually did, or what it cost.
--
-- 1. `outcomes text[]` — a call is rarely ONE thing. A guest who asks about
--    parking, gets an answer, then reports a broken shower produced a single
--    outcome before this: whichever tool fired last. Worse, a guest who asked a
--    couple of questions and hung up was logged as 'abandoned', because
--    'abandoned' was the fallback whenever no TOOL ran — and the model answers
--    most questions straight from the loaded KB without calling one. The
--    singular `outcome` column stays, holding the highest-priority entry of
--    `outcomes`, so the home dashboard's category chart and every existing
--    filter keep working unchanged.
--
-- 2. `cost_breakdown jsonb` — `cost_usd` alone can't be audited. The breakdown
--    records the per-component split (llm / stt / tts / telephony / session /
--    kb_search), the measured usage behind it, the rates used, and whether the
--    figure was measured or estimated.

alter table call_logs
  add column if not exists outcomes       text[] not null default '{}'::text[],
  add column if not exists cost_breakdown jsonb;

-- The vocabulary. Ordered here the way the dashboard ranks it (most specific
-- first) — the singular `outcome` column holds whichever entry ranks highest.
--
-- 'abandoned' is now narrow: the caller hung up without a real exchange. It is
-- never combined with anything else.
--
-- The last two values are legacy. Nothing writes them any more and no row uses
-- them, but they were valid before this migration, so they stay accepted rather
-- than making the constraint retroactively unsatisfiable.
do $$
declare
  allowed text[] := array[
    'reservation_looked_up',
    'availability_checked',
    'booking_link_sent',
    'maintenance_ticket_raised',
    'transferred_to_human',
    'transfer_unavailable',
    'question_answered',
    'unresolved',
    'complaint',
    'spam',
    'wrong_number',
    'abandoned',
    'other',
    -- legacy, still accepted:
    'reservation_info_provided',
    'troubleshoot_resolved'
  ];
begin
  alter table call_logs drop constraint if exists call_logs_outcome_check;
  execute format(
    'alter table call_logs add constraint call_logs_outcome_check
       check (outcome is null or outcome = any (%L::text[]))', allowed);

  alter table call_logs drop constraint if exists call_logs_outcomes_check;
  execute format(
    'alter table call_logs add constraint call_logs_outcomes_check
       check (outcomes <@ %L::text[])', allowed);
end $$;

-- Containment lookups (`outcomes @> '{spam}'`) for anything that filters
-- server-side later; the dashboard itself filters the fetched list in-browser.
create index if not exists call_logs_outcomes_idx on call_logs using gin (outcomes);

-- Existing rows: carry the single outcome across so history isn't blank in the
-- new column. The 37 rows sitting on the old, too-eager 'abandoned' are left
-- exactly as they are — their transcripts are what would be needed to
-- re-classify them honestly, and the 14-day retention sweep has already taken
-- most of those.
update call_logs
   set outcomes = array[outcome]
 where outcome is not null and outcomes = '{}'::text[];

-- Applied to the live project 2026-08-16 via MCP; committed here so the schema
-- history stays complete.
--
-- Backfill: 187 of 232 calls had no cost at all, because nothing ever wrote the
-- column — the agent only started pricing calls today (src/call_cost.py). A
-- "total spend" line on the calls page that silently skipped four calls in five
-- would be worse than no line, so history gets an estimate.
--
-- ESTIMATED, and flagged as such: `cost_breakdown.measured` is false on every
-- row this touches, exactly as it is for a live call whose usage metrics never
-- arrived. Only calls from here on carry measured LLM tokens, TTS characters
-- and STT seconds.
--
-- The rate is call_cost.blended_per_minute_usd() = $0.05971/min: LiveKit's own
-- per-minute assumptions for a voice agent (3,000 input + 175 output tokens,
-- 600 TTS characters, one minute of STT) priced at the rates this stack runs
-- on. Keep the two in sync — the split below is the same one Python computes.
--
-- Deliberately NOT touched:
--   * the 45 rows that already carry a cost. They were seeded at the old
--     Gemini-Live blend ($0.061/min) and are within a rounding error of this
--     one; overwriting real history to make it tidier is not worth it.
--   * the 15 rows with no duration — a call that never recorded a length can't
--     be priced, and inventing one would put fiction in the totals.

update call_logs
   set cost_usd = round((duration_seconds / 60.0 * 0.05971)::numeric, 4),
       cost_breakdown = jsonb_build_object(
         'version', 1,
         'measured', false,
         'source', 'backfill_2026_08_16',
         'total_usd', round((duration_seconds / 60.0 * 0.05971)::numeric, 4),
         'components_usd', jsonb_build_object(
           'llm',       round((duration_seconds / 60.0 * 0.00141)::numeric, 6),
           'stt',       round((duration_seconds / 60.0 * 0.0058)::numeric, 6),
           'tts',       round((duration_seconds / 60.0 * 0.03)::numeric, 6),
           'session',   round((duration_seconds / 60.0 * 0.01)::numeric, 6),
           'telephony', round((duration_seconds / 60.0 * 0.0125)::numeric, 6),
           'kb_search', 0
         ),
         'usage', jsonb_build_object('duration_s', duration_seconds),
         'note', 'Estimated from duration at the blended per-minute rate; '
                 'predates per-call usage metering.'
       )
 where cost_usd is null
   and duration_seconds is not null;

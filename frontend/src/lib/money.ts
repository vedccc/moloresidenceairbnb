/**
 * Call costs, in euros.
 *
 * They are STORED in US dollars (`call_logs.cost_usd`), because that is what
 * LiveKit and Telnyx invoice in and re-deriving a dollar figure from a rounded
 * euro one loses money in the noise. The dashboard shows euros only — the
 * client's own currency — so the conversion lives here, in one place, and every
 * figure on every page goes through it.
 *
 * Changing the rate re-converts history too. That is deliberate: the question
 * the page answers is "what is this costing us", not "what was it worth on the
 * day", and a table where each row used a different rate could not be added up.
 */

/**
 * USD -> EUR. Market rate on 14 August 2026 (EUR/USD 1.1567).
 *
 * A hand-maintained constant on purpose: the static bundle has no server to
 * fetch a live rate from, and a currency API call on every page load would make
 * the totals move about for no useful reason. Update it when it has drifted
 * enough to matter.
 */
export const USD_TO_EUR = 0.867;

/** Dollars to euros. Passes null through, so a call with no cost stays "no cost". */
export function usdToEur(usd: number | string | null | undefined): number | null {
  if (usd == null) return null;
  const n = typeof usd === 'string' ? Number(usd) : usd;
  if (!Number.isFinite(n)) return null;
  return n * USD_TO_EUR;
}

/**
 * A euro amount as text.
 *
 * `decimals` defaults to 3 because a single call costs around five cents:
 * rounded to the usual 2dp, most rows would read "€0.05" and a handful of
 * short calls "€0.00". Totals pass 2 — by then it is ordinary money.
 */
export function formatEur(
  eur: number | null | undefined,
  { decimals = 3 }: { decimals?: number } = {},
): string {
  if (eur == null || !Number.isFinite(eur)) return '—';
  return `€${eur.toFixed(decimals)}`;
}

/** Convert and format in one step — what the table cells actually call. */
export function formatEurFromUsd(
  usd: number | string | null | undefined,
  opts?: { decimals?: number },
): string {
  return formatEur(usdToEur(usd), opts);
}

import { describe, it, expect } from 'vitest';
import { USD_TO_EUR, formatEur, formatEurFromUsd, usdToEur } from './money';

describe('money', () => {
  it('converts dollars to euros at the stored rate', () => {
    expect(usdToEur(1)).toBeCloseTo(USD_TO_EUR, 10);
    expect(usdToEur(0.06)).toBeCloseTo(0.06 * USD_TO_EUR, 10);
  });

  it('accepts the string a numeric column arrives as', () => {
    expect(usdToEur('0.06')).toBeCloseTo(0.06 * USD_TO_EUR, 10);
  });

  it('keeps "no cost" distinct from "zero cost"', () => {
    // A call with a null cost must render as an em dash, not €0.000 — the
    // latter reads as "this call was free", which is never true.
    expect(usdToEur(null)).toBeNull();
    expect(usdToEur(undefined)).toBeNull();
    expect(usdToEur('not a number')).toBeNull();
    expect(formatEur(null)).toBe('—');
    expect(formatEurFromUsd(null)).toBe('—');
    expect(formatEurFromUsd(0)).toBe('€0.000');
  });

  it('shows three decimals per call and two for a total', () => {
    // One call costs around five cents; at 2dp most rows would read €0.05 and
    // the short ones €0.00.
    expect(formatEurFromUsd(0.0597)).toBe('€0.052');
    expect(formatEur(10.8129, { decimals: 2 })).toBe('€10.81');
  });

  it('uses a plausible rate', () => {
    // A slipped decimal here would silently rescale every figure on the page.
    expect(USD_TO_EUR).toBeGreaterThan(0.5);
    expect(USD_TO_EUR).toBeLessThan(1.5);
  });
});

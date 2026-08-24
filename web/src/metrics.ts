/**
 * Portfolio performance for a book built from irregular purchases.
 *
 * Buying in tranches over weeks or months makes the naive "current value over
 * total cost" figure misleading: money put in last week is credited with the
 * same holding period as money put in a year ago. XIRR is the money-weighted
 * answer -- the constant annual rate that discounts every actual cash flow back
 * to zero -- so a position bought late does not get flattered or punished by
 * when it happened to be funded.
 */

export interface CashFlow {
  date: Date;
  amount: number; // negative = money in, positive = money out or current value
}

const DAY = 86_400_000;
const YEAR = 365;

function npv(rate: number, flows: CashFlow[], t0: number): number {
  return flows.reduce(
    (sum, f) => sum + f.amount / (1 + rate) ** ((f.date.getTime() - t0) / DAY / YEAR),
    0,
  );
}

/**
 * Money-weighted annualised return. Returns null when the flows cannot define
 * one (all same sign, single day, or no convergence).
 */
export function xirr(flows: CashFlow[]): number | null {
  if (flows.length < 2) return null;
  const hasIn = flows.some((f) => f.amount < 0);
  const hasOut = flows.some((f) => f.amount > 0);
  if (!hasIn || !hasOut) return null;

  const t0 = Math.min(...flows.map((f) => f.date.getTime()));
  if (Math.max(...flows.map((f) => f.date.getTime())) - t0 < DAY) return null;

  // Bisection: slower than Newton but cannot diverge, and the bracket below
  // covers everything from a total loss to a 100x gain.
  let lo = -0.9999;
  let hi = 100;
  let fLo = npv(lo, flows, t0);
  if (fLo * npv(hi, flows, t0) > 0) return null; // no sign change, no root

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid, flows, t0);
    if (Math.abs(fMid) < 1e-9) return mid;
    if (fLo * fMid < 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

/** Simple (not annualised) return on invested cost. */
export function simpleReturn(cost: number, value: number): number | null {
  return cost > 0 ? value / cost - 1 : null;
}

export interface ValuePoint {
  d: string; // ISO date
  v: number; // total portfolio value in USD
}

/**
 * Annualised Sharpe from a series of portfolio values.
 *
 * This needs a value history, which the app can only accumulate going forward
 * -- entry prices alone cannot reconstruct what the portfolio was worth on any
 * past day. Returns null until there are enough observations for the number to
 * mean anything; a Sharpe computed from two weeks of data is noise wearing a
 * decimal point.
 */
export function sharpe(history: ValuePoint[], riskFreeAnnual = 0.04): number | null {
  const MIN_POINTS = 30;
  if (history.length < MIN_POINTS) return null;

  const sorted = [...history].sort((a, b) => a.d.localeCompare(b.d));
  const rets: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const days = (Date.parse(sorted[i].d) - Date.parse(sorted[i - 1].d)) / DAY;
    if (days <= 0 || sorted[i - 1].v <= 0) continue;
    // Normalise to a daily rate so irregular gaps between visits do not
    // distort the volatility estimate.
    rets.push((sorted[i].v / sorted[i - 1].v) ** (1 / days) - 1);
  }
  if (rets.length < MIN_POINTS - 1) return null;

  const rfDaily = (1 + riskFreeAnnual) ** (1 / 252) - 1;
  const excess = rets.map((r) => r - rfDaily);
  const mean = excess.reduce((a, b) => a + b, 0) / excess.length;
  const variance =
    excess.reduce((a, b) => a + (b - mean) ** 2, 0) / (excess.length - 1);
  const sd = Math.sqrt(variance);
  return sd > 0 ? (mean / sd) * Math.sqrt(252) : null;
}

/** How many daily observations remain before Sharpe becomes reportable. */
export function sharpeNeedsMore(history: ValuePoint[]): number {
  return Math.max(0, 30 - history.length);
}

/** Largest peak-to-trough fall in the recorded value history. */
export function maxDrawdown(history: ValuePoint[]): number | null {
  if (history.length < 2) return null;
  const sorted = [...history].sort((a, b) => a.d.localeCompare(b.d));
  let peak = sorted[0].v;
  let worst = 0;
  for (const p of sorted) {
    peak = Math.max(peak, p.v);
    if (peak > 0) worst = Math.min(worst, p.v / peak - 1);
  }
  return worst;
}

/** Shapes of the JSON published by the GitHub Actions pipeline. */

/** One name the screen currently says belongs in the basket. */
export interface Candidate {
  ticker: string;
  market: "US" | "JP";
  name: string;
  /** EV/EBIT on the trailing twelve months. Lower is cheaper. */
  metric: number;
  /** The same multiple on the last fiscal year, for contrast. A wide gap means
   *  earnings have moved since the 10-K. */
  evEbitFy?: number | null;
  /** F-Score summary, e.g. "F 8/9". */
  quality: string;
  rank: number;
  price?: number;
  adv?: number;
  divYield?: number;
  /** True when no debt concept was tagged and enterprise value fell back to
   *  non-current liabilities. Treat the valuation as softer. */
  debtEstimated?: boolean;
  /** Yield is probably a one-off (special dividend, return of capital), so it
   *  should not be treated as a recurring withholding drag. */
  divSuspect?: boolean;
}

/**
 * Rule thresholds, published by the private pipeline rather than compiled into
 * this bundle. The bundle is served from a public site, so keeping the numbers
 * here would put the strategy's parameters back in the open.
 */
export interface ScreenConfig {
  fScoreMin: number;
  fScoreExit: number;
  fScoreWatch: number;
  minAdvUsd: number;
  advOrderCap: number;
  divYieldSuspect: number;
  valuationBasis?: string;
}

export interface TargetFile {
  asOf: string | null;
  us: Candidate[];
  jp: Candidate[];
  config?: ScreenConfig;
}

/**
 * Per-company facts for every screened name, not just the ranked shortlist.
 * Keys are abbreviated because this ships to the browser in full.
 */
export interface Fact {
  f: number; // F-Score points
  fa: number; // tests available
  p: number; // last close
  ee: number | null; // EV/EBIT
  dy: number; // dividend yield
  adv: number | null; // average daily traded value
  n: string; // company name
}

export interface FactsFile {
  asOf: string | null;
  facts: Record<string, Fact>;
}

/** One company research report, generated nightly by the private pipeline. */
export interface Report {
  ticker: string;
  cik: number;
  generated: string;
  meta: {
    name?: string;
    sic?: string;
    sicDescription?: string;
    country?: string;
    exchanges?: string[];
    fiscalYearEnd?: string;
    latestForm?: string | null;
    latestFiling?: string | null;
  };
  /** concept -> { "2025": value }. Keys are English so terms.ts can pair them
   *  with a Chinese label at render time. */
  annual: Record<string, Record<string, number>>;
  quarterly: Record<string, { end: string; val: number; fy?: number; fp?: string }[]>;
  ttm: Record<string, { value: number | null; basis: string }>;
  latestBalance: Record<string, { value: number | null; date: string | null }>;
  sharesOutstanding: Record<string, number>;
  priceAnchors: { date: string; float: number; shares: number; price: number }[];
  priceAnalysis: PriceAnalysis | null;
  valuation: {
    price: number | null;
    shares: number | null;
    marketCap: number | null;
    cash: number;
    debt: number;
    enterpriseValue: number | null;
    evEbitTtm: number | null;
    evCfoTtm: number | null;
    peTtm: number | null;
    pb: number | null;
    ebitBasis: string;
  };
}

export interface Regression {
  beta: number;
  alpha: number;
  r2: number | null;
  residSd: number;
  n: number;
}

export interface PriceAnalysis {
  periods: { from: string; to: string; years: number; stock: number; market: number; rf: number }[];
  all: Regression | null;
  trimmed: Regression | null;
  trimmedPeriod: string;
  recent: Regression | null;
  underperformed: number;
  totalPeriods: number;
  cumStock: number;
  cumMarket: number;
  months: number;
  stockSd: number;
  marketSd: number;
  peak: number;
}

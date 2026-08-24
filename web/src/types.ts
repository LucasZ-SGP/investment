/** Shapes of the JSON published by the GitHub Actions pipeline. */

/** One name the screen currently says belongs in the basket. */
export interface Candidate {
  ticker: string;
  market: "US" | "JP";
  name: string;
  /** EV/EBIT. Lower is cheaper. */
  metric: number;
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

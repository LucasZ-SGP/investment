/**
 * Bilingual labels for financial terms.
 *
 * Every figure in a report carries both the Chinese name and the English one.
 * The English is not decoration: filings, screeners and any second opinion the
 * user seeks are all in English, and a report that only names things in
 * Chinese makes cross-checking harder than it needs to be.
 */

export interface Term {
  zh: string;
  en: string;
  /** Shown on hover where a term needs a definition rather than a translation. */
  note?: string;
}

export const T: Record<string, Term> = {
  // Income statement
  revenue: { zh: "营业收入", en: "Revenue" },
  grossProfit: { zh: "毛利", en: "Gross Profit" },
  grossMargin: { zh: "毛利率", en: "Gross Margin" },
  operatingIncome: { zh: "经营利润", en: "Operating Income / EBIT" },
  operatingMargin: { zh: "经营利润率", en: "Operating Margin" },
  netIncome: { zh: "净利润", en: "Net Income" },
  eps: { zh: "摊薄每股收益", en: "Diluted EPS" },
  rnd: { zh: "研发费用", en: "R&D Expense" },
  cogs: { zh: "营业成本", en: "Cost of Revenue" },

  // Cash flow and capital
  cfo: { zh: "经营现金流", en: "Cash Flow from Operations" },
  capex: { zh: "资本开支", en: "Capital Expenditure" },
  buybacks: { zh: "股票回购", en: "Share Buybacks" },
  dividends: { zh: "现金分红", en: "Dividends Paid" },
  dilutedShares: { zh: "摊薄加权股数", en: "Diluted Weighted Shares" },
  sharesOutstanding: { zh: "期末流通股", en: "Shares Outstanding" },

  // Balance sheet
  assets: { zh: "总资产", en: "Total Assets" },
  assetsCurrent: { zh: "流动资产", en: "Current Assets" },
  liabilities: { zh: "总负债", en: "Total Liabilities" },
  liabilitiesCurrent: { zh: "流动负债", en: "Current Liabilities" },
  cash: { zh: "现金及等价物", en: "Cash & Equivalents" },
  equity: { zh: "股东权益", en: "Shareholders' Equity" },
  ltDebt: { zh: "长期有息负债", en: "Long-Term Debt" },
  stDebt: { zh: "短期有息负债", en: "Short-Term Debt" },
  goodwill: { zh: "商誉", en: "Goodwill" },
  bookValuePerShare: { zh: "每股账面价值", en: "Book Value per Share" },

  // Ratios
  roe: { zh: "净资产收益率", en: "ROE", note: "净利润 / 股东权益" },
  roic: { zh: "投入资本回报率", en: "ROIC", note: "经营利润 /（股东权益 − 净现金）" },
  marketCap: { zh: "市值", en: "Market Cap" },
  enterpriseValue: { zh: "企业价值", en: "Enterprise Value", note: "市值 + 有息负债 − 现金" },
  evEbit: { zh: "企业价值倍数", en: "EV / EBIT", note: "本策略的核心估值指标，越低越便宜" },
  evCfo: { zh: "企业价值 / 经营现金流", en: "EV / CFO" },
  pe: { zh: "市盈率", en: "P/E" },
  pb: { zh: "市净率", en: "P/B" },
  divYield: { zh: "股息率", en: "Dividend Yield" },
  fScore: { zh: "质量分", en: "Piotroski F-Score", note: "九项财务健康检验，买入门槛为 7 分" },
  ttm: { zh: "过去十二个月", en: "TTM", note: "Trailing Twelve Months，比上一财年更贴近当前经营状况" },

  // Price and risk
  beta: { zh: "贝塔", en: "Beta", note: "对市场波动的敏感度，1 表示与市场同步" },
  alpha: { zh: "阿尔法", en: "Alpha", note: "扣除市场因素后的超额收益，负值表示长期跑输" },
  drawdown: { zh: "回撤", en: "Drawdown" },
  volatility: { zh: "波动率", en: "Volatility" },
  r2: { zh: "拟合优度", en: "R²", note: "市场因子能解释该股收益变动的比例" },
  publicFloat: { zh: "公众持股市值", en: "Public Float" },
};

/** "毛利 Gross Profit" — the form used in table rows and headings. */
export function label(key: string): string {
  const t = T[key];
  if (!t) return key;
  return `${t.zh} <span style="color:var(--faint);font-weight:400">${t.en}</span>`;
}

/** Plain text form, for places that cannot take markup. */
export function labelText(key: string): string {
  const t = T[key];
  return t ? `${t.zh} ${t.en}` : key;
}

/** With the definition attached as a tooltip where one exists. */
export function labelWithNote(key: string): string {
  const t = T[key];
  if (!t) return key;
  const title = t.note ? ` title="${t.note}"` : "";
  const dotted = t.note ? ";border-bottom:1px dotted var(--border-strong);cursor:help" : "";
  return `<span${title} style="white-space:nowrap${dotted}">${t.zh} <span style="color:var(--faint);font-weight:400">${t.en}</span></span>`;
}

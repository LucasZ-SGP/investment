import type { Ctx } from "../main";
import type { Report, Sector } from "../types";
import { label, labelWithNote } from "../terms";

export const title = "研究";
export const icon = "◇";

/** Reports are fetched one at a time and kept for the session. */
const cache = new Map<string, Report>();
let current: string | null = null;
let loading: string | null = null;
let error: string | null = null;

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

const M = (v: number | null | undefined, d = 0) =>
  v === null || v === undefined ? "—" : `$${(v / 1e6).toLocaleString("en-US", { maximumFractionDigits: d })}M`;
const pct = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(d)}%`;
const signed = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;

/** A row of yearly figures. `fmt` renders each cell. */
function row(key: string, vals: Record<string, number>, years: string[],
             fmt: (v: number) => string = (v) => M(v)): string {
  return `<tr><td>${label(key)}</td>${years
    .map((y) => `<td class="num">${y in vals ? fmt(vals[y]) : "—"}</td>`)
    .join("")}</tr>`;
}

function derivedRow(name: string, years: string[],
                    calc: (y: string) => number | null,
                    fmt: (v: number) => string): string {
  return `<tr><td>${name}</td>${years
    .map((y) => {
      const v = calc(y);
      return `<td class="num">${v === null ? "—" : fmt(v)}</td>`;
    })
    .join("")}</tr>`;
}

/**
 * Observations computed from the numbers.
 *
 * Deliberately mechanical: these restate what the data shows, they do not
 * judge the business. Anything requiring industry knowledge -- why a moat is
 * eroding, whether a regulatory change bites -- belongs in the user's own
 * notes, not in a generated paragraph that would read as authoritative.
 */
function observations(r: Report): { level: "bad" | "warn" | "good" | ""; text: string }[] {
  const out: { level: "bad" | "warn" | "good" | ""; text: string }[] = [];
  const a = r.annual;
  const years = Object.keys(a.revenue ?? {}).sort();
  if (!years.length) return out;
  const first = years[0];
  const last = years[years.length - 1];

  // Revenue against gross profit: the accounting-driven divergence that makes
  // some businesses look like they are shrinking when they are not.
  const revChg = a.revenue?.[last] / a.revenue?.[first] - 1;
  const gpChg = a.grossProfit?.[last] / a.grossProfit?.[first] - 1;
  if (isFinite(revChg) && isFinite(gpChg) && Math.abs(gpChg - revChg) > 0.25) {
    out.push({
      level: gpChg > revChg ? "good" : "bad",
      text: `${first}–${last}：营业收入 Revenue ${signed(revChg, 0)}，但毛利 Gross Profit ${signed(gpChg, 0)}。
        两者背离 ${Math.abs(gpChg - revChg) * 100 > 100 ? "极大" : "明显"} —— 用营收或市销率判断这家公司会得出相反结论。`,
    });
  }

  // How stable is the earnings base the valuation rests on?
  const ebits = years.map((y) => a.operatingIncome?.[y]).filter((v) => typeof v === "number");
  if (ebits.length >= 4) {
    const mx = Math.max(...ebits);
    const mn = Math.min(...ebits);
    if (mn < mx * 0.35) {
      out.push({
        level: "bad",
        text: `经营利润 EBIT 在过去十年间波动于 ${M(mn)} 至 ${M(mx)}。
          当前估值建立在最新的盈利水平上；若回落至区间下沿，估值倍数将变成
          ${r.valuation.enterpriseValue && mn > 0 ? (r.valuation.enterpriseValue / mn).toFixed(1) + "×" : "极高"}。
          <strong>这是本报告中最需要独立判断的一点。</strong>`,
      });
    }
  }

  // Current run-rate against the last full year.
  const ttmEbit = r.ttm.operatingIncome?.value;
  const fyEbit = a.operatingIncome?.[last];
  if (ttmEbit && fyEbit && Math.abs(ttmEbit / fyEbit - 1) > 0.12) {
    out.push({
      level: ttmEbit < fyEbit ? "bad" : "good",
      text: `过去十二个月 TTM 的经营利润为 ${M(ttmEbit)}，较 FY${last} 的 ${M(fyEbit)}
        ${signed(ttmEbit / fyEbit - 1, 1)}。<strong>筛选名单按财年数据排序，因此名单上的
        ${labelWithNote("evEbit")} 与当前运行率并不一致</strong>，以本页 TTM 口径为准。`,
    });
  }

  const gw = a.goodwill?.[last];
  const eq = a.equity?.[last];
  if (gw && eq && gw / eq > 0.35) {
    out.push({
      level: "warn",
      text: `商誉 Goodwill 占股东权益 Equity 的 ${pct(gw / eq, 0)}。
        一次减值即可抹去可观比例的净资产，并使市净率 P/B 的安全边际消失。`,
    });
  }

  const rnd = a.rnd?.[last];
  const rndFirst = a.rnd?.[first];
  const gpLast = a.grossProfit?.[last];
  const gpFirst = a.grossProfit?.[first];
  if (rnd && gpLast && rndFirst && gpFirst) {
    const now = rnd / gpLast;
    const then = rndFirst / gpFirst;
    if (now - then > 0.05) {
      out.push({
        level: "warn",
        text: `研发费用 R&D 占毛利的比例由 ${pct(then, 0)} 升至 ${pct(now, 0)}。
          维持现有毛利需要投入更多，经营杠杆的持续性因此存疑。`,
      });
    }
  }

  const bb = years.reduce((s, y) => s + (a.buybacks?.[y] ?? 0), 0);
  const mc = r.valuation.marketCap;
  if (bb > 0 && mc) {
    const div = years.reduce((s, y) => s + (a.dividends?.[y] ?? 0), 0);
    out.push({
      level: div === 0 ? "good" : "",
      text: `十年累计回购 Buybacks ${M(bb)}，相当于当前市值的 ${pct(bb / mc, 0)}。
        累计分红 ${M(div)}。${div === 0
          ? "<strong>全部股东回报以回购形式发放 —— 对新加坡税务居民无 30% 股息预扣，是结构性优势。</strong>"
          : "分红部分需承担 30% 预扣税。"}`,
    });
  }

  const cash = r.valuation.cash;
  if (cash && mc && cash / mc > 0.25) {
    out.push({
      level: "good",
      text: `现金 Cash 占市值的 ${pct(cash / mc, 0)}，有息负债 ${M(r.valuation.debt)}。
        企业价值 EV 仅 ${M(r.valuation.enterpriseValue)}，远低于市值。`,
    });
  }

  const pa = r.priceAnalysis;
  if (pa) {
    const reg = pa.trimmed ?? pa.all;
    if (reg && reg.alpha < -0.1) {
      out.push({
        level: "bad",
        text: `过去十年 ${pa.underperformed}/${pa.totalPeriods} 个观测期跑输市场，
          累计 ${signed(pa.cumStock, 0)} 对市场 ${signed(pa.cumMarket, 0)}。
          剔除异常值后年化 ${labelWithNote("alpha")} 约 ${signed(reg.alpha, 0)}。
          <strong>这是对「便宜」最有力的反驳：市场已反复对这家公司定价，且一直是对的。</strong>`,
      });
    }
  }

  return out;
}

/** Sector background for a company's SIC code. */
function sectorFor(sic: string | undefined, sectors: Sector[]): Sector | null {
  const n = parseInt(sic ?? "", 10);
  if (!isFinite(n)) return null;
  return sectors.find((x) => x.sic.some(([lo, hi]) => n >= lo && n <= hi)) ?? null;
}

/**
 * What the company says it does, quoted from its own annual report.
 *
 * Extraction is heuristic -- filings vary enormously in layout -- so anything
 * that does not read like a business description is dropped and the filing is
 * linked instead. A plausible-looking fragment lifted from the wrong section
 * would be worse than nothing.
 */
function businessSection(r: Report): string {
  const n = r.narrative;
  const src = n?.source;
  const link = src
    ? `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.form)} · ${esc(src.filed)}</a>`
    : "";

  if (!n?.businessOverview && !n?.competition) {
    return `<div class="callout warn"><span class="title">未能自动提取业务描述</span>
      <p>该公司年报的排版无法可靠解析。${src ? `请直接查阅原文：${link}` : ""}</p></div>`;
  }

  return `
${n.businessOverview ? `
<h4>业务概述 Business Overview</h4>
<div class="card" style="border-left:3px solid var(--border-strong)">
  <p style="margin:0;font-size:14.5px;line-height:1.75">${esc(n.businessOverview)}</p>
</div>` : ""}
${n.competition ? `
<h4>竞争格局（公司自述）Competition, in the company's words</h4>
<div class="card" style="border-left:3px solid var(--border-strong)">
  <p style="margin:0;font-size:14.5px;line-height:1.75">${esc(n.competition)}</p>
</div>` : ""}
${n.riskHeadings?.length ? `
<h4>风险因素 Risk Factors <span class="badge">公司自行披露 ${n.riskHeadings.length} 条</span></h4>
<div class="card">
  <ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.7">
    ${n.riskHeadings.map((h) => `<li style="margin-bottom:7px">${esc(h)}</li>`).join("")}
  </ul>
  <p class="hint" style="margin-bottom:0">
    这些是公司在年报 Item 1A 中<strong>自己列出</strong>的风险，法律上要求如实披露。
    排序按原文，不代表严重程度。
  </p>
</div>` : ""}
<p class="hint">以上均为公司年报原文摘录${link ? `（来源：${link}）` : ""}，未经改写。</p>`;
}

/** Editor-written sector background. Explicitly separated from anything quoted
 *  from a filing, so the reader always knows which is which. */
function sectorSection(sec: Sector | null): string {
  if (!sec) return "";
  const block = (zh: string, en: string, body: string) => `
    <h4 style="margin-top:18px">${zh} <span style="color:var(--faint);font-weight:400">${en}</span></h4>
    <p style="font-size:14.5px;line-height:1.75;margin:0">${body}</p>`;
  return `
<div class="callout" style="border-left-color:var(--accent)">
  <span class="title">板块：${esc(sec.name)} <span style="color:var(--faint);font-weight:400">${esc(sec.nameEn)}</span></span>
  <p>以下是<strong>编者撰写的行业背景</strong>，不是从财报提取的事实。它的作用是让你在读财务数字前，
     先知道这门生意是怎么回事、钱从哪来、什么会杀死它。</p>
</div>
<div class="card">
  ${block("这门生意怎么做", "How it works", sec.howItWorks)}
  ${block("竞争格局", "Competitive dynamics", sec.competition)}
  ${block("监管与政策", "Regulation", sec.regulation)}
  ${block("技术与结构性变化", "Technology & structural change", sec.technology)}
  <h4 style="margin-top:18px;color:var(--bad)">深度价值在这个板块的典型陷阱
    <span style="color:var(--faint);font-weight:400">Value traps here</span></h4>
  <p style="font-size:14.5px;line-height:1.75;margin:0">${sec.valueTrap}</p>
</div>`;
}

function financialTables(r: Report): string {
  const a = r.annual;
  const years = Object.keys(a.revenue ?? a.assets ?? {}).sort().slice(-10);
  if (!years.length) return `<p class="hint">没有可用的年度数据。</p>`;
  const head = `<thead><tr><th style="min-width:190px">${"　"}</th>${years
    .map((y) => `<th class="num">${y}</th>`).join("")}</tr></thead>`;

  const num = (k: string, y: string) => (a[k]?.[y] ?? null);
  const ratio = (n: string, d: string) => (y: string) => {
    const nv = num(n, y), dv = num(d, y);
    return nv !== null && dv ? nv / dv : null;
  };

  return `
<h4>损益表 Income Statement <span class="badge">百万美元 US$M</span></h4>
<div class="chart-wrap"><table>${head}<tbody>
  ${row("revenue", a.revenue ?? {}, years)}
  ${row("grossProfit", a.grossProfit ?? {}, years)}
  ${derivedRow(label("grossMargin"), years, ratio("grossProfit", "revenue"), (v) => pct(v))}
  ${row("operatingIncome", a.operatingIncome ?? {}, years)}
  ${derivedRow(label("operatingMargin"), years, ratio("operatingIncome", "revenue"), (v) => pct(v))}
  ${row("netIncome", a.netIncome ?? {}, years)}
  ${derivedRow(label("eps"), years,
    (y) => { const n = num("netIncome", y), s = num("dilutedShares", y); return n !== null && s ? n / s : null; },
    (v) => `$${v.toFixed(2)}`)}
  ${row("rnd", a.rnd ?? {}, years)}
</tbody></table></div>

<h4>现金流与资本配置 Cash Flow &amp; Capital Allocation <span class="badge">百万美元 US$M</span></h4>
<div class="chart-wrap"><table>${head}<tbody>
  ${row("cfo", a.cfo ?? {}, years)}
  ${row("capex", a.capex ?? {}, years)}
  ${row("buybacks", a.buybacks ?? {}, years)}
  ${row("dividends", a.dividends ?? {}, years)}
  ${row("sharesOutstanding", r.sharesOutstanding ?? {}, years, (v) => (v / 1e6).toFixed(1))}
</tbody></table></div>

<h4>资产负债表 Balance Sheet <span class="badge">百万美元 US$M</span></h4>
<div class="chart-wrap"><table>${head}<tbody>
  ${row("assets", a.assets ?? {}, years)}
  ${row("assetsCurrent", a.assetsCurrent ?? {}, years)}
  ${row("cash", a.cash ?? {}, years)}
  ${row("liabilities", a.liabilities ?? {}, years)}
  ${row("liabilitiesCurrent", a.liabilitiesCurrent ?? {}, years)}
  ${row("ltDebt", a.ltDebt ?? {}, years)}
  ${row("equity", a.equity ?? {}, years)}
  ${row("goodwill", a.goodwill ?? {}, years)}
  ${derivedRow(label("bookValuePerShare"), years,
    (y) => { const e = num("equity", y), s = r.sharesOutstanding?.[y]; return e !== null && s ? e / s : null; },
    (v) => `$${v.toFixed(2)}`)}
</tbody></table></div>

<h4>回报率 Returns</h4>
<div class="chart-wrap"><table>${head}<tbody>
  ${derivedRow(labelWithNote("roe"), years, ratio("netIncome", "equity"), (v) => pct(v))}
  ${derivedRow(labelWithNote("roic"), years,
    (y) => { const e = num("equity", y), c = num("cash", y), o = num("operatingIncome", y);
             return e !== null && c !== null && o !== null && e - c > 0 ? o / (e - c) : null; },
    (v) => pct(v))}
  ${derivedRow(`商誉 / 净资产 <span style="color:var(--faint);font-weight:400">Goodwill / Equity</span>`,
    years, ratio("goodwill", "equity"), (v) => pct(v, 0))}
  ${derivedRow(`研发 / 毛利 <span style="color:var(--faint);font-weight:400">R&amp;D / Gross Profit</span>`,
    years, ratio("rnd", "grossProfit"), (v) => pct(v, 0))}
</tbody></table></div>`;
}

function quarterTable(r: Report): string {
  const q = r.quarterly?.revenue ?? [];
  if (q.length < 2) return "";
  const keys: [string, string][] = [
    ["revenue", "revenue"], ["grossProfit", "grossProfit"],
    ["operatingIncome", "operatingIncome"], ["netIncome", "netIncome"],
  ];
  const ends = q.slice(-8).map((x) => x.end);
  return `
<h4>季度趋势 Quarterly Trend <span class="badge">百万美元 US$M</span></h4>
<div class="chart-wrap"><table>
  <thead><tr><th style="min-width:190px">　</th>${ends.map((e) => `<th class="num">${e.slice(2, 7)}</th>`).join("")}</tr></thead>
  <tbody>${keys.map(([k]) => {
    const series = r.quarterly?.[k] ?? [];
    const byEnd = new Map(series.map((s) => [s.end, s.val]));
    return `<tr><td>${label(k)}</td>${ends
      .map((e) => `<td class="num">${byEnd.has(e) ? M(byEnd.get(e)!) : "—"}</td>`).join("")}</tr>`;
  }).join("")}
  <tr><td>同比 YoY <span style="color:var(--faint);font-weight:400">Revenue</span></td>${ends
    .map((e) => {
      const cur = (r.quarterly?.revenue ?? []).find((x) => x.end === e)?.val;
      const yr = String(+e.slice(0, 4) - 1) + e.slice(4);
      const prev = (r.quarterly?.revenue ?? []).find((x) => x.end === yr)?.val;
      const v = cur && prev ? cur / prev - 1 : null;
      return `<td class="num ${v !== null && v < 0 ? "neg" : v !== null ? "pos" : ""}">${signed(v)}</td>`;
    }).join("")}</tr>
  </tbody>
</table></div>
<p class="hint">季度数据来自 10-Q 申报。第四季度不单独申报，故序列存在年度缺口；
  过去十二个月 TTM 由「本期年初至今 + 上一财年 − 去年同期年初至今」构造，不受该缺口影响。</p>`;
}

function priceSection(r: Report): string {
  const pa = r.priceAnalysis;
  if (!pa) {
    return `<div class="callout warn"><span class="title">价格数据不足</span>
      <p>该公司的公众持股市值 Public Float 申报记录少于四期，无法构造收益序列。</p></div>`;
  }
  const reg = (k: "all" | "trimmed" | "recent", name: string) => {
    const x = pa[k];
    if (!x) return "";
    return `<tr><td>${name}</td>
      <td class="num">${x.beta.toFixed(2)}</td>
      <td class="num ${x.alpha < 0 ? "neg" : "pos"}"><strong>${signed(x.alpha, 1)}</strong></td>
      <td class="num">${x.r2 ?? "—"}</td>
      <td class="num">${x.n}</td></tr>`;
  };
  const best = pa.trimmed ?? pa.all;
  // Enough anchors to show a trajectory, too few for a meaningful regression.
  const noRegression = !pa.all && !pa.trimmed;

  return `
<h4>价格轨迹 Price Trajectory</h4>
<div class="chart-wrap"><table>
  <thead><tr><th>${labelWithNote("publicFloat")} 测量日</th><th class="num">隐含股价 Implied Price</th></tr></thead>
  <tbody>${r.priceAnchors.map((p) => `<tr><td>${p.date}</td><td class="num">$${p.price.toFixed(2)}</td></tr>`).join("")}
    ${r.valuation.price ? `<tr class="hl"><td>当前 Current</td><td class="num">$${r.valuation.price.toFixed(2)}</td></tr>` : ""}
  </tbody>
</table></div>
<p class="hint">
  隐含股价 = 公众持股市值 ÷ 流通股数。公众持股市值剔除内部人持股，故绝对水平系统性低于真实股价；
  若内部人持股比例大致稳定，<strong>期间收益率仍然可用</strong>。这是在没有付费行情源的情况下能取得的最长真实序列。
</p>

<h4>逐期收益 Period Returns <span class="badge">已年化 annualised</span></h4>
<div class="chart-wrap"><table>
  <thead><tr><th>区间</th><th class="num">年数</th><th class="num">本股 Stock</th>
    <th class="num">市场 Market</th><th class="num">超额 Excess</th></tr></thead>
  <tbody>${pa.periods.map((p) => {
    const ex = p.stock - p.market;
    return `<tr><td>${p.from.slice(0, 7)} → ${p.to.slice(0, 7)}</td>
      <td class="num">${p.years.toFixed(1)}</td>
      <td class="num ${p.stock < 0 ? "neg" : "pos"}">${signed(p.stock)}</td>
      <td class="num">${signed(p.market)}</td>
      <td class="num ${ex < 0 ? "neg" : "pos"}"><strong>${signed(ex)}</strong></td></tr>`;
  }).join("")}</tbody>
</table></div>
<p class="hint">市场收益取自 Ken French Data Library（CRSP 全市场，含股息再投资）。</p>

<h4>${labelWithNote("beta")}<span style="font-weight:400;color:var(--muted)"> —— 系统性风险</span></h4>
${noRegression
    ? `<div class="callout warn"><span class="title">观测期不足，不做回归</span>
       <p>仅有 ${pa.totalPeriods} 个年度观测。样本这么小时，${labelWithNote("beta")} 与
       ${labelWithNote("alpha")} 会被单期行情完全主导，算出来的数字看似精确、实则无意义。
       上方的逐期收益与累计表现仍然可用。</p></div>`
    : `<div class="chart-wrap"><table>
  <thead><tr><th>口径</th><th class="num">${labelWithNote("beta")}</th>
    <th class="num">${labelWithNote("alpha")} /年</th><th class="num">${labelWithNote("r2")}</th>
    <th class="num">观测数 n</th></tr></thead>
  <tbody>
    ${reg("all", "全部观测 All periods")}
    ${reg("trimmed", `剔除异常值 Outlier removed<div style="font-size:11px;color:var(--faint)">${pa.trimmedPeriod}</div>`)}
    ${reg("recent", "最近五期 Recent five")}
  </tbody>
</table></div>`}
${pa.all && pa.trimmed && Math.abs(pa.all.beta - pa.trimmed.beta) > 1
    ? `<div class="callout warn"><span class="title">全样本的 Beta 不可采信</span>
       <p>剔除单一异常期（${pa.trimmedPeriod}）后，Beta 由 ${pa.all.beta.toFixed(2)} 降至
       ${pa.trimmed.beta.toFixed(2)}。少数几个年度观测很容易被一期极端行情主导，
       <strong>应以剔除后的估计为准</strong>。</p></div>`
    : ""}

<h4>${labelWithNote("alpha")}<span style="font-weight:400;color:var(--muted)"> —— 超额收益</span></h4>
${best ? `
<div class="grid c4">
  <div class="stat"><div class="k">年化 Alpha</div>
    <div class="v ${best.alpha < 0 ? "bad" : "good"}">${signed(best.alpha, 1)}</div>
    <div class="s">剔除异常值口径</div></div>
  <div class="stat"><div class="k">跑输期数 Underperformed</div>
    <div class="v ${pa.underperformed > pa.totalPeriods / 2 ? "bad" : ""}">${pa.underperformed}/${pa.totalPeriods}</div>
    <div class="s">对市场</div></div>
  <div class="stat"><div class="k">十年累计 Cumulative</div>
    <div class="v ${pa.cumStock < 0 ? "bad" : "good"}">${signed(pa.cumStock, 0)}</div>
    <div class="s">市场 ${signed(pa.cumMarket, 0)}</div></div>
  <div class="stat"><div class="k">距高点 From Peak</div>
    <div class="v bad">${r.valuation.price ? signed(r.valuation.price / pa.peak - 1, 0) : "—"}</div>
    <div class="s">高点 $${pa.peak.toFixed(2)}</div></div>
</div>
<p>
  Alpha 的稳健性通常高于 Beta：剔除异常值后 Beta 变化剧烈，而 Alpha 在三种口径下
  ${pa.recent ? `（${signed(pa.all!.alpha, 0)} / ${signed(pa.trimmed!.alpha, 0)} / ${signed(pa.recent.alpha, 0)}）` : ""}
  方向一致。<strong>若 Alpha 长期显著为负，说明该股持续跑输其市场敏感度所能解释的水平</strong> ——
  这是对低估值最直接的反驳，也可能意味着这门生意的经济特性比财报呈现的更差。
</p>
<p class="hint">
  方法局限：观测为年度且期数少（n=${best.n}），统计功效低；${pa.trimmed?.r2 !== null
    ? `拟合优度 R² 仅 ${pa.trimmed?.r2}，即市场因子只能解释该股约 ${pct(pa.trimmed?.r2 ?? 0, 0)} 的收益变动，其余为个股特有波动。`
    : ""}
  更可靠的做法是用月度数据做三因子或五因子回归，需要付费行情源提供的完整日线。
</p>` : ""}`;
}

export function render(ctx: Ctx): string {
  const held = new Set(ctx.book.holdings.map((h) => h.ticker));
  const screened = ctx.targets.us;
  const inScreen = new Set(screened.map((c) => c.ticker));
  const extra = [...held].filter((t) => !inScreen.has(t)).sort();

  const chip = (t: string, sub: string, active: boolean, tag: string) =>
    `<button class="btn pick${active ? " primary" : ""}" data-t="${esc(t)}"
       style="display:flex;flex-direction:column;align-items:flex-start;gap:1px;padding:7px 12px;min-width:104px">
       <span style="font-weight:650">${esc(t)}${tag}</span>
       <span style="font-size:11px;opacity:.75;font-weight:400">${esc(sub)}</span>
     </button>`;

  const report = current ? cache.get(current) : null;

  return `
<h2>公司研究 <span style="font-weight:400;color:var(--muted);font-size:20px">Company Research</span></h2>
<p class="lede">
  持仓、筛选名单、以及需要调仓的标的的基本面报告。数据来自 SEC EDGAR 申报，
  由私有仓库的管线每晚生成。
</p>

${held.size ? `<h3>当前持仓 Held</h3>
<div class="row" style="margin-top:0">${[...held].sort()
    .map((t) => chip(t, inScreen.has(t) ? "在名单内" : "已不在名单", t === current,
      inScreen.has(t) ? "" : ' <span class="badge warn">!</span>')).join("")}</div>` : ""}

<h3>筛选名单 Screen${ctx.targets.asOf ? ` <span class="badge">${ctx.targets.asOf}</span>` : ""}</h3>
<div class="row" style="margin-top:0">${screened.slice(0, 30)
    .map((c) => chip(c.ticker, `EV/EBIT ${c.metric.toFixed(1)}`, c.ticker === current, "")).join("")}</div>
${extra.length ? `<p class="hint">另有 ${extra.length} 只持仓已不在名单：${extra.map(esc).join("、")}</p>` : ""}

<div id="report" style="margin-top:26px">
${loading ? `<div class="empty"><div class="big">⏳</div>正在载入 ${esc(loading)} 的报告…</div>` : ""}
${error ? `<div class="callout bad"><span class="title">载入失败</span><p>${esc(error)}</p></div>` : ""}
${!current && !loading ? `<div class="empty"><div class="big">◇</div>
   <p>选择上方任一标的查看报告</p></div>` : ""}
${report ? renderReport(report, ctx.industries.sectors ?? []) : ""}
</div>`;
}

function renderReport(r: Report, sectors: Sector[]): string {
  const v = r.valuation;
  const m = r.meta;
  const obs = observations(r);
  const sec = sectorFor(m.sic, sectors);
  const badge = { bad: "bad", warn: "warn", good: "good", "": "" } as const;

  return `
<hr style="border:none;border-top:1px solid var(--border);margin:0 0 22px">
<h2 style="margin-bottom:2px">${esc(m.name ?? r.ticker)} <span class="badge">${esc(r.ticker)}</span></h2>
<p class="hint" style="margin-top:0">
  ${esc(m.sicDescription ?? "")}${m.sic ? `（SIC ${m.sic}）` : ""} ·
  注册地 ${esc(m.country ?? "—")} · ${(m.exchanges ?? []).map(esc).join("/")} ·
  最近定期报告 ${esc(m.latestForm ?? "—")} ${esc(m.latestFiling ?? "")} ·
  报告生成于 ${esc(r.generated)}
</p>

<h3>这家公司是做什么的 What the Company Does</h3>
${businessSection(r)}

<h3>行业背景 Sector Context</h3>
${sectorSection(sec)}

<h3>估值 Valuation</h3>
<div class="grid c4">
  <div class="stat"><div class="k">${labelWithNote("marketCap")}</div><div class="v">${M(v.marketCap)}</div>
    <div class="s">${v.price ? `$${v.price.toFixed(2)} × ${(v.shares ?? 0) / 1e6}M 股` : ""}</div></div>
  <div class="stat"><div class="k">${labelWithNote("enterpriseValue")}</div><div class="v">${M(v.enterpriseValue)}</div>
    <div class="s">现金 ${M(v.cash)} · 债务 ${M(v.debt)}</div></div>
  <div class="stat"><div class="k">${labelWithNote("evEbit")}</div>
    <div class="v ${(v.evEbitTtm ?? 99) < 6 ? "good" : ""}">${v.evEbitTtm ?? "—"}×</div>
    <div class="s">TTM 口径</div></div>
  <div class="stat"><div class="k">${labelWithNote("pb")}</div><div class="v">${v.pb ?? "—"}×</div>
    <div class="s">${labelWithNote("pe")} ${v.peTtm ?? "—"}×</div></div>
</div>
<p class="hint">盈利口径：${esc(v.ebitBasis)}</p>

<h3>过去十二个月 TTM vs 上一财年 FY</h3>
<div class="chart-wrap"><table>
  <thead><tr><th style="min-width:190px">　</th><th class="num">TTM</th><th class="num">上一财年 Last FY</th><th class="num">变化 Change</th></tr></thead>
  <tbody>${(["revenue", "grossProfit", "operatingIncome", "netIncome", "cfo"] as const).map((k) => {
    const t = r.ttm[k]?.value;
    const years = Object.keys(r.annual[k] ?? {}).sort();
    const fy = years.length ? r.annual[k][years[years.length - 1]] : null;
    const ch = t && fy ? t / fy - 1 : null;
    return `<tr><td>${label(k)}</td><td class="num"><strong>${M(t)}</strong></td>
      <td class="num">${M(fy)}</td>
      <td class="num ${ch !== null && ch < 0 ? "neg" : ch !== null ? "pos" : ""}">${signed(ch)}</td></tr>`;
  }).join("")}</tbody>
</table></div>

${quarterTable(r)}

<h3>五年 / 十年财务 Financials</h3>
${financialTables(r)}

<h3>股价表现 Price Performance</h3>
${priceSection(r)}

<h3>数据观察 Observations</h3>
${obs.length
    ? obs.map((o) => `<div class="callout ${badge[o.level]}"><p style="margin:0">${o.text}</p></div>`).join("")
    : `<p class="hint">没有触发任何自动观察项。</p>`}
<p class="hint">
  以上为<strong>由数据机械推导</strong>的观察，不含行业判断。
  竞争格局、监管变化、技术路线等需要产业知识的内容不会自动生成 ——
  那类判断应由你自行研究后记录，而不是由程序写出一段看起来权威的文字。
</p>

<h3>数据来源 Sources</h3>
<div class="card">
  <table class="rules"><tbody>
    <tr><td>财务数据</td><td>SEC EDGAR XBRL <code>companyfacts</code>，取 10-K / 10-Q 申报值，重述以最新申报为准</td></tr>
    <tr><td>公司元数据</td><td>SEC EDGAR <code>submissions</code></td></tr>
    <tr><td>价格锚点</td><td>SEC <code>dei:EntityPublicFloat</code> ÷ 流通股数</td></tr>
    <tr><td>市场收益率</td><td>Ken French Data Library（CRSP 全市场）</td></tr>
    <tr><td>现价</td><td>私有仓库每晚筛选输出（Alpaca 日线）</td></tr>
  </tbody></table>
  <p class="hint" style="margin-bottom:0">
    本报告为研究材料，非投资建议。所有比率均由上述原始申报数据现场计算。
  </p>
</div>`;
}

export function mount(root: HTMLElement, ctx: Ctx): void {
  root.querySelectorAll<HTMLButtonElement>(".pick").forEach((b) =>
    b.addEventListener("click", async () => {
      const t = b.dataset.t!;
      if (t === current) return;
      error = null;
      if (cache.has(t)) {
        current = t;
        ctx.refresh();
        return;
      }
      loading = t;
      current = null;
      ctx.refresh();
      try {
        const rep = await ctx.report(t);
        cache.set(t, rep);
        current = t;
      } catch (e) {
        error = `${t}: ${(e as Error).message}`;
      } finally {
        loading = null;
        ctx.refresh();
      }
    }),
  );
}

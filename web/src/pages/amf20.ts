import type { Ctx } from "../main";
import type { Candidate } from "../types";
import { type Book, type Holding, loadHistory, recordValue } from "../store";
import { maxDrawdown, sharpe, sharpeNeedsMore, simpleReturn, xirr, type CashFlow } from "../metrics";
import { usd } from "../fmt";

export const title = "AMF-20";
export const icon = "▦";

const DAY = 86_400_000;

/** Fallbacks only. The live thresholds come from the private repo via
 *  targets.config -- hardcoding them here would publish them, since this
 *  bundle is served from a public site. */
const FALLBACK_CFG = { fScoreExit: 0, fScoreWatch: 0, advOrderCap: 0.1, minAdvUsd: 0 };

interface Lot {
  id: string;
  shares: number;
  cost: number;
  openedAt: string;
  note?: string;
}

interface Position {
  ticker: string;
  name: string;
  lots: Lot[];
  shares: number;
  costTotal: number;
  avgCost: number;
  price: number | null;
  value: number;
  pnl: number;
  pnlPct: number | null;
  xirr: number | null;
  weight: number;
  firstBuy: string;
  days: number;
  fScore: number | null;
  fAvail: number | null;
  evEbit: number | null;
  inScreen: boolean;
  known: boolean;
}

interface Trigger {
  level: "now" | "soon" | "info";
  what: string;
  why: string;
}

function esc(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function nextRebalance(month: number): Date {
  const now = new Date();
  const y = now.getFullYear();
  const thisYear = new Date(y, month - 1, 1);
  return thisYear > now ? thisYear : new Date(y + 1, month - 1, 1);
}

function analyse(ctx: Ctx) {
  const s = ctx.settings;
  const book = ctx.book;
  const facts = ctx.facts.facts;
  const screened = new Set(ctx.targets.us.map((c) => c.ticker));
  const cfg = { ...FALLBACK_CFG, ...(ctx.targets.config ?? {}) };

  // Group lots by ticker: the same name bought three times is one position,
  // but each tranche keeps its own date and price for the return maths.
  const byTicker = new Map<string, Lot[]>();
  for (const h of book.holdings) {
    if (!byTicker.has(h.ticker)) byTicker.set(h.ticker, []);
    byTicker.get(h.ticker)!.push(h);
  }

  const positions: Position[] = [];
  for (const [ticker, lots] of byTicker) {
    lots.sort((a, b) => a.openedAt.localeCompare(b.openedAt));
    const fact = facts[ticker];
    const price = fact?.p ?? null;
    const shares = lots.reduce((a, l) => a + l.shares, 0);
    const costTotal = lots.reduce((a, l) => a + l.shares * l.cost, 0);
    const value = price !== null ? shares * price : costTotal;

    // Money-weighted return: each tranche is a cash outflow on its own date,
    // today's market value is the inflow.
    const flows: CashFlow[] = lots.map((l) => ({
      date: new Date(l.openedAt),
      amount: -l.shares * l.cost,
    }));
    flows.push({ date: new Date(), amount: value });

    positions.push({
      ticker,
      name: fact?.n ?? "",
      lots,
      shares,
      costTotal,
      avgCost: shares ? costTotal / shares : 0,
      price,
      value,
      pnl: value - costTotal,
      pnlPct: simpleReturn(costTotal, value),
      xirr: price !== null ? xirr(flows) : null,
      weight: 0,
      firstBuy: lots[0].openedAt,
      days: Math.floor((Date.now() - Date.parse(lots[0].openedAt)) / DAY),
      fScore: fact?.f ?? null,
      fAvail: fact?.fa ?? null,
      evEbit: fact?.ee ?? null,
      inScreen: screened.has(ticker),
      known: !!fact,
    });
  }

  const invested = positions.reduce((a, p) => a + p.value, 0);
  const total = invested + book.cashUsd;
  positions.forEach((p) => (p.weight = total ? (p.value / total) * 100 : 0));
  positions.sort((a, b) => b.value - a.value);

  const costAll = positions.reduce((a, p) => a + p.costTotal, 0);
  const history = recordValue(total);

  // Portfolio-level money-weighted return over every tranche ever bought.
  const allFlows: CashFlow[] = book.holdings.map((h) => ({
    date: new Date(h.openedAt),
    amount: -h.shares * h.cost,
  }));
  if (invested > 0) allFlows.push({ date: new Date(), amount: invested });

  const reb = nextRebalance(s.rebalanceMonth);
  const daysToReb = Math.ceil((reb.getTime() - Date.now()) / DAY);
  const building = positions.length < s.usPositions * 0.5;

  // ---- rebalance triggers ------------------------------------------------
  const triggers: Trigger[] = [];

  for (const p of positions.filter((x) => x.weight > s.trimPct)) {
    triggers.push({
      level: "now",
      what: `减仓 ${p.ticker}：占 ${p.weight.toFixed(1)}%，超过 ${s.trimPct}% 上限`,
      why: `卖出约 ${usd(p.value - (total * s.trimPct) / 100)}，削回等权。等权重是这套策略收益的来源，让赢家无限膨胀等于放弃它。`,
    });
  }

  for (const p of positions.filter((x) => x.fScore !== null && x.fScore <= cfg.fScoreExit)) {
    triggers.push({
      level: "now",
      what: `卖出 ${p.ticker}：F-Score 已跌至 ${p.fScore}/${p.fAvail}`,
      why: `买入时质量分不低于 ${cfg.fScoreMin ?? "门槛"}，跌到 ${cfg.fScoreExit} 分及以下属于基本面崩坏而非波动。这是本策略唯一承认的「不等调仓日就卖」的信号。`,
    });
  }

  for (const p of positions.filter(
    (x) => x.fScore !== null && x.fScore > cfg.fScoreExit && x.fScore <= cfg.fScoreWatch,
  )) {
    triggers.push({
      level: "info",
      what: `留意 ${p.ticker}：F-Score 降到 ${p.fScore}/${p.fAvail}`,
      why: "尚未触及卖出线，不要动手。记下来，调仓日一并处理。",
    });
  }

  for (const p of positions.filter((x) => !x.known)) {
    triggers.push({
      level: "soon",
      what: `${p.ticker} 查不到数据`,
      why: "可能已被收购、退市或改代码。去券商确认——如果是被收购，你没有选择，按现金处理并在调仓时补仓。",
    });
  }

  if (!building && daysToReb <= 30) {
    triggers.push({
      level: "now",
      what: `${daysToReb} 天后是调仓日`,
      why: "重跑筛选：满 12 个月且已不在名单的卖出，用等权重补齐目标持仓数。一年只有这一次全面调整。",
    });
  }

  const stale = positions.filter((p) => p.days >= 365 && !p.inScreen);
  if (stale.length && !building) {
    triggers.push({
      level: "info",
      what: `${stale.length} 只已满 12 个月且不在当前名单：${stale.map((p) => p.ticker).join("、")}`,
      why: "调仓日卖出。现在不要动——提前卖只是白付价差。",
    });
  }

  return {
    book, positions, total, invested, costAll, history, building, cfg,
    reb, daysToReb, triggers,
    cashPct: total ? (book.cashUsd / total) * 100 : 0,
    totalPnl: invested - costAll,
    totalPnlPct: simpleReturn(costAll, invested),
    portfolioXirr: xirr(allFlows),
    sharpeVal: sharpe(history),
    sharpeGap: sharpeNeedsMore(history),
    maxDd: maxDrawdown(history),
  };
}

function buildOrders(ctx: Ctx, capital: number, held: Set<string>) {
  const s = ctx.settings;
  const perPos = (capital * (s.usWeight / 100)) / Math.max(s.usPositions, 1);
  const cap = ctx.targets.config?.advOrderCap ?? 0.1;
  const slots = Math.max(s.usPositions - held.size, 0);
  const orders: {
    c: Candidate; shares: number; cost: number; flags: string[];
  }[] = [];
  const skipped: { ticker: string; why: string }[] = [];

  for (const c of ctx.targets.us) {
    if (orders.length >= slots) break;
    if (held.has(c.ticker)) continue;
    if (!c.price || c.price <= 0) {
      skipped.push({ ticker: c.ticker, why: "没有价格数据" });
      continue;
    }
    const shares = Math.floor(perPos / c.price);
    if (shares < 1) {
      skipped.push({ ticker: c.ticker, why: `股价 ${usd(c.price)} 超过单仓 ${usd(perPos)}` });
      continue;
    }
    const cost = shares * c.price;
    const flags: string[] = [];
    if (c.adv && cost > c.adv * cap) {
      flags.push(`占日均成交额 ${((cost / c.adv) * 100).toFixed(0)}%，分几天买`);
    }
    if (c.debtEstimated) flags.push("债务未披露，估值已按保守上限处理");
    const drag = (c.divYield ?? 0) * 0.3;
    if (drag > 0.015) flags.push(`股息预扣拖累 ${(drag * 100).toFixed(1)}%/年`);
    orders.push({ c, shares, cost, flags });
  }
  return { orders, skipped, perPos };
}

const LEVEL = { now: ["bad", "立即"], soon: ["warn", "近期"], info: ["", "留意"] } as const;

export function render(ctx: Ctx): string {
  const a = analyse(ctx);
  const s = ctx.settings;
  const held = new Set(a.positions.map((p) => p.ticker));
  const { orders, skipped, perPos } = buildOrders(ctx, s.capitalUsd, held);

  const metric = (k: string, v: string, cls = "", sub = "") =>
    `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div>
     <div class="s">${sub}</div></div>`;

  const pct = (v: number | null, d = 1) =>
    v === null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
  const sign = (v: number | null) => (v === null ? "" : v >= 0 ? "good" : "bad");

  return `
<h2>AMF-20 <span class="badge">Acquirer's Multiple × F-Score · 20 只等权</span></h2>

<div class="card">
  <div class="grid c3">
    <div>
      <label for="cap">投入资金（USD）</label>
      <input type="number" id="cap" value="${s.capitalUsd}" min="1000" step="1000" />
      <div class="hint">改这个数字，下方买入清单的股数即时重算</div>
    </div>
    <div>
      <label for="cash">当前现金（USD）</label>
      <input type="number" id="cash" value="${a.book.cashUsd}" min="0" step="100" />
      <div class="hint">用于计算实际配置比例</div>
    </div>
    <div>
      <label>每仓目标金额</label>
      <div style="font-family:var(--mono);font-size:22px;font-weight:600;padding-top:4px">${usd(perPos)}</div>
      <div class="hint">${s.usWeight}% ÷ ${s.usPositions} 只</div>
    </div>
  </div>
</div>

<h3>组合表现</h3>
<div class="grid c4">
  ${metric("总资产", usd(a.total), "", `持仓 ${usd(a.invested)} + 现金 ${usd(a.book.cashUsd)}`)}
  ${metric("累计盈亏", usd(a.totalPnl), sign(a.totalPnl), `成本 ${usd(a.costAll)}`)}
  ${metric("收益率", pct(a.totalPnlPct), sign(a.totalPnlPct), "对总投入成本")}
  ${metric(
    "年化（XIRR）", pct(a.portfolioXirr), sign(a.portfolioXirr),
    a.portfolioXirr === null ? "需要至少两笔、跨一天以上" : "资金加权，已处理分批买入",
  )}
</div>
<div class="grid c4">
  ${metric("持仓数", `${a.positions.length} <span style="font-size:14px;color:var(--faint)">/ ${s.usPositions}</span>`, "", a.building ? "建仓中" : "已建满")}
  ${metric("现金比例", `${a.cashPct.toFixed(1)}%`, "", `目标 ${100 - s.usWeight}%`)}
  ${metric(
    "Sharpe", a.sharpeVal === null ? "—" : a.sharpeVal.toFixed(2), "",
    a.sharpeVal === null ? `还需 ${a.sharpeGap} 天记录` : `基于 ${a.history.length} 天记录`,
  )}
  ${metric(
    "最大回撤", a.maxDd === null ? "—" : `${(a.maxDd * 100).toFixed(1)}%`, a.maxDd ? "bad" : "",
    a.maxDd === null ? "记录不足" : "自开始记录以来",
  )}
</div>
${
    a.sharpeVal === null && a.positions.length
      ? `<p class="hint">Sharpe 和最大回撤需要每日净值序列，而买入价推不出历史净值 ——
         只能从今天起累积。每打开一次页面记录一天，约 ${a.sharpeGap} 天后这两个数字才有意义。</p>`
      : ""
  }

<h3>当前持仓</h3>
<p class="hint" style="margin-top:-4px">
  ${ctx.facts.asOf ? `价格与质量分更新于 ${ctx.facts.asOf}` : "⚠ 尚无数据，市值按买入成本估算"}
</p>
<div class="chart-wrap">
<table>
  <thead><tr><th>代码</th><th>股数</th><th>均价</th><th>现价</th><th>市值</th><th>权重</th>
    <th>盈亏</th><th>收益率</th><th>年化</th><th>F-Score</th><th>EV/EBIT</th><th>持有</th><th></th></tr></thead>
  <tbody>${
    a.positions.length
      ? a.positions
          .map((p) => {
            const fCls = p.fScore === null ? "" : p.fScore <= a.cfg.fScoreExit ? "neg"
              : p.fScore <= a.cfg.fScoreWatch ? "" : "pos";
            return `<tr>
      <td><strong>${esc(p.ticker)}</strong>${p.name ? `<div style="font-size:11px;color:var(--faint)">${esc(p.name)}</div>` : ""}
        ${p.lots.length > 1 ? `<span class="badge">${p.lots.length} 批</span>` : ""}</td>
      <td class="num">${p.shares.toLocaleString()}</td>
      <td class="num">$${p.avgCost.toFixed(2)}</td>
      <td class="num">${p.price === null ? "—" : "$" + p.price.toFixed(2)}</td>
      <td class="num">${usd(p.value)}</td>
      <td class="num"><strong>${p.weight.toFixed(1)}%</strong></td>
      <td class="num ${p.pnl >= 0 ? "pos" : "neg"}">${usd(p.pnl)}</td>
      <td class="num ${sign(p.pnlPct)}">${pct(p.pnlPct)}</td>
      <td class="num ${sign(p.xirr)}">${pct(p.xirr)}</td>
      <td class="num ${fCls}">${p.fScore === null ? "—" : `${p.fScore}/${p.fAvail}`}</td>
      <td class="num">${p.evEbit === null ? "—" : p.evEbit.toFixed(2)}</td>
      <td class="num">${p.days}天${p.inScreen ? ' <span class="badge good">在名单</span>' : ""}</td>
      <td><button class="btn drop" data-t="${esc(p.ticker)}" style="padding:2px 8px;font-size:11px">删</button></td>
    </tr>${
      p.lots.length > 1
        ? `<tr><td colspan="13" style="text-align:left;padding-top:0;font-size:12px;color:var(--faint)">
             ${p.lots.map((l) => `${l.openedAt.slice(0, 10)}: ${l.shares} 股 @ $${l.cost}`).join("　·　")}
           </td></tr>`
        : ""
    }`;
          })
          .join("")
      : `<tr><td colspan="13" style="text-align:center;color:var(--faint);padding:26px">还没有持仓</td></tr>`
  }</tbody>
</table>
</div>

<h3>录入买入</h3>
<div class="card">
  <div class="grid c4">
    <div><label for="tk">代码</label><input type="text" id="tk" placeholder="AAPL" /></div>
    <div><label for="sh">股数</label><input type="number" id="sh" min="0" step="1" /></div>
    <div><label for="cb">买入价（每股）</label><input type="number" id="cb" min="0" step="0.01" /></div>
    <div><label for="dt">买入日期</label><input type="text" id="dt" value="${new Date().toISOString().slice(0, 10)}" /></div>
  </div>
  <label for="nt">认错条件（可选）</label>
  <input type="text" id="nt" placeholder="出现什么情况我承认判断错了" />
  <div class="hint">同一只票分批买入就多录几次，系统会按各自的日期和价格算年化收益。</div>
  <div class="row"><button class="btn primary" id="add">添加</button>
    <span id="msg" style="font-size:13px"></span></div>
</div>

<h3>你现在该做什么</h3>
${
    orders.length
      ? `<div class="card" style="border-left:3px solid var(--good)">
           <strong>按 ${usd(s.capitalUsd)} 资金、每仓 ${usd(perPos)} 算出的买入清单</strong>
           <p style="margin:6px 0 0;color:var(--muted);font-size:13.5px">
             照单执行，<strong>不要挑</strong>。等权重买满是这套策略的全部要点，挑着买就变成了押注个股。
           </p>
         </div>
         <div class="chart-wrap"><table>
           <thead><tr><th>操作</th><th>代码</th><th>名称</th><th>股数</th><th>现价</th><th>金额</th><th>EV/EBIT</th><th>F</th></tr></thead>
           <tbody>${orders
             .map(
               (o) => `<tr>
             <td><span class="badge good">买入</span></td>
             <td><strong>${esc(o.c.ticker)}</strong></td>
             <td style="text-align:left">${esc(o.c.name)}</td>
             <td class="num"><strong>${o.shares.toLocaleString()}</strong></td>
             <td class="num">$${o.c.price!.toFixed(2)}</td>
             <td class="num">${usd(o.cost)}</td>
             <td class="num">${o.c.metric.toFixed(2)}</td>
             <td class="num">${esc(o.c.quality.replace("F ", ""))}</td>
           </tr>${
             o.flags.length
               ? `<tr><td colspan="8" style="text-align:left;padding-top:0;font-size:12px;color:var(--warn)">⚠ ${o.flags.map(esc).join(" · ")}</td></tr>`
               : ""
           }`,
             )
             .join("")}</tbody>
         </table></div>
         <p class="hint">合计 ${usd(orders.reduce((x, o) => x + o.cost, 0))}${
           skipped.length ? ` · ${skipped.length} 只被跳过（${skipped.slice(0, 3).map((k) => esc(k.ticker)).join("、")}${skipped.length > 3 ? "…" : ""}）` : ""
         }</p>`
      : ""
  }
${
    a.triggers.length
      ? a.triggers
          .map((t) => {
            const [cls, label] = LEVEL[t.level];
            return `<div class="callout ${cls}"><span class="title">
              <span class="badge ${cls}">${label}</span> ${esc(t.what)}</span><p>${esc(t.why)}</p></div>`;
          })
          .join("")
      : orders.length
        ? ""
        : `<div class="card" style="border-left:3px solid var(--good)">
             <strong>没有需要动手的事。</strong>
             <p style="margin:6px 0 0;color:var(--muted)">配置在范围内，没有仓位触线，距调仓日 ${a.daysToReb} 天。
             <strong>什么都不做就是正确操作。</strong></p></div>`
  }

<h3>什么情况下才调仓</h3>
<div class="card">
  <table class="rules"><tbody>
    <tr><td><strong>定期 · 一年一次</strong></td>
      <td>每年 ${s.rebalanceMonth} 月（下次 ${a.reb.getFullYear()} 年，${a.daysToReb} 天后）。
        重跑筛选 → 满 12 个月且已不在名单的卖出 → 等权补齐 ${s.usPositions} 只</td></tr>
    <tr><td><strong>规则触发 · 随时</strong></td>
      <td>
        ① 单仓涨过 <strong>${s.trimPct}%</strong> → 削回等权<br>
        ② 持仓 F-Score 跌到 <strong>≤ ${a.cfg.fScoreExit}</strong> → 质量崩坏，直接卖<br>
        ③ 被收购 / 退市 → 没有选择，按现金处理
      </td></tr>
    <tr><td><strong>建仓期</strong></td>
      <td>持仓不足目标一半时，随时买入至满仓，不必等调仓日</td></tr>
    <tr><td style="color:var(--bad)"><strong>不构成调仓理由</strong></td>
      <td style="color:var(--bad)">
        股价下跌本身 · 财经新闻 · 你觉得难受 · 筛选名单的日常变动 ·
        某只票"看起来更好"
      </td></tr>
  </tbody></table>
  <p class="hint" style="margin-top:12px">
    上面三条规则触发时，会自动出现在「你现在该做什么」里，并标注 <span class="badge bad">立即</span>。
    没有出现，就是没有该做的事。名单每晚重算，但你一年只按它行动两次：建仓期和调仓日。
  </p>
</div>

${
    ctx.targets.asOf
      ? `<details style="margin-top:20px"><summary style="cursor:pointer;font-size:13.5px;color:var(--muted)">
           完整筛选名单（${ctx.targets.us.length} 只，${ctx.targets.asOf}）—— 上面的清单已从中选好，正常不需要看
         </summary>
         <div class="chart-wrap"><table>
           <thead><tr><th>#</th><th>代码</th><th>名称</th><th>EV/EBIT</th><th>F-Score</th><th>股息率</th><th>预扣拖累</th></tr></thead>
           <tbody>${ctx.targets.us
             .map(
               (c) => `<tr><td class="num">${c.rank}</td><td><strong>${esc(c.ticker)}</strong></td>
               <td style="text-align:left">${esc(c.name)}</td><td class="num">${c.metric.toFixed(2)}</td>
               <td>${esc(c.quality)}</td>
               <td class="num">${c.divYield ? (c.divYield * 100).toFixed(1) + "%" : "—"}</td>
               <td class="num ${(c.divYield ?? 0) * 0.3 > 0.01 ? "neg" : ""}">${
                 c.divYield ? "−" + (c.divYield * 0.3 * 100).toFixed(2) + "%" : "—"
               }</td></tr>`,
             )
             .join("")}</tbody></table></div></details>`
      : `<div class="callout warn" style="margin-top:20px"><span class="title">筛选名单为空</span>
         <p>数据任务还没成功跑过，或筛选结果为零。检查 Actions 里最近一次运行。</p></div>`
  }`;
}

export function mount(root: HTMLElement, ctx: Ctx): void {
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;

  // Capital drives the order sizes, so re-render as it changes.
  let debounce: number | undefined;
  $("#cap").addEventListener("input", (e) => {
    const v = +(e.target as HTMLInputElement).value || 0;
    clearTimeout(debounce);
    debounce = window.setTimeout(() => ctx.save({ capitalUsd: v }), 350);
  });

  $("#cash").addEventListener("input", (e) => {
    const v = +(e.target as HTMLInputElement).value || 0;
    clearTimeout(debounce);
    debounce = window.setTimeout(() => {
      void ctx.saveBook({ ...ctx.book, cashUsd: v });
    }, 350);
  });

  $("#add").addEventListener("click", () => {
    const msg = $("#msg");
    const say = (t: string, ok: boolean) => {
      msg.textContent = t;
      msg.style.color = ok ? "var(--good)" : "var(--bad)";
    };
    const ticker = $<HTMLInputElement>("#tk").value.trim().toUpperCase();
    const shares = +$<HTMLInputElement>("#sh").value;
    const cost = +$<HTMLInputElement>("#cb").value;
    const date = $<HTMLInputElement>("#dt").value.trim();

    if (!ticker || !shares || !cost) return say("代码、股数、买入价都要填", false);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date)))
      return say("日期格式应为 YYYY-MM-DD", false);
    if (Date.parse(date) > Date.now()) return say("买入日期不能是未来", false);

    const lot: Holding = {
      id: crypto.randomUUID(),
      ticker,
      market: "US",
      shares,
      cost,
      openedAt: new Date(date).toISOString(),
      note: $<HTMLInputElement>("#nt").value.trim(),
    };
    const book: Book = { ...ctx.book, holdings: [...ctx.book.holdings, lot] };
    void ctx.saveBook(book);
  });

  root.querySelectorAll<HTMLButtonElement>(".drop").forEach((b) =>
    b.addEventListener("click", () => {
      const t = b.dataset.t!;
      const n = ctx.book.holdings.filter((h) => h.ticker === t).length;
      if (!confirm(`删除 ${t} 的全部 ${n} 笔买入记录？`)) return;
      void ctx.saveBook({
        ...ctx.book,
        holdings: ctx.book.holdings.filter((h) => h.ticker !== t),
      });
    }),
  );

  // Keep the history series alive even on a page the user just glances at.
  void loadHistory();
}

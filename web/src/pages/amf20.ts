import type { Ctx } from "../main";
import type { Candidate } from "../types";
import {
  type Book, type Contribution, type Holding, loadHistory, recordValue,
  totalContributed, uninvestedCash,
} from "../store";
import { maxDrawdown, sharpe, sharpeNeedsMore, simpleReturn, xirr, type CashFlow } from "../metrics";
import { usd } from "../fmt";

export const title = "AMF-20";
export const icon = "▦";

const DAY = 86_400_000;

/** Fallbacks only. The live thresholds come from the private repo via
 *  targets.config -- hardcoding them here would publish them, since this
 *  bundle is served from a public site. */
const FALLBACK_CFG = {
  fScoreMin: 0, fScoreExit: 0, fScoreWatch: 0, advOrderCap: 0.1, minAdvUsd: 0,
};

interface Lot {
  id: string;
  shares: number;
  cost: number;
  openedAt: string;
  note?: string;
}

interface Position {
  ticker: string; name: string; lots: Lot[];
  shares: number; costTotal: number; avgCost: number;
  price: number | null; value: number;
  pnl: number; pnlPct: number | null; xirr: number | null;
  weight: number; days: number;
  fScore: number | null; fAvail: number | null; evEbit: number | null;
  inScreen: boolean; known: boolean;
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

const today = () => new Date().toISOString().slice(0, 10);

function analyse(ctx: Ctx) {
  const s = ctx.settings;
  const book = ctx.book;
  const facts = ctx.facts.facts;
  const screened = new Set(ctx.targets.us.map((c) => c.ticker));
  const cfg = { ...FALLBACK_CFG, ...(ctx.targets.config ?? {}) };

  // Group lots by ticker: one position, but each tranche keeps its own date
  // and price so the return maths stays honest about when money went in.
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

    const flows: CashFlow[] = lots.map((l) => ({
      date: new Date(l.openedAt), amount: -l.shares * l.cost,
    }));
    flows.push({ date: new Date(), amount: value });

    positions.push({
      ticker, name: fact?.n ?? "", lots, shares, costTotal,
      avgCost: shares ? costTotal / shares : 0,
      price, value,
      pnl: value - costTotal,
      pnlPct: simpleReturn(costTotal, value),
      xirr: price !== null ? xirr(flows) : null,
      weight: 0,
      days: Math.floor((Date.now() - Date.parse(lots[0].openedAt)) / DAY),
      fScore: fact?.f ?? null, fAvail: fact?.fa ?? null, evEbit: fact?.ee ?? null,
      inScreen: screened.has(ticker), known: !!fact,
    });
  }

  const contributed = totalContributed(book);
  const cash = uninvestedCash(book);
  const invested = positions.reduce((a, p) => a + p.value, 0);
  const total = invested + cash;
  positions.forEach((p) => (p.weight = total ? (p.value / total) * 100 : 0));
  positions.sort((a, b) => b.value - a.value);

  const costAll = positions.reduce((a, p) => a + p.costTotal, 0);
  const history = recordValue(total);

  // Portfolio return is measured against money handed to the strategy, not
  // money deployed -- so cash sitting idle counts against it, as it should.
  const flows: CashFlow[] = book.contributions.map((c) => ({
    date: new Date(c.date), amount: -c.amount,
  }));
  if (total > 0) flows.push({ date: new Date(), amount: total });

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
      why: `买入时质量分不低于 ${cfg.fScoreMin || "门槛"}，跌到 ${cfg.fScoreExit} 分及以下属于基本面崩坏而非波动。这是本策略唯一承认的「不等调仓日就卖」的信号。`,
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
      why: "重跑筛选：满 12 个月且已不在名单的卖出，用等权重补齐目标持仓数。",
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
    book, positions, contributed, cash, total, invested, costAll, history,
    building, reb, daysToReb, triggers, cfg,
    cashPct: total ? (cash / total) * 100 : 0,
    totalPnl: invested - costAll,
    totalPnlPct: simpleReturn(costAll, invested),
    portfolioXirr: xirr(flows),
    sharpeVal: sharpe(history),
    sharpeGap: sharpeNeedsMore(history),
    maxDd: maxDrawdown(history),
  };
}

function buildOrders(ctx: Ctx, total: number, cash: number, held: Set<string>) {
  const s = ctx.settings;
  const perPos = (total * (s.usWeight / 100)) / Math.max(s.usPositions, 1);
  const cap = ctx.targets.config?.advOrderCap ?? 0.1;
  const slots = Math.max(s.usPositions - held.size, 0);
  const orders: { c: Candidate; shares: number; cost: number; flags: string[] }[] = [];
  const skipped: { ticker: string; why: string }[] = [];
  let budget = cash;

  for (const c of ctx.targets.us) {
    if (orders.length >= slots) break;
    if (held.has(c.ticker)) continue;
    if (!c.price || c.price <= 0) {
      skipped.push({ ticker: c.ticker, why: "没有价格数据" });
      continue;
    }
    // Never plan an order the account cannot actually pay for.
    const affordable = Math.min(perPos, budget);
    const shares = Math.floor(affordable / c.price);
    if (shares < 1) {
      skipped.push({
        ticker: c.ticker,
        why: budget < c.price
          ? `现金只剩 ${usd(budget)}，不够买 1 股`
          : `股价 ${usd(c.price)} 超过单仓 ${usd(perPos)}`,
      });
      continue;
    }
    const cost = shares * c.price;
    budget -= cost;

    const flags: string[] = [];
    if (c.adv && cost > c.adv * cap) {
      flags.push(`占日均成交额 ${((cost / c.adv) * 100).toFixed(0)}%，分几天买`);
    }
    if (c.debtEstimated) flags.push("债务未披露，估值已按保守上限处理");
    if (c.divSuspect) {
      flags.push(
        `股息率 ${((c.divYield ?? 0) * 100).toFixed(1)}% 异常高，多半含特别股息，` +
        `不按经常性拖累计算 —— 买前确认下一年的实际派息`,
      );
    } else {
      const drag = (c.divYield ?? 0) * 0.3;
      if (drag > 0.015) flags.push(`股息预扣拖累 ${(drag * 100).toFixed(1)}%/年`);
    }
    orders.push({ c, shares, cost, flags });
  }
  return { orders, skipped, perPos, leftover: budget };
}

const LEVEL = { now: ["bad", "立即"], soon: ["warn", "近期"], info: ["", "留意"] } as const;

export function render(ctx: Ctx): string {
  const a = analyse(ctx);
  const s = ctx.settings;
  const held = new Set(a.positions.map((p) => p.ticker));
  const { orders, skipped, perPos, leftover } = buildOrders(ctx, a.total, a.cash, held);

  const metric = (k: string, v: string, cls = "", sub = "") =>
    `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="s">${sub}</div></div>`;
  const pct = (v: number | null, d = 1) =>
    v === null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
  const sign = (v: number | null) => (v === null ? "" : v >= 0 ? "good" : "bad");

  const noMoney = a.contributed <= 0;

  return `
<h2>AMF-20 <span class="badge">Acquirer's Multiple × F-Score · ${s.usPositions} 只等权</span></h2>

${
    ctx.dirty
      ? `<div class="callout warn">
           <span class="title">有未保存的改动</span>
           <p>改动目前只在这台设备上。手动保存是为了避免每次编辑都在私有仓库留下一个 commit。</p>
           <div class="row"><button class="btn primary" id="commit">保存到私有仓库</button>
             <span id="commitmsg" style="font-size:13px"></span></div>
         </div>`
      : ""
  }

${
    noMoney
      ? `<div class="callout">
           <span class="title">先记一笔注资</span>
           <p>还没有资金记录。在下方「加现金」填入金额和日期，就会立刻算出该买哪些股票、各多少股。
              以后每次追加资金也在同一个地方记录。</p>
         </div>`
      : ""
  }

<h3>组合表现</h3>
<div class="grid c4">
  ${metric("累计注资", usd(a.contributed), "", `${a.book.contributions.length} 笔`)}
  ${metric("当前总值", usd(a.total), "", `持仓 ${usd(a.invested)} + 现金 ${usd(a.cash)}`)}
  ${metric("累计盈亏", usd(a.totalPnl), sign(a.totalPnl), `持仓成本 ${usd(a.costAll)}`)}
  ${metric("年化（XIRR）", pct(a.portfolioXirr), sign(a.portfolioXirr),
    a.portfolioXirr === null ? "需跨一天以上" : "对注资额，含现金拖累")}
</div>
<div class="grid c4">
  ${metric("持仓数", `${a.positions.length} <span style="font-size:14px;color:var(--faint)">/ ${s.usPositions}</span>`,
    "", a.building ? "建仓中" : "已建满")}
  ${metric("现金比例", `${a.cashPct.toFixed(1)}%`, "", `目标 ${100 - s.usWeight}%`)}
  ${metric("Sharpe", a.sharpeVal === null ? "—" : a.sharpeVal.toFixed(2), "",
    a.sharpeVal === null ? `还需 ${a.sharpeGap} 天记录` : `基于 ${a.history.length} 天`)}
  ${metric("最大回撤", a.maxDd === null ? "—" : `${(a.maxDd * 100).toFixed(1)}%`,
    a.maxDd ? "bad" : "", a.maxDd === null ? "记录不足" : "自开始记录以来")}
</div>
${
    a.sharpeVal === null && a.positions.length
      ? `<p class="hint">Sharpe 与最大回撤需要每日净值序列，而买入价推不出历史净值 ——
         只能从今天起累积，约 ${a.sharpeGap} 天后才有意义。</p>`
      : ""
  }

<h3>当前持仓</h3>
<p class="hint" style="margin-top:-4px">
  ${ctx.facts.asOf ? `价格与质量分更新于 ${ctx.facts.asOf}` : "⚠ 尚无数据"}
</p>
<div class="chart-wrap">
<table>
  <thead><tr><th>代码</th><th>股数</th><th>均价</th><th>现价</th><th>市值</th><th>权重</th>
    <th>盈亏</th><th>收益率</th><th>年化</th><th>F-Score</th><th>EV/EBIT</th><th>持有</th><th></th></tr></thead>
  <tbody>${
    a.positions.length
      ? a.positions.map((p) => {
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
      <td><button class="btn drop" data-t="${esc(p.ticker)}" style="padding:2px 8px;font-size:11px;white-space:nowrap">删</button></td>
    </tr>${
      p.lots.length > 1
        ? `<tr><td colspan="13" style="text-align:left;padding-top:0;font-size:12px;color:var(--faint)">
             ${p.lots.map((l) => `${l.openedAt.slice(0, 10)}: ${l.shares} 股 @ $${l.cost}`).join("　·　")}</td></tr>`
        : ""
    }`;
        }).join("")
      : `<tr><td colspan="13" style="text-align:center;color:var(--faint);padding:26px">还没有持仓</td></tr>`
  }</tbody>
</table>
</div>

<h3>记录</h3>
<div class="grid c2">
  <div class="card">
    <h4 style="margin-top:0">加现金</h4>
    <p class="hint" style="margin-top:0">首次投入和后续追加都记在这里。填负数表示取出。</p>
    <div class="grid c2">
      <div><label for="camt">金额（USD）</label><input type="number" id="camt" step="100" placeholder="10000" /></div>
      <div><label for="cdate">日期</label><input type="text" id="cdate" value="${today()}" /></div>
    </div>
    <label for="cnote">备注（可选）</label>
    <input type="text" id="cnote" placeholder="首次投入 / 年终追加" />
    <div class="row"><button class="btn primary" id="addcash">记录注资</button>
      <span id="cashmsg" style="font-size:13px"></span></div>
  </div>

  <div class="card">
    <h4 style="margin-top:0">买入股票</h4>
    <p class="hint" style="margin-top:0">同一只票分批买就多记几次，各自保留日期和价格。</p>
    <div class="grid c2">
      <div><label for="tk">代码</label><input type="text" id="tk" placeholder="CRTO" /></div>
      <div><label for="sh">股数</label><input type="number" id="sh" min="0" step="1" /></div>
    </div>
    <div class="grid c2">
      <div><label for="cb">买入价</label><input type="number" id="cb" min="0" step="0.01" /></div>
      <div><label for="dt">日期</label><input type="text" id="dt" value="${today()}" /></div>
    </div>
    <div class="row"><button class="btn primary" id="add">记录买入</button>
      <span id="msg" style="font-size:13px"></span></div>
  </div>
</div>

${
    a.book.contributions.length
      ? `<details style="margin:14px 0"><summary style="cursor:pointer;font-size:13.5px;color:var(--muted)">
           注资记录（${a.book.contributions.length} 笔，合计 ${usd(a.contributed)}）</summary>
         <table><thead><tr><th>日期</th><th>金额</th><th>备注</th><th></th></tr></thead><tbody>
         ${[...a.book.contributions].sort((x, y) => y.date.localeCompare(x.date)).map((c) => `
           <tr><td>${c.date.slice(0, 10)}</td>
             <td class="num ${c.amount >= 0 ? "pos" : "neg"}">${usd(c.amount)}</td>
             <td style="text-align:left">${esc(c.note ?? "")}</td>
             <td><button class="btn dropc" data-id="${c.id}" style="padding:2px 8px;font-size:11px;white-space:nowrap">删</button></td></tr>`).join("")}
         </tbody></table></details>`
      : ""
  }

<h3>你现在该做什么</h3>
${
    orders.length
      ? `<div class="card" style="border-left:3px solid var(--good)">
           <strong>按当前总值 ${usd(a.total)}、每仓 ${usd(perPos)} 算出的买入清单</strong>
           <p style="margin:6px 0 0;color:var(--muted);font-size:13.5px">
             照单执行，<strong>不要挑</strong>。等权重买满是这套策略的全部要点，挑着买就变成了押注个股。
             ${leftover > 0 ? `执行后剩余现金约 ${usd(leftover)}。` : ""}
           </p>
         </div>
         <div class="chart-wrap"><table>
           <thead><tr><th>操作</th><th>代码</th><th>名称</th><th>股数</th><th>现价</th><th>金额</th><th>EV/EBIT</th><th>F</th></tr></thead>
           <tbody>${orders.map((o) => `<tr>
             <td><span class="badge good">买入</span></td>
             <td><strong>${esc(o.c.ticker)}</strong></td>
             <td style="text-align:left">${esc(o.c.name)}</td>
             <td class="num"><strong>${o.shares.toLocaleString()}</strong></td>
             <td class="num">$${o.c.price!.toFixed(2)}</td>
             <td class="num">${usd(o.cost)}</td>
             <td class="num">${o.c.metric.toFixed(2)}${
               o.c.evEbitFy && Math.abs(o.c.metric / o.c.evEbitFy - 1) > 0.15
                 ? `<div style="font-size:10px;color:var(--faint)">财年 ${o.c.evEbitFy.toFixed(2)}</div>`
                 : ""
             }</td>
             <td class="num">${esc(o.c.quality.replace("F ", ""))}</td>
           </tr>${
             o.flags.length
               ? `<tr><td colspan="8" style="text-align:left;padding-top:0;font-size:12px;color:var(--warn)">⚠ ${o.flags.map(esc).join(" · ")}</td></tr>`
               : ""
           }`).join("")}</tbody>
         </table></div>
         <p class="hint">合计 ${usd(orders.reduce((x, o) => x + o.cost, 0))}${
           skipped.length ? ` · ${skipped.length} 只被跳过（${skipped.slice(0, 3).map((k) => esc(k.ticker)).join("、")}${skipped.length > 3 ? "…" : ""}）` : ""
         }</p>`
      : ""
  }
${
    a.triggers.length
      ? a.triggers.map((t) => {
          const [cls, label] = LEVEL[t.level];
          return `<div class="callout ${cls}"><span class="title">
            <span class="badge ${cls}">${label}</span> ${esc(t.what)}</span><p>${esc(t.why)}</p></div>`;
        }).join("")
      : orders.length || noMoney
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
      <td>① 单仓涨过 <strong>${s.trimPct}%</strong> → 削回等权<br>
        ② 持仓 F-Score 跌到 <strong>≤ ${a.cfg.fScoreExit}</strong> → 质量崩坏，直接卖<br>
        ③ 被收购 / 退市 → 没有选择</td></tr>
    <tr><td><strong>追加资金时</strong></td>
      <td>记一笔注资，按上方清单补齐缺口，不必等调仓日</td></tr>
    <tr><td style="color:var(--bad)"><strong>不构成调仓理由</strong></td>
      <td style="color:var(--bad)">股价下跌本身 · 财经新闻 · 你觉得难受 · 筛选名单的日常变动</td></tr>
  </tbody></table>
</div>

${
    ctx.targets.asOf
      ? `<details style="margin-top:20px"><summary style="cursor:pointer;font-size:13.5px;color:var(--muted)">
           完整筛选名单（${ctx.targets.us.length} 只，${ctx.targets.asOf}）</summary>
         <div class="chart-wrap"><table>
           <thead><tr><th>#</th><th>代码</th><th>名称</th><th>EV/EBIT<div style="font-weight:400;font-size:10px">TTM</div></th>
             <th>EV/EBIT<div style="font-weight:400;font-size:10px">上一财年</div></th>
             <th>F-Score</th><th>股息率</th><th>预扣拖累</th></tr></thead>
           <tbody>${ctx.targets.us.map((c) => `<tr><td class="num">${c.rank}</td>
             <td><strong>${esc(c.ticker)}</strong></td>
             <td style="text-align:left">${esc(c.name)}</td>
             <td class="num"><strong>${c.metric.toFixed(2)}</strong></td>
             <td class="num" style="color:var(--faint)">${
               c.evEbitFy ? c.evEbitFy.toFixed(2) : "—"
             }${
               c.evEbitFy && Math.abs(c.metric / c.evEbitFy - 1) > 0.15
                 ? ` <span class="badge ${c.metric > c.evEbitFy ? "bad" : "good"}">${
                     c.metric > c.evEbitFy ? "盈利下滑" : "盈利改善"
                   }</span>`
                 : ""
             }</td>
             <td>${esc(c.quality)}</td>
             <td class="num">${c.divYield ? (c.divYield * 100).toFixed(1) + "%" : "—"}</td>
             <td class="num ${c.divSuspect ? "" : (c.divYield ?? 0) * 0.3 > 0.01 ? "neg" : ""}">${
               c.divSuspect ? '<span class="badge warn">特别股息?</span>'
                 : c.divYield ? "−" + (c.divYield * 0.3 * 100).toFixed(2) + "%" : "—"
             }</td></tr>`).join("")}</tbody></table></div></details>`
      : `<div class="callout warn" style="margin-top:20px"><span class="title">筛选名单为空</span>
         <p>私有仓库的数据任务还没成功跑过。</p></div>`
  }`;
}

export function mount(root: HTMLElement, ctx: Ctx): void {
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const say = (el: HTMLElement | null, t: string, ok: boolean) => {
    if (!el) return;
    el.textContent = t;
    el.style.color = ok ? "var(--good)" : "var(--bad)";
  };
  const validDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));

  $("#commit")?.addEventListener("click", async () => {
    const m = $("#commitmsg");
    say(m, "保存中…", true);
    try {
      await ctx.commitBook();
    } catch (e) {
      say(m, (e as Error).message, false);
    }
  });

  $("#addcash")?.addEventListener("click", () => {
    const m = $("#cashmsg");
    const amount = +$<HTMLInputElement>("#camt")!.value;
    const date = $<HTMLInputElement>("#cdate")!.value.trim();
    if (!amount) return say(m, "填一个金额", false);
    if (!validDate(date)) return say(m, "日期格式应为 YYYY-MM-DD", false);
    if (Date.parse(date) > Date.now()) return say(m, "日期不能是未来", false);

    const c: Contribution = {
      id: crypto.randomUUID(),
      date: new Date(date).toISOString(),
      amount,
      note: $<HTMLInputElement>("#cnote")!.value.trim(),
    };
    ctx.updateBook({ ...ctx.book, contributions: [...ctx.book.contributions, c] });
  });

  $("#add")?.addEventListener("click", () => {
    const m = $("#msg");
    const ticker = $<HTMLInputElement>("#tk")!.value.trim().toUpperCase();
    const shares = +$<HTMLInputElement>("#sh")!.value;
    const cost = +$<HTMLInputElement>("#cb")!.value;
    const date = $<HTMLInputElement>("#dt")!.value.trim();

    if (!ticker || !shares || !cost) return say(m, "代码、股数、买入价都要填", false);
    if (!validDate(date)) return say(m, "日期格式应为 YYYY-MM-DD", false);
    if (Date.parse(date) > Date.now()) return say(m, "日期不能是未来", false);

    const lot: Holding = {
      id: crypto.randomUUID(), ticker, market: "US", shares, cost,
      openedAt: new Date(date).toISOString(),
    };
    const book: Book = { ...ctx.book, holdings: [...ctx.book.holdings, lot] };
    ctx.updateBook(book);
  });

  /**
   * Two-click delete instead of window.confirm.
   *
   * A native dialog can be suppressed entirely -- by the browser, by an
   * embedded webview, or by the user having ticked "block further dialogs" --
   * and when that happens confirm() silently returns false and the button
   * appears dead with nothing in the console. An in-page confirmation cannot
   * be swallowed and shows exactly what is about to happen.
   */
  function armDelete(btn: HTMLButtonElement, label: string, run: () => void) {
    const original = btn.textContent;
    let armed = false;
    let timer: number | undefined;

    btn.addEventListener("click", () => {
      if (armed) {
        clearTimeout(timer);
        try {
          run();
        } catch (e) {
          btn.textContent = "失败";
          btn.style.color = "var(--bad)";
          console.error("删除失败:", e);
        }
        return;
      }
      armed = true;
      btn.textContent = label;
      btn.style.color = "var(--bad)";
      btn.style.borderColor = "var(--bad)";
      timer = window.setTimeout(() => {
        armed = false;
        btn.textContent = original;
        btn.style.color = "";
        btn.style.borderColor = "";
      }, 4000);
    });
  }

  root.querySelectorAll<HTMLButtonElement>(".drop").forEach((b) => {
    const t = b.dataset.t!;
    const n = ctx.book.holdings.filter((h) => h.ticker === t).length;
    armDelete(b, `确认删除 ${n} 笔?`, () => {
      ctx.updateBook({
        ...ctx.book,
        holdings: ctx.book.holdings.filter((h) => h.ticker !== t),
      });
    });
  });

  root.querySelectorAll<HTMLButtonElement>(".dropc").forEach((b) => {
    armDelete(b, "确认?", () => {
      ctx.updateBook({
        ...ctx.book,
        contributions: ctx.book.contributions.filter((c) => c.id !== b.dataset.id),
      });
    });
  });

  void loadHistory();
}

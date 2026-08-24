import type { Ctx } from "../main";
import { checkAccess } from "../github";
import { clearToken, getToken, storeToken, tokenState } from "../store";

export const title = "设置";
export const icon = "⚙";

export function render(ctx: Ctx): string {
  const s = ctx.settings;
  const st = tokenState();
  const stLabel = { none: ["", "未设置"], plain: ["warn", "明文存储"], encrypted: ["good", "已加密"] }[st];
  const cash = 100 - s.usWeight - s.jpWeight;

  return `
<h2>设置</h2>

<h3>配置比例</h3>
<div class="card">
  <div class="grid c2">
    <div>
      <label for="usw">美股篮子（%）</label>
      <input type="number" id="usw" value="${s.usWeight}" min="0" max="100" step="5" />
    </div>
    <div>
      <label for="jpw">日股篮子（%）</label>
      <input type="number" id="jpw" value="${s.jpWeight}" min="0" max="100" step="5" />
    </div>
  </div>
  <p class="hint">
    现金 = <strong id="cashpct">${cash}%</strong>（自动计算）。
    <strong>投入金额不在这里设置</strong> —— 它由 AMF-20 页面的注资记录累加得出，
    这样每笔资金都有日期，年化收益才算得准。
  </p>

  <div class="grid c3">
    <div>
      <label for="usn">美股持仓数</label>
      <input type="number" id="usn" value="${s.usPositions}" min="0" max="60" step="1" />
    </div>
    <div>
      <label for="jpn">日股持仓数</label>
      <input type="number" id="jpn" value="${s.jpPositions}" min="0" max="60" step="1" />
    </div>
    <div>
      <label for="trim">减仓触发线（%）</label>
      <input type="number" id="trim" value="${s.trimPct}" min="1" max="30" step="0.5" />
      <div class="hint" id="trimhint"></div>
    </div>
  </div>

  <label for="reb">调仓月份</label>
  <select id="reb">
    ${Array.from({ length: 12 }, (_, i) =>
      `<option value="${i + 1}"${i + 1 === s.rebalanceMonth ? " selected" : ""}>${i + 1} 月</option>`,
    ).join("")}
  </select>
  <div class="hint">固定下来，一年只碰这一次。学术回测用的是 6 月底重组。</div>

  <div class="row">
    <button class="btn primary" id="savecfg">保存</button>
    <span id="cfgmsg" style="font-size:13px"></span>
  </div>
</div>

<h3>行情数据</h3>
<div class="card">
  <p style="margin-top:0">
    筛选与行情由<strong>私有仓库</strong>中的 GitHub Actions 每晚抓取并提交，
    本站在解锁后读取。<strong>浏览器不需要任何行情 API key</strong>。
  </p>
  <p class="hint" style="margin-bottom:0">
    为什么不在这里填 key：Alpaca 的行情接口不允许浏览器跨域调用（CORS 被拒），技术上做不到。
    而且你的策略是年度调仓，隔夜价格完全够用 —— 实时报价对这套打法没有意义，反而会诱发手痒。
  </p>
</div>

<h3>私有仓库</h3>
<div class="callout warn">
  <span class="title">本站点是公开的</span>
  <p>
    免费版 GitHub Pages 必须由公开仓库发布，任何知道网址的人都能打开本站。
    因此策略、名单与持仓一律不放在这里，而是存于你的私有仓库，
    由本站在解锁后取回。<strong>未配置下列内容前，本站不显示任何实质信息。</strong>
  </p>
</div>
<div class="card">
  <label for="repo">Private 仓库（owner/name）</label>
  <input type="text" id="repo" value="${s.privateRepo}" placeholder="hongduo/investment-private" />
  <div class="hint">
    策略文档、筛选名单、持仓全部存在这里。<strong>必须是 private 仓库</strong>，
    与承载本站点的公开仓库分开；填入公开仓库会被拒绝。
  </div>

  <label for="bpath">路径前缀</label>
  <input type="text" id="bpath" value="${s.basePath}" placeholder="investment" />
  <div class="hint">
    本项目在该仓库中的子目录。留空表示仓库根目录；
    与其它数据共用一个仓库时填写，例如 <code>investment</code>，
    则策略文档为 <code>investment/strategy.md</code>、名单为 <code>investment/data/targets.json</code>。
  </div>

  <label for="hpath">持仓文件路径</label>
  <input type="text" id="hpath" value="${s.holdingsPath}" placeholder="holdings.json" />
  <div class="hint">
    相对于仓库根目录的完整路径（<strong>不受上面的前缀影响</strong>）。
    文件不存在时会在第一次录入持仓时自动创建。
  </div>

  <label for="pat">Fine-grained Token <span class="badge ${stLabel[0]}">${stLabel[1]}</span></label>
  <input type="password" id="pat" placeholder="${st === "none" ? "github_pat_..." : "已保存，留空不改动"}" autocomplete="off" />

  <label for="pass">加密口令（推荐）</label>
  <input type="password" id="pass" placeholder="留空则明文存储" autocomplete="off" />
  <div class="hint">
    填了口令，token 会用 AES-GCM 加密后再存进浏览器。留空则明文存 localStorage。
  </div>

  <div class="row">
    <button class="btn primary" id="savetok">保存并测试</button>
    <button class="btn" id="cleartok">删除 token</button>
    <span id="tokmsg" style="font-size:13px"></span>
  </div>

  <details style="margin-top:14px">
    <summary style="cursor:pointer;font-size:13.5px;color:var(--muted)">怎么创建这个 token</summary>
    <ol style="padding-left:20px;font-size:13.5px;color:var(--muted)">
      <li>先建一个 <strong>private</strong> 仓库（可以是空的）</li>
      <li>GitHub → Settings → Developer settings → Personal access tokens →
        <strong>Fine-grained tokens</strong> → Generate new token</li>
      <li><strong>Repository access</strong>：Only select repositories，只勾那一个 private 仓库</li>
      <li><strong>Permissions</strong> → Repository permissions → <strong>Contents: Read and write</strong>，其它一律不给</li>
      <li><strong>Expiration</strong>：设 90 天</li>
    </ol>
    <p style="font-size:13px;color:var(--bad);padding-left:20px">
      别用 classic token —— 它的权限是账号级的，泄露等于交出整个 GitHub 账号。
    </p>
  </details>
</div>

<h3>外观</h3>
<div class="card">
  <label for="theme">主题</label>
  <select id="theme">
    ${(["auto", "light", "dark"] as const)
      .map((t) => `<option value="${t}"${s.theme === t ? " selected" : ""}>${
        { auto: "跟随系统", light: "浅色", dark: "深色" }[t]
      }</option>`)
      .join("")}
  </select>
</div>`;
}

export function mount(root: HTMLElement, ctx: Ctx): void {
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;

  const num = (id: string) => +$<HTMLInputElement>(id).value || 0;

  function syncDerived() {
    const cash = 100 - num("#usw") - num("#jpw");
    const el = $("#cashpct");
    el.textContent = `${cash}%`;
    el.style.color = cash < 0 ? "var(--bad)" : "";

    const n = num("#usn") + num("#jpn");
    const start = n ? 100 / n : 0;
    const trim = num("#trim");
    $("#trimhint").innerHTML =
      n === 0
        ? ""
        : trim <= start
          ? `<span style="color:var(--bad)">必须高于起始权重 ${start.toFixed(1)}%，否则一买进就触线</span>`
          : `起始权重 ${start.toFixed(1)}%，有 ${(trim - start).toFixed(1)}pp 缓冲`;
  }

  ["#usw", "#jpw", "#usn", "#jpn", "#trim"].forEach((id) =>
    $(id).addEventListener("input", syncDerived),
  );
  syncDerived();

  $("#savecfg").addEventListener("click", () => {
    const cash = 100 - num("#usw") - num("#jpw");
    const m = $("#cfgmsg");
    if (cash < 0) {
      m.textContent = "两个篮子加起来不能超过 100%";
      m.style.color = "var(--bad)";
      return;
    }
    ctx.save({
      usWeight: num("#usw"),
      jpWeight: num("#jpw"),
      usPositions: num("#usn"),
      jpPositions: num("#jpn"),
      trimPct: num("#trim"),
      rebalanceMonth: +$<HTMLSelectElement>("#reb").value,
    });
    m.textContent = "已保存";
    m.style.color = "var(--good)";
    setTimeout(() => (m.textContent = ""), 1800);
  });

  $("#theme").addEventListener("change", (e) => {
    ctx.save({ theme: (e.target as HTMLSelectElement).value as "auto" | "light" | "dark" });
  });

  $("#savetok").addEventListener("click", async () => {
    const m = $("#tokmsg");
    const repo = $<HTMLInputElement>("#repo").value.trim();
    const pat = $<HTMLInputElement>("#pat").value.trim();
    const pass = $<HTMLInputElement>("#pass").value;
    ctx.save({
      privateRepo: repo,
      basePath: $<HTMLInputElement>("#bpath").value.trim().replace(/^\/+|\/+$/g, ""),
      holdingsPath: $<HTMLInputElement>("#hpath").value.trim() || "holdings.json",
    });

    const say = (t: string, ok: boolean | null) => {
      m.textContent = t;
      m.style.color = ok === null ? "var(--muted)" : ok ? "var(--good)" : "var(--bad)";
    };

    try {
      let token: string | null;
      if (pat) {
        await storeToken(pat, pass || null);
        token = pat;
      } else {
        token = await getToken(pass || undefined);
      }
      if (!token) return say("请粘贴 token，或输入口令解锁已保存的那个", false);
      say("测试中…", null);
      const r = await checkAccess(token, repo);
      say(r.message, r.ok);
      if (r.ok) {
        $<HTMLInputElement>("#pat").value = "";
        $<HTMLInputElement>("#pass").value = "";
        // Pull the strategy, screen and holdings straight away so the user
        // sees whether the private repo is actually populated.
        try {
          await ctx.unlock(pass || undefined);
          say(`${r.message} · 已载入私有数据`, true);
        } catch (e) {
          say(`${r.message}，但载入失败：${(e as Error).message}`, false);
        }
      }
    } catch (e) {
      say((e as Error).message, false);
    }
  });

  $("#cleartok").addEventListener("click", () => {
    clearToken();
    const m = $("#tokmsg");
    m.textContent = "已删除。记得去 GitHub 撤销它。";
    m.style.color = "var(--good)";
  });
}

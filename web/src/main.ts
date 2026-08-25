import "./styles.css";
import type { CompanyNotes, FactsFile, Industries, Report, TargetFile } from "./types";
import {
  type Book, cacheBook, getToken, loadBook, loadSettings, normalise,
  saveSettings, type Settings, tokenState,
} from "./store";
import { EMPTY_FACTS, EMPTY_TARGETS, loadPrivate, loadReport, saveBookRemote } from "./private";

import * as strategy from "./pages/strategy";
import * as amf20 from "./pages/amf20";
import * as research from "./pages/research";
import * as settingsPage from "./pages/settings";

export interface Ctx {
  settings: Settings;
  /** Strategy document, as Markdown, fetched from the private repo. */
  strategy: string;
  targets: TargetFile;
  facts: FactsFile;
  industries: Industries;
  notes: CompanyNotes;
  book: Book;
  /** Empty until unlocked. Every page except 设置 requires this. */
  unlocked: boolean;
  /** True when the local book differs from what is stored in the private repo.
   *  Writes are manual: auto-saving would put a commit in the repo on every
   *  keystroke-sized edit. */
  dirty: boolean;
  save(patch: Partial<Settings>): void;
  /** Local edit. Marks the book dirty; does not touch the network. */
  updateBook(book: Book): void;
  /** Push the local book to the private repo. One commit per press. */
  commitBook(): Promise<void>;
  refresh(): void;
  unlock(passphrase?: string): Promise<void>;
  /** Fetch one company report from the private repo. */
  report(ticker: string): Promise<Report>;
}

export interface Page {
  title: string;
  icon: string;
  /** Pages that show nothing useful while locked. */
  needsUnlock?: boolean;
  render(ctx: Ctx): string;
  mount?(root: HTMLElement, ctx: Ctx): void;
}

const PAGES: Record<string, Page> = {
  strategy: { ...strategy, needsUnlock: true },
  amf20: { ...amf20, needsUnlock: true },
  research: { ...research, needsUnlock: true },
  settings: settingsPage,
};
const ORDER = ["strategy", "amf20", "research", "settings"];

let bookSha: string | null = null;

async function boot() {
  const app = document.getElementById("app")!;

  const ctx: Ctx = {
    settings: loadSettings(),
    strategy: "",
    targets: EMPTY_TARGETS,
    facts: EMPTY_FACTS,
    industries: { sectors: [] },
    notes: { companies: {} },
    // The cached copy keeps the page usable offline; the private repo is
    // authoritative and replaces it on unlock.
    book: loadBook(),
    unlocked: false,
    dirty: false,

    save(patch) {
      ctx.settings = { ...ctx.settings, ...patch };
      saveSettings(ctx.settings);
      applyTheme(ctx.settings);
      draw(app, ctx);
    },

    updateBook(book) {
      // Drop any legacy fields so they never reach the repo.
      ctx.book = normalise(book);
      ctx.dirty = true;
      cacheBook(ctx.book); // survives a reload even before it is committed
      draw(app, ctx);
    },

    async commitBook() {
      const token = await getToken();
      if (!token || !ctx.settings.privateRepo) {
        throw new Error("尚未解锁或未配置私有仓库");
      }
      bookSha = await saveBookRemote(
        token, ctx.settings.privateRepo, ctx.settings.holdingsPath, ctx.book, bookSha,
      );
      ctx.dirty = false;
      cacheBook(ctx.book);
      draw(app, ctx);
    },

    refresh() {
      draw(app, ctx);
    },

    async report(ticker) {
      const token = await getToken();
      if (!token) throw new Error("会话已锁定，请刷新页面重新解锁");
      return loadReport(token, ctx.settings.privateRepo, ctx.settings.basePath, ticker);
    },

    async unlock(passphrase) {
      const token = await getToken(passphrase);
      if (!token) throw new Error("需要口令解锁已保存的 token");
      if (!ctx.settings.privateRepo) throw new Error("尚未配置私有仓库");
      const data = await loadPrivate(
        token, ctx.settings.privateRepo, ctx.settings.basePath, ctx.settings.holdingsPath,
      );
      ctx.strategy = data.strategy;
      ctx.targets = data.targets;
      ctx.facts = data.facts;
      ctx.industries = data.industries;
      ctx.notes = data.notes;
      ctx.book = data.book;
      bookSha = data.bookSha;
      cacheBook(data.book);
      ctx.dirty = false;
      ctx.unlocked = true;
      draw(app, ctx);
    },
  };

  applyTheme(ctx.settings);
  window.addEventListener("hashchange", () => draw(app, ctx));

  // Unsaved edits live only in this browser; leaving would strand them.
  window.addEventListener("beforeunload", (e) => {
    if (ctx.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  draw(app, ctx);

  // A plaintext token can unlock without asking; an encrypted one cannot.
  if (ctx.settings.privateRepo && tokenState() === "plain") {
    ctx.unlock().catch(() => {/* fall through to the lock screen */});
  }
}

function applyTheme(s: Settings) {
  const root = document.documentElement;
  if (s.theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", s.theme);
}

function currentRoute(): string {
  const r = location.hash.replace(/^#\/?/, "").split("?")[0];
  return PAGES[r] ? r : "strategy";
}

/**
 * Lock screen. The deployed site is public -- a free GitHub Pages site must be
 * served from a public repository -- so this is what a stranger sees.
 */
function lockScreen(ctx: Ctx): string {
  const st = tokenState();
  const configured = !!ctx.settings.privateRepo && st !== "none";

  if (!configured) {
    return `<div class="empty" style="padding-top:80px">
      <div class="big">🔒</div>
      <h2 style="margin:8px 0">未配置</h2>
      <p style="max-width:44ch;margin:0 auto 18px;color:var(--muted)">
        策略、筛选名单和持仓都存放在你的私有仓库中，本站点仅是查看器。
        请先在设置中填写私有仓库与访问 token。
      </p>
      <a class="btn primary" href="#/settings">前往设置</a>
    </div>`;
  }

  return `<div class="empty" style="padding-top:70px">
    <div class="big">🔒</div>
    <h2 style="margin:8px 0">已锁定</h2>
    <p style="color:var(--muted);margin-bottom:18px">
      从 <code>${ctx.settings.privateRepo}</code> 载入
    </p>
    <div style="max-width:320px;margin:0 auto;text-align:left">
      ${st === "encrypted"
        ? `<label for="pw">加密口令</label>
           <input type="password" id="pw" autocomplete="current-password" />`
        : ""}
      <div class="row" style="justify-content:center">
        <button class="btn primary" id="unlock">解锁</button>
      </div>
      <div id="lockmsg" style="margin-top:10px;font-size:13px;text-align:center"></div>
    </div>
  </div>`;
}

function draw(app: HTMLElement, ctx: Ctx) {
  const route = currentRoute();
  const page = PAGES[route];
  const locked = !!page.needsUnlock && !ctx.unlocked;

  const nav = ORDER.map((key) => {
    const p = PAGES[key];
    const dim = p.needsUnlock && !ctx.unlocked ? ';opacity:.5' : "";
    return `<a class="nav-item${key === route ? " active" : ""}" href="#/${key}" style="${dim.slice(1)}">
      <span class="ico">${p.icon}</span>${p.title}</a>`;
  }).join("");

  app.innerHTML = `
    <nav class="sidebar">
      <div class="brand"><h1>投资台</h1>
        <p>${ctx.unlocked ? (ctx.dirty ? "● 有未保存改动" : "已解锁") : "🔒 已锁定"}</p></div>
      ${nav}
    </nav>
    <main class="main" id="page-root">${locked ? lockScreen(ctx) : page.render(ctx)}</main>`;

  const root = document.getElementById("page-root")!;

  if (locked) {
    const btn = root.querySelector<HTMLButtonElement>("#unlock");
    const msg = root.querySelector<HTMLDivElement>("#lockmsg");
    const go = async () => {
      const pw = root.querySelector<HTMLInputElement>("#pw")?.value;
      if (msg) {
        msg.textContent = "载入中…";
        msg.style.color = "var(--muted)";
      }
      try {
        await ctx.unlock(pw || undefined);
      } catch (e) {
        if (msg) {
          msg.textContent = (e as Error).message;
          msg.style.color = "var(--bad)";
        }
      }
    };
    btn?.addEventListener("click", go);
    root.querySelector<HTMLInputElement>("#pw")
      ?.addEventListener("keydown", (e) => e.key === "Enter" && go());
    return;
  }

  page.mount?.(root, ctx);
}

boot();

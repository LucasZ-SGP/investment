/**
 * Local settings, the holdings book, and secret handling.
 *
 * The holdings book lives in localStorage so the app works with zero setup,
 * and additionally syncs to a private GitHub repo when one is configured.
 *
 * The GitHub token is the only genuinely sensitive thing here. By default it is
 * encrypted at rest (PBKDF2 -> AES-GCM); the plaintext lives in a module
 * variable for the session and is never persisted. That is defence in depth,
 * not a guarantee: what actually limits the damage is scoping the token to a
 * single repo with Contents-only permission.
 */

import type { ValuePoint } from "./metrics";

export interface Settings {
  capitalUsd: number;
  usWeight: number; // % of the book in the US basket
  jpWeight: number; // % in the Japan basket; cash is the remainder
  usPositions: number;
  jpPositions: number;
  trimPct: number; // trim a position back to equal weight once it exceeds this
  rebalanceMonth: number; // 1-12
  /** "owner/name" of the PRIVATE repo holding the strategy, screen and book. */
  privateRepo: string;
  /** Directory within that repo holding this project's files. Empty means the
   *  repo root; set it when sharing the repo with unrelated data. */
  basePath: string;
  /** Path to the holdings file, relative to the repo root. */
  holdingsPath: string;
  theme: "auto" | "light" | "dark";
}

export const DEFAULTS: Settings = {
  capitalUsd: 50_000,
  // Japan is off by default. Two independent reasons, both in 策略 page:
  // the evidence for it is weak, and there is no free data source that gives
  // current Japanese prices. Turn it on only if both change.
  usWeight: 80,
  jpWeight: 0,
  usPositions: 20,
  jpPositions: 0,
  trimPct: 8,
  rebalanceMonth: 6,
  privateRepo: "",
  basePath: "investment",
  holdingsPath: "investment/holdings.json",
  theme: "auto",
};

export interface Holding {
  id: string;
  ticker: string;
  market: "US" | "JP";
  shares: number;
  cost: number; // per share, in the market's own currency
  openedAt: string; // ISO date
  note?: string;
}

export interface Book {
  version: 1;
  cashUsd: number;
  holdings: Holding[];
  updatedAt: string;
}

export const EMPTY_BOOK: Book = { version: 1, cashUsd: 0, holdings: [], updatedAt: "" };

const SETTINGS_KEY = "sc.settings";
const BOOK_KEY = "sc.book";
const TOKEN_KEY = "sc.token";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function loadBook(): Book {
  try {
    const raw = localStorage.getItem(BOOK_KEY);
    return raw ? { ...EMPTY_BOOK, ...JSON.parse(raw) } : { ...EMPTY_BOOK };
  } catch {
    return { ...EMPTY_BOOK };
  }
}

/** Cache only. The private repo is the source of truth; this keeps the page
 *  usable between loads and while a write is in flight. */
export function cacheBook(b: Book): void {
  localStorage.setItem(BOOK_KEY, JSON.stringify(b));
}

// ---------------------------------------------------------------- history
// Entry prices alone cannot reconstruct what the portfolio was worth on any
// past day, so risk figures need a value series recorded as we go. One point
// per day, written whenever the page is opened.

const HISTORY_KEY = "sc.history";
const MAX_POINTS = 1500; // ~6 years of trading days

export function loadHistory(): ValuePoint[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/** Record today's value, replacing any earlier point for the same day. */
export function recordValue(total: number): ValuePoint[] {
  if (!(total > 0)) return loadHistory();
  const today = new Date().toISOString().slice(0, 10);
  const hist = loadHistory().filter((p) => p.d !== today);
  hist.push({ d: today, v: Math.round(total * 100) / 100 });
  hist.sort((a, b) => a.d.localeCompare(b.d));
  const trimmed = hist.slice(-MAX_POINTS);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  return trimmed;
}

// ---------------------------------------------------------------- crypto

const enc = new TextEncoder();
const dec = new TextDecoder();
let sessionToken: string | null = null;

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 310_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function storeToken(token: string, passphrase: string | null): Promise<void> {
  sessionToken = token;
  if (!passphrase) {
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ enc: false, v: token }));
    return;
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(token));
  localStorage.setItem(
    TOKEN_KEY,
    JSON.stringify({ enc: true, salt: b64(salt.buffer), iv: b64(iv.buffer), ct: b64(ct) }),
  );
}

export function tokenState(): "none" | "plain" | "encrypted" {
  const raw = localStorage.getItem(TOKEN_KEY);
  if (!raw) return "none";
  try {
    return JSON.parse(raw).enc ? "encrypted" : "plain";
  } catch {
    return "none";
  }
}

export async function getToken(passphrase?: string): Promise<string | null> {
  if (sessionToken) return sessionToken;
  const raw = localStorage.getItem(TOKEN_KEY);
  if (!raw) return null;
  const rec = JSON.parse(raw);
  if (!rec.enc) {
    sessionToken = rec.v;
    return sessionToken;
  }
  if (!passphrase) return null;
  const key = await deriveKey(passphrase, unb64(rec.salt));
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(rec.iv) as BufferSource },
      key,
      unb64(rec.ct) as BufferSource,
    );
    sessionToken = dec.decode(pt);
    return sessionToken;
  } catch {
    throw new Error("口令不正确");
  }
}

export function clearToken(): void {
  sessionToken = null;
  localStorage.removeItem(TOKEN_KEY);
}

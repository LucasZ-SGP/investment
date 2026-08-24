/**
 * Everything of substance lives in the user's private repo, not on the public
 * Pages site.
 *
 * A free GitHub Pages site must be served from a public repository, so anyone
 * who learns the URL can open it. Keeping the strategy document and the screen
 * output here means the deployed page is an empty shell until it is unlocked
 * with a token that only the owner holds.
 *
 * What this does NOT hide: the pipeline source in the public repo. It
 * implements published methods (Acquirer's Multiple, Piotroski F-Score) and
 * reveals the approach, though not the thresholds in use, the current picks,
 * or any position.
 */
import { readText, writeText } from "./github";
import type { FactsFile, TargetFile } from "./types";
import { type Book, EMPTY_BOOK, migrate } from "./store";
import { DEFAULT_STRATEGY_DOC } from "./strategyDoc";

/** Join a base directory with a relative path, tolerating stray slashes. */
function under(base: string, rel: string): string {
  const b = base.replace(/^\/+|\/+$/g, "");
  return b ? `${b}/${rel}` : rel;
}

export function paths(basePath: string) {
  return {
    strategy: under(basePath, "strategy.md"),
    targets: under(basePath, "data/targets.json"),
    facts: under(basePath, "data/facts.json"),
  };
}

export interface PrivateData {
  strategy: string;
  strategySha: string | null;
  targets: TargetFile;
  facts: FactsFile;
  book: Book;
  bookSha: string | null;
  /** Paths that were missing, so the UI can explain what is not set up yet. */
  missing: string[];
}

export const EMPTY_TARGETS: TargetFile = { asOf: null, us: [], jp: [] };
export const EMPTY_FACTS: FactsFile = { asOf: null, facts: {} };

async function json<T>(token: string, repo: string, path: string, fallback: T,
                       missing: string[]): Promise<T> {
  const f = await readText(token, repo, path);
  if (!f) {
    missing.push(path);
    return fallback;
  }
  try {
    return JSON.parse(f.text) as T;
  } catch {
    missing.push(`${path}（不是合法 JSON）`);
    return fallback;
  }
}

export async function loadPrivate(
  token: string, repo: string, basePath: string, holdingsPath: string,
): Promise<PrivateData> {
  const missing: string[] = [];
  const P = paths(basePath);

  // Fetched together: four sequential round-trips to api.github.com otherwise.
  const [doc, targets, facts, bookFile] = await Promise.all([
    readText(token, repo, P.strategy),
    json<TargetFile>(token, repo, P.targets, EMPTY_TARGETS, missing),
    json<FactsFile>(token, repo, P.facts, EMPTY_FACTS, missing),
    readText(token, repo, holdingsPath),
  ]);

  if (!doc) missing.push(P.strategy);

  // A missing holdings file is normal on first run, not an error.
  let book: Book = { ...EMPTY_BOOK };
  if (bookFile) {
    try {
      // Same normalisation as the local cache: a book written by an older
      // build must not be read back in its old shape.
      book = migrate(JSON.parse(bookFile.text));
    } catch {
      throw new Error(`${holdingsPath} 不是合法 JSON，请检查或删除该文件`);
    }
  }

  return {
    strategy: doc?.text ?? DEFAULT_STRATEGY_DOC,
    strategySha: doc?.sha ?? null,
    targets,
    facts,
    book,
    bookSha: bookFile?.sha ?? null,
    missing,
  };
}

/** Persist holdings. Returns the new blob SHA for the next optimistic write. */
export async function saveBookRemote(
  token: string, repo: string, path: string, book: Book, sha: string | null,
): Promise<string> {
  book.updatedAt = new Date().toISOString();
  return writeText(
    token, repo, path, JSON.stringify(book, null, 2), sha,
    `holdings: ${book.holdings.length} 笔`,
  );
}

/** Write the strategy document back, e.g. after the user edits it. */
export async function saveStrategy(
  token: string, repo: string, basePath: string, text: string, sha: string | null,
): Promise<string> {
  return writeText(token, repo, paths(basePath).strategy, text, sha, "strategy: update");
}

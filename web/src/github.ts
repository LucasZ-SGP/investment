/**
 * Reading and writing JSON files in the user's PRIVATE repo via the GitHub
 * Contents API. That repo holds the journal, positions and checklists -- the
 * things that must never be in the public Pages repo.
 *
 * Writes carry the blob SHA we last read, so a concurrent edit from another
 * device fails with a 409 rather than silently overwriting.
 */

const API = "https://api.github.com";

export interface RepoFile<T> {
  data: T;
  sha: string | null; // null when the file does not exist yet
}

function headers(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/** UTF-8 safe base64, since journal entries will be full of Chinese text. */
function toB64(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}
function fromB64(s: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
}

export async function checkAccess(
  token: string,
  repo: string,
): Promise<{ ok: boolean; message: string; private?: boolean }> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    return { ok: false, message: "仓库格式应为 owner/name" };
  }
  const r = await fetch(`${API}/repos/${repo}`, { headers: headers(token) });
  if (r.status === 404) {
    return { ok: false, message: "找不到仓库，或这个 token 没有被授权访问它" };
  }
  if (r.status === 401) return { ok: false, message: "Token 无效或已过期" };
  if (!r.ok) return { ok: false, message: `GitHub 返回 ${r.status}` };
  const j = await r.json();
  if (!j.private) {
    return {
      ok: false,
      private: false,
      message: "这个仓库是公开的。私密数据必须存在 private 仓库里，请换一个。",
    };
  }
  if (!j.permissions?.push) {
    return { ok: false, message: "Token 缺少写权限（需要 Contents: Read and write）" };
  }
  return { ok: true, message: `已连接 ${j.full_name}`, private: true };
}

export async function readJson<T>(
  token: string,
  repo: string,
  path: string,
  fallback: T,
): Promise<RepoFile<T>> {
  const r = await fetch(`${API}/repos/${repo}/contents/${encodeURI(path)}`, {
    headers: headers(token),
    cache: "no-store",
  });
  if (r.status === 404) return { data: fallback, sha: null };
  if (!r.ok) throw new Error(`读取 ${path} 失败: ${r.status}`);
  const j = await r.json();
  try {
    return { data: JSON.parse(fromB64(j.content)) as T, sha: j.sha };
  } catch {
    throw new Error(`${path} 不是合法 JSON`);
  }
}

/** Read a file as text. Returns null when it does not exist yet. */
export async function readText(
  token: string,
  repo: string,
  path: string,
): Promise<{ text: string; sha: string } | null> {
  const r = await fetch(`${API}/repos/${repo}/contents/${encodeURI(path)}`, {
    headers: headers(token),
    cache: "no-store",
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`读取 ${path} 失败: ${r.status}`);
  const j = await r.json();
  return { text: fromB64(j.content), sha: j.sha };
}

export async function writeText(
  token: string,
  repo: string,
  path: string,
  text: string,
  sha: string | null,
  message: string,
): Promise<string> {
  const body: Record<string, unknown> = { message, content: toB64(text) };
  if (sha) body.sha = sha;
  const r = await fetch(`${API}/repos/${repo}/contents/${encodeURI(path)}`, {
    method: "PUT",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 409) throw new Error("另一台设备已经改过这个文件，请先刷新再保存");
  if (!r.ok) throw new Error(`写入 ${path} 失败: ${r.status}`);
  return (await r.json()).content.sha as string;
}

export async function writeJson<T>(
  token: string,
  repo: string,
  path: string,
  data: T,
  sha: string | null,
  message: string,
): Promise<string> {
  const body: Record<string, unknown> = {
    message,
    content: toB64(JSON.stringify(data, null, 2)),
  };
  if (sha) body.sha = sha;

  const r = await fetch(`${API}/repos/${repo}/contents/${encodeURI(path)}`, {
    method: "PUT",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 409) {
    throw new Error("另一台设备已经改过这个文件，请先刷新再保存");
  }
  if (!r.ok) throw new Error(`写入 ${path} 失败: ${r.status} ${await r.text()}`);
  return (await r.json()).content.sha as string;
}

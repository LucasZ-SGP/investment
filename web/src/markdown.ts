/**
 * Minimal Markdown renderer.
 *
 * The strategy document lives in the user's private repo and is fetched at
 * runtime, so it arrives as text and has to be rendered here. A library would
 * mean a third-party script in a page that holds a GitHub token, which is
 * exactly what the CSP exists to prevent -- so this covers the subset the
 * document actually uses and nothing more.
 *
 * Everything is escaped before any markup is inserted: the source is a file
 * from a repo, and treating it as trusted HTML would make the document itself
 * an injection vector.
 */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Inline spans: code, bold, italic. Applied after escaping. */
function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

function tableRow(line: string): string[] {
  return line
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

const isDivider = (l: string) => /^\|?[\s:|-]+\|[\s:|-]*$/.test(l) && l.includes("-");

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let listType: "ul" | "ol" | null = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code
    if (/^```/.test(line)) {
      closeList();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(`<pre style="background:var(--surface-2);padding:12px;border-radius:6px;overflow-x:auto"><code>${esc(
        body.join("\n"),
      )}</code></pre>`);
      continue;
    }

    // Table: a header row followed by a divider row
    if (line.includes("|") && i + 1 < lines.length && isDivider(lines[i + 1])) {
      closeList();
      const head = tableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(tableRow(lines[i++]));
      }
      out.push(
        `<div class="chart-wrap"><table class="rules"><thead><tr>${head
          .map((h) => `<th style="text-align:left">${inline(h)}</th>`)
          .join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }

    // Headings
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = Math.min(h[1].length + 1, 4); // #  -> h2, so page keeps one h1
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Blockquote -> callout
    if (/^>\s?/.test(line)) {
      closeList();
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i++].replace(/^>\s?/, ""));
      }
      out.push(`<div class="callout"><p>${inline(body.join(" "))}</p></div>`);
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      closeList();
      out.push(`<hr style="border:none;border-top:1px solid var(--border);margin:22px 0">`);
      i++;
      continue;
    }

    // Lists
    const ul = /^[-*+]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const want = ul ? "ul" : "ol";
      if (listType !== want) {
        closeList();
        out.push(`<${want}>`);
        listType = want;
      }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
      i++;
      continue;
    }

    if (!line.trim()) {
      closeList();
      i++;
      continue;
    }

    // Paragraph: absorb following non-blank, non-structural lines
    closeList();
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|[-*+]\s|\d+[.)]\s|>|```)/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isDivider(lines[i + 1]))
    ) {
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }

  closeList();
  return out.join("\n");
}

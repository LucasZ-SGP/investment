import type { Ctx } from "../main";
import { renderMarkdown } from "../markdown";

export const title = "策略";
export const icon = "◈";

/**
 * Renders the strategy document fetched from the private repo.
 *
 * Nothing substantive is authored here on purpose: this file ships in a bundle
 * served from a public GitHub Pages site. Edit strategy.md in the private repo
 * instead; the change appears on the next unlock.
 */
export function render(ctx: Ctx): string {
  return `${renderMarkdown(ctx.strategy)}

<hr style="border:none;border-top:1px solid var(--border);margin:30px 0">
<p class="hint">
  本文档来自私有仓库的 <code>strategy.md</code>。直接在仓库中编辑即可，
  下次解锁时会取回最新版本。
</p>`;
}

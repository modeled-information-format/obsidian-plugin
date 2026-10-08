// Summary-first display of compressed concepts (spec §5.6), in the
// Related panel and as a banner at the top of reading view.

import { MarkdownRenderer, type App, type Component } from "obsidian";

import { compressionState, type Frontmatter } from "./engine";

/**
 * A compressed concept's header: when it was compressed and, summary first,
 * either its summary (when the body still holds the full text) or a
 * collapsible view of the preserved original (when the body is the summary).
 * Returns false when the concept is not compressed.
 */
export function renderCompressed(app: App, parent: HTMLElement, fm: Frontmatter, body: string, sourcePath: string, component: Component): boolean {
  const state = compressionState(fm);
  if (!state.compressed) return false;
  const box = parent.createDiv({ cls: "mif-compressed" });
  const head = box.createDiv({ cls: "mif-compressed-head" });
  head.createSpan({ cls: "mif-compressed-badge", text: "Compressed" });
  if (state.at) head.createSpan({ cls: "mif-muted", text: ` ${state.at.slice(0, 10)}` });

  const bodyIsSummary = !!state.summary && body.includes(state.summary.trim());
  if (state.summary && !bodyIsSummary) {
    box.createDiv({ cls: "mif-compressed-summary", text: state.summary });
  } else if (!state.summary) {
    box.createDiv({ cls: "mif-warning-text", text: "No summary recorded." });
  }
  const original = (fm.extensions as Record<string, unknown> | undefined)?.original_content;
  if (typeof original === "string") {
    const details = box.createEl("details", { cls: "mif-compressed-original" });
    details.createEl("summary", { text: `Original content (${original.split("\n").length} lines)` });
    const content = details.createDiv({ cls: "markdown-rendered" });
    // Rendered on first open only: originals can be long.
    let rendered = false;
    details.addEventListener("toggle", () => {
      if (!details.open || rendered) return;
      rendered = true;
      void MarkdownRenderer.render(app, original, content, sourcePath, component);
    });
  } else if (bodyIsSummary) {
    head.createSpan({ cls: "mif-muted", text: " · original not preserved" });
  }
  return true;
}

/** 0-based line of the first non-blank body line in a document's text. */
export function firstBodyLine(text: string): number {
  const lines = text.split("\n");
  let i = 0;
  if (lines[0] === "---") {
    i = lines.indexOf("---", 1);
    if (i === -1) return 0;
    i++;
  }
  while (i < lines.length && lines[i]!.trim() === "") i++;
  return i;
}

/**
 * Whether a reading-view section element is the first body section. Uses the
 * section's line info when Obsidian has it; at post-process time it often
 * does not (the element is not attached yet), so fall back to the DOM: no
 * earlier rendered section other than the frontmatter.
 */
export function isFirstBodySection(el: HTMLElement, info: { lineStart: number; text: string } | null): boolean | undefined {
  if (info) return info.lineStart === firstBodyLine(info.text);
  if (!el.isConnected || !el.parentElement) return undefined;
  if (el.classList.contains("mod-frontmatter")) return false; // hidden; never host the banner
  for (let p = el.previousElementSibling; p; p = p.previousElementSibling) {
    const section = [...p.classList].some((c) => c.startsWith("el-"));
    if (section && !p.classList.contains("mod-frontmatter")) return false;
  }
  return true;
}

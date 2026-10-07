// Spike B — does FileManager.processFrontMatter preserve MIF frontmatter?
//
// For each concept, a copy is written under _spike/fidelity/ and edited two
// ways: a no-op callback, then a one-field edit (`modified`). The report
// records whether bytes, key order, and engine-parsed values survive, and
// what Obsidian's own frontmatter object looks like next to the engine's
// PyYAML-compatible parse. The answer decides whether the plugin's writer
// can use processFrontMatter or must edit the YAML block itself.

import type { App } from "obsidian";

import { parseMarkdown, type Frontmatter } from "../engine";
import { cell, conceptFiles, reportHeader, writeSpikeFile } from "./util";

const PROBE_MODIFIED = "2026-10-07T00:00:00Z";

interface Row {
  path: string;
  noopBytes: string;
  noopValues: string;
  editKeyOrder: string;
  editOtherValues: string;
  modifiedWrittenAs: string;
  obsidianVsEngine: string;
}

const keysOf = (fm: Frontmatter) => Object.keys(fm).join(",");

function diffValues(a: Frontmatter, b: Frontmatter, ignore = new Set<string>()): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => !ignore.has(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

const frontmatterBlock = (text: string) => /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";

export async function runFidelitySpike(app: App): Promise<string> {
  const rows: Row[] = [];
  const details: string[] = [];

  for (const source of conceptFiles(app)) {
    const original = await app.vault.read(source);
    let engineBefore: Frontmatter;
    try {
      engineBefore = parseMarkdown(original).frontmatter;
    } catch (err) {
      rows.push({
        path: source.path, noopBytes: "—", noopValues: "—", editKeyOrder: "—",
        editOtherValues: "—", modifiedWrittenAs: "—",
        obsidianVsEngine: `engine rejects: ${(err as Error).message}`,
      });
      continue;
    }

    const copy = await writeSpikeFile(app, `fidelity/${source.path}`, original);
    const row: Row = {
      path: source.path, noopBytes: "", noopValues: "", editKeyOrder: "",
      editOtherValues: "", modifiedWrittenAs: "", obsidianVsEngine: "",
    };

    // 1. No-op callback: Obsidian still re-serializes the block.
    let obsidianView: Frontmatter = {};
    try {
      await app.fileManager.processFrontMatter(copy, (fm: Frontmatter) => {
        obsidianView = structuredClone(fm);
      });
      const afterNoop = await app.vault.read(copy);
      row.noopBytes = afterNoop === original ? "identical" : "rewritten";
      if (afterNoop !== original) {
        details.push(`### ${source.path} — raw file after no-op\n\n\`\`\`text\n${JSON.stringify(afterNoop.slice(0, 400))}\n\`\`\`\n`);
      }
      const changed = diffValues(engineBefore, parseMarkdown(afterNoop).frontmatter);
      row.noopValues = changed.length ? `changed: ${changed.join(", ")}` : "same";
      if (afterNoop !== original) {
        details.push(
          `### ${source.path} — no-op rewrite\n\nBefore:\n\n\`\`\`yaml\n${frontmatterBlock(original)}\n\`\`\`\n\nAfter:\n\n\`\`\`yaml\n${frontmatterBlock(afterNoop)}\n\`\`\`\n`,
        );
      }
    } catch (err) {
      row.noopBytes = `error: ${(err as Error).message}`;
    }

    // Obsidian's own parse of the frontmatter vs the engine's.
    const viewDiff = diffValues(engineBefore, obsidianView);
    row.obsidianVsEngine = viewDiff.length
      ? viewDiff.map((k) => `${k}: obsidian=${JSON.stringify(obsidianView[k])} engine=${JSON.stringify(engineBefore[k])}`).join("; ")
      : "same";

    // 2. One-field edit.
    try {
      await writeSpikeFile(app, `fidelity/${source.path}`, original);
      await app.fileManager.processFrontMatter(copy, (fm: Frontmatter) => {
        fm.modified = PROBE_MODIFIED;
      });
      const afterEdit = await app.vault.read(copy);
      const engineAfter = parseMarkdown(afterEdit).frontmatter;
      const expectedOrder = keysOf({ ...engineBefore, modified: PROBE_MODIFIED });
      row.editKeyOrder = keysOf(engineAfter) === expectedOrder ? "preserved" : `now ${keysOf(engineAfter)}`;
      const changed = diffValues(engineBefore, engineAfter, new Set(["modified"]));
      row.editOtherValues = changed.length ? `changed: ${changed.join(", ")}` : "same";
      row.modifiedWrittenAs = /^modified:.*$/m.exec(frontmatterBlock(afterEdit))?.[0] ?? "(missing)";
    } catch (err) {
      row.editKeyOrder = `error: ${(err as Error).message}`;
    }
    rows.push(row);
  }

  const table = [
    "| File | No-op: bytes | No-op: values | Edit: key order | Edit: other values | `modified` written as | Obsidian parse vs engine |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((r) =>
      `| ${[r.path, r.noopBytes, r.noopValues, r.editKeyOrder, r.editOtherValues, r.modifiedWrittenAs, r.obsidianVsEngine].map(cell).join(" | ")} |`),
  ].join("\n");

  const report = `${reportHeader("Spike B — processFrontMatter fidelity")}
Copies of every concept were edited under \`_spike/fidelity/\`; originals are untouched.

${table}

## Rewrites

${details.join("\n") || "None — every no-op left the file byte-identical."}
`;
  await writeSpikeFile(app, "fidelity-report.md", report);
  return `${rows.length} files checked`;
}

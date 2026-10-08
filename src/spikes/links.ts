// Spike C — how does Obsidian resolve MIF relationship targets?
//
// MIF targets are bundle-relative paths ("/semantic/x.md") or urn:mif: ids,
// kept that way by decision D2. This spike records, for (1) every frontmatter
// relationship target in the vault and (2) a probe note covering each link
// shape, whether Obsidian's own resolvers find the target and whether the
// body-mirror link lands in resolvedLinks (which drives backlinks and graph).

import { TFile, type App } from "obsidian";

import { parseMarkdown, scalarText } from "../engine";
import { cell, conceptFiles, reportHeader, waitForCache, writeSpikeFile } from "./util";

interface Relationship {
  type?: unknown;
  target?: unknown;
}

const PROBE_TARGET = "semantic/rate-limit-policy.md";

// Each shape a MIF body mirror (or a hand-written link) might use.
const PROBE_LINKS: Array<[label: string, markdown: string]> = [
  ["leading slash", `[policy](/${PROBE_TARGET})`],
  ["no leading slash", `[policy](${PROBE_TARGET})`],
  ["relative ../", `[policy](../../../${PROBE_TARGET})`],
  ["no .md extension", `[policy](/semantic/rate-limit-policy)`],
  ["angle brackets", `[policy](</${PROBE_TARGET}>)`],
  ["space encoded", `[spaced](/_spike/links/space%20name.md)`],
  ["space raw in <>", `[spaced](</_spike/links/space name.md>)`],
  ["urn:mif concept", `[policy](urn:mif:7b3c1e90-5a2f-4c8d-9e10-2f6a4b8c1d3e)`],
  ["wikilink", `[[${PROBE_TARGET.replace(/\.md$/, "")}]]`],
];

function resolveTarget(app: App, target: string, from: string): string {
  if (target.startsWith("urn:")) return "n/a (urn)";
  const direct = app.vault.getAbstractFileByPath(target.replace(/^\//, ""));
  const linkpath = app.metadataCache.getFirstLinkpathDest(target, from);
  return `path lookup: ${direct instanceof TFile ? "found" : "missing"}; getFirstLinkpathDest: ${linkpath?.path ?? "null"}`;
}

export async function runLinkSpike(app: App): Promise<string> {
  // (1) Frontmatter relationship targets across the vault.
  const relRows: string[] = [];
  for (const file of conceptFiles(app)) {
    let rels: Relationship[] = [];
    try {
      const fm = parseMarkdown(await app.vault.read(file)).frontmatter;
      rels = Array.isArray(fm.relationships) ? (fm.relationships as Relationship[]) : [];
    } catch {
      continue;
    }
    const resolved = app.metadataCache.resolvedLinks[file.path] ?? {};
    for (const rel of rels) {
      const target = scalarText(rel.target ?? "");
      const inResolved = Object.keys(resolved).some((dest) => `/${dest}` === target || dest === target);
      relRows.push(`| ${[file.path, rel.type, target, resolveTarget(app, target, file.path), inResolved ? "yes" : "no"].map(cell).join(" | ")} |`);
    }
  }

  // (2) Probe note: one line per link shape, from a nested folder.
  await writeSpikeFile(app, "links/space name.md", "Target with a space in its name.\n");
  const probeBody = PROBE_LINKS.map(([label, md]) => `- ${label}: ${md}`).join("\n");
  const probe = await writeSpikeFile(app, "links/nested/probe.md", `# Link probe\n\n${probeBody}\n`);
  const indexed = await waitForCache(app, probe);
  // resolvedLinks is filled after "changed"; wait for the resolver pass.
  await new Promise<void>((done) => {
    const ref = app.metadataCache.on("resolved", () => { app.metadataCache.offref(ref); done(); });
    window.setTimeout(() => { app.metadataCache.offref(ref); done(); }, 3000);
  });
  const cache = app.metadataCache.getFileCache(probe);
  const resolved = app.metadataCache.resolvedLinks[probe.path] ?? {};
  const unresolved = app.metadataCache.unresolvedLinks[probe.path] ?? {};
  const probeRows = PROBE_LINKS.map(([label, md], i) => {
    const link = cache?.links?.find((l) => l.position.start.line === 2 + i);
    const dest = link ? app.metadataCache.getFirstLinkpathDest(link.link, probe.path) : null;
    const status = !link ? "not parsed as a link" : dest ? `resolved → ${dest.path}` : link.link in unresolved ? "unresolved" : "ignored";
    const inGraph = dest ? (dest.path in resolved ? "yes" : "no") : "—";
    return `| ${[label, md, link?.link ?? "—", status, inGraph].map(cell).join(" | ")} |`;
  });

  const report = `${reportHeader("Spike C — relationship target resolution")}
Metadata cache indexed probe: ${indexed ? "yes" : "timed out"}. Resolved destinations from probe: ${Object.keys(resolved).join(", ") || "none"}.

## Frontmatter relationship targets

| File | Type | Target | Obsidian resolution | Body mirror in resolvedLinks |
|---|---|---|---|---|
${relRows.join("\n") || "| — | — | — | — | — |"}

## Link shapes (from \`_spike/links/nested/probe.md\`)

| Shape | Markdown | Parsed link | Result | In resolvedLinks (backlinks/graph) |
|---|---|---|---|---|
${probeRows.join("\n")}
`;
  await writeSpikeFile(app, "links-report.md", report);
  return `${relRows.length} relationships, ${PROBE_LINKS.length} link shapes`;
}

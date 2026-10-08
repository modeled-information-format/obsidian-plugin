// JSON-LD export, laid out as MIF's `mif_convert.py emit-jsonld`
// does: <out>/<bundle name>/<bundle path with .jsonld>. Projections never
// use `.md` (Invariant 2), so OKF's `*.md` glob never picks them up.

import type { JsonLd } from "./convert";

/** `semantic/x.md` → `<folder>/<bundle>/semantic/x.jsonld`. */
export function exportPath(folder: string, bundleName: string, bundlePath: string): string {
  const rel = bundlePath.replace(/\.md$/i, ".jsonld");
  return [folder.replace(/^\/+|\/+$/g, ""), bundleName, rel].filter(Boolean).join("/");
}

/**
 * The projection as `mif_convert.py` writes it: `json.dumps(indent=2,
 * ensure_ascii=False)` plus a newline. One difference cannot be avoided
 * in JavaScript: a float with no fraction (YAML `1.0`) prints as `1`.
 */
export const serializeJsonLd = (jsonld: JsonLd) => `${JSON.stringify(jsonld, null, 2)}\n`;

/** Exported files under `<folder>/<bundle>/` with no source concept any more. */
export function staleExports(existing: string[], folder: string, bundleName: string, bundlePaths: Iterable<string>): string[] {
  const keep = new Set([...bundlePaths].map((p) => exportPath(folder, bundleName, p)));
  const prefix = `${exportPath(folder, bundleName, "")}`.replace(/\/?$/, "/");
  return existing.filter((p) => p.startsWith(prefix) && p.endsWith(".jsonld") && !keep.has(p));
}

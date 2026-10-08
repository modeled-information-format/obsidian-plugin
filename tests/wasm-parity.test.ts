// Parity oracle (ADR-0001, D5): the plugin's TypeScript engine against mif-rs
// compiled to WASM (spikes/mif-wasm). Skipped unless the WASM package has
// been built:
//   (cd spikes/mif-wasm && wasm-pack build --release --target nodejs --out-dir pkg-node)
// CI builds it from a pinned mif-rs ref. Any difference must be listed in
// KNOWN_GAPS with the spec gap that explains it; an unlisted difference,
// or a listed gap that no longer occurs, fails.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { mdToJsonLd, parseMarkdown, roundtripDrift } from "../src/engine/convert";

const ROOT = join(__dirname, "..");
const PKG = process.env.MIF_WASM ?? join(ROOT, "spikes/mif-wasm/pkg-node/mif_wasm.js");
const available = existsSync(PKG);

type Wasm = { parseMarkdown(md: string): string; toJsonLd(md: string): string; roundtripDrift(md: string): string | undefined };

/** file → which comparison may differ, and why (a known spec gap). */
const KNOWN_GAPS: Record<string, { parts: Array<"frontmatter" | "jsonld" | "drift" | "error">; why: string }> = {
  "tests/fixtures/edge/timestamps.md": { parts: ["frontmatter", "jsonld"], why: "YAML 1.1 timestamps (PyYAML, the plugin) vs YAML 1.2 strings (mif-rs)" },
  "tests/fixtures/edge/yaml11-scalars.md": { parts: ["frontmatter", "jsonld", "drift"], why: "yes/no/octal/sexagesimal/.inf resolve differently under YAML 1.1 and 1.2" },
};

const SETS = ["test-vault", "tests/fixtures/edge", "tests/fixtures/rel", "tests/fixtures/citations", "tests/fixtures/temporal", "tests/fixtures/memories"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f.startsWith(".") || f.startsWith("_") ? [] : files(p);
    return f.endsWith(".md") && f !== "index.md" ? [p] : [];
  });
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

function ours(text: string) {
  try {
    const { frontmatter, body } = parseMarkdown(text);
    return { frontmatter, jsonld: mdToJsonLd(frontmatter, body), drift: roundtripDrift(text) !== null, error: false };
  } catch {
    return { frontmatter: undefined, jsonld: undefined, drift: false, error: true };
  }
}

function theirs(wasm: Wasm, text: string) {
  try {
    const parsed = JSON.parse(wasm.parseMarkdown(text)) as { frontmatter?: unknown };
    return { frontmatter: parsed.frontmatter ?? parsed, jsonld: JSON.parse(wasm.toJsonLd(text)), drift: (wasm.roundtripDrift(text) ?? null) !== null, error: false };
  } catch {
    return { frontmatter: undefined, jsonld: undefined, drift: false, error: true };
  }
}

describe.skipIf(!available)("parity with mif-rs (WASM oracle)", () => {
  const wasm = available ? (createRequire(import.meta.url)(PKG) as Wasm) : undefined;
  const docs = SETS.flatMap((s) => (existsSync(join(ROOT, s)) ? files(join(ROOT, s)) : [])).map((p) => relative(ROOT, p));

  it("covers the fixture sets", () => expect(docs.length).toBeGreaterThan(30));

  for (const name of docs) {
    it(name, () => {
      const text = readFileSync(join(ROOT, name), "utf8");
      const a = ours(text);
      const b = theirs(wasm!, text);
      const differs = (["error", "frontmatter", "jsonld", "drift"] as const).filter((k) => canonical(a[k]) !== canonical(b[k]));
      const gap = KNOWN_GAPS[name];
      if (!gap) {
        expect(differs, `unlisted difference from mif-rs in ${name}`).toEqual([]);
        return;
      }
      // A listed gap must still be real, and nothing beyond it may differ.
      expect(differs.length, `${name}: listed gap (${gap.why}) no longer occurs — remove it`).toBeGreaterThan(0);
      expect(differs.filter((d) => !gap.parts.includes(d)), `${name}: differs beyond its listed gap`).toEqual([]);
    });
  }
});

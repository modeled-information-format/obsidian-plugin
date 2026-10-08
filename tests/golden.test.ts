// Parity tests: the TypeScript engine against goldens produced by the MIF
// reference converter (scripts/gen_golden.py -> tests/golden). Every place
// the engine intentionally differs from mif_convert.py is listed in
// DIVERGENCES with its reason; anything else is a parity failure.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  REFERENCE_PASSTHROUGH,
  mdToJsonLd,
  normalize,
  parseMarkdown,
  roundtripDrift,
  type Namespaces,
} from "../src/engine/convert";
import { serializeJsonLd } from "../src/engine/export";
import { validateJsonLd } from "../src/engine/validate";
import { loadYaml } from "../src/engine/yaml11";

const ROOT = resolve(__dirname, "..");
const GOLDEN = join(ROOT, "tests", "golden");
const BUNDLES: Record<string, string> = {
  "test-vault": join(ROOT, "test-vault"),
  edge: join(ROOT, "tests", "fixtures", "edge"),
  // Goldens for these bundles were missing here, which
  // failed collection of this whole file without failing any test.
  rel: join(ROOT, "tests", "fixtures", "rel"),
  legacy: join(ROOT, "tests", "fixtures", "mif", "legacy-0.1-bundle"),
  ...Object.fromEntries(
    readdirSync(join(ROOT, "tests/fixtures/mif/relationship_types")).map((n) => [`reltypes-${n}`, join(ROOT, "tests/fixtures/mif/relationship_types", n)]),
  ),
};

/** Concepts where the reference round trip is lossy but ours must not be. */
const LOSSY_IN_REFERENCE = new Set([
  "edge/key-order.md", // customTopLevel dropped by fixed passthrough list
  "edge/timestamps.md", // quotedCreated dropped
  "edge/unicode-long.md", // description dropped
]);

/** Concepts whose round trip is lossy in our engine, with the reason. */
const DIVERGENCES: Record<string, string> = {
  "edge/unicode-long.md":
    "`description` beside `summary` is shadowed by the derived OKF description (lossy in the reference and mif-rs too); flagged by projectionConflicts()",
  "edge/yaml11-scalars.md":
    "`.inf` has no JSON representation; the reference emits invalid JSON (Infinity) and calls it lossless, we report drift",
};

const revive = (_: string, v: unknown) => {
  if (v && typeof v === "object" && "$float" in v) {
    const f = (v as { $float: string }).$float;
    return f === "nan" ? NaN : f.startsWith("-") ? -Infinity : Infinity;
  }
  return v;
};
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"), revive) as Record<string, unknown>;

function* goldenCases(dir = GOLDEN): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (!statSync(full).isDirectory()) continue;
    if (existsSync(join(full, "parse.json"))) yield relative(GOLDEN, full);
    else yield* goldenCases(full);
  }
}

function namespacesFor(bundle: string): Namespaces | undefined {
  const config = join(BUNDLES[bundle] ?? "", ".mif", "config.yaml");
  if (!existsSync(config)) return undefined;
  const parsed = loadYaml(readFileSync(config, "utf8")) as { namespaces?: Namespaces };
  return parsed?.namespaces;
}

const cases = [...goldenCases()].sort();

describe("golden parity with mif_convert.py", () => {
  it("has goldens to test", () => {
    expect(cases.length).toBeGreaterThanOrEqual(12);
  });

  for (const key of cases) {
    const [bundle, ...rest] = key.split("/");
    const relPath = rest.join("/");
    const source = readFileSync(join(BUNDLES[bundle!]!, relPath), "utf8");
    const golden = (name: string) => join(GOLDEN, key, name);
    const parsedGolden = readJson(golden("parse.json"));

    describe(key, () => {
      if ("error" in parsedGolden) {
        it("rejects the file like the reference", () => {
          expect(() => parseMarkdown(source)).toThrow(/No YAML frontmatter found/);
        });
        return;
      }

      const { frontmatter, body } = parseMarkdown(source);
      const namespaces = namespacesFor(bundle!);

      it("parses frontmatter and body identically", () => {
        expect(frontmatter).toEqual(parsedGolden.frontmatter);
        expect(body).toBe(parsedGolden.body);
      });

      it("exports byte-identical JSON-LD to mif_convert emit-jsonld", () => {
        const ours = mdToJsonLd(frontmatter, body, namespaces);
        const theirs = readFileSync(golden("jsonld.json"), "utf8");
        // Keys the reference drops (F10) and its non-finite floats cannot match byte for byte.
        const extra = Object.keys(ours).some((k) => !(k in readJson(golden("jsonld.json"))));
        if (extra || key in DIVERGENCES) return;
        // The one unavoidable difference: Python prints an integral float as 1.0, JavaScript as 1.
        expect(serializeJsonLd(ours)).toBe(theirs.replace(/(: |^\s+)(-?\d+)\.0(,?)$/gm, "$1$2$3"));
      });

      it("projects JSON-LD identically for reference keys, and passes the rest through", () => {
        const ours = mdToJsonLd(frontmatter, body, namespaces);
        const theirs = readJson(golden("jsonld.json"));
        const extra = Object.keys(ours).filter((k) => !(k in theirs));
        for (const k of extra) {
          expect(REFERENCE_PASSTHROUGH.has(k), `${k} should only be extra if the reference drops it`).toBe(false);
          expect(frontmatter).toHaveProperty([k]);
        }
        const oursRestricted = Object.fromEntries(Object.entries(ours).filter(([k]) => k in theirs));
        expect(oursRestricted).toEqual(theirs);
      });

      it("reads the reference's canonical serialization back to the same data", () => {
        const normalizedRef = readFileSync(golden("normalized.md"), "utf8");
        expect(parseMarkdown(normalizedRef).frontmatter).toEqual(parsedGolden.frontmatter);
        expect(parseMarkdown(normalize(source)).frontmatter).toEqual(frontmatter);
      });

      it("round-trips md -> json-ld -> md", () => {
        const ref = readJson(golden("roundtrip.json"));
        const drift = roundtripDrift(source, namespaces);
        if (key in DIVERGENCES) {
          expect(drift, DIVERGENCES[key]).not.toBeNull();
          if (LOSSY_IN_REFERENCE.has(key)) expect(ref.lossless).toBe(false);
          return;
        }
        expect(drift).toBeNull();
        expect(ref.lossless).toBe(!LOSSY_IN_REFERENCE.has(key));
      });
    });
  }
});

describe("schema validation of the example bundle", () => {
  for (const key of cases.filter((c) => c.startsWith("test-vault/"))) {
    it(`${key} projects to a schema-valid document`, () => {
      const source = readFileSync(join(BUNDLES["test-vault"]!, key.slice("test-vault/".length)), "utf8");
      const { frontmatter, body } = parseMarkdown(source);
      expect(validateJsonLd(mdToJsonLd(frontmatter, body))).toEqual([]);
    });
  }
});

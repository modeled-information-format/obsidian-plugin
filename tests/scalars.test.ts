// Every scalar in tests/golden/scalars.json was resolved by PyYAML itself
// (scripts/gen_golden.py SCALAR_CASES); loadYaml must agree on each one.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadYaml } from "../src/engine/yaml11";

interface ScalarCase {
  text: string;
  value?: unknown;
  error?: string;
}

const revive = (_: string, v: unknown) => {
  if (v && typeof v === "object" && "$float" in v) {
    const f = (v as { $float: string }).$float;
    return f === "nan" ? NaN : f.startsWith("-") ? -Infinity : Infinity;
  }
  return v;
};

const cases = JSON.parse(
  readFileSync(join(__dirname, "golden", "scalars.json"), "utf8"),
  revive,
) as ScalarCase[];

describe("PyYAML scalar resolution", () => {
  for (const c of cases) {
    it(`v: ${JSON.stringify(c.text)}`, () => {
      if (c.error) {
        expect(() => loadYaml(`v: ${c.text}`)).toThrow();
        return;
      }
      expect((loadYaml(`v: ${c.text}`) as { v: unknown }).v).toEqual(c.value);
    });
  }
});

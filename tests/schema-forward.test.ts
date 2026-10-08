// Forward compatibility with in-flight MIF schema changes (tracked with
// scripts/mif-align.mjs). MIF 1.4 makes @id's pattern urn:mif:<uuid>; the
// schema's pattern error must merge into the id-not-uuid diagnostic.

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/engine/validate", async (orig) => {
  const real = await orig<typeof import("../src/engine/validate")>();
  return {
    ...real,
    validateJsonLd: (doc: { "@id"?: string }) => {
      const issues = real.validateJsonLd(doc);
      const UUID = /^urn:mif:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (typeof doc["@id"] === "string" && !UUID.test(doc["@id"])) issues.push({ path: "/@id", keyword: "pattern", message: "must match pattern" });
      return issues;
    },
  };
});

const { analyze } = await import("../src/engine/analyze");

describe("@id must be urn:mif:<uuid> (MIF 1.4)", () => {
  it("reports one error, with the fix, instead of a warning plus a schema error", () => {
    const a = analyze("---\nid: my-slug\ntype: semantic\ncreated: 2026-01-01T00:00:00Z\n---\n\nBody.\n");
    const ids = a.diagnostics.filter((d) => d.path[0] === "id");
    expect(ids.map((d) => [d.code, d.severity])).toEqual([["id-not-uuid", "error"]]);
    expect(ids[0]!.fixes[0]!.label).toMatch(/new UUID/);
    expect(a.level).toBe(0);
  });
  it("leaves UUID ids alone", () => {
    const a = analyze("---\nid: 11111111-2222-4333-8444-555555555555\ntype: semantic\ncreated: 2026-01-01T00:00:00Z\n---\n\nBody.\n");
    expect(a.diagnostics.filter((d) => d.path[0] === "id")).toEqual([]);
    expect(a.level).toBe(1);
  });
});

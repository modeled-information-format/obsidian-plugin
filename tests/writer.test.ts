// The frontmatter writer must change only what it was asked to (D6). Every
// fixture that Obsidian's processFrontMatter mangled in Spike B is edited
// here and checked line by line.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

import { parseMarkdown } from "../src/engine/convert";
import { toLf, updateFrontmatter, WriteError } from "../src/engine/writer";

const ROOT = join(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f.startsWith(".") || f.startsWith("_") ? [] : files(p);
    return f.endsWith(".md") && f !== "index.md" ? [p] : [];
  });
}

const editable = [...files(join(ROOT, "test-vault")), ...files(join(ROOT, "tests", "fixtures", "edge"))]
  .map((p) => ({ name: relative(ROOT, p), text: readFileSync(p, "utf8") }))
  .filter(({ text }) => {
    try {
      parseMarkdown(text);
      return true;
    } catch {
      return false;
    }
  });

/** Lines present in `after` but not in `before` (multiset difference). */
function addedLines(before: string, after: string): string[] {
  const pool = new Map<string, number>();
  for (const l of before.split("\n")) pool.set(l, (pool.get(l) ?? 0) + 1);
  return after.split("\n").filter((l) => {
    const n = pool.get(l) ?? 0;
    if (n > 0) {
      pool.set(l, n - 1);
      return false;
    }
    return true;
  });
}

const STAMP = "2026-10-07T12:00:00Z";

describe("updateFrontmatter on every fixture", () => {
  for (const { name, text } of editable) {
    describe(name, () => {
      const before = parseMarkdown(text);

      it("setting `modified` changes only that key", () => {
        const out = updateFrontmatter(text, { modified: STAMP });
        const after = parseMarkdown(out);
        expect(after.frontmatter).toEqual({ ...before.frontmatter, modified: STAMP });
        expect(after.body).toBe(before.body);
        expect(addedLines(text, out)).toEqual([`modified: ${STAMP}`]);
      });

      it("inserts a new key at its canonical position", () => {
        if ("namespace" in before.frontmatter) return;
        const out = updateFrontmatter(text, { namespace: "_semantic/test" });
        const keys = Object.keys(parseMarkdown(out).frontmatter);
        const i = keys.indexOf("namespace");
        // Every key that canonically precedes `namespace` is written before it.
        for (const k of ["id", "type", "memoryType", "created", "modified"]) {
          if (keys.includes(k)) expect(keys.indexOf(k), k).toBeLessThan(i);
        }
      });

      it("deleting a key removes only its lines", () => {
        const key = "title" in before.frontmatter ? "title" : "created";
        const out = updateFrontmatter(text, { [key]: undefined });
        const expected = { ...before.frontmatter };
        delete expected[key];
        expect(parseMarkdown(out).frontmatter).toEqual(expected);
        expect(addedLines(text, out)).toEqual([]);
      });
    });
  }
});

describe("updateFrontmatter details", () => {
  const base = "---\nid: 7b3c1e90-5a2f-4c8d-9e10-2f6a4b8c1d3e\ntype: semantic  # base type\ncreated: 2026-01-15T10:30:00Z\n---\n\nBody.\n";

  it("keeps a trailing comment when replacing an inline scalar", () => {
    const out = updateFrontmatter(base, { type: "episodic" });
    expect(out).toContain("type: episodic  # base type");
  });

  it("replaces a block value with a new mapping", () => {
    const withTemporal = updateFrontmatter(base, { temporal: { validFrom: "2026-01-15T00:00:00Z", ttl: "P90D" } });
    const out = updateFrontmatter(withTemporal, { temporal: { validFrom: "2026-02-01T00:00:00Z" } });
    expect(parseMarkdown(out).frontmatter.temporal).toEqual({ validFrom: "2026-02-01T00:00:00Z" });
    expect(out.match(/^temporal:/gm)).toHaveLength(1);
  });

  it("quotes strings that would otherwise change type", () => {
    const out = updateFrontmatter(base, { title: "yes", namespace: "010" });
    const fm = parseMarkdown(out).frontmatter;
    expect(fm.title).toBe("yes");
    expect(fm.namespace).toBe("010");
  });

  it("creates frontmatter for a plain note", () => {
    const out = updateFrontmatter("# Note\n\nText.\n", { id: "x", type: "semantic" });
    expect(out).toBe("---\nid: x\ntype: semantic\n---\n# Note\n\nText.\n");
  });

  it("fills an empty frontmatter block", () => {
    const out = updateFrontmatter("---\n\n---\nBody.\n", { id: "x" });
    expect(parseMarkdown(out)).toEqual({ frontmatter: { id: "x" }, body: "Body.\n" });
  });

  it("refuses CRLF files, and toLf fixes them", () => {
    const crlf = base.replace(/\n/g, "\r\n");
    expect(() => updateFrontmatter(crlf, { type: "episodic" })).toThrow(WriteError);
    expect(updateFrontmatter(toLf(crlf), { type: "episodic" })).toContain("type: episodic");
  });
});

describe("nested edits keep the file's YAML style", () => {
  const a = readFileSync(join(ROOT, "tests/fixtures/rel/a.md"), "utf8");

  it("setScalarIn changes exactly one line", async () => {
    const { setScalarIn } = await import("../src/engine/writer");
    const out = setScalarIn(a, ["relationships", 0, "target"], "/elsewhere/c.md");
    expect(addedLines(a, out)).toEqual(["    target: /elsewhere/c.md"]);
    expect((parseMarkdown(out).frontmatter.relationships as Array<{ target: string }>)[0]!.target).toBe("/elsewhere/c.md");
  });

  it("rewriting a block keeps indented list items indented", async () => {
    const { addRelationship } = await import("../src/engine/relationships");
    const out = addRelationship(a, { type: "implements", target: "/d.md" }, () => "Concept D");
    const fmLines = out.slice(0, out.indexOf("\n---", 4)).split("\n");
    expect(fmLines.filter((l) => /^\s*- type:/.test(l)).every((l) => l.startsWith("  - type:"))).toBe(true);
    // Only the new item and its mirror line are added.
    expect(addedLines(a, out)).toEqual(["  - type: implements", "    target: /d.md", "- implements [Concept D](/d.md)"]);
  });
});

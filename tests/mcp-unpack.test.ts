// The MCP server code is carried inside main.js and written out as mcp.cjs on
// desktop (src/mcpUnpack.ts, plan M54): the file on disk must end up as the
// embedded copy, whatever was there before.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureMcpFile, type EmbeddedMcp, type UnpackNode } from "../src/mcpUnpack";

const node = { fs, zlib, crypto: { createHash }, Buffer } as unknown as UnpackNode;
const code = 'module.exports = { startEndpoint() { return "the server"; } };\n';
const embedded: EmbeddedMcp = { gz: zlib.gzipSync(Buffer.from(code)).toString("base64"), sha256: createHash("sha256").update(code).digest("hex") };

describe("ensureMcpFile", () => {
  let dir = "";
  let file = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "mif-unpack-"));
    file = join(dir, "mcp.cjs");
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("writes the embedded code when the file is missing, and leaves a matching file alone", () => {
    expect(ensureMcpFile(file, embedded, node)).toBe("written");
    expect(fs.readFileSync(file, "utf8")).toBe(code);
    const stamp = fs.statSync(file).mtimeMs;
    expect(ensureMcpFile(file, embedded, node)).toBe("present");
    expect(fs.statSync(file).mtimeMs).toBe(stamp);
  });

  it("replaces a file left by another version, or altered", () => {
    fs.writeFileSync(file, "module.exports = { startEndpoint() { return 'an older server'; } };\n");
    expect(ensureMcpFile(file, embedded, node)).toBe("written");
    expect(fs.readFileSync(file, "utf8")).toBe(code);
  });

  it("refuses embedded code that does not match its recorded hash, and writes nothing", () => {
    const wrong = { ...embedded, sha256: "0".repeat(64) };
    expect(() => ensureMcpFile(file, wrong, node)).toThrow(/does not match its recorded hash/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("uses the file on disk as it is when nothing is embedded, as in a development build", () => {
    expect(ensureMcpFile(file, undefined, node)).toBe("missing");
    fs.writeFileSync(file, "anything");
    expect(ensureMcpFile(file, undefined, node)).toBe("kept");
    expect(fs.readFileSync(file, "utf8")).toBe("anything");
  });
});

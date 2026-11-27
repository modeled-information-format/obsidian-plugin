// The MCP server's code travels inside main.js (plan M54). Obsidian's plugin
// installer fetches main.js, manifest.json and styles.css from a release and
// nothing else, so a second file would never reach a user. The build gzips
// mcp.cjs into main.js as base64, with its sha256; desktop writes it out beside
// main.js the first time a vault turns the server on, and loads it from there.
//
// The file on disk is always made to match the copy in main.js: a missing,
// stale (left by an older version of the plugin) or altered mcp.cjs is replaced
// before it is loaded.

declare const __MIF_MCP_GZ__: string | undefined;
declare const __MIF_MCP_SHA256__: string | undefined;

export interface EmbeddedMcp {
  /** mcp.cjs, gzipped, as base64. */
  gz: string;
  /** sha256 of mcp.cjs, hex. */
  sha256: string;
}

/** The copy the build put in main.js; undefined in a development build, which uses the file on disk as it is. */
export const EMBEDDED_MCP: EmbeddedMcp | undefined =
  typeof __MIF_MCP_GZ__ === "string" && __MIF_MCP_GZ__ && typeof __MIF_MCP_SHA256__ === "string" ? { gz: __MIF_MCP_GZ__, sha256: __MIF_MCP_SHA256__ } : undefined;

/** The parts of Node this needs, passed in: main.js may not reach for Node when it loads. */
export interface UnpackNode {
  fs: { existsSync(p: string): boolean; readFileSync(p: string): Uint8Array; writeFileSync(p: string, data: Uint8Array): void };
  zlib: { gunzipSync(data: Uint8Array): Uint8Array };
  crypto: { createHash(name: "sha256"): { update(data: Uint8Array): { digest(encoding: "hex"): string } } };
  Buffer: { from(data: string, encoding: "base64"): Uint8Array };
}

/**
 * Make `file` the embedded server code. "present": it already was. "written":
 * it was missing or different and has been replaced. "kept": nothing is
 * embedded (a development build) and a file is there. "missing": nothing is
 * embedded and there is no file.
 */
export function ensureMcpFile(file: string, embedded: EmbeddedMcp | undefined, node: UnpackNode): "present" | "written" | "kept" | "missing" {
  const sha = (data: Uint8Array) => node.crypto.createHash("sha256").update(data).digest("hex");
  if (!embedded) return node.fs.existsSync(file) ? "kept" : "missing";
  if (node.fs.existsSync(file) && sha(node.fs.readFileSync(file)) === embedded.sha256) return "present";
  const code = node.zlib.gunzipSync(node.Buffer.from(embedded.gz, "base64"));
  // The copy in main.js is checked against its own hash before it is trusted as code.
  if (sha(code) !== embedded.sha256) throw new Error("The MCP server code inside main.js does not match its recorded hash; reinstall the plugin.");
  node.fs.writeFileSync(file, code);
  return "written";
}

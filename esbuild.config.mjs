import esbuild from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { gzipSync } from "node:zlib";

const prod = process.argv[2] === "production";

// The MCP server code is its own bundle, so main.js, which every platform
// loads, does not carry the MCP SDK as code. Desktop loads mcp.cjs when a vault
// turns the server on (src/main.ts, loadMcp).
const mcp = await esbuild.context({
  entryPoints: ["src/mcp/entry.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  format: "cjs",
  target: "es2022",
  platform: "browser",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  metafile: true,
  outfile: "mcp.cjs",
});

// Obsidian's installer fetches main.js, manifest.json and styles.css and nothing
// else, so a production main.js carries mcp.cjs inside it, gzipped, with its
// sha256 (src/mcpUnpack.ts). It is built first for that reason. A development
// build embeds nothing and uses the mcp.cjs on disk.
let embedded = { gz: "", sha256: "" };
const sizes = [];
if (prod) {
  const result = await mcp.rebuild();
  sizes.push(["mcp.cjs", Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0)]);
  await mcp.dispose();
  const code = readFileSync("mcp.cjs");
  embedded = { gz: gzipSync(code, { level: 9 }).toString("base64"), sha256: createHash("sha256").update(code).digest("hex") };
}

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    ...builtinModules,
  ],
  format: "cjs",
  target: "es2022",
  platform: "browser",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  metafile: true,
  outfile: "main.js",
  define: {
    // Visible in Settings and the Ontology panel, to tell which build is running.
    __MIF_BUILD__: JSON.stringify(new Date().toISOString().replace(/\.\d+Z$/, "Z")),
    __MIF_MCP_GZ__: JSON.stringify(embedded.gz),
    __MIF_MCP_SHA256__: JSON.stringify(embedded.sha256),
  },
});

if (prod) {
  const result = await ctx.rebuild();
  sizes.unshift(["main.js", Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0)]);
  await ctx.dispose();
  for (const [name, bytes] of sizes) console.log(`${name}: ${(bytes / 1024).toFixed(1)} KiB`);
  console.log(`mcp.cjs inside main.js: ${(embedded.gz.length / 1024).toFixed(1)} KiB (gzip, base64)`);
} else {
  await ctx.watch();
  await mcp.watch();
}

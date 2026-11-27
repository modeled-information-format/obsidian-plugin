import esbuild from "esbuild";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

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
  // Visible in Settings and the Ontology panel, to tell which build is running.
  define: { __MIF_BUILD__: JSON.stringify(new Date().toISOString().replace(/\.\d+Z$/, "Z")) },
});

// The MCP server code is its own file, so main.js, which every platform
// loads, does not carry the MCP SDK. Desktop loads mcp.cjs when a vault turns
// the server on (src/main.ts, loadMcp).
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

if (prod) {
  for (const [name, c] of [["main.js", ctx], ["mcp.cjs", mcp]]) {
    const result = await c.rebuild();
    const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
    console.log(`${name}: ${(bytes / 1024).toFixed(1)} KiB`);
    await c.dispose();
  }
} else {
  await ctx.watch();
  await mcp.watch();
}

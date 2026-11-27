// Mobile safety check for the built bundle. Obsidian on iOS and
// Android has no Node or Electron, so main.js must load without them:
//   - the only module-level require is "obsidian";
//   - Node built-ins are reached only through `window.require(...)` inside
//     desktop-gated code (the mif-cli bridge), never at load time;
//   - manifest.json does not claim desktop-only, and minAppVersion matches
//     versions.json.
//   npm run build && node scripts/check-mobile.mjs
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

const js = readFileSync("main.js", "utf8");
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
const problems = [];

for (const m of js.matchAll(/(window\.)?require\("([^"]+)"\)/g)) {
  const [, viaWindow, mod] = m;
  if (mod === "obsidian" && !viaWindow) continue;
  if (viaWindow && (builtinModules.includes(mod) || mod.startsWith("node:"))) continue; // lazy, desktop-gated
  problems.push(`${viaWindow ? "window." : ""}require("${mod}") in main.js`);
}
const lazyNode = [...js.matchAll(/window\.require\("([^"]+)"\)/g)].map((m) => m[1]);
if (/\brequire\("(fs|path|os|child_process|electron)"\)/.test(js.replace(/window\.require\(/g, "window.req("))) {
  problems.push("a Node built-in is required at module level");
}
if (manifest.isDesktopOnly !== false) problems.push(`manifest.json isDesktopOnly is ${manifest.isDesktopOnly}; the plugin is meant to run on mobile`);
if (versions[manifest.version] !== manifest.minAppVersion) {
  problems.push(`versions.json["${manifest.version}"] is ${versions[manifest.version]}, manifest minAppVersion is ${manifest.minAppVersion}`);
}
// The MCP server code (and with it the MCP SDK) belongs in mcp.cjs, which only desktop loads.
// Its tool names are the marker: main.js must not contain them, and mcp.cjs must.
const MARKER = "mif_vault_search_concepts";
if (js.includes(MARKER)) problems.push(`main.js contains the MCP server code (found "${MARKER}"); it belongs in mcp.cjs only`);
let mcpJs = "";
try {
  mcpJs = readFileSync("mcp.cjs", "utf8");
} catch {
  problems.push("mcp.cjs is missing: the build should emit it beside main.js");
}
if (mcpJs && !mcpJs.includes(MARKER)) problems.push("mcp.cjs does not contain the MCP server code");
// Obsidian's installer fetches main.js and not mcp.cjs, so main.js must carry this very mcp.cjs,
// compressed: its sha256 is recorded in main.js beside the copy (src/mcpUnpack.ts).
if (mcpJs && !js.includes(createHash("sha256").update(readFileSync("mcp.cjs")).digest("hex"))) problems.push("main.js does not carry this build's mcp.cjs (its sha256 is not in main.js): build with `npm run build`");
for (const m of mcpJs.matchAll(/\brequire\("([^"]+)"\)/g)) {
  if (!builtinModules.includes(m[1]) && !m[1].startsWith("node:")) problems.push(`mcp.cjs requires "${m[1]}", which is not bundled`);
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.version !== manifest.version) problems.push(`package.json version ${pkg.version} != manifest.json ${manifest.version}`);

if (problems.length) {
  console.error(`mobile check failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`mobile check passed: main.js requires only "obsidian" at load and carries the MCP server code only compressed; desktop-only lazy loads: ${lazyNode.join(", ") || "none"}, mcp.cjs`);

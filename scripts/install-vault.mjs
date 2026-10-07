// Install the built plugin into test-vault and stage the edge fixtures, so
// the vault can be opened in Obsidian for the spikes. Everything written
// here is gitignored (test-vault/.obsidian/, test-vault/_fixtures/).
//   npm run build && npm run install-vault
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(".");
const vault = join(root, "test-vault");
const pluginDir = join(vault, ".obsidian", "plugins", "mif");

if (!existsSync(join(root, "main.js"))) throw new Error("main.js missing: run `npm run build` first");
mkdirSync(pluginDir, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) cpSync(join(root, f), join(pluginDir, f));

// Enable the plugin and its developer commands on first open.
writeFileSync(join(vault, ".obsidian", "community-plugins.json"), JSON.stringify(["mif"]) + "\n");
if (!existsSync(join(pluginDir, "data.json"))) {
  writeFileSync(join(pluginDir, "data.json"), JSON.stringify({ showDevCommands: true }) + "\n");
}

// Edge fixtures exercise Spike B with YAML 1.1 scalars, timestamps, etc.
const fixtures = join(vault, "_fixtures", "edge");
rmSync(fixtures, { recursive: true, force: true });
mkdirSync(fixtures, { recursive: true });
const edge = join(root, "tests", "fixtures", "edge");
for (const f of readdirSync(edge).filter((f) => f.endsWith(".md"))) cpSync(join(edge, f), join(fixtures, f));

console.log(`installed plugin into ${pluginDir}\nstaged edge fixtures into ${fixtures}`);

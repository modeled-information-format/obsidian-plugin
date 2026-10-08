// Keep the reference docs true to the source:
//   docs/reference/diagnostics.md — every diagnostic code, both ways
//   docs/reference/commands.md    — every command name, both ways
//   docs/reference/settings.md    — every settings key, both ways
//   node scripts/check-docs.mjs
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? (f === "generated" ? [] : walk(join(d, f))) : f.endsWith(".ts") ? [join(d, f)] : []));
const src = walk("src").map((f) => readFileSync(f, "utf8")).join("\n");
const doc = (p) => readFileSync(p, "utf8");
const problems = [];
const compare = (what, inSource, inDocs) => {
  for (const x of inSource) if (!inDocs.has(x)) problems.push(`${what} '${x}' is in the source but not documented`);
  for (const x of inDocs) if (!inSource.has(x)) problems.push(`${what} '${x}' is documented but not in the source`);
};

// Diagnostic codes: `code: "x"` in diagnostic objects, and the semantics
// helpers info("x", …) / warn("x", …). Dynamic codes are listed by hand.
const NOT_CODES = new Set(["repository"]); // a citation-type synonym table entry, not a diagnostic
const codes = new Set([
  ...[...src.matchAll(/\bcode: "([a-z0-9.-]+)"/g)].map((m) => m[1]),
  ...[...src.matchAll(/\b(?:info|warn)\("([a-z0-9.-]+)"/g)].map((m) => m[1]),
  "citation-type", "citation-role", "schema-<keyword>",
].filter((c) => !NOT_CODES.has(c)));
const documentedCodes = new Set([...doc("docs/reference/diagnostics.md").matchAll(/^\| `([^`]+)` \|/gm)].map((m) => m[1]));
compare("diagnostic", codes, documentedCodes);

// Commands: name fields of addCommand calls and dev spike(...) registrations.
const main = readFileSync("src/main.ts", "utf8");
const commands = new Set([
  ...[...main.matchAll(/addCommand\(\{\s*id: "[^"]+",\s*name: "([^"]+)"/g)].map((m) => m[1]),
  ...[...main.matchAll(/^\s+id: "[^"]+",\n\s+name: "([^"]+)"/gm)].map((m) => m[1]),
  ...[...main.matchAll(/spike\("[^"]+", "([^"]+)"/g)].map((m) => m[1]),
]);
const documentedCommands = new Set([...doc("docs/reference/commands.md").matchAll(/^\| ([^|`]+?) \|/gm)].map((m) => m[1].trim()).filter((c) => c !== "Command"));
compare("command", commands, documentedCommands);

// Settings: keys of MifSettings.
const settingsTs = readFileSync("src/settings.ts", "utf8");
const iface = settingsTs.slice(settingsTs.indexOf("export interface MifSettings"), settingsTs.indexOf("export const DEFAULT_SETTINGS"));
const keys = new Set([...iface.matchAll(/^\s+([a-zA-Z]+): /gm)].map((m) => m[1]));
const documentedKeys = new Set([...doc("docs/reference/settings.md").matchAll(/^\|[^|]+\| `([a-zA-Z]+)` \|/gm)].map((m) => m[1]));
compare("setting", keys, documentedKeys);

if (problems.length) {
  console.error(`docs check failed:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`docs check passed: ${codes.size} diagnostic codes, ${commands.size} commands, ${keys.size} settings documented`);

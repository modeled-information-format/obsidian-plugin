// The MIF engine: pure functions with no Obsidian dependency, so they run
// under vitest and can be swapped for a mif-rs WASM build behind the same
// surface. Everything Obsidian-specific lives outside
// src/engine.

export {
  CONTEXT_URL,
  FRONTMATTER_ORDER,
  FrontmatterError,
  RESERVED_FILENAMES,
  jsonLdToMd,
  mdToJsonLd,
  normalize,
  orderedFrontmatter,
  parseMarkdown,
  projectionConflicts,
  roundtripDrift,
  serializeMarkdown,
  type Frontmatter,
  type JsonLd,
  type Namespaces,
} from "./convert";
export { CONFIG_SCHEMA_ID, MIF_SCHEMA_ID, validateAgainst, validateJsonLd, type SchemaIssue } from "./validate";
export { dumpYaml, loadYaml, pythonIsoTimestamp } from "./yaml11";

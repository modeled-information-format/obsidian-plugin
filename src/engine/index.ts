// The MIF engine: pure functions with no Obsidian dependency, so they run
// under vitest and can be swapped for a mif-rs WASM build behind the same
// surface. Everything Obsidian-specific lives outside
// src/engine.

export {
  scalarText,
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
export { CONFIG_SCHEMA_ID, MIF_SCHEMA_ID, validateAgainst, validateBundleConfig, validateJsonLd, type SchemaIssue } from "./validate";
export { dumpYaml, loadYaml, pythonIsoTimestamp } from "./yaml11";
export { analyze, ambiguities, detectRewrites, BASE_TYPES, isoSeconds, L2_FIELDS, levelOf, type Analysis, type AnalyzeOptions, type Diagnostic, type Fix, type Level, type Severity } from "./analyze";
export { newConceptText, promoteToConcept, type BaseType, type NewConcept, type Promotion } from "./concept";
export { toLf, updateFrontmatter, WriteError } from "./writer";
export {
  addRelationship,
  adoptMirror,
  bodyRelationships,
  buildRegistry,
  CORE_TYPES,
  frontmatterRelationships,
  incomingLabel,
  kebab,
  malformedMirrorLines,
  mirrorDrift,
  relativeTarget,
  removeRelationship,
  resolveTarget,
  retarget,
  syncMirror,
  updateRelationship,
  type RelationshipInput,
  type Registry,
  type RelType,
} from "./relationships";
export { buildIndex, bundleDiagnostics, titleForTarget, titleOf, toBundleConcept, type BundleConcept, type BundleIndex, type Edge } from "./bundle";
export { legacySigns, migrateConcept, migratedPath, type LegacySigns } from "./migrate";
export {
  chainTraits,
  composeTraits,
  discover,
  parseOntology,
  resolveChain,
  visibleNamespaces,
  visibleTypes,
  type ComposedType,
  type Corpus,
  type DiscoveryHit,
  type EntityTypeDef,
  type OntologyDef,
} from "./ontology";
export { entityReference, entitySlug, entityUrn, parseEntityFile, referencedEntities, renderEntityFile, ENTITY_URN, type EntityRecord } from "./entities";
export { semanticDiagnostics, usefulSuggestions, type SemanticContext, type SemanticReport } from "./semantics";
export { applyEdit, checkInput, FORM_KEYS, SECTIONS, topLevelModel, type Checked, type FieldKind, type FieldModel } from "./form";
export { DEFAULT_THRESHOLDS, durationMs, freshness, temporalDiagnostics, urgency, type Freshness, type FreshnessState, type Thresholds } from "./temporal";
export {
  adoptCitations, authorText, bodyCitations, citationAuthors, citationDiagnostics, citationMirrorDiagnostics, CITATION_ROLES, CITATION_TYPES,
  hasCitationSection, moveNoteToBody, syncCitations, type BodyCitation,
} from "./citations";
export { compress, compressionDiagnostics, compressionState, contentLines, decompress, type CompressionState } from "./compression";
export { provenanceDiagnostics, SOURCE_TYPES, TRUST_LEVELS, trustOf, vocabularyLabel } from "./provenance";
export { applyTextFix, VAULT_TRANSFORMS } from "./fixes";
export { exportPath, serializeJsonLd, staleExports } from "./export";
export { idFromUrn, parseIngest, parseProblem, parseScored, parseStats, type IngestResult, type Problem, type ScoredId } from "./cli";
export { graphOf, layout, type Graph, type GraphEdge, type GraphNode } from "./graph";

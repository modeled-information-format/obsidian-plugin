// JSON Schema validation of the JSON-LD projection against the canonical
// MIF schemas (vendored in ./schemas; spec §2.4: no network at runtime).
// Validators are compiled at build time by scripts/build-validators.mjs, so
// nothing is compiled — and no `new Function` runs — inside Obsidian.

import type { ErrorObject } from "ajv";

import { validateConfig as configValidator, validateMif as mifValidator, validateOntology as ontologyValidator } from "./generated/validators";

export const MIF_SCHEMA_ID = "https://mif-spec.dev/schema/mif.schema.json";
export const CONFIG_SCHEMA_ID = "https://mif-spec.dev/schema/relationship-types-config.schema.json";

export interface SchemaIssue {
  /** JSON Pointer into the document, e.g. "/relationships/0/type". */
  path: string;
  message: string;
  keyword: string;
  /** The property named by a `required` or `additionalProperties` error. */
  property?: string;
}

const toIssue = (e: ErrorObject): SchemaIssue => {
  const params = e.params as { missingProperty?: string; additionalProperty?: string };
  const property = params.missingProperty ?? params.additionalProperty;
  const message = e.message ?? e.keyword;
  return {
    path: e.instancePath || "/",
    message: e.keyword === "additionalProperties" && property ? `${message} ('${property}')` : message,
    keyword: e.keyword,
    ...(property ? { property } : {}),
  };
};

export const ONTOLOGY_SCHEMA_ID = "https://mif-spec.dev/schema/ontology/ontology.schema.json";

const VALIDATORS: Record<string, typeof mifValidator | undefined> = {
  [MIF_SCHEMA_ID]: mifValidator,
  [CONFIG_SCHEMA_ID]: configValidator,
  [ONTOLOGY_SCHEMA_ID]: ontologyValidator,
};

/** Validate a document against a vendored schema by $id. */
export function validateAgainst(schemaId: string, document: unknown): SchemaIssue[] {
  const fn = VALIDATORS[schemaId];
  if (!fn) throw new Error(`no generated validator for ${schemaId}`);
  return fn(document) ? [] : (fn.errors ?? []).map(toIssue);
}

/** Validate a JSON-LD projection against mif.schema.json. */
export const validateJsonLd = (jsonld: unknown) => validateAgainst(MIF_SCHEMA_ID, jsonld);

/** Validate a bundle's .mif/config.yaml against its schema. */
export const validateBundleConfig = (config: unknown) => validateAgainst(CONFIG_SCHEMA_ID, config);

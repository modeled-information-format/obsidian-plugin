// JSON Schema validation of the JSON-LD projection against the canonical
// MIF schemas, vendored in ./schemas (spec §2.4: no network at runtime).
// Refresh with `npm run sync-schemas`.

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import citation from "../../schemas/citation.schema.json";
import container from "../../schemas/container.schema.json";
import entityReference from "../../schemas/definitions/entity-reference.schema.json";
import documentReference from "../../schemas/document-reference.schema.json";
import mif from "../../schemas/mif.schema.json";
import relationshipTypesConfig from "../../schemas/relationship-types-config.schema.json";

export const MIF_SCHEMA_ID = "https://mif-spec.dev/schema/mif.schema.json";
export const CONFIG_SCHEMA_ID = "https://mif-spec.dev/schema/relationship-types-config.schema.json";

export interface SchemaIssue {
  /** JSON Pointer into the JSON-LD document, e.g. "/relationships/0/type". */
  path: string;
  message: string;
  keyword: string;
}

let ajv: Ajv2020 | undefined;
const compiled = new Map<string, ValidateFunction>();

function instance(): Ajv2020 {
  if (ajv) return ajv;
  ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  for (const schema of [entityReference, documentReference, citation, container, relationshipTypesConfig, mif]) {
    ajv.addSchema(schema as object);
  }
  return ajv;
}

const toIssue = (e: ErrorObject): SchemaIssue => ({
  path: e.instancePath || "/",
  message: e.message ?? e.keyword,
  keyword: e.keyword,
});

/** Validate a document against a vendored schema by $id. */
export function validateAgainst(schemaId: string, document: unknown): SchemaIssue[] {
  let fn = compiled.get(schemaId);
  if (!fn) {
    fn = instance().getSchema(schemaId);
    if (!fn) throw new Error(`schema not vendored: ${schemaId}`);
    compiled.set(schemaId, fn);
  }
  return fn(document) ? [] : (fn.errors ?? []).map(toIssue);
}

/** Validate a JSON-LD projection against mif.schema.json. */
export const validateJsonLd = (jsonld: unknown) => validateAgainst(MIF_SCHEMA_ID, jsonld);

// Provenance (spec §12): the source-type and trust vocabularies, and
// advisory checks that a concept's confidence and trust fit its source.
// §12.1's confidence ranges are descriptive and overlap,
// so a value outside them is information, not an error.

import type { Diagnostic } from "./analyze";
import type { Frontmatter } from "./convert";

export const SOURCE_TYPES: Record<string, { description: string; range: [number, number] }> = {
  user_explicit: { description: "User directly stated", range: [0.9, 1] },
  user_implicit: { description: "Inferred from user actions", range: [0.7, 0.89] },
  agent_inferred: { description: "AI reasoning from context", range: [0.5, 0.69] },
  external_import: { description: "From an external data source", range: [0.3, 0.7] },
  system_generated: { description: "Automatically generated", range: [0.2, 0.5] },
};

/** §12.2, most to least trusted. */
export const TRUST_LEVELS: Record<string, string> = {
  verified: "Confirmed by multiple sources",
  user_stated: "User explicitly provided",
  high_confidence: "Strong inference",
  moderate_confidence: "Reasonable inference",
  low_confidence: "Weak inference",
  uncertain: "Unverified",
};

/** Option text for vocabulary dropdowns. */
export function vocabularyLabel(field: string, value: string): string | undefined {
  if (field === "sourceType" && SOURCE_TYPES[value]) {
    const { description, range } = SOURCE_TYPES[value];
    return `${value} — ${description} (${range[0].toFixed(2)}–${range[1].toFixed(2)})`;
  }
  if (field === "trustLevel" && TRUST_LEVELS[value]) return `${value} — ${TRUST_LEVELS[value]}`;
  return undefined;
}

export const trustOf = (fm: Frontmatter | undefined): string | undefined => {
  const p = fm?.provenance;
  return p && typeof p === "object" && typeof (p as Record<string, unknown>).trustLevel === "string" ? ((p as Record<string, unknown>).trustLevel as string) : undefined;
};

export function provenanceDiagnostics(fm: Frontmatter): Diagnostic[] {
  const p = fm.provenance;
  if (p === undefined || p === null || typeof p !== "object" || Array.isArray(p)) return [];
  const prov = p as Record<string, unknown>;
  const out: Diagnostic[] = [];
  const meaningful = Object.keys(prov).filter((k) => k !== "@type");
  if (meaningful.length === 0) {
    out.push({ severity: "info", code: "provenance-empty", message: "`provenance` is empty: it meets the Level 3 floor but records nothing (§12.3).", path: ["provenance"], fixes: [] });
    return out;
  }
  const source = typeof prov.sourceType === "string" ? SOURCE_TYPES[prov.sourceType] : undefined;
  if (source && typeof prov.confidence === "number" && prov.confidence >= 0 && prov.confidence <= 1) {
    const [lo, hi] = source.range;
    if (prov.confidence < lo || prov.confidence > hi + 0.0099) {
      out.push({ severity: "info", code: "provenance-confidence",
        message: `Confidence ${prov.confidence} is outside the ${lo.toFixed(2)}–${hi.toFixed(2)} range §12.1 gives for ${String(prov.sourceType)}.`,
        path: ["provenance", "confidence"], fixes: [] });
    }
  }
  if (prov.trustLevel === "user_stated" && typeof prov.sourceType === "string" && !prov.sourceType.startsWith("user_")) {
    out.push({ severity: "info", code: "provenance-trust",
      message: `trustLevel user_stated with sourceType ${prov.sourceType}: the user did not state this (§12.2).`,
      path: ["provenance", "trustLevel"], fixes: [] });
  }
  if (prov.sourceType === "external_import" && (prov.trustLevel === "verified" || prov.trustLevel === "user_stated")) {
    out.push({ severity: "info", code: "provenance-trust",
      message: `An external import marked ${prov.trustLevel}: §18.3 says imports should not raise trust.`,
      path: ["provenance", "trustLevel"], fixes: [] });
  }
  return out;
}

// Applying a quick fix to a file's text. Transforms that need the vault
// (migrate, download-ontology, create-entity) are handled by the plugin.

import type { Fix } from "./analyze";
import { adoptCitations, moveNoteToBody, syncCitations } from "./citations";
import { compress, decompress } from "./compression";
import { applyEdit } from "./form";
import { adoptMirror, syncMirror } from "./relationships";
import { toLf, updateFrontmatter, WriteError } from "./writer";

export const VAULT_TRANSFORMS = new Set<Fix["transform"]>(["migrate", "download-ontology", "create-entity"]);

export function applyTextFix(text: string, fix: Fix, opts: { titleFor?: (target: string) => string | undefined; now?: Date } = {}): string {
  switch (fix.transform) {
    case "lf":
      return toLf(text);
    case "mirror":
      return syncMirror(text, opts.titleFor);
    case "mirror-adopt":
      return syncMirror(adoptMirror(text), opts.titleFor);
    case "citations-sync":
      return syncCitations(text, { create: true });
    case "citations-adopt":
      // Adopted entries take the spec's fallbacks; the sync then writes those back.
      return syncCitations(adoptCitations(text));
    case "citation-note-to-body":
      return moveNoteToBody(text, Number(fix.data?.index));
    case "compress":
      return compress(text, opts.now);
    case "decompress":
      return decompress(text);
    case undefined:
      break;
    default:
      throw new WriteError(`'${fix.transform}' is not a text fix`);
  }
  let out = text;
  for (const e of fix.edits ?? []) out = applyEdit(out, e.path, e.value);
  if (fix.updates) out = updateFrontmatter(out, fix.updates);
  return out;
}

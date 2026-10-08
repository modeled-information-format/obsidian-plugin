// Runtime helpers referenced by the generated validators (scripts/
// build-validators.mjs rewrites Ajv's CommonJS require() calls to these).
// Named imports only, so esbuild and Vitest resolve them the same way.

import { fullFormats } from "ajv-formats/dist/formats";

export const formats = { fullFormats };

/** Length in Unicode code points (Ajv's runtime/ucs2length). */
function ucs2length(str: string): number {
  let length = 0;
  for (let pos = 0; pos < str.length; length++) {
    const code = str.charCodeAt(pos++);
    if (code >= 0xd800 && code <= 0xdbff && pos < str.length) {
      const next = str.charCodeAt(pos);
      if ((next & 0xfc00) === 0xdc00) pos++;
    }
  }
  return length;
}

export const ucs2 = { default: ucs2length };

// PyYAML-compatible YAML loading for MIF frontmatter.
//
// The MIF reference converter (mif_convert.py) reads frontmatter with
// PyYAML's safe_load, i.e. YAML 1.1 resolution, then stringifies dates and
// datetimes with Python's isoformat(). The `yaml` package's own 1.1 schema
// differs from PyYAML in several places (y/n booleans, 1e3 floats, leading-
// zero decimals, timestamps as Date), so those tags are replaced here with
// PyYAML's exact implicit-resolver regexes. tests/golden pins the behaviour.
//
// Note: mif-rs (serde_norway) resolves YAML closer to 1.2 and keeps
// timestamps verbatim, so it disagrees with this module on those scalars.

import { isScalar, parseDocument, stringify, visit, type ScalarTag, type Tags } from "yaml";
import { stringifyNumber } from "yaml/util";

const TIMESTAMP_TAG = "tag:yaml.org,2002:timestamp";
const BOOL_TAG = "tag:yaml.org,2002:bool";
const INT_TAG = "tag:yaml.org,2002:int";
const FLOAT_TAG = "tag:yaml.org,2002:float";
const REPLACED = new Set([TIMESTAMP_TAG, BOOL_TAG, INT_TAG, FLOAT_TAG]);
// The same tags by their built-in names, for Tags entries given as strings.
const REPLACED_NAMES = new Set([
  "bool", "int", "intHex", "intOct", "intTime", "float", "floatExp", "floatNaN", "floatTime", "timestamp",
]);

// --- PyYAML implicit resolvers (yaml/resolver.py) --------------------------

const BOOL_TRUE = /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/;
const BOOL_FALSE = /^(?:no|No|NO|false|False|FALSE|off|Off|OFF)$/;

const INT_RE =
  /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/;

const FLOAT_RE =
  /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;

const TIMESTAMP_RE =
  /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/;

// PyYAML constructor regex (yaml/constructor.py, construct_yaml_timestamp).
const TIMESTAMP_PARTS =
  /^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:(?:[Tt]|[ \t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\.([0-9]*))?(?:[ \t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?)?$/;

// --- constructors -----------------------------------------------------------

function sexagesimal(text: string): number {
  // PyYAML: digits are base-60 from the right; sign applies to the whole.
  let sign = 1;
  let s = text;
  if (s.startsWith("-")) {
    sign = -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }
  let value = 0;
  for (const part of s.split(":")) value = value * 60 + Number(part);
  return sign * value;
}

function constructInt(raw: string): number {
  const text = raw.replace(/_/g, "");
  const negative = text.startsWith("-");
  const unsigned = text.replace(/^[-+]/, "");
  let value: number;
  if (unsigned === "0") value = 0;
  else if (unsigned.startsWith("0b")) value = parseInt(unsigned.slice(2), 2);
  else if (unsigned.startsWith("0x")) value = parseInt(unsigned.slice(2), 16);
  else if (unsigned.startsWith("0")) value = parseInt(unsigned, 8);
  else if (unsigned.includes(":")) return sexagesimal(text);
  else value = parseInt(unsigned, 10);
  // Python ints have no negative zero.
  return negative && value !== 0 ? -value : value;
}

function constructFloat(raw: string): number {
  const text = raw.replace(/_/g, "").toLowerCase();
  if (text.endsWith(".inf")) return text.startsWith("-") ? -Infinity : Infinity;
  if (text === ".nan") return NaN;
  if (text.includes(":")) return sexagesimal(text);
  return Number(text);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/**
 * Construct a PyYAML timestamp and render it exactly as mif_convert.py's
 * stringify_datetimes() would: date.isoformat() for dates, and
 * datetime.isoformat() with "+00:00" replaced by "Z" for datetimes.
 */
export function pythonIsoTimestamp(raw: string): string {
  const m = TIMESTAMP_PARTS.exec(raw);
  if (!m) throw new Error(`invalid timestamp: ${raw}`);
  const [, y, mo, d, h, mi, s, frac, tz, tzSign, tzHour, tzMinute] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (month < 1 || month > 12 || probe.getUTCDate() !== day) {
    throw new Error(`invalid date in timestamp: ${raw}`);
  }
  const date = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
  if (h === undefined) return date;

  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (hour > 23 || minute > 59 || second > 59) {
    throw new Error(`invalid time in timestamp: ${raw}`);
  }
  let out = `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
  if (frac !== undefined) {
    const micro = Number(frac.slice(0, 6).padEnd(6, "0"));
    if (micro !== 0) out += `.${pad(micro, 6)}`;
  }
  if (tzSign !== undefined) {
    const offHour = Number(tzHour);
    const offMinute = Number(tzMinute ?? "0");
    if (offHour * 60 + offMinute >= 24 * 60) {
      throw new Error(`invalid UTC offset in timestamp: ${raw}`);
    }
    if (offHour === 0 && offMinute === 0) return `${out}Z`;
    // Python normalizes the sign of a negative offset onto the whole delta.
    out += `${tzSign}${pad(offHour)}:${pad(offMinute)}`;
  } else if (tz === "Z") {
    out += "Z";
  }
  return out;
}

// --- tags -------------------------------------------------------------------

const boolTrue: ScalarTag = {
  identify: (v) => v === true,
  default: true,
  tag: BOOL_TAG,
  test: BOOL_TRUE,
  resolve: () => true,
  stringify: () => "true",
};

const boolFalse: ScalarTag = {
  identify: (v) => v === false,
  default: true,
  tag: BOOL_TAG,
  test: BOOL_FALSE,
  resolve: () => false,
  stringify: () => "false",
};

const intTag: ScalarTag = {
  identify: (v) => typeof v === "number" && Number.isInteger(v),
  default: true,
  tag: INT_TAG,
  test: INT_RE,
  resolve: constructInt,
  stringify: stringifyNumber,
};

const floatTag: ScalarTag = {
  identify: (v) => typeof v === "number",
  default: true,
  tag: FLOAT_TAG,
  test: FLOAT_RE,
  resolve: constructFloat,
  stringify(item) {
    const n = Number(item.value);
    if (Number.isNaN(n)) return ".nan";
    if (!Number.isFinite(n)) return n < 0 ? "-.inf" : ".inf";
    return stringifyNumber(item);
  },
};

// Resolves to the Python isoformat string, never a Date. On output, a string
// matching TIMESTAMP_RE is quoted (the test regex marks it as ambiguous),
// which mirrors PyYAML's safe_dump of a str that looks like a timestamp.
const timestampTag: ScalarTag = {
  // On output, a string already in the exact form PyYAML would produce for
  // it is written plain (`created: 2026-01-15T10:30:00Z`), as MIF examples
  // do; it reads back as the same string. Any other timestamp-looking
  // string is quoted by the string tag.
  identify: (v) => typeof v === "string" && TIMESTAMP_RE.test(v) && safeIso(v) === v,
  default: true,
  tag: TIMESTAMP_TAG,
  test: TIMESTAMP_RE,
  resolve: pythonIsoTimestamp,
  stringify: (item) => String(item.value),
};

function safeIso(v: string): string | null {
  try {
    return pythonIsoTimestamp(v);
  } catch {
    return null;
  }
}

// timestampTag goes first so its identify() is tried before the string tag's.
const pyyamlTags = (tags: Tags): Tags => [
  timestampTag,
  ...tags.filter((t) => (typeof t === "string" ? !REPLACED_NAMES.has(t) : !REPLACED.has(t.tag))),
  boolTrue,
  boolFalse,
  intTag,
  floatTag,
];

export const LOAD_OPTIONS = {
  version: "1.1",
  schema: "yaml-1.1",
  customTags: pyyamlTags,
  merge: true,
  // PyYAML keeps the last of duplicate keys; we refuse instead, because a
  // silently shadowed key in a knowledge document is a defect worth surfacing.
  uniqueKeys: true,
} as const;

/** Load YAML text with PyYAML safe_load semantics (timestamps as strings). */
export function loadYaml(text: string): unknown {
  const doc = parseDocument(text, LOAD_OPTIONS);
  const [error] = doc.errors;
  if (error) throw error;
  if (!text.endsWith("\n")) {
    // A block scalar that runs to the end of a stream with no final line
    // break has no break to keep: PyYAML (per spec) returns "x", while the
    // `yaml` package appends "\n". Frontmatter text always lacks the final
    // break (FRONTMATTER_RE stops before "\n---"), so this case is common.
    visit(doc, {
      Scalar(_, node) {
        const blockScalar = node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED";
        if (blockScalar && isScalar(node) && node.range && node.range[1] >= text.length
            && typeof node.value === "string" && node.value.endsWith("\n")) {
          node.value = node.value.slice(0, -1);
        }
      },
    });
  }
  return doc.toJS();
}

/**
 * Dump a value as block-style YAML, quoting any string that would otherwise
 * resolve to a non-string under the PyYAML rules above. Not byte-identical
 * to PyYAML's safe_dump (folding and quote style differ); it is
 * semantically identical, which is what round-trip comparison relies on.
 */
export function dumpYaml(value: unknown, opts: { indentSeq?: boolean } = {}): string {
  return stringify(value, {
    ...LOAD_OPTIONS,
    indentSeq: opts.indentSeq ?? false,
    lineWidth: 0,
    defaultStringType: "PLAIN",
  });
}

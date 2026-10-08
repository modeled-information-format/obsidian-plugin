// Minimal text edits between two versions, as separate hunks, so an open
// editor is changed only where the text actually changed (cursor, folds,
// and selections elsewhere stay put).

export interface Hunk {
  /** Offsets into the old text. */
  from: number;
  to: number;
  text: string;
}

/**
 * Line-level LCS diff, then each changed line run is trimmed to its common
 * prefix/suffix. Falls back to a single trimmed hunk for very large inputs.
 */
export function textHunks(before: string, after: string, maxLines = 4000): Hunk[] {
  if (before === after) return [];
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > maxLines * maxLines / 4) return [trim(before, after, 0, before.length, 0, after.length)];

  // LCS table over lines.
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  // Line start offsets (with a sentinel at the end).
  const starts = (lines: string[]) => {
    const out = [0];
    for (const l of lines) out.push(out[out.length - 1]! + l.length + 1);
    return out;
  };
  const sa = starts(a);
  const sb = starts(b);
  const off = (s: number[], i: number, text: string) => Math.min(s[i]!, text.length);

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    const i0 = i;
    const j0 = j;
    while ((i < n || j < m) && !(i < n && j < m && a[i] === b[j])) {
      if (j >= m || (i < n && lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) i++;
      else j++;
    }
    hunks.push(trim(before, after, off(sa, i0, before), off(sa, i, before), off(sb, j0, after), off(sb, j, after)));
  }
  return hunks.filter((h) => h.from !== h.to || h.text !== "");
}

function trim(before: string, after: string, aFrom: number, aTo: number, bFrom: number, bTo: number): Hunk {
  while (aFrom < aTo && bFrom < bTo && before[aFrom] === after[bFrom]) {
    aFrom++;
    bFrom++;
  }
  while (aTo > aFrom && bTo > bFrom && before[aTo - 1] === after[bTo - 1]) {
    aTo--;
    bTo--;
  }
  return { from: aFrom, to: aTo, text: after.slice(bFrom, bTo) };
}

/** Apply hunks (offsets into `text`) — the inverse, for tests. */
export function applyHunks(text: string, hunks: Hunk[]): string {
  let out = text;
  for (const h of [...hunks].sort((x, y) => y.from - x.from)) out = out.slice(0, h.from) + h.text + out.slice(h.to);
  return out;
}

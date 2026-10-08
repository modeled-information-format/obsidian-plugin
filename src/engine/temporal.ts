// Temporal model and freshness (spec §9). Computed live, never written back
// automatically. Choices where the spec is silent or self-contradictory:
//   - exponential uses a true half-life, 0.5^(t/halfLife) (the field's name
//     and mnemonic's decay.py), not §9.2's e^(-t/halfLife);
//   - t runs from the latest of decay.lastReinforced, temporal.lastAccessed,
//     temporal.recordedAt, created (reinforcement resets it, §9.3);
//   - linear and step use ttl, as §9.2 says;
//   - validUntil in the past, or ttl elapsed since recordedAt, is "expired"
//     whatever the strength; validFrom in the future is "not yet valid".

import type { Diagnostic, Fix } from "./analyze";
import { scalarText, type Frontmatter } from "./convert";

export type FreshnessState = "fresh" | "ageing" | "stale" | "expired" | "not-yet-valid" | "timeless";

export interface Thresholds {
  /** strength >= fresh → fresh */
  fresh: number;
  /** strength >= ageing → ageing, else stale */
  ageing: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { fresh: 0.75, ageing: 0.5 };

export interface Freshness {
  state: FreshnessState;
  /** 0..1 when a decay model applies. */
  strength?: number;
  model: "none" | "linear" | "exponential" | "step";
  /** Which field `t` was measured from, and when. */
  since?: { field: string; at: string };
  /** When the concept stops being valid (validUntil or recordedAt + ttl). */
  expiresAt?: string;
  validFrom?: string;
  validUntil?: string | null;
  recordedAt?: string;
  /** Stored strength, if the concept records one (strength or currentStrength). */
  storedStrength?: number;
  /** Why the state is what it is, for display. */
  reason: string;
  /** Problems with the temporal data itself. */
  problems: string[];
}

const DAY = 86_400_000;

/**
 * ISO 8601 duration → milliseconds. Years are 365 days and months 30 days,
 * as in mnemonic's parse_duration_days; weeks and time parts are supported.
 */
export function durationMs(d: unknown): number | null {
  if (typeof d !== "string") return null;
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(d.trim());
  if (!m || d.trim() === "P" || d.trim().endsWith("T")) return null;
  const [, y, mo, w, dd, h, mi, s] = m.map((x) => (x === undefined ? 0 : Number(x)));
  return ((y! * 365 + mo! * 30 + w! * 7 + dd!) * 24 * 3600 + h! * 3600 + mi! * 60 + s!) * 1000;
}

const parseTime = (v: unknown): number | null => {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) || !v.includes("T") ? v : `${v}Z`);
  return Number.isNaN(t) ? null : t;
};

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export function decayStrength(model: Freshness["model"], ageMs: number, halfLifeMs: number | null, ttlMs: number | null): number | undefined {
  const t = Math.max(0, ageMs);
  switch (model) {
    case "none":
      return 1;
    case "exponential":
      return halfLifeMs && halfLifeMs > 0 ? Math.pow(0.5, t / halfLifeMs) : undefined;
    case "linear":
      return ttlMs && ttlMs > 0 ? Math.max(0, 1 - t / ttlMs) : undefined;
    case "step":
      return ttlMs && ttlMs > 0 ? (t < ttlMs ? 1 : 0) : undefined;
  }
}

export function freshness(fm: Frontmatter, now: Date = new Date(), thresholds: Thresholds = DEFAULT_THRESHOLDS): Freshness {
  const temporal = (fm.temporal && typeof fm.temporal === "object" ? fm.temporal : {}) as Record<string, unknown>;
  const decay = (temporal.decay && typeof temporal.decay === "object" ? temporal.decay : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const nowMs = now.getTime();

  const model = (typeof decay.model === "string" && ["none", "linear", "exponential", "step"].includes(decay.model) ? decay.model : "none") as Freshness["model"];
  const halfLifeMs = durationMs(decay.halfLife);
  const ttlMs = durationMs(temporal.ttl);
  if (decay.halfLife !== undefined && halfLifeMs === null) problems.push(`decay.halfLife '${scalarText(decay.halfLife)}' is not an ISO 8601 duration`);
  if (temporal.ttl !== undefined && ttlMs === null) problems.push(`ttl '${scalarText(temporal.ttl)}' is not an ISO 8601 duration`);
  if (model === "exponential" && !halfLifeMs) problems.push("exponential decay needs decay.halfLife");
  if ((model === "linear" || model === "step") && !ttlMs) problems.push(`${model} decay needs temporal.ttl`);

  const stored = typeof decay.currentStrength === "number" ? decay.currentStrength : typeof decay.strength === "number" ? decay.strength : undefined;
  if (typeof decay.currentStrength === "number" && typeof decay.strength === "number" && decay.currentStrength !== decay.strength) {
    problems.push("decay.strength and decay.currentStrength (aliases) disagree");
  }

  const validFrom = parseTime(temporal.validFrom);
  const validUntil = parseTime(temporal.validUntil);
  const recordedAt = parseTime(temporal.recordedAt) ?? parseTime(fm.created);
  if (validFrom !== null && validUntil !== null && validUntil < validFrom) problems.push("validUntil is before validFrom");

  // Reference time for decay: the latest reinforcement-like event.
  const candidates: Array<[string, unknown]> = [
    ["temporal.decay.lastReinforced", decay.lastReinforced],
    ["temporal.lastAccessed", temporal.lastAccessed],
    ["temporal.recordedAt", temporal.recordedAt],
    ["created", fm.created],
  ];
  let since: { field: string; at: number } | undefined;
  for (const [field, v] of candidates) {
    const t = parseTime(v);
    if (t !== null && (!since || t > since.at)) since = { field, at: t };
  }

  const ttlExpiry = ttlMs && recordedAt !== null ? recordedAt + ttlMs : null;
  const expiry = [validUntil, ttlExpiry].filter((x): x is number => x !== null).sort((a, b) => a - b)[0];

  const base = {
    model,
    since: since ? { field: since.field, at: iso(since.at) } : undefined,
    expiresAt: expiry !== undefined ? iso(expiry) : undefined,
    validFrom: typeof temporal.validFrom === "string" ? temporal.validFrom : undefined,
    validUntil: temporal.validUntil === null ? null : typeof temporal.validUntil === "string" ? temporal.validUntil : undefined,
    recordedAt: typeof temporal.recordedAt === "string" ? temporal.recordedAt : undefined,
    storedStrength: stored,
    problems,
  };

  if (validFrom !== null && validFrom > nowMs) {
    return { ...base, state: "not-yet-valid", reason: `valid from ${iso(validFrom)}` };
  }
  if (expiry !== undefined && expiry <= nowMs) {
    const why = expiry === validUntil ? "validUntil passed" : "ttl elapsed";
    return { ...base, state: "expired", strength: model === "none" ? undefined : 0, reason: `${why} ${Math.floor((nowMs - expiry) / DAY)} days ago` };
  }
  if (model === "none" || !since) {
    return { ...base, state: "timeless", reason: model === "none" ? "no decay model" : "no reference time" };
  }
  const strength = decayStrength(model, nowMs - since.at, halfLifeMs, ttlMs);
  if (strength === undefined) return { ...base, state: "timeless", reason: "decay parameters missing" };
  const state: FreshnessState = strength >= thresholds.fresh ? "fresh" : strength >= thresholds.ageing ? "ageing" : "stale";
  const age = Math.floor((nowMs - since.at) / DAY);
  return { ...base, state, strength, reason: `${model} decay, ${age} days since ${since.field.replace(/^temporal\.(decay\.)?/, "")}` };
}

/** Sort key: expired first (longest ago), then lowest strength. */
export function urgency(f: Freshness, now: Date = new Date()): number {
  if (f.state === "expired") return -1e12 - (now.getTime() - Date.parse(f.expiresAt ?? now.toISOString()));
  if (f.strength !== undefined) return f.strength;
  return 2;
}

// --- diagnostics -------------------------------------------------------------------

const pct = (n: number) => n.toFixed(2);

/** Advisory freshness diagnostics for one concept at `now`. */
/** "90 days", "2 weeks", "1 year" → an ISO 8601 duration ("P90D"), when unambiguous. */
export function toIsoDuration(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^\s*(\d+)\s*(day|days|d|week|weeks|w|month|months|mo|year|years|y)\s*$/i.exec(v);
  if (!m) return undefined;
  const unit = m[2]!.toLowerCase();
  const code = unit.startsWith("d") ? "D" : unit.startsWith("w") ? "W" : unit.startsWith("mo") ? "M" : "Y";
  return `P${m[1]}${code}`;
}

const SUPERSEDE: Fix = { label: "Supersede with a new concept", transform: "supersede" };

/** Advisory freshness diagnostics for one concept at `now`, each with ways to resolve it. */
export function temporalDiagnostics(fm: Frontmatter, now: Date = new Date(), thresholds: Thresholds = DEFAULT_THRESHOLDS): Diagnostic[] {
  const f = freshness(fm, now, thresholds);
  const out: Diagnostic[] = [];
  const stamp = iso(now.getTime());
  const temporal = (fm.temporal && typeof fm.temporal === "object" ? fm.temporal : {}) as Record<string, unknown>;
  const decay = (temporal.decay && typeof temporal.decay === "object" ? temporal.decay : {}) as Record<string, unknown>;
  const set = (path: Array<string | number>, value: unknown) => ({ path: ["temporal", ...path], value });

  // Problems with the temporal data itself, with a repair where one is clear.
  for (const p of f.problems) {
    const fixes: Fix[] = [];
    if (p.startsWith("ttl ")) {
      const iso8601 = toIsoDuration(temporal.ttl);
      if (iso8601) fixes.push({ label: `Use ${iso8601}`, edits: [set(["ttl"], iso8601)] });
      fixes.push({ label: "Remove ttl", edits: [set(["ttl"], undefined)] });
    } else if (p.startsWith("decay.halfLife ")) {
      const iso8601 = toIsoDuration(decay.halfLife);
      if (iso8601) fixes.push({ label: `Use ${iso8601}`, edits: [set(["decay", "halfLife"], iso8601)] });
    } else if (p === "exponential decay needs decay.halfLife") {
      fixes.push({ label: "Set halfLife to P30D", edits: [set(["decay", "halfLife"], "P30D")] });
    } else if (/decay needs temporal\.ttl$/.test(p)) {
      fixes.push({ label: "Set ttl to P90D", edits: [set(["ttl"], "P90D")] });
    } else if (p === "validUntil is before validFrom") {
      fixes.push({ label: "Swap validFrom and validUntil", edits: [set(["validFrom"], temporal.validUntil), set(["validUntil"], temporal.validFrom)] });
    } else if (p.includes("aliases) disagree") && typeof decay.currentStrength === "number") {
      fixes.push({ label: `Use ${String(decay.currentStrength)} for both`, edits: [set(["decay", "strength"], decay.currentStrength)] });
    }
    out.push({ severity: "warning", code: "temporal-invalid", message: `Temporal data: ${p}.`, path: ["temporal"], fixes });
  }

  if (f.state === "expired") {
    const ttlExpired = /ttl/.test(f.reason);
    const fixes: Fix[] = [];
    if (ttlExpired) {
      fixes.push({ label: "Renew: set recordedAt to now", edits: [set(["recordedAt"], stamp)] });
      fixes.push({ label: "Remove ttl (no expiry)", edits: [set(["ttl"], undefined)] });
    } else {
      // Extend by the concept's own validity span, or a year when it has none.
      const from = typeof temporal.validFrom === "string" ? Date.parse(temporal.validFrom) : NaN;
      const until = typeof temporal.validUntil === "string" ? Date.parse(temporal.validUntil) : NaN;
      const span = !Number.isNaN(from) && !Number.isNaN(until) && until > from ? until - from : 365 * DAY;
      const extended = iso(now.getTime() + span);
      fixes.push({ label: `Extend validUntil to ${extended.slice(0, 10)}`, edits: [set(["validUntil"], extended)] });
      fixes.push({ label: "Remove validUntil (no end)", edits: [set(["validUntil"], undefined)] });
    }
    fixes.push(SUPERSEDE);
    out.push({
      severity: "warning",
      code: "freshness-expired",
      message: `Expired: ${f.reason}. Extend or renew it if it still holds, or supersede it with a new concept.`,
      path: ["temporal", ttlExpired ? "ttl" : "validUntil"],
      fixes,
    });
  } else if (f.state === "stale" || f.state === "ageing") {
    const reviewed: Fix = {
      label: "Mark reviewed now",
      edits: [set(["decay", "lastReinforced"], stamp)],
    };
    if (f.state === "stale") {
      out.push({
        severity: "info",
        code: "freshness-stale",
        message: `Stale: strength ${pct(f.strength!)} (${f.reason}). Mark it reviewed if it still holds, or supersede it.`,
        path: ["temporal", "decay"],
        fixes: [reviewed, SUPERSEDE],
      });
    } else {
      out.push({
        severity: "info",
        code: "freshness-ageing",
        message: `Ageing: strength ${pct(f.strength!)} (${f.reason}). Mark it reviewed if it still holds.`,
        path: ["temporal", "decay"],
        fixes: [reviewed],
      });
    }
  } else if (f.state === "not-yet-valid") {
    out.push({
      severity: "info",
      code: "freshness-future",
      message: `Not yet valid: ${f.reason}.`,
      path: ["temporal", "validFrom"],
      fixes: [{ label: "Make it valid now", edits: [set(["validFrom"], stamp)] }],
    });
  }
  if (f.storedStrength !== undefined && f.strength !== undefined && Math.abs(f.storedStrength - f.strength) > 0.2) {
    const key = typeof decay.currentStrength === "number" ? "currentStrength" : "strength";
    out.push({
      severity: "info",
      code: "freshness-recorded",
      message: `Recorded strength ${pct(f.storedStrength)} differs from the computed ${pct(f.strength)}.`,
      path: ["temporal", "decay", key],
      fixes: [{ label: `Record ${pct(f.strength)}`, edits: [set(["decay", key], Math.round(f.strength * 100) / 100)] }],
    });
  }
  return out;
}

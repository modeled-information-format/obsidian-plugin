// Freshness (spec §9) against mnemonic's decay.py curves (tests/golden/decay.json)
// and the state rules chosen where the spec is silent.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { decayStrength, durationMs, freshness, urgency } from "../src/engine/temporal";

const golden = JSON.parse(readFileSync(join(__dirname, "golden/decay.json"), "utf8")) as {
  curves: Array<{ model: "exponential" | "linear" | "step" | "none"; halfLifeDays: number; days: number; strength: number }>;
  durationDays: Record<string, number | null>;
};
const DAY = 86_400_000;

describe("decay curves match mnemonic's decay.calculate_strength", () => {
  for (const c of golden.curves) {
    it(`${c.model} ${c.halfLifeDays}d at ${c.days}d`, () => {
      // mnemonic uses halfLife as the span for linear/step; the spec uses ttl.
      const span = c.halfLifeDays * DAY;
      expect(decayStrength(c.model, c.days * DAY, span, span)).toBeCloseTo(c.strength, 10);
    });
  }
});

describe("durations", () => {
  for (const [text, days] of Object.entries(golden.durationDays)) {
    it(JSON.stringify(text), () => expect(durationMs(text)).toBe(days === null ? null : days * DAY));
  }
  it("also reads weeks and time parts", () => {
    expect(durationMs("P2W")).toBe(14 * DAY);
    expect(durationMs("PT12H")).toBe(DAY / 2);
    expect(durationMs("P1DT6H")).toBe(1.25 * DAY);
    expect(durationMs("PT")).toBeNull();
    expect(durationMs("90 days")).toBeNull();
  });
});

describe("freshness states", () => {
  const now = new Date("2026-02-01T00:00:00Z");
  const base = { id: "x", type: "semantic", created: "2026-01-01T00:00:00Z" };

  it("is timeless without a decay model", () => {
    expect(freshness(base, now)).toMatchObject({ state: "timeless", model: "none" });
  });

  it("decays exponentially by half-life from the latest reinforcement", () => {
    const f = freshness({ ...base, temporal: { recordedAt: "2026-01-04T00:00:00Z", decay: { model: "exponential", halfLife: "P7D" } } }, now);
    expect(f.since).toEqual({ field: "temporal.recordedAt", at: "2026-01-04T00:00:00Z" });
    expect(f.strength).toBeCloseTo(0.5 ** 4, 10); // 28 days = 4 half-lives
    expect(f.state).toBe("stale");
    const reinforced = freshness({ ...base, temporal: { recordedAt: "2026-01-04T00:00:00Z", decay: { model: "exponential", halfLife: "P7D", lastReinforced: "2026-01-30T00:00:00Z" } } }, now);
    expect(reinforced.since!.field).toBe("temporal.decay.lastReinforced");
    expect(reinforced.strength).toBeCloseTo(0.5 ** (2 / 7), 10); // 2 days: 0.82
    expect(reinforced.state).toBe("fresh");
  });

  it("bands by thresholds", () => {
    const at = (days: number) => freshness({ ...base, created: new Date(now.getTime() - days * DAY).toISOString(), temporal: { decay: { model: "exponential", halfLife: "P10D" } } }, now);
    expect(at(1).state).toBe("fresh"); // 0.93
    expect(at(5).state).toBe("ageing"); // 0.71
    expect(at(15).state).toBe("stale"); // 0.35
  });

  it("expires at validUntil or recordedAt + ttl, whichever is first", () => {
    const byUntil = freshness({ ...base, temporal: { validUntil: "2026-01-20T00:00:00Z", decay: { model: "exponential", halfLife: "P365D" } } }, now);
    expect(byUntil).toMatchObject({ state: "expired", expiresAt: "2026-01-20T00:00:00Z", strength: 0 });
    expect(byUntil.reason).toMatch(/validUntil passed 12 days ago/);
    const byTtl = freshness({ ...base, temporal: { recordedAt: "2026-01-01T00:00:00Z", ttl: "P14D" } }, now);
    expect(byTtl).toMatchObject({ state: "expired", expiresAt: "2026-01-15T00:00:00Z" });
    expect(byTtl.reason).toMatch(/ttl elapsed/);
  });

  it("is not yet valid before validFrom", () => {
    expect(freshness({ ...base, temporal: { validFrom: "2026-03-01T00:00:00Z" } }, now).state).toBe("not-yet-valid");
  });

  it("uses ttl for linear and step, and reports missing parameters", () => {
    const lin = freshness({ ...base, temporal: { ttl: "P62D", decay: { model: "linear" } } }, now);
    expect(lin.strength).toBeCloseTo(0.5, 10);
    const noTtl = freshness({ ...base, temporal: { decay: { model: "step" } } }, now);
    expect(noTtl.state).toBe("timeless");
    expect(noTtl.problems).toEqual(["step decay needs temporal.ttl"]);
  });

  it("reports inconsistent temporal data", () => {
    const f = freshness({ ...base, temporal: { validFrom: "2026-01-10T00:00:00Z", validUntil: "2026-01-05T00:00:00Z", ttl: "90 days", decay: { model: "exponential", halfLife: "P7D", strength: 0.4, currentStrength: 0.6 } } }, now);
    expect(f.problems).toEqual(expect.arrayContaining([
      "ttl '90 days' is not an ISO 8601 duration",
      "decay.strength and decay.currentStrength (aliases) disagree",
      "validUntil is before validFrom",
    ]));
    expect(f.storedStrength).toBe(0.6);
  });

  it("orders by urgency: expired first, then weakest", () => {
    const expired = freshness({ ...base, temporal: { validUntil: "2026-01-20T00:00:00Z" } }, now);
    const weak = freshness({ ...base, temporal: { decay: { model: "exponential", halfLife: "P7D" } } }, now);
    const timeless = freshness(base, now);
    const sorted = [timeless, weak, expired].sort((a, b) => urgency(a, now) - urgency(b, now));
    expect(sorted.map((f) => f.state)).toEqual(["expired", "stale", "timeless"]);
  });
});

describe("freshness diagnostics and fixes", async () => {
  const { temporalDiagnostics } = await import("../src/engine/temporal");
  const { updateFrontmatter } = await import("../src/engine/writer");
  const { parseMarkdown } = await import("../src/engine/convert");
  const { applyTextFix } = await import("../src/engine/fixes");
  const now = new Date("2026-02-01T00:00:00Z");
  const text = (temporal: Record<string, unknown>) =>
    updateFrontmatter("---\nid: x\ntype: semantic\ncreated: 2026-01-01T00:00:00Z\n---\n\nBody.\n", { temporal });
  const fm = (t: string) => parseMarkdown(t).frontmatter;
  const diag = (t: string, code: string) => temporalDiagnostics(fm(t), now).find((x) => x.code === code)!;
  const apply = (t: string, code: string, label: RegExp) => applyTextFix(t, diag(t, code).fixes.find((f) => label.test(f.label))!);
  const codes = (t: string) => temporalDiagnostics(fm(t), now).map((x) => x.code);

  it("expired by ttl: renew, drop the ttl, or supersede", () => {
    const t = text({ recordedAt: "2026-01-01T00:00:00Z", ttl: "P14D" });
    expect(diag(t, "freshness-expired").fixes.map((f) => f.label)).toEqual(["Renew: set recordedAt to now", "Remove ttl (no expiry)", "Supersede with a new concept"]);
    expect(codes(apply(t, "freshness-expired", /^Renew/))).not.toContain("freshness-expired");
    expect(codes(apply(t, "freshness-expired", /^Remove ttl/))).not.toContain("freshness-expired");
    expect(diag(t, "freshness-expired").fixes[2]!.transform).toBe("supersede");
  });

  it("expired by validUntil: extend by its own span, drop the end, or supersede", () => {
    const t = text({ validFrom: "2025-01-01T00:00:00Z", validUntil: "2025-07-01T00:00:00Z" });
    const labels = diag(t, "freshness-expired").fixes.map((f) => f.label);
    expect(labels).toEqual(["Extend validUntil to 2026-08-01", "Remove validUntil (no end)", "Supersede with a new concept"]);
    const extended = apply(t, "freshness-expired", /^Extend/);
    expect((fm(extended).temporal as Record<string, string>).validUntil).toBe("2026-08-01T00:00:00Z");
    expect(codes(extended)).not.toContain("freshness-expired");
    expect(codes(apply(t, "freshness-expired", /^Remove validUntil/))).not.toContain("freshness-expired");
    // No span to reuse: a year.
    expect(diag(text({ validUntil: "2026-01-20T00:00:00Z" }), "freshness-expired").fixes[0]!.label).toBe("Extend validUntil to 2027-02-01");
  });

  it("stale and ageing: mark reviewed (and supersede when stale)", () => {
    const stale = text({ recordedAt: "2026-01-01T00:00:00Z", decay: { model: "exponential", halfLife: "P7D" } });
    expect(diag(stale, "freshness-stale").fixes.map((f) => f.label)).toEqual(["Mark reviewed now", "Supersede with a new concept"]);
    const reviewed = apply(stale, "freshness-stale", /^Mark reviewed/);
    expect((fm(reviewed).temporal as { decay: { lastReinforced: string } }).decay.lastReinforced).toBe("2026-02-01T00:00:00Z");
    expect(temporalDiagnostics(fm(reviewed), now)).toEqual([]);
    const ageing = text({ recordedAt: "2026-01-27T00:00:00Z", decay: { model: "exponential", halfLife: "P10D" } });
    expect(codes(ageing)).toEqual(["freshness-ageing"]);
    expect(codes(apply(ageing, "freshness-ageing", /^Mark reviewed/))).toEqual([]);
  });

  it("not yet valid: make it valid now", () => {
    const t = text({ validFrom: "2026-03-01T00:00:00Z" });
    expect(codes(apply(t, "freshness-future", /^Make it valid now/))).toEqual([]);
  });

  it("repairs invalid temporal data where the fix is clear", () => {
    const t = text({ validFrom: "2026-01-10T00:00:00Z", validUntil: "2026-01-05T00:00:00Z", ttl: "90 days", decay: { model: "exponential" } });
    const fixes = temporalDiagnostics(fm(t), now).filter((d) => d.code === "temporal-invalid").flatMap((d) => d.fixes.map((f) => f.label));
    expect(fixes).toEqual(expect.arrayContaining(["Use P90D", "Remove ttl", "Set halfLife to P30D", "Swap validFrom and validUntil"]));
    let out = t;
    for (const label of [/^Use P90D/, /^Set halfLife/, /^Swap/]) {
      const d = temporalDiagnostics(fm(out), now).find((x) => x.code === "temporal-invalid" && x.fixes.some((f) => label.test(f.label)))!;
      out = applyTextFix(out, d.fixes.find((f) => label.test(f.label))!);
    }
    expect(codes(out)).not.toContain("temporal-invalid");
  });

  it("offers to record the computed strength when the stored one is far off", () => {
    const t = text({ recordedAt: "2026-01-01T00:00:00Z", decay: { model: "exponential", halfLife: "P7D", strength: 0.9 } });
    expect(diag(t, "freshness-recorded").fixes[0]!.label).toMatch(/^Record 0\.0[0-9]$/);
  });
});

describe("superseding concept", async () => {
  const { conceptPath, slugify, supersedingConceptText } = await import("../src/engine/concept");
  const { parseMarkdown } = await import("../src/engine/convert");
  const { mirrorDrift } = await import("../src/engine/relationships");
  it("is a new concept of the same kind that supersedes the old one", () => {
    const now = new Date("2026-10-08T12:00:00Z");
    expect(slugify("Rate-limit policy 2027 — Ünicode")).toBe("rate-limit-policy-2027-unicode");
    const next = conceptPath("temporal", "Rate limit policy 2027", (p: string) => p === "temporal/rate-limit-policy-2027.md");
    expect(next).toBe("temporal/rate-limit-policy-2027-2.md");
    const text = supersedingConceptText({ path: "temporal/expired-until.md", frontmatter: { id: "a", type: "semantic", namespace: "_semantic", title: "Expired policy" } }, { path: next, id: "11111111-2222-4333-8444-555555555555", now, title: "Rate limit policy 2027" });
    const { frontmatter, body } = parseMarkdown(text);
    expect(frontmatter).toMatchObject({ type: "semantic", namespace: "_semantic", title: "Rate limit policy 2027", relationships: [{ type: "supersedes", target: "expired-until.md" }] });
    expect((frontmatter.temporal as Record<string, string>).validFrom).toBe("2026-10-08T12:00:00Z");
    expect(body).toContain("- supersedes [Expired policy](expired-until.md)");
    expect(mirrorDrift(frontmatter, body)).toBeNull();
  });
});

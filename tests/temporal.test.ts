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
  const now = new Date("2026-02-01T00:00:00Z");
  const text = (temporal: Record<string, unknown>) =>
    updateFrontmatter("---\nid: x\ntype: semantic\ncreated: 2026-01-01T00:00:00Z\n---\n\nBody.\n", { temporal });
  const fm = (t: string) => parseMarkdown(t).frontmatter;

  it("renewing an expired ttl makes the concept current again", () => {
    const t = text({ recordedAt: "2026-01-01T00:00:00Z", ttl: "P14D" });
    const d = temporalDiagnostics(fm(t), now).find((x) => x.code === "freshness-expired")!;
    const renewed = updateFrontmatter(t, d.fixes[0]!.updates!);
    expect(temporalDiagnostics(fm(renewed), now).map((x) => x.code)).not.toContain("freshness-expired");
  });

  it("marking a stale concept reviewed resets its decay", () => {
    const t = text({ recordedAt: "2026-01-01T00:00:00Z", decay: { model: "exponential", halfLife: "P7D" } });
    const d = temporalDiagnostics(fm(t), now).find((x) => x.code === "freshness-stale")!;
    const reviewed = updateFrontmatter(t, d.fixes[0]!.updates!);
    expect((fm(reviewed).temporal as { decay: { lastReinforced: string } }).decay.lastReinforced).toBe("2026-02-01T00:00:00Z");
    expect(temporalDiagnostics(fm(reviewed), now)).toEqual([]);
  });

  it("offers to record the computed strength when the stored one is far off", () => {
    const t = text({ recordedAt: "2026-01-01T00:00:00Z", decay: { model: "exponential", halfLife: "P7D", strength: 0.9 } });
    const d = temporalDiagnostics(fm(t), now).find((x) => x.code === "freshness-recorded")!;
    expect(d.fixes[0]!.label).toMatch(/^Record 0\.0[0-9]$/);
  });
});

// What an MCP client may change in the vault (plan, Phase 2), on the vault
// side: every write goes through here, and through MifManager's guarded
// write. The rules live in one place:
//   - never while the note is open with unsaved edits, or is the active editor;
//   - checked against the MIF schema before anything is saved;
//   - a note's own prose is never edited: a concept is created whole, and an
//     existing one changes only in its frontmatter and the mirrored
//     Relationships and Citations sections the plugin maintains;
//   - an agent-created concept is marked agent-written and unverified, with
//     the client's name (spec §12: sourceType agent_inferred, trustLevel
//     uncertain, agent, agentVersion);
//   - every write is logged and raises a notice.

import { Notice, TFile, type App } from "obsidian";
import type { MifCli } from "./cliBridge";
import {
  addRelationship as addRelationshipText, analyze, applyEdit, entityReference, entitySlug, isoSeconds, linkTarget, newConceptText, relativeTarget, removeRelationship as removeRelationshipText,
  slugify, syncCitations, syncMirror, titledConceptPath, titleForTarget, updateFrontmatter, updateRelationship as updateRelationshipText, type BaseType, type Edge,
} from "./engine";
import type { MifManager } from "./manager";
import type { Author, ConceptEdit, ConceptRef, EntityTypeView, IngestView, NewConceptInput, Refused, RelationshipWrite, Repointed, Unavailable } from "./mcp/host";
import type { MifSettings } from "./settings";

const TYPES = ["semantic", "episodic", "procedural"];
export const AUDIT_LOG = "mcp-audit.log";
/** provenance.sourceRef of anything this server wrote or edited. */
export const REVIEW_SOURCE = "mcp:mif-vault";

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
/** The sections the plugin writes from the frontmatter; an edit never supplies them. */
const MIRRORED = new Set(["relationships", "citations"]);

/** A note as its frontmatter block and what follows it. */
function parts(text: string): { head: string; body: string } {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return m ? { head: m[0].endsWith("\n") ? m[0] : `${m[0]}\n`, body: text.slice(m[0].length) } : { head: "", body: text };
}

/** A body without its mirrored Relationships and Citations sections: the concept's own prose. */
export function proseOf(body: string): string {
  const out: string[] = [];
  let skip = false;
  for (const line of body.split("\n")) {
    const m = HEADING.exec(line);
    if (m && m[1]!.length <= 2) skip = m[1]!.length === 2 && MIRRORED.has(m[2]!.toLowerCase());
    if (!skip) out.push(line);
  }
  return out.join("\n").trim();
}

/** `prose` with the section under `heading` replaced by `text`; a heading it lacks is added as a second-level section. */
export function replaceSection(prose: string, heading: string, text: string): string {
  const want = heading.trim().replace(/^#+\s*/, "").toLowerCase();
  const lines = prose.split("\n");
  const at = lines.findIndex((l) => HEADING.exec(l)?.[2]!.toLowerCase() === want);
  if (at < 0) return `${prose}\n\n## ${heading.trim().replace(/^#+\s*/, "")}\n\n${text.trim()}`.trim();
  const level = HEADING.exec(lines[at]!)![1]!.length;
  let end = at + 1;
  while (end < lines.length) {
    const next = HEADING.exec(lines[end]!);
    if (next && next[1]!.length <= level) break;
    end++;
  }
  return [...lines.slice(0, at + 1), "", text.trim(), ...(end < lines.length ? ["", ...lines.slice(end)] : [])].join("\n").trim();
}

/** The trust levels a reviewer can give an agent-written concept (spec §12), strongest first. */
export const REVIEW_LEVELS = ["verified", "user_stated", "high_confidence", "moderate_confidence", "low_confidence"] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];
export const DEFAULT_REVIEW_LEVEL: ReviewLevel = "user_stated";

const errorsOf = (text: string) => analyze(text).diagnostics.filter((d) => d.severity === "error");
const refuse = (refused: string): Refused => ({ refused });

export class VaultWrites {
  /** When each admitted write happened, for the limit. */
  private stamps: number[] = [];

  constructor(
    private readonly app: App,
    private readonly manager: MifManager,
    private readonly cli: MifCli,
    private readonly settings: () => MifSettings,
    private readonly ref: (path: string) => ConceptRef | undefined,
    private readonly pluginDir: string,
    private readonly entityTypes: () => EntityTypeView[] = () => [],
  ) {}

  writes() {
    const s = this.settings();
    return { allowed: s.mcpAllowWrites, limit: s.mcpWriteLimit, window_minutes: s.mcpWriteWindowMinutes };
  }

  admit(now = Date.now()): Refused | undefined {
    const { limit, window_minutes } = this.writes();
    const since = now - window_minutes * 60_000;
    this.stamps = this.stamps.filter((t) => t > since);
    if (this.stamps.length >= limit) {
      const wait = Math.max(1, Math.ceil((this.stamps[0]! + window_minutes * 60_000 - now) / 60_000));
      return refuse(`This vault allows ${limit} writes in ${window_minutes} minutes and that many have been made. Try again in about ${wait} minute(s), or ask the user to raise the limit in the plugin's settings.`);
    }
    this.stamps.push(now);
    return undefined;
  }

  private audit(who: string, action: string, target: string, outcome: string): void {
    const line = `${new Date().toISOString()}\t${who}\t${action}\t${target}\t${outcome}\n`;
    const adapter = this.app.vault.adapter as { append?: (p: string, d: string) => Promise<void> };
    void adapter.append?.(`${this.pluginDir}/${AUDIT_LOG}`, line)?.catch(() => undefined);
  }

  private record(author: Author, action: string, target: string, outcome: string, notice?: string): void {
    this.audit(`${author.agent}${author.agent_version ? ` ${author.agent_version}` : ""}`, action, target, outcome);
    this.manager.debug("mcp-write", { agent: author.agent, action, target, outcome });
    if (notice) new Notice(`MIF: ${author.agent} ${notice}`);
  }

  private file(path: string): TFile | undefined {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile && this.manager.get(path)?.isConcept ? f : undefined;
  }

  /** The target as a relationship in `from` writes it: a bundle path inside the bundle, the concept's urn across bundles. */
  private target(from: string, to: string): string | Refused {
    const a = this.manager.rootFor(from);
    const b = this.manager.rootFor(to);
    if (a === null || b === null) return refuse(`${to} is not a MIF concept in a bundle.`);
    if (a === b) return `/${linkTarget(this.manager.toBundlePath(b, to))}`;
    const id = this.ref(to)?.id;
    return id ?? refuse(`${to} is in another bundle and has no valid id, so a relationship cannot name it.`);
  }

  /**
   * Change one existing note's text, under every rule: not while it is being
   * edited, not if the change would add a schema error, and through the
   * manager's guarded write, which reads the result back.
   */
  private async change(path: string, author: Author, action: string, notice: string, edit: (text: string) => string | Refused): Promise<{ concept: ConceptRef } | Refused> {
    const file = this.file(path);
    if (!file) return refuse(`No concept at ${path}.`);
    if (await this.manager.isBeingEdited(file)) {
      this.record(author, action, path, "refused: being edited");
      return refuse(`${path} is open in Obsidian with unsaved edits, or is the note being edited now. Nothing was changed; try again shortly.`);
    }
    const before = await this.app.vault.read(file);
    let next: string | Refused;
    try {
      next = edit(before);
    } catch (err) {
      return refuse(`The change could not be made to ${path}: ${(err as Error).message}`);
    }
    if (typeof next !== "string") return next;
    if (next === before) return refuse(`${path} already has that; nothing was changed.`);
    // The note changed, so its modified date does: the same rule as for an edit made in Obsidian.
    try {
      next = updateFrontmatter(next, { modified: isoSeconds(new Date()) });
    } catch (err) {
      return refuse(`The change could not be made to ${path}: ${(err as Error).message}`);
    }
    const added = errorsOf(next).filter((d) => !errorsOf(before).some((e) => e.code === d.code && e.message === d.message));
    if (added.length) {
      this.record(author, action, path, "refused: invalid");
      return refuse(`The change would make ${path} invalid: ${added.map((d) => d.message).join("; ")}. Nothing was changed.`);
    }
    const text = next;
    const saved = await this.manager.write(file, () => text, { background: true });
    if (!saved) {
      this.record(author, action, path, "refused: changed while saving");
      return refuse(`${path} changed while it was being saved. Nothing was changed; read it again and retry.`);
    }
    await this.manager.analyzeFile(file, { quiet: true });
    this.manager.rebuildIndexes();
    this.record(author, action, path, "done", notice);
    return { concept: this.ref(path)! };
  }

  private titleFor(path: string): (target: string) => string | undefined {
    const ctx = this.manager.indexFor(path);
    return ctx ? titleForTarget(ctx.index, ctx.bundlePath) : () => undefined;
  }

  /** The position, in the note's relationships, of the one of `type` that resolves to `target`. */
  private indexOf(path: string, match: { type: string; target: string }): number | Refused {
    const ctx = this.manager.indexFor(path);
    const wanted = ctx ? this.manager.toBundlePath(ctx.info.root, match.target) : undefined;
    const id = this.ref(match.target)?.id?.toLowerCase();
    const edge = (ctx?.index.outgoing.get(ctx.bundlePath) ?? []).find((e) => e.type === match.type && (e.resolved === wanted || (!!id && e.target.toLowerCase() === id)));
    return edge ? edge.index : refuse(`${path} declares no ${match.type} relationship to ${match.target}. List its relationships to see what it declares.`);
  }

  /**
   * Every relationship, in any bundle, that names the concept at `path`, by the
   * note that declares it. A "supersedes" relationship is history and is left out.
   */
  private pointing(path: string): Map<string, Edge[]> {
    const out = new Map<string, Edge[]>();
    const ctx = this.manager.indexFor(path);
    if (!ctx) return out;
    const add = (root: string, e: Edge) => {
      if (e.type === "supersedes") return;
      const from = this.manager.toVaultPath(root, e.from);
      out.set(from, [...(out.get(from) ?? []), e]);
    };
    for (const e of ctx.index.incoming.get(ctx.bundlePath) ?? []) add(ctx.info.root, e);
    // From another bundle a concept is named by its id, which that bundle's index cannot resolve.
    const id = this.ref(path)?.id?.toLowerCase();
    if (id) {
      for (const root of this.manager.bundleRoots()) {
        if (root === ctx.info.root) continue;
        for (const edges of this.manager.indexOfRoot(root)?.outgoing.values() ?? []) {
          for (const e of edges) if (e.resolved === undefined && e.target.toLowerCase() === id) add(root, e);
        }
      }
    }
    return out;
  }

  /**
   * Point the relationships in `edges` at the concept at `to` (plan M68): each
   * declaring note is changed once, under every rule a change obeys. A note that
   * already declares the same type to `to` loses the old relationship instead
   * of gaining a second. A note that cannot be changed now is reported, not forced.
   */
  private async retarget(edges: Map<string, Edge[]>, to: string, author: Author, skip: string[]): Promise<Repointed> {
    const repointed: ConceptRef[] = [];
    const left: string[] = [];
    const name = this.ref(to)?.title ?? to;
    for (const [from, list] of edges) {
      if (from === to || skip.includes(from)) continue;
      const target = this.target(from, to);
      if (typeof target !== "string") {
        left.push(`${from}: ${target.refused}`);
        continue;
      }
      const already = new Set(list.filter((e) => typeof this.indexOf(from, { type: e.type, target: to }) === "number").map((e) => e.type));
      const r = await this.change(from, author, "repoint-relationship", "", (text) => {
        let next = text;
        const titleFor = (t: string) => (t === target ? name : this.titleFor(from)(t));
        // From the last relationship back, so a removal does not move one still to be changed.
        for (const e of [...list].sort((a, b) => b.index - a.index)) {
          next = already.has(e.type) ? removeRelationshipText(next, e.index, titleFor) : updateRelationshipText(next, e.index, { type: e.type, target, ...(e.strength === undefined ? {} : { strength: e.strength }) }, titleFor);
        }
        return next;
      });
      if ("refused" in r) left.push(`${from}: ${r.refused}`);
      else repointed.push(r.concept);
    }
    if (repointed.length) new Notice(`MIF: ${author.agent} pointed the relationships of ${repointed.length} concept(s) at ${name}`);
    return { repointed, left };
  }

  async addRelationship(path: string, rel: RelationshipWrite, author: Author) {
    const target = this.target(path, rel.target);
    if (typeof target !== "string") return target;
    if (typeof this.indexOf(path, rel) === "number") return refuse(`${path} already declares a ${rel.type} relationship to ${rel.target}; nothing was changed.`);
    const name = this.ref(rel.target)?.title ?? rel.target;
    return this.change(path, author, "add-relationship", `added a ${rel.type} relationship from ${this.ref(path)?.title ?? path} to ${name}`, (text) =>
      addRelationshipText(text, { type: rel.type, target, ...(rel.strength === undefined ? {} : { strength: rel.strength }) }, this.titleFor(path)),
    );
  }

  async updateRelationship(path: string, match: { type: string; target: string }, next: { type?: string; strength?: number }, author: Author) {
    const index = this.indexOf(path, match);
    if (typeof index !== "number") return index;
    const target = this.target(path, match.target);
    if (typeof target !== "string") return target;
    const current = (this.manager.indexFor(path)?.index.outgoing.get(this.manager.indexFor(path)!.bundlePath) ?? []).find((e) => e.index === index);
    const strength = next.strength ?? current?.strength;
    return this.change(path, author, "update-relationship", `changed the ${match.type} relationship from ${this.ref(path)?.title ?? path} to ${this.ref(match.target)?.title ?? match.target}`, (text) =>
      updateRelationshipText(text, index, { type: next.type ?? match.type, target: current?.target ?? target, ...(strength === undefined ? {} : { strength }) }, this.titleFor(path)),
    );
  }

  async removeRelationship(path: string, match: { type: string; target: string }, author: Author) {
    const index = this.indexOf(path, match);
    if (typeof index !== "number") return index;
    return this.change(path, author, "remove-relationship", `removed the ${match.type} relationship from ${this.ref(path)?.title ?? path} to ${this.ref(match.target)?.title ?? match.target}`, (text) =>
      removeRelationshipText(text, index, this.titleFor(path)),
    );
  }

  async addCitation(path: string, citation: Record<string, unknown>, author: Author) {
    const fm = this.manager.get(path)?.frontmatter ?? {};
    const list = Array.isArray(fm.citations) ? [...(fm.citations as unknown[])] : [];
    const entry: Record<string, unknown> = { "@type": "Citation", ...citation };
    if (list.some((c) => !!c && typeof c === "object" && (c as Record<string, unknown>).title === entry.title && (c as Record<string, unknown>).url === entry.url)) {
      return refuse(`${path} already cites "${String(entry.title)}"; nothing was changed.`);
    }
    return this.change(path, author, "add-citation", `added a citation to ${this.ref(path)?.title ?? path}`, (text) => syncCitations(updateFrontmatter(text, { citations: [...list, entry] }), { create: true }));
  }

  async addEntityReference(path: string, entity: { urn: string; name?: string; role?: string }, author: Author) {
    const fm = this.manager.get(path)?.frontmatter ?? {};
    const list = Array.isArray(fm.entities) ? [...(fm.entities as unknown[])] : [];
    if (list.some((r) => (r as { entity?: { "@id"?: string } })?.entity?.["@id"] === entity.urn)) return refuse(`${path} already refers to ${entity.urn}; nothing was changed.`);
    return this.change(path, author, "add-entity-reference", `added a reference to ${entity.name ?? entity.urn} on ${this.ref(path)?.title ?? path}`, (text) => updateFrontmatter(text, { entities: [...list, entityReference(entity)] }));
  }

  async createEntity(bundle: string, entity: { type: string; name: string }, author: Author): Promise<{ urn: string; created: boolean } | Refused> {
    if (!this.manager.bundleRoots().includes(bundle)) return refuse(`No bundle "${bundle}".`);
    const slug = slugify(entity.name);
    if (!entitySlug(entity.type) || !slug) return refuse("An entity needs a type and a name with at least one letter or digit.");
    // Only a type this bundle has: a core type, or one its loaded ontologies define.
    const known = this.entityTypes().filter((t) => t.bundles.includes(bundle));
    const def = known.find((t) => t.slug === entitySlug(entity.type));
    if (!def) {
      this.record(author, "create-entity", `${entity.type}:${entity.name}`, "refused: unknown type");
      return refuse(`"${entity.type}" is not an entity type of this bundle. Its entity types: ${known.map((t) => t.name).join(", ")}.`);
    }
    const type = def.slug;
    const urn = `urn:mif:entity:${type}:${slug}`;
    if (this.manager.entityIndex(bundle).get(urn)?.record) return { urn, created: false };
    const typeName = def.source === "core" ? def.name : undefined;
    const ok = await this.manager.createEntity(bundle, urn, entity.name, typeName);
    this.record(author, "create-entity", urn, ok ? "done" : "refused", ok ? `created the entity ${entity.name}` : undefined);
    return ok ? { urn, created: true } : refuse(`The entity ${urn} could not be created.`);
  }

  async createConcept(input: NewConceptInput, author: Author): Promise<({ concept: ConceptRef; carried: number } & Repointed) | Refused> {
    const old = input.supersedes === undefined ? undefined : this.manager.get(input.supersedes);
    const oldFile = input.supersedes === undefined ? undefined : this.file(input.supersedes);
    if (input.supersedes !== undefined && (!old?.isConcept || !oldFile)) return refuse(`No concept at ${input.supersedes} to supersede.`);
    const oldFm = (old?.frontmatter ?? {}) as Record<string, unknown>;
    const roots = this.manager.bundleRoots();
    const root = old ? old.root : (input.bundle ?? (roots.length === 1 ? roots[0]! : undefined));
    if (root === undefined || !roots.includes(root)) return refuse(`Say which bundle the concept belongs to. Bundles in this vault: ${roots.map((r) => `"${r}"`).join(", ")}.`);
    const type = input.type ?? (typeof oldFm.type === "string" ? oldFm.type : undefined);
    if (!type || !TYPES.includes(type)) return refuse(`A concept's type is one of ${TYPES.join(", ")}.`);
    const title = input.title.trim();
    if (!title) return refuse("A concept needs a title.");
    if (oldFile && (await this.manager.isBeingEdited(oldFile))) {
      return refuse(`${input.supersedes} is open in Obsidian with unsaved edits, or is the note being edited now, so it cannot be superseded yet. Nothing was changed; try again shortly.`);
    }

    const now = new Date();
    const oldBundlePath = input.supersedes === undefined ? undefined : this.manager.toBundlePath(root, input.supersedes);
    const folder = (input.folder ?? (oldBundlePath === undefined ? type : oldBundlePath.includes("/") ? oldBundlePath.slice(0, oldBundlePath.lastIndexOf("/")) : "")).replace(/^\/+|\/+$/g, "");
    // The file keeps the title's capitals (plan M57); a name is taken if any file has it in any case.
    const taken = new Set(this.app.vault.getFiles().map((f) => f.path.toLowerCase()));
    const bundlePath = titledConceptPath(folder, title, (p) => taken.has(this.manager.toVaultPath(root, p).toLowerCase()));
    const path = this.manager.toVaultPath(root, bundlePath);
    const namespace = input.namespace ?? (typeof oldFm.namespace === "string" ? oldFm.namespace : undefined);
    const stamp = isoSeconds(now);

    let text: string;
    let carried = 0;
    try {
      text = newConceptText({ id: crypto.randomUUID(), type: type as BaseType, title, ...(namespace ? { namespace } : {}), created: now });
      // The body is the agent's whole text; a first-level heading of its own replaces the default one.
      const body = input.body.trim();
      if (body) text = /^#\s/.test(body) ? text.replace(/# [^\n]*\n$/, `${body}\n`) : `${text}\n${body}\n`;
      const temporal = { "@type": "TemporalMetadata", validFrom: stamp, recordedAt: stamp, ...(input.valid_until ? { validUntil: input.valid_until } : {}) };
      text = updateFrontmatter(text, {
        modified: stamp,
        ...(input.summary ? { summary: input.summary } : {}),
        ...(input.tags?.length ? { tags: input.tags } : {}),
        ...(input.entity_type ? { entity: { name: title, entity_type: input.entity_type } } : {}),
        temporal,
        // Agent-written and unverified until a person reviews it (spec §12).
        provenance: { "@type": "Provenance", sourceType: "agent_inferred", trustLevel: "uncertain", agent: author.agent, ...(author.agent_version ? { agentVersion: author.agent_version } : {}), sourceRef: REVIEW_SOURCE },
        ...(input.citations.length ? { citations: input.citations.map((c) => ({ "@type": "Citation", ...c })) } : {}),
        ...(input.entities.length ? { entities: input.entities.map((e) => entityReference(e)) } : {}),
      });
      const titles = new Map<string, string>();
      const titleFor = (target: string) => titles.get(target);
      if (oldBundlePath !== undefined) {
        const target = relativeTarget(bundlePath, oldBundlePath);
        titles.set(target, typeof oldFm.title === "string" ? oldFm.title : oldBundlePath);
        text = addRelationshipText(text, { type: "supersedes", target }, titleFor);
      }
      const declared = new Set<string>();
      for (const rel of input.relationships) {
        const target = this.target(path, rel.target);
        if (typeof target !== "string") return target;
        titles.set(target, this.ref(rel.target)?.title ?? rel.target);
        declared.add(`${rel.type}|${target}`);
        text = addRelationshipText(text, { type: rel.type, target, ...(rel.strength === undefined ? {} : { strength: rel.strength }) }, titleFor);
      }
      // A superseding concept takes over what the old one declared, so the graph around it still holds:
      // every relationship but the old one's own "supersedes", and not one the new concept already declares.
      const oldCtx = input.supersedes === undefined ? undefined : this.manager.indexFor(input.supersedes);
      for (const e of oldCtx?.index.outgoing.get(oldCtx.bundlePath) ?? []) {
        if (e.type === "supersedes") continue;
        let target: string | undefined;
        if (e.resolved !== undefined) {
          const to = this.manager.toVaultPath(oldCtx!.info.root, e.resolved);
          const t = this.target(path, to);
          if (typeof t === "string") {
            target = t;
            titles.set(t, this.ref(to)?.title ?? to);
          }
        } else if (/^(\/|urn:)/.test(e.target)) {
          target = e.target;
        }
        if (target === undefined || declared.has(`${e.type}|${target}`)) continue;
        declared.add(`${e.type}|${target}`);
        text = addRelationshipText(text, { type: e.type, target, ...(e.strength === undefined ? {} : { strength: e.strength }) }, titleFor);
        carried++;
      }
      if (input.citations.length) text = syncCitations(text, { create: true });
    } catch (err) {
      return refuse(`The concept could not be written: ${(err as Error).message}`);
    }
    const errors = errorsOf(text);
    if (errors.length) {
      this.record(author, "create-concept", path, "refused: invalid");
      return refuse(`The concept would not be valid MIF: ${errors.map((d) => d.message).join("; ")}. Nothing was created.`);
    }

    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    if (parent && this.app.vault.getAbstractFileByPath(parent) === null) await this.app.vault.createFolder(parent);
    const created = await this.app.vault.create(path, text);
    await this.manager.analyzeFile(created, { quiet: true });
    if (oldFile && oldBundlePath !== undefined) {
      const temporal = oldFm.temporal && typeof oldFm.temporal === "object" ? (oldFm.temporal as Record<string, unknown>) : {};
      const until = typeof temporal.validUntil === "string" ? Date.parse(temporal.validUntil) : NaN;
      if (Number.isNaN(until) || until > now.getTime()) await this.manager.write(oldFile, (t) => applyEdit(t, ["temporal", "validUntil"], stamp), { background: true });
      await this.manager.analyzeFile(oldFile, { quiet: true });
    }
    this.manager.rebuildIndexes();
    this.record(author, oldFile ? "supersede-concept" : "create-concept", path, "done", oldFile ? `created ${title}, which supersedes ${typeof oldFm.title === "string" ? oldFm.title : input.supersedes}` : `created ${title}`);
    // What other concepts declared to the old one now names the new one (plan M68).
    const moved = input.supersedes === undefined ? { repointed: [], left: [] } : await this.retarget(this.pointing(input.supersedes), path, author, [input.supersedes]);
    return { concept: this.ref(path)!, carried, ...moved };
  }

  /** A concept's provenance once an agent has changed its text: back to "uncertain", with the client on record. Its sourceType is kept. */
  private reviewMark(path: string, author: Author): Record<string, unknown> {
    const p = this.manager.get(path)?.frontmatter?.provenance;
    const { agentVersion: _was, ...kept } = (p && typeof p === "object" ? p : { "@type": "Provenance", sourceType: "agent_inferred" }) as Record<string, unknown>;
    return { ...kept, trustLevel: "uncertain", agent: author.agent, ...(author.agent_version ? { agentVersion: author.agent_version } : {}), sourceRef: REVIEW_SOURCE };
  }

  /** `text` with its prose replaced; the mirrored sections are rebuilt from the frontmatter afterwards, by the caller. */
  private withProse(text: string, next: (prose: string) => string): string {
    const { head, body } = parts(text);
    const old = proseOf(body);
    let prose = proseOf(next(old));
    // The note keeps its first-level heading unless the new text brings its own.
    const title = /^#\s[^\n]*/.exec(old)?.[0];
    if (title && !/^#\s/.test(prose)) prose = `${title}\n\n${prose}`;
    // Blank lines between the frontmatter and the text stay as the author had them.
    return `${head}${/^\n*/.exec(body)![0]}${prose}\n`;
  }

  private mirrors(text: string, path: string): string {
    const fm = analyze(text).frontmatter;
    const cited = Array.isArray(fm?.citations) && fm.citations.length > 0;
    return syncMirror(cited ? syncCitations(text, { create: true }) : text, this.titleFor(path));
  }

  async editConcept(path: string, edit: ConceptEdit, author: Author): Promise<{ concept: ConceptRef } | Refused> {
    if (edit.body === undefined && !edit.section && edit.summary === undefined && edit.tags === undefined) return refuse("Nothing to change: give body, section, summary or tags.");
    if (edit.section && MIRRORED.has(edit.section.heading.trim().replace(/^#+\s*/, "").toLowerCase())) {
      return refuse(`The ${edit.section.heading} section is written from the concept's frontmatter. Change relationships and citations with their own tools.`);
    }
    const stamp = isoSeconds(new Date());
    return this.change(path, author, "edit-concept", `edited ${this.ref(path)?.title ?? path}; it is back in review`, (text) => {
      let next = text;
      if (edit.body !== undefined) next = this.withProse(next, () => edit.body!);
      if (edit.section) next = this.withProse(next, (prose) => replaceSection(prose, edit.section!.heading, edit.section!.text));
      next = updateFrontmatter(next, { modified: stamp, ...(edit.summary === undefined ? {} : { summary: edit.summary }), ...(edit.tags === undefined ? {} : { tags: edit.tags }), provenance: this.reviewMark(path, author) });
      return edit.body !== undefined || edit.section ? this.mirrors(next, path) : next;
    });
  }

  async mergeConcepts(into: string, from: string[], body: string, author: Author): Promise<({ concept: ConceptRef; merged: ConceptRef[]; warnings: string[] } & Repointed) | Refused> {
    const sources = [...new Set(from)];
    if (!this.file(into)) return refuse(`No concept at ${into}.`);
    if (!sources.length || sources.includes(into)) return refuse("A merge needs at least one other concept to merge in.");
    if (!body.trim()) return refuse("A merge needs body: the merged text.");
    for (const s of sources) {
      const f = this.file(s);
      if (!f) return refuse(`No concept at ${s}.`);
      if (await this.manager.isBeingEdited(f)) return refuse(`${s} is open in Obsidian with unsaved edits, or is the note being edited now. Nothing was changed; try again shortly.`);
    }
    const warnings: string[] = [];
    const now = new Date();
    const stamp = isoSeconds(now);
    const fmOf = (p: string) => (this.manager.get(p)?.frontmatter ?? {}) as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) ? (v as Array<Record<string, unknown>>).filter((x) => !!x && typeof x === "object") : []);
    // What the merged-in concepts declare, to carry over: relationships by where they lead, citations, entity references.
    const carried: Array<{ type: string; target: string; strength?: number }> = [];
    for (const s of sources) {
      const ctx = this.manager.indexFor(s);
      for (const e of ctx?.index.outgoing.get(ctx.bundlePath) ?? []) {
        if (e.resolved !== undefined) {
          const to = this.manager.toVaultPath(ctx!.info.root, e.resolved);
          if (to === into || sources.includes(to)) continue;
          const target = this.target(into, to);
          if (typeof target === "string") carried.push({ type: e.type, target, ...(e.strength === undefined ? {} : { strength: e.strength }) });
          else warnings.push(`${s}: its ${e.type} relationship to ${to} was not carried over. ${target.refused}`);
        } else if (/^(\/|urn:)/.test(e.target)) {
          carried.push({ type: e.type, target: e.target, ...(e.strength === undefined ? {} : { strength: e.strength }) });
        } else {
          warnings.push(`${s}: its ${e.type} relationship to "${e.target}" was not carried over, because that target does not resolve.`);
        }
      }
    }
    const supersedes: string[] = [];
    for (const s of sources) {
      const target = this.target(into, s);
      if (typeof target !== "string") return target;
      supersedes.push(target);
    }
    const title = this.ref(into)?.title ?? into;
    const names = sources.map((s) => this.ref(s)?.title ?? s);
    const result = await this.change(into, author, "merge-concepts", `merged ${names.join(", ")} into ${title}; it is back in review`, (text) => {
      const fm = fmOf(into);
      const citations = list(fm.citations);
      const entities = list(fm.entities);
      const had = { citations: citations.length, entities: entities.length };
      for (const s of sources) {
        for (const c of list(fmOf(s).citations)) if (!citations.some((x) => x.title === c.title && x.url === c.url)) citations.push({ "@type": "Citation", ...c });
        for (const r of list(fmOf(s).entities)) {
          const id = (r.entity as { "@id"?: string } | undefined)?.["@id"];
          if (!entities.some((x) => (x.entity as { "@id"?: string } | undefined)?.["@id"] === id)) entities.push({ "@type": "EntityReference", ...r });
        }
      }
      let next = this.withProse(text, () => body);
      next = updateFrontmatter(next, {
        modified: stamp,
        provenance: this.reviewMark(into, author),
        ...(citations.length > had.citations ? { citations } : {}),
        ...(entities.length > had.entities ? { entities } : {}),
      });
      const ctx = this.manager.indexFor(into);
      const declared = new Set((ctx?.index.outgoing.get(ctx.bundlePath) ?? []).map((e) => `${e.type}|${e.target}`));
      const titles = new Map(sources.map((s, i) => [supersedes[i]!, this.ref(s)?.title ?? s]));
      const titleFor = (t: string) => titles.get(t) ?? this.titleFor(into)(t);
      for (const rel of [...carried, ...supersedes.map((target) => ({ type: "supersedes", target }))]) {
        if (declared.has(`${rel.type}|${rel.target}`)) continue;
        declared.add(`${rel.type}|${rel.target}`);
        next = addRelationshipText(next, rel, titleFor);
      }
      const cited = citations.length > 0 ? syncCitations(next, { create: true }) : next;
      return syncMirror(cited, titleFor);
    });
    if ("refused" in result) return result;
    // Each merged-in concept is kept, with its validity ended now.
    for (const s of sources) {
      const f = this.file(s)!;
      const temporal = fmOf(s).temporal && typeof fmOf(s).temporal === "object" ? (fmOf(s).temporal as Record<string, unknown>) : {};
      const until = typeof temporal.validUntil === "string" ? Date.parse(temporal.validUntil) : NaN;
      if (Number.isNaN(until) || until > now.getTime()) await this.manager.write(f, (t) => applyEdit(t, ["temporal", "validUntil"], stamp), { background: true });
      await this.manager.analyzeFile(f, { quiet: true });
      this.audit(`${author.agent}${author.agent_version ? ` ${author.agent_version}` : ""}`, "merged-into", s, into);
    }
    this.manager.rebuildIndexes();
    // What other concepts declared to a merged-in concept now names the one it was merged into (plan M68).
    const repointed = new Map<string, ConceptRef>();
    const left: string[] = [];
    for (const s of sources) {
      const moved = await this.retarget(this.pointing(s), into, author, sources);
      for (const c of moved.repointed) repointed.set(c.path, c);
      left.push(...moved.left);
    }
    return { concept: this.ref(into)!, merged: sources.flatMap((s) => this.ref(s) ?? []), warnings, repointed: [...repointed.values()], left };
  }

  /**
   * The user's review of an agent-written concept: give it a trust level.
   * Who wrote it (sourceType, agent) stays as recorded; only the trust changes.
   */
  async promote(path: string, level: ReviewLevel): Promise<boolean> {
    const file = this.file(path);
    if (!file || !REVIEW_LEVELS.includes(level)) return false;
    const ok = await this.manager.write(file, (t) => applyEdit(t, ["provenance", "trustLevel"], level));
    if (!ok) return false;
    await this.manager.analyzeFile(file, { quiet: true });
    this.manager.rebuildIndexes();
    this.audit("user", "review-promote", path, level);
    return true;
  }

  /**
   * The user's rejection of an agent-written concept: it goes to the trash
   * (Obsidian's or the system's, as the vault is set), so it can be restored.
   * A concept it superseded is valid again if this write is what ended it, and
   * what other concepts declare to the rejected one is pointed back at it.
   */
  async reject(path: string): Promise<boolean> {
    const file = this.file(path);
    const a = this.manager.get(path);
    if (!file || !a) return false;
    const from = (a.frontmatter?.temporal as { validFrom?: unknown } | undefined)?.validFrom;
    const ctx = this.manager.indexFor(path);
    const superseded = (ctx?.index.outgoing.get(ctx.bundlePath) ?? []).flatMap((e) => (e.type === "supersedes" && e.resolved !== undefined ? [this.manager.toVaultPath(ctx!.info.root, e.resolved)] : []));
    const pointing = superseded.length === 1 ? this.pointing(path) : new Map<string, Edge[]>();
    await this.app.fileManager.trashFile(file);
    for (const old of superseded) {
      const oldFile = this.file(old);
      const temporal = this.manager.get(old)?.frontmatter?.temporal as Record<string, unknown> | undefined;
      if (!oldFile || !temporal || typeof from !== "string" || temporal.validUntil !== from) continue;
      const { validUntil: _ended, ...open } = temporal;
      await this.manager.write(oldFile, (t) => updateFrontmatter(t, { temporal: open }));
      await this.manager.analyzeFile(oldFile, { quiet: true });
    }
    this.manager.rebuildIndexes();
    if (superseded.length === 1 && this.file(superseded[0]!)) await this.retarget(pointing, superseded[0]!, { agent: "user" }, [path]);
    this.audit("user", "review-reject", path, "moved to trash");
    return true;
  }

  async ingest(bundle: string, author: Author, progress?: (done: number, total: number) => void): Promise<IngestView | Unavailable> {
    const why = this.cli.unavailable() ?? (await this.cli.checkVersion());
    if (why) return { unavailable: `Ingest needs mif-cli: ${why}` };
    const r = await this.cli.ingestBundle(bundle, progress, { background: true });
    this.record(author, "ingest", bundle || "(vault root)", `stored ${r.stored}, unchanged ${r.unchanged}, failed ${r.failed.length}`, `ingested ${r.stored} concept(s) into the vector store`);
    return { bundle, stored: r.stored, unchanged: r.unchanged, failed: r.failed.map((f) => ({ path: f.path, reason: [f.problem.title, f.problem.detail].filter(Boolean).join(": ") })) };
  }
}

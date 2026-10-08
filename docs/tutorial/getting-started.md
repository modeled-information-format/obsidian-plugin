---
diataxis_type: tutorial
title: Getting started with MIF in Obsidian
description: Install the plugin, create your first MIF concept, link it to another, and bring it to Level 3.
---

# Getting started with MIF in Obsidian

In this tutorial you create two MIF concepts in a new vault, relate them, and
raise one to MIF Level 3. It takes about fifteen minutes. You need Obsidian
1.10 or later.

## 1. Install and enable the plugin

1. Copy `main.js`, `manifest.json`, and `styles.css` from a release into
   `<vault>/.obsidian/plugins/mif/`.
2. In **Settings → Community plugins**, enable **MIF**.

The status bar now shows `MIF –` for the open note: it is not a MIF concept
yet. By default the whole vault is one MIF bundle (**Settings → MIF → Bundle
roots**).

## 2. Create a concept

1. Open the command palette (**Cmd/Ctrl+P**) and run **MIF: New concept**.
2. Choose type **Semantic**, title it `Dark mode preference`, leave the
   namespace empty, and keep the folder `semantic`. Click **Create**.

The new note, `semantic/dark-mode-preference.md`, has frontmatter with a UUID `id`, `type: semantic`, and
`created`. The status bar shows `MIF L1`: the note is a valid Level 1
concept. Write a sentence in the body, for example *The user prefers dark
mode in every editor.*

## 3. Read the diagnostics

Click the status bar item. The **MIF diagnostics** panel lists what the note
needs for the next level:

> Level 2 needs: namespace, modified, temporal.

Each diagnostic has buttons. Click **Set namespace to _semantic**, **Set
modified to now**, and **Add temporal.recordedAt from created**. The status
bar changes to `MIF L2`.

## 4. Relate two concepts

1. Create a second concept, `Editor theme decision`, the same way.
2. With it open, run **MIF: Add relationship**.
3. Choose type `derived-from`, click **Choose…**, and pick *Dark mode
   preference*. Click **Save**.

The plugin writes the relationship to frontmatter and mirrors it in the body:

```markdown
## Relationships

- derived-from [Dark mode preference](/semantic/dark-mode-preference.md)
```

Open **MIF: Open related panel**: *Dark mode preference* is listed under
*Outgoing*. Open the other note: the same edge appears there under
*Incoming*, labelled with the inverse type `derives`.

## 5. Reach Level 3

Open **MIF: Open properties panel** on *Dark mode preference*:

1. Under **Temporal**, set **Valid From** with **Now**.
2. Under **Provenance**, choose **Source Type** `user_explicit` and **Trust
   Level** `user_stated`, and enter **Confidence** `0.95`.

The status bar shows `MIF L3`.

## 6. See it as JSON-LD

Run **MIF: Open JSON-LD panel**. It shows the note's derived JSON-LD
projection and *Round trip: lossless* — the markdown converts to JSON-LD and
back without losing anything. Markdown stays the source of truth.

## Next

- [Fix what the diagnostics report](../how-to/fix-problems.md)
- [Work with relationships](../how-to/relationships.md)
- [How the plugin reads MIF](../explanation/how-the-plugin-reads-mif.md)

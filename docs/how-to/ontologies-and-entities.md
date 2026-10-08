---
diataxis_type: how-to
title: Use ontologies, namespaces, and entities
description: Declare an ontology, get namespace and entity-type hints, and keep entity references resolvable.
---

# Use ontologies, namespaces, and entities

Ontology, namespace, and entity checks are advisory: they never change a
concept's level.

## Load ontologies

- Put ontology files in the bundle's `.mif/ontologies/`; they always work
  offline and take precedence.
- With **Download ontologies from mif-spec.dev** on (the default), an
  ontology a concept declares is downloaded with the ontologies it extends,
  checked against the catalog's sha256, and cached. **MIF: Download all
  ontologies from the spec catalog** fetches everything at once.

## Declare and check

Set `ontology.id` in a concept (Properties panel → **Ontology**). The **MIF
ontology** panel (**MIF: Open ontology panel**) then shows the `extends`
chain, the namespaces it declares, entity types, and suggestions from the
ontology's discovery rules. Diagnostics flag a namespace or entity type the
chain does not declare.

**Default ontology** (settings) supplies namespace hints for concepts that
declare none.

## Entities

- **Add a reference:** **MIF: Add entity reference** picks an entity of the
  bundle or creates one (`.mif/entities/<type>/<slug>.yaml`).
- **Missing entity file:** the `entity-unresolved` diagnostic has a **Create
  the entity file** fix; it also covers entity authors of citations.
- **See them all:** **MIF: Open entities panel** lists every entity and the
  notes that reference it.

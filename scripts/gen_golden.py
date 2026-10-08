#!/usr/bin/env python3
"""Generate golden files from the MIF reference converter (mif_convert.py).

The TypeScript engine is tested against these outputs, so the plugin's
behaviour is pinned to the reference implementation rather than to our
reading of the spec. Re-run after the MIF repo changes:

    MIF_REPO=../MIF npm run golden

For every bundle in BUNDLES and every concept file in it (the converter's own
iter_concepts, so reserved filenames are skipped exactly as upstream skips
them), writes under tests/golden/<bundle>/<relpath>/:

    parse.json       {"frontmatter": ..., "body": ...} or {"error": ...}
    jsonld.json      md_to_jsonld() with the bundle's namespaces
    normalized.md    normalize() -- canonical serialization
    roundtrip.json   {"lossless": bool, "error": str | null}
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIF_REPO = Path(os.environ.get("MIF_REPO", ROOT.parent / "MIF")).resolve()
sys.path.insert(0, str(MIF_REPO / "scripts"))

import mif_convert as mc  # noqa: E402
import migrate_0_1_to_1_0 as mig  # noqa: E402
import okf_validate as okf  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"
BUNDLES = {
    "test-vault": ROOT / "test-vault",
    "edge": FIXTURES / "edge",
    "rel": FIXTURES / "rel",
    "legacy": FIXTURES / "mif" / "legacy-0.1-bundle",
    **{f"reltypes-{p.name}": p for p in sorted((FIXTURES / "mif" / "relationship_types").iterdir()) if p.is_dir()},
}
KEBAB_CASES = [
    "DerivedFrom", "derived-from", "RelatesTo", "relates_to", "Relates To", "farm:BreedsWith",
    "farm:breeds-with", "MentionedIn", "SupersededBy", "ImplementedBy", "XMLParser", "a",
]
UUID5_SLUGS = ["decision-sample", "prior-sample-decision", "dark-mode-preference", "x", ""]
OUT = ROOT / "tests" / "golden"


def encode_nonfinite(obj):
    """JSON has no Infinity/NaN; tag them so the TS loader can revive them."""
    if isinstance(obj, float) and (obj != obj or obj in (float("inf"), float("-inf"))):
        return {"$float": repr(obj)}  # 'inf', '-inf', 'nan'
    if isinstance(obj, dict):
        return {k: encode_nonfinite(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [encode_nonfinite(v) for v in obj]
    return obj


def dump(path: Path, obj) -> None:
    text = json.dumps(encode_nonfinite(obj), indent=2, ensure_ascii=False, allow_nan=False)
    path.write_text(text + "\n")


# Plain scalars whose resolution differs across YAML 1.1/1.2 parsers. Each is
# loaded by PyYAML as `v: <text>` and run through stringify_datetimes().
SCALAR_CASES = [
    # booleans
    "yes", "Yes", "YES", "no", "NO", "on", "ON", "off", "Off", "true", "True",
    "FALSE", "y", "Y", "n", "N", "yEs", "tRue",
    # null
    "~", "null", "Null", "NULL", "nULL", "",
    # integers
    "0", "-0", "+7", "010", "08", "09", "0o17", "0b101", "0x1F", "0X1F", "1_000",
    "1:20", "-1:20:30", "01:20", "190:20:30",
    # floats
    "1.0", "1.", ".5", "-.5", "1e3", "1E3", "1.0e3", "1.0e+3", "1.0E-3", "6.8523015e+5",
    "685.230_15e+03", "190:20:30.15", ".inf", "-.Inf", "+.INF", ".nan", ".NaN", "inf",
    # timestamps
    "2026-01-15", "2026-1-15", "2026-01-15T10:30:00Z", "2026-01-15t10:30:00z",
    "2026-01-15 10:30:00", "2026-01-15  10:30:00", "2026-01-15T10:30:00.5Z",
    "2026-01-15T10:30:00.123456789Z", "2026-01-15T10:30:00.000Z", "2026-01-15T10:30:00.Z",
    "2026-01-15T10:30:00+05:30", "2026-01-15T10:30:00-08", "2026-01-15T10:30:00 -08:00",
    "2026-01-15T10:30:00+00:00", "2026-01-15T10:30:00-00:00", "2026-1-5T1:02:03Z",
    # strings that look close to something else
    "2026-01-15T10:30", "1.2.3", "0x", "+", "-", "v1", "1_", "._", "12:60",
]


def scalar_goldens() -> list[dict]:
    import yaml

    out = []
    for text in SCALAR_CASES:
        try:
            value = mc.stringify_datetimes(yaml.safe_load(f"v: {text}"))["v"]
            out.append({"text": text, "value": encode_nonfinite(value), "kind": type(value).__name__})
        except Exception as exc:  # noqa: BLE001 - recorded as golden
            out.append({"text": text, "error": type(exc).__name__})
    return out


def hermetic(bundle: Path) -> Path:
    """A temp copy of the bundle without gitignored files, so local
    artifacts (test-vault/_fixtures, _spike, .obsidian) never leak into goldens."""
    import tempfile

    tracked = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", str(bundle.relative_to(ROOT))],
        capture_output=True, text=True, check=True,
    ).stdout.split("\0")
    tmp = Path(tempfile.mkdtemp(prefix="mif-golden-")) / bundle.name
    for rel in filter(None, tracked):
        src = ROOT / rel
        dest = tmp / src.relative_to(bundle)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
    return tmp


def _load_script(path: Path, name: str):
    """Import a hyphen-named script as a module. Annotations are deferred
    (PEP 563) so scripts using `X | None` hints also load on Python 3.9;
    the upstream file is not modified."""
    import types

    mod = types.ModuleType(name)
    mod.__file__ = str(path)
    sys.modules[name] = mod
    code = compile("from __future__ import annotations\n" + path.read_text(), str(path), "exec")
    exec(code, mod.__dict__)
    return mod


def ontology_goldens() -> dict:
    """Ontology behaviour from the Python references:
    - ontologies repo scripts/validate-namespaces.py: namespace flattening and
      the corpus consistency check (type_hint conflicts with ancestors,
      dangling `replaces`);
    - MIF scripts/validate-ontologies.py: visible entity types along the
      extends closure and subtype_of checks."""
    import tempfile

    ont_repo = Path(os.environ.get("ONTOLOGIES_REPO", ROOT.parent / "ontologies")).resolve()
    ns = _load_script(ont_repo / "scripts" / "validate-namespaces.py", "ont_validate_namespaces")
    vo = _load_script(MIF_REPO / "scripts" / "validate-ontologies.py", "mif_validate_ontologies")
    corpus_dir = FIXTURES / "ontologies" / "corpus"
    tmp = Path(tempfile.mkdtemp(prefix="mif-ont-"))
    (tmp / "ontologies").symlink_to(corpus_dir)

    ns_corpus = ns.load_corpus(tmp)
    out = {
        "namespaces": {oid: info["namespaces"] for oid, info in ns_corpus.items()},
        "namespaceChecks": {k: v for k, v in ns.check_corpus(ns_corpus).items()},
        "visibleTypes": {},
        "subtypeChecks": {},
    }
    vo_corpus = vo.load_ontology_corpus([corpus_dir])
    for oid in sorted(vo_corpus):
        out["visibleTypes"][oid] = sorted(vo.visible_types(oid, vo_corpus))
    sub_dir = FIXTURES / "ontologies" / "subtype_of"
    sub_corpus = vo.load_ontology_corpus([sub_dir, corpus_dir])
    for f in sorted(sub_dir.glob("*.ontology.yaml")):
        data = vo.load_yaml(f)
        oid = data["ontology"]["id"]
        out["subtypeChecks"][f.name] = vo.check_subtype_of(data, vo.visible_types(oid, sub_corpus))
    for f in sorted(corpus_dir.glob("*.ontology.yaml")):
        data = vo.load_yaml(f)
        oid = data["ontology"]["id"]
        errs = vo.check_subtype_of(data, vo.visible_types(oid, vo_corpus))
        if errs:
            out["subtypeChecks"][f"corpus/{f.name}"] = errs
    return out


def main() -> int:
    rust = OUT / "ontology-chains.json"
    keep = rust.read_text() if rust.exists() else None
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)
    if keep is not None:
        rust.write_text(keep)  # produced by scripts/gen_rust_goldens.mjs
    for name in list(BUNDLES):
        BUNDLES[name] = hermetic(BUNDLES[name])
    count = 0
    for name, bundle in BUNDLES.items():
        namespaces = mc.bundle_namespaces(bundle)
        for md_path in mc.iter_concepts(bundle):
            # Read bytes so CRLF survives (read_text would translate it).
            text = md_path.read_bytes().decode("utf-8")
            rel = md_path.relative_to(bundle).as_posix()
            out = OUT / name / rel
            out.mkdir(parents=True, exist_ok=True)
            try:
                fm, body = mc.parse_markdown(text)
            except Exception as exc:  # noqa: BLE001 - recorded as golden
                dump(out / "parse.json", {"error": f"{type(exc).__name__}: {exc}"})
                count += 1
                continue
            dump(out / "parse.json", {"frontmatter": fm, "body": body})
            dump(out / "rels.json", {
                "frontmatter": okf._frontmatter_relationships(fm),
                "body": okf._relationships_section(body),
            })
            if md_path.name.endswith(".memory.md"):
                (out / "migrated.md").write_text(mig.migrate_concept(text))
            # Round-trip through JSON text, exactly like roundtrip_file().
            jsonld = json.loads(json.dumps(mc.md_to_jsonld(fm, body, namespaces or None)))
            dump(out / "jsonld.json", jsonld)
            (out / "normalized.md").write_text(mc.normalize(text))
            fm2, body2 = mc.jsonld_to_md(jsonld)
            lossless = mc.serialize_markdown(fm2, body2) == mc.serialize_markdown(fm, body)
            dump(out / "roundtrip.json", {"lossless": lossless})
            count += 1

    dump(OUT / "scalars.json", scalar_goldens())
    dump(OUT / "kebab.json", {k: okf._kebab(k) for k in KEBAB_CASES})
    dump(OUT / "ontologies.json", ontology_goldens())
    dump(OUT / "uuid5.json", {
        "namespace": str(mig.MIF_NAMESPACE),
        "slugs": {s: str(__import__("uuid").uuid5(mig.MIF_NAMESPACE, s)) for s in UUID5_SLUGS},
    })
    for name, bundle in BUNDLES.items():
        errors, warnings, _ = okf.validate_bundle(bundle)
        strip = lambda m: m.replace(str(bundle.resolve()) + "/", "").replace(str(bundle) + "/", "")  # noqa: E731
        dump(OUT / name / "okf.json", {"errors": [strip(e) for e in errors], "warnings": [strip(w) for w in warnings]})

    commit = subprocess.run(
        ["git", "-C", str(MIF_REPO), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    import yaml

    dump(OUT / "SOURCE.json", {
        "generator": "scripts/gen_golden.py",
        "mifCommit": commit,
        "pyyaml": yaml.__version__,
        "python": sys.version.split()[0],
        "concepts": count,
    })
    print(f"wrote goldens for {count} concept(s) from MIF {commit[:7]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

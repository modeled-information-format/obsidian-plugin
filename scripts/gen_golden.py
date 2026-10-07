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

BUNDLES = {
    "test-vault": ROOT / "test-vault",
    "edge": ROOT / "tests" / "fixtures" / "edge",
}
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


def main() -> int:
    if OUT.exists():
        shutil.rmtree(OUT)
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
            # Round-trip through JSON text, exactly like roundtrip_file().
            jsonld = json.loads(json.dumps(mc.md_to_jsonld(fm, body, namespaces or None)))
            dump(out / "jsonld.json", jsonld)
            (out / "normalized.md").write_text(mc.normalize(text))
            fm2, body2 = mc.jsonld_to_md(jsonld)
            lossless = mc.serialize_markdown(fm2, body2) == mc.serialize_markdown(fm, body)
            dump(out / "roundtrip.json", {"lossless": lossless})
            count += 1

    dump(OUT / "scalars.json", scalar_goldens())

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

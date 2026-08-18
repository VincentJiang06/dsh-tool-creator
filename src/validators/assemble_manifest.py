#!/usr/bin/env python3
"""assemble_manifest.py — MECHANICAL assembler for acceptance-manifest.json (D4, L4).

EVIDENCE ASSEMBLY NEVER PASSES THROUGH A MODEL. This script is the only writer
of the shipped acceptance manifest, and every field it writes is computed from
artifacts the pipeline already produced mechanically or gate-validated:

  evidence-ledger.jsonl            executor-written (disk-byte hashes, session ids,
                                   roleModel, pipeline id, manifest sha)
  artifacts/decision-record.json   battery synthesis output, gate-validated by
                                   validate_decision.py BEFORE this script runs
                                   (it is the battery gate's `then` command)
  artifacts/evidence-dossier.json  engineer output, gate-validated at stage 3
  artifacts/battery-lens-*.json    executor-written lens returns (P1/P2/P3 counts)
  <workspace>/<build-subdir>/      the artifact tree itself (file walk → sha256s
                                   + rootHash, byte-identical to tools/reverify.mjs)

Model roles only ever produce what they already produce; this script never asks
a model anything and never invents a value. Where a value cannot be derived it
is either DISCLOSED ("unknown" dshVersion, measured:false baselineDelta with a
reason) or the script REFUSES to write a manifest at all (exit 1, named reason).

Refusals (the fraud classes this assembler exists to block):
  1. Verdict fold mismatch: the decision-record's effective_verdict must equal
     the recomputed min(re_audit, battery_cap) — ANY disagreement (above OR
     below the fold) refuses, naming both values. A manifest may never certify
     a verdict the fold does not produce.
  2. measured=true without machine-parseable rates: a dossier baseline note that
     carries pass_rate=/baseline_rate= tokens must parse to floats in [0,1] for
     BOTH rates, else refusal — a half-parsed rate is a fabricated rate.
  3. Silent-limit suppression: every dossier layer with verdict not_run must be
     named in limits[]; a limits list that lost one refuses. (An empty limits[]
     for a dossier carrying not_run layers is exactly this class.)
  4. Evidence integrity: missing/unparseable ledger, mixed manifestSha256 or
     pipeline ids across ledger lines, no roleModel anywhere, symlinks/specials
     in the artifact tree, harness path absent (from the artifact tree for
     skill/plugin; from the creation-workspace build/ for a preset, whose harness
     is workspace-anchored and NOT shipped inside the preset — see below),
     breaches_found with zero counted lens findings — all refusals, all named.

Preset evidence model (targets/preset/BUILD.md §1): a preset's install unit is
build/preset/ (what lands in $DSH_HOME/.agent-presets/<id>/); the harness and the
validate-dossier/validate-structure kit live at the creation-workspace build/ level
and deliberately do NOT travel inside the shipped preset. So for kind=preset the
manifest hashes build/preset/, the harness membership check is REPLACED by a
"harness exists at build/" check, the reverify harness path is anchored to resolve
from the creation workspace (stepped up out of the shipped root), and a REQUIRED
limit discloses that the command phase is creation-workspace-anchored while the HASH
phase alone re-runs from the installed artifact.

Baseline-delta derivation (mechanical, no NLP): the first dossier layers[].notes
entry containing "baseline" (case-insensitive) is the record. If it carries
pass_rate=<f>/baseline_rate=<f> tokens → measured:true with those rates. If it
carries no rate tokens → measured:false with the note VERBATIM (the BUILD.md
carve-out "n/a — code artifact; …" travels unaltered). No note mentioning
baseline → measured:false with a disclosed "no record found" reason.

dshVersion: read from <dsh-root>/profiles/node_modules/@deepseek-ai/dsh/package.json
(default dsh-root ~/.dsh); unresolvable → "unknown" AND a limits[] disclosure.

Timing disclosure (always in limits[]): the assembler runs INSIDE the battery
gate, so evidenceLedgerSha256 pins the ledger before the battery stage's own
line lands — the final ledger gains exactly the line recording the gate that
produced this manifest.

Usage:
  assemble_manifest.py --workspace DIR [--build-subdir NAME] --out PATH
                       [--provider NAME] [--dsh-root DIR]
  assemble_manifest.py --selftest
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone

VERDICT_ORDER = {"draft": 0, "candidate": 1, "industrial": 2}
BATTERY_VERDICTS = ("clean", "breaches_found", "not_run")
LEDGER_NAME = "evidence-ledger.jsonl"
ARTIFACTS_DIR = "artifacts"
DECISION_NAME = "decision-record.json"
DOSSIER_NAME = "evidence-dossier.json"
LENS_PREFIX = "battery-lens-"
MANIFEST_BASENAME = "acceptance-manifest.json"
RATE_RE = re.compile(r"(pass_rate|baseline_rate)\s*=\s*([^\s,;)]+)", re.IGNORECASE)

LEDGER_TIMING_LIMIT = (
    "evidenceLedgerSha256 pins the ledger BEFORE the battery stage's own line: "
    "the assembler runs inside the battery gate, so the final ledger gains one "
    "line (the battery attempt that produced this manifest) after assembly"
)
KIT_STAGING_LIMIT = (
    "reverify commands validate-dossier/validate-structure need the pipeline kit "
    "(validators/ + artifacts/) staged at the artifact root; on a bare artifact "
    "tree they fail visibly (non-zero exit), never silently"
)
DSH_UNKNOWN_LIMIT = (
    "dshVersion unresolved at assembly time (no readable dsh install) — "
    "re-verification cannot pin the host drift axis for this creation"
)
PRESET_WORKSPACE_HARNESS_LIMIT = (
    "preset command-phase re-verification is creation-workspace-anchored: the acceptance harness "
    "(evals/run_harness.sh) and the validate-dossier/validate-structure pipeline kit live at the "
    "creation-workspace build/ level and are DELIBERATELY NOT shipped inside the preset tree — "
    "build/preset/ is the install unit that lands in $DSH_HOME/.agent-presets/<id>/ and the harness "
    "must not travel with it (targets/preset/BUILD.md §1). The reverify commands therefore resolve "
    "only from the creation workspace (the harness path is stepped up out of the shipped preset root); "
    "the HASH phase (per-file sha256 + rootHash) alone is re-runnable from the installed preset artifact"
)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str) -> str:
    with open(path, "rb") as f:
        return sha256_bytes(f.read())


def battery_cap(battery_verdict: str) -> str:
    return "industrial" if battery_verdict == "clean" else "candidate"


def min_fold(re_audit: str, battery: str) -> str:
    cap = battery_cap(battery)
    return min(re_audit, cap, key=lambda x: VERDICT_ORDER[x])


# --------------------------------------------------------------------------
# Artifact tree walk + rootHash (byte-identical to tools/reverify.mjs)
# --------------------------------------------------------------------------

def walk_build(build_dir: str, exclude_abs: str | None) -> tuple[dict, list]:
    """Walk the artifact tree → {posix-rel-path: sha256}. Symlinks/specials refuse.

    Excludes acceptance-manifest.json at the tree root (the standard's rule),
    the --out file when it resolves inside the tree (never self-hash), and
    runtime cache dirs (__pycache__, .DS_Store) — R1-c shipped .pyc files whose
    bytes change on every harness re-run, which would trip reverify's
    tree-unchanged check on the first legitimate re-verification.
    """
    files: dict = {}
    violations: list = []
    CACHE_DIRS = {"__pycache__", ".git", "node_modules"}
    for root, dirs, names in os.walk(build_dir, followlinks=False):
        dirs.sort()
        for d in list(dirs):
            if d in CACHE_DIRS:
                dirs.remove(d)
                continue
            if os.path.islink(os.path.join(root, d)):
                rel = os.path.relpath(os.path.join(root, d), build_dir)
                violations.append(f"artifact tree carries a symlink directory '{rel}' — symlinks are illegal in a manifested artifact")
                dirs.remove(d)
        for name in sorted(names):
            if name == ".DS_Store":
                continue
            abs_path = os.path.join(root, name)
            rel = os.path.relpath(abs_path, build_dir).replace(os.sep, "/")
            if os.path.islink(abs_path):
                violations.append(f"artifact tree carries a symlink '{rel}' — symlinks are illegal in a manifested artifact")
                continue
            if not os.path.isfile(abs_path):
                violations.append(f"artifact tree carries a non-regular file '{rel}' (socket/fifo) — illegal in a manifested artifact")
                continue
            if rel == MANIFEST_BASENAME:
                continue  # the standard: the manifest never hashes itself
            if exclude_abs and os.path.abspath(abs_path) == exclude_abs:
                continue
            files[rel] = sha256_file(abs_path)
    if not files and not violations:
        violations.append(f"artifact tree at '{build_dir}' is empty — nothing to manifest")
    return files, violations


def compute_root_hash(files: dict) -> str:
    """sha256 over '<hash>  <path>' lines, paths sorted by code point (== UTF-8
    byte order, which UTF-8 preserves), '\n'-joined with a trailing '\n' —
    byte-identical to computeRootHash in tools/reverify.mjs."""
    paths = sorted(files.keys())
    text = "\n".join(f"{files[p]}  {p}" for p in paths) + ("\n" if paths else "")
    return sha256_bytes(text.encode("utf-8"))


# --------------------------------------------------------------------------
# Ledger → provenance
# --------------------------------------------------------------------------

def read_ledger(path: str) -> tuple[list, list]:
    if not os.path.isfile(path):
        return [], [f"evidence ledger missing at '{path}' — provenance cannot be assembled without machine-written evidence"]
    violations: list = []
    entries: list = []
    with open(path, "r", encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            if line.strip() == "":
                continue
            try:
                entries.append(json.loads(line))
            except Exception as e:
                violations.append(f"evidence ledger line {i} is unparseable ({e}) — corrupt evidence refuses assembly")
    if not entries and not violations:
        violations.append(f"evidence ledger at '{path}' has zero entries — nothing was ledgered")
    return entries, violations


def resolve_dsh_version(dsh_root: str) -> str:
    pkg = os.path.join(dsh_root, "profiles", "node_modules", "@deepseek-ai", "dsh", "package.json")
    try:
        with open(pkg, "r", encoding="utf-8") as f:
            version = json.load(f).get("version")
        return version if isinstance(version, str) and version.strip() else "unknown"
    except Exception:
        return "unknown"


def derive_provenance(entries: list, ledger_path: str, provider: str, dsh_root: str) -> tuple[dict, list, list]:
    violations: list = []
    extra_limits: list = []
    pipelines = sorted({e.get("pipeline") for e in entries if isinstance(e.get("pipeline"), str)})
    if len(pipelines) != 1:
        violations.append(f"evidence ledger names {len(pipelines)} pipeline id(s) {pipelines} — expected exactly one")
    shas = sorted({e.get("manifestSha256") for e in entries if isinstance(e.get("manifestSha256"), str)})
    if len(shas) != 1:
        violations.append(
            f"evidence ledger carries {len(shas)} distinct manifestSha256 value(s) — the pipeline manifest changed mid-run; staged evidence is not one run's evidence"
        )
    models = sorted({e.get("roleModel") for e in entries if isinstance(e.get("roleModel"), str) and e.get("roleModel").strip()})
    if not models:
        violations.append("no ledger line carries a roleModel — verdicts are model-pinned and cannot ship unpinned")
    session_ids: list = []
    for e in entries:
        for sid in e.get("childSessionIds") or []:
            if isinstance(sid, str) and sid not in session_ids:
                session_ids.append(sid)
    dsh_version = resolve_dsh_version(dsh_root)
    if dsh_version == "unknown":
        extra_limits.append(DSH_UNKNOWN_LIMIT)
    provenance = {
        "pipeline": pipelines[0] if len(pipelines) == 1 else "invalid",
        "pipelineVersion": f"manifest:{shas[0][:12]}" if len(shas) == 1 else "invalid",
        "createdAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "dshVersion": dsh_version,
        "model": {"provider": provider if provider else "unknown", "id": "+".join(models) if models else "invalid"},
        "evidenceLedgerSha256": sha256_file(ledger_path) if os.path.isfile(ledger_path) else "0" * 64,
        "sessionIds": session_ids,
    }
    return provenance, extra_limits, violations


# --------------------------------------------------------------------------
# Decision record + lens artifacts → verdicts
# --------------------------------------------------------------------------

def count_lens_findings(artifacts_dir: str) -> tuple[dict, list]:
    counts = {"p1": 0, "p2": 0, "p3": 0}
    violations: list = []
    if not os.path.isdir(artifacts_dir):
        return counts, violations
    for name in sorted(os.listdir(artifacts_dir)):
        if not (name.startswith(LENS_PREFIX) and name.endswith(".json")):
            continue
        path = os.path.join(artifacts_dir, name)
        try:
            with open(path, "r", encoding="utf-8") as f:
                lens = json.load(f)
        except Exception as e:
            violations.append(f"lens artifact '{name}' is unparseable ({e}) — finding counts cannot be assembled from corrupt evidence")
            continue
        for j, finding in enumerate(lens.get("findings") or [] if isinstance(lens, dict) else []):
            severity = (finding.get("severity") if isinstance(finding, dict) else None) or ""
            key = str(severity).strip().lower()[:2]
            if key in counts:
                counts[key] += 1
            else:
                violations.append(f"lens artifact '{name}' findings[{j}] severity {severity!r} is not P1/P2/P3 — unrankable finding refuses counting")
    return counts, violations


def derive_verdicts(decision: dict, counts: dict) -> tuple[dict, list]:
    violations: list = []
    acceptance = decision.get("acceptance") or {}
    re_audit = acceptance.get("re_audit_verdict")
    battery = acceptance.get("battery_verdict")
    written = acceptance.get("effective_verdict")
    if re_audit not in VERDICT_ORDER:
        violations.append(f"decision-record acceptance.re_audit_verdict {re_audit!r} is not draft/candidate/industrial")
    if battery not in BATTERY_VERDICTS:
        violations.append(f"decision-record acceptance.battery_verdict {battery!r} is not clean/breaches_found/not_run")
    if violations:
        return {}, violations
    recomputed = min_fold(re_audit, battery)
    if written != recomputed:
        violations.append(
            f"REFUSED verdict fold mismatch: decision-record effective_verdict={written!r} but recomputed "
            f"min(re_audit={re_audit!r}, battery_cap[{battery!r}]={battery_cap(battery)!r}) == {recomputed!r} "
            f"— the manifest will not certify a verdict the fold does not produce"
        )
    if battery == "breaches_found" and counts["p1"] + counts["p2"] + counts["p3"] == 0:
        violations.append(
            "decision-record battery_verdict=='breaches_found' but zero P1/P2/P3 findings were counted across "
            "artifacts/battery-lens-*.json — breaches without findings is suppressed evidence"
        )
    verdicts = {
        "reAudit": re_audit,
        "battery": battery,
        "effective": recomputed,
        "batteryFindingsCounts": {"p1": counts["p1"], "p2": counts["p2"], "p3": counts["p3"]},
    }
    return verdicts, violations


# --------------------------------------------------------------------------
# Dossier → baselineDelta + limits
# --------------------------------------------------------------------------

def derive_baseline(dossier: dict) -> tuple[dict, list]:
    violations: list = []
    for layer in dossier.get("layers") or []:
        notes = layer.get("notes") if isinstance(layer, dict) else None
        if not isinstance(notes, str) or "baseline" not in notes.lower():
            continue
        rates = {m.group(1).lower(): m.group(2) for m in RATE_RE.finditer(notes)}
        if not rates:
            return {"measured": False, "note": notes.strip()}, violations  # carve-out travels verbatim
        parsed = {}
        for key in ("pass_rate", "baseline_rate"):
            raw = rates.get(key)
            try:
                value = float(raw)
            except (TypeError, ValueError):
                violations.append(
                    f"REFUSED baselineDelta: dossier baseline note carries rate tokens but {key} is "
                    f"{'missing' if raw is None else repr(raw)} — measured=true without both parseable rates is a fabricated rate"
                )
                continue
            if not (0.0 <= value <= 1.0):
                violations.append(f"REFUSED baselineDelta: {key}={value} outside [0,1]")
                continue
            parsed[key] = value
        if violations:
            return {}, violations
        return {
            "measured": True,
            "passRate": parsed["pass_rate"],
            "baselineRate": parsed["baseline_rate"],
            "note": notes.strip(),
        }, violations
    return {
        "measured": False,
        "note": "no baseline-delta record found in the evidence dossier layer notes — not measured this creation "
                "(no pass_rate/baseline_rate entry and no n/a carve-out note)",
    }, violations


def derive_limits(dossier: dict) -> list:
    limits: list = []
    for layer in dossier.get("layers") or []:
        if not isinstance(layer, dict) or layer.get("verdict") != "not_run":
            continue
        name = layer.get("layer", "?")
        kind = layer.get("eval_kind", "?")
        notes = layer.get("notes") or ""
        notes = notes.strip() if isinstance(notes, str) else ""
        limits.append(f"{name} ({kind}) not_run: {notes if notes else 'no notes recorded'}")
    return limits


# --------------------------------------------------------------------------
# Artifact identity (name/kind/version from the tree, never from a model)
# --------------------------------------------------------------------------

def _frontmatter_field(text: str, field: str) -> str | None:
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return None
    for line in lines[1:]:
        if line.strip() == "---":
            return None
        m = re.match(rf"\s*{re.escape(field)}\s*:\s*(.+?)\s*$", line)
        if m:
            return m.group(1).strip().strip("'\"")
    return None


def _yaml_scalar(path: str, *fields: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
    except Exception:
        return None
    for field in fields:
        m = re.search(rf"^\s*{re.escape(field)}\s*:\s*(.+?)\s*$", text, re.MULTILINE)
        if m:
            return m.group(1).strip().strip("'\"")
    return None


def artifact_root(build_dir: str) -> str:
    """The artifact tree root. A preset target ships its self-contained
    directory one level down at build/preset/ (targets/preset/BUILD.md §1:
    the install unit must not land the harness/installer into $DSH_HOME), so
    when build/ has no root marker but build/preset/ carries one, that
    subdir is the tree root. All other targets keep the artifact at build/."""
    def has_marker(d):
        return any(os.path.isfile(os.path.join(d, m))
                   for m in ("package.json", "preset.yml", "agent.cordis.yml", "SKILL.md"))
    if not has_marker(build_dir):
        sub = os.path.join(build_dir, "preset")
        if os.path.isdir(sub) and has_marker(sub):
            return sub
    return build_dir


def detect_identity(build_dir: str, decision: dict) -> tuple[str, str, str, list]:
    violations: list = []
    fallback_name = decision.get("target") if isinstance(decision.get("target"), str) else None
    pkg_json = os.path.join(build_dir, "package.json")
    if os.path.isfile(pkg_json):
        try:
            with open(pkg_json, "r", encoding="utf-8") as f:
                pkg = json.load(f)
        except Exception as e:
            return "", "", "", [f"build/package.json is unparseable ({e}) — plugin identity cannot be read"]
        name = pkg.get("name") if isinstance(pkg.get("name"), str) else fallback_name
        version = pkg.get("version") if isinstance(pkg.get("version"), str) else "unversioned"
        if not name:
            violations.append("plugin identity: neither package.json name nor decision-record target is usable")
        return name or "", "plugin", version, violations
    for preset_file in ("preset.yml", "agent.cordis.yml"):
        path = os.path.join(build_dir, preset_file)
        if os.path.isfile(path):
            name = _yaml_scalar(path, "id", "name") or fallback_name
            version = _yaml_scalar(path, "version") or "unversioned"
            if not name:
                violations.append("preset identity: neither preset.yml id/name nor decision-record target is usable")
            return name or "", "preset", version, violations
    skill_md = os.path.join(build_dir, "SKILL.md")
    if os.path.isfile(skill_md):
        with open(skill_md, "r", encoding="utf-8") as f:
            text = f.read()
        name = _frontmatter_field(text, "name") or fallback_name
        version = _frontmatter_field(text, "version") or "unversioned"
        if not name:
            violations.append("skill identity: neither SKILL.md frontmatter name nor decision-record target is usable")
        return name or "", "skill", version, violations
    return "", "", "", [
        "artifact tree is unrecognizable: no package.json (plugin), preset.yml/agent.cordis.yml (preset), or SKILL.md (skill) at the tree root"
    ]


# --------------------------------------------------------------------------
# Reverify commands (relative paths — the manifest travels; cwd containment)
# --------------------------------------------------------------------------

def build_reverify(dossier: dict, files: dict, kind: str, build_dir: str, tree_dir: str) -> tuple[dict, list, list]:
    violations: list = []
    extra_limits: list = []
    harness = (dossier.get("verification") or {}).get("harness_path")
    # harness_ref is the value written into the manifest (argv + harnessPath). For
    # skill/plugin it equals the dossier path (the harness travels INSIDE the tree).
    # For a preset it is stepped up out of the shipped root to the workspace build.
    harness_ref = ""
    if not isinstance(harness, str) or not harness.strip():
        violations.append("dossier verification.harness_path is missing/blank — a manifest without a runnable harness entry is unshippable")
        harness = ""
    else:
        harness = harness.strip()
        if kind == "preset":
            # A preset's install unit is build/preset/ ONLY; the harness (and the
            # validate-dossier/validate-structure pipeline kit) deliberately live at the
            # creation-workspace build/ level and must NOT land in $DSH_HOME on install
            # (targets/preset/BUILD.md §1). So the membership check ("harness must be in
            # the artifact tree files") does NOT apply for kind=preset. Instead:
            #   (a) the harness must EXIST relative to the workspace build_dir, and
            #   (b) the reverify command path is anchored to resolve from the creation
            #       workspace — stepped up from the shipped tree (build/preset/) to
            #       build_dir (build/) — the honest cwd/path for a workspace-anchored tool.
            harness_abs = os.path.join(build_dir, harness)
            if not os.path.isfile(harness_abs):
                violations.append(
                    f"preset harness verification.harness_path '{harness}' does not exist at the creation-workspace "
                    f"build dir ('{harness_abs}') — a preset harness is workspace-anchored (not shipped inside the "
                    f"preset tree) but it must still exist there to be re-runnable"
                )
            step = os.path.relpath(build_dir, tree_dir)  # '..' when the tree is build/preset/
            harness_ref = os.path.normpath(os.path.join(step, harness)).replace(os.sep, "/")
            extra_limits.append(PRESET_WORKSPACE_HARNESS_LIMIT)
        else:
            harness_ref = harness
            if harness not in files:
                violations.append(
                    f"dossier verification.harness_path '{harness}' is not in the artifact tree walk — the shipped harness must travel with the artifact"
                )
    harness_desc = (
        "the target's own deterministic acceptance harness, resolved from the CREATION WORKSPACE "
        "(a preset harness is not shipped inside the preset tree; see limits[]) — targets/preset/BUILD.md §1/§6"
        if kind == "preset"
        else "the target's own deterministic acceptance harness (targets/*/BUILD.md evals convention)"
    )
    commands = [
        {
            "id": "harness",
            "argv": ["bash", harness_ref],
            "cwd": ".",
            "expectedExit": 0,
            "description": harness_desc,
        },
        {
            "id": "validate-dossier",
            "argv": ["python3", "validators/validate_report.py", "artifacts/evidence-dossier.json", "--target-dir", "."],
            "cwd": ".",
            "expectedExit": 0,
            "description": "pipeline validator re-check of the evidence dossier (requires the pipeline kit staged at the artifact root)",
        },
        {
            "id": "validate-structure",
            "argv": ["python3", "validators/validate_structure.py", "artifacts/structure-contract.json", "--target-dir", ".", "--check-files"],
            "cwd": ".",
            "expectedExit": 0,
            "description": "pipeline validator re-check of the structure contract, fail-closed file existence (requires the pipeline kit staged at the artifact root)",
        },
    ]
    for cmd in commands:
        normalized = os.path.normpath(os.path.join("/artifact-root", cmd["cwd"]))
        if not (normalized == "/artifact-root" or normalized.startswith("/artifact-root" + os.sep)):
            violations.append(f"reverify command '{cmd['id']}' cwd '{cmd['cwd']}' escapes the artifact root — containment refused")
        for arg in cmd["argv"]:
            if os.path.isabs(arg):
                violations.append(f"reverify command '{cmd['id']}' carries absolute path argv '{arg}' — the manifest travels; paths must be relative")
    if "validators/validate_report.py" not in files:
        extra_limits.append(KIT_STAGING_LIMIT)
    return {"commands": commands, "harnessPath": harness_ref}, violations, extra_limits


# --------------------------------------------------------------------------
# Final consistency guard (defense in depth — re-checked on the ASSEMBLED doc)
# --------------------------------------------------------------------------

def consistency_errors(manifest: dict, decision: dict, dossier: dict) -> list:
    v: list = []
    verdicts = manifest.get("verdicts") or {}
    acceptance = decision.get("acceptance") or {}
    if verdicts and acceptance.get("re_audit_verdict") in VERDICT_ORDER and acceptance.get("battery_verdict") in BATTERY_VERDICTS:
        recomputed = min_fold(acceptance["re_audit_verdict"], acceptance["battery_verdict"])
        if verdicts.get("effective") != recomputed or acceptance.get("effective_verdict") != recomputed:
            v.append(
                f"verdict fold mismatch at final guard: manifest effective={verdicts.get('effective')!r}, "
                f"decision effective_verdict={acceptance.get('effective_verdict')!r}, recomputed fold={recomputed!r}"
            )
    bd = manifest.get("baselineDelta") or {}
    if bd.get("measured") is True and not (isinstance(bd.get("passRate"), float) and isinstance(bd.get("baselineRate"), float)):
        v.append("baselineDelta measured=true without both numeric rates — fabricated-rate class")
    if bd.get("measured") is False and not str(bd.get("note", "")).strip():
        v.append("baselineDelta measured=false with a blank note — n/a-with-reason is legal, silence is not")
    limits = manifest.get("limits") or []
    joined = "\n".join(str(x) for x in limits)
    for layer in dossier.get("layers") or []:
        if isinstance(layer, dict) and layer.get("verdict") == "not_run":
            name = str(layer.get("layer", "?"))
            if name not in joined:
                v.append(
                    f"SILENT-LIMIT SUPPRESSION: dossier layer {name} is not_run but limits[] does not name it — "
                    f"a limits list that lost a not_run layer is the fraud class this gate exists for"
                )
    # A preset's harness is creation-workspace-anchored and legitimately absent from the
    # shipped tree files (targets/preset/BUILD.md §1); the in-tree guard applies to
    # skill/plugin only, whose harness DOES travel inside the artifact.
    kind = (manifest.get("artifact") or {}).get("kind")
    harness = (manifest.get("reverify") or {}).get("harnessPath", "")
    if kind != "preset" and harness and harness not in (manifest.get("artifact") or {}).get("files", {}):
        v.append(f"reverify.harnessPath '{harness}' not present in artifact.files")
    return v


# --------------------------------------------------------------------------
# Assembly
# --------------------------------------------------------------------------

def assemble(workspace: str, build_subdir: str, out_path: str, provider: str, dsh_root: str) -> tuple[dict, list]:
    workspace = os.path.abspath(workspace)
    build_dir = os.path.join(workspace, build_subdir)
    artifacts_dir = os.path.join(workspace, ARTIFACTS_DIR)
    ledger_path = os.path.join(workspace, LEDGER_NAME)
    violations: list = []

    if not os.path.isdir(build_dir):
        return {}, [f"build dir missing at '{build_dir}'"]

    # A preset target's self-contained tree sits at build/preset/; every other
    # target keeps it at build/. The manifest describes the ARTIFACT tree.
    tree_dir = artifact_root(build_dir)

    def load(name):
        path = os.path.join(artifacts_dir, name)
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            violations.append(f"required artifact '{ARTIFACTS_DIR}/{name}' unreadable/unparseable: {e}")
            return {}

    decision = load(DECISION_NAME)
    dossier = load(DOSSIER_NAME)
    if violations:
        return {}, violations

    files, walk_violations = walk_build(tree_dir, os.path.abspath(out_path))
    violations.extend(walk_violations)

    entries, ledger_violations = read_ledger(ledger_path)
    violations.extend(ledger_violations)
    provenance, prov_limits, prov_violations = derive_provenance(entries, ledger_path, provider, dsh_root) if entries else ({}, [], [])
    violations.extend(prov_violations)

    counts, count_violations = count_lens_findings(artifacts_dir)
    violations.extend(count_violations)
    verdicts, verdict_violations = derive_verdicts(decision, counts)
    violations.extend(verdict_violations)

    baseline, baseline_violations = derive_baseline(dossier)
    violations.extend(baseline_violations)

    # Identity (name/kind/version) is read from the tree BEFORE reverify so the
    # harness handling can branch on kind: a preset's harness is workspace-anchored,
    # not shipped inside the preset tree (targets/preset/BUILD.md §1).
    name, kind, version, identity_violations = detect_identity(tree_dir, decision)
    violations.extend(identity_violations)

    reverify, reverify_violations, kit_limits = build_reverify(dossier, files, kind, build_dir, tree_dir)
    violations.extend(reverify_violations)

    limits = derive_limits(dossier) + kit_limits + prov_limits + [LEDGER_TIMING_LIMIT]

    if violations:
        return {}, violations

    manifest = {
        "manifestVersion": 1,
        "artifact": {
            "name": name,
            "kind": kind,
            "version": version,
            "rootHash": compute_root_hash(files),
            "files": files,
        },
        "provenance": provenance,
        "verdicts": verdicts,
        "reverify": reverify,
        "baselineDelta": baseline,
        "limits": limits,
    }
    final = consistency_errors(manifest, decision, dossier)
    if final:
        return {}, final
    return manifest, []


def main() -> int:
    args = sys.argv[1:]
    if args == ["--selftest"]:
        return run_selftest()
    opts = {"--workspace": None, "--build-subdir": "build", "--out": None,
            "--provider": "", "--dsh-root": os.path.join(os.path.expanduser("~"), ".dsh")}
    i = 0
    while i < len(args):
        if args[i] in opts and i + 1 < len(args):
            opts[args[i]] = args[i + 1]
            i += 2
        else:
            print(f"unknown/valueless argument: {args[i]}", file=sys.stderr)
            print(__doc__.split("Usage:")[1].strip(), file=sys.stderr)
            return 2
    if not opts["--workspace"] or not opts["--out"]:
        print("usage: assemble_manifest.py --workspace DIR [--build-subdir NAME] --out PATH [--provider NAME] [--dsh-root DIR] | --selftest", file=sys.stderr)
        return 2

    manifest, violations = assemble(opts["--workspace"], opts["--build-subdir"], opts["--out"], opts["--provider"], opts["--dsh-root"])
    if violations:
        print(f"FAIL: acceptance manifest NOT written ({len(violations)} violation(s)):")
        for x in violations:
            print(f"  - {x}")
        return 1
    out = os.path.abspath(opts["--out"])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")
    files = manifest["artifact"]["files"]
    print(f"PASS: {out} ({len(files)} files, rootHash {manifest['artifact']['rootHash'][:12]}, "
          f"effective={manifest['verdicts']['effective']}, limits={len(manifest['limits'])})")
    return 0


# --------------------------------------------------------------------------
# --selftest fixtures
# --------------------------------------------------------------------------

def _green_decision() -> dict:
    return {
        "target": "toy-target",
        "acceptance": {
            "re_audit_verdict": "industrial",
            "battery_verdict": "clean",
            "battery_independence_tier": "model",
            "battery_stop_reason": "E9 pre-registered condition fired",
            "effective_verdict": "industrial",
        },
    }


def _green_dossier() -> dict:
    return {
        "layers": [
            {"layer": "E-L0", "eval_kind": "regression", "cases_total": 5, "cases_passed": 5, "verdict": "green", "notes": ""},
            {"layer": "E-L1", "eval_kind": "capability", "cases_total": 20, "cases_passed": 19,
             "verdict": "green", "notes": "baseline_delta: n/a — code artifact; uplift is proven by the unit/golden layers"},
            {"layer": "E-L4", "eval_kind": "capability", "cases_total": 0, "cases_passed": 0,
             "verdict": "not_run", "notes": "standing-mount behavior not observable outside a live host"},
        ],
        "verification": {"harness_ran": True, "harness_path": "evals/run_harness.sh",
                         "all_required_passed": True, "command_output": "12/12 green", "exit_code": 0},
    }


def _ledger_lines() -> list:
    sha = "a" * 64
    return [
        {"ts": "2026-08-17T01:00:00Z", "pipeline": "tool-creator", "manifestSha256": sha, "stage": "composer",
         "attempt": 1, "childSessionIds": ["sess-1"], "gateExit": 0, "roleModel": "deepseek-v4-pro", "tokens": None, "error": None},
        {"ts": "2026-08-17T02:00:00Z", "pipeline": "tool-creator", "manifestSha256": sha, "stage": "engineer",
         "attempt": 1, "childSessionIds": ["sess-2", "sess-3"], "gateExit": 0, "roleModel": "deepseek-v4-pro", "tokens": 1234, "error": None},
    ]


def _write_workspace(root: str, *, decision=None, dossier=None, ledger_lines=None,
                     lens=None, build_files=None, dsh_version="9.9.9-test") -> dict:
    ws = os.path.join(root, "ws")
    os.makedirs(os.path.join(ws, ARTIFACTS_DIR), exist_ok=True)
    build = os.path.join(ws, "build")
    files = build_files if build_files is not None else {
        "package.json": json.dumps({"name": "dsh-toy-plugin", "version": "0.1.0"}) + "\n",
        "lib/index.js": "export const name = 'dsh-toy-plugin';\n",
        "evals/run_harness.sh": "#!/bin/sh\nexit 0\n",
    }
    for rel, content in files.items():
        path = os.path.join(build, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
    with open(os.path.join(ws, ARTIFACTS_DIR, DECISION_NAME), "w", encoding="utf-8") as f:
        json.dump(decision if decision is not None else _green_decision(), f)
    with open(os.path.join(ws, ARTIFACTS_DIR, DOSSIER_NAME), "w", encoding="utf-8") as f:
        json.dump(dossier if dossier is not None else _green_dossier(), f)
    lens_doc = lens if lens is not None else {"findings": [{"lens": "coherence", "severity": "P3", "claim": "wording"}], "flags": []}
    with open(os.path.join(ws, ARTIFACTS_DIR, f"{LENS_PREFIX}coherence.json"), "w", encoding="utf-8") as f:
        json.dump(lens_doc, f)
    with open(os.path.join(ws, LEDGER_NAME), "w", encoding="utf-8") as f:
        for line in (ledger_lines if ledger_lines is not None else _ledger_lines()):
            f.write((line if isinstance(line, str) else json.dumps(line)) + "\n")
    dsh_root = os.path.join(root, "fake-dsh")
    if dsh_version is not None:
        pkg_dir = os.path.join(dsh_root, "profiles", "node_modules", "@deepseek-ai", "dsh")
        os.makedirs(pkg_dir, exist_ok=True)
        with open(os.path.join(pkg_dir, "package.json"), "w", encoding="utf-8") as f:
            json.dump({"name": "@deepseek-ai/dsh", "version": dsh_version}, f)
    return {"ws": ws, "build": build, "dsh_root": dsh_root,
            "out": os.path.join(ws, ARTIFACTS_DIR, MANIFEST_BASENAME)}


def _assemble_fx(fx: dict) -> tuple[dict, list]:
    return assemble(fx["ws"], "build", fx["out"], "deepseek-official", fx["dsh_root"])


def run_selftest() -> int:  # noqa: C901 — the selftest is deliberately exhaustive
    ok = True
    caught = 0
    total = 0

    def fail(msg):
        nonlocal ok
        ok = False
        print(f"SELFTEST FAIL: {msg}")

    with tempfile.TemporaryDirectory() as tmp:
        # ---- green fixture --------------------------------------------------
        fx = _write_workspace(os.path.join(tmp, "green"))
        manifest, violations = _assemble_fx(fx)
        if violations:
            fail(f"green fixture refused: {violations}")
        else:
            a = manifest["artifact"]
            checks = [
                (a["name"] == "dsh-toy-plugin" and a["kind"] == "plugin" and a["version"] == "0.1.0", "identity from package.json"),
                (set(a["files"]) == {"package.json", "lib/index.js", "evals/run_harness.sh"}, "file walk coverage"),
                (a["rootHash"] == compute_root_hash(a["files"]), "rootHash recompute"),
                (manifest["verdicts"] == {"reAudit": "industrial", "battery": "clean", "effective": "industrial",
                                          "batteryFindingsCounts": {"p1": 0, "p2": 0, "p3": 1}}, "verdicts + lens counts"),
                (manifest["provenance"]["model"] == {"provider": "deepseek-official", "id": "deepseek-v4-pro"}, "model pin from ledger roleModel"),
                (manifest["provenance"]["dshVersion"] == "9.9.9-test", "dshVersion from dsh install"),
                (manifest["provenance"]["sessionIds"] == ["sess-1", "sess-2", "sess-3"], "sessionIds union from ledger"),
                (manifest["provenance"]["pipeline"] == "tool-creator", "pipeline id from ledger"),
                (manifest["baselineDelta"]["measured"] is False and "n/a" in manifest["baselineDelta"]["note"], "carve-out note travels verbatim"),
                (any("E-L4" in x for x in manifest["limits"]), "not_run layer named in limits"),
                (LEDGER_TIMING_LIMIT in manifest["limits"], "ledger-timing disclosure present"),
                (KIT_STAGING_LIMIT in manifest["limits"], "kit-staging disclosure present"),
                (len(manifest["reverify"]["commands"]) == 3 and all(c["cwd"] == "." for c in manifest["reverify"]["commands"]), "3 reverify commands, contained cwd"),
                (all(not os.path.isabs(arg) for c in manifest["reverify"]["commands"] for arg in c["argv"]), "reverify argv all relative"),
                (manifest["reverify"]["harnessPath"] == "evals/run_harness.sh", "harnessPath from dossier verification"),
            ]
            bad = [label for passed, label in checks if not passed]
            if bad:
                fail(f"green fixture assembled wrong: {bad}")
            else:
                print("selftest: green fixture ok (assembled, all content checks pass)")

        # ---- sanity pass: measured baseline with parseable rates ------------
        dossier = _green_dossier()
        dossier["layers"][1]["notes"] = "baseline_delta: pass_rate=0.85 baseline_rate=0.40 (tokens -12%, wall-clock -8%)"
        fx = _write_workspace(os.path.join(tmp, "measured"), dossier=dossier)
        manifest, violations = _assemble_fx(fx)
        if violations or manifest["baselineDelta"] != {"measured": True, "passRate": 0.85, "baselineRate": 0.40,
                                                      "note": dossier["layers"][1]["notes"]}:
            fail(f"measured-rates sanity pass wrong: violations={violations}")
        else:
            print("selftest: sanity-pass measured baseline rates parsed mechanically")

        # ---- sanity pass: unresolvable dsh install → unknown, DISCLOSED -----
        fx = _write_workspace(os.path.join(tmp, "nodsh"), dsh_version=None)
        manifest, violations = _assemble_fx(fx)
        if violations or manifest["provenance"]["dshVersion"] != "unknown" or DSH_UNKNOWN_LIMIT not in manifest["limits"]:
            fail(f"unknown-dshVersion sanity pass wrong: violations={violations}")
        else:
            print("selftest: sanity-pass dshVersion unknown is disclosed in limits")

        # ---- sanity pass: skill identity from SKILL.md frontmatter ----------
        fx = _write_workspace(os.path.join(tmp, "skill"), build_files={
            "SKILL.md": "---\nname: toy-skill\nversion: 1.2.0\n---\n# toy\n",
            "evals/run_harness.sh": "#!/bin/sh\nexit 0\n",
        })
        manifest, violations = _assemble_fx(fx)
        if violations or (manifest["artifact"]["name"], manifest["artifact"]["kind"], manifest["artifact"]["version"]) != ("toy-skill", "skill", "1.2.0"):
            fail(f"skill identity sanity pass wrong: violations={violations}")
        else:
            print("selftest: sanity-pass skill identity from frontmatter")

        # ---- sanity pass: PRESET target — shipped tree at build/preset/, harness at build/evals/ ----
        # A preset ships build/preset/ ONLY; the harness lives at the creation-workspace build/
        # level and is deliberately NOT in the shipped tree (targets/preset/BUILD.md §1). This
        # MUST assemble GREEN: hash build/preset/, detect kind=preset, anchor the harness path up
        # out of the shipped root, and disclose the workspace-anchored command-phase limit.
        preset_files = {
            "preset/preset.yml": "name: toy-preset\nversion: 2.0.0\ndescription: a toy preset\norder: 10\n",
            "preset/agent.cordis.yml": "- id: persona\n  name: '@deepseek-ai/persona'\n",
            "evals/run_harness.sh": "#!/bin/sh\nexit 0\n",
        }
        fx = _write_workspace(os.path.join(tmp, "preset"), build_files=preset_files)
        manifest, violations = _assemble_fx(fx)
        if violations:
            fail(f"preset fixture refused: {violations}")
        else:
            a = manifest["artifact"]
            checks = [
                (a["name"] == "toy-preset" and a["kind"] == "preset" and a["version"] == "2.0.0", "preset identity from preset.yml"),
                (set(a["files"]) == {"preset.yml", "agent.cordis.yml"}, "walk is the shipped preset/ tree only (harness NOT a member)"),
                (a["rootHash"] == compute_root_hash(a["files"]), "rootHash recompute"),
                (manifest["reverify"]["harnessPath"] == "../evals/run_harness.sh", "harnessPath anchored up out of the shipped root"),
                (manifest["reverify"]["commands"][0]["argv"] == ["bash", "../evals/run_harness.sh"], "harness argv resolves from the creation workspace"),
                (manifest["reverify"]["commands"][0]["cwd"] == ".", "harness cwd stays contained in the shipped root"),
                (PRESET_WORKSPACE_HARNESS_LIMIT in manifest["limits"], "workspace-anchored preset limit present"),
                (any("E-L4" in x for x in manifest["limits"]), "not_run layer still named in limits"),
            ]
            bad = [label for passed, label in checks if not passed]
            if bad:
                fail(f"preset fixture assembled wrong: {bad}")
            else:
                print("selftest: sanity-pass PRESET target (build/preset/ hashed, harness workspace-anchored, limit disclosed)")

        # ---- traps ----------------------------------------------------------
        traps = []

        d = _green_decision()
        d["acceptance"]["battery_verdict"] = "not_run"  # cap candidate; effective stays industrial
        traps.append(("fold mismatch: effective above the battery cap", {"decision": d}, "fold mismatch"))

        d = _green_decision()
        d["acceptance"]["effective_verdict"] = "draft"  # below the fold — writer-side refuses any disagreement
        traps.append(("fold mismatch: effective below the recomputed fold", {"decision": d}, "fold mismatch"))

        doss = _green_dossier()
        doss["layers"][1]["notes"] = "baseline_delta: pass_rate=0.62"
        traps.append(("measured rates: baseline_rate token missing", {"dossier": doss}, "fabricated rate"))

        doss = _green_dossier()
        doss["layers"][1]["notes"] = "baseline_delta: pass_rate=1.2 baseline_rate=0.4"
        traps.append(("measured rates: pass_rate outside [0,1]", {"dossier": doss}, "outside [0,1]"))

        doss = _green_dossier()
        doss["verification"]["harness_path"] = "evals/ghost.sh"
        traps.append(("harness path absent from the artifact tree", {"dossier": doss}, "harness"))

        # PRESET trap (b): the harness is missing even at the workspace build/ level — a preset
        # harness is workspace-anchored (not shipped) but it must still EXIST to be re-runnable.
        traps.append((
            "preset harness missing at the creation-workspace build/ level",
            {"build_files": {
                "preset/preset.yml": "name: toy-preset\nversion: 2.0.0\n",
                "preset/agent.cordis.yml": "- id: persona\n  name: '@deepseek-ai/persona'\n",
            }},
            "preset harness",
        ))

        # PLUGIN regression trap (c): the skill/plugin membership check is NOT loosened — the
        # very stepped-up path a PRESET legitimately anchors is REFUSED for a plugin, whose
        # harness must travel inside the artifact tree.
        doss = _green_dossier()
        doss["verification"]["harness_path"] = "../evals/run_harness.sh"
        traps.append((
            "plugin harness referenced outside the artifact tree still refuses (membership intact)",
            {"dossier": doss},
            "not in the artifact tree walk",
        ))

        d = _green_decision()
        d["acceptance"]["battery_verdict"] = "breaches_found"
        d["acceptance"]["effective_verdict"] = "candidate"
        traps.append(("breaches_found with zero counted lens findings", {"decision": d, "lens": {"findings": [], "flags": []}}, "suppressed evidence"))

        traps.append(("ledger missing", {"ledger_lines": None, "_rm_ledger": True}, "ledger missing"))
        traps.append(("ledger carries an unparseable line", {"ledger_lines": _ledger_lines() + ["CORRUPT-NOT-JSON"]}, "unparseable"))

        lines = _ledger_lines()
        lines[1]["manifestSha256"] = "b" * 64
        traps.append(("ledger mixed manifestSha256 (manifest changed mid-run)", {"ledger_lines": lines}, "manifestSha256"))

        lines = _ledger_lines()
        for line in lines:
            del line["roleModel"]
        traps.append(("no roleModel anywhere in the ledger", {"ledger_lines": lines}, "model-pinned"))

        traps.append(("unrecognizable artifact tree", {"build_files": {"random.txt": "hello\n"}}, "unrecognizable"))

        for idx, (name, overrides, needle) in enumerate(traps):
            total += 1
            rm_ledger = overrides.pop("_rm_ledger", False)
            fx = _write_workspace(os.path.join(tmp, f"trap{idx}"), **overrides)
            if rm_ledger:
                os.remove(os.path.join(fx["ws"], LEDGER_NAME))
            _, violations = _assemble_fx(fx)
            hit = violations and any(needle.lower() in str(x).lower() for x in violations)
            if hit:
                caught += 1
            else:
                fail(f"trap '{name}' was NOT caught (violations={violations})")

        # symlink trap (separate: needs os.symlink after the tree is written)
        total += 1
        fx = _write_workspace(os.path.join(tmp, "trap-symlink"))
        os.symlink("/etc/hosts", os.path.join(fx["build"], "evil-link"))
        _, violations = _assemble_fx(fx)
        if violations and any("symlink" in str(x) for x in violations):
            caught += 1
        else:
            fail(f"trap 'symlink in the artifact tree' was NOT caught (violations={violations})")

        # silent-limit suppression trap: the final guard is fed a manifest whose
        # limits[] lost the not_run layer — the exact fraud class, caught even if
        # a future code path filters limits after derivation.
        total += 1
        fx = _write_workspace(os.path.join(tmp, "trap-limits"))
        manifest, violations = _assemble_fx(fx)
        if violations:
            fail(f"limits-suppression trap setup unexpectedly refused: {violations}")
        else:
            suppressed = json.loads(json.dumps(manifest))
            suppressed["limits"] = []
            guard = consistency_errors(suppressed, _green_decision(), _green_dossier())
            if guard and any("SILENT-LIMIT SUPPRESSION" in str(x) for x in guard):
                caught += 1
            else:
                fail(f"trap 'limits emptied while dossier carries not_run layers' was NOT caught (guard={guard})")

    print(f"selftest: 1 green ok, {caught}/{total} traps caught")
    return 0 if ok and caught == total else 1


if __name__ == "__main__":
    sys.exit(main())

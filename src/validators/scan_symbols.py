#!/usr/bin/env python3
"""scan_symbols.py — mechanical hallucinated-API gate for PLUGIN targets (L4).

The slopsquatting / hallucinated-import class from the landscape research: a
model-built plugin imports `@deepseek-ai/<pkg>` packages or named exports that
do not exist in the real host install. This script compares the BUILT plugin's
imports against the installed host's symbol table — pure text-level, stdlib
only, no model in the loop.

What it does, mechanically:
  1. Scan every `lib/**/*.js` under --build-dir for `@deepseek-ai/<pkg>` module
     specifiers (static import/export-from, bare import, dynamic import(),
     require()) and collect the named imports taken from each specifier
     (`{a, b as c}` → external names a, b; a default import → "default";
     `* as ns` → package-existence check only).
  2. For each imported package: it must exist as a directory with a
     package.json under --host-dir (default
     ~/.dsh/profiles/node_modules/@deepseek-ai). Missing → HALLUCINATED
     PACKAGE (the slopsquatting finding).
  3. For each named import: resolve the entry file (package.json exports map
     for '.' or the './subpath', falling back to main, lib/index.js,
     index.js), text-scan its `export` statements into an export surface, and
     require the name to be present. Missing from a CLOSED surface →
     HALLUCINATED SYMBOL.

Exit 1 with a named finding list when anything is hallucinated; exit 0 with a
verification summary otherwise; exit 2 when --build-dir has no lib/ (not a
plugin tree — this gate is plugin-only).

HONEST FALSE-NEGATIVE BOUNDS (text-level scan, disclosed by design):
  - `export * from '...'` makes a surface OPEN: absence of a name is then
    unprovable, so named imports against that package are skipped and counted
    as "open-surface skips", never guessed either way.
  - An entry file with NO recognizable ESM `export` statements (CJS/bundled
    interop shapes, computed exports) is treated as UNKNOWN surface = open —
    the scan prefers a disclosed skip to a false accusation.
  - Comment stripping is heuristic (block comments and whitespace-prefixed
    `//` lines); import-looking text surviving inside strings can in
    principle produce a false hit, and string-built dynamic specifiers are
    invisible. This bounds the gate at "catches the common fabrication
    shapes", not "proves the import graph" — a linker it is not.

Usage:
  scan_symbols.py --build-dir DIR [--host-dir DIR]
  scan_symbols.py --selftest
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile

DEFAULT_HOST_DIR = os.path.join(os.path.expanduser("~"), ".dsh", "profiles", "node_modules", "@deepseek-ai")

SPEC_STATIC_RE = re.compile(
    r"(?:^|\s)(import|export)\s+([^'\";]*?)\s*from\s*['\"](@deepseek-ai/[^'\"]+)['\"]", re.MULTILINE)
SPEC_BARE_RE = re.compile(r"(?:^|\s)import\s*['\"](@deepseek-ai/[^'\"]+)['\"]")
SPEC_DYNAMIC_RE = re.compile(r"\bimport\(\s*['\"](@deepseek-ai/[^'\"]+)['\"]\s*\)")
SPEC_REQUIRE_RE = re.compile(r"\brequire\(\s*['\"](@deepseek-ai/[^'\"]+)['\"]\s*\)")

EXPORT_BRACE_RE = re.compile(r"(?:^|\s)export\s*\{([^}]*)\}", re.MULTILINE)
EXPORT_DECL_RE = re.compile(
    r"(?:^|\s)export\s+(?:async\s+)?(?:const|let|var|function\s*\*?|class)\s+([A-Za-z_$][\w$]*)", re.MULTILINE)
EXPORT_DEFAULT_RE = re.compile(r"(?:^|\s)export\s+default\b", re.MULTILINE)
EXPORT_STAR_RE = re.compile(r"(?:^|\s)export\s*\*\s*(?:as\s+[A-Za-z_$][\w$]*\s+)?from\b", re.MULTILINE)


def strip_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.DOTALL)
    # only whitespace-prefixed or line-start // — keeps 'https://…' intact
    return re.sub(r"(?m)(?:^|(?<=\s))//[^\n]*", " ", text)


def parse_import_clause(clause: str) -> tuple[list, bool]:
    """→ (external names required from the module, needs_package_only).

    `{a, b as c}` → [a, b]; `d` (default) → [default]; `* as ns` → ([], True).
    Mixed forms combine (e.g. `d, {a}` → [default, a]).
    """
    names: list = []
    package_only = False
    clause = clause.strip()
    if clause == "":
        return names, True  # bare side-effect import: package existence only
    brace = re.search(r"\{([^}]*)\}", clause)
    if brace:
        for item in brace.group(1).split(","):
            item = item.strip()
            if not item:
                continue
            external = item.split(" as ")[0].strip() if " as " in item else item
            if external:
                names.append(external)
        clause = (clause[:brace.start()] + clause[brace.end():]).strip().strip(",").strip()
    if clause.startswith("*"):
        package_only = True
        clause = ""
    if clause:  # a leading bare identifier = default import
        ident = clause.split(",")[0].strip()
        if re.fullmatch(r"[A-Za-z_$][\w$]*", ident):
            names.append("default")
    if not names and not package_only:
        package_only = True
    return names, package_only


def extract_imports(text: str, source_rel: str) -> list:
    """→ [{spec, names, direction, source}] for every @deepseek-ai specifier."""
    text = strip_comments(text)
    found: list = []
    for m in SPEC_STATIC_RE.finditer(text):
        keyword, clause, spec = m.group(1), m.group(2), m.group(3)
        if keyword == "export" and re.match(r"^\s*\*", clause):
            found.append({"spec": spec, "names": [], "source": source_rel})  # export * from pkg: existence only
            continue
        if keyword == "export":
            names = []
            brace = re.search(r"\{([^}]*)\}", clause)
            if brace:
                for item in brace.group(1).split(","):
                    item = item.strip()
                    if item:
                        names.append(item.split(" as ")[0].strip() if " as " in item else item)
            found.append({"spec": spec, "names": names, "source": source_rel})
            continue
        names, _package_only = parse_import_clause(clause)
        found.append({"spec": spec, "names": names, "source": source_rel})
    for regex in (SPEC_BARE_RE, SPEC_DYNAMIC_RE, SPEC_REQUIRE_RE):
        for m in regex.finditer(text):
            found.append({"spec": m.group(1), "names": [], "source": source_rel})
    return found


def split_spec(spec: str) -> tuple[str, str]:
    parts = spec.split("/")
    return parts[1] if len(parts) > 1 else "", "/".join(parts[2:])


def resolve_entry(pkg_dir: str, subpath: str) -> str | None:
    """Resolve the export-surface file for a package (sub)path. None = unresolvable."""
    def first_string(value):
        if isinstance(value, str):
            return value
        if isinstance(value, dict):
            for key in ("default", "import", "node", "require"):
                if key in value:
                    got = first_string(value[key])
                    if got:
                        return got
            for child in value.values():
                got = first_string(child)
                if got:
                    return got
        return None

    try:
        with open(os.path.join(pkg_dir, "package.json"), "r", encoding="utf-8") as f:
            pkg = json.load(f)
    except Exception:
        pkg = {}
    exports = pkg.get("exports")
    key = "." if subpath == "" else f"./{subpath}"
    candidates: list = []
    if isinstance(exports, dict) and key in exports:
        entry = first_string(exports[key])
        if entry:
            candidates.append(entry)
    elif isinstance(exports, (str, dict)) and subpath == "":
        entry = first_string(exports)
        if entry:
            candidates.append(entry)
    if subpath == "":
        if isinstance(pkg.get("main"), str):
            candidates.append(pkg["main"])
        candidates += ["lib/index.js", "index.js"]
    else:
        candidates += [f"{subpath}.js", f"{subpath}/index.js", f"lib/{subpath}.js"]
    for rel in candidates:
        path = os.path.normpath(os.path.join(pkg_dir, rel))
        if os.path.isfile(path):
            return path
    return None


def export_surface(entry_path: str) -> tuple[set, bool]:
    """→ (names, open). open=True when absence of a name is unprovable."""
    with open(entry_path, "r", encoding="utf-8") as f:
        text = strip_comments(f.read())
    names: set = set()
    is_open = bool(EXPORT_STAR_RE.search(text))
    for m in EXPORT_BRACE_RE.finditer(text):
        for item in m.group(1).split(","):
            item = item.strip()
            if not item:
                continue
            names.add(item.split(" as ")[1].strip() if " as " in item else item)
    for m in EXPORT_DECL_RE.finditer(text):
        names.add(m.group(1))
    if EXPORT_DEFAULT_RE.search(text):
        names.add("default")
    if not names and not is_open:
        is_open = True  # no recognizable ESM exports: UNKNOWN surface, disclosed skip
    return names, is_open


def scan(build_dir: str, host_dir: str) -> tuple[list, dict]:
    """→ (findings, stats). Findings non-empty = hallucinated symbols/packages."""
    lib_dir = os.path.join(build_dir, "lib")
    findings: list = []
    stats = {"files": 0, "packages": set(), "named_checked": 0, "open_skips": 0}
    imports: list = []
    for root, dirs, names in os.walk(lib_dir):
        dirs.sort()
        for name in sorted(names):
            if not name.endswith(".js"):
                continue
            path = os.path.join(root, name)
            rel = os.path.relpath(path, build_dir).replace(os.sep, "/")
            stats["files"] += 1
            with open(path, "r", encoding="utf-8") as f:
                imports.extend(extract_imports(f.read(), rel))

    surfaces: dict = {}
    for imp in imports:
        pkg, subpath = split_spec(imp["spec"])
        stats["packages"].add(pkg)
        pkg_dir = os.path.join(host_dir, pkg)
        if not (os.path.isdir(pkg_dir) and os.path.isfile(os.path.join(pkg_dir, "package.json"))):
            findings.append(
                f"HALLUCINATED package @deepseek-ai/{pkg} (imported by {imp['source']} as '{imp['spec']}') — "
                f"not installed under {host_dir}"
            )
            continue
        if not imp["names"]:
            continue
        cache_key = (pkg, subpath)
        if cache_key not in surfaces:
            entry = resolve_entry(pkg_dir, subpath)
            if entry is None:
                surfaces[cache_key] = None
            else:
                surfaces[cache_key] = (export_surface(entry), os.path.relpath(entry, host_dir))
        if surfaces[cache_key] is None:
            findings.append(
                f"HALLUCINATED subpath '{imp['spec']}' (imported by {imp['source']}) — package @deepseek-ai/{pkg} "
                f"exists but no exports-map entry or file resolves that subpath"
            )
            continue
        (names, is_open), entry_rel = surfaces[cache_key]
        for wanted in imp["names"]:
            if wanted in names:
                stats["named_checked"] += 1
            elif is_open:
                stats["open_skips"] += 1  # wildcard/unknown surface: absence unprovable, disclosed
            else:
                findings.append(
                    f"HALLUCINATED symbol '{wanted}' imported from '{imp['spec']}' by {imp['source']} — "
                    f"not in the export surface of {entry_rel} (closed surface, {len(names)} exports)"
                )
    return findings, stats


def main() -> int:
    args = sys.argv[1:]
    if args == ["--selftest"]:
        return run_selftest()
    opts = {"--build-dir": None, "--host-dir": DEFAULT_HOST_DIR}
    i = 0
    while i < len(args):
        if args[i] in opts and i + 1 < len(args):
            opts[args[i]] = args[i + 1]
            i += 2
        else:
            print(f"unknown/valueless argument: {args[i]}", file=sys.stderr)
            print("usage: scan_symbols.py --build-dir DIR [--host-dir DIR] | --selftest", file=sys.stderr)
            return 2
    if not opts["--build-dir"]:
        print("usage: scan_symbols.py --build-dir DIR [--host-dir DIR] | --selftest", file=sys.stderr)
        return 2
    if not os.path.isdir(os.path.join(opts["--build-dir"], "lib")):
        print(f"NOT A PLUGIN TREE: no lib/ under '{opts['--build-dir']}' — this gate is plugin-only", file=sys.stderr)
        return 2
    if not os.path.isdir(opts["--host-dir"]):
        print(f"HOST DIR MISSING: '{opts['--host-dir']}' — cannot compare against a host install that is not there", file=sys.stderr)
        return 2
    findings, stats = scan(opts["--build-dir"], opts["--host-dir"])
    if findings:
        print(f"FAIL: {len(findings)} hallucinated import(s):")
        for x in findings:
            print(f"  - {x}")
        return 1
    print(
        f"PASS: {stats['files']} lib file(s), {len(stats['packages'])} @deepseek-ai package(s) verified, "
        f"{stats['named_checked']} named import(s) proven, {stats['open_skips']} open-surface skip(s) (disclosed false-negative bound)"
    )
    return 0


# --------------------------------------------------------------------------
# --selftest fixtures
# --------------------------------------------------------------------------

def _write(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)


def _make_host(root: str) -> str:
    host = os.path.join(root, "host", "@deepseek-ai")
    _write(os.path.join(host, "dsh-tools", "package.json"), json.dumps({
        "name": "@deepseek-ai/dsh-tools", "main": "lib/index.js",
        "exports": {".": {"default": "./lib/index.js"}, "./invariant": {"default": "./lib/invariant.js"}},
    }))
    _write(os.path.join(host, "dsh-tools", "lib", "index.js"),
           "const defineTool = 1; class ToolRuntime {}\n"
           "export { defineTool, ToolRuntime, ToolRuntime as default };\n")
    _write(os.path.join(host, "dsh-tools", "lib", "invariant.js"),
           "export function invariant(x) { return x; }\n")
    _write(os.path.join(host, "schemastery", "package.json"), json.dumps({
        "name": "@deepseek-ai/schemastery", "main": "lib/index.js"}))
    _write(os.path.join(host, "schemastery", "lib", "index.js"),
           "function Schema() {}\nexport default Schema;\nexport const from = 1;\n")
    _write(os.path.join(host, "dsh-bundled", "package.json"), json.dumps({
        "name": "@deepseek-ai/dsh-bundled", "main": "lib/index.js"}))
    _write(os.path.join(host, "dsh-bundled", "lib", "index.js"),
           "export * from './impl.js';\n")
    return host


def _make_build(root: str, name: str, lib_files: dict) -> str:
    build = os.path.join(root, name)
    for rel, content in lib_files.items():
        _write(os.path.join(build, rel), content)
    return build


def run_selftest() -> int:
    ok = True

    def fail(msg):
        nonlocal ok
        ok = False
        print(f"SELFTEST FAIL: {msg}")

    with tempfile.TemporaryDirectory() as tmp:
        host = _make_host(tmp)

        # ---- green: real packages, real named/default/aliased/subpath imports
        build = _make_build(tmp, "green", {
            "lib/index.js": (
                "// wiring — https://example.com/docs stays intact under comment stripping\n"
                "import { defineTool, ToolRuntime as RT } from '@deepseek-ai/dsh-tools';\n"
                "import Schema from '@deepseek-ai/schemastery';\n"
                "import { invariant } from '@deepseek-ai/dsh-tools/invariant';\n"
                "import * as bundled from '@deepseek-ai/dsh-bundled';\n"
                "export const apply = () => [defineTool, RT, Schema, invariant, bundled];\n"),
            "lib/pure.js": "export const pure = 1; // zero @deepseek-ai imports\n",
        })
        findings, stats = scan(build, host)
        if findings:
            fail(f"green fixture flagged: {findings}")
        elif stats["named_checked"] < 4:
            fail(f"green fixture verified too few named imports: {stats}")
        else:
            print(f"selftest: green fixture ok ({stats['named_checked']} named imports proven, 0 findings)")

        # ---- sanity pass: open surface (export *) — unknown name is a
        # DISCLOSED skip, never an accusation (documented false negative)
        build = _make_build(tmp, "open-surface", {
            "lib/index.js": "import { whoKnows } from '@deepseek-ai/dsh-bundled';\nexport const x = whoKnows;\n",
        })
        findings, stats = scan(build, host)
        if findings or stats["open_skips"] != 1:
            fail(f"open-surface sanity pass wrong: findings={findings} stats={stats}")
        else:
            print("selftest: sanity-pass open surface (export *) skips disclosed, no false accusation")

        traps = [
            ("hallucinated package (slopsquatting)", {
                "lib/index.js": "import { anything } from '@deepseek-ai/dsh-imaginary-helper';\n",
            }, "HALLUCINATED package @deepseek-ai/dsh-imaginary-helper"),
            ("hallucinated named import from a closed surface", {
                "lib/index.js": "import { defineTool, summonDemon } from '@deepseek-ai/dsh-tools';\n",
            }, "HALLUCINATED symbol 'summonDemon'"),
            ("aliased hallucination: external name is checked, not the alias", {
                "lib/index.js": "import { ghostExport as fine } from '@deepseek-ai/dsh-tools';\n",
            }, "HALLUCINATED symbol 'ghostExport'"),
            ("default import from a package with no default export", {
                "lib/index.js": "import Tools from '@deepseek-ai/dsh-tools/invariant';\n",
            }, "HALLUCINATED symbol 'default'"),
            ("hallucinated subpath on a real package", {
                "lib/index.js": "import { x } from '@deepseek-ai/dsh-tools/quantum';\n",
            }, "HALLUCINATED subpath '@deepseek-ai/dsh-tools/quantum'"),
            ("re-export of a hallucinated name (export-from direction)", {
                "lib/index.js": "export { vaporFn } from '@deepseek-ai/dsh-tools';\n",
            }, "HALLUCINATED symbol 'vaporFn'"),
        ]
        caught = 0
        for idx, (name, lib_files, needle) in enumerate(traps):
            build = _make_build(tmp, f"trap{idx}", lib_files)
            findings, _stats = scan(build, host)
            if findings and any(needle in x for x in findings):
                caught += 1
            else:
                fail(f"trap '{name}' was NOT caught (findings={findings})")

    print(f"selftest: 1 green ok, {caught}/{len(traps)} traps caught")
    return 0 if ok and caught == len(traps) else 1


if __name__ == "__main__":
    sys.exit(main())

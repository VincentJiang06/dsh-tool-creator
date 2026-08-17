#!/usr/bin/env node
/**
 * dsh-forge single-source build: src/ → dist/{preset/, profile-patch.yml,
 * install.sh, hashes.json}. Deterministic: sorted walks, no timestamps in
 * output. The charter exists ONCE (src/preset/charter.md) and is injected
 * into both planes — the web preset persona and the headless profile patch —
 * killing the two-plane drift hazard by construction.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('.', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const PRESET = join(DIST, 'preset');
const PRESET_ID = 'forge';

rmSync(DIST, { recursive: true, force: true });
mkdirSync(PRESET, { recursive: true });

// ---- charter: one source, two planes --------------------------------------
const charter = readFileSync(join(SRC, 'preset/charter.md'), 'utf8').trimEnd();
const indented = charter.split('\n').map((l) => (l.length ? `      ${l}` : '')).join('\n');

// ---- web plane: the preset directory --------------------------------------
const tmpl = readFileSync(join(SRC, 'preset/agent.cordis.tmpl.yml'), 'utf8');
if (!tmpl.includes('{{CHARTER_INDENTED}}')) throw new Error('template lost its charter marker');
writeFileSync(join(PRESET, 'agent.cordis.yml'), tmpl.replace('{{CHARTER_INDENTED}}', indented));
cpSync(join(SRC, 'preset/preset.yml'), join(PRESET, 'preset.yml'));
for (const dir of ['manifest', 'roles', 'targets', 'schemas', 'validators', 'references']) {
  cpSync(join(SRC, dir), join(PRESET, dir), { recursive: true });
}

// ---- headless plane: profile patch from the SAME charter ------------------
const patchPersona = charter.split('\n').map((l) => (l.length ? `      ${l}` : '')).join('\n');
writeFileSync(join(DIST, 'profile-patch.yml'), `# dsh-forge headless/terminal variant — GENERATED from the same charter as
# the web preset (single source; do not hand-edit). Apply as a profile patch
# layer: terminal sessions cannot join agent presets, so this approximates
# the forge composition at the profile level. Web sessions should use the
# real preset instead.
- id: agent-default-model
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
- id: system-prompt
  config:
    complete: true
    includeRuntimeContext: false
    persona: |-
${patchPersona}
# The Claude-marketplace bundle registers global-layer cc_* tools and skills
# that leak into every scope, including forge role subagents; forge runs
# disable it (DECISION D5).
- id: claude-marketplace
  disabled: true
`);

// ---- integrity manifest ---------------------------------------------------
const hashes = {};
const walk = (dir) => {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else hashes[relative(PRESET, p)] = `sha256:${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
  }
};
walk(PRESET);
writeFileSync(join(DIST, 'hashes.json'), `${JSON.stringify(hashes, null, 2)}\n`);

// ---- installer ------------------------------------------------------------
writeFileSync(join(DIST, 'install.sh'), `#!/usr/bin/env bash
# dsh-forge installer — copies the preset into the user preset root and
# verifies every file hash. --verify-only checks dist/ integrity without
# installing. GENERATED; source of truth is the dsh-forge repo.
set -euo pipefail
HERE="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
DEST="\${DSH_HOME:-$HOME/.dsh}/.agent-presets/${PRESET_ID}"

verify() { # $1 = base dir to verify against hashes.json
  python3 - "$1" "$HERE/hashes.json" <<'PY'
import hashlib, json, sys, pathlib
base, manifest = pathlib.Path(sys.argv[1]), json.loads(pathlib.Path(sys.argv[2]).read_text())
bad = [rel for rel, want in manifest.items()
       if not (base / rel).is_file()
       or f"sha256:{hashlib.sha256((base / rel).read_bytes()).hexdigest()}" != want]
if bad:
    print("HASH MISMATCH:", *bad, sep="\\n  "); sys.exit(1)
print(f"verified {len(manifest)} files OK")
PY
}

verify "$HERE/preset"
[ "\${1:-}" = "--verify-only" ] && exit 0

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$HERE/preset" "$DEST"
verify "$DEST"
echo "installed preset '${PRESET_ID}' -> $DEST (select it from the dsh web preset picker; terminal runs use profile-patch.yml)"
`);
chmodSync(join(DIST, 'install.sh'), 0o755);

console.log(`built dist/: preset (${Object.keys(hashes).length} files hashed), profile-patch.yml, install.sh`);

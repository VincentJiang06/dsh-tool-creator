# The acceptance manifest — evidence that travels with the artifact

Every artifact this pipeline ships (skill / plugin / preset) carries an
`acceptance-manifest.json` at its root: a machine-readable record of what was
verified at creation time, pinned to exact bytes and exact versions, with the
deterministic slice of that verification **re-runnable by anyone who holds the
directory** — an installer, a marketplace, a directory like dsh-suite, or a user
three rc-versions later. Schema: `src/schemas/acceptance-manifest.json`
(normative; a byte-identical copy is embedded in the verifier and drift-tested).
This is the open-standard slot no ecosystem fills today (RESEARCH-LANDSCAPE §(b).3):
creators that verify at all discard the evidence at packaging time.

## What is in it

- `artifact` — name/kind/version, a sha256 per file, and a `rootHash` over the
  sorted file-hash list (`shasum -a 256` line format, so coreutils can check it too).
- `provenance` — pipeline + version, creation time, pinned dsh version, pinned
  model (`provider`/`id`), the sha256 of the executor's `evidence-ledger.jsonl`,
  and the child session ids. The ledger is written mechanically by
  `dsh-pipeline-executor` from disk bytes — never model-transcribed.
- `verdicts` — `reAudit`, `battery`, the min-folded `effective`
  (battery caps: clean→industrial, not_run→candidate, breaches_found→candidate —
  aligned with the pipeline's validate_decision gate; F7 fix 2026-08-18),
  and P1/P2/P3 finding counts.
- `reverify` — the re-runnable commands (argv arrays, expected exit codes), the
  harness path (the target's `evals/run_harness.sh` per `targets/*/BUILD.md`),
  and optionally a regex the harness summary must match.
- `baselineDelta` — measured pass rate vs the no-artifact baseline, or an honest
  `measured: false` with a reason. N/a-with-reason is legal; a fabricated rate is not.
- `limits` — plain-language verification limits (e.g. "preset E-L4 not_run:
  mount guards not observed outside a live host").

## The re-verify contract

`node tools/reverify.mjs <artifact-dir>` (or `--manifest <path>`; flags
`--skip-commands` for hash-only, `--json` for machine output). Zero
dependencies, node ≥ 20. It runs three fail-closed phases:

1. **Shape** — the manifest must validate against the schema, plus semantic
   rules (unique command ids, non-empty argv, cwd contained in the artifact
   root, the baselineDelta honesty rule) and the verdict min-fold. A manifest
   that fails here gets nothing else evaluated.
2. **Bytes** — every listed file is re-hashed; files on disk but not in the
   manifest are failures (tamper-by-addition); symlinks are illegal; the
   `rootHash` is recomputed. If any byte check fails, **commands are refused**:
   the verifier never executes bytes the manifest did not pin.
3. **Commands** — each `reverify.commands[]` entry runs via `execFile` argv (no
   shell) with a 120 s default timeout, in a minimal environment
   (`TMPDIR`/`REVERIFY_TMP` point at scratch), comparing exit codes; then the
   tree is re-hashed and must be byte-identical (`tree-unchanged`) — commands
   are required to be deterministic, offline, and side-effect-free inside the
   artifact tree. A command marked `requiresKit` (the `validate-dossier` /
   `validate-structure` pipeline-kit re-checks) or `requiresWorkspace` (a
   preset's workspace-anchored harness, stepped up out of the shipped tree) is
   **SKIPPED with a disclosed reason** when its entrypoint is not present in the
   installed tree — this is an honest skip, *not* a failure: on a bare/installed
   artifact those entrypoints legitimately do not ship (the kit "never leaves the
   factory"; a preset harness is not shipped inside the preset). The skip is
   gated on entrypoint **absence**, never on the flag alone, so a genuinely
   missing in-tree harness still FAILs (that is tampering). Run reverify from the
   creation workspace — where the kit is staged and the harness resolves — for
   the full command re-proof.

Exit 0 iff every evaluated check passes (a disclosed SKIP is not a failure). Output is a check table
(`schema-shape`, `hash:<path>`, `root-hash`, `unlisted-files`, `harness-path`,
`cmd:<id>`, `summary-regex`, `tree-unchanged`) — one row per named failure mode.

## What a directory can do with it

Today a directory row says "verified on rc.6" — a claim about the past, on
someone else's machine. With the manifest, dsh-suite (or any installer) can run
one command per listed artifact on **its** host, against **its** rc, and publish
"re-proved on rc.7, 2026-08-17, all checks green" — or the exact check that
broke, per artifact, when an rc-train host drifts. On a **bare/installed** tree
the re-proof is the full HASH phase (byte-exact integrity) plus every in-tree
command; the `requiresKit`/`requiresWorkspace` commands report a disclosed SKIP
(not RED) because their entrypoints legitimately do not ship — so a holder gets
an honest green, not a false failure. For the complete command re-proof
(including the pipeline-kit re-checks) reverify runs from the **creation
workspace**. Install-time, the same command turns "we copied the files" into
"we re-proved the artifact's bytes and in-tree battery still pass before
enabling it". Hash-only mode (`--skip-commands`) gives integrity checking for
free where executing anything is unacceptable.

## Ledger-pin semantics

`provenance.evidenceLedgerSha256` pins the ledger AS OF assembly time — the
battery attempt that runs the assembly gate appends its own ledger line AFTER
the manifest is written, so the pin covers every line except the assembling
attempt's own. This is mechanically consistent (the assembler cannot hash a
line that does not exist yet) and disclosed here rather than papered over.

## Honest limits

- Re-running the commands proves the artifact still passes **its own
  deterministic battery on this host**. It does not re-run the live-model
  layers (trigger precision, baseline delta, adversarial battery): those were
  measured once at creation, and travel as hash-pinned evidence
  (`evidenceLedgerSha256`, `sessionIds`), not as replayable commands.
- Layers a target cannot verify offline (e.g. a preset's E-L4 real mount) ship
  as `not_run` in the creation evidence and are named in `limits[]`. A green
  verdict nobody ran would be fabricated; the standard prefers a truthful gap.
- The standard *requires* commands to be offline and deterministic, but the
  verifier does not sandbox — it enforces what it can mechanically (no shell,
  pinned bytes only, exit codes, unchanged tree) and leaves network isolation
  to the host. A manifest is evidence, not a signature: it proves consistency
  with what the creator recorded, not who the creator was.
- **Adjudication mode travels in `limits[]`.** A headless run has no human in
  the loop: every gate is machine-adjudicated and the O-series human veto is
  reserved-but-not-exercised. The manifest discloses this (a standing
  machine-adjudication limit) alongside the battery mode — its independence tier
  and the fact that the SEED anti-false-negative gate is persona-instruction to
  the attacker lenses, not executor-enforced. The one mechanical floor on the
  battery verdict is the breach-grade check: P1/P2 lens findings force
  `breaches_found`, and a `clean`/`not_run` verdict written over counted P1/P2
  findings is **refused at assembly** (a `clean` cap is `industrial`, so this is
  the guard that stops a top-grade verdict shipping over real breaches). What it
  does *not* do is force a hollow battery to find defects it didn't look for —
  hence the disclosure: a `clean` verdict rests on the lenses' diligence, and a
  consumer reading `effective=industrial` can see, in `limits[]`, that no human
  adjudicated it.

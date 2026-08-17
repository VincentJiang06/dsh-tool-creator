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
  (battery caps: clean→industrial, not_run→candidate, breaches_found→draft),
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
   artifact tree.

Exit 0 iff every evaluated check passes. Output is a check table
(`schema-shape`, `hash:<path>`, `root-hash`, `unlisted-files`, `harness-path`,
`cmd:<id>`, `summary-regex`, `tree-unchanged`) — one row per named failure mode.

## What a directory can do with it

Today a directory row says "verified on rc.6" — a claim about the past, on
someone else's machine. With the manifest, dsh-suite (or any installer) can run
one command per listed artifact on **its** host, against **its** rc, and publish
"re-proved on rc.7, 2026-08-17, all checks green" — or the exact check that
broke, per artifact, when an rc-train host drifts. Install-time, the same
command turns "we copied the files" into "we re-proved the artifact still
passes its own battery before enabling it". Hash-only mode gives integrity
checking for free where executing anything is unacceptable.

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

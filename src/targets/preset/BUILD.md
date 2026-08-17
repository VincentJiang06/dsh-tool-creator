# Target pack: `preset` — build a real dsh agent preset, and verify it like one

You are reading this because your dispatch prompt named this file as the BUILD CONVENTION for the
current run's build target. It is authoritative for **what the artifact IS, where its files go, and
what the harness is**. It is not a role charter and it does not compete with one: your role pack
(`vendor/roles/engineer.md`) still owns the judgment — red-first, layered evidence, evaluator
calibration, pre-registered stops. Where this pack and the Structure Contract disagree about a
path, the CONTRACT wins and the disagreement is a FINDING you report; where this pack and your role
pack appear to disagree about discipline, your role pack wins.

A dsh agent preset is **an agent-plane Cordis composition directory**. Not a profile, not a plugin,
not a config file: a directory whose NAME is its id, holding an `agent.cordis.yml` the roster
mounts ONCE per process as a standing scope — every session naming the preset joins that one mount
by scope parentage. The references this pack is modeled on are the shipped presets under the
harness install's `dsh/config/agent-presets/`: `standard` (the row-policy reference — §4 is its
table) and `cordis` (the preset-local-skills convention — §3.1 quotes it). Every convention below
is those files' convention; quote them, don't invent.

`<WS>` below is the workspace root your prompt gave you; `<WS>/build` is the build directory.
Nothing you write ever leaves `<WS>/build` and `<WS>/artifacts`.

---

## 1. The artifact tree

Unlike the sibling targets, the artifact here is THREE pieces, and only one of them installs. The
install channel is whole-directory copy (§3.4), so the install unit lives one level down: anything
at the preset root ships to every user's `$DSH_HOME`, and the harness, installer and headless
variant must not.

```
<WS>/build/
  preset/                          the INSTALL UNIT — exactly what lands in $DSH_HOME/.agent-presets/<id>/
    agent.cordis.yml               REQUIRED. the composition — the only load-bearing file (§3.1)
    preset.yml                     REQUIRED. display metadata ONLY: name, description, order (§3.2)
    skills/<name>/SKILL.md         preset-local skills, when the contract commissions them (§3.1)
    <assets>/                      everything a row references by relative path — travels with the copy
  headless.patch.yml               REQUIRED companion. the terminal-session variant (§3.3)
  install.sh                       REQUIRED companion. copy + hash-verify installer (§3.4)
  manifest.sha256                  REQUIRED. content hashes of every file under preset/ (§3.4)
  README.md                        REQUIRED. install, select, verify, limits
  evals/run_harness.sh             REQUIRED. THE harness (§6)
  evals/cases.json                 REQUIRED. the case index (§6)
  evals/checks/<name>.py           the offline checkers the harness dispatches (§6)
  fixtures/<class>/<case>.input.yml        REQUIRED. one broken or edge composition per case
  fixtures/<class>/<case>.expected.json    REQUIRED. its pinned checker verdict, beside it
  evals/red/<name>.log             REQUIRED. red-light output, captured before green exists
```

Every Structure Contract `content_ref` that contains a slash and a file extension must exist here
on disk when you return; the conductor re-runs the structure gate fail-closed.

---

## 2. The mount seam — the single most load-bearing fact of this target

A preset is graded by a machine you cannot run: `dsh-agent-presets` applies its guards when the
roster MOUNTS the composition into a live host, and no offline gate loads a composition. Every
invariant below is therefore carried as a written rule, because the alternative is discovering it
as a mount rejection in a real deployment. Follow every rule literally. Line references are to the
harness install's `@deepseek-ai/` packages.

### 2.1 Mount-guard invariants dsh enforces (these CANNOT be caught offline)

**Invariant 1 — a row that PROVIDES a service must sit inside a group carrying an `isolate`
realm.** At mount, `leakedServices()` walks the subtree; any service published into the root realm
rejects the WHOLE preset with: `row(s) published process-global service(s) [...]; a preset service
must sit behind an `isolate` realm or move to the host composition`
(`dsh-agent-presets/lib/index.js:722-723`). `isolate: true` means an entry-local realm — this
standing mount's own private instance. A shared label does NOT pool instances: `provide()` throws
on the second registration under the same realm symbol (standard preset header, lines 11-18).
Rows that only register into layered registries (tools, prompt sections, skills) need no realm.
Shipped precedents for what DOES: `{planMode}`, `{compaction, toolResultPruner}` (compaction-basic
reads the pruner via `ctx.get`, so both share one realm), `{workflowEngine}`, and minimal's
`{terminals}` and `{fs}`.

**Invariant 2 — every enabled row must activate.** A row waiting on a service the composition
never supplies fails the whole mount: `N row(s) did not activate:` with one line per row naming
the missing injection (`inactiveRows`, `:662-678`, thrown at `:721`). The classic trigger is
copying a host-plane row into the preset — its dependency lives outside any realm the preset can
see.

**Invariant 3 — host-plane-only rows never move into a preset.** These collide or go dead when
preset-mounted; the list is assembled from the shipped presets' own section comments: `shell-env`;
the background-jobs REGISTRY; the `goals` service, its session driver and the `/goal` command; the
`subagents` registry and every provider (spawn/fork/product); `tool-subagent-report` (its
continuable setup list is not scope-aware — "one copy per mounted preset means every child gets
`report` registered once per live session, which throws on the second", standard preset delegation
comment); `tokenMeter`; the `skills` registry itself; the `web` service and its search provider;
the entire sandbox/approval/persistence/model-route stack. A preset holds MODEL-FACING tool rows
plus persona and prompt sections — nothing else.

**Invariant 4 — the id is the directory name, and the namespace is booby-trapped.** It must match
`^[a-z0-9][a-z0-9-]*$` (`PRESET_ID`, `:101`). A directory whose composition is missing or
unparsable is not skipped — it becomes a BROKEN roster row that still occupies its id. And roots
resolve first-wins with the user root appended LAST: "a shipped preset still shadows a locally
authored directory that claimed its name" (`:818-825`). An id of `standard`, `code`, `minimal` or
`cordis` produces a preset that installs cleanly and is invisible forever.

**Invariant 5 — three resolution rules, one per path shape.** A bare specifier in a row's `name`
resolves from the HARNESS install, never from the preset directory (`PresetTree.import`,
`:495-506`) — name only packages that exist there. A relative path resolves from the preset
directory and travels with the copy. An absolute path becomes a file URL — and breaks on the first
copy to another machine, so it never appears. Also: `PresetTree.write()` is a no-op — the loader
never persists tree state back into a preset file; do not design anything that expects it to.

**Invariant 6 — `persona` with `complete: true` becomes the SOLE prompt section.** The assembly
waterfall restores an effective complete section as the only section afterwards
(`dsh-system-prompt/lib/index.js` assemble contract), which suppresses every tool-guidance section
(workflow's order 115, continuable-subagent's 116.5, structured_output's 190) and the deployment's
web-surface sections; `includeRuntimeContext: false` additionally drops the runtime snapshot. Tool
DESCRIPTIONS are unaffected — they travel in the schemas. Use `complete: true` only when the
charter deliberately absorbs all tool guidance, and say so in a comment beside it.

**Invariant 7 — standing mount, once per process; the composition is read once per generation.**
Row plugins must key session state per Session/Agent themselves — one instance serves every joined
session (`:771-785`). The mount records an mtime+size stamp of `agent.cordis.yml` ONLY: editing
the composition affects sessions created AFTERWARDS; live sessions keep their generation for life
(`:926-933`). Other files in the directory (skills, manifests, role packs) are re-read on next
use. install.sh and the README must state this, or the first post-edit session becomes a bug
report.

**Invariant 8 — a session's preset locks at the first turn.** Switching is allowed only while the
session log is blank; afterwards the API answers `agent-preset-locked` ("its agent preset is
fixed"), and resuming a session under a different preset name throws `AgentPresetConflict`: "A
session's preset is fixed at creation" (`dsh-host-apiproxy/lib/index.js:3339`, `:1640`). Nothing
you ship can migrate an existing session; never promise it.

**Verify before you claim done.** You cannot mount a preset from inside the sandbox, so there is
no evidence available to you that these invariants hold. Therefore: (a) follow the rules above
literally rather than reasoning about whether a given shape "should" work, and (b) record `E-L4`
as `not_run` in the dossier with the reason — exactly as §7's row requires. A green `E-L4` you did
not observe is a fabricated verdict, and these invariants are precisely the failures such a green
would hide.

---

## 3. Required files

### 3.1 `agent.cordis.yml`

A YAML LIST of row entries — `- id: <row-id>` / `name: '<package>'` / optional `config:`,
`disabled:`, and `cordis:group` group rows carrying `group: true` + `isolate:`. The dialect admits
`!!js` expression tags (the shipped presets gate rows on `process.platform` with it); your parser
in §6 must accept the tag without executing it.

Conventions, all from the shipped files:

- **Comment discipline**: every section carries a comment stating which plane owns what and WHY a
  row is here, absent, or disabled. The standard preset's comments are the register to match — a
  row policy without its reason is the first thing the next author breaks.
- **Preset-local skills** (when commissioned): the cordis preset's convention exactly — a
  `skill-filesystem` row with
  `customSkillDirs: [!!js "process.getBuiltinModule('node:url').fileURLToPath(new URL('skills/', baseUrl))"]`
  plus a `tool-skill` row. `baseUrl` is the preset's own directory, so the root resolves wherever
  the copy lands. Both rows register into this preset's LAYER of the host skill registry — no
  realm. A `tool-skill` row over an empty or absent `skills/` renders a "no skills" catalog:
  ship both rows or neither.
- **Charter injection**: the persona row's `text` is the agent's identity. `{{model}}` and
  `{{cwd}}` resolve from the agent's own route and workspace. See Invariant 6 before reaching for
  `complete: true`.

### 3.2 `preset.yml`

Display metadata ONLY: `name`, `description`, `order`. `id` and `trust` are NOT writable here —
id comes from the directory name, trust from the discovered root. Nothing load-bearing may live in
this file: the host's own copy operation rewrites it, keeping `description` but dropping `name`
and `order` (`copyComposition`, `dsh-agent-presets/lib/index.js:396-405`). A behavior note that
only exists in `preset.yml` does not survive duplication.

### 3.3 `headless.patch.yml` — the terminal-session companion

Terminal one-shot runs (`dsh --profile headless "task"`) have NO preset concept at all: the
headless bundle composes no `agent-presets` row, the runner's agent setup installs only the model
selection and never calls `presets.mount`/`composeFrom` (`dsh-headless/lib/index.js:70-83`), and
the CLI has no preset flag or verb. Even hand-patching an `agent-presets` row in changes nothing —
the agent is simply published with a "published without joining an agent preset" warning
(`dsh-agent-presets/lib/index.js:866`). The ONLY way to give a terminal session this preset's
toolface is the patch layer, not the preset mechanism.

So the target commissions a companion: a Cordis patch document expressing the same row policy as
host-plane edits (disable rows the preset drops, insert what it adds) that a user applies to their
headless profile's patch layer. How a given deployment wires patch layers in is out of scope —
the README says "apply to your headless profile patches" and stops there. The two documents WILL
drift; the harness pins the overlap (§6).

### 3.4 `install.sh` + `manifest.sha256` — because distribution is copy-only

There is no other channel. The CLI force-overrides the roster's roots to the shipped install —
whenever the composed tree has an `agent-presets` row, an overlay replaces `roots` wholesale with
the shipped root, keeping only `default` and `includeUserRoot` (`dsh/lib/profile-boot-*.js`
overlay); plugins cannot add roots or a second roster (root-realm service-name collision); the
copy API accepts only ids already on the roster, never composition text; there is no CLI verb.
The single third-party landing point is `$DSH_HOME/.agent-presets/<id>/`, and the deployment's own
comment prices it: authoring there "carries the same trust as shell access because a preset IS a
composition" (`dsh-web-app/cordis.patch.yml:410-414`).

`install.sh` therefore: (1) resolves `DEST="${DSH_HOME:-$HOME/.dsh}/.agent-presets/<id>"`;
(2) refuses an existing DEST unless `-f`; (3) copies `preset/` recursively, dereferencing
symlinks; (4) re-verifies every file against `manifest.sha256` AFTER the copy and deletes DEST on
mismatch; (5) tightens modes the way the host's own copy does — directories 0700, files 0600
preserving owner-execute; (6) prints: which id was installed, that only NEW sessions see it
(Invariant 7), and that it is selectable from Web sessions only (§3.3). `manifest.sha256` is
generated over every file under `preset/` and shipped beside the installer, not inside the preset.

---

## 4. Row policy relative to `standard` — the keep/drop table you must fill

Under the web profile the host composition DISABLES the model-facing rows and lets the preset
decide: a capability the preset does not carry does not exist for its sessions. So the composition
is written by decision, not by copy: for every `standard` row, KEEP or DROP, with the cost in a
comment. The table below is what each row buys; the shipped file is the authority for config.

| `standard` row | what it does | dropping it costs |
|---|---|---|
| `persona` | the agent's identity section | deployment default persona speaks instead |
| `agent-instructions` | AGENTS.md ingestion (64KB cap) | project instructions never reach the agent |
| `tool-bash` / `tool-pwsh` | shell (platform-gated pair — keep both gates) | no shell at all |
| `tool-fs`, `tool-fs-search` | file read/write/edit, search | no file access |
| `tool-jobs` | collect/stop background jobs (registry stays host-plane) | background work runs but can never be collected |
| `skill-filesystem`, `tool-skill` | local skill roots + catalog/loader | no skill catalog for this agent |
| `tool-goal` | the goal tool (service stays host-plane) | no goals |
| `planning` group | plan mode (`isolate: {planMode}`) | no plan mode |
| `compaction` group | auto-compaction, `/compact`, tool-result pruning (`isolate: {compaction, toolResultPruner}`) | NO context survival: overflow hits `agent/request-error` with no one to catch it |
| `delegation` group | subagent tools + workflow engine (`isolate: {workflowEngine}`) | no delegation of any kind |
| `tool-subagent` rows' `config.agentOptions` | per-tool-row model pinning for children | children inherit the parent's route |
| `tool-ralph` | autonomous multi-round loop | nothing, unless the charter uses it — see §5.2 |
| `tool-ask-user`, `tool-todo` | user questions, todo list | no interactive clarification / no todo state |
| `tool-web` | web search (`fetch: false` in the shipped config) | no web access |

Two rows are traps, not choices: the disabled `tool-subagent-codex`/`-claude-code` rows exist to
be enabled in a COPY (their comment says so), and `tool-subagent-report` is not in the preset at
all — Invariant 3.

---

## 5. Counterexamples — a shipped preset got each of these wrong

Each rule below was extracted from the audit of a real, mounted, working preset (the forge
pipeline's own predecessor). None of them failed the mount; all of them were wrong. That is the
class of defect this section exists for: legal compositions that lie.

**5.1 A preset cannot subtract from the global layer.** The shipped preset set
`includeDefaultRoots: false` on its `skill-filesystem` row with a comment claiming it kept
marketplace content out. False security: third-party host-plane bundle rows (the `cc_*` tools)
are global-layer — their tools stay in every preset's catalog, and skills they register land in
the global layer every scope sees. A preset only ADDS. The rule: never write a comment claiming a
preset removed a host capability; real mitigation is the companion patch (§3.3) disabling the row
host-side, plus an explicit charter ban — ship both, and name the residual risk in the README.

**5.2 Every row is an affordance; delete what the charter forbids.** The shipped preset carried
`tool-ralph` while its charter demanded a deterministic stage-stepper that never uses it. A row
present in the catalog is an invitation the model may accept under pressure; prose prohibitions
lose to schemas. The rule: the composition and the charter must agree — a tool the charter forbids
is a row you delete, and §6's checker cross-references the two.

**5.3 Dropping compaction is a measurement, not a default.** The shipped preset excluded the
compaction group on determinism grounds, leaving a five-stage retrying conductor with no
compaction AND no tool-result pruner — context overflow would surface as a hard request error
mid-run. The rule: dropping the compaction group requires a stated context budget in the row
comment (expected turns × expected result sizes vs the window); absent that arithmetic, keep it.

**5.4 Workflow children inherit the preset's ENTIRE toolface.** Workflow scripts cannot pass
`toolFilter` or `persona` to `agent()` — the host does not forward them — so every workflow child
sees every tool the preset mounts, including the delegation tools themselves. The shipped preset's
role confinement was prose-only. The rule: size the toolface for the LEAST trusted agent that will
inherit it; when real confinement matters, dispatch through a `tool-subagent` row (whose config
does carry `persona`/`toolFilter`) instead of the workflow engine, or thin the preset.

---

## 6. The evaluation harness

**The harness is `<WS>/build/evals/run_harness.sh`.** It runs from `<WS>/build`, is deterministic,
offline, self-contained, finishes well inside 120 seconds, and exits `0` iff every required case
passed, printing one line per layer with `passed/total` plus case id, expected and produced for
each failure. Record `verification.harness_path = "evals/run_harness.sh"` — the gate resolves it
as a FILE relative to `<WS>/build` and re-runs it; a second run that disagrees with your recorded
exit code fails the stage.

What IS offline-verifiable, as checkers under `evals/checks/` (python3 + grep; no dsh boot):

1. **Dialect parse**: both YAML documents parse under a loader that maps the `!!js` tag to an
   inert string (`add_constructor('tag:yaml.org,2002:js', ...)` on a SafeLoader subclass); the
   composition is a list; every entry has `id` and `name`; group rows carry `group: true`.
2. **Realm allowlist**: every row whose package appears in the checker's pinned
   service-providing list (from the Structure Contract) sits inside a group carrying `isolate`.
   State honestly in the checker: this is an allowlist heuristic, not `leakedServices` — only a
   mount runs the real guard.
3. **Resolution**: every bare `@deepseek-ai/*` (or other bare) row name exists as a directory
   under `INSTALL="${DSH_INSTALL:-$HOME/.dsh/profiles/node_modules}"`; every relative path and
   every `baseUrl`-anchored directory named in a config exists under `preset/`.
4. **Metadata**: `preset.yml` keys ⊆ {name, description, order}; an `id` or `trust` key fails;
   the install id in `install.sh` matches `PRESET_ID` regex and is none of the four shipped ids.
5. **Companions**: `bash -n install.sh`; `headless.patch.yml` parses; the charter/composition
   cross-reference of §5.2 (no charter-forbidden tool has a live row, no charter-referenced tool
   lacks one); `(cd preset && shasum -a 256 -c ../manifest.sha256)` is green.
6. **Hygiene greps**: no absolute paths in the composition; no key-shaped strings
   (`sk-`, `AKIA`, `ghp_`, `-----BEGIN`) anywhere under `preset/`.

The **fixtures** are how the checkers themselves are proven: each `fixtures/<class>/<case>.input.yml`
is a deliberately broken or edge composition, and `<case>.expected.json` pins the verdict the
checker must produce for it. The harness replays every fixture through the checkers AND runs the
checkers over the real `preset/` — a checker that passes a broken fixture is itself the red light.
Failure classes at minimum: `leaked-service` (service row outside any isolate group, including one
nested inside a non-isolate group), `dangling-name` (row package absent from the install),
`missing-asset` (relative path to nowhere), `bad-metadata` (`id:` in preset.yml), `id-collision`
(shipped id), `secret` (a key-shaped string in a config), `charter-drift` (row present that the
charter text bans). `evals/cases.json` indexes them with the sibling packs' exact entry shape
(`id`, `layer`, `eval_kind`, `failure_class`, `spec_source`, `input`, `expected`, `compare`);
`spec_source` points at the upstream SkillSpec field or the string `brainstormed`. Red logs live
in `evals/red/`, non-empty, with paths recorded in `red_light_history.red_artifact_path`.

What CANNOT be verified offline: an actual mount (the `leakedServices` and `inactiveRows` guards
exist only in a live host), standing-mount statefulness, generation/stamp behavior, persona
assembly, the session lock, and everything in §2.1 as observed fact. That is `E-L4`, and it is
recorded `not_run` — §7.

---

## 7. Layer mapping for this target

| layer | what it is for a preset target |
|---|---|
| `E-L0` | syntax and shape: both YAML documents parse under the `!!js` dialect, id regex holds, `preset.yml` keys are the legal subset, `bash -n install.sh` is green, manifest verifies |
| `E-L1` | single-check semantics: one fixture composition in, its pinned checker verdict out |
| `E-L2` | one checker in isolation over the real `preset/`: realm allowlist, resolution against the install, relative-path existence, charter cross-reference |
| `E-L3` | under pressure: adversarial fixtures — a service row buried in a nested non-isolate group, a name that exists on disk but not in the install, a shipped-id collision, a comment CLAIMING a subtraction (§5.1), a key-shaped string in a config |
| `E-L4` | a real mount. It CANNOT be run outside a live dsh host. Assert what is assertable offline — every §6 checker green over the real composition — and record the VERIFICATION LIMIT honestly in the layer notes: the mount guards, standing-mount behavior and session lock were NOT observed. A green `E-L4` you did not run is a fabricated verdict; `not_run` with a truthful note is a correct outcome |
| `E-L5` | the rework-signal collection point you installed (format + location), not a score |

---

## 8. Hard rules specific to this target

- **Never invent a row id, a package name, or a settings namespace the Structure Contract did not
  commission.** Bare specifiers resolve from the harness install (Invariant 5): name only what
  exists there. A misnamed package is not a soft error — it makes the whole directory a broken
  roster row that still occupies its id. A structural improvement is a finding, not a unilateral
  edit.
- **Never reuse a shipped preset id** (`standard`, `code`, `minimal`, `cordis`) — the shipped root
  wins duplicate ids, and your preset installs cleanly and is never seen (Invariant 4).
- **Never depend on `$DSH_PRESET_DIR` or any environment variable pointing at the preset
  directory — none exists.** The only anchors that survive the copy are relative paths and the
  cordis preset's `baseUrl` expression (§3.1).
- **Never design distribution around custom roots, an npm package, or an API import.** The CLI
  force-overrides the roster's roots to the shipped install and no wire accepts composition text
  (§3.4). Copy into `$DSH_HOME/.agent-presets/<id>/` is the whole channel; install.sh IS the
  distribution story.
- **Secrets never appear in the composition or any file under `preset/`.** A preset is plain text
  that gets copied whole between machines and carries shell-level trust by the deployment's own
  definition; there is no credential seam here. Keys live in the host's credential service, never
  in a row config, a charter, or a skill.
- **A preset only ADDS.** No row, comment, README line or charter sentence may claim it removed,
  hid or disabled a host capability (§5.1). Subtraction belongs to the companion patch, and the
  residual risk gets named.
- **No absolute paths anywhere under `preset/`** — they break on the first copy (Invariant 5),
  and the §6 hygiene grep is required to enforce it.
- **The composition and the charter must agree** (§5.2): a tool the charter forbids is a row that
  does not exist, and the §6 cross-reference checker is required, not optional.

# dsh-tool-creator

> 一个 dsh(DeepSeek Harness)**制品工厂**:五个受限角色子代理被确定性步进,
> 造出 dsh skill / plugin / preset,并把一份**机器裁定、可重跑的验收证据**
> (`acceptance-manifest.json`)打进每一个制品内部。
>
> A dsh artifact factory: a deterministic conductor steps five confined role
> subagents to CREATE dsh skills / plugins / presets, and ships a
> machine-adjudicated, re-runnable acceptance manifest **inside** every artifact.

## 目录 / Contents

1. [这是什么 / What it is](#1-这是什么--what-it-is)
2. [为什么存在 / Why it exists](#2-为什么存在--why-it-exists)
3. [工作原理 / How it works](#3-工作原理--how-it-works)
4. [安装与使用 / Install & use](#4-安装与使用--install--use)
5. [证据为何可信 / What makes the evidence trustworthy](#5-证据为何可信--what-makes-the-evidence-trustworthy)
6. [差异证明电池 / The differential battery](#6-差异证明电池--the-differential-battery)
7. [设计取舍与诚实边界 / Design notes & honest limits](#7-设计取舍与诚实边界--design-notes--honest-limits)
8. [与 dsh-pipeline-executor 的关系 / Relationship to the executor](#8-与-dsh-pipeline-executor-的关系--relationship-to-the-executor)

---

## 1. 这是什么 / What it is

dsh-tool-creator 是一个名为 `tool-creator` 的 **dsh agent preset**。它的 conductor
不写作、不设计、不评审——只做一件事:通过 `dsh-pipeline-executor` 插件,把五个
角色(composer → guidance → engineer → zipper → battery)按固定顺序**确定性步进**
一遍,每关读一个 `gateExit`,绿了进下一关、红了按表重试三次,全绿才出厂。产物是
制品本身 **加上** 一份随它出厂的验收清单 `acceptance-manifest.json`。

用法是**两段式**,不是一键:

- **① 磨 spec(普通会话,约 20–30 分钟)**:先在一个普通会话里跑 `spec-grill`
  技能,它像审讯官一样把你的想法逼到无歧义,产出一个 `# TOOL-CREATOR SPEC v1` 块。
- **② 跑流水线(约 60–63 分钟)**:把整个 SPEC 块作为**唯一消息**发给 tool-creator
  preset 会话。conductor 的准入门认这个格式直接放行,五关跑完,产出制品 + 验收清单。

诚实的时间预算:**grill ~20–30min + pipeline ~60–63min ≈ 1–1.5 小时**。流水线段是
实测的,不是投影:R3 preset 全跑 62.4min、R2d plugin 全跑 63.5min(见 §7)。目标是
**一次通过 + 时间可控**,不是抢速度——铁 spec 进去,盲区最少。

> A `tool-creator` preset whose conductor is a pure stage-stepper. **Phase ①**
> run the `spec-grill` skill in a normal session (~20–30min) to forge a
> `TOOL-CREATOR SPEC v1` block; **Phase ②** hand that block to the tool-creator
> preset (~60–63min measured), which produces the artifact + its acceptance
> manifest. Total ≈ 1–1.5h. First-pass success over raw speed.

## 2. 为什么存在 / Why it exists

竞品调研的结论很直接:整个 dsh 生态有 **982 个 npm 插件、1,909 个目录条目**,但
"创建时的行为验收"是一个**空类目**。现有 creator 的质量天花板都停在
"schema 合法 + 能 smoke-load";最强的对手(Anthropic `skill-creator`)确实做行为
测试 + 基线对比,却在**打包时把证据丢掉**。没有任何生态在做:对抗性创建门、
把证据**打进制品**、确定性可重跑的门、创建时的漂移复验、以及 dsh 特有故障类检测
(幻觉符号、重复实例注册、optional-peer 崩 boot、skill 根遮蔽——这些没有一个
出现在任何 vetting 清单里)。这正是 RESEARCH-LANDSCAPE 的六轴 10x 空位。

一句话差异化:**竞品封顶在"schema 合法 + 能加载";本项目把一份机器裁定、
可重跑的验收清单打进制品内部**——目录方从"我们又装了一遍"变成"我们又证明了一遍"。

> 982 dsh plugins / 1,909 directory entries, yet creation-time behavioral
> acceptance is an empty category. Rivals cap at "schema-valid + smoke-loads";
> the strongest (skill-creator) does baseline-delta testing but discards the
> evidence at packaging. This ships a machine-adjudicated, re-runnable
> acceptance manifest **inside** the artifact — the open-standard slot nobody fills.

## 3. 工作原理 / How it works

分层机制:grill 技能把想法烤成铁 spec → conductor charter 只认 `gateExit` 步进
→ executor 从声明式 manifest 派发受限角色、跑门、机械写台账 → battery 门链尾端
机械组装出验收清单。

```
普通会话:  spec-grill 技能  ──►  # TOOL-CREATOR SPEC v1
                                        │  (作为唯一消息交给 preset)
                                        ▼
preset 会话: conductor charter (纯步进器,只读 gateExit,零自由裁量)
                                        │  pipeline_stage({stage, attempt, target})
                                        ▼
            dsh-pipeline-executor  ──►  读 pipeline.manifest.json (控制流 = 声明式)
                                        │
      ┌─────────────────────────────────┼───────────── per-role 派发 (persona + 工具白名单 + outputSchema) ─┐
      ▼            ▼            ▼            ▼                                    ▼
   composer ──► guidance ──► engineer ──► zipper ──► battery (扇出 3 透镜 + synthesis)
    (spec)     (structure)   (build+     (compress,   coherence / gaming / reality
                             fixtures)   skill-only)            │
      │            │            │            │                  ▼
      └── 门:python validator，execFile argv，无 shell → gateExit ──►  decision-record
                                        │                                        │
                                        ▼   battery 门链 `then` (仅在 fold 门绿后)
                                assemble_manifest.py  ──►  acceptance-manifest.json (打进制品)
```

**五个角色,各一句:**

- **composer**(只读):把 spec 折成 `skill-spec.json`;grilled spec 是首要来源,不复议。
- **guidance**(只读):从 spec 推出 `structure-contract.json`(目录/文件契约)。
- **engineer**(读写+bash):真写代码/文档 + 建 fixture,产出 `evidence-dossier.json`;全流程最重的一关。
- **zipper**(读写,跑 v4-flash):机械压缩,**仅 skill 目标**运行;plugin/preset 是代码+配置,无散文可压,按 target filter 跳过。
- **battery**(扇出):三透镜对抗攻击 + synthesis 写 `decision-record.json`;门链尾端组装验收清单。

conductor 故意保留**逐关步进**而非一键全跑:阶段间的 conductor turn 是天然检查点
(会话日志可见、用户可打断、工具超时可控)。它从不看角色的散文,只读 `gateExit`。

> Layers: grill skill → conductor charter (reads only `gateExit`) → executor
> dispatches confined roles from a declarative manifest, runs `execFile` gates,
> writes the evidence ledger → the battery gate chain mechanically assembles the
> acceptance manifest. Five roles, one line each above.

## 4. 安装与使用 / Install & use

**要求 / Requirements**:dsh(DeepSeek Harness,0.1.0-rc.x)+ `deepseek-v4-pro`
根模型(本项目**只针对 v4-pro 调音**,见 §7);plugin 目标的符号扫描需要
`~/.dsh/profiles/node_modules/@deepseek-ai` 存在。

**安装 / Install** — `dist/install.sh`:先对 `dist/preset/` 逐文件核 sha256
(`hashes.json`,33 个文件),核过再:

- 把 preset 复制进 `~/.dsh/.agent-presets/tool-creator`(复制后再核一次哈希);
- 把 `spec-grill` 技能装进 `~/.dsh/skills/spec-grill`(供**普通会话**磨 spec 用)。

`--verify-only` 只核 `dist/` 完整性、不安装。

```bash
bash dist/install.sh              # 校验 + 安装 preset 与 spec-grill 技能
bash dist/install.sh --verify-only   # 只核哈希,不落盘
```

**选中 preset / Select the preset**:web 端在 preset 选择器里选 `tool-creator`;
**终端没有 preset 概念**——终端用单源生成的 `dist/profile-patch.yml`(profile-patch
变体,与 web charter 同源注入,双平面 persona 漂移由构造消除)。

`dsh-pipeline-executor` 作为独立的 npm 包分发(见 §8),preset 行通过 cordis
`baseUrl` 约定拿到绝对 `baseDir`;它是通用生态件,不是本 preset 私有。

> `dist/install.sh` hash-verifies `dist/preset/` against `hashes.json` (33
> files), copies the preset into `~/.dsh/.agent-presets/tool-creator` and the
> `spec-grill` skill into `~/.dsh/skills/spec-grill`. Web selects the preset in
> the picker; terminal has no preset concept and uses the single-source
> `profile-patch.yml`. Requires dsh + `deepseek-v4-pro`.

## 5. 证据为何可信 / What makes the evidence trustworthy

`acceptance-manifest.json` 由 `assemble_manifest.py` **机械组装**——每个字段都来自
机器/门源(台账、decision-record、dossier、透镜产物、目录树遍历),证据组装**从不
经过模型转写**(R5"转录洗白"教训的结构性解决)。它带着:

- **哈希**:`rootHash` + `files` 覆盖制品每个文件的 sha256;缺文件=篡改,不是容忍。
- **裁决 + 上限**:`min-fold` 规则 `effective = min(reAudit, battery_cap)`,
  breaches_found/not_run 把上限压到 `candidate`——**电池给自己的产物封顶**。
  reverify 会重算这个 fold,写得比 fold 高的 manifest 直接判伪造。
- **可重跑**:`reverify` 命令数组 + `tools/reverify.mjs`(零依赖、离线、execFile
  argv):重算所有哈希 → 跑门 → 再哈希证明制品树未被改动。"verified on rc.6"
  变"re-verify on rc.7"。
- **台账 sha256**:`evidenceLedgerSha256` 钉住 executor 从磁盘字节写的台账;
  manifest 带的是它的哈希不是内容——活体证据被钉住,不被重放。

机械保证(非指令):**capability 级别 O-L3 由 executor 从 manifest 常量盖章**进
decision-record(像盖 sha256 一样盖一个结构常量,因为 synthesis 曾**非确定性**地
一次写 O-L0、一次写 O-L3);validator 要求 machine-adjudicated 门必须 O-L3+;
plugin 目标额外过 `scan_symbols.py` 幻觉符号门;zipper 的 target filter 机械跳过。

**活证 / Live proof**:三个 target 都有 live-green manifest——skill(R1-c)、
preset(R3,kind=preset/O-L3)、plugin(R2d,kind=plugin/O-L3,scan_symbols 干净);
故障注入 R4(zipper seeded-red)→ 诚实 `stopped_unmet`,不出厂。R1-c 的门自证时刻:
battery attempt 1 因 synthesis 低报 verdict 被 `validate_decision` 当场判红重试,
attempt 2 修正通过——**门把模型的不精确变成了自我纠正**。

制品出厂前撞到并**用机械保证(而非指令)**根治的确定性缺陷:O-L0/O-L3 非确定性
→ 机械盖章;冻结工具结果崩溃 → clone-before-write;preset 子目录树 → `artifact_root`;
过严准入门 → target-aware;跨会话台账污染 → per-line `manifestSha256` 机械拒绝。
这些是竞品"schema 校验 + smoke"永远碰不到的层——包括 plugin 目标的**六条 load-time
boot 不变量** + preset 目标的**八条 mount-guard 不变量**(`targets/*/BUILD.md §2.1`)。

> The manifest is mechanically assembled — never model-transcribed. It ships
> hashes (rootHash + per-file sha256), a min-fold verdict that caps itself, a
> re-runnable `reverify` command set, and the ledger's sha256. O-L3 capability
> is stamped from a manifest constant (synthesis authored it non-deterministically).
> Three targets banked live-green (skill R1-c / preset R3 / plugin R2d); the
> fault-injection run R4 honestly `stopped_unmet`.

## 6. 差异证明电池 / The differential battery

这是本项目对自己的 **skill 形态**做的对照测量——证明"组合(preset)形态"的独有
下限。全部台账在 `docs/evidence/differential-battery.md`。

| # | 主张 | preset 形态(banked) | skill 形态对照 |
|---|---|---|---|
| T-D1 | 控制流忠实是机械的 | manifest/产物/门日志 sha256 由 executor 从磁盘算;抽查 10/10 吻合 | 模型誊写实测 5/6 |
| T-D2 | 角色约束:继承层机械 + 自有层指令 | toolFilter 白名单机械生效;禁令前 9 helper,禁令后 0/4、0/4、1(只读 ls,已被检测) | 文本约束,基线违规读 role-pack 不可阻止 |
| T-D3 | 角色包零稀释(B15 根因) | role-pack 作 persona 派发:30+30 分类 fixture + 30 案例触发电池 | prompt 稀释:3 fixture 无 golden 对 |
| T-D5 | 证据不可伪造 | manifest 机械组装;fold 伪造被 validator 当场拒绝(r1c 实录) | R5 实测模型伪造引文 |
| T-D6 | 环境钉死可复现 | r1b/r1c 同题两跑结构相同、钉 rc.6 + v4-pro | skill 跑在任意用户组合,不可钉 |
| T-D7 | 成本结构可工程化 | battery 5 透镜 464–495K → 3 透镜 243–259K(−47%),一次配置改动生效 | skill 无法控制派发结构 |

(T-D4 注入抵抗为 partial,并入攻击轮;完整台账见证据文档。)

**B15 头对头**(2026-08-14 skill 基线 vs r1c preset 产物,cmark-gfm 判定):
语料 **30+30 分 10 类 vs 18+18 平铺**(preset 胜)、触发电池 **30/30 vs 无**
(preset 胜)、backslash+pipe 转义**平**(r1b 曾错,且被其 reality 透镜当场抓获)、
`--max-col-width` 字面性**基线微负**(≤N+3 显式省略号 vs 严格 ≤N)。

结果:08-14 的全败 → **2 胜 / 1 平 / 1 微负——"不再输"达成**。

诚实面(这正是卖点):那个微负是**真的输**,不粉饰;而 T-D2 的角色约束是
**指令级**的——继承层的 toolFilter 机械生效,但宿主注入的 own-scope `subagent` 门
在宿主侧仍开(禁令+电池检测兜底,不宣称超出实际的隔离)。诚实本身就是产品叙事。

> The battery measures preset-form vs this project's own skill-form baseline
> (T-D1..T-D7). B15 head-to-head: **2W / 1T / 1 narrow-loss** vs the 2026-08-14
> total loss — "不再输" achieved. Honest: the loss is a real loss, and T-D2
> confinement is instruction-level (host `subagent` door stays open). The honesty
> is the selling point.

## 7. 设计取舍与诚实边界 / Design notes & honest limits

- **只调 v4-pro**:charter 单风格、实验单矩阵、验收单执行器。多模型适配不做
  (battery 的跨厂商攻击手除外,预留 disabled 行)。根模型无受支持的 per-dispatch
  钩子,靠部署默认 + 文档承担。
- **墙钟约 62min,略超 <1h 目标**:R3 anatomy = composer 8.6 + guidance 9.5 +
  **engineer 26.5** + zipper 0(SKIPPED)+ battery-a2 17.8 = 62.4min;R2d = 63.5min。
  两个极点是 **engineer**(不可压缩的真代码 + 30 fixture 工作)和 **battery**。
  sub-60 的杠杆(flash-tier composer/guidance 试、engineer 语料底调)有质量风险、
  留 L7 门测——不做没证据的砍。
- **确认严禁 mid-run 安装**:R2 曾混配跑(我自己的安装纪律违规),per-line
  `manifestSha256` fail-close(两版本→拒绝)机械抓到了它。永远在两次 run 之间安装。
- **修复必须机械、不靠指令**:每个确定性缺陷都用结构保证收口(盖章/clone/
  artifact_root/target-aware/per-line sha),而不是往 prompt 里再加一句话。
- **对抗性 dogfood**:每一个缺陷都是一次**真实 live run** 暴露的(L0→L5 台账见
  `.loop-state/DECISIONS.md`),不是想象出来的。

> v4-pro-only tuning. Wall-clock ~62min, slightly over the sub-1h goal —
> engineer (26.5) + battery are the poles. Never install mid-run (a per-line
> `manifestSha256` fail-close caught the one violation). Fixes are mechanical,
> not instructional. Every defect was surfaced by a real live run.

## 8. 与 dsh-pipeline-executor 的关系 / Relationship to the executor

`dsh-pipeline-executor` 是**独立发布在 npm 上的通用生态件**,不是本 preset 私有。
它读一份声明式 stage manifest,每关派发一个或多个受限角色子代理(persona + 工具
白名单 + outputSchema 由 manifest 钉死),由 **executor 而非模型**从子代理的结构化
返回写产物,用机械门(execFile argv、无 shell)判 verdict,并把每次尝试写进只读、
append-only 的证据台账(`evidence-ledger.jsonl`,所有 sha256 从磁盘字节算)。

dsh-tool-creator 是它的**第一个消费者(dogfood 产物)**;任何需要"声明式、
per-role 受限、门控多代理流水线"的项目都能复用它。它自己的文档、工具表、配置键、
错误码见 `packages/dsh-pipeline-executor/README.md`。

> `dsh-pipeline-executor` ships independently on npm as a generically useful
> declarative, per-role-confined, gated multi-agent pipeline executor. It writes
> artifacts (not the model), runs `execFile` gates, and records a machine-written
> evidence ledger. dsh-tool-creator is its first consumer. See
> `packages/dsh-pipeline-executor/README.md`.

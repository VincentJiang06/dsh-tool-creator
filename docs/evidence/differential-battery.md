# 差异化证明电池(T-D1..T-D7)——preset 形态 vs skill 形态,实测台账

> 每项 = 一个只有组合(preset)形态才成立的主张 + 对照测量。skill 形态对照
> 数据来自 2026-08-14 基线实测;preset 形态数据来自 L5 实跑(r1b/r1c 等,
> 工作区与会话日志均存档)。状态:banked = 证据齐;partial = 待 L5 收官补齐。

| # | 主张 | preset 形态实测 | skill 形态对照 | 状态 |
|---|---|---|---|---|
| T-D1 | 控制流忠实是机械的 | manifest/产物/门日志 sha256 由执行器从磁盘计算;R1 战役抽查 10/10 重算吻合;控制流在声明式 manifest 里,模型零转写 | 模型誊写脚本实测 5/6 | **banked** |
| T-D2 | 角色约束:继承层机械 + 自有层指令 | toolFilter 白名单机械生效(子代理工具面日志实证);宿主注入的 own-scope `subagent` 门无法机械关闭——禁令前 9 个 helper,禁令后 0/4、0/4、1(唯一一个是只读 ls,已被检测) | 文本约束,基线实测违规读 role-pack 不可阻止 | **banked**(诚实边界:门在宿主侧仍开) |
| T-D3 | 角色包零稀释(B15 根因) | role-pack 作为 persona 派发:r1c 语料 30+30 分类 fixture + 触发电池 30 案例 | prompt 稀释事故:3 fixture 无 golden 对(08-16 实测) | **banked** |
| T-D4 | 注入抵抗 | request.md 由 conductor 逐字写入(diff 实证),其内容零工具可执行性;battery 透镜工具面受限 | 无结构防线 | partial(专项注入跑并入 L6 攻击轮) |
| T-D5 | 证据不可伪造 | acceptance manifest 由 assemble_manifest.py 机械组装;fold 伪造被 validator 当场拒绝(r1c battery a1 门红实录:synthesis 写 draft 被拒重试) | R5 实测模型伪造 imageStatus 引文 | **banked** |
| T-D6 | 环境钉死可复现 | r1b/r1c 同题两跑:阶段结构相同、四关均 a1 绿、manifest 钉 dsh 0.1.0-rc.6 + deepseek-v4-pro;差异(battery 结局)可归因于两跑间的已记录变更 | skill 跑在任意用户组合,不可钉 | **banked**(严格同配置复跑并入 L6) |
| T-D7 | 成本结构可工程化 | battery 规模由 manifest 声明:5 透镜 464-495K/次 → 3 透镜 243-259K/次(−47%),一次配置改动生效 | skill 无法控制派发结构 | **banked** |

## 附:门系统的自证时刻(r1c battery attempt 1)

`validate_decision` 拒绝了 synthesis 的 decision record(fold 低报 + adjudicator
字段错),charter 按表重试,attempt 2 修正通过——**门把模型的不精确变成了
自我纠正**,全程有 gate log + ledger 回执。这是"下限+证明"主张的最短实证。

## B15 头对头终局(2026-08-14 skill 基线 vs r1c preset 产物,cmark-gfm 判定)

| 维度 | 基线 | r1c | 胜者 |
|---|---|---|---|
| backslash+pipe 转义 | 正确 | 正确(r1b 曾错,且其 reality 透镜当场抓获) | 平 |
| --max-col-width 10 | 严格 ≤N | ≤N+3 显式省略号(有文档契约与论证) | 基线微胜(字面性) |
| 语料 | 18+18 平铺 | **30+30 分 10 类 + E-L2 20/20** | **r1c** |
| 触发电池 | 无 | **30 案例(20正+10负)30/30** | **r1c** |

08-14 的全败 → **2 胜 1 平 1 微负:"不再输"达成**。

## 三 target live 闭环(2026-08-19,L5 关门)

| target | 运行 | manifest | 关键证据 |
|---|---|---|---|
| skill | R1-c | live 绿 | B15 不再输;fold 自证(synthesis 低报被门拒重试) |
| preset | R3 | live 绿 | kind=preset,O-L3,preset 证据模型三层缺陷全清,reverify ok |
| plugin | R2d | live 绿 | kind=plugin,O-L3 首过,scan_symbols 干净,reverify ok |
| (故障) | R4 | 无(应然) | zipper seeded-red → 诚实 stopped_unmet |

全程暴露并根治的确定性缺陷(每个都用机械保证而非指令修复):O-L0/O-L3 非确定性
→ 机械盖章;冻结工具结果崩溃 → clone-before-write;preset 子目录树 → artifact_root;
过严准入门 → target-aware;跨会话台账污染 → per-line manifestSha 机械拒绝。这些
是竞品的 "schema 校验 + smoke" 永远碰不到的层。

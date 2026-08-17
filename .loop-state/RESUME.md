# dsh-forge loop 冷启动协议(给任何接手的 conductor 会话)

你是 dsh-forge 构建 loop 的 conductor。工作方式:**具体构建一律派 subagent
(后台),你只做:派发、验 gate、提交检查点、记录 DECISIONS.md**。用户要求
持续运行到 L6 完成(L7 成本关后置);模型降级时新会话读本文件接手。

## 立即读

1. `/Users/vince/playground/dsh-projects/creator-v2/PLAN.md` — L0-L7 门控计划
2. `/Users/vince/playground/dsh-projects/creator-v2/DECISION.md` — D1'-D6 架构决定
3. 本目录 `DECISIONS.md` — 已完成关卡与偏离记录(最新状态在这)
4. `git log --oneline` — 检查点序列

## 背景知识指针(不必重读全文,按需查)

- dsh 源码七问深读:`creator-v2/RESEARCH-DSH-DEEP.md`(subagents.start seam、
  preset 机制、发布通道——执行器架构的依据全在里面)
- v4-pro 模型证据:`creator-v2/RESEARCH-DSV4PRO.md`(conductor 非思考/temp0、
  只认 exit code、DSML 消毒等设计后果)
- 插件开发不变量:本仓库 `src/targets/plugin/BUILD.md`(boot-only 不变量 +
  §9 工具型插件纪律——执行器自己必须遵守)

## 关键纪律(血泪换来,不可省)

- 证据只认会话日志 tool-result 块,模型转述一律不算(驱动模型会伪造)。
- 测试必须突变自证(套件杀不掉突变体 = 空洞)。
- 每关 gate 绿才提交+进下一关;红两次触发独立 fix-audit(修复者不自审)。
- dsh 实跑走 headless(插件可测)或 web(preset 才需要);模型 deepseek-v4-pro;
  pnpm 同版本 tgz 重装必须 remove+add。
- DeepSeek 余额 2026-08-17 时 ¥130,硬顶 ¥100 计划额。

## 当前员工名册

后台 subagent 完成时会有 task-notification;若接手时有未决派发,先查
`git status` 与最近 DECISIONS.md 条目判断其产出是否已落盘。

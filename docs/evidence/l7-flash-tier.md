# L7 flash 分层实测(V1=r5 / V2=r6,2026-08-19)

> 主张:机械阶段(composer/guidance/zipper)换 `deepseek-v4-flash`,质量下限由门系统
> 保证,总时长压到 60 分钟内。验证方式:R1 同题(csv-md-table skill)live 全流水线,
> 请求字节级相同,与 R3 分阶段基线头对头。
> **终判(V2)**:预算修复实证成立(flash 死亡 0/4 vs V1 2/4),**sub-60 含重试达成:
> 59.69 分**(V1 62.0)——余量 0.3 分,小于 pro 阶段方差(engineer 跨跑 21.2/26.5/30.2),
> 诚实表述是"**典型 sub-60,非保证**;剩余方差在 pro 阶段,与 flash 无关"。

## V1 → V2 对照(V2 五关全首过,零重试)

| 阶段 | 模型 | V1 含重试 | V1 绿次 | **V2(=绿次)** | V2 token |
|---|---|---|---|---|---|
| composer | flash | 9.6m(a1 死) | 5.8m | **4.7m** | 42,581 |
| guidance | flash | 6.2m | 6.2m | **7.3m** | 77,893 |
| engineer | pro | 21.2m | 21.2m | **30.2m**(慢侧方差) | 187,416 |
| zipper | flash | 8.7m(a1 死) | 2.5m | **2.7m** | 62,394 |
| battery | pro | 15.8m | 15.8m | **13.9m** | 283,133 |
| **合计** | | **62.0m** | | **59.69m** | 653,417(零浪费) |

flash 阶段耗时跨跑稳定(4.7/5.8、7.3/6.2、2.7/2.5);V1→V2 的总差 = 消灭重试(−10.0m)
− engineer 方差(+9.0m)。V1 死于 24576/32768 的两个派发,在 40960/49152 下均一次过。

## V2 的门系统高光:真实质量回归被当场抓获

r6 的 engineer(pro,跑间方差)把触发电池做成了**形状检查**(31 条全 `live_run=false`,
`observed:null`),没有像 r5 那样实跑确定性激活代理(37 条 live,1.0/0.0)。battery 的
gaming 与 reality 两个透镜**各自独立**把这一点定为 P1(共 2×P1/5×P2/2×P3),verdict
= breaches_found → effective 压到 candidate,**回归被抓住、计数、写进出厂 verdict**,
而不是溜出厂——这正是"质量地板由门保证"的实证:换更便宜的模型敢,是因为验收不靠模型自觉。

## V2 其余机械验证

- manifest:`model.id = deepseek-v4-flash+deepseek-v4-pro`;mixed-model 披露行逐字在
  limits[];64 文件,O-L3。
- reverify **72/72 exit 0**(harness 实跑绿,validate-* 披露式 SKIP,tree-unchanged 绿)。
- 请求与 V1 字节级相同;无中途安装;诚实 done close-out。

## 分阶段实测(r5 vs 基线)

| 阶段 | 模型 | 次数 | 绿次耗时 | 基线 | 单次变化 | 含重试 |
|---|---|---|---|---|---|---|
| composer | flash | 2 | 5.8m | 8.6m | **−33%** | 9.6m |
| guidance | flash | 1 | 6.2m | 9.5m | **−35%** | 6.2m |
| engineer | pro | 1 | 21.2m | 26.5m | (同模型方差) | 21.2m |
| zipper | flash | 2 | 2.5m | 6.9m(r1c,pro) | **−64%** | 8.7m |
| battery | pro | 1 | 15.8m | 17.8m | (同模型方差) | 15.8m |
| **合计** | | | | 62.4m | 无重试投影 **≈52m** | **62.0m** |

## 失败尸检(会话日志解压,两次 a1 `ROLE_NO_OUTPUT`)

两例同因:**maxTokens 截断于 reasoning 膨胀**——flash 在部署级 `reasoningEffort=high`
(spike E3:不可按派发下调)下,推理远超为 pro 调的预算。
- composer a1(cap 24576):reasoning 18,243;structured_output **已开流 22 个 delta**
  被掐断;`turn/end max-tokens`。
- zipper a1(cap 32768):**32,768/32,768 全部是 reasoning**(自检循环),输出从未开始。
- guidance(cap 40960)首过——三个 flash 阶段把故障干净地夹出区间:24576 死 / 32768 死 /
  40960 过。

**修复(纯 manifest)**:composer 24576→40960(已证充足预算)、zipper 32768→49152。
cap 是上限不是支出,空余不计费。复验推迟到下一离峰窗,由门测量。

## 这一跑顺带 live 证明的 L6 机制(此前只有 fixture 证据)

- 混合模型披露:r5 manifest 的 limits[] 逐字出现 `mixed-model run: composer=deepseek-v4-flash,
  engineer=deepseek-v4-pro, …`;`model.id = deepseek-v4-flash+deepseek-v4-pro`。
- reverify **61/61 exit 0**:55 个文件 hash + rootHash 全对,skill 自带 harness 实跑绿,
  validate-* 按 requiresKit 设计披露式 SKIP,tree-unchanged 绿。
- 门系统:两次 flash 故障均被门抓住并重试转绿;五关 gateExit 全 0;诚实 close-out。

## 质量对照(engineer 未动,r1c 为参照)

fixture:14 类 / 23 案例(r1c:10 类 / 30+30——类广度 +40%,案例数 −23%,形态迁移
非塌方);触发电池 37 案例(25 正 / 12 负),正向 1.0(线 0.9)、误触 0.0(线 0.05);
battery 判 breaches_found→candidate(0P1/2P2/4P3,诚实非通胀)。

## 附带发现

- **死配置**:zipper role 块里躺着 role 级 `provider/model`(flash)——执行器只读
  stage 级(`stage.model ?? defaults.model`),L5 时代的"zipper→flash"从未生效,
  r1c 的 6.9m 是 **pro** 时间。已清除;杠杆只在执行器**读取的位置**才是真的,
  验证手段就是 ledger 的 roleModel(本跑正是这么抓到的)。
- 执行器 0.1.8 候选:失败尝试 `childSessionIds:[]`+`tokens:null`(死子代理不入账,
  ~62K 输出 token 不可见);manifest 出生在 artifacts/、靠归档拷贝到制品根
  (target-aware --out 可根治)。

# dsh-agent-nodeforge — 语义文档（DSH 智能体实例锻造）

## 1. 元信息

| 项 | 值 |
|---|---|
| 版本 | v0.1 |
| 日期 | 2026-09-26 |
| 状态 | 实现完成 · **离线已验收 / 线上未验收**（见 §7） |
| 实现落点 | `src/plan.ts`（纯计划层）· `src/index.ts`（壳：落盘/装依赖/起进程/工具面）· `tests/plan.test.mjs` |
| 主副本 | 本文件（`docs/semantic.md`）；无同语义副本 |
| 设计者 | 爱丽丝（主人 2026-09-26 指令：「创建实例的方法也要配套跟上，最好是借助本地源码安装的 dsh，不同智能体搞个工作分区」） |

> ⚠ **流程诚实标注（2026-09-26）**：本插件是**先写代码、后补语义文档**的——违反 `AGENTS.md` §5.20 规则 1（「新能力开工前先落语义文档」）。原因不是判断「不需要」，而是接到指令后直接进了取证与实现。**记录在此不掩饰**：文档是本插件的一部分，但它的**产生顺序**错了，下次新能力开工应先落此文件。

## 2. 定位与反定位

**定位**：把「起一个新的 DSH 智能体实例」从**一次性手工操作**变成**可复算的计划 + 一条命令**。一个节点 = 一个跑起来的 DSH 进程 = 网络里的一个成员。

**反定位**（同样重要）：

- **不是编排器**：它只**造**节点，不管节点之间怎么说话——那是 `dsh-agent-cluster` 的职责（两者共用同一个总线根才互相看得见，见 N3）。
- **不是守护**：它不起 watchdog、不做崩溃自愈、不做端口接管——那是 `dsh-agent-watch` 的职责。
- **不是部署器**：它不装第三方插件、不改**既有** profile 的装配（既有 profile 一律拒绝覆盖，见 N1）。
- **不是调度器**：造几个节点、谁当主脑、派什么活，都是决策，不归它。
- **不是凭据管理器**：`isolatedHome=true` 会分出一个新的 `DSH_HOME`，但**新 home 的凭据是空的**——它不搬运、不复制任何凭据。

## 3. 术语表

| 术语 | 定义 |
|---|---|
| **节点（node）** | 一个跑起来的 DSH 进程；在网络里由 `nodeId` 标识（cluster 插件按 `<hostname>-<profile>-<port>` 派生） |
| **profile** | `$DSH_HOME/profiles/<name>/` —— 决定**装配**（装哪些插件、怎么配） |
| **工作分区（workspace）** | 子进程的 **cwd** —— 决定**在哪干活**；DSH 的会话存储本就按 workspace 分子目录（`sessions/--<workspace>--/`），所以分区天然不串会话 |
| **home** | `DSH_HOME` —— 决定**数据面**（sessions / credentials / presets / 侧车轨迹） |
| **锻造（forge）** | 建工作分区 + 写 profile 骨架 + 写 cluster 配置 + 装 link 依赖 + 起进程 这一整套动作 |
| **计划（plan）** | 纯函数产出：要写哪些文件、内容是什么、怎么起——**零 IO、零环境读取** |
| **随附 profile** | DSH 自带的 profile 名（`web` / `headless` / `sdk` / `sdk-minimal` / `acp`）：不可作为新建目标名，且它们的 bundle 从安装目录解析、无需下载 |
| **保留名** | `desktop`（归 Electron 持有）· `watch`（本机守护）——不可占用 |

## 4. 概念模型与不变量

```
        ┌──────────── 一个节点 = 三个互相独立的层次 ────────────┐
        │ profile   $DSH_HOME/profiles/<name>/    ← 装配        │
        │ workspace <nodesRoot>/<name>/           ← 干活的地方   │
        │ home      DSH_HOME（共享或隔离）         ← 数据面       │
        └──────────────────────────────────────────────────────┘
                              ▲
                    node_create 一次锻造：建目录 → 写四件套 → 装 link → spawn
                              │
                    ┌─────────┴─────────┐
              共享总线 busDir      （必须与 cluster 插件同值）
```

**不变量（每条都能被一次测量判真假）**：

- **N1 不覆盖既有 profile**：计划里所有文件都是 `create` 模式；目标文件已存在 ⇒ **拒绝写入并报告**，不静默覆盖（覆盖会改掉别人的装配）。判据：对一个已存在的 profile 再调一次 ⇒ `filesRefused` 非空、`ok=false`。
- **N2 名字合法**：不得撞随附 profile 名（官方 `--from-default-profile` 契约明令）或本机保留名（`desktop`/`watch`），且只允许 `[a-z0-9-]` 且以字母数字开头。
- **N3 总线一致**：新节点的 `busDir` 必须与网络内其它节点**同值**——否则表现为「节点活着，但名册里看不到别人」（静默，不报错，是最容易误判的一种失败）。
- **N4 不碰载体**：`node_stop` 对 `web`（当前载体）与 `watch`（守护）**一律拒绝**；判据落在候选名上，不依赖调用方自觉。
- **N5 观测不反噬**：轨迹落盘失败吞错并返回 `false`，绝不影响锻造主流程（对照 §5.22 规则 3）。
- **N6 与宿主同进程的安全**：所有回调经 `guarded()`；spawn **必挂 `error` 监听**（异步失败不监听会掀掉宿主）；子进程 `detached + unref` + stdio 落文件（不占宿主 fd，且活过宿主）。
- **N7 计划可复算**：`planNode(spec)` 是纯函数——同 spec 必得同计划；不读环境、不碰文件系统。

## 5. 契约

### 5.1 文件契约（照官方模板**逐字段**对齐）

官方 profile 骨架（2026-09-26 从 `$DSH_HOME/profiles/headless/` 取证）：

| 文件 | 作用 | 本插件的写法 |
|---|---|---|
| `package.json` | 声明 `dsh.profile.bundles` 与依赖 | `name: dsh-profile-<n>` · `private: true` · `dependencies` **只有** `dsh-agent-cluster: link:<路径>` · `bundles` 取自模板 · **外加一块 `dshNodeforge` 自描述**（见下） |
| `cordis.yml` | profile 根，**恒为空** | `[]`（装配靠 patch 叠加） |
| `cordis.patch.yml` | **用户覆盖层** | 一条 `insert`：`dsh-agent-cluster` + config（`role`/`profile`/`busDir`/`autoInject`/`leaderEligible`/`leaderAutoRenew`/可选 `port`） |
| `pnpm-workspace.yaml` | 本机 pnpm 约定 | `autoInstallPeers: false`（见 §9 的 2026-09-26 条） |

- **bundle 是 in-box**：`@deepseek-ai/dsh-base` / `dsh-headless` 从当前 dsh 安装解析，**不下载**（官方契约原文：`The in-box bundles named by that copied list still resolve from the current dsh installation.`）⇒ 一次 `pnpm install` 只为装那条 link。
- **`create` 模式**：四件套全部 `create`。已存在即拒绝（N1）。

**`dshNodeforge` 自描述块**（照官方 `dshTavern` 自定义键的先例，v1）：把 `template` / `workspace` / `port` / `role` / `busDir` / `home` / `autoInject` 写进 profile **自己**的 `package.json`。

**为什么要有它**：① `node_start` 要起一个**已存在**的节点，就得知道该带哪些 app 参数（`--no-open` 只有 web 认，带错就秒退）② `node_list` 要报**真实** workspace，而不是按默认规则猜（猜不到自定义分区，会把「规则不覆盖」显示成「分区不存在」）。

**读取契约**：一律经 `readNodeMeta()`，**never throws** —— 形状不对 ⇒ 返回 `undefined`，调用方**退回默认规则**。⚠ 不这么做等于把「信息缺失」升级成「功能失效」（profile 是手工造的时候没有这个块，那是正常情况，不是错误）。

### 5.2 YAML 转义契约（**单引号，实测强制**）

写进 `cordis.patch.yml` 的字符串一律经 `yamlQuote()` 用 **YAML 单引号**包裹。

⚠ **这不是风格偏好，是可用性**——2026-09-26 实测对照（`js-yaml` 真解析）：

| 写法 | 结果 |
|---|---|
| `k: 'C:\Users\tr\.dsh-cluster'` | 解析得 `C:\Users\tr\.dsh-cluster` —— **逐字符相等** ✓ |
| `k: "C:\Users\tr\.dsh-cluster"` | **`YAMLException: expected hexadecimal character`** —— `\U` 被当转义起始，**根本解析不了** |

单引号里只有 `'` 需要翻倍，其余（`\` `"` `#` `:`）全部字面量。

### 5.3 启动契约（与已验证的守护实现同形）

```
<node> --expose-internals <harness>/apps/cli/lib/bin.js --profile <name> [--port N] [--no-open]
cwd = workspace
env = { ...process.env, DSH_HOME: <home>, NODE_USE_ENV_PROXY: '1' }
```

形状照抄 `dsh-agent-watch` 的 spawn（那是本机已验证的参考实现）。`port=0` 时**不传** `--port`。

⚠ **`--no-open` 是条件性的，不是标配**：它是 **web app 自己的**参数，`headless` / `sdk` / `acp` 都**不认**它——2026-09-26 实测，带错的后果是 `error: unknown option '--no-open'`，进程**起得来但秒退**，名册里什么都不留（症状极像「插件没生效」）。判据在 `TEMPLATE_ACCEPTS_NO_OPEN`（目前 `['web']`）。

### 5.4 工具面（模型可见契约）

| 工具 | 参数 | 说明 |
|---|---|---|
| `node_create` | `name`(必) `template` `workspace` `port` `role` `isolatedHome` `dryRun` `start` | 一次锻造；`dryRun=true` 只出计划；`start=false` 只落盘 |
| `node_list` | 无 | profile 目录（装配真源）与总线名册（身份真源）对照 |
| `node_stop` | `name` | 停节点（pid 取自总线心跳）；N4 保护名单 |
| `node_start` | `name`(必) `port` `workspace` | 起一个**已存在**的节点。`node_create` 有 N1 保护（拒绝覆盖既有 profile）⇒ **停掉之后想再起只能靠它**。参数缺省读自描述块（三级回退：显式参数 > 自描述块 > 默认规则）；**不写任何文件** |

### 5.5 路径真源（调用点清单）

| 值 | 真源 | 为什么 |
|---|---|---|
| `harnessRoot` | **`process.argv[1]`**（launcher 路径，上溯三层） | 本进程正在跑就是最硬的证据；不硬编码安装位置 |
| `clusterPluginPath` | **本模块文件位置**（`import.meta.url`，兄弟目录） | 同上 |
| `home` | 配置 → `$DSH_HOME` → `~/.dsh` | 与 DSH 自己的解析链一致 |
| `busDir` | 配置 → `~/.dsh-cluster` | 与 cluster 插件默认一致 |
| `nodesRoot` | 配置 → `<home 的父目录>/dsh-nodes` | 默认与 DSH_HOME 同级，不污染主工作区 |

## 6. 边界与信任

- **能力边界 ≠ 沙箱**：本插件能 spawn 任意 `harnessRoot` 下的 DSH 进程；它**不**提供隔离保证。`isolatedHome` 分的是**数据面**，不是权限面。
- **同名保护是单向的**：N1 只保护「已存在的 profile 不被覆盖」；它**不保护**「workspace 里的文件」——`node_create` 会 `mkdir -p` 工作分区。
- **`node_stop` 只按心跳 pid**：心跳里的 pid 可能是**重用过的** pid（进程已死、系统把号给了别人）⇒ 判据是「pid 存活」而非「那是不是 DSH」。**已知风险，未加进程名核验**（见 U2）。
- **不接触凭据**：不读写任何 `.credentials.yaml`，不搬运 home 之间的凭据。
- **不越界**：不改宿主组合、不动 `web`/`watch`、不 kill 端口持有者（那是守护的活）。

## 7. 可证伪验收

> 代号：**U** = 离线单测（`npm test`，**24 passed / 0 failed**）· **E** = 端到端 · **—** = 未覆盖。

| # | 命题 | 状态 | 证据 |
|---|---|---|---|
| A1 | `yamlQuote` 让 Windows 路径经**真解析**逐字符保真 | **单测已验** | ✔ U：`js-yaml` 解析往返；**尸体样本**：改成双引号实现 ⇒ **3 fail**（含「双引号竟然保真了」的自检条） |
| A2 | 名字校验拦住随附 profile 名与保留名 | **单测已验** | ✔ U：5 个随附名 + 2 个保留名全被拒且带理由；**尸体样本**：去掉随附名检查 ⇒ **1 fail** |
| A3 | 计划产出四件套，`package.json` 合法且依赖只有一条 link | **单测已验** | ✔ U：文件名集合断言 + `bundles` 深度相等 + `Object.keys(dependencies).length === 1` |
| A4 | `cordis.patch.yml` 真解析后 cluster 配置逐字段保真 | **单测已验** | ✔ U：解析后断言 `busDir`（含反斜杠）/`role`（中文）/`profile`/`autoInject`/`leaderEligible` |
| A5 | 所有计划文件都是 `create` 模式（N1） | **单测已验** | ✔ U；**尸体样本**：改成 `overwrite` ⇒ **1 fail** |
| A6 | 启动形状与守护同形（`--expose-internals` / `--profile` / `--no-open`，`cwd=workspace`） | **单测已验** | ✔ U：逐位置断言 argv + `env.DSH_HOME` + `cwd` |
| A7 | `stopGuard` 拒绝 web/watch | **单测已验** | ✔ U |
| A8 | **线上**：`node_create` 起出的节点真的进 `cluster_nodes` 名册 | **待线上验收** | ⚠ 待线上验收（需挂载插件 + 重启 web） |
| A9 | **线上**：新节点**无用户会话**时，收到消息落 `hold-no-session`（而非重试到 `dead`） | **待线上验收** | ⚠ 待线上验收——与 `dsh-agent-cluster` §7 E4 是**同一次验收**（该节点就是最现成的无会话样本） |
| A10 | 对既有 profile 再锻造一次 ⇒ 拒绝且不改动任何文件 | **待线上验收** | ⚠ 待线上验收（离线只能验计划层，落盘拒绝路径要真跑） |
| A11 | profile 写入 `dshNodeforge` 自描述块，且 `readNodeMeta` 往返保真 | **单测已验** | ✔ U：字段逐项深度相等 + 往返。**两组尸体样本**：把读侧键名打错（读写不再一致）⇒ **2 fail**；去掉版本校验（`v=2` 也被当合法）⇒ **1 fail** |
| A12 | `readNodeMeta` 对坏形状一律 `undefined` 且**不抛**；缺字段用安全默认 | **单测已验** | ✔ U：11 个坏样本（`null` / 数组 / `v≠1` / 非对象块 / 原始值…）全部 `undefined`；缺字段得空串 / `0` / `false`，**不伪造值**（伪造 workspace 会让 `node_start` 起错地方） |

## 8. 与实现的关系

- 主实现：`src/plan.ts`（纯）+ `src/index.ts`（壳）。
- 依赖：`ctx.tools`（工具面）。**无**对其他自研插件的 import（规则：不跨插件内部 import）——与 cluster 的关系是**同样的总线文件格式 + 同样的派生规则**，不是代码复用。⚠ 该「同样的派生规则」目前是**两份独立实现**（cluster 的 `deriveNodeId` 与本插件的 `matchesProfile`）：规则一致但代码不同，**改动其一必须同步另一**（对照 cluster 语义文档 §8 与 sentinel 的「同源规则、独立实现」先例）。
- 测试：`tests/plan.test.mjs`（18 条；跑 `lib/` 产物，故先 `npm run build`）。
- 开发依赖：`js-yaml`（**只为在测试里做真解析判据**，运行时不使用）。

## 9. 实践修订记录

| 日期 | 类型 | 内容 |
|---|---|---|
| 2026-09-26 | 立项 | 主人指令「创建实例的方法也要配套跟上，最好是借助本地源码安装的 dsh，不同智能体搞个工作分区」。取证链：① 活样本 = 本机两个 DSH 进程的完整命令行（`node --expose-internals <harness>/apps/cli/lib/bin.js --profile web --no-open`）② 官方契约 = `apps/cli/reference/README.zh.md`（`--from-default-profile` 的九条行为）③ 参考实现 = `dsh-agent-watch` 的 spawn（`cwd=workspace`）④ 模板形状 = `$DSH_HOME/profiles/headless/` 四件套 ⑤ 隔离面 = `resolveBusRoot` 注释「总线不落在 DSH_HOME 内」+ `attachment-local` 的 `DSH_HOME → ~/.dsh` 解析链 |
| 2026-09-26 | **实测（YAML 转义）** | `js-yaml` 真解析对照：单引号写法下 `C:\Users\tr\.dsh-cluster` 逐字符保真；**双引号写法直接 `YAMLException: expected hexadecimal character`**。⇒ `yamlQuote()` 的「别改成双引号」从注释升级为**判据**（配尸体样本） |
| 2026-09-26 | **踩坑（peer 遮蔽）** | 挂载前必须先立 `pnpm-workspace.yaml` 的 `autoInstallPeers: false`：peer 范围 `^0.1.0-rc.6` **匹配不到**工作区 `0.1.7-rc.x`（semver 预发布规则），pnpm 会从 registry 拉副本遮蔽宿主链接层。与 `dsh-agent-cluster` 同款约定（见 `reports/dsh-升级-0.1.7-rc.2-2026-09-26.md` §4.2） |
| 2026-09-26 | **流程自纠** | 本插件是先代码后文档（§1 已标注）。补文档时顺带发现：`plan.ts` 的 `matchesProfile` 与 cluster 的 `deriveNodeId` 是**同源规则的两份实现** ⇒ 已在 §8 显式登记同步义务 |
| 2026-09-26 | **补两个缺口 + 三个实测坑（自圈驱动）** | ① **新工具 `node_start`**：N1 保护让「停掉的节点无法用工具重启」成为真缺口（只能手工起）。② **profile 自描述块 `dshNodeforge`**：把 `template`/`workspace`/`port`/`role`/`busDir`/`home`/`autoInject` 写进 profile 自己的 `package.json`，一并解决「`node_start` 不知道该怎么起」与「`node_list` 报不出真实 workspace」（**U3 由此关闭**）。③ `node_create` 暴露 `autoInject` 参数（原先写死 `false`，导致无法复现「`autoInject=true` 的无会话节点」这一 E4 的目标场景）。**三个坑全是「起得来但秒退」型，症状都像「插件没生效」**：`--no-open` 是 **web 专有**参数（headless 带它 ⇒ `unknown option` 秒退）；**`headless` 是 one-shot 不是常驻**（`dsh: a task is required`）——官方 help 那句 `answer one task, print the result, and exit` 我**读过却没过脑子**；`execFile('pnpm.cmd')` 在 Windows 上 **`spawn EINVAL`**（必须 `shell: true`）。**外加一个猜出来的包名**：sdk 真值是 `dsh-sdk-app`（初版写 `dsh-sdk`）——四个模板的 bundle 包名现已全部实测，并有测试逐字守着。 |

## 10. 未决问题

- **U1 挂载与线上验收（部分已清）**：插件已挂载到 web profile（2026-09-26 21:15）。**A8 已通过线上验收** —— `node_create` 起出的 `LAPTOP-BF4IAPLM-node-a-3090` 真的进了名册（`2 在线 / 共 6`，**12 天来第一次有第二个活节点**），派生名与角色都对。**A9（= cluster §7 E4）仍待验**：node-a 配的是 `autoInject=false` ⇒ 走的是**更早的** `held` 分支，碰不到本次修的 `no-target` 语义分类（结果正确但**验的是另一条路**）。要验 E4 需要一个 `autoInject=true` 且无会话的节点——`tavern-3081` 正是那个场景。**A10**（对既有 profile 再锻造 ⇒ 拒绝）同样待线上验收。
- **U2 `node_stop` 的 pid 重用风险**：只判「pid 存活」，不核验「那个 pid 是不是 DSH」。若心跳陈旧且 pid 被系统重用，可能误杀无关进程。候选修法：读 `/proc/<pid>` 或 `Win32_Process` 的 CommandLine 核验含 `--profile <name>`。**在补上之前，`node_stop` 只应对自己刚造的节点使用**。
- **U3 workspace 真源 → 已关闭（2026-09-26）**：`node_list` 现在**优先读 profile 的自描述块** `dshNodeforge.workspace`（真实值），读不到才退回默认规则——「自定义分区被显示成『无工作分区』」这一形态随之消失。**残留**：手工造的 profile（无该块）仍走默认规则，那是**有意的降级**而非缺陷。
- **U4 模板面偏窄**：只支持 `headless` 与 `sdk`（均为不依赖自研插件栈的随附模板）。要造「像 web 一样带完整自研栈」的节点，需要额外的 bundle 列表来源——但那条路会把主脑的器官复制到执行节点上，**先问清需求再做**。
- **U5 依赖安装的耗时与失败面**：`pnpm install` 串在锻造路径里（超时 120s，失败只告警不中止）。若将来批量造节点，应考虑「先建全部 profile、再并发装依赖」。

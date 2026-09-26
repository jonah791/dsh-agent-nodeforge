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
- **N8 数据面默认隔离**（2026-09-26 主人定调「虽然跟你共用一个 dsh，但要尽可能分离」）：新节点的 `DSH_HOME` 默认是 `<workspace>/.dsh`，**sessions / credentials / presets / storages 各自独立**；**唯一仍共享的是总线目录**——它是通信生命线，分了就互相看不见（= N3）。要共用数据面必须**显式**传 `isolatedHome: false`。

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
| A8 | **线上**：`node_create` 起出的节点真的进 `cluster_nodes` 名册 | **已实测**（2026-09-26 21:25） | ✔ E：`node_create name=node-a template=web port=3090` ⇒ 名册出现 `LAPTOP-BF4IAPLM-node-a-3090 [执行节点] · 在线`——**12 天来第一次**名册里有第二个活节点；派生名（`<host>-<profile>-<port>`）与角色都对 |
| A9 | **线上**：新节点**无用户会话**时，收到消息落 `hold-no-session`（而非重试到 `dead`） | **已实测**（2026-09-26 21:44） | ✔ E：`node-b`（`autoInject=true` + 零会话）收到 `m-muify6kr-117fc910` ⇒ **恰好 1 条** `hold-no-session`、消息留在 inbox、`attempts={}` / `failed=0` / `dead=0`。与 cluster §7 **E4 是同一次验收** |
| A10 | 对既有 profile 再锻造一次 ⇒ 拒绝且不改动任何文件 | **待线上验收** | ⚠ 待线上验收（离线只能验计划层，落盘拒绝路径要真跑） |
| A11 | profile 写入 `dshNodeforge` 自描述块，且 `readNodeMeta` 往返保真 | **单测已验** | ✔ U：字段逐项深度相等 + 往返。**两组尸体样本**：把读侧键名打错（读写不再一致）⇒ **2 fail**；去掉版本校验（`v=2` 也被当合法）⇒ **1 fail** |
| A12 | `readNodeMeta` 对坏形状一律 `undefined` 且**不抛**；缺字段用安全默认 | **单测已验** | ✔ U：11 个坏样本（`null` / 数组 / `v≠1` / 非对象块 / 原始值…）全部 `undefined`；缺字段得空串 / `0` / `false`，**不伪造值**（伪造 workspace 会让 `node_start` 起错地方） |
| A13 | **线上**：`node_start` 能起一个**已存在**的节点 | **已实测**（2026-09-26 21:43） | ✔ E：`node-a` 离线后由 `node_start` 拉起（pid 26468 · 3090 监听 · 名册回在线）。⚠ **同时暴露一个真缺陷**：对**无自描述块**的 profile，`node_start` 会**丢端口** ⇒ 落到 app 默认端口（3080 已被主 web 占）⇒ 进程起来后**立刻死**，症状是「进程起来了但名册里没有」（与 `--no-open` 同族）。**显式传 `port` 即恢复**，已当场验证。见 U6 |
| A14 | **线上**：数据面默认隔离成立——独立 home 长出 profiles/credentials/storages，主 home 里不再有它，而**通信不受影响** | **已实测**（2026-09-26 22:04） | ✔ E：重建后 `node-a` 的 home `E:\alice-nodes\node-a\.dsh\` 含 `.anonymous-user-id` · `.credentials.yaml` · `profiles/node-a/`（**自带** `node_modules` + `pnpm-lock.yaml`）· `storages/`；主 home 的 `profiles/` **已无 node-a**；两节点仍进名册（`node_list` 每行标出「独立 home」）且仍能收消息（`hold-no-session` **1 条**、消息留在 inbox、`dead/` 空、`attempts` 空） |
| A15 | **线上**：**孤儿化成立**——节点跨 web 重启存活（生命周期独立于载体） | **已实测**（2026-09-26 22:14） | ✔ E：**两次同样操作的对照**——22:12 重启时两节点是 web 的**直接子进程**（`parent=web`）⇒ **双双被杀**（pid 9072/25420 消失）；实现孤儿化后 22:14 再重启 ⇒ `node-a`(pid 12332，`parent=`**已死**的 18652) 与 `node-b`(pid 6044，`parent=`**已死**的 19216) **双双存活**、3090/3091 仍监听、名册仍在线。机制：`taskkill /T` 沿 `ParentProcessId` 链遍历，经**自灭中间层**转手后链就断（独立对照实验见 `_tmp_orphan/orphan-test.mjs`）。⚠ **范围**：只验了「重启 web」这条**主路径**；`killWeb` 的其它调用路径（L786/L916/L918）未测 |

## 8. 与实现的关系

- 主实现：`src/plan.ts`（纯）+ `src/index.ts`（壳）。
- 依赖：`ctx.tools`（工具面）。**无**对其他自研插件的 import（规则：不跨插件内部 import）——与 cluster 的关系是**同样的总线文件格式 + 同样的派生规则**，不是代码复用。⚠ 该「同样的派生规则」目前是**两份独立实现**（cluster 的 `deriveNodeId` 与本插件的 `matchesProfile`）：规则一致但代码不同，**改动其一必须同步另一**（对照 cluster 语义文档 §8 与 sentinel 的「同源规则、独立实现」先例）。
- 测试：`tests/plan.test.mjs`（**24 条**；跑 `lib/` 产物，故先 `npm run build`）。⚠ **测不到的部分如实标注**：`spawnDetached()` 与孤儿化行为**不是纯函数**（要真起进程），离线测不了——它们的判据是**线上验收 A15**（跨 web 重启存活），不靠单测。
- 开发依赖：`js-yaml`（**只为在测试里做真解析判据**，运行时不使用）。

## 9. 实践修订记录

| 日期 | 类型 | 内容 |
|---|---|---|
| 2026-09-26 | 立项 | 主人指令「创建实例的方法也要配套跟上，最好是借助本地源码安装的 dsh，不同智能体搞个工作分区」。取证链：① 活样本 = 本机两个 DSH 进程的完整命令行（`node --expose-internals <harness>/apps/cli/lib/bin.js --profile web --no-open`）② 官方契约 = `apps/cli/reference/README.zh.md`（`--from-default-profile` 的九条行为）③ 参考实现 = `dsh-agent-watch` 的 spawn（`cwd=workspace`）④ 模板形状 = `$DSH_HOME/profiles/headless/` 四件套 ⑤ 隔离面 = `resolveBusRoot` 注释「总线不落在 DSH_HOME 内」+ `attachment-local` 的 `DSH_HOME → ~/.dsh` 解析链 |
| 2026-09-26 | **实测（YAML 转义）** | `js-yaml` 真解析对照：单引号写法下 `C:\Users\tr\.dsh-cluster` 逐字符保真；**双引号写法直接 `YAMLException: expected hexadecimal character`**。⇒ `yamlQuote()` 的「别改成双引号」从注释升级为**判据**（配尸体样本） |
| 2026-09-26 | **踩坑（peer 遮蔽）** | 挂载前必须先立 `pnpm-workspace.yaml` 的 `autoInstallPeers: false`：peer 范围 `^0.1.0-rc.6` **匹配不到**工作区 `0.1.7-rc.x`（semver 预发布规则），pnpm 会从 registry 拉副本遮蔽宿主链接层。与 `dsh-agent-cluster` 同款约定（见 `reports/dsh-升级-0.1.7-rc.2-2026-09-26.md` §4.2） |
| 2026-09-26 | **流程自纠** | 本插件是先代码后文档（§1 已标注）。补文档时顺带发现：`plan.ts` 的 `matchesProfile` 与 cluster 的 `deriveNodeId` 是**同源规则的两份实现** ⇒ 已在 §8 显式登记同步义务 |
| 2026-09-26 | **补两个缺口 + 三个实测坑（自圈驱动）** | ① **新工具 `node_start`**：N1 保护让「停掉的节点无法用工具重启」成为真缺口（只能手工起）。② **profile 自描述块 `dshNodeforge`**：把 `template`/`workspace`/`port`/`role`/`busDir`/`home`/`autoInject` 写进 profile 自己的 `package.json`，一并解决「`node_start` 不知道该怎么起」与「`node_list` 报不出真实 workspace」（**U3 由此关闭**）。③ `node_create` 暴露 `autoInject` 参数（原先写死 `false`，导致无法复现「`autoInject=true` 的无会话节点」这一 E4 的目标场景）。**三个坑全是「起得来但秒退」型，症状都像「插件没生效」**：`--no-open` 是 **web 专有**参数（headless 带它 ⇒ `unknown option` 秒退）；**`headless` 是 one-shot 不是常驻**（`dsh: a task is required`）——官方 help 那句 `answer one task, print the result, and exit` 我**读过却没过脑子**；`execFile('pnpm.cmd')` 在 Windows 上 **`spawn EINVAL`**（必须 `shell: true`）。**外加一个猜出来的包名**：sdk 真值是 `dsh-sdk-app`（初版写 `dsh-sdk`）——四个模板的 bundle 包名现已全部实测，并有测试逐字守着。 |
| 2026-09-26 | **默认翻转：数据面隔离（主人定调）** | 主人：「虽然跟你共用一个 dsh，但要尽可能分离，最好是独立进程」。**先澄清事实**：节点**本来就是独立进程**（各自 pid / 端口 / 内存，`spawn(detached)+unref` 起；取证：23964 / 26468 / 7340 三个独立 node 进程，3080 / 3090 / 3091 各归其主）；**没分离的是数据面**（profiles / sessions / credentials / presets 共用 `E:\alice\.dsh`）。⇒ 把 `isolatedHome` 默认从 `false` **翻转为 `true`**：每节点 `DSH_HOME` = `<workspace>/.dsh`，**唯一仍共享的是总线目录**（通信生命线，分了就互相看不见 = N3）。**连带必修**：`node_list` 原先只扫主 home 的 `profiles/`，默认隔离后会让**绝大多数节点隐形**（那是「仪器看不见」，不是「节点不存在」）⇒ 改为**扫两处**（主 home 的 `profiles/` + `nodesRoot/*/.dsh/profiles/`），并在每行标出「独立 home / 共用 home」。**实测验收**：重建后的 `node-a` / `node-b` 各自长出 `.anonymous-user-id` / `.credentials.yaml` / `profiles/<name>/`（含自己的 `node_modules` 与 `pnpm-lock.yaml`）/ `storages/`，主 home 里已无它们；两节点仍进名册、仍能收消息（`hold-no-session` 照常、消息留在 inbox、`attempts` 空）。 |
| 2026-09-26 | **孤儿化：节点生命周期真正独立（对照实验驱动）** | 承接上一条的「独立进程」诉求——**进程独立只是半句**：节点是 web 的子进程，而守护 `killWeb()` 用 `taskkill ['/T','/F','/PID']`（杀**整棵进程树**）⇒ web 重启时被**连带杀掉**（21:41 实测 pid 26468/7340 双双消失）。**关键实测**：`taskkill /T` **沿 `ParentProcessId` 链**遍历 ⇒ 经一个**自灭的中间层**转手后，链就断了。**独立对照实验**（`_tmp_orphan/orphan-test.mjs`；**绝不对真 web 跑 taskkill**）：同一次 `taskkill /T /F /PID <parent>` 下——直接子进程**死**、经中间层转手的**活**。⇒ 新增 `scripts/spawn-detached.mjs`（spawn 真进程后立刻退出；日志 fd 由它打开并交给子进程；**留 150ms 窗口**让 spawn 的异步 `error` 能留痕——否则「起不来」= 静默失败）+ `index.ts` 的 `spawnDetached()`（两处 spawn 统一走它；提交 `8f305d7`）。⚠ **语义变化**：工具返回的 `pid` 是**启动器**的（约 150ms 后自灭）⇒ **真节点 pid 要等心跳落盘后从 `cluster_nodes` 读**。**线上决定性验证（A15）**：22:14 重启 web 后两节点（`parent=` **已死的**启动器）**双双存活**、3090/3091 仍监听；对照 22:12 那次（`parent=web`）**双双被杀**。 |

## 10. 未决问题

- **U1 挂载与线上验收 → 已基本清（2026-09-26）**：插件已挂载到 web profile（21:15）。**A8 已验**（`node_create` 起出的节点进名册——12 天来第一次名册里有第二个活节点）；**A9 已验**（`node-b` 以 `autoInject=true` + **零会话**收到消息 ⇒ **1 条 `hold-no-session`**、消息留在 inbox、`attempts` 空、`dead` 空——与 cluster §7 **E4 是同一次验收**）；**A13 / A14 / A15 亦已验**。**残留**：**A10**（对既有 profile 再锻造 ⇒ 拒绝且不改动任何文件）仍待线上验收——离线只覆盖了计划层，落盘拒绝路径要真跑一次。
- **U2 `node_stop` 的 pid 重用风险**：只判「pid 存活」，不核验「那个 pid 是不是 DSH」。若心跳陈旧且 pid 被系统重用，可能误杀无关进程。候选修法：读 `/proc/<pid>` 或 `Win32_Process` 的 CommandLine 核验含 `--profile <name>`。**在补上之前，`node_stop` 只应对自己刚造的节点使用**。
- **U3 workspace 真源 → 已关闭（2026-09-26）**：`node_list` 现在**优先读 profile 的自描述块** `dshNodeforge.workspace`（真实值），读不到才退回默认规则——「自定义分区被显示成『无工作分区』」这一形态随之消失。**残留**：手工造的 profile（无该块）仍走默认规则，那是**有意的降级**而非缺陷。
- **U4 模板面 → 已扩到四个（2026-09-26 关闭原缺口）**：现支持 `web`（**缺省·常驻**）/ `sdk` / `acp` / `headless`（one-shot），四者的 bundle 包名全部**实测**（用独立 `DSH_HOME` 跑 `--from-default-profile <t> --dump-config` 读回 manifest），并有测试逐字守着。**残留（有意不做）**：「像本地 web profile 那样带**完整自研插件栈**」的节点——那条路会把主脑器官（evolution / selftest / plugin-manager / telegram…）复制到执行节点上，与 P2-5「执行节点无直达主人通道」**直接冲突**。真要做也只能是**显式白名单**，且先问清需求。
- **U5 依赖安装的耗时与失败面**：`pnpm install` 串在锻造路径里（超时 120s，失败只告警不中止）。若将来批量造节点，应考虑「先建全部 profile、再并发装依赖」。
- **U6 无自描述块的老 profile：`node_start` 会丢端口（2026-09-26 实测发现）**：自描述块是**分批上线**的，**先造后加**的 profile（如 `node-a`：21:25 造，而 meta 功能 21:36 才有）没有 `dshNodeforge` 块 ⇒ 三级回退（显式参数 > 自描述块 > 默认规则）里 `port` 只能落到 `0`（**不传 `--port`**）⇒ web app 用默认端口（**3080，已被主 web 占用**）⇒ 进程**起得来但立刻死**，症状是「进程起来了，名册里却没有」——与 `--no-open` 那个坑**同族**。当场验证：显式传 `port: 3090` 即恢复（pid 26468 · 3090 监听 · 名册回在线）。**候选修法**：① 最简——`note` 里对「无 meta」情形**响亮警告端口风险**（当前只说「元信息来源：默认规则」，语气太轻）；② 更稳——`node_start` 加一步「**回填**自描述块」（读不到 meta 时按实际使用的参数补写一次，让 profile **自愈**成自描述）；③ 治本——把端口写进**与 profile 解耦的位置**（如 workspace 里的标记文件）。**倾向 ②**：它同时解决「老 profile 永久缺信息」与「每次起都要人记端口」。
- **U7 节点活不过 web 重启 → 已解决（2026-09-26 22:14 线上验证）**：**真因**在守护侧——`dsh-agent-watch` 的 `killWeb()` 用 `execFile('taskkill', ['/T','/F','/PID', pid])`（`/T` = 杀整棵进程树），而节点是本插件 `spawn` 的**子进程** ⇒ web 重启时被**连带杀掉**（21:41 实测 pid 26468/7340 双双消失）。**解法的关键实测**：`taskkill /T` **沿 `ParentProcessId` 链**遍历 ⇒ 经一个**自灭的中间层**转手后，链就断了。**独立对照实验**（`_tmp_orphan/orphan-test.mjs`；**绝不对真 web 跑 taskkill**）：同一次 `taskkill /T /F /PID <parent>` 下——直接子进程**死**、经中间层转手的**活**。⇒ 实现 `scripts/spawn-detached.mjs` + `spawnDetached()`（提交 `8f305d7`），`node_create` 与 `node_start` 两处 spawn 统一走它。**线上决定性验证**：22:14 重启 web 后 `node-a`(pid 12332，parent=**已死的** 18652) 与 `node-b`(pid 6044，parent=**已死的** 19216) **双双存活**、3090/3091 仍监听；对照 22:12 那次（它们是 web 的直接子进程）**双双被杀**。**边界（未测）**：`killWeb` 的其它调用路径（L786/L916/L918）是否同样只沿父子链；跨机器 / 跨用户场景未验。
- **U8 独立 home 的节点拿不到主 home 的 presets（性质：设计后果，不是缺陷）**：数据面分离后节点用自己的 `$DSH_HOME/.agent-presets/`——初始为空 ⇒ 它以 **bundle 默认**行为运行，**不继承**我（web）的预设（如 `alice-v2`）。**这正是隔离要的效果**（执行节点不该带主脑器官），但也意味着「要让节点有角色/个性，得在它自己的 home 里配」——`node_create` 目前**不代配预设**。若将来要「造节点时顺带装一份 worker 预设」，须显式列进契约（并说明内容来源）。

<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: DSH 智能体实例锻造：把「起一个新的节点」变成一条命令——独立工作分区 + profile 骨架 + cluster 配置 + 进程管理，带 web/watch 保护名单
  inject: 'tools'
  tools: node_create,node_list,node_start,node_stop,node_retire,manor_roster
  runtime: host-only
  envDeps: 无（spawn 走宿主 node，经孤儿化启动器转手）
  boundary: 不覆盖已存在的 profile（拒绝而非静默改写）；**web / watch 在保护名单内，拒绝停止**；节点退役只移不删（可手工搬回）
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools >=0.1.0-rc.6
-->
# dsh-agent-nodeforge

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-nodeforge"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-60%20passed-brightgreen" alt="tests">
</p>

**一句话**：把「**起一个新的 DSH 智能体节点**」从一堆手工步骤变成一条命令——建工作分区、写 profile 骨架、配 cluster、起进程，全自动。

**为什么值得用**：手工起一个节点要同时处理四件事（profile 骨架字段、cluster 总线配置、link 依赖、进程启动方式），任何一处错都表现为「节点起来了但看不见」或「起不来但没报错」。本插件把四件事固化成一条 `node_create`，并且**带三道拒绝**：已存在的 profile **一律拒绝覆盖**（不静默改写）；`web` / `watch` 在**保护名单**内，`node_stop` 拒绝停止；节点退役**只移不删**（`_retired/`，可手工搬回）。

## 能力

**工具面 6 个**（名称逐字来自 `src/index.ts` 的 `defineTool({ name })`）：

| 工具 | 用途 |
|------|------|
| `node_create` | 锻造一个新节点：工作分区 + profile 骨架（照官方模板逐字段对齐）+ cluster 配置（共用总线）+ link 依赖 + 起进程。`dryRun` 只出计划；`start:false` 只落盘不起进程；**已存在的 profile 一律拒绝覆盖** |
| `node_list` | 列本机节点：profile 目录（装配真源）与总线名册（身份真源）**对照**——答「谁有 profile、谁在名册里、谁真的在线」，含没有名册身份的孤儿 profile |
| `node_start` | 起一个**已存在**的节点（profile 已在盘上）。先在**各数据面**定位 profile（共享 home + 独立 home 布局 + nodesRoot 分区），不假设与本实例共用 home；不写任何文件；profile 不存在 ⇒ 明确拒绝并列出探测过的数据面 |
| `node_stop` | 停一个本机节点（pid 取自总线心跳）。**带保护名单**：`web`（当前载体）与 `watch`（守护）一律拒绝 |
| `node_retire` | 把**已离线**的节点从名册退役（条目与状态文件**移入** `_retired/`，**只移不删**，可手工搬回）。三条硬拒绝：找不到的不清 · **在线的不清** · 庄园成员不清（须显式 `includeMembers`） |
| `manor_roster` | 庄园名册视图（与 `dsh-manor` 的分工见其文档） |

## 快速开始

**1) 装依赖**：

```jsonc
"dsh-agent-nodeforge": "link:E:/alice/self-plugins/dsh-agent-nodeforge"
```

**2) 挂组合**：

```yaml
- id: nodeforge
  name: dsh-agent-nodeforge
```

**3) 30 秒验证**：`node_create {name: "probe-node", dryRun: true}` → 应返回**计划**（工作分区路径 / profile 字段 / cluster 配置 / 将执行的命令），**不落盘、不起进程**；再 `node_list` → 应列出本机现有节点及其「独立 home / 共用 home」标注。

## 配置

| 项 | 默认 | 说明 |
|---|---|---|
| `nodesRoot` | 见源码 `Config` | 节点工作分区根（缺省布局下节点各自成区） |
| `isolatedHome` | `true` | **每节点一套数据面**（sessions / credentials / presets 各自独立）；`false` = 与本实例共用（轻，但凭据不分家） |
| `busDir` | 见源码 | 集群总线目录（**唯一仍共享的东西**——分了就互相看不见） |

## 落盘与自证

| 落点 | 何时写 | 内容 |
|---|---|---|
| `<nodesRoot>/<name>/` | `node_create` | 节点工作分区（含 profile 骨架与 `.dsh/` 数据面，若 `isolatedHome`） |
| 总线名册 / 状态文件 | 节点运行时 | 心跳与身份（`node_list` 的**身份真源**） |
| `_retired/` | `node_retire` | 退役节点的名册条目与状态文件（**移入，不删除**） |

**一条命令答五问**：`node_list` 一屏给出「谁有 profile / 谁在名册 / 谁在线 / 谁是孤儿 / 数据面在哪」。

## 生效判据与回退

**怎么证明线上跑的是当前构建**：行为级（本会话工具面有 `node_*`）+ 构建级（`lib/index.js` mtime 晚于 web 进程启动时间；⚠ 重新构建 ≠ 生效）。
**回退**：① `git revert` + 重建 + 预检重启；② patch 行 `disabled: true`；③ 已造出的节点是**独立进程 + 独立数据面**，停用插件不影响它们继续跑。

## 测试

```bash
cd self-plugins/dsh-agent-nodeforge && npm test
```

**60 条用例**（跑一次得到）：覆盖 profile 探测四条真实布局（含 `isolatedHome` 的独立 home 与共享 home 两种）、**保护名单拒绝**（web/watch）、退役三拒绝、`dryRun` 零副作用、孤儿 profile 呈现。无需网络。

## 设计要点

- **不覆盖已存在的 profile**：宁可拒绝也不静默改写别人的装配——「拒绝」是防线在工作，不是故障。
- **保护名单落在候选名上**，不依赖调用方自觉：`node_stop` 对 `web` / `watch` 一律拒绝。
- **退役只移不删**：`_retired/` 保留全部痕迹，可手工搬回。
- **数据面隔离是默认**：节点**本来就是独立进程**；默认再把**数据面**分开（唯一仍共享的是总线——通信生命线）。
- **探测而非假设**：`node_start` 按序列出四条真实布局的候选路径，一个都不存在才判「真没造过」。

## 相关文档

- [`docs/semantic.md`](docs/semantic.md) —— **权威契约**（含 N1–N9 不变量与实测验收表）
- 中心仓：[alice-digital-life](https://github.com/jonah791/alice-digital-life)（本插件归 **治理层**）
- 相关插件：[`dsh-manor`](https://github.com/jonah791/dsh-manor)（庄园成员调度）、[`dsh-agent-cluster`](https://github.com/jonah791/dsh-agent-cluster)（总线）

## License

MIT © jonah791

---

本插件属于**爱丽丝 DSH 自研插件生态**（[alice-digital-life](https://github.com/jonah791/alice-digital-life) · 73 个插件 · 8 个模块）：单一职责、独立仓库、独立可用。

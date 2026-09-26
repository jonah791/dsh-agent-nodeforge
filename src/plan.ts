/**
 * plan.ts — 节点锻造的**纯计划层**（零 IO、零进程、零环境读取 ⇒ 可离线全量测）。
 *
 * 存在理由：把「起一个新的 DSH 实例」从**一次性手工操作**变成**可复算的计划**。
 * 计划的形状照抄官方 profile 模板（2026-09-26 取证：`$DSH_HOME/profiles/headless/` 的
 * 四件套 = `package.json` + `cordis.yml` + `cordis.patch.yml` + `pnpm-workspace.yaml`），
 * 逐字段对齐——**形状对不上就会随版本漂移**。
 *
 * 隔离语义（三个层次，互不替代）：
 *   - **profile** = 装配（装哪些插件、怎么配）
 *   - **workspace** = 工作分区（子进程 cwd；DSH 的会话存储本就按 workspace 分目录）
 *   - **home** = 数据面（sessions / credentials / presets）。共享 = 轻（秒级起），
 *     隔离 = 重（每 home 要独立装配与凭据）——用于需要身份隔离的对外节点。
 */

/** 随附（in-box）profile 名：不能作为新建目标名，且它们的 bundle 从安装目录解析、无需安装。 */
export const SHIPPED_PROFILES = ['web', 'headless', 'sdk', 'sdk-minimal', 'acp'] as const

/** 保留名：即使不在随附列表中也不许占用（`desktop` 归 Electron；`watch` 是本机守护）。 */
export const RESERVED_NAMES = ['desktop', 'watch'] as const

/** 随附模板 → 它的 bundle 列表（照官方模板复制；只收**不依赖自研插件栈**的模板）。 */
export const TEMPLATE_BUNDLES: Record<string, readonly string[]> = {
  headless: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
  sdk: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk'],
}

/** 节点规格（调用方给全，本模块不读环境）。 */
export interface NodeSpec {
  /** 节点名 = profile 名（也用于派生节点 id：`<host>-<name>-<port>`）。 */
  name: string
  /** 随附模板名（见 `TEMPLATE_BUNDLES`）。 */
  template: string
  /** 工作分区绝对路径（子进程 cwd）。 */
  workspace: string
  /** harness 安装根（须含 `apps/cli/lib/bin.js`）。 */
  harnessRoot: string
  /** 本节点的 DSH_HOME。 */
  home: string
  /** 总线根——**所有要互通的实例必须同一值**（否则互相看不见）。 */
  busDir: string
  /** 名册展示用的角色标签。 */
  role: string
  /** 端口；`0` = 不指定（由 app 决定）。 */
  port: number
  /** 是否自动把收到消息注入会话；执行节点常置 `false`（由适配器读 mailbox）。 */
  autoInject: boolean
  /** 该节点的 cluster 插件包路径（`link:` 依赖用）。 */
  clusterPluginPath: string
}

/** 一个待落盘文件。 */
export interface PlannedFile {
  path: string
  content: string
  /** `create` = 已存在则**拒绝**（保护既有 profile / 用户改动）；`overwrite` = 覆盖。 */
  mode: 'create' | 'overwrite'
}

/** 启动形状（与 `dsh-agent-watch` 的 spawn 逐字段同形——那是已验证的参考实现）。 */
export interface LaunchPlan {
  cmd: string[]
  cwd: string
  env: Record<string, string>
}

/** 节点计划：要写哪些文件 + 怎么起 + 注意事项。 */
export interface NodePlan {
  files: PlannedFile[]
  launch: LaunchPlan
  warnings: string[]
}

/** 校验结果（fail-loud：说清为什么不合法）。 */
export type NameCheck = { ok: true } | { ok: false; reason: string }

/**
 * YAML 单引号标量转义。
 *
 * ⚠ **别改成双引号**：本模块要写进 YAML 的字符串大量是 Windows 路径（`C:\Users\…`），
 * 而 YAML 双引号里 `\` 是转义起始符 ⇒ `"C:\Users"` 会被解析成 `C:Users`（静默吃字符）。
 * 单引号里只有 `'` 需要翻倍，其余（含 `\` `"` `#` `:`）全部字面量。
 * @param s - 原始字符串
 */
export function yamlQuote(s: string): string {
  return "'" + s.replaceAll("'", "''") + "'"
}

/**
 * 校验节点名可否用作新建目标。
 * 规则来源：官方 `--from-default-profile` 契约（目标名不能是随附 profile 名、目标目录必须不存在）
 * + 本机保留名（`desktop` 归 Electron、`watch` 是正在跑的守护）。
 * @param name - 候选名
 */
export function validateNodeName(name: string): NameCheck {
  const n = name.trim()
  if (n === '') return { ok: false, reason: '名字为空' }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(n)) {
    return { ok: false, reason: '名字只能用「小写字母 / 数字 / 连字符」，且以字母数字开头：' + n }
  }
  if ((SHIPPED_PROFILES as readonly string[]).includes(n)) {
    return { ok: false, reason: '名字撞随附 profile（' + SHIPPED_PROFILES.join(' / ') + '）——官方契约禁止：' + n }
  }
  if ((RESERVED_NAMES as readonly string[]).includes(n)) {
    return { ok: false, reason: '名字是本机保留名（' + RESERVED_NAMES.join(' / ') + '）：' + n }
  }
  return { ok: true }
}

/** 路径拼接（避免依赖平台 path 模块——纯层只做字符串规则，分隔符由调用方给的绝对路径体现）。 */
const joinPath = (base: string, ...parts: string[]): string => {
  const sep = base.includes('\\') ? '\\' : '/'
  const trimmed = base.replace(/[\\/]+$/, '')
  return [trimmed, ...parts.map((p) => p.replace(/^[\\/]+/, ''))].join(sep)
}

/**
 * 生成一个节点的完整计划（**纯函数**：给全 spec ⇒ 给全文件内容与启动形状）。
 * @param spec - 节点规格
 */
export function planNode(spec: NodeSpec): NodePlan {
  const warnings: string[] = []
  const bundles = TEMPLATE_BUNDLES[spec.template]
  if (bundles === undefined) {
    // 不抛：计划层返回可诊断的告警，由壳层决定是否中止（纯层不出局）。
    warnings.push('未知模板 ' + spec.template + '（已知：' + Object.keys(TEMPLATE_BUNDLES).join(' / ') + '）⇒ 该 profile 无 bundle，起不来')
  }
  const profileDir = joinPath(spec.home, 'profiles', spec.name)
  const bundleList = bundles ?? []

  const profilePkg = {
    name: 'dsh-profile-' + spec.name,
    private: true,
    // 依赖只有 cluster 插件一条 **link**（bundle 本身是 in-box，从 dsh 安装目录解析，不需要装）。
    dependencies: { 'dsh-agent-cluster': 'link:' + spec.clusterPluginPath },
    dsh: { profile: { bundles: bundleList } },
  }

  const patchYml = [
    '# 由 dsh-agent-nodeforge 生成 —— 本节点的装配覆盖层。',
    '# 改这里即可调整该节点的插件与配置；不要手工改 cordis.yml（它恒为空，装配靠 patch 叠加）。',
    '- insert:',
    '    - id: agent-cluster',
    '      name: dsh-agent-cluster',
    '      config:',
    '        role: ' + yamlQuote(spec.role),
    '        profile: ' + yamlQuote(spec.name),
    '        busDir: ' + yamlQuote(spec.busDir),
    '        autoInject: ' + String(spec.autoInject),
    '        # 执行节点不参与主脑选举、不自动续租（省电 + 不抢主脑）。',
    '        leaderEligible: false',
    '        leaderAutoRenew: false',
    ...(spec.port > 0 ? ['        port: ' + String(spec.port)] : []),
    '',
  ].join('\n')

  const files: PlannedFile[] = [
    { path: joinPath(profileDir, 'package.json'), content: JSON.stringify(profilePkg, null, 2) + '\n', mode: 'create' },
    { path: joinPath(profileDir, 'cordis.yml'), content: '# dsh profile root —— 恒为空；装配靠 patch 叠加。\n[]\n', mode: 'create' },
    { path: joinPath(profileDir, 'cordis.patch.yml'), content: patchYml, mode: 'create' },
    {
      path: joinPath(profileDir, 'pnpm-workspace.yaml'),
      // autoInstallPeers: false —— 2026-09-26 实测：pnpm 11.7.0 不再从 .npmrc 读该设置，
      // 而 peer 范围匹配不到工作区版本时，pnpm 会从 registry 拉副本**遮蔽宿主链接层**。
      content: 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
      mode: 'create',
    },
  ]

  const bin = joinPath(spec.harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
  const cmd = [
    process.execPath,
    '--expose-internals',
    bin,
    '--profile',
    spec.name,
    ...(spec.port > 0 ? ['--port', String(spec.port)] : []),
    '--no-open',
  ]

  return {
    files,
    launch: {
      cmd,
      cwd: spec.workspace,
      env: {
        DSH_HOME: spec.home,
        // Node 内置 fetch 自动走系统代理（对外 API 必需；与守护同款设置）。
        NODE_USE_ENV_PROXY: '1',
      },
    },
    warnings,
  }
}

/**
 * 本机节点全貌里的一条（`node_list` 用）。
 * @param name - profile 名
 * @param profileExists - profile 目录是否存在
 * @param workspaceExists - 工作分区是否存在
 * @param pid - 在跑的进程号（`null` = 没在跑）
 */
export interface NodeRow {
  name: string
  profileExists: boolean
  workspaceExists: boolean
  pid: number | null
}

/** 一行可读摘要（工具面 render 用；纯函数便于测格式）。 */
export function describeNodeRow(r: NodeRow): string {
  const state = r.pid !== null ? '运行中 pid=' + String(r.pid) : '未运行'
  const parts = [r.name, state]
  if (!r.profileExists) parts.push('无 profile')
  if (!r.workspaceExists) parts.push('无工作分区')
  return parts.join(' · ')
}

/**
 * 停止前的**白名单保护**：这两个 profile 是当前载体，停掉就是自杀。
 * 判据是**候选名**而非进程号——名字错了会被这里挡下，不依赖调用方自觉。
 * @param name - 待停节点名
 */
export function stopGuard(name: string): NameCheck {
  const n = name.trim()
  if (n === 'web') return { ok: false, reason: 'web 是当前主载体（正在服务 GUI 与会话）——拒绝停止' }
  if (n === 'watch') return { ok: false, reason: 'watch 是守护进程（负责拉起与自愈）——拒绝停止' }
  if (n === '') return { ok: false, reason: '未指定节点名' }
  return { ok: true }
}

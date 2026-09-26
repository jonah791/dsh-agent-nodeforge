/**
 * dsh-agent-nodeforge — 把「起一个新的 DSH 智能体实例」变成一条命令。
 *
 * **三层职责**（对照 `docs/semantic.md` §1）：
 *   - 纯计划层 `plan.ts`：给全 spec ⇒ 给全文件内容与启动形状（零 IO，可离线全量测）
 *   - 本文件（壳）：落盘 / 装依赖 / 起进程 / 工具面
 *
 * **与 dsh-agent-cluster 的分工**：cluster 管「已经存在的节点怎么互相说话」；
 * nodeforge 管「节点从哪来」。两者共用同一个总线根（`busDir` 必须一致才互相看得见）。
 *
 * ⚠ **本插件与宿主同进程**（§5.24）：所有回调 `guarded()`、spawn 必挂 `error`、
 * 观测落盘一律吞错返回 bool——逃逸异常会**直接杀死 web**。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, hostname as osHostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  describeNodeRow, planNode, readNodeMeta, stopGuard, validateNodeName,
  SHIPPED_PROFILES, TEMPLATE_BUNDLES, type NodeRow, type NodeSpec,
} from './plan.ts'

export const name = 'agent-nodeforge'
export const inject = ['tools'] as const

/** 插件配置（全部可部署期覆盖）。 */
export interface Config {
  /** 总开关。 */
  enabled: boolean
  /** 本机 DSH_HOME（新节点的 profile 落在这里；空 = `$DSH_HOME` 或 `~/.dsh`）。 */
  home: string
  /** 总线根（**必须与 cluster 插件一致**；空 = `~/.dsh-cluster`）。 */
  busDir: string
  /** 节点工作分区根（空 = 与 DSH_HOME 同级目录下的 `dsh-nodes`）。 */
  nodesRoot: string
  /** harness 安装根（含 `apps/cli/lib/bin.js`；空 = 从本进程 argv 推导）。 */
  harnessRoot: string
  /** cluster 插件路径（写进新 profile 的 link 依赖；空 = 推导为 nodeforge 的兄弟目录）。 */
  clusterPluginPath: string
  /** 装依赖超时（ms）。 */
  installTimeoutMs: number
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  home: z.string().default(''),
  busDir: z.string().default(''),
  nodesRoot: z.string().default(''),
  harnessRoot: z.string().default(''),
  clusterPluginPath: z.string().default(''),
  installTimeoutMs: z.number().default(120_000),
})

/** 工具参数（宽松形状：`parameters` 只做展示与提示，取值自己校验）。 */
interface ToolArgs {
  name?: unknown
  template?: unknown
  workspace?: unknown
  port?: unknown
  role?: unknown
  isolatedHome?: unknown
  autoInject?: unknown
  dryRun?: unknown
  start?: unknown
}

const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** `node_create` 的返回形状（三处早退共用；`output.schema` 要求字段齐全）。 */
interface CreateResult {
  ok: boolean
  name: string
  profileDir: string
  workspace: string
  busDir: string
  filesWritten: string[]
  filesRefused: string[]
  errors: string[]
  warnings: string[]
  pid: number
  note: string
}

const createFail = (name: string, profileDir: string, workspace: string, busDir: string, reason: string): CreateResult => ({
  ok: false, name, profileDir, workspace, busDir,
  filesWritten: [], filesRefused: [], errors: [], warnings: [], pid: 0, note: reason,
})

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return

  // ── 路径真源 ────────────────────────────────────────────────────────────────
  // §5.16 规则 2：配置里的身份型字段一律是**锚点**不是真源——锚点可用则用之，
  // 否则回退运行时真源。这里两个真源都取自「本插件自己是怎么被启动的」：
  //   · harnessRoot ← argv[1]（launcher 脚本路径）——本进程正在跑就是最硬的证据
  //   · clusterPluginPath ← 本模块文件位置（两插件是兄弟目录）
  const selfDir = dirname(fileURLToPath(import.meta.url))
  const harnessRootOf = (): string => {
    const c = config.harnessRoot.trim()
    if (c !== '') return c
    const argv1 = process.argv[1] ?? ''
    // <harness>/apps/cli/lib/bin.js → 上溯三层
    if (argv1.includes(join('apps', 'cli', 'lib'))) return resolve(dirname(argv1), '..', '..', '..')
    return ''
  }
  const clusterPathOf = (): string => {
    const c = config.clusterPluginPath.trim()
    if (c !== '') return c
    // <self-plugins>/dsh-agent-nodeforge/lib → <self-plugins>/dsh-agent-cluster
    return resolve(selfDir, '..', '..', 'dsh-agent-cluster')
  }
  const homeOf = (): string => {
    const c = config.home.trim()
    if (c !== '') return c
    const e = (process.env['DSH_HOME'] ?? '').trim()
    return e !== '' ? e : join(homedir(), '.dsh')
  }
  const busDirOf = (): string => {
    const c = config.busDir.trim()
    if (c !== '') return c
    return join(homedir(), '.dsh-cluster')
  }
  const nodesRootOf = (): string => {
    const c = config.nodesRoot.trim()
    if (c !== '') return c
    return join(dirname(homeOf()), 'dsh-nodes')
  }

  // ── 观测（§5.22：机制必须自证；§5.24：观测绝不反噬） ──────────────────────────
  const trace = (phase: string, detail: Record<string, unknown> = {}): boolean => {
    try {
      appendFileSync(join(homeOf(), 'nodeforge-trace.jsonl'), JSON.stringify({ atMs: Date.now(), phase, ...detail }) + '\n')
      return true
    } catch {
      return false
    }
  }
  /** 兜底：回调内逃逸异常会杀死宿主（§5.24）。 */
  const guarded = (where: string, fn: () => void): void => {
    try {
      fn()
    } catch (e) {
      trace('guarded-error', { where, error: String(e) })
    }
  }

  // ── 落盘 ────────────────────────────────────────────────────────────────────
  const writePlan = (files: { path: string; content: string; mode: 'create' | 'overwrite' }[]): { written: string[]; refused: string[]; errors: string[] } => {
    const written: string[] = []
    const refused: string[] = []
    const errors: string[] = []
    for (const f of files) {
      try {
        if (f.mode === 'create' && existsSync(f.path)) {
          // 保护：既有 profile 一律不覆盖（含用户手工改动）。宁可拒绝，不可静默改装配。
          refused.push(f.path)
          continue
        }
        mkdirSync(dirname(f.path), { recursive: true })
        writeFileSync(f.path, f.content, 'utf8')
        written.push(f.path)
      } catch (e) {
        errors.push(f.path + ' :: ' + String(e))
      }
    }
    return { written, refused, errors }
  }

  // ── 名册（读总线，不查进程表——跨平台且与 cluster 同一真源） ──────────────────
  interface RosterEntry {
    nodeId: string
    pid: number | null
    atMs: number
  }
  const readRoster = (): RosterEntry[] => {
    const dir = join(busDirOf(), 'nodes')
    let names: string[] = []
    try {
      names = readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch {
      return []
    }
    const out: RosterEntry[] = []
    for (const f of names) {
      try {
        const raw = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, unknown>
        out.push({
          nodeId: str(raw['nodeId'], f.replace(/\.json$/, '')),
          pid: typeof raw['pid'] === 'number' ? raw['pid'] : null,
          atMs: typeof raw['atMs'] === 'number' ? raw['atMs'] : 0,
        })
      } catch {
        // 坏心跳（含全 NUL 文件）跳过——与 cluster 同语义：坏数据不崩主流程。
      }
    }
    return out
  }
  /**
   * 名册条目是否属于某个 profile。
   * 判据用**主机名前缀**（`<host>-<profile>` / `<host>-<profile>-<port>`，即 cluster 的派生规则），
   * 而不是「nodeId 里含 `-<name>-`」——后者会让 profile `a` 误配到 `…-node-a-0`。
   */
  const matchesProfile = (nodeId: string, profileName: string): boolean => {
    const host = osHostname()
    return nodeId === host + '-' + profileName || nodeId.startsWith(host + '-' + profileName + '-')
  }
  const pidAlive = (pid: number | null): boolean => {
    if (pid === null || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (err) {
      return (err as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  /** 列本机节点：profile 目录（装配真源）+ 总线名册（身份真源）对照。 */
  const listNodes = (): { rows: (NodeRow & { rosterNodeId: string; online: boolean })[]; profilesDir: string } => {
    const profilesDir = join(homeOf(), 'profiles')
    let names: string[] = []
    try {
      names = readdirSync(profilesDir).filter((f) => {
        if (f === 'node_modules' || f.startsWith('_') || f.startsWith('.')) return false
        try {
          return statSync(join(profilesDir, f)).isDirectory()
        } catch {
          return false
        }
      })
    } catch {
      names = []
    }
    const roster = readRoster()
    const now = Date.now()
    return {
      profilesDir,
      rows: names.map((n) => {
        const hit = roster.filter((r) => matchesProfile(r.nodeId, n)).sort((a, b) => b.atMs - a.atMs)[0]
        // 工作分区：**优先读 profile 的自描述块**（真实值），读不到才退回默认规则
        // （`<nodesRoot>/<name>`）——后者覆盖不到自定义分区，会把「规则不覆盖」
        // 显示成「分区不存在」（§5.9 规则 6 的经典形态）。
        let wsPath = join(nodesRootOf(), n)
        try {
          const m = readNodeMeta(JSON.parse(readFileSync(join(profilesDir, n, 'package.json'), 'utf8')))
          if (m !== undefined && m.workspace !== '') wsPath = m.workspace
        } catch {
          /* 读不到就用默认规则 */
        }
        let wsExists = false
        try {
          wsExists = statSync(wsPath).isDirectory()
        } catch {
          wsExists = false
        }
        return {
          name: n,
          profileExists: true,
          workspaceExists: wsExists,
          pid: hit && pidAlive(hit.pid) ? hit.pid : null,
          rosterNodeId: hit?.nodeId ?? '',
          online: hit !== undefined && now - hit.atMs < 60_000,
        }
      }),
    }
  }

  // ── 工具一：node_create ─────────────────────────────────────────────────────
  const createTool: ToolDefinition = defineTool({
    name: 'node_create',
    description:
      '锻造一个 DSH 智能体实例：建工作分区 + 写 profile 骨架（照官方模板逐字段对齐）+ '
      + '写 cluster 配置（共用总线）+ 装 link 依赖 + 起进程。三个隔离层次互相独立——'
      + 'profile 决定「装配」、workspace 决定「在哪干活」、home 决定「数据面」（只有 isolatedHome=true 才分家）。'
      + 'dryRun=true 只出计划不落盘；start=false 只落盘不起进程。已存在的 profile 一律拒绝覆盖。',
    parameters: {
      name: { type: 'string', description: '节点名（= profile 名；小写字母/数字/连字符，不可撞随附 profile 或保留名）' },
      template: { type: 'string', description: '随附模板：web（缺省·常驻）| sdk | acp | headless（one-shot，跑完即退，不适合当节点）' },
      workspace: { type: 'string', description: '工作分区绝对路径（缺省 <nodesRoot>/<name>）' },
      port: { type: 'number', description: '端口（缺省 0 = 不指定）' },
      role: { type: 'string', description: '名册角色标签（缺省「执行节点」）' },
      isolatedHome: { type: 'boolean', description: 'true = 连 DSH_HOME 一起隔离（重；用于需要身份/凭据隔离的对外节点）' },
      autoInject: { type: 'boolean', description: '收到消息是否自动注入会话（缺省 false：留给适配器/工具取用）。置 true 可复现「有会话才注入」的语义' },
      dryRun: { type: 'boolean', description: 'true = 只出计划，不落盘、不起进程' },
      start: { type: 'boolean', description: '落盘后是否起进程（缺省 true）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          name: { type: 'string', required: true },
          profileDir: { type: 'string', required: true },
          workspace: { type: 'string', required: true },
          busDir: { type: 'string', required: true },
          filesWritten: { type: 'array', required: true, items: { type: 'string' } },
          filesRefused: { type: 'array', required: true, items: { type: 'string' } },
          errors: { type: 'array', required: true, items: { type: 'string' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          pid: { type: 'number', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => {
        const v = value as Record<string, unknown>
        const written = v['filesWritten'] as string[]
        const refused = v['filesRefused'] as string[]
        const lines = [
          '节点 ' + String(v['name']) + (v['ok'] ? ' ⇒ 锻造完成' : ' ⇒ 未完成'),
          '  profile   ' + String(v['profileDir']),
          '  workspace ' + String(v['workspace']),
          '  busDir    ' + String(v['busDir']),
          '  落盘 ' + String(written.length) + ' 个文件' + (refused.length > 0 ? '，拒绝 ' + String(refused.length) + ' 个（已存在）' : ''),
          Number(v['pid']) > 0 ? '  进程 pid=' + String(v['pid']) : '  未起进程',
          String(v['note']),
        ]
        for (const w of v['warnings'] as string[]) lines.push('  ⚠ ' + w)
        for (const e of v['errors'] as string[]) lines.push('  ✗ ' + e)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: ToolArgs): Promise<CreateResult> {
      const name = str(args.name, '').trim()
      const check = validateNodeName(name)
      if (!check.ok) {
        trace('create-reject', { name, reason: check.reason })
        return createFail(name, '', '', busDirOf(), check.reason)
      }
      const isolated = bool(args.isolatedHome, false)
      const workspace = str(args.workspace, '').trim() !== '' ? resolve(str(args.workspace)) : join(nodesRootOf(), name)
      const home = isolated ? join(workspace, '.dsh') : homeOf()
      const harnessRoot = harnessRootOf()
      if (harnessRoot === '') {
        const reason = '推不出 harnessRoot（argv[1] 不是 apps/cli/lib/bin.js 形状，且未配置 config.harnessRoot）'
        trace('create-reject', { name, reason })
        return createFail(name, '', workspace, busDirOf(), reason)
      }

      const spec: NodeSpec = {
        name,
        // 默认 `web`：**常驻型**。`headless` 是 one-shot（要任务、跑完即退），
        // 拿它当节点 ⇒ 进程打印 `dsh: a task is required` 后消失（2026-09-26 实测）。
        template: str(args.template, '').trim() !== '' ? str(args.template) : 'web',
        workspace,
        harnessRoot,
        home,
        busDir: busDirOf(),
        role: str(args.role, '').trim() !== '' ? str(args.role) : '执行节点',
        port: num(args.port, 0),
        autoInject: bool(args.autoInject, false),
        clusterPluginPath: clusterPathOf(),
      }
      const plan = planNode(spec)
      const profileDir = dirname(plan.files[0]?.path ?? '')

      if (bool(args.dryRun, false)) {
        trace('create-dry-run', { name, profileDir, workspace, files: plan.files.length })
        return {
          ok: true, name, profileDir, workspace, busDir: spec.busDir,
          filesWritten: plan.files.map((f) => f.path), filesRefused: [], errors: [],
          warnings: plan.warnings, pid: 0,
          note: 'dryRun：以上为**将**落盘的文件（未写、未起进程）。去掉 dryRun 即执行。',
        }
      }

      // ① 工作分区（先建——没有分区就没有 cwd）
      try {
        mkdirSync(spec.workspace, { recursive: true })
      } catch (e) {
        const reason = '建工作分区失败：' + String(e)
        trace('create-reject', { name, reason })
        return createFail(name, profileDir, workspace, spec.busDir, reason)
      }

      // ② profile 四件套
      const wrote = writePlan(plan.files)
      trace('create-files', { name, written: wrote.written.length, refused: wrote.refused.length, errors: wrote.errors.length })

      // ③ link 依赖（bundle 是 in-box、从安装目录解析、无需下载；只有 cluster 是 link）
      const warnings = [...plan.warnings]
      if (wrote.refused.length === 0 && wrote.errors.length === 0) {
        const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
        try {
          await new Promise<void>((res, rej) => {
            // `shell: true` 是 Windows 必需：execFile 直接跑 `.cmd` 会 `spawn EINVAL`
            // （2026-09-26 实测）。参数全是本模块写死的常量，**无注入面**。
            const child = execFile(pnpm, ['install', '--silent'], { cwd: profileDir, timeout: config.installTimeoutMs, shell: true }, (err) => {
              if (err) rej(err)
              else res()
            })
            child.on('error', (err) => rej(err))
          })
          trace('create-install', { name, ok: true })
        } catch (e) {
          warnings.push('依赖安装失败（节点多半起不来）：' + String(e))
          trace('create-install', { name, ok: false, error: String(e) })
        }
      } else {
        warnings.push(wrote.refused.length > 0 ? '有文件已存在 ⇒ 未覆盖、未安装依赖' : '有写入错误 ⇒ 未安装依赖')
      }

      // ④ 起进程（detached + stdio 落文件：不占宿主 fd，且子进程活过宿主）
      let pid = 0
      if (bool(args.start, true) && wrote.errors.length === 0 && wrote.refused.length === 0) {
        const logPath = join(spec.workspace, '.nodeforge.log')
        let logFd: number | undefined
        try {
          logFd = openSync(logPath, 'a')
        } catch {
          logFd = undefined
        }
        try {
          const child = spawn(plan.launch.cmd[0] ?? 'node', plan.launch.cmd.slice(1), {
            cwd: plan.launch.cwd,
            env: { ...process.env, ...plan.launch.env },
            stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
            detached: true,
          })
          // 必挂 error：spawn 异步失败（ENOENT/EPERM）不监听会掀掉宿主（§5.24）。
          child.on('error', (err) => {
            trace('spawn-error', { name, error: String(err) })
          })
          child.unref()
          pid = child.pid ?? 0
          trace('create-started', { name, pid, cmd: plan.launch.cmd.join(' ') })
        } catch (e) {
          warnings.push('起进程抛错：' + String(e))
          trace('spawn-throw', { name, error: String(e) })
        } finally {
          // 父进程侧关掉副本——否则每次锻造泄一个 fd。
          if (logFd !== undefined) {
            try {
              closeSync(logFd)
            } catch {
              /* 关不掉不影响结论 */
            }
          }
        }
      }

      const ok = wrote.errors.length === 0 && wrote.refused.length === 0
      return {
        ok, name, profileDir, workspace, busDir: spec.busDir,
        filesWritten: wrote.written, filesRefused: wrote.refused, errors: wrote.errors,
        warnings,
        pid,
        note: ok
          ? (pid > 0
            ? '已起进程（pid=' + String(pid) + '）。心跳一个周期内出现在 cluster_nodes；看不见就查 '
              + join(spec.workspace, '.nodeforge.log') + ' 与 nodeforge-trace.jsonl。'
            : '文件已就位但未起进程（start=false）——用同一 name 再调一次并给 start=true，或手工起。')
          : '未完成：' + (wrote.refused.length > 0
            ? '目标 profile 已存在（拒绝覆盖）——换个名字，或先确认它是不是你要的那个节点'
            : '见 errors'),
      }
    },
  })

  // ── 工具二：node_list ───────────────────────────────────────────────────────
  const listTool: ToolDefinition = defineTool({
    name: 'node_list',
    description:
      '列本机节点：profile 目录（装配真源）与总线名册（身份真源）对照。'
      + '答「谁有 profile、谁在名册里、谁真的在线」——包括没有名册身份的孤儿 profile。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number', required: true },
          profilesDir: { type: 'string', required: true },
          busDir: { type: 'string', required: true },
          rows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                rosterNodeId: { type: 'string', required: true },
                online: { type: 'boolean', required: true },
                pid: { type: 'number', required: true },
                summary: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value: any) => {
        const v = value as Record<string, unknown>
        const lines = [
          '本机节点 ' + String(v['total']) + ' 个｜profiles: ' + String(v['profilesDir']),
          '总线: ' + String(v['busDir']),
        ]
        for (const r of v['rows'] as Record<string, unknown>[]) {
          const roster = String(r['rosterNodeId'])
          lines.push('• ' + String(r['summary'])
            + (roster !== '' ? ' · 名册 ' + roster + (r['online'] ? '（在线）' : '（离线）') : ' · 无名册身份'))
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      const { rows, profilesDir } = listNodes()
      return {
        total: rows.length,
        profilesDir,
        busDir: busDirOf(),
        rows: rows.map((r) => ({
          name: r.name,
          rosterNodeId: r.rosterNodeId,
          online: r.online,
          pid: r.pid ?? 0,
          summary: describeNodeRow(r),
        })),
      }
    },
  })

  // ── 工具三：node_stop ───────────────────────────────────────────────────────
  const stopTool: ToolDefinition = defineTool({
    name: 'node_stop',
    description:
      '停一个本机节点（pid 取自总线心跳）。**带保护名单**：web（当前载体）与 watch（守护）一律拒绝——'
      + '判据落在候选名上，不依赖调用方自觉。',
    parameters: {
      name: { type: 'string', description: '要停的节点名（= profile 名）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          name: { type: 'string', required: true },
          pid: { type: 'number', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => {
        const v = value as Record<string, unknown>
        return [{
          type: 'text',
          text: (v['ok'] ? '已停 ' : '未停 ') + String(v['name'])
            + (Number(v['pid']) > 0 ? ' (pid=' + String(v['pid']) + ')' : '') + '\n' + String(v['note']),
        }]
      },
    },
    async execute(args: ToolArgs) {
      const name = str(args.name, '').trim()
      const guard = stopGuard(name)
      if (!guard.ok) {
        trace('stop-guard', { name, reason: guard.reason })
        return { ok: false, name, pid: 0, note: guard.reason }
      }
      const hit = readRoster().filter((r) => matchesProfile(r.nodeId, name)).sort((a, b) => b.atMs - a.atMs)[0]
      if (hit === undefined || hit.pid === null) {
        return { ok: false, name, pid: 0, note: '名册里没有该节点的有效心跳（也许它没在跑）——未做任何事。' }
      }
      if (!pidAlive(hit.pid)) {
        return { ok: false, name, pid: hit.pid, note: '心跳里的 pid 已不存在（陈旧心跳）——未做任何事。' }
      }
      try {
        process.kill(hit.pid)
        trace('stopped', { name, pid: hit.pid })
        return { ok: true, name, pid: hit.pid, note: '已发终止信号；心跳过期后名册会把它标为离线。' }
      } catch (e) {
        trace('stop-error', { name, pid: hit.pid, error: String(e) })
        return { ok: false, name, pid: hit.pid, note: '终止失败：' + String(e) }
      }
    },
  })

  // ── 工具四：node_start ──────────────────────────────────────────────────────
  const startTool: ToolDefinition = defineTool({
    name: 'node_start',
    description:
      '起一个**已存在**的节点（profile 已在盘上）。`node_create` 只造新节点且拒绝覆盖既有 profile，'
      + '所以「停掉之后想再起」必须靠这个工具。参数缺省时读 profile 的自描述块 `dshNodeforge`'
      + '（template / workspace / port / home / busDir），因此正常情况下只需给 name。'
      + '**不写任何文件**，只起进程；profile 不存在 ⇒ 明确拒绝并提示改用 node_create。',
    parameters: {
      name: { type: 'string', description: '节点名（= profile 名）' },
      port: { type: 'number', description: '覆盖端口（缺省用自描述块里的值；0 = 不指定）' },
      workspace: { type: 'string', description: '覆盖工作分区（缺省用自描述块里的值，再退回默认规则）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          name: { type: 'string', required: true },
          pid: { type: 'number', required: true },
          workspace: { type: 'string', required: true },
          cmd: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => {
        const v = value as Record<string, unknown>
        return [{
          type: 'text',
          text: (v['ok'] ? '已起 ' : '未起 ') + String(v['name'])
            + (Number(v['pid']) > 0 ? ' (pid=' + String(v['pid']) + ')' : '')
            + '\n  cwd ' + String(v['workspace'])
            + '\n  cmd ' + String(v['cmd'])
            + '\n' + String(v['note']),
        }]
      },
    },
    async execute(args: ToolArgs) {
      const name = str(args.name, '').trim()
      const check = validateNodeName(name)
      if (!check.ok) {
        trace('start-reject', { name, reason: check.reason })
        return { ok: false, name, pid: 0, workspace: '', cmd: '', note: check.reason }
      }
      const profileDir = join(homeOf(), 'profiles', name)
      if (!existsSync(profileDir)) {
        const note = 'profile 不存在（' + profileDir + '）——这是**没造过**的节点，改用 node_create。'
        trace('start-reject', { name, reason: 'no-profile' })
        return { ok: false, name, pid: 0, workspace: '', cmd: '', note }
      }
      // 读自描述块：读不到就退回默认规则（**不把「信息缺失」升级成「功能失效」**）
      let meta: ReturnType<typeof readNodeMeta>
      try {
        meta = readNodeMeta(JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')))
      } catch {
        meta = undefined
      }
      const harnessRoot = harnessRootOf()
      if (harnessRoot === '') {
        return { ok: false, name, pid: 0, workspace: '', cmd: '', note: '推不出 harnessRoot（argv[1] 形状不符且未配置 config.harnessRoot）' }
      }
      // 三级回退：显式参数 > profile 自描述 > 本机默认规则
      const workspace = str(args.workspace, '').trim() !== ''
        ? resolve(str(args.workspace))
        : (meta !== undefined && meta.workspace !== '' ? meta.workspace : join(nodesRootOf(), name))
      const spec: NodeSpec = {
        name,
        template: meta !== undefined && meta.template !== '' ? meta.template : 'web',
        workspace,
        harnessRoot,
        home: meta !== undefined && meta.home !== '' ? meta.home : homeOf(),
        busDir: meta !== undefined && meta.busDir !== '' ? meta.busDir : busDirOf(),
        role: meta?.role ?? '',
        port: num(args.port, meta?.port ?? 0),
        autoInject: meta?.autoInject ?? false,
        clusterPluginPath: clusterPathOf(),
      }
      const plan = planNode(spec)
      try {
        mkdirSync(spec.workspace, { recursive: true })
      } catch (e) {
        return { ok: false, name, pid: 0, workspace, cmd: '', note: '工作分区不可用：' + String(e) }
      }
      let logFd: number | undefined
      try {
        logFd = openSync(join(spec.workspace, '.nodeforge.log'), 'a')
      } catch {
        logFd = undefined
      }
      try {
        const child = spawn(plan.launch.cmd[0] ?? 'node', plan.launch.cmd.slice(1), {
          cwd: plan.launch.cwd,
          env: { ...process.env, ...plan.launch.env },
          stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
          detached: true,
        })
        child.on('error', (err) => {
          trace('spawn-error', { name, error: String(err) })
        })
        child.unref()
        const pid = child.pid ?? 0
        trace('started', { name, pid, fromMeta: meta !== undefined, cmd: plan.launch.cmd.join(' ') })
        return {
          ok: true, name, pid, workspace,
          cmd: plan.launch.cmd.join(' '),
          note: '元信息来源：' + (meta !== undefined
            ? 'profile 自描述块'
            : '默认规则（该 profile 无 dshNodeforge 块——可能是手工造的）')
            + '。心跳一个周期内出现在 cluster_nodes；日志见 ' + join(workspace, '.nodeforge.log'),
        }
      } catch (e) {
        trace('start-throw', { name, error: String(e) })
        return { ok: false, name, pid: 0, workspace, cmd: plan.launch.cmd.join(' '), note: '起进程抛错：' + String(e) }
      } finally {
        if (logFd !== undefined) {
          try {
            closeSync(logFd)
          } catch {
            /* 关不掉不影响结论 */
          }
        }
      }
    },
  })

  ctx.effect(() => {
    guarded('register', () => {
      ctx.tools.register(createTool)
      ctx.tools.register(listTool)
      ctx.tools.register(stopTool)
      ctx.tools.register(startTool)
    })
    trace('startup', {
      home: homeOf(), busDir: busDirOf(), nodesRoot: nodesRootOf(),
      harnessRoot: harnessRootOf(), clusterPluginPath: clusterPathOf(),
      shipped: SHIPPED_PROFILES.join(','), templates: Object.keys(TEMPLATE_BUNDLES).join(','),
    })
    return () => {
      trace('unload', {})
    }
  })
}

/**
 * roster.ts — 庄园名册的**纯函数层**（零 IO、零随机：同输入必同输出，可离线全量测）。
 *
 * 为什么独立成层：判定逻辑（谁在线、哪个源在说谎）必须能被**尸体样本**直接喂，
 * 不依赖真实总线；壳（`index.ts`）只负责把盘上的事实读成 `HeartbeatFacts`。
 *
 * ── 为什么不能只用「一个真源」（2026-10-06 实测事故）────────────────────────────
 * 同日 `node_list` 把三个活着的成员（maid-01/02/03，各已跑 26 小时）报成「未运行」。
 * 根因不是读不到名册——名册读得好好的；是**关联判据**：它按 cluster 的 id 派生规则
 * `‹host›-‹profile›[-port]` 去名册里找，而 alice-manor 的适配器用**裸 id** 注册
 * （`--id maid-01`）⇒ 匹配失败 ⇒ 显示成「未运行 · 无名册身份」。
 * ⇒ 本模块的修法：**宽松匹配**（裸名 / ‹host›-‹名› / ‹host›-‹名›-‹port› 都认）
 *   + **三源核验**（自报 `atMs` · 心跳文件 `mtime` · `pid` 探活），并把**源间分歧显式报出**。
 *
 * 判活判据的取向（本人纪律：严格者优先）：
 *   只当**所有可用源都新鲜**时才判 `online`；任一源陈旧即降级并在 `divergences` 里说明是哪一源。
 *   ——宁可把活的报成可疑（可见、可追问），不可把死的报成活（静默、无人知）。
 */

/** 心跳超过这个毫秒数即判陈旧。与 `projects/self/alice-manor/manor.mjs` 的 `STALE_SEC = 30` 同一口径。 */
export const HEARTBEAT_STALE_MS = 30_000

/** 动作日志清点上限（防目录膨胀把一次读盘拖成灾难）。 */
export const DEFAULT_ACTION_TAIL = 400

/** 一个成员在盘上留下的原始事实（由壳层读盘得到，本层不做任何 IO）。 */
export interface HeartbeatFacts {
  /** 文件名派生的 id（`nodes/<id>.json`）。 */
  id: string
  /** 自报心跳时刻（文件内容里的 `atMs`）；解析失败时 0。 */
  atMs: number
  /** 心跳文件的实际修改时刻（文件系统事实）；取不到时 0。 */
  mtimeMs: number
  /** 自报 pid；无则 null。 */
  pid: number | null
  /** pid 探活结果；无法判定时 null。 */
  pidAlive: boolean | null
  startedAtMs: number
  role: string
  harness: string
  displayName: string
  profile: string
  workdir: string
  capabilities: string[]
  /** 心跳文件解析失败的原因；正常时 null。 */
  broken: string | null
  /** 必须在名册里显示但可能不带主机前缀的**别名**（如 profile 名），供宽松匹配。 */
  aliases?: string[]
}

/** 名册里的一行（判定后的形状）。 */
export interface RosterRow {
  id: string
  state: 'online' | 'stale' | 'broken'
  /** 自报心跳年龄（秒；负数按 0 计——时钟回拨不应变成「未来」）。 */
  ageReportedSec: number
  /** 心跳文件年龄（秒）。 */
  ageFileSec: number
  pid: number | null
  pidAlive: boolean | null
  /** 源间分歧（人类可读），空数组 = 三源一致。 */
  divergences: string[]
  role: string
  harness: string
  displayName: string
  profile: string
  workdir: string
  capabilities: string[]
  startedAtMs: number
  /** 该行是否由别名（而非 host 前缀）匹配上的——匹配放宽的痕迹要留。 */
  matchedBy: string
}

/** 共享上下文（`context/org-context.jsonl`）的计数。 */
export interface ContextSummary {
  present: boolean
  total: number
  kinds: Record<string, number>
  bad: number
}

/** 任务账（动作日志终态清点）。 */
export interface TaskSummary {
  done: number
  failed: number
  unfinished: number
  recent: { taskId: string; state: string; ms: number; note: string }[]
}

/** 一份完整名册读数。 */
export interface RosterReport {
  ok: boolean
  busDir: string
  /** ★ 区分「名册为空」与「名册读不到」——两者在下游长得一样，但含义相反。 */
  readable: boolean
  errors: string[]
  members: RosterRow[]
  counts: { total: number; online: number; stale: number; broken: number }
  context: ContextSummary
  tasks: TaskSummary
  /** 给人看的口径说明（读了哪个目录、阈值多少）。 */
  notes: string[]
}

const sec = (ms: number): number => (ms > 0 ? ms / 1000 : 0)
const nonNeg = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)
const int = (v: number): number => (Number.isFinite(v) ? Math.round(v) : 0)

/**
 * 成员的**宽松匹配**：裸名、`‹host›-‹名›`、`‹host›-‹名›-‹port›`，以及显式别名都算命中。
 *
 * 为什么必须宽松：两套命名约定在庄园里并存——cluster 派生的节点用 `‹host›-‹profile›`，
 * 而 alice-manor 的适配器用裸 id。只认一套就会把另一套报成「不存在」。
 * @param row - 候选名册行
 * @param wanted - 要找的名（profile 名或 nodeId）
 * @param host - 本机主机名
 * @returns 命中时返回「命中依据」（人类可读），未命中返回空串
 */
export function matchMember(row: HeartbeatFacts, wanted: string, host: string): string {
  const w = wanted.trim()
  if (w === '') return ''
  if (row.id === w) return '裸名'
  if (row.id === host + '-' + w || row.id.startsWith(host + '-' + w + '-')) return 'host 前缀'
  if (row.aliases !== undefined && row.aliases.includes(w)) return '别名'
  if (row.profile === w) return 'profile 名'
  return ''
}

/**
 * 判定单个成员（纯函数：同一 `nowMs` 下结果确定）。
 * @param f - 盘上事实
 * @param nowMs - 判定基准时刻
 * @returns 名册行
 */
export function judgeMember(f: HeartbeatFacts, nowMs: number): RosterRow {
  const ageReportedSec = sec(nonNeg(nowMs - f.atMs))
  const ageFileSec = sec(nonNeg(nowMs - f.mtimeMs))
  const divergences: string[] = []

  if (f.broken !== null) {
    return {
      id: f.id, state: 'broken', ageReportedSec, ageFileSec, pid: f.pid, pidAlive: f.pidAlive,
      divergences: ['心跳文件损坏：' + f.broken],
      role: f.role, harness: f.harness, displayName: f.displayName, profile: f.profile,
      workdir: f.workdir, capabilities: f.capabilities, startedAtMs: f.startedAtMs, matchedBy: '',
    }
  }

  const freshReported = f.atMs > 0 && nowMs - f.atMs < HEARTBEAT_STALE_MS
  const freshFile = f.mtimeMs > 0 && nowMs - f.mtimeMs < HEARTBEAT_STALE_MS
  const freshPid = f.pidAlive === true

  // ── 分歧显式化：这是本模块存在的理由（一个真源会静默说谎）──────
  if (f.atMs > 0 && f.mtimeMs > 0 && freshReported !== freshFile) {
    divergences.push(freshReported
      ? '自报新（' + ageReportedSec.toFixed(0) + 's）但文件旧（' + ageFileSec.toFixed(0) + 's）'
      : '文件新（' + ageFileSec.toFixed(0) + 's）但自报旧（' + ageReportedSec.toFixed(0) + 's）')
  }
  if (f.pidAlive === false && (freshReported || freshFile)) {
    divergences.push('心跳新鲜但 pid ' + String(f.pid) + ' 探不到（进程已退而文件残留）')
  }
  if (freshPid && !freshReported && !freshFile) {
    divergences.push('pid ' + String(f.pid) + ' 仍在但心跳两源都陈旧（进程活着却不再写心跳）')
  }
  if (f.atMs === 0 && f.mtimeMs > 0) divergences.push('心跳内容取不到 atMs（文件在但内容不可信）')
  if (f.mtimeMs === 0 && f.atMs > 0) divergences.push('心跳文件 mtime 取不到（内容可信度未知）')

  const online = freshReported && freshFile
  return {
    id: f.id,
    state: online ? 'online' : 'stale',
    ageReportedSec, ageFileSec, pid: f.pid, pidAlive: f.pidAlive, divergences,
    role: f.role, harness: f.harness, displayName: f.displayName, profile: f.profile,
    workdir: f.workdir, capabilities: f.capabilities, startedAtMs: f.startedAtMs, matchedBy: '',
  }
}

/**
 * 统计共享上下文（append-only jsonl 的**内容**，由壳层读成字符串后交进来）。
 * @param text - 文件全文；`null` = 文件不存在或读不到
 * @returns 计数（区分「present=false」与「present=true 但 total=0」）
 */
export function summarizeContext(text: string | null): ContextSummary {
  if (text === null) return { present: false, total: 0, kinds: {}, bad: 0 }
  const kinds: Record<string, number> = {}
  let total = 0
  let bad = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    total += 1
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      const k = typeof o['kind'] === 'string' ? o['kind'] : '(缺 kind)'
      kinds[k] = (kinds[k] ?? 0) + 1
    } catch {
      bad += 1
    }
  }
  return { present: true, total, kinds, bad }
}

/**
 * 清点任务账：每份动作日志看**终态**（`done` / `failed`），无终态即 `unfinished`。
 * @param files - `{ name, text }[]`（壳层读盘所得；text 为 null 表示读不到该份）
 * @returns 计数与最近若干条
 */
export function summarizeTasks(files: { name: string; text: string | null }[]): TaskSummary {
  let done = 0
  let failed = 0
  let unfinished = 0
  const recent: TaskSummary['recent'] = []
  for (const f of files) {
    if (f.text === null) continue
    const stages: Record<string, Record<string, unknown>> = {}
    for (const line of f.text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const o = JSON.parse(line) as Record<string, unknown>
        stages[String(o['stage'])] = o
      } catch {
        /* 单行坏不致命——继续读完该份 */
      }
    }
    if (stages['start'] === undefined) continue
    const start = stages['start']
    const detail = (start['detail'] ?? {}) as Record<string, unknown>
    const taskId = typeof detail['taskId'] === 'string' ? detail['taskId'] : '(无 taskId)'
    const fin = stages['done'] ?? stages['failed']
    const state = fin !== undefined ? String(fin['stage']) : 'unfinished'
    if (state === 'done') done += 1
    else if (state === 'failed') failed += 1
    else unfinished += 1
    const finDetail = fin !== undefined ? ((fin['detail'] ?? {}) as Record<string, unknown>) : {}
    recent.push({
      taskId,
      state,
      ms: typeof finDetail['ms'] === 'number' ? finDetail['ms'] : 0,
      note: fin !== undefined && typeof fin['humanText'] === 'string' ? fin['humanText'] : 'started, 无终态',
    })
  }
  return { done, failed, unfinished, recent }
}

/**
 * 组装一份名册报告（纯函数：喂事实，出结论）。
 * @param input - 壳层收集的全部事实
 * @returns 报告
 */
export function buildRoster(input: {
  busDir: string
  nowMs: number
  /** `null` = 名册目录读不到（与「空数组」语义相反，故必须分开传）。 */
  heartbeats: HeartbeatFacts[] | null
  contextText: string | null
  actionFiles: { name: string; text: string | null }[]
  /** 错误清单（壳层收集：读不到目录等）。 */
  errors: string[]
}): RosterReport {
  const notes: string[] = [
    '阈值：心跳超 ' + String(HEARTBEAT_STALE_MS / 1000) + ' 秒判陈旧（与 manor.mjs 同一口径）',
    '判活：**所有可用源都新鲜**才判在线；源间分歧在 divergences 里显式列出',
  ]

  if (input.heartbeats === null) {
    // ★ fail-loud：读不到 ≠ 空。静默当成「没有成员上线过」会把仪器故障伪装成事实。
    return {
      ok: false,
      busDir: input.busDir,
      readable: false,
      errors: input.errors.concat(['名册目录读不到：' + input.busDir + '/nodes（不存在或不可读）']),
      members: [],
      counts: { total: 0, online: 0, stale: 0, broken: 0 },
      context: summarizeContext(input.contextText),
      tasks: summarizeTasks(input.actionFiles),
      notes,
    }
  }

  const rows = input.heartbeats.map((f) => judgeMember(f, input.nowMs))
  rows.sort((a, b) => a.id.localeCompare(b.id))
  let online = 0
  let broken = 0
  for (const r of rows) {
    if (r.state === 'online') online += 1
    if (r.state === 'broken') broken += 1
  }
  const counted = summarizeTasks(input.actionFiles)
  return {
    ok: input.errors.length === 0,
    busDir: input.busDir,
    readable: true,
    errors: input.errors.slice(),
    members: rows,
    counts: { total: rows.length, online, stale: rows.length - online - broken, broken },
    context: summarizeContext(input.contextText),
    tasks: counted,
    notes,
  }
}

const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length))

/**
 * 渲染成人类可读文本（纯函数：格式可断言）。
 * @param r - 名册报告
 * @returns 多行文本
 */
export function renderRoster(r: RosterReport): string {
  const lines: string[] = []
  lines.push('庄园名册 · ' + new Date(Date.now()).toLocaleString('zh-CN', { hour12: false }))
  lines.push('总线 ' + r.busDir)
  if (!r.readable) {
    lines.push('')
    lines.push('✖ 名册读不到——**这不是「没有成员」，是仪器看不到**。')
    for (const e of r.errors) lines.push('  ✗ ' + e)
    return lines.join('\n')
  }

  lines.push('')
  lines.push('成员 ' + String(r.counts.total) + ' 个（在线 ' + String(r.counts.online)
    + ' · 陈旧 ' + String(r.counts.stale) + (r.counts.broken > 0 ? ' · 损坏 ' + String(r.counts.broken) : '') + '）')
  if (r.members.length === 0) lines.push('  （名册为空——没有成员上线过）')
  const wId = r.members.reduce((a, m) => Math.max(a, m.id.length), 8) + 2
  for (const m of r.members) {
    const mark = m.state === 'online' ? '✓ 在线' : (m.state === 'broken' ? '✖ 损坏' : '⚠ 陈旧')
    const age = m.ageReportedSec < 120
      ? m.ageReportedSec.toFixed(0) + 's'
      : (m.ageReportedSec / 60).toFixed(1) + 'm'
    const pid = m.pid !== null
      ? 'pid ' + String(m.pid) + (m.pidAlive === true ? '(活)' : (m.pidAlive === false ? '(不在)' : '(未知)'))
      : 'pid -'
    lines.push('  ' + pad(m.id, wId) + pad(mark, 9) + pad('心跳 ' + age, 12) + pad(pid, 20)
      + (m.role !== '-' ? m.role : '') + (m.displayName !== '' ? ' · ' + m.displayName : ''))
    for (const d of m.divergences) lines.push('      ⚠ ' + d)
  }

  lines.push('')
  lines.push('共享上下文')
  if (!r.context.present) lines.push('  ⚠ 不存在（或读不到）')
  else {
    const kinds = Object.entries(r.context.kinds).map(([k, v]) => k + ' ' + String(v)).join(' · ')
    lines.push('  ' + String(r.context.total) + ' 条' + (kinds !== '' ? ' — ' + kinds : '')
      + (r.context.bad > 0 ? '  ⚠ 坏行 ' + String(r.context.bad) : ''))
  }

  lines.push('')
  lines.push('任务账（动作日志终态清点）')
  lines.push('  终结 ' + String(r.tasks.done) + ' · 失败 ' + String(r.tasks.failed) + ' · 未完 ' + String(r.tasks.unfinished))
  for (const t of r.tasks.recent.slice(-5)) {
    const secs = t.ms > 0 ? (t.ms / 1000).toFixed(0) + 's' : '-'
    lines.push('  ' + pad(t.taskId, 18) + pad(t.state, 12) + pad(secs, 8) + t.note.slice(0, 60))
  }

  if (r.notes.length > 0) {
    lines.push('')
    for (const n of r.notes) lines.push('  · ' + n)
  }
  for (const e of r.errors) lines.push('  ✗ ' + e)
  return lines.join('\n')
}

/** 供工具层复用的「计数摘要」单行（避免 render 之外再造一套格式）。 */
export function rosterHeadline(r: RosterReport): string {
  if (!r.readable) return '名册读不到（' + int(r.errors.length) + ' 条错误）'
  return '成员 ' + String(r.counts.total) + ' · 在线 ' + String(r.counts.online)
    + ' · 陈旧 ' + String(r.counts.stale)
}

// ── 退役判定（只增不减的设施补上「减」的一半）────────────────────────────────
//
// 背景（2026-10-10）：名册能把节点判成 online/stale/broken，却**没有任何清理动作**——
// 于是一次性的测试节点（sim-node-a 26 天、wb-0 25 天、ref-0 14 天…）永久占据名册，
// 「陈旧」这个信号也就永远亮着，变成噪音。补的不是「一键清空」，是**逐条可审的退役**。

/**
 * manor 适配器在心跳里留下的 harness 自述 —— 「是庄园成员」的**机制判据**。
 *
 * 为什么不用 `maid-` 前缀：那是命名约定，成员改名即失效；而 `harness` 是注册那一刻
 * 适配器自己写进去的（`E:\alice\projects\self\alice-manor\adapter.mjs`），改名也带得走。
 */
export const MANOR_HARNESS = 'alice-manor-adapter'

/**
 * **成员档可见的工具**（`E3` 裁决落地 · 2026-10-14）。
 *
 * ★ 存在理由（现读证据）：本插件原先**没有任何 role 分档** —— `ctx.effect` 里
 *   六个工具**无条件全注册**（`index.ts:1059-1064`）。而 `dsh-manor` **有**
 *   `MEMBER_TOOLS` 白名单（成员只见 4 件）⇒ **同一个庄园、同一份成员 profile 里，
 *   两套插件对「成员该看到什么」给了相反答案**（`manor.md` §10 E3 的裁决项原话）。
 *
 * ★ 裁决（技术处置自主）：**让两套插件给同一种答案** —— 成员不该能停别的节点
 *   （`node_stop`）、不该能退役痕迹（`node_retire`）、不该能造节点（`node_create`）。
 *   ⚠ 这与「要不要加权限分级」**不是同一问**：勘已答过后者 ——
 *     「在信任模型下再加角色门是**假装有防线**——成员与主脑同级，拦不住东西」。
 *     ⇒ 本表**不声称是安全边界**，它声称的是**同一概念的一致答案**（可维护性，不是防线）。
 *   ⚠ 如实标注：成员手里若有 shell（`workspace-write` 沙箱内），
 *     **绕得过**这一层（她可以直接跑 `bin.js`）。⇒ **它不是沙箱**。
 *
 * ★ 白名单形态（不是黑名单）⇒ **新增工具默认对成员不可见**（fail-closed，与 manor 同形）。
 */
export const MEMBER_TOOLS: readonly string[] = ['node_list']

/**
 * host 专属工具（**显式清单**：与 `MEMBER_TOOLS` 双向覆盖全部工具，且不相交）。
 *
 * ★ 与 manor 的 `HOST_ONLY_TOOLS` **同一纪律**：那份清单的注释写着为什么必须有它 ——
 *   「**「默认不可见」与「有人确认过这是有意的」是两件事**」。实测代价是
 *   派给 maid-05 的活 **200 秒后被杀**而没有任何机制报警。
 *   ⇒ 补法不是「记得改白名单」，而是**让「没归类」变成一个测试失败**。
 */
export const HOST_ONLY_TOOLS: readonly string[] = [
  // ⚠ 真名**现读自 `index.ts`**（2026-10-14：我第一版凭印象写了 `node_roster`，
  //   而 `rosterTool` 注册的名字是 **`manor_roster`**（`index.ts:846`）——
  //   猜名字会让「双向覆盖测试」本身变成假绿：它比对的是我手写的两张表，
  //   而**盘上真注册的名字**没人对。⇒ 名字一律现读，不凭印象。）
  'node_create', 'node_start', 'node_stop', 'node_retire', 'manor_roster',
]

/** 本插件注册的**全部**工具（单一真源：双向覆盖测试读它）。 */
export const ALL_TOOLS: readonly string[] = [...MEMBER_TOOLS, ...HOST_ONLY_TOOLS]

/**
 * 按角色筛工具面。**纯函数** ⇒ 可离线测（与 manor 的 `toolsForRole` 同形同纪律）。
 *
 * @param role `host`（缺省）⇒ **全部**；`member` ⇒ 只列 `MEMBER_TOOLS`
 * @param all 全部工具名（调用方给 ⇒ 本函数不猜）
 */
export function toolsForRole(role: 'host' | 'member' | string, all: readonly string[]): string[] {
  if (role === 'member') {
    const allow = new Set<string>(MEMBER_TOOLS)
    return all.filter((t) => allow.has(t))
  }
  // ★ 缺省（含任何未知角色）⇒ **全部**（现有行为零回归；与 manor 的缺省同向）
  return [...all]
}

/** 一个节点能否退役的结论。 */
export interface RetireVerdict {
  /** true = 可以移走。 */
  ok: boolean
  /** 理由 —— **必须自足**：读的人不该再去别处找「为什么是这个结论」。 */
  reason: string
  /** 是否由 manor 适配器注册（= 庄园成员）。 */
  isMember: boolean
  /** 是否仍在线。 */
  online: boolean
  /** 放行但该留意的事（成员可复活、维护者角色可能是资产…）。 */
  warnings: string[]
}

/**
 * 判定一个节点能否退役（纯函数：喂盘上事实，出放行/拒绝）。
 *
 * 取向与判活同源——**宁可拒，不可误清**。四条拒绝各说各拦的是什么：
 * 找不到的不清（不猜历史）、在线的不清（退役的是痕迹不是活体）、
 * 成员不清（**离线是成员的形态**，不是残留）、资产额外警告。
 *
 * @param input - 盘上事实 + 选项
 * @returns 结论
 */
export function judgeRetire(input: {
  id: string
  /** `null` = 名册里没有这个 id（与「有事实但离线」是两件事）。 */
  facts: HeartbeatFacts | null
  nowMs: number
  /** 显式允许退役成员（缺省 false）。 */
  includeMembers: boolean
}): RetireVerdict {
  const warnings: string[] = []
  const f = input.facts
  if (f === null) {
    return {
      ok: false, isMember: false, online: false, warnings,
      reason: '名册里没有「' + input.id + '」——没有东西可退役（不猜它是否曾经存在）。',
    }
  }
  const isMember = f.harness === MANOR_HARNESS
  const row = judgeMember(f, input.nowMs)
  const online = row.state === 'online'
  if (online) {
    return {
      ok: false, isMember, online, warnings,
      reason: '「' + f.id + '」仍在线（心跳 ' + row.ageReportedSec.toFixed(0) + 's）——退役的是痕迹，不是活体。',
    }
  }
  if (isMember && !input.includeMembers) {
    return {
      ok: false, isMember, online, warnings,
      reason: '「' + f.id + '」是庄园成员（harness=' + MANOR_HARNESS
        + '）——**离线是成员的形态**，不是残留；要退役成员须显式 includeMembers=true。',
    }
  }
  if (f.broken !== null) warnings.push('心跳文件损坏（' + f.broken + '）——正是这类残留最该清')
  if (isMember) warnings.push('这是**成员**：移走名册条目后，她下次被 manor_wake 唤醒会重新注册（不是永久删除）')
  if (f.role === '维护者') warnings.push('自述角色是「维护者」——可能是可再起的资产（如桌面端），移走前想清楚')
  return {
    ok: true, isMember, online, warnings,
    reason: '离线 ' + row.ageReportedSec.toFixed(0) + 's（文件 ' + row.ageFileSec.toFixed(0) + 's）'
      + (f.role !== '-' ? ' · 角色 ' + f.role : '') + (f.displayName !== '' ? ' · ' + f.displayName : ''),
  }
}

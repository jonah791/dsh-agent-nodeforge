/**
 * plan.ts 套件：节点锻造的纯计划层。
 *
 * **判据强度说明（§5.9 规则 6：读数自带域标注）**：本套件的 YAML 判据是**真解析级**——
 * 用 js-yaml 把生成物解回来，断言**逐字符保真**，而不是只断言「字符串里有没有这行」。
 * 依据：2026-09-26 实测对照——同一个 Windows 路径，单引号写法解析后逐字符相等，
 * 双引号写法直接 `YAMLException: expected hexadecimal character`（`\U` 被当转义起始）。
 * 所以下面那条「尸体样本」测的不是风格，是**可用性**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  SHIPPED_PROFILES, TEMPLATE_BUNDLES, describeNodeRow, planNode, readNodeMeta, stopGuard, validateNodeName, yamlQuote,
} from '../lib/plan.js'

const require = createRequire(import.meta.url)
const yaml = require('js-yaml')

/** 造一个字段齐全的 spec（各用例只覆盖自己关心的字段）。 */
const mkSpec = (over = {}) => ({
  name: 'node-a',
  template: 'headless',
  workspace: 'E:\\alice-nodes\\node-a',
  harnessRoot: 'E:\\alice\\deepseek-harness',
  home: 'E:\\alice\\.dsh',
  busDir: 'C:\\Users\\tr\\.dsh-cluster',
  role: '执行节点',
  port: 0,
  autoInject: false,
  clusterPluginPath: 'E:\\alice\\self-plugins\\dsh-agent-cluster',
  ...over,
})

const fileOf = (plan, suffix) => {
  const f = plan.files.find((x) => x.path.endsWith(suffix))
  assert.ok(f !== undefined, '计划里应有 ' + suffix)
  return f.content
}

// ── yamlQuote：本模块最危险的一处（Windows 路径 + YAML 转义） ────────────────────

test('yamlQuote：Windows 路径经真解析后**逐字符保真**（单引号语义）', () => {
  const p = 'C:\\Users\\tr\\.dsh-cluster'
  assert.equal(yaml.load('k: ' + yamlQuote(p) + '\n').k, p)
})

test('尸体样本：双引号实现下同一路径**会被检出**（抛错或值失真，二者皆算）', () => {
  // 不预设失败形态——高效实现可能抛、也可能静默吃字符，只要「被检出」就说明本套件有区分力。
  const p = 'C:\\Users\\tr\\.dsh-cluster'
  let detected = false
  try {
    const got = yaml.load('k: "' + p + '"\n').k
    if (got !== p) detected = true
  } catch {
    detected = true
  }
  assert.ok(detected, '双引号实现竟然保真了——那这条尸体样本没有区分力，判据要重写')
})

test('yamlQuote：串里的单引号被翻倍后仍保真', () => {
  const s = "a'b'c"
  assert.equal(yaml.load('k: ' + yamlQuote(s) + '\n').k, s)
})

test('yamlQuote：中文与特殊字符不破坏解析', () => {
  for (const s of ['执行节点', 'a#b', 'a: b', '- x', ' 前后有空格 ']) {
    assert.equal(yaml.load('k: ' + yamlQuote(s) + '\n').k, s, '串未保真：' + s)
  }
})

// ── validateNodeName ─────────────────────────────────────────────────────────

test('validateNodeName：撞随附 profile 名一律拒（官方契约禁止）', () => {
  for (const n of SHIPPED_PROFILES) {
    const r = validateNodeName(n)
    assert.equal(r.ok, false, n + ' 应被拒')
  }
})

test('validateNodeName：本机保留名一律拒（desktop / watch）', () => {
  assert.equal(validateNodeName('desktop').ok, false)
  assert.equal(validateNodeName('watch').ok, false)
})

test('validateNodeName：非法字符 / 空 一律拒，且理由可读', () => {
  for (const n of ['', '  ', 'Node-A', 'node_a', 'node.a', '-leading', 'node a']) {
    const r = validateNodeName(n)
    assert.equal(r.ok, false, JSON.stringify(n) + ' 应被拒')
    if (!r.ok) assert.ok(r.reason.length > 0, '拒绝必须带理由')
  }
})

test('validateNodeName：合法名通过（含单字符与数字开头）', () => {
  for (const n of ['a', 'n1', 'node-a', 'worker-01', 'x-y-z']) {
    assert.equal(validateNodeName(n).ok, true, n + ' 应通过')
  }
})

// ── planNode：文件四件套 + 真解析 ─────────────────────────────────────────────

test('planNode：产出官方模板的四件套，路径都落在该 profile 目录下', () => {
  const plan = planNode(mkSpec())
  const names = plan.files.map((f) => f.path.replace(/^.*[\\/]/, '')).sort()
  assert.deepEqual(names, ['cordis.patch.yml', 'cordis.yml', 'package.json', 'pnpm-workspace.yaml'])
  for (const f of plan.files) {
    assert.ok(f.path.includes('profiles'), '文件应落在 profiles/ 下：' + f.path)
    assert.ok(f.path.includes('node-a'), '文件应在该节点自己的 profile 目录里：' + f.path)
  }
})

test('planNode：package.json 是合法 JSON，bundles 取自模板、依赖只有 cluster 的 link', () => {
  const spec = mkSpec()
  const pkg = JSON.parse(fileOf(planNode(spec), 'package.json'))
  assert.equal(pkg.name, 'dsh-profile-node-a')
  assert.deepEqual(pkg.dsh.profile.bundles, [...TEMPLATE_BUNDLES.headless])
  assert.equal(pkg.dependencies['dsh-agent-cluster'], 'link:' + spec.clusterPluginPath)
  // 只该有这一条依赖——多出来的意味着我们偷偷装了本该 in-box 的包。
  assert.equal(Object.keys(pkg.dependencies).length, 1)
})

test('planNode：cordis.patch.yml **真解析**后，cluster 配置逐字段保真（含反斜杠路径）', () => {
  const spec = mkSpec()
  const doc = yaml.load(fileOf(planNode(spec), 'cordis.patch.yml'))
  assert.ok(Array.isArray(doc), 'patch 顶层应是数组')
  const insert = doc.find((e) => Array.isArray(e?.insert))
  assert.ok(insert !== undefined, '应有一条 insert')
  const row = insert.insert.find((r) => r.name === 'dsh-agent-cluster')
  assert.ok(row !== undefined, 'insert 里应有 dsh-agent-cluster')
  assert.equal(row.config.busDir, spec.busDir, 'busDir 必须逐字符保真（反斜杠不得被吃）')
  assert.equal(row.config.role, spec.role)
  assert.equal(row.config.profile, spec.name)
  assert.equal(row.config.autoInject, false)
  assert.equal(row.config.leaderEligible, false)
  assert.equal(row.config.leaderAutoRenew, false)
  assert.equal(row.config.port, undefined, 'port=0 时不该写 port 键')
})

test('planNode：port>0 时 patch 与 cmd 都带上端口', () => {
  const spec = mkSpec({ port: 3081 })
  const doc = yaml.load(fileOf(planNode(spec), 'cordis.patch.yml'))
  const row = doc[0].insert.find((r) => r.name === 'dsh-agent-cluster')
  assert.equal(row.config.port, 3081)
  const cmd = planNode(spec).launch.cmd
  assert.ok(cmd.includes('--port'), 'cmd 应含 --port')
  assert.equal(cmd[cmd.indexOf('--port') + 1], '3081')
})

test('planNode：启动形状与已验证的守护实现同形（--expose-internals / --profile，cwd=workspace）', () => {
  const spec = mkSpec()
  const { launch } = planNode(spec)
  assert.equal(launch.cmd[1], '--expose-internals')
  assert.ok(launch.cmd[2]?.endsWith('bin.js'), 'argv[2] 应是 launcher：' + String(launch.cmd[2]))
  assert.equal(launch.cmd[launch.cmd.indexOf('--profile') + 1], 'node-a')
  // ⚠ 反向断言：headless 模板**不得**带 `--no-open`——它不认这个参数，会 unknown option 秒退。
  // 这条断言曾经写反（要求存在），等于把一个真实崩溃锁进了绿灯（2026-09-26 实测修正）。
  assert.ok(!launch.cmd.includes('--no-open'), 'headless 不该带 --no-open：' + launch.cmd.join(' '))
  assert.equal(launch.cwd, spec.workspace, 'cwd 必须是工作分区')
  assert.equal(launch.env.DSH_HOME, spec.home)
})

test('planNode：所有文件都是 create 模式（既有 profile 不得被静默覆盖）', () => {
  // 这是保护语义：覆盖会改掉别人的装配。改动这一条等于拆掉保护，必须有意识地做。
  for (const f of planNode(mkSpec()).files) assert.equal(f.mode, 'create', f.path + ' 应为 create 模式')
})

test('planNode：未知模板 ⇒ 发出可诊断告警且不抛（纯层不出局）', () => {
  const plan = planNode(mkSpec({ template: 'nope' }))
  assert.ok(plan.warnings.length > 0, '应告警')
  assert.ok(plan.warnings[0]?.includes('nope'), '告警应点出模板名：' + String(plan.warnings[0]))
})

// ── 模板形态（实测语义：谁常驻、谁认识 --no-open） ─────────────────────────────

test('模板真值：四个随附模板的 bundle 包名与官方 manifest 逐字一致', () => {
  // 包名是从 `--from-default-profile <t> --dump-config` 读回来的**真值**，不是猜的。
  // 初版曾把 sdk 写成 '@deepseek-ai/dsh-sdk'（真值 dsh-sdk-app）——猜出来的包名会让节点起不来。
  assert.deepEqual(TEMPLATE_BUNDLES.web, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  assert.deepEqual(TEMPLATE_BUNDLES.sdk, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'])
  assert.deepEqual(TEMPLATE_BUNDLES.acp, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'])
  assert.deepEqual(TEMPLATE_BUNDLES.headless, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])
})

test('--no-open 只对 web 模板加：其它 app 不认它，带上会 unknown option 秒退', () => {
  const web = planNode(mkSpec({ template: 'web' })).launch.cmd
  assert.ok(web.includes('--no-open'), 'web 该带 --no-open：' + web.join(' '))
  for (const t of ['headless', 'sdk', 'acp']) {
    const cmd = planNode(mkSpec({ template: t })).launch.cmd
    assert.ok(!cmd.includes('--no-open'), t + ' 不该带 --no-open：' + cmd.join(' '))
  }
})

// ── stopGuard / describeNodeRow ──────────────────────────────────────────────

test('stopGuard：web 与 watch 一律拒（停它们 = 自杀）', () => {
  for (const n of ['web', 'watch']) {
    const r = stopGuard(n)
    assert.equal(r.ok, false, n + ' 应被拒')
    if (!r.ok) assert.ok(r.reason.includes(n), '理由应点名：' + r.reason)
  }
})

test('stopGuard：普通节点放行；空名拒绝', () => {
  assert.equal(stopGuard('node-a').ok, true)
  assert.equal(stopGuard('').ok, false)
})

test('describeNodeRow：运行态 / 缺失态都说清楚', () => {
  assert.ok(describeNodeRow({ name: 'x', profileExists: true, workspaceExists: true, pid: 123 }).includes('pid=123'))
  const missing = describeNodeRow({ name: 'x', profileExists: false, workspaceExists: false, pid: null })
  assert.ok(missing.includes('无 profile') && missing.includes('无工作分区') && missing.includes('未运行'))
})

// ── 自描述块（profile 自己记住「我是怎么被造的」）─────────────────────────────
// 为什么要它：`node_start` 要起一个**已存在**的节点就得知道该带哪些 app 参数
// （`--no-open` 只有 web 认，带错就秒退）；`node_list` 要报**真实** workspace 而不是猜。

test('planNode：package.json 写入 dshNodeforge 自描述块，字段逐项保真', () => {
  const spec = mkSpec({ template: 'web', port: 3090, autoInject: true })
  const pkg = JSON.parse(fileOf(planNode(spec), 'package.json'))
  assert.deepEqual(pkg.dshNodeforge, {
    v: 1,
    template: 'web',
    workspace: spec.workspace,
    port: 3090,
    role: spec.role,
    busDir: spec.busDir,
    home: spec.home,
    autoInject: true,
  })
})

test('readNodeMeta：往返保真（写进去的能读回来）', () => {
  const spec = mkSpec({ template: 'web', port: 3090 })
  const meta = readNodeMeta(JSON.parse(fileOf(planNode(spec), 'package.json')))
  assert.equal(meta.template, 'web')
  assert.equal(meta.port, 3090)
  assert.equal(meta.workspace, spec.workspace)
  assert.equal(meta.busDir, spec.busDir)
})

test('readNodeMeta：坏形状一律 undefined 且**不抛**（never throws）', () => {
  // 读不到元信息只该让调用方**退回默认规则**，绝不能升级成「节点起不来」。
  for (const bad of [null, undefined, 42, 'x', [], {}, { dshNodeforge: null }, { dshNodeforge: [] },
    { dshNodeforge: 'x' }, { dshNodeforge: { v: 2 } }, { dshNodeforge: { v: '1' } }]) {
    assert.equal(readNodeMeta(bad), undefined, '坏样本应得 undefined：' + JSON.stringify(bad))
  }
})

test('readNodeMeta：缺字段用安全默认（空串 / 0 / false），**不伪造值**', () => {
  const m = readNodeMeta({ dshNodeforge: { v: 1, template: 'web' } })
  assert.equal(m.template, 'web')
  assert.equal(m.workspace, '', '缺 workspace 应是空串——伪造一个默认路径会让 node_start 起错地方')
  assert.equal(m.port, 0)
  assert.equal(m.autoInject, false)
})

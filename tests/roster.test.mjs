/**
 * roster.ts（庄园名册纯函数层）测试 — **尸体样本驱动**。
 *
 * 为什么先测这一层：判定逻辑（谁在线、哪个源在说谎）是本能力唯一会「静默说谎」的地方。
 * 壳层只搬运事实，坏不到哪去；纯层判错，下游**无法分辨**。
 * 因此每个判据都配一具喂进去的坏样本（§5.9 规则 2：防线必须有尸体测试）。
 *
 * ⚠ **一处自我纠错（2026-10-06）**：本文件初稿的头注曾写「`tests/` 目录此前不存在」——
 *   那是**假读数**：`glob tests/**` 返回 No files found，而同目录其实已有 33 个测试
 *   （本文件加入后 `npm test` 共 48 个用例，全过）。⇒ 记录在此提醒自己：
 *   **「仪器说没有」与「真的没有」是两件事**。同日两次同族事故：早上 `node_list` 把三个
 *   连跑 26 小时的成员报成「未运行」，随后 `glob` 把 33 个文件报成空。
 *   判据：**换一种仪器复核，再下结论**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRoster, judgeMember, judgeRetire, matchMember, renderRoster, summarizeContext, summarizeTasks,
  HEARTBEAT_STALE_MS, DEFAULT_ACTION_TAIL, MANOR_HARNESS,
} from '../lib/roster.js'

const NOW = 1_800_000_000_000
const FRESH = NOW - 3_000            // 3 秒前（阈值 30 秒内 ⇒ 新鲜）
const OLD = NOW - 600_000            // 10 分钟前 ⇒ 陈旧

/** 造一条盘上事实（缺省 = 三源都新鲜、三源都一致）。 */
const facts = (over = {}) => ({
  id: 'maid-01',
  atMs: FRESH,
  mtimeMs: FRESH,
  pid: 5696,
  pidAlive: true,
  startedAtMs: NOW - 93_600_000,
  role: '执行节点',
  harness: 'alice-manor-adapter',
  displayName: '女仆 maid-01',
  profile: 'maid-01',
  workdir: 'E:\\alice',
  capabilities: ['agent.session'],
  broken: null,
  ...over,
})

test('常量口径与 manor.mjs 对齐（阈值 30 秒）', () => {
  assert.equal(HEARTBEAT_STALE_MS, 30_000)
  assert.equal(DEFAULT_ACTION_TAIL, 400)
})

test('正向：三源都新鲜 ⇒ online，且无分歧', () => {
  const r = judgeMember(facts(), NOW)
  assert.equal(r.state, 'online')
  assert.deepEqual(r.divergences, [])
  assert.equal(r.pidAlive, true)
})

test('尸体①：双源都陈旧 ⇒ stale（两个方向都测）', () => {
  assert.equal(judgeMember(facts({ atMs: OLD, mtimeMs: OLD }), NOW).state, 'stale')
  assert.equal(judgeMember(facts({ atMs: OLD, mtimeMs: OLD, pidAlive: false }), NOW).state, 'stale')
})

test('尸体②：自报新但文件旧 ⇒ 降级 + 显式指出是哪一源', () => {
  const r = judgeMember(facts({ atMs: FRESH, mtimeMs: OLD }), NOW)
  assert.equal(r.state, 'stale', '取最保守的源——任一源陈旧即不判在线')
  assert.equal(r.divergences.length, 1)
  assert.match(r.divergences[0], /自报新.*文件旧/)
})

test('尸体③：文件新但自报旧 ⇒ 降级 + 显式指出（与②对称）', () => {
  const r = judgeMember(facts({ atMs: OLD, mtimeMs: FRESH }), NOW)
  assert.equal(r.state, 'stale')
  assert.match(r.divergences[0], /文件新.*自报旧/)
})

test('尸体④：心跳新鲜但 pid 探不到（进程已退而文件残留）⇒ 分歧必须可见', () => {
  const r = judgeMember(facts({ pidAlive: false }), NOW)
  assert.equal(r.state, 'online', '双源仍新鲜——不因 pid 一源就翻案')
  assert.equal(r.divergences.length, 1)
  assert.match(r.divergences[0], /pid 5696 探不到/)
})

test('尸体⑤：pid 仍在但心跳两源都陈旧 ⇒ 分歧必须可见（活着却不再写心跳）', () => {
  const r = judgeMember(facts({ atMs: OLD, mtimeMs: OLD, pidAlive: true }), NOW)
  assert.equal(r.state, 'stale')
  assert.match(r.divergences[0], /仍在但心跳两源都陈旧/)
})

test('尸体⑥：心跳文件损坏 ⇒ state=broken 且原因进 divergences', () => {
  const r = judgeMember(facts({ broken: 'Unexpected token < in JSON' }), NOW)
  assert.equal(r.state, 'broken')
  assert.match(r.divergences[0], /心跳文件损坏/)
})

test('尸体⑦：时钟回拨（atMs 在未来）⇒ 年龄不为负', () => {
  const r = judgeMember(facts({ atMs: NOW + 60_000, mtimeMs: NOW + 60_000 }), NOW)
  assert.equal(r.ageReportedSec, 0)
  assert.equal(r.ageFileSec, 0)
  assert.equal(r.state, 'online')
})

test('尸体⑧：名册**读不到** ⇒ readable=false + ok=false + 错误非空（绝不静默当空）', () => {
  const rep = buildRoster({
    busDir: 'C:\\nope', nowMs: NOW, heartbeats: null,
    contextText: null, actionFiles: [], errors: [],
  })
  assert.equal(rep.readable, false)
  assert.equal(rep.ok, false)
  assert.ok(rep.errors.length >= 1, '读不到必须有错')
  assert.match(rep.errors.join(' '), /名册目录读不到/)
  const text = renderRoster(rep)
  assert.match(text, /这不是「没有成员」，是仪器看不到/)
})

test('尸体⑨：名册**为空** ⇒ readable=true + total=0 + 零错误（与⑧语义相反）', () => {
  const rep = buildRoster({
    busDir: 'C:\\ok', nowMs: NOW, heartbeats: [],
    contextText: null, actionFiles: [], errors: [],
  })
  assert.equal(rep.readable, true)
  assert.equal(rep.ok, true)
  assert.equal(rep.counts.total, 0)
  assert.deepEqual(rep.errors, [])
  assert.match(renderRoster(rep), /名册为空——没有成员上线过/)
})

test('计数：online / stale / broken 三态分列正确', () => {
  const rep = buildRoster({
    busDir: 'C:\\ok', nowMs: NOW,
    heartbeats: [
      facts({ id: 'a' }),
      facts({ id: 'b', atMs: OLD, mtimeMs: OLD, pidAlive: false }),
      facts({ id: 'c', broken: 'bad json' }),
    ],
    contextText: null, actionFiles: [], errors: [],
  })
  assert.deepEqual(rep.counts, { total: 3, online: 1, stale: 1, broken: 1 })
})

test('宽松匹配：裸名 / host 前缀 / 别名 / profile 名都命中', () => {
  const host = '<host>'
  assert.equal(matchMember(facts({ id: 'maid-01' }), 'maid-01', host), '裸名')
  assert.equal(matchMember(facts({ id: host + '-web-0' }), 'web', host), 'host 前缀')
  assert.equal(matchMember(facts({ id: 'x', profile: 'maid-09' }), 'maid-09', host), 'profile 名')
  assert.equal(matchMember(facts({ id: 'x', aliases: ['绘琉'] }), '绘琉', host), '别名')
  assert.equal(matchMember(facts({ id: 'maid-01' }), 'maid-99', host), '', '不匹配必须返回空串')
  assert.equal(matchMember(facts({ id: 'maid-01' }), '', host), '', '空查询不匹配')
})

test('共享上下文：null / 空串 / 坏行 三种形态分得清', () => {
  assert.deepEqual(summarizeContext(null), { present: false, total: 0, kinds: {}, bad: 0 })
  const empty = summarizeContext('\n  \n')
  assert.equal(empty.present, true)
  assert.equal(empty.total, 0)
  const mixed = summarizeContext('{"kind":"FACT"}\n{"kind":"FACT"}\n{"kind":"CLAIM"}\nnot json\n')
  assert.equal(mixed.present, true)
  assert.equal(mixed.total, 4)
  assert.equal(mixed.bad, 1)
  assert.deepEqual(mixed.kinds, { FACT: 2, CLAIM: 1 })
  assert.deepEqual(summarizeContext('{"no":"kind"}').kinds, { '(缺 kind)': 1 })
})

test('任务账：done / failed / unfinished 三态 + 忽略无 start 的碎文件', () => {
  const s = summarizeTasks([
    { name: 'a.jsonl', text: '{"stage":"start","detail":{"taskId":"t-1"}}\n{"stage":"done","detail":{"ms":37000},"humanText":"ok"}\n' },
    { name: 'b.jsonl', text: '{"stage":"start","detail":{"taskId":"t-2"}}\n{"stage":"failed","humanText":"boom"}\n' },
    { name: 'c.jsonl', text: '{"stage":"start","detail":{"taskId":"t-3"}}\n' },
    { name: 'd.jsonl', text: '{"stage":"stage"}\n' },
    { name: 'e.jsonl', text: null },
  ])
  assert.equal(s.done, 1)
  assert.equal(s.failed, 1)
  assert.equal(s.unfinished, 1)
  assert.equal(s.recent.length, 3, '无 start 的碎文件不入账')
  assert.equal(s.recent[0].taskId, 't-1')
  assert.equal(s.recent[0].ms, 37000)
})

test('对账：报告里的 members 与 counts 必须自洽（防渲染与判定脱钩）', () => {
  const rep = buildRoster({
    busDir: 'C:\\ok', nowMs: NOW,
    heartbeats: [facts({ id: 'a' }), facts({ id: 'b', atMs: OLD, mtimeMs: OLD })],
    contextText: '{"kind":"FACT"}\n', actionFiles: [], errors: [],
  })
  const onlineFromRows = rep.members.filter((m) => m.state === 'online').length
  assert.equal(rep.counts.online, onlineFromRows)
  assert.equal(rep.counts.total, rep.members.length)
  assert.match(rosterText(rep), /成员 2 个（在线 1 · 陈旧 1）/)
})

/** 渲染文本的小包装（便于在断言里读）。 */
function rosterText(rep) {
  return renderRoster(rep)
}

/* ── 退役判定（judgeRetire）· 每条拒绝各配一具尸体 ─────────────────────────────
   取向是「宁可拒，不可误清」，所以每条拒绝都必须证明自己**真的会拦**；
   而每条放行都要有**对照组**（只换一个变量就放行），否则「拒对了」也可能是撞运气。 */

test('judgeRetire：成员离线 ⇒ 拒（离线是成员的形态，不是残留）', () => {
  const v = judgeRetire({
    id: 'maid-01',
    facts: facts({ atMs: OLD, mtimeMs: OLD, pidAlive: false }),
    nowMs: NOW, includeMembers: false,
  })
  assert.equal(v.ok, false)
  assert.equal(v.isMember, true)
  assert.match(v.reason, /离线是成员的形态/)
})

test('judgeRetire：对照组 —— 同一条记录，显式 includeMembers 即放行', () => {
  const f = facts({ atMs: OLD, mtimeMs: OLD, pidAlive: false })
  const v = judgeRetire({ id: 'maid-01', facts: f, nowMs: NOW, includeMembers: true })
  assert.equal(v.ok, true, '放开第二道闸后必须放行，否则拒绝来自别处')
  assert.match(v.warnings.join(' '), /成员/)
})

test('judgeRetire：在线 ⇒ 拒（退役的是痕迹，不是活体）', () => {
  const v = judgeRetire({ id: 'x', facts: facts({ id: 'x' }), nowMs: NOW, includeMembers: true })
  assert.equal(v.ok, false)
  assert.equal(v.online, true)
  assert.match(v.reason, /仍在线/)
})

test('judgeRetire：名册里没有 ⇒ 拒（不猜历史）', () => {
  const v = judgeRetire({ id: 'ghost', facts: null, nowMs: NOW, includeMembers: true })
  assert.equal(v.ok, false)
  assert.match(v.reason, /没有东西可退役/)
})

test('judgeRetire：一次性测试节点离线 ⇒ 放行（这正是要清的那类）', () => {
  const v = judgeRetire({
    id: 'sim-node-a',
    facts: facts({ id: 'sim-node-a', harness: '-', role: '研究员', atMs: OLD, mtimeMs: OLD, pidAlive: false }),
    nowMs: NOW, includeMembers: false,
  })
  assert.equal(v.ok, true)
  assert.equal(v.isMember, false)
})

test('judgeRetire：维护者角色放行但必须带警告（可能是可再起的资产）', () => {
  const v = judgeRetire({
    id: 'desktop-19387',
    facts: facts({ id: 'desktop-19387', harness: '-', role: '维护者', atMs: OLD, mtimeMs: OLD, pidAlive: false }),
    nowMs: NOW, includeMembers: false,
  })
  assert.equal(v.ok, true)
  assert.match(v.warnings.join(' '), /维护者/)
})

test('judgeRetire：损坏心跳放行，且点名「正是该清的」', () => {
  const v = judgeRetire({
    id: 'bad',
    facts: facts({ id: 'bad', harness: '-', broken: 'Unexpected token', atMs: 0, mtimeMs: OLD, pidAlive: false }),
    nowMs: NOW, includeMembers: false,
  })
  assert.equal(v.ok, true)
  assert.match(v.warnings.join(' '), /损坏/)
})

test('judgeRetire：MANOR_HARNESS 与真实心跳里的值一致（防改名后成员保护静默失效）', () => {
  assert.equal(MANOR_HARNESS, 'alice-manor-adapter', '适配器写的 harness 值变了 ⇒ 成员保护会恒不命中，比没有更危险')
  const v = judgeRetire({
    id: 'm',
    facts: facts({ harness: MANOR_HARNESS, atMs: OLD, mtimeMs: OLD, pidAlive: false }),
    nowMs: NOW, includeMembers: false,
  })
  assert.equal(v.isMember, true)
  assert.equal(v.ok, false)
})

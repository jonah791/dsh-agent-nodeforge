/**
 * 工具面分档测试（`E3` 裁决落地 · 2026-10-14）。
 *
 * ★ 存在理由（现读证据）：本插件修前**没有任何 role 分档** —— `ctx.effect` 里
 *   六个工具无条件全注册；而 `dsh-manor` **有** `MEMBER_TOOLS` 白名单 ⇒
 *   **同一个庄园、同一份成员 profile，两套插件对「成员该看到什么」给了相反答案**。
 *
 * 三条判据（缺一即假绿）：
 *   ① **双向覆盖**：`MEMBER_TOOLS ∪ HOST_ONLY_TOOLS == 真注册的全部`（且不相交）
 *      —— ⚠ 「默认不可见」与「有人确认过这是有意的」是两件事（manor 的实测代价：
 *        派给 maid-05 的活 200 秒后被杀而没有任何机制报警）。
 *   ② ★★ **读源码里的真注册名**，不只比我手写的两张表 ——
 *      否则「双向覆盖」比对的是**我自己的两份手抄**，而**盘上真注册的名字没人对**。
 *      （这正是 manor.md N15 那条判据：「契约的源必须是**行为**不是声明」。）
 *      实证：我第一版 `HOST_ONLY_TOOLS` 凭印象写了 `node_roster`，
 *      而 `rosterTool` 注册的真名是 **`manor_roster`**（`index.ts:846`）。
 *   ③ **成员档不含管理动作**：`node_stop` / `node_retire` / `node_create` 必须不可见。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { MEMBER_TOOLS, HOST_ONLY_TOOLS, ALL_TOOLS, toolsForRole } from '../src/roster.ts'

const here = dirname(fileURLToPath(import.meta.url))
const srcIndex = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8')

/** 从源码里抽出**真注册**的工具名（`name: 'x'` 出现在 defineTool 里）。 */
function registeredNamesFromSource(text) {
  const out = []
  for (const m of text.matchAll(/defineTool\(\{[\s\S]{0,400}?name:\s*'([a-z_]+)'/g)) out.push(m[1])
  return out
}

test('① 双向覆盖：两张表**并集 == 真注册的全部**，且不相交', () => {
  const fromSource = registeredNamesFromSource(srcIndex)
  assert.ok(fromSource.length >= 6, '从源码只抽到 ' + String(fromSource.length) + ' 个名字 —— 抽取器在空跑（先修判据，别信它的绿）')
  const declared = new Set(ALL_TOOLS)
  // ★ 并集必须覆盖源码里每一个真注册名
  for (const n of fromSource) {
    assert.ok(declared.has(n), '★ 源码里注册了 `' + n + '` 却没被归进任何一张表 —— 加工具的人必须**显式决定**它对成员可见还是 host 专属')
  }
  // ★ 反向：表里也不许有源码里不存在的名字（防手写漂移）
  const srcSet = new Set(fromSource)
  for (const n of ALL_TOOLS) {
    assert.ok(srcSet.has(n), '★ 表里写了 `' + n + '` 而源码里没有这个注册 —— 手写表已漂移（我第一版就是这么写错的）')
  }
  // ★ 不相交
  const inter = MEMBER_TOOLS.filter((t) => HOST_ONLY_TOOLS.includes(t))
  assert.deepEqual(inter, [], '两张表不许相交（相交意味着「既可见又专属」）')
})

test('② 成员档不含管理动作（`node_stop` / `node_retire` / `node_create` 不可见）', () => {
  const member = toolsForRole('member', ALL_TOOLS)
  for (const forbidden of ['node_stop', 'node_retire', 'node_create', 'node_start']) {
    assert.ok(!member.includes(forbidden), '★ 成员档不许含 `' + forbidden + '`')
  }
  assert.deepEqual(member, ['node_list'], '成员档现读只该有 `node_list`')
})

test('③ 缺省与未知角色 ⇒ 全部（现有行为零回归）', () => {
  assert.deepEqual(toolsForRole('host', ALL_TOOLS).sort(), [...ALL_TOOLS].sort())
  assert.deepEqual(toolsForRole('', ALL_TOOLS).sort(), [...ALL_TOOLS].sort(), '空角色 ⇒ 全部（缺省方向与 manor 同向）')
  assert.deepEqual(toolsForRole('莫名其妙', ALL_TOOLS).sort(), [...ALL_TOOLS].sort(), '★ 未知角色 ⇒ 全部 —— 不因一个没见过的值而收窄（取宽那侧不该由猜测决定）')
})

test('④ 分档是**纯函数**（可离线测；渲染/注册逻辑不许内联在 execute 里）', () => {
  // 教训来源：manor 的 `rowTag` 曾内联在 `execute` 里 ⇒ 不受任何测试保护，分档改了它没跟上。
  const all = ['node_create', 'node_list', 'node_stop']
  assert.deepEqual(toolsForRole('member', all), ['node_list'])
  assert.deepEqual(toolsForRole('host', all), all)
  // 白名单形态：**新增工具默认对成员不可见**（fail-closed）
  assert.deepEqual(toolsForRole('member', ['node_list', 'node_未来新增']), ['node_list'], '★ 新工具默认不可见 —— 白名单形态，不是黑名单')
})

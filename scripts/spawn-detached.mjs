/**
 * spawn-detached.mjs —— **孤儿化启动器**。
 *
 * **干什么**：spawn 出真正的进程后**立刻退出**，使被启动者的父进程成为「已死进程」，
 * 从而**不在调用方的进程树里**。
 *
 * **为什么需要它**（2026-09-26 实测）：Windows 的 `taskkill /T`（杀整棵进程树）是
 * **沿 ParentProcessId 链**遍历的。守护重启 web 时正是用
 * `execFile('taskkill', ['/T','/F','/PID', pid])` ⇒ 直接 `spawn` 的子进程会被**连带杀掉**
 * （实测：web 重启后两个节点一起消失）。而**经一个自灭的中间层转手**后链就断了——
 * 对照实验（`_tmp_orphan/orphan-test.mjs`）：同一次 `taskkill /T /F /PID <parent>` 下，
 * 直接子进程**死**、经中间层转手的**活**。
 *
 * **用法**：`node spawn-detached.mjs <logPath> -- <cmd> [args...]`
 *
 * - `cwd` / `env` 由**调用方**在 spawn 本脚本时指定，本脚本原样继承给真进程
 * - 真进程的 stdout/stderr 接到 `<logPath>`（追加）——中间层退出后没人能再收管道了
 * - 本脚本**不做任何判断**，把「起什么」完全交给调用方（单一职责）
 */
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'

const sep = process.argv.indexOf('--')
const logPath = process.argv[2]
const cmd = sep > 0 ? process.argv.slice(sep + 1) : []

if (cmd.length === 0 || logPath === undefined) {
  process.stderr.write('spawn-detached: 用法 node spawn-detached.mjs <logPath> -- <cmd> [args...]\n')
  process.exit(2)
}

let fd
try {
  fd = openSync(logPath, 'a')
} catch {
  fd = undefined
}

const child = spawn(cmd[0], cmd.slice(1), {
  cwd: process.cwd(),
  env: process.env,
  detached: true,
  stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
})

// spawn 的失败是**异步**的（走 error 事件）⇒ 立刻 exit(0) 会把这个窗口关掉、
// 让「起不来」变成一次静默失败。留 150ms 给它：真起来了则什么都不发生，
// 起不来则写一行到 stderr（本脚本唯一的留痕机会，随后就退出了）。
child.on('error', (err) => {
  try {
    process.stderr.write('spawn-detached error: ' + String(err) + '\n')
  } catch {
    /* 留痕失败不影响退出 */
  }
  process.exit(3)
})
child.unref()
setTimeout(() => process.exit(0), 150)

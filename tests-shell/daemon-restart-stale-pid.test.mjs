// tests-shell/daemon-restart-stale-pid.test.mjs —— 2026-11 生产死局回归：
// daemon.json 记着一个「活着但绝不是守护进程」的 pid（僵尸/复用残留）+ 端口指向
// 新进程这次要绑的端口 → 旧谓词「pidAlive + probeDaemon 有人应答即外来」在 bind
// 后的写前复查里**探到本进程自己**，误判成外来双开 → 新进程自己把自己劝退、
// daemon.json 永远不清 → plugins.json off→on 后宿主反复报「已拉起守护进程（pid …），
// 等待就绪…」→「守护进程未能在时限内就绪」，守护进程永远起不来。
//
// 生产报错（修复前前台复现）：
//   [daemon.json] bind 后写前复查发现守护进程已在运行（pid 45366，端口 4390）——
//   本进程（pid 55876，端口 4390）不启动、不覆盖 daemon.json
//   启动失败：已有守护进程在运行（pid 45366，端口 4390；bind 后写前复查发现）……
// 而 pid 45366 早已死亡（kill(pid,0) 对僵尸/残留 pid 仍假阳性）。
//
// 修复（两道，本文件把它们一起钉住）：
//   1. 身份校验：/api/hello 自带 pid；写前复查只把「端口上应答的就是 daemon.json
//      记的那个」（alive.pid === prev.pid）判为冲突 —— 自探（alive.pid = 本进程）
//      与「别的进程占着记的 pid」都放行覆写；真双开（探到赢家，pid 一致）照旧拦截。
//   2. lifecycle.pidAlive 僵尸感知：kill(pid,0) 假阳性时 Linux 上读 /proc/<pid>/stat
//      的状态位，Z/X 判为不存活。
//
// 测法（确定性复现）：沙箱 state 目录里预写 daemon.json，pid 填**测试进程自己的
// pid**（活着、但绝不是守护进程 —— 与生产「残留 pid 仍 kill(0) 成功」同形状），
// port 填本次要绑的端口；走**生产同款通道 ensureDaemon**（plugins.json off→on 的
// 宿主路径）正常启动（skipExistingCheck 不设 = false）。修复前：子进程 bind 该
// 端口后自探命中自己 → WB_DAEMON_ALREADY_RUNNING 退场 → ensureDaemon 报「未能在
// 时限内就绪」（本用例红）；修复后：身份不符放行 → 守护进程就绪、daemon.json 的
// pid 被更新为新守护进程（本用例绿）。
//
// 注：进程内 startDaemon 无法确定性构造「自探」——bind 前无法预知自己绑到的端口，
// daemon.json 又必须写在 bind 之前；只有「指定端口 + 子进程」才能让 daemon.json 的
// port 与子进程实际 bind 的端口严格一致（WB_DAEMON_PORT 由 ensureDaemon 从陈旧
// daemon.json 的 prev.port 传下去，正是生产链路本身）。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import http from "node:http"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PLUGIN_NAME, ensureDaemon, pidAlive, shutdownDaemon, stateDirFor } from "../lifecycle.mjs"
import { startDaemon } from "../daemon.mjs"
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox } from "../tests/helpers.mjs"

const KEY = "stale-pid-test-key-0123456789abcdef"
const PLUGIN_ROOT = fileURLToPath(new URL("../", import.meta.url))

after(() => {
  cleanupAllSandboxes()
})

const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred, deadlineMs, what) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (await pred()) return true
    await tick(150)
  }
  throw new Error(`等待超时：${what}`)
}

// daemon.json 原文（不经 readDaemonInfo 规范化，便于断言逐字段）
function readRawInfo(stateDir) {
  return JSON.parse(readFileSync(join(stateDir, "daemon.json"), "utf8"))
}

// 拿一个当前空闲的端口（先占后放）：陈旧 daemon.json 记它，新守护进程将绑它，
// 写前复查的自探才会命中「本进程自己」
async function grabFreePort() {
  return new Promise((ok) => {
    const s = http.createServer()
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port
      s.close(() => ok(port))
    })
  })
}

// 一个活着但不是守护进程的进程（充当「别人的 pid」；与 daemon.test.mjs 同款）
function spawnDummy() {
  return spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" })
}

// 本地假 hello 服务：手工指定 /api/hello 的响应体（钉谓词分支用，不起真 daemon）
function fakeHelloServer(helloBody) {
  return new Promise((ok) => {
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(helloBody))
    })
    srv.listen(0, "127.0.0.1", () => ok({ srv, port: srv.address().port }))
  })
}

describe("生产死局回归：陈旧 daemon.json（pid 活着但不是守护进程）+ bind 后自探 → 必须能正常启动", () => {
  test("ensureDaemon 生产通道：daemon.json.pid = 测试进程 pid、port = 本次要绑的端口 → 守护进程就绪、pid 被更新为新守护进程", async () => {
    const cfgDir = makeSandbox("wb-stale-pid-").dir
    const stateDir = stateDirFor(cfgDir)
    mkdirSync(stateDir, { recursive: true })
    // 生产死局的落盘形状：pid = 当前测试进程（活着，但绝不是守护进程 —— 与生产
    // 「早死的旧 pid 仍 kill(pid,0) 成功」同形状），port = 新守护进程这次要绑的端口
    const port = await grabFreePort()
    writeFileSync(
      join(stateDir, "daemon.json"),
      JSON.stringify({ pid: process.pid, port, key: KEY, version: "x", startedAt: new Date().toISOString(), host: "127.0.0.1" }),
    )
    // 生产同款通道（plugins.json off→on 后宿主走的 ensureDaemon）：正常启动，
    // skipExistingCheck 不设（= false，bind 前的门也开着，正是生产参数）
    const logs = []
    const r = await ensureDaemon({ cfgDir, pluginDir: PLUGIN_ROOT, log: (...a) => logs.push(a.join(" ")), budgetMs: 20000 })
    try {
      // 修复前这里 error = 「守护进程未能在时限内就绪…」（子进程自探命中自己后
      // 以 WB_DAEMON_ALREADY_RUNNING 退场）—— 生产死局的直接复现
      assert.equal(r.error, undefined, `ensureDaemon 不应报错：${r.error ?? ""}`)
      assert.equal(r.spawned, true)
      assert.ok(r.info, "应返回就绪守护进程的信息")
      // 守护进程起来并就绪（/api/hello 可达），且它绑的就是陈旧条目记的那个端口
      assert.equal(r.info.port, port, "新守护进程应绑上陈旧 daemon.json 记的端口（自探形状的前提）")
      const hello = await fetch(`http://127.0.0.1:${r.info.port}/api/hello`)
      assert.equal(hello.status, 200)
      const body = await hello.json()
      assert.equal(body.name, PLUGIN_NAME)
      assert.equal(body.ready, true)
      // daemon.json 的 pid 被更新为新守护进程（不是测试进程），与 hello.pid 一致
      const raw = readRawInfo(stateDir)
      assert.notEqual(raw.pid, process.pid, "daemon.json 的 pid 必须不再是测试进程（陈旧条目被覆写）")
      assert.equal(raw.pid, r.info.pid)
      assert.equal(body.pid, r.info.pid, "hello.pid 应与 daemon.json.pid 一致（身份校验依据）")
      // 生产日志形状：宿主侧应看到「已拉起守护进程（pid …），等待就绪…」且不再跟
      // 「未能在时限内就绪」（error 已断言为 undefined）
      assert.ok(logs.some((l) => /已拉起守护进程（pid \d+），等待就绪/.test(l)), `应拉起子进程：${logs.join(" | ")}`)
    } finally {
      // 收尾：通知子进程退场，等它退出后再删沙箱（Windows 文件占用）
      if (r.info) {
        await shutdownDaemon(r.info).catch(() => {})
        await waitFor(() => !pidAlive(r.info.pid), 10000, "守护进程子进程退出").catch(() => {})
      }
      cleanupSandbox(cfgDir)
    }
  })
})

describe("身份校验的兼容口径：老版本 hello 没有 pid 字段 → 保守判冲突（升级期不误放）", () => {
  test("端口上是老版本守护进程（hello 无 pid）+ daemon.json 记着活着的 pid → bind 后写前复查仍拒绝启动", async () => {
    const stateDir = makeSandbox("wb-stale-pid-oldhello-").dir
    const dummy = spawnDummy() // daemon.json 记的 pid：活着，但不是守护进程
    const fake = await fakeHelloServer({ name: PLUGIN_NAME, version: "0.0.0-old", ready: true }) // 无 pid 字段
    try {
      writeFileSync(
        join(stateDir, "daemon.json"),
        JSON.stringify({ pid: dummy.pid, port: fake.port, key: KEY, version: "x", startedAt: new Date().toISOString() }),
      )
      // skipExistingCheck=true：隔离出 bind 后写前复查这一道门（bind 前的门探不到
      // 自己、维持旧语义，另有用例覆盖）；升级期对无 pid 的老版本保守判冲突
      await assert.rejects(
        () =>
          startDaemon({
            key: KEY,
            port: 0,
            stateDir,
            engine: { store: { loadAccounts: () => [], eligibleAccounts: () => [] }, runner: null, tasks: null, upstream: null, errors: [], ok: false },
            noTimers: true,
            skipExistingCheck: true,
          }),
        (e) => e.code === "WB_DAEMON_ALREADY_RUNNING" && /写前复查/.test(e.message),
      )
      // 假 hello 服务与 daemon.json 都没被动过（拒绝启动的进程不写盘）
      assert.equal(readRawInfo(stateDir).pid, dummy.pid)
      const hello = await fetch(`http://127.0.0.1:${fake.port}/api/hello`)
      assert.equal(hello.status, 200)
    } finally {
      dummy.kill()
      await new Promise((ok) => fake.srv.close(ok))
      cleanupSandbox(stateDir)
    }
  })
})

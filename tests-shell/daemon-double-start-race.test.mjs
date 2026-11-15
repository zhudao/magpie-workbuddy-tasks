// tests-shell/daemon-double-start-race.test.mjs —— B6 回归：双 daemon TOCTOU 防双活。
//
// 缺陷：拒双开靠「读 daemon.json → pidAlive → probeDaemon」，发生在 **bind 之前**；
// 两个 ensureDaemon 在同一两秒窗口各自通过检查 → 第一个绑 4390、第二个绑 4391，
// 两个进程都活着，每 5s 交替覆写 daemon.json，跨进程 spacer 互不知晓（单 job
// 闸门失效、0ms 间隔撞风控）。
//
// 修法（任务两方案里选「写前复查」）：bind 成功后、首次写 daemon.json 之前再读
// 一次；此后每次 5s 心跳写盘前同样复查。发现「别的、活着的、健康的、**且就是
// daemon.json 记的那个**」守护进程 → 本进程优雅退出且**不覆盖 daemon.json**。
// 探活失败（进程活着但服务已关 —— 正常重启/退场窗口）不算接管，放行覆写。
//
// 身份校验（2026-11 生产缺陷修复）：写前复查发生在**本进程 bind 之后**，探测可
// 能探到**本进程自己**（daemon.json 记着僵尸/复用 pid、端口正是本进程刚绑的）；
// 旧谓词「有人应答即外来」会把自探误判成外来守护进程 → 新进程自己把自己劝退、
// daemon.json 永远不清、守护进程永远起不来。修后谓词：/api/hello 自带 pid，只有
// alive.pid === prev.pid（端口上应答的就是 daemon.json 记的那个）才判冲突；探到
// 自己（pid = 本进程 ≠ prev.pid）或别的进程 → 放行覆写。老版本 hello 没有 pid
// 字段 → 保守判冲突（升级期兼容）。真双开竞态不受影响：输家探到的赢家已把自己
// 的 {pid,port} 写进 daemon.json，alive.pid === prev.pid 照旧拦截。
//
// 测法说明（如实）：**行为断言**。「真双开」的赢家用一个 spawn 出来的**真实守护
// 进程子进程**（独立 pid/端口，daemon.json 由它自己写 —— pid/port/hello.pid 三者
// 一致，正是竞态赢家落盘的真实形状）；「陈旧 pid + 端口上是别的守护进程」的放行
// 分支用进程内在役守护进程钉住。真双进程同时 bind 的瞬时交错无法在测试里确定性
// 重放，其收敛兜底（写后自检）复用与写前复查**同一个判别函数**，由这里的用例
// 覆盖该谓词的全部分支。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import net from "node:net"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { startDaemon } from "../daemon.mjs"
import { probeDaemon, readDaemonInfo, shutdownDaemon } from "../lifecycle.mjs"
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox } from "../tests/helpers.mjs"

const KEY = "double-start-race-test-key-0123456789"
const DAEMON_PATH = fileURLToPath(new URL("../daemon.mjs", import.meta.url))

after(() => {
  cleanupAllSandboxes()
})

function fakeEngine() {
  return {
    store: { loadAccounts: () => [], eligibleAccounts: () => [] },
    runner: null,
    tasks: null,
    upstream: null,
    errors: [],
    ok: false,
  }
}

async function boot(stateDir, extra = {}) {
  return startDaemon({
    key: KEY,
    port: 0,
    stateDir,
    engine: fakeEngine(),
    noTimers: true,
    skipExistingCheck: true,
    ...extra,
  })
}

// 一个活着但不是守护进程的进程（充当「别人的 pid」；与 daemon.test.mjs 同款）
function spawnDummy() {
  return spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" })
}

// 一个立即退出的进程：拿到一个确定已死的 pid（等待 exit 事件后再用）
async function spawnDeadPid() {
  const dead = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" })
  await new Promise((ok) => dead.on("exit", ok))
  return dead.pid
}

// daemon.json 原文（不经 readDaemonInfo 规范化，便于断言逐字段）
function readRawInfo(stateDir) {
  return JSON.parse(readFileSync(join(stateDir, "daemon.json"), "utf8"))
}

// 把 daemon.json 改写成指向「别的活守护进程」的真实身份（pid/port 都是它的 →
// 写前复查的探测命中它、hello.pid 又与 prev.pid 一致 → 判冲突），模拟「另一个
// 守护进程刚写了 daemon.json」的接管形状
function fakeForeignOwner(stateDir, pid, port) {
  writeFileSync(
    join(stateDir, "daemon.json"),
    JSON.stringify({ pid, port, key: KEY, version: "x", startedAt: new Date().toISOString() }),
  )
}

// 拿一个当前空闲的端口（先占后放：探测必然拒绝连接）
async function grabFreePort() {
  const s = net.createServer()
  await new Promise((ok) => s.listen(0, "127.0.0.1", ok))
  const port = s.address().port
  await new Promise((ok) => s.close(ok))
  return port
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred, deadlineMs, what) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const v = await pred()
    if (v) return v
    await tick(200)
  }
  throw new Error(`等待超时：${what}`)
}

// 起一个**真实的外来守护进程子进程**（独立 pid/端口，--port 0 由 OS 挑空闲口）。
// 身份校验后，「真双开」的赢家必须是真实异进程守护进程：daemon.json 的 {pid,port}
// 与端口上应答的 hello.pid 三者一致，写前复查才判冲突 —— 这正是竞态赢家落盘的
// 真实形状（旧的「假 pid + 健康端口」组合在新谓词下不再是冲突，见下方放行用例）。
async function spawnForeignDaemon(stateDir) {
  const child = spawn(process.execPath, [DAEMON_PATH, "--cfg", stateDir, "--state", stateDir, "--port", "0"], {
    stdio: "ignore",
    env: { ...process.env },
  })
  const info = await waitFor(async () => {
    const d = readDaemonInfo(stateDir)
    if (!d || Number(d.pid) !== child.pid) return null
    return (await probeDaemon(d.port, d.key).catch(() => null)) ? d : null
  }, 20000, "外来守护进程子进程就绪")
  return { child, info }
}

// 收尾：POST /api/shutdown 请子进程退场（与生产同一通道），超时兜底 kill
async function stopForeignDaemon(w) {
  if (!w?.child) return
  if (w.info) await shutdownDaemon(w.info).catch(() => {})
  const exited = await Promise.race([
    new Promise((ok) => w.child.once("exit", () => ok(true))),
    tick(3000).then(() => false),
  ])
  if (!exited && w.child.exitCode === null) w.child.kill()
}

describe("B6 写前复查：daemon.json 已被别的活守护进程写入 → 本进程不双活", () => {
  test("启动路径：bind 后发现 daemon.json 指向真实外来守护进程（pid/port/hello.pid 一致）→ 拒绝启动（WB_DAEMON_ALREADY_RUNNING）且不覆盖 daemon.json", async () => {
    const stateDir = makeSandbox("wb-dstart-boot-").dir
    // 真双开竞态的「赢家」：真实守护进程子进程，已把自己的 {pid,port} 写进
    // daemon.json（全新沙箱里它先起、先写 —— 竞态输家读到的正是这份形状）
    const winner = await spawnForeignDaemon(stateDir)
    try {
      // 输家视角：bind 前的门已滑过（skipExistingCheck —— 那道门发生在 bind 前，
      // 探不到自己；本用例专测 bind 后的写前复查），此刻 daemon.json 是赢家写的
      await assert.rejects(
        () => boot(stateDir, { key: "another-key", skipExistingCheck: true }),
        (e) => e.code === "WB_DAEMON_ALREADY_RUNNING" && /写前复查/.test(e.message),
      )
      // 输家没写盘：daemon.json 仍是赢家那份（pid 未被输家覆盖）
      const raw = readRawInfo(stateDir)
      assert.equal(raw.pid, winner.info.pid, "拒绝启动的进程绝不能覆盖 daemon.json")
      assert.notEqual(raw.pid, process.pid)
      // 赢家不受影响，且 hello 带着它自己的 pid（身份校验的依据）
      const hello = await fetch(`http://127.0.0.1:${winner.info.port}/api/hello`)
      assert.equal(hello.status, 200)
      assert.equal((await hello.json()).pid, winner.info.pid)
    } finally {
      await stopForeignDaemon(winner)
      cleanupSandbox(stateDir) // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("运行路径：心跳写盘前发现 daemon.json 被真实外来守护进程接管 → 优雅退出、不覆写、端口不再服务", async () => {
    const stateDir = makeSandbox("wb-dstart-tick-").dir
    const foreignSb = makeSandbox("wb-dstart-tick-foreign-").dir
    const h = await boot(stateDir) // 进程内在役守护进程（noTimers，手动驱动心跳）
    // 外来守护进程必须起在**自己的沙箱**：若与 h 同目录，它启动时的写前复查会
    // 看到 h 的 daemon.json（真实活守护进程）而按真双开退场 —— 那是另一条用例
    const winner = await spawnForeignDaemon(foreignSb)
    try {
      // 运行中 daemon.json 被改写成外来守护进程的真实身份（接管形状）
      fakeForeignOwner(stateDir, winner.info.pid, winner.info.port)
      await h.ticks.heartbeatGuarded()
      assert.ok(h.stopped, "写前复查发现接管 → 本进程优雅退出")
      await h.whenStopped
      // 不覆盖：文件仍是外来者那份（本进程的 pid 从未写回）
      const raw = readRawInfo(stateDir)
      assert.equal(raw.pid, winner.info.pid)
      assert.notEqual(raw.pid, process.pid)
      // 端口已不再服务（双活被消除）
      await assert.rejects(() =>
        fetch(`http://127.0.0.1:${h.port}/api/hello`, { signal: AbortSignal.timeout(1500) }),
      )
    } finally {
      await stopForeignDaemon(winner)
      await h.stop().catch(() => {})
      cleanupSandbox(stateDir)
      cleanupSandbox(foreignSb)
    }
  })
})

describe("B6 身份校验的放行分支：探到的不是 daemon.json 记的那个 → 不误判、放行覆写", () => {
  test("daemon.json 记着陈旧 pid，端口上应答的是**另一个**健康守护进程（自探/别家）→ 正常启动并覆写（2026-11 生产死局修复）", async () => {
    const stateDir = makeSandbox("wb-dstart-mismatch-").dir
    const h = await boot(stateDir) // 端口上真正应答的守护进程（进程内，hello.pid = 本测试进程）
    const dummy = spawnDummy() // daemon.json 记的「陈旧」pid（活着、但不是守护进程）
    try {
      fakeForeignOwner(stateDir, dummy.pid, h.port)
      // skipExistingCheck=true：bind 前的门保持旧语义（pidAlive + 探活健康即拒，
      // 它发生在 bind 前、探不到自己），本用例专测 bind 后写前复查的新谓词
      const b = await boot(stateDir, { key: "another-key", skipExistingCheck: true })
      try {
        // 探到的 hello.pid（= 本测试进程）≠ prev.pid（dummy）→ 不算接管 → 放行覆写
        const raw = readRawInfo(stateDir)
        assert.equal(raw.pid, process.pid, "身份不符 → 放行，daemon.json 被新进程覆写")
        assert.equal(raw.port, b.port)
        const hello = await fetch(`http://127.0.0.1:${b.port}/api/hello`)
        assert.equal(hello.status, 200)
        assert.equal((await hello.json()).pid, process.pid)
      } finally {
        await b.stop()
      }
      // 原在役守护进程不受影响
      assert.equal((await fetch(`http://127.0.0.1:${h.port}/api/hello`)).status, 200)
    } finally {
      dummy.kill()
      await h.stop()
      cleanupSandbox(stateDir)
    }
  })
})

describe("B6 不伤正常路径：陈旧条目、重启窗口照常启动并覆写", () => {
  test("daemon.json 指向已死进程（陈旧条目）→ 正常启动并写回自己的 pid", async () => {
    const stateDir = makeSandbox("wb-dstart-stale-").dir
    const deadPid = await spawnDeadPid()
    writeFileSync(
      join(stateDir, "daemon.json"),
      JSON.stringify({ pid: deadPid, port: 12345, key: "old", version: "x", startedAt: new Date().toISOString() }),
    )
    const h = await boot(stateDir) // 死 pid → 探活失败 → 放行覆写
    try {
      const raw = readRawInfo(stateDir)
      assert.equal(raw.pid, process.pid, "陈旧条目被新进程覆写（重启路径）")
      assert.equal(raw.port, h.port)
      const hello = await fetch(`http://127.0.0.1:${h.port}/api/hello`)
      assert.equal(hello.status, 200)
    } finally {
      await h.stop()
      cleanupSandbox(stateDir)
    }
  })

  test("daemon.json 指向活着的进程但 /api/hello 不通（重启窗口：旧进程退场中）→ 正常启动（不误伤端口顺延）", async () => {
    const stateDir = makeSandbox("wb-dstart-window-").dir
    const dummy = spawnDummy() // 活着，但它的「端口」上没有任何服务
    try {
      const freePort = await grabFreePort()
      fakeForeignOwner(stateDir, dummy.pid, freePort)
      const h = await boot(stateDir) // pid 活但探活失败 → 不算接管 → 放行
      try {
        const raw = readRawInfo(stateDir)
        assert.equal(raw.pid, process.pid, "重启窗口（pid 活、服务已关）必须放行覆写")
        const hello = await fetch(`http://127.0.0.1:${h.port}/api/hello`)
        assert.equal(hello.status, 200)
      } finally {
        await h.stop()
      }
    } finally {
      dummy.kill()
      cleanupSandbox(stateDir)
    }
  })

  test("无 daemon.json（全新状态目录）→ 初始 claim 直通、心跳正常落盘", async () => {
    const stateDir = makeSandbox("wb-dstart-fresh-").dir
    const h = await boot(stateDir)
    try {
      assert.equal(readDaemonInfo(stateDir).pid, process.pid)
      assert.ok(readDaemonInfo(stateDir).port > 0)
      // noTimers 下手动驱动一次守护化心跳：无外来条目 → 正常写回
      await h.ticks.heartbeatGuarded()
      assert.ok(h.stopped === false, "正常心跳绝不触发退场")
      assert.equal(readDaemonInfo(stateDir).pid, process.pid)
      assert.ok(readFileSync(join(stateDir, "daemon.heartbeat"), "utf8").length > 0)
    } finally {
      await h.stop()
      cleanupSandbox(stateDir)
    }
  })
})

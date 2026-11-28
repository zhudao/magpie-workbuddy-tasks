// tests-shell/host-restart-lifecycle.test.mjs —— issue #9 回归：
//   1. shutdownDaemon 与 POST /api/shutdown?pid=... 身份校验：pid 不匹配绝不误杀
//      后来接管同一端口的新守护进程（返回 false / 409）；
//   2. 宿主 A 退出不杀共享守护进程：宿主 A 拉起守护进程 → 宿主 B 复用 → 宿主 A
//      SIGTERM 退出 → 守护进程仍然存活、4390/端口不断；
//   3. 复用后若守护进程被外部进程树清理带走，宿主 B 的 3s 复用复查自动拉起恢复；
//   4. plugins.json off:true 时 ensureDaemon 不拉起（守住停用方向）；
//   5. ensureDaemon 传入更高/不同 version 时平滑替换旧版本守护进程。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  PLUGIN_NAME,
  ensureDaemon,
  isPluginDisabledInConfig,
  pidAlive,
  probeDaemon,
  readDaemonInfo,
  shutdownDaemon,
  stateDirFor,
} from "../lifecycle.mjs"
import { WorkBuddyTasksPlugin } from "../index.mjs"
import { cleanupAllSandboxes, makeSandbox } from "../tests/helpers.mjs"

const PLUGIN_ROOT = fileURLToPath(new URL("../", import.meta.url))
const DAEMON_PATH = fileURLToPath(new URL("../daemon.mjs", import.meta.url))
const INDEX_URL = new URL("../index.mjs", import.meta.url).href

after(() => {
  cleanupAllSandboxes()
})

const tick = (ms = 100) => new Promise((r) => setTimeout(r, ms))

async function waitFor(pred, deadlineMs, what) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const v = await pred()
    if (v) return v
    await tick(150)
  }
  throw new Error(`等待超时：${what}`)
}

async function freePort() {
  const net = await import("node:net")
  return new Promise((ok) => {
    const s = net.createServer()
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port
      s.close(() => ok(p))
    })
  })
}

describe("issue #9：宿主重启防误杀与守护进程保活", () => {
  test("shutdownDaemon 与 /api/shutdown?pid= 校验：pid 不匹配拒绝关闭，匹配才退出", async () => {
    const cfgDir = makeSandbox("wb-i9-pid-").dir
    const stateDir = stateDirFor(cfgDir)
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(cfgDir, "plugins.json"), JSON.stringify({ plugins: [{ spec: "github:me/magpie-workbuddy-tasks" }] }))
    const port = await freePort()
    const r = await ensureDaemon({ cfgDir, pluginDir: PLUGIN_ROOT, budgetMs: 20000, port })
    assert.equal(r.error, undefined)
    assert.ok(r.info?.pid)
    try {
      const wrongPid = r.info.pid + 99999
      // 1) shutdownDaemon 携带不匹配的 pid → 探测即拦截返回 false，不打断原进程
      const killedWrong = await shutdownDaemon({ ...r.info, pid: wrongPid })
      assert.equal(killedWrong, false, "pid 不匹配时 shutdownDaemon 必须拒绝")
      assert.ok(pidAlive(r.info.pid), "原守护进程必须仍然存活")
      assert.ok(await probeDaemon(r.info.port, r.info.key), "端口服务不受影响")

      // 2) 直接打 POST /api/shutdown?pid=错误pid → 409 pid mismatch
      const direct = await fetch(`http://127.0.0.1:${r.info.port}/api/shutdown?pid=${wrongPid}`, {
        method: "POST",
      })
      assert.equal(direct.status, 409)
      const body = await direct.json()
      assert.equal(body.ok, false)
      assert.equal(body.pid, r.info.pid)
      assert.ok(await probeDaemon(r.info.port, r.info.key), "409 后守护进程继续服务")

      // 3) 传入正确 pid → 成功优雅退出
      const killedRight = await shutdownDaemon(r.info)
      assert.equal(killedRight, true)
      await waitFor(() => !pidAlive(r.info.pid), 10000, "匹配 pid 后守护进程退出")
    } finally {
      if (r.info && pidAlive(r.info.pid)) {
        await shutdownDaemon(r.info).catch(() => {})
      }
    }
  })

  test("宿主 A 退出不杀共享守护进程；宿主 B 复用后即使守护进程被外部杀掉也能 3s 复查自愈", async () => {
    const cfgDir = makeSandbox("wb-i9-host-").dir
    const stateDir = stateDirFor(cfgDir)
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(join(cfgDir, "plugins.json"), JSON.stringify({ plugins: [{ spec: "github:me/magpie-workbuddy-tasks" }] }))
    const port = await freePort()

    // 宿主 A（独立子进程）加载插件并拉起守护进程
    const hostAScript = `
      import { WorkBuddyTasksPlugin } from ${JSON.stringify(INDEX_URL)};
      const logs = [];
      await WorkBuddyTasksPlugin({ directory: ${JSON.stringify(cfgDir)}, client: { app: { log: (e) => logs.push(e.message) } } }, { port: ${port} });
      console.log("HOST_A_READY");
      process.stdin.resume();
      process.stdin.on("end", () => process.emit("SIGTERM"));
      setInterval(() => {}, 1000);
    `
    const hostA = spawn(process.execPath, ["--input-type=module", "-e", hostAScript], {
      stdio: ["pipe", "pipe", "pipe"],
    })
    let hostAOut = ""
    let hostAExited = false
    hostA.stdout.on("data", (d) => { hostAOut += d.toString("utf8") })
    hostA.once("exit", () => { hostAExited = true })

    let daemonInfo = null
    try {
      await waitFor(() => hostAOut.includes("HOST_A_READY"), 15000, "宿主 A 加载完成")
      daemonInfo = await waitFor(async () => {
        const d = readDaemonInfo(stateDir)
        if (!d) return null
        return (await probeDaemon(d.port, d.key).catch(() => null)) ? d : null
      }, 20000, "宿主 A 拉起的守护进程就绪")
      const pidA = daemonInfo.pid

      // 宿主 B 加载插件（走到「复用已有」，!spawned）
      const logsB = []
      await WorkBuddyTasksPlugin(
        { directory: cfgDir, client: { app: { log: (e) => logsB.push(e.message) } } },
        { port },
      )
      await waitFor(() => logsB.some((l) => l.includes("复用已有")), 10000, "宿主 B 复用已有守护进程")

      // 模拟插件自动更新：宿主 A 收到 SIGTERM 并走 registerExitHooks 退出
      hostA.stdin.end()
      await waitFor(() => hostAExited, 5000, "宿主 A 退出")
      await tick(600)

      // 核心断言：宿主 A 退出后，守护进程 pidA 仍然活着且端口正常响应
      assert.ok(pidAlive(pidA), "宿主 A 退出绝不能关掉共享守护进程")
      const helloAfterA = await probeDaemon(daemonInfo.port, daemonInfo.key)
      assert.equal(helloAfterA?.pid, pidA)

      // 再模拟 Windows 进程树清理外部杀掉 pidA：宿主 B 的 3s 复用复查应自动拉起新守护进程
      process.kill(pidA, "SIGKILL")
      await waitFor(() => !pidAlive(pidA), 5000, "旧守护进程 pidA 被杀")
      const recovered = await waitFor(async () => {
        const d = readDaemonInfo(stateDir)
        if (!d || d.pid === pidA) return null
        return (await probeDaemon(d.port, d.key).catch(() => null)) ? d : null
      }, 15000, "宿主 B 复用复查自动拉起新守护进程")
      assert.notEqual(recovered.pid, pidA)
      assert.equal(recovered.port, port)
      daemonInfo = recovered
    } finally {
      if (!hostAExited) hostA.kill("SIGKILL")
      const cur = readDaemonInfo(stateDir) || daemonInfo
      if (cur && pidAlive(cur.pid)) await shutdownDaemon(cur).catch(() => {})
    }
  })

  test("plugins.json off:true 时 ensureDaemon 不拉起；version 变化时平滑替换旧版本", async () => {
    const cfgDir = makeSandbox("wb-i9-off-").dir
    const stateDir = stateDirFor(cfgDir)
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      join(cfgDir, "plugins.json"),
      JSON.stringify({ plugins: [{ spec: "github:me/magpie-workbuddy-tasks", off: true }] }),
    )
    assert.equal(isPluginDisabledInConfig(cfgDir), true)
    const rOff = await ensureDaemon({ cfgDir, pluginDir: PLUGIN_ROOT, budgetMs: 5000 })
    assert.equal(rOff.off, true)
    assert.equal(rOff.spawned, false)
    assert.equal(readDaemonInfo(stateDir), null, "off:true 时绝不拉起或残留 daemon.json")

    // 移除 off:true 后启动一个真实子进程充当「旧版本」daemon（手工改写 package.json 太重，
    // 直接验证 version 参数与运行中版本号一致时复用、不一致时平滑替换）
    writeFileSync(
      join(cfgDir, "plugins.json"),
      JSON.stringify({ plugins: [{ spec: "github:me/magpie-workbuddy-tasks" }] }),
    )
    assert.equal(isPluginDisabledInConfig(cfgDir), false)
    const port = await freePort()
    const first = await ensureDaemon({ cfgDir, pluginDir: PLUGIN_ROOT, budgetMs: 20000, port })
    assert.equal(first.spawned, true)
    try {
      const hello = await probeDaemon(first.info.port, first.info.key)
      assert.equal(hello.name, PLUGIN_NAME)
      // 传入不同 version → 触发平滑替换，新 pid ≠ 旧 pid
      const upgraded = await ensureDaemon({
        cfgDir,
        pluginDir: PLUGIN_ROOT,
        budgetMs: 20000,
        port,
        version: `${hello.version}-next`,
      })
      assert.equal(upgraded.spawned, true)
      assert.notEqual(upgraded.info.pid, first.info.pid, "版本变化应替换旧守护进程")
      assert.ok(!pidAlive(first.info.pid), "旧守护进程应已退出")
      assert.ok(await probeDaemon(upgraded.info.port, upgraded.info.key), "新守护进程就绪")
      await shutdownDaemon(upgraded.info).catch(() => {})
    } finally {
      const cur = readDaemonInfo(stateDir)
      if (cur && pidAlive(cur.pid)) await shutdownDaemon(cur).catch(() => {})
    }
  })
})

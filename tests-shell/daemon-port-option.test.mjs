// tests-shell/daemon-port-option.test.mjs —— issue #5 回归（0.3.8）：
// 端口不再从残留 daemon.json 继承 + 插件选项 port 可固定端口。
//
// 生产症状（issue #5）：历史某次端口顺延（被占用 +1..+9 或随机端口）把 8761 写进
// 了 state/daemon.json；旧 ensureDaemon 把 `prev.port` 当偏好回传（WB_DAEMON_PORT），
// 于是「停掉再重启，daemon.json 仍是 8761、4390 空出来了也回不去」，而插件入口卡
// 按 4390 推导看板地址 → 永远打不开。修复口径：daemon.json 的 port 是**观察值/复
// 用线索**，绝不回灌成偏好；期望端口只来自显式传入（index.mjs 里源头是插件选项
// options.port，经 normalizePort 归一），未传 = 默认 4390。
//
// 测法：走生产同款通道 ensureDaemon（真实子进程）。残留 daemon.json 的 pid 填测
// 试进程自己的 pid（活着但绝不是守护进程 —— 与 daemon-restart-stale-pid 同款形状，
// kill(pid,0) 假阳性），port 填一个被哑 HTTP 服务**占住**的端口 Q：复用门探 Q 探
// 到的是不合格的 hello（404）→ 不误复用、必然走到 spawn；同时 Q 被占住意味着子
// 进程无论顺延还是随机端口兜底都绝不可能绑上 Q，断言才稳。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PLUGIN_NAME, ensureDaemon, normalizePort, pidAlive, shutdownDaemon, stateDirFor } from "../lifecycle.mjs"
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox } from "../tests/helpers.mjs"

const KEY = "port-option-test-key-0123456789abcdef"
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

// 先占后放拿一个当前空闲的端口
async function grabFreePort() {
  return new Promise((ok) => {
    const s = http.createServer()
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port
      s.close(() => ok(port))
    })
  })
}

// 占住一个端口并持续持有（返回 {srv, port}，由调用方释放）：保证「另一空闲端口
// Q」在整轮测试里绝不会被子进程的顺延/随机端口兜底撞上，也绝不含糊。
async function holdPort() {
  return new Promise((ok) => {
    const srv = http.createServer(() => {})
    srv.listen(0, "127.0.0.1", () => ok({ srv, port: srv.address().port }))
  })
}

// 收尾：通知子进程退场、等它退出、释放占位端口、删沙箱（Windows 文件占用）
async function teardown(r, held, cfgDir) {
  if (r?.info) {
    await shutdownDaemon(r.info).catch(() => {})
    await waitFor(() => !pidAlive(r.info.pid), 10000, "守护进程子进程退出").catch(() => {})
  }
  if (held) await new Promise((ok) => held.srv.close(ok))
  cleanupSandbox(cfgDir)
}

function staleDaemonJson(stateDir, port) {
  // issue #5 的生产残留形状：port = 历史顺延结果（Q），pid = 看着活着的非守护进程
  writeFileSync(
    join(stateDir, "daemon.json"),
    JSON.stringify({ pid: process.pid, port, key: KEY, version: "x", startedAt: new Date().toISOString(), host: "127.0.0.1" }),
  )
}

describe("issue #5 回归：显式 port 生效、残留 daemon.json 的端口不再被继承", () => {
  test("显式 port=P + 残留 daemon.json（port=Q、pid 看着活着）→ 守护进程绑 P，绝不绑 Q", async () => {
    const cfgDir = makeSandbox("wb-port-opt-").dir
    const stateDir = stateDirFor(cfgDir)
    mkdirSync(stateDir, { recursive: true })
    const held = await holdPort() // Q：整轮被占住，子进程绝无可能选中它
    const qPort = held.port
    const pPort = await grabFreePort() // P：先占后放，此刻空闲
    assert.notEqual(pPort, qPort, "前置：P 与 Q 必须是两个端口")
    staleDaemonJson(stateDir, qPort)
    // 生产同款通道 + 显式端口（index.mjs 会把插件选项 port 传到这里）
    const logs = []
    const r = await ensureDaemon({ cfgDir, pluginDir: PLUGIN_ROOT, log: (...a) => logs.push(a.join(" ")), budgetMs: 20000, port: pPort })
    try {
      assert.equal(r.error, undefined, `ensureDaemon 不应报错：${r.error ?? ""}`)
      assert.equal(r.spawned, true, "残留条目探活不合格（Q 上是哑 HTTP 服务）→ 应 spawn 而非复用")
      assert.ok(r.info, "应返回就绪守护进程的信息")
      // 一次证明两件事：显式端口生效 + 残留端口不再继承
      assert.equal(r.info.port, pPort, "必须绑显式传入的 P")
      assert.notEqual(r.info.port, qPort, "绝不绑残留 daemon.json 记的 Q")
      assert.equal(readRawInfo(stateDir).port, pPort, "daemon.json 的 port 应更新为实际绑定的 P")
      const hello = await fetch(`http://127.0.0.1:${r.info.port}/api/hello`)
      assert.equal(hello.status, 200)
      assert.equal((await hello.json()).name, PLUGIN_NAME)
    } finally {
      await teardown(r, held, cfgDir)
    }
  })

  test("不传 port + 残留 daemon.json（port=Q）→ 实际端口 ≠ Q（不再被残留端口粘住）", async () => {
    const cfgDir = makeSandbox("wb-port-stale-").dir
    const stateDir = stateDirFor(cfgDir)
    mkdirSync(stateDir, { recursive: true })
    const held = await holdPort()
    staleDaemonJson(stateDir, held.port)
    const logs = []
    // 不传 port：期望端口回落默认 4390。**不硬断言 == 4390** —— 开发机上 4390
    // 可能被占而顺延（+1..+9 再随机）；「不再被残留端口粘住」才是本回归点。
    const r = await ensureDaemon({ cfgDir, pluginDir: PLUGIN_ROOT, log: (...a) => logs.push(a.join(" ")), budgetMs: 20000 })
    try {
      assert.equal(r.error, undefined, `ensureDaemon 不应报错：${r.error ?? ""}`)
      assert.equal(r.spawned, true)
      assert.ok(r.info)
      assert.notEqual(r.info.port, held.port, "实际端口绝不能等于残留 daemon.json 记的 Q（issue #5 回归点）")
      assert.equal(readRawInfo(stateDir).port, r.info.port, "daemon.json 的 port = 实际绑定端口（唯一真相）")
      const hello = await fetch(`http://127.0.0.1:${r.info.port}/api/hello`)
      assert.equal(hello.status, 200)
    } finally {
      await teardown(r, held, cfgDir)
    }
  })
})

describe("normalizePort：端口归一边界（index.mjs 与 lifecycle.mjs 共用同一实现）", () => {
  test("合法：number / 纯数字 string / 前后空白 / 边界 1 与 65535 / 前导零", () => {
    assert.equal(normalizePort(8761), 8761)
    assert.equal(normalizePort("8761"), 8761)
    assert.equal(normalizePort(" 4390 "), 4390)
    assert.equal(normalizePort(1), 1)
    assert.equal(normalizePort(65535), 65535)
    // 前导零按十进制数值收（"04390" = 4390）：options 是本地配置不是 HTTP 头，
    // 不需要 sanitizeServeHost 那套防前导零歧义的白名单，纯数字即可
    assert.equal(normalizePort("04390"), 4390)
  })

  test("非法：null/undefined/空串/0/负数/越界/小数/带字母/布尔/对象/NaN → null（忽略并回默认 4390，绝不猜）", () => {
    const bad = [
      null,
      undefined,
      "",
      "   ", // 纯空白 = 未配置
      0,
      -1,
      -4390,
      "0", // 0 留给 daemon --port 0 的「系统挑端口」语义，插件选项不开放
      "-1",
      65536,
      99999,
      "65536",
      "4390abc", // 用户多敲了字符：宁可忽略回默认，也不截断去猜
      "abc",
      "43 90",
      "0x10",
      "4390.5",
      4390.5, // number 小数：非整数端口
      true,
      false,
      NaN,
      Infinity,
      {},
      [],
    ]
    for (const v of bad) {
      assert.equal(normalizePort(v), null, `normalizePort(${typeof v === "string" ? JSON.stringify(v) : String(v)}) 应为 null`)
    }
  })

  test("index.mjs 的 _internal 透传同一实现（宿主侧不另写一份边界）", async () => {
    const { _internal } = await import("../index.mjs")
    assert.equal(_internal.normalizePort, normalizePort)
  })
})

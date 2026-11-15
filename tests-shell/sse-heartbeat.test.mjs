// tests-shell/sse-heartbeat.test.mjs —— SSE keepalive 心跳（P3-3）回归。
//
// 旧行为：/api/events 只在连上时写一次 retry 行，之后纯靠事件驱动 —— 空闲连接
// 可能被反代/中间层（nginx、反代超时、NAT）静默掐断，前端只能靠重连兜底。
// 修后：每 ssePingMs（默认 25s，测试注入更短）给所有客户端广播一行合法的 SSE
// 注释 ": ping\n\n"（EventSource/各类解析器忽略注释行，不产生任何事件）。
//
// 钉死（生命周期四件套，与文件里既有定时器同款口径）：
//   1. 连接后能在注入的短间隔内收到 ": ping" 注释行；
//   2. 最后一个客户端断开 → 心跳定时器停表（h.ssePingActive() === false，不泄漏）；
//   3. 重连接口 → 定时器重新活着（首连起表、无客户端绝不空转）；
//   4. shutdown（h.stop()）→ 定时器被清（与 timers 登记簿统一清理一致）。
//
// 全程零真实网络：引擎是假壳，fetch 走 node:http 裸流读取（不用全局 fetch ——
// 它会把 SSE 缓冲到结束才返回）。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { startDaemon } from "../daemon.mjs"
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox } from "../tests/helpers.mjs"

// 心跳间隔注入 40ms：断言窗口（数百 ms）内必有多条 ping，又不至于刷屏。
const PING_MS = 40
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms))

// 裸 http GET 打开 /api/events 流，收集 chunk，返回 {chunks, close}。
function openSse(port) {
  const chunks = []
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
      res.on("data", (d) => chunks.push(String(d)))
      res.on("error", () => {})
      resolve({
        chunks,
        text: () => chunks.join(""),
        close: () => {
          try {
            res.destroy()
          } catch {}
          try {
            req.destroy()
          } catch {}
        },
      })
    })
    req.on("error", reject)
  })
}

function fakeEngine() {
  return {
    store: { loadAccounts: () => [], eligibleAccounts: () => [] },
    runner: null,
    tasks: null,
    upstream: null,
    errors: [],
    ok: true,
  }
}

const keep = []
after(() => {
  for (const d of keep) cleanupSandbox(d)
  cleanupAllSandboxes()
})

async function boot({ ssePingMs = PING_MS } = {}) {
  const stateDir = makeSandbox("wb-sse-ping-").dir
  keep.push(stateDir)
  return startDaemon({
    key: "sse-ping-key-0123456789abcdef",
    port: 0,
    stateDir,
    engine: fakeEngine(),
    ssePingMs,
    noTimers: true,
    skipExistingCheck: true,
  })
}

describe("SSE keepalive 心跳（P3-3）", () => {
  test("连接后收到 ': ping' 注释行；最后客户端断开 → 定时器停表不泄漏", async () => {
    const h = await boot()
    let stream = null
    try {
      assert.equal(h.ssePingActive(), false, "无客户端时不起表")
      stream = await openSse(h.port)
      await tick(PING_MS * 3)
      const t = stream.text()
      assert.ok(t.startsWith("retry: 3000\n\n"), `首行仍是 retry 行，实际 ${JSON.stringify(t.slice(0, 20))}`)
      assert.ok(t.includes(": ping\n\n"), "必须在注入间隔内收到 SSE 注释心跳行")
      assert.ok(!t.includes("data:"), "空闲期（无事件）不应夹带 data 事件")

      assert.equal(h.ssePingActive(), true, "有客户端 → 定时器活着")
      stream.close()
      await tick(PING_MS * 3)
      assert.equal(h.ssePingActive(), false, "最后一个客户端断开 → 定时器必须停表（不泄漏）")
    } finally {
      stream?.close()
      await h.stop()
    }
  })

  test("断开再重连：定时器重新起表；stop() 后定时器被清（shutdown 清理）", async () => {
    const h = await boot()
    let s1 = null
    let s2 = null
    try {
      assert.equal(h.ssePingActive(), false)
      s1 = await openSse(h.port)
      await tick(PING_MS * 2)
      assert.equal(h.ssePingActive(), true, "首连起表")
      s1.close()
      await tick(PING_MS * 2)
      assert.equal(h.ssePingActive(), false, "断开停表")

      s2 = await openSse(h.port)
      await tick(PING_MS * 2)
      assert.equal(h.ssePingActive(), true, "重连后重新起表")
      await h.stop() // shutdown：连同 timers 登记簿一起清
      s2 = null
      assert.equal(h.ssePingActive(), false, "shutdown 后心跳定时器必须被清掉")
    } finally {
      s1?.close()
      s2?.close()
      await h.stop().catch(() => {})
    }
  })

  test("两个客户端只共用一个定时器；全部断开才停表", async () => {
    const h = await boot()
    let a = null
    let b = null
    try {
      a = await openSse(h.port)
      await tick(PING_MS * 2)
      assert.equal(h.ssePingActive(), true)
      b = await openSse(h.port)
      a.close()
      await tick(PING_MS * 2)
      assert.equal(h.ssePingActive(), true, "还剩一个客户端 → 定时器继续活着")
      b.close()
      await tick(PING_MS * 2)
      assert.equal(h.ssePingActive(), false, "全部断开才停表")
    } finally {
      a?.close()
      b?.close()
      await h.stop()
    }
  })

  test("手动手跳钩子：ticks.ssePing() 向所有客户端写注释行（noTimers 模式可驱动）", async () => {
    const h = await boot({ ssePingMs: 25000 }) // 默认间隔：跑不到定时，手动驱动
    let stream = null
    try {
      stream = await openSse(h.port)
      await tick(30)
      assert.ok(!stream.text().includes(": ping"), "25s 间隔内不会自动出 ping")
      h.ticks.ssePing()
      await tick(30)
      assert.ok(stream.text().includes(": ping\n\n"), "手动驱动一次就出一条注释行")
    } finally {
      stream?.close()
      await h.stop()
    }
  })
})

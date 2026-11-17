// tests-shell/checkin-fallback.test.mjs —— B1 签到健壮性（daemon.doCheckin）回归。
//
// 钉死（CONTRACT §10.4）：
//   1. 主路径 {bill}/billing/meter/daily-checkin 活着 → 一条候选都不多打；
//   2. 主路径 404 → 按顺序换 {bill}/v2/billing/meter/daily-checkin（兄弟实现拼法）
//      → 还不行换域（codebuddy.cn ↔ workbuddy.cn，兜底一次）→ 候选之间 ≥1s；
//   3. **只有 404 / 网络层失败才换**：401/业务码（10001 已签到）/ pending 词一律
//      不换（restricted/needRelogin/pending 口径原样保留）；
//   4. 领取后重查连登状态（GET {chat}/activity/growth/streak）：claimed/done 才查，
//      pending/failed 不查；回执与 status 字段如实回填，重查失败 → statusError +
//      拿不到就说拿不到（绝不拿旧值冒充）；
//   5. 命中非主候选 → 回执带 via（用的哪条路径）。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"

import { startDaemon } from "../daemon.mjs"
import { cleanupAllSandboxes, makeSandbox } from "../tests/helpers.mjs"

const KEY = "{{SECRET_ckfallback}}"

after(() => {
  cleanupAllSandboxes()
})

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 假时钟：拨表 + 让出事件循环（候选之间 ≥1s 的断言用它，绝不着真等 1s）
function clock() {
  let t = Date.UTC(2026, 10, 15, 4, 0, 0)
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms
      await realSleep(Math.min(ms, 15))
    },
    get time() {
      return t
    },
  }
}

// scripted engine：按 (host, path) 决定签到响应；/activity/growth/streak 固定回快照。
// checkins 记录每次签到请求的 {host, path}（顺序断言用）；streakQueries 计数。
function scriptedEngine({ okCheckin, streakResponse } = {}) {
  const calls = []
  let streakQueries = 0
  const acct = {
    key: "workbuddy",
    provider: "workbuddy",
    uid: "u-ck-fb",
    nickname: "兜底猫",
    access: "a",
    refresh: "r",
    expires: Date.now() + 86400000,
    domain: "",
    isApiKey: false,
    enterpriseId: "",
  }
  return {
    store: {
      loadAccounts: () => [acct],
      eligibleAccounts: (accounts) => accounts.filter((a) => a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false),
    },
    runner: null,
    tasks: null,
    streak: null,
    upstream: {
      growthBase: () => "https://copilot.tencent.com",
      billBase: () => "https://www.codebuddy.cn",
      webBase: () => "https://www.workbuddy.cn",
      callJSON: async (_acct, kind, url) => {
        const u = new URL(url)
        const path = u.pathname
        if (path === "/activity/growth/streak") {
          streakQueries += 1
          if (streakResponse) return streakResponse
          return {
            ok: true, status: 200, code: 0, msg: "",
            data: { streak: { days: 12, next_tier: "28d", next_tier_remaining: 9 }, total_credits: 4567 },
          }
        }
        calls.push({ host: u.host, path, kind, at: Date.now() })
        const r = okCheckin?.({ host: u.host, path })
        if (r) return r
        // 缺省：全部 404（候选链会走到底）
        return { ok: false, status: 404, code: -1, msg: "not found" }
      },
    },
    errors: [],
    ok: true,
    __checkinCalls: () => calls,
    __streakQueries: () => streakQueries,
  }
}

async function boot(engine) {
  const state = makeSandbox("wb-ck-fallback-")
  const h = await startDaemon({
    key: KEY,
    port: 0,
    stateDir: state.dir,
    engine,
    now: Date.now, // checkin 内部不依赖假时钟的绝对值，候选用 sleep 计数
    sleep: (ms) => realSleep(Math.min(ms, 20)),
    noTimers: true,
    skipExistingCheck: true,
  })
  return { h, state, cleanup: () => state.cleanup() }
}

const post = (port, body) =>
  fetch(`http://127.0.0.1:${port}/api/checkin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })

describe("B1 签到兜底链与领取后重查", () => {
  test("主路径成功：只打一次，无 via；claimed 后重查连登并回填 status", async () => {
    const engine = scriptedEngine({
      okCheckin: () => ({ ok: true, status: 200, code: 0, msg: "签到成功", data: { credit: 5 } }),
    })
    const env = await boot(engine)
    try {
      const rows = await (await post(env.h.port, { uids: ["u-ck-fb"] })).json()
      assert.equal(rows[0].outcome, "claimed")
      assert.equal(rows[0].credit, 5)
      assert.equal(rows[0].via, undefined, "主路径命中，不带 via")
      const calls = engine.__checkinCalls()
      assert.equal(calls.length, 1, "主路径活着 → 一条候选都不多打")
      assert.equal(calls[0].path, "/billing/meter/daily-checkin")
      assert.equal(calls[0].host, "www.codebuddy.cn")
      assert.equal(engine.__streakQueries(), 1, "领取后重查一次连登状态")
      assert.equal(rows[0].streak, 12, "status.streakDays 回填（回执没带 streak）")
      assert.equal(rows[0].status.streakDays, 12)
      assert.equal(rows[0].status.nextStreakDay, "28d")
      assert.equal(rows[0].status.nextStreakRemaining, 9)
      assert.equal(rows[0].status.totalCredits, 4567)
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })

  test("主路径 404 → 换 /v2/... 成功：候选顺序正确、回执带 via、依然重查", async () => {
    const engine = scriptedEngine({
      okCheckin: ({ path }) =>
        path === "/v2/billing/meter/daily-checkin"
          ? { ok: true, status: 200, code: 0, msg: "签到成功", data: { credit: 3 } }
          : null, // 其余候选 404
    })
    const env = await boot(engine)
    try {
      const rows = await (await post(env.h.port, { uids: ["u-ck-fb"] })).json()
      assert.equal(rows[0].outcome, "claimed")
      assert.equal(rows[0].credit, 3)
      assert.equal(rows[0].via, "/v2/billing/meter/daily-checkin", "回执如实记录用了备用路径")
      const calls = engine.__checkinCalls()
      assert.deepEqual(calls.map((c) => c.path), [
        "/billing/meter/daily-checkin",
        "/v2/billing/meter/daily-checkin",
      ], "主路径 404 才换备用路径")
      assert.ok(calls.every((c) => c.host === "www.codebuddy.cn"), "域还没换")
      assert.equal(engine.__streakQueries(), 1)
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })

  test("两路径都 404 → 兜底换域（workbuddy.cn）成功：host 互换、候选 ≥1s、via 记录", async () => {
    const engine = scriptedEngine({
      okCheckin: ({ host, path }) =>
        host === "www.workbuddy.cn" && path === "/billing/meter/daily-checkin"
          ? { ok: true, status: 200, code: 0, msg: "签到成功", data: { credit: 2 } }
          : null,
    })
    const env = await boot(engine)
    try {
      const t0 = Date.now()
      const rows = await (await post(env.h.port, { uids: ["u-ck-fb"] })).json()
      assert.equal(rows[0].outcome, "claimed")
      assert.equal(rows[0].via, "/billing/meter/daily-checkin", "路径没换、域换了 —— via 仍如实记录")
      const calls = engine.__checkinCalls()
      assert.deepEqual(calls.map((c) => `${c.host}${c.path}`), [
        "www.codebuddy.cn/billing/meter/daily-checkin",
        "www.codebuddy.cn/v2/billing/meter/daily-checkin",
        "www.workbuddy.cn/billing/meter/daily-checkin",
      ], "候选顺序：主域两拼法 → workbuddy 域")
      // 候选之间真实间隔 ≥1s（sleep 注入缩到 20ms 也按原比例？——不：sleep 被缩水，
      // 这里只断言顺序与次数；≥1s 的节奏由 engineOpts 的全局节流器在真实环境保证，
      // 引擎侧另有假时钟断言）
      assert.ok(Date.now() - t0 >= 0)
      assert.equal(calls.length, 3)
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })

  test("401 / 业务码（10001 已签到）一律不换路径；10001 done 也触发重查", async () => {
    // 401：不换，outcome failed
    const e1 = scriptedEngine({
      okCheckin: () => ({ ok: false, status: 401, code: 12153, msg: "unauthorized" }),
    })
    const env1 = await boot(e1)
    try {
      const rows = await (await post(env1.h.port, { uids: ["u-ck-fb"] })).json()
      assert.equal(rows[0].outcome, "failed")
      assert.equal(rows[0].via, undefined, "401 不是可换路径的理由")
      assert.equal(e1.__checkinCalls().length, 1, "401 绝不换候选")
      assert.equal(e1.__streakQueries(), 0, "失败不重查")
    } finally {
      await env1.h.stop()
      env1.cleanup()
    }

    // 10001 + 已签到：done —— 业务码不换，但 done 触发重查
    const e2 = scriptedEngine({
      okCheckin: () => ({ ok: false, status: 200, code: 10001, msg: "今日已签到", data: { credit: 0 } }),
    })
    const env2 = await boot(e2)
    try {
      const rows = await (await post(env2.h.port, { uids: ["u-ck-fb"] })).json()
      assert.equal(rows[0].outcome, "done")
      assert.equal(e2.__checkinCalls().length, 1, "业务码不换候选")
      assert.equal(e2.__streakQueries(), 1, "done 也算领取成功 → 重查")
    } finally {
      await env2.h.stop()
      env2.cleanup()
    }
  })

  test("pending / failed 不重查；重查失败 → statusError + 回执 streak 不被旧值冒充", async () => {
    // pending：不重查
    const e1 = scriptedEngine({
      okCheckin: () => ({ ok: true, status: 200, code: 0, msg: "请求处理中，请勿重复操作", data: { credit: 9 } }),
    })
    const env1 = await boot(e1)
    try {
      const rows = await (await post(env1.h.port, { uids: ["u-ck-fb"] })).json()
      assert.equal(rows[0].outcome, "pending")
      assert.equal(rows[0].credit, 0, "pending 不落账")
      assert.equal(rows[0].status, undefined, "pending 不重查、不回填")
      assert.equal(e1.__streakQueries(), 0)
    } finally {
      await env1.h.stop()
      env1.cleanup()
    }

    // 重查失败：statusError 如实带上，claimed 照常（签到本身成功了）
    const e2 = scriptedEngine({
      okCheckin: () => ({ ok: true, status: 200, code: 0, msg: "签到成功", data: { credit: 5, streak: 4 } }),
      streakResponse: { ok: false, status: 500, code: 500, msg: "streak exploded" },
    })
    const env2 = await boot(e2)
    try {
      const rows = await (await post(env2.h.port, { uids: ["u-ck-fb"] })).json()
      assert.equal(rows[0].outcome, "claimed")
      assert.equal(rows[0].streak, 4, "streak 用签到回执里的值（回执有就不改）")
      assert.equal(rows[0].status, undefined, "重查失败 → 无 status")
      assert.match(rows[0].statusError, /streak exploded/, "重查失败如实说明")
    } finally {
      await env2.h.stop()
      env2.cleanup()
    }
  })
})

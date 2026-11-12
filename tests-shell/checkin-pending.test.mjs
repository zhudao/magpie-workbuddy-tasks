// tests-shell/checkin-pending.test.mjs —— /api/checkin 回执细分（CONTRACT §10.4，
// hub #596）的守护进程回归：fake engine + 可编程 upstream.callJSON，零真实网络。
//
// 钉死：
//   1. msg 含「处理中 / 请勿重复操作 / 系繁忙 / 稍后再试」→ outcome "pending"：
//      不算成功（credit 0）、当天可重试 —— 原实现把 code=0 一律当成功，会把
//      「请求处理中，请勿重复操作」记成已领；
//   2. code 0 + msg 含「失败」→ failed；code 0 + 「不足」绝不是失败（claimed）；
//   3. code 10001 + 「已签到」→ done；code 10001 其他 → failed；其他 code → failed；
//   4. 显式指定已冻结账号 → failed + 「恢复」提示（CONTRACT §10.5）。
//   5. 缺省目标 = eligibleNow（排除冻结账号）。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { startDaemon } from "../daemon.mjs"
import { cleanupAllSandboxes, makeSandbox } from "../tests/helpers.mjs"

const KEY = "{{SECRET_ckpending}}"

after(() => {
  cleanupAllSandboxes()
})

// fake engine：store 两个账号（u-ck01 健康 / u-ck02 留给冻结用例）；upstream.callJSON
// 按脚本队列逐个吐信封
function scriptedEngine(responses) {
  let i = 0
  const acct = (uid, nickname) => ({
    key: uid === "u-ck01" ? "workbuddy" : "workbuddy#ck02",
    provider: "workbuddy",
    uid,
    nickname,
    access: "a",
    refresh: "r",
    expires: Date.now() + 86400000,
    domain: "",
    isApiKey: false,
    enterpriseId: "",
  })
  return {
    store: {
      loadAccounts: () => [acct("u-ck01", "签到猫"), acct("u-ck02", "冻结猫")],
      eligibleAccounts: (accounts) =>
        accounts.filter((a) => a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false),
    },
    runner: null,
    tasks: null,
    streak: null,
    upstream: {
      growthBase: () => "https://copilot.tencent.com",
      billBase: () => "https://www.codebuddy.cn",
      webBase: () => "https://www.workbuddy.cn",
      callJSON: async (_acct, kind, url) => {
        const path = new URL(url).pathname
        assert.equal(path, "/billing/meter/daily-checkin", "签到只打 daily-checkin")
        assert.equal(kind, "billing")
        const next = responses[Math.min(i, responses.length - 1)]
        i += 1
        return next
      },
    },
    errors: [],
    ok: true,
    __calls: () => i,
  }
}

async function boot(responses, { frozen = [] } = {}) {
  const state = makeSandbox("wb-ck-pending-")
  if (frozen.length) {
    writeFileSync(
      join(state.dir, "frozen.json"),
      JSON.stringify(Object.fromEntries(frozen.map((uid) => [uid, { at: new Date().toISOString(), code: 11140, message: "request illegal" }]))),
    )
  }
  const h = await startDaemon({
    key: KEY,
    port: 0,
    stateDir: state.dir,
    engine: scriptedEngine(responses),
    noTimers: true,
    skipExistingCheck: true,
  })
  return { h, state, cleanup: () => state.cleanup() }
}

const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })

describe("/api/checkin 回执细分（CONTRACT §10.4）", () => {
  test("「请求处理中，请勿重复操作」→ pending：不算成功、积分为 0、当天可重试", async () => {
    const env = await boot([{ ok: true, status: 200, code: 0, msg: "请求处理中，请勿重复操作", data: { credit: 5 } }])
    try {
      const r = await post(env.h.port, "/api/checkin", { uids: ["u-ck01"] })
      assert.equal(r.status, 200)
      const rows = await r.json()
      assert.equal(rows[0].outcome, "pending", "pending 不算成功")
      assert.equal(rows[0].credit, 0, "pending 的积分不可信，不落账")
      assert.match(rows[0].message, /请勿重复操作/)
      // 当天可重试：再打一次，上游照样被调（没有「已领」的本地记忆）
      const before = env.h.engine.__calls()
      await post(env.h.port, "/api/checkin", { uids: ["u-ck01"] })
      assert.equal(env.h.engine.__calls(), before + 1, "第二次请求照常发出（pending 不落账）")
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })

  test("code 0：成功 → claimed；「失败」→ failed；「不足」→ 绝不判失败", async () => {
    const env = await boot([
      { ok: true, status: 200, code: 0, msg: "签到成功", data: { credit: 5, streak: 3 } },
      { ok: true, status: 200, code: 0, msg: "签到失败：系统开小差了", data: {} },
      { ok: true, status: 200, code: 0, msg: "距离 7 天奖励还不足 1 天", data: { credit: 2 } },
    ])
    try {
      const r = await post(env.h.port, "/api/checkin", { uids: ["u-ck01"] })
      // 同一账号打三次：脚本队列依次吐三个信封
      const rows1 = await r.json()
      assert.equal(rows1[0].outcome, "claimed")
      assert.equal(rows1[0].credit, 5)
      const rows2 = await (await post(env.h.port, "/api/checkin", { uids: ["u-ck01"] })).json()
      assert.equal(rows2[0].outcome, "failed", "「失败」是唯一硬词")
      const rows3 = await (await post(env.h.port, "/api/checkin", { uids: ["u-ck01"] })).json()
      assert.equal(rows3[0].outcome, "claimed", "「不足」不得判失败（§10.4）")
      assert.equal(rows3[0].credit, 2)
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })

  test("code 10001 + 已签到 → done；code 10001 其他 → failed；其他 code → failed", async () => {
    const env = await boot([
      { ok: true, status: 200, code: 10001, msg: "今日已签到", data: { credit: 0 } },
      { ok: true, status: 200, code: 10001, msg: "what?" },
      { ok: false, status: 200, code: 500, msg: "boom" },
    ])
    try {
      const r1 = await (await post(env.h.port, "/api/checkin", { uids: ["u-ck01"] })).json()
      assert.equal(r1[0].outcome, "done")
      const r2 = await (await post(env.h.port, "/api/checkin", { uids: ["u-ck01"] })).json()
      assert.equal(r2[0].outcome, "failed")
      const r3 = await (await post(env.h.port, "/api/checkin", { uids: ["u-ck01"] })).json()
      assert.equal(r3[0].outcome, "failed")
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })

  test("pending 词优先于 code：10001 +「稍后再试」也是 pending；成功信封缺 msg → claimed", async () => {
    const env = await boot([
      { ok: true, status: 200, code: 10001, msg: "系统繁忙，稍后再试" },
      { ok: true, status: 200, code: 0, msg: "", data: { credit: 7 } },
    ])
    try {
      const r1 = await (await post(env.h.port, "/api/checkin", { uids: ["u-ck01"] })).json()
      assert.equal(r1[0].outcome, "pending", "pending 词优先于 10001/done")
      const r2 = await (await post(env.h.port, "/api/checkin", { uids: ["u-ck01"] })).json()
      assert.equal(r2[0].outcome, "claimed")
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })

  test("显式指定已冻结账号 → failed +「恢复」提示；缺省目标排除冻结账号", async () => {
    const env = await boot([{ ok: true, status: 200, code: 0, msg: "签到成功", data: { credit: 5 } }], {
      frozen: ["u-ck02"],
    })
    try {
      // 显式点名冻结账号：如实失败（不静默跳过）
      const r = await (await post(env.h.port, "/api/checkin", { uids: ["u-ck02"] })).json()
      assert.equal(r[0].outcome, "failed")
      assert.match(r[0].message, /账号已冻结/)
      assert.match(r[0].message, /恢复/)
      // 缺省目标排除冻结账号：只剩 u-ck01 签到成功
      const def = await (await post(env.h.port, "/api/checkin", {})).json()
      assert.deepEqual(
        def.map((x) => [x.uid, x.outcome]),
        [["u-ck01", "claimed"]],
        "缺省目标排除冻结账号",
      )
      // 冻结账号零上游：脚本只被 u-ck01 消费了 1 个信封
      assert.equal(env.h.engine.__calls(), 1)
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })
})

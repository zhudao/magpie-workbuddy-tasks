// tests-shell/checkin-stats.test.mjs —— issue #6：签到收益进「今日积分」。
//
// 生产缺陷：doCheckin 是 manualOp 直调的单账号操作，不产生 step、也不走
// finalizeJob，所以签到拿到的积分从来进不了 history.json；而 computeStats 只累加
// history，看板「今日积分」在只有签到的日子里恒为 0。magpie 本体（auth.checkin /
// settings.workbuddyCheckin）自动签到的收益更是在它自己的 plugin-checkin.json 里，
// 本插件完全读不到。
//
// 本文件用假引擎 + 可编程 upstream.callJSON（零真实网络）钉死：
//   1. POST /api/checkin 成功后落一条 leg="checkin" 的历史行，credited 进今日积分，
//      且不产生新的「运行轮次」（jobId 为空）；
//   2. pending（「处理中」）→ state=skip、credit 0，绝不入账；
//   3. magpie 的 plugin-checkin.json 里当日 workbuddy 条目计入今日积分；
//   4. 同一天「手签历史行」与「本体账本」是同一份收益：按账号取较大值，绝不相加；
//   5. 账本里别的厂商（trae-cn）、别的日子、认不出的键一律不计。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { startDaemon } from "../daemon.mjs"
import { cleanupAllSandboxes, makeSandbox } from "../tests/helpers.mjs"

const KEY = "{{SECRET_ckstats}}"

after(() => {
  cleanupAllSandboxes()
})

// 两个账号：u-ck01（key "workbuddy"）/ u-ck02（key "workbuddy#ck02"）
function fakeEngine(responses) {
  let i = 0
  const acct = (key, uid, nickname) => ({
    key,
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
      loadAccounts: () => [acct("workbuddy", "u-ck01", "签到猫"), acct("workbuddy#ck02", "u-ck02", "搬砖猫")],
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
        // B1.2：签到成功后 daemon 会重查一次连登状态（独立于签到脚本队列）
        if (path === "/activity/growth/streak") {
          assert.equal(kind, "chat")
          return { ok: true, status: 200, code: 0, msg: "", data: { streak: { days: 3 } } }
        }
        assert.match(path, /daily-checkin$/, "签到只打 daily-checkin")
        assert.equal(kind, "billing")
        const next = responses[Math.min(i, responses.length - 1)]
        i += 1
        return next
      },
    },
    errors: [],
    ok: true,
  }
}

async function boot(responses, ledger) {
  const state = makeSandbox("wb-ck-stats-")
  const cfg = makeSandbox("wb-ck-cfg-")
  mkdirSync(join(cfg.dir), { recursive: true })
  if (ledger) writeFileSync(join(cfg.dir, "plugin-checkin.json"), JSON.stringify(ledger), "utf8")
  const h = await startDaemon({
    key: KEY,
    port: 0,
    stateDir: state.dir,
    cfgDir: cfg.dir,
    engine: fakeEngine(responses),
    noTimers: true,
    skipExistingCheck: true,
  })
  return {
    h,
    state,
    cfg,
    cleanup: () => {
      state.cleanup()
      cfg.cleanup()
    },
  }
}

const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })

const get = async (port, path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json()

describe("签到收益进「今日积分」（issue #6）", () => {
  test("claimed 签到 → 落一条 leg=checkin 历史行、计入今日积分、不多算运行轮次", async () => {
    const env = await boot([{ ok: true, status: 200, code: 0, msg: "签到成功", data: { credit: 100, streak: 3 } }])
    try {
      const rows = await (await post(env.h.port, "/api/checkin", { uids: ["u-ck01"] })).json()
      assert.equal(rows[0].outcome, "claimed")
      assert.equal(rows[0].credit, 100)

      const hist = await get(env.h.port, "/api/history?limit=10")
      const line = hist.rows.find((r) => r.leg === "checkin")
      assert.ok(line, "签到必须落一条 leg=checkin 的历史行")
      assert.equal(line.state, "ok")
      assert.equal(line.credit, 100)
      assert.equal(line.uid, "u-ck01")
      assert.equal(line.jobId || "", "", "签到不是运行轮次，历史行不带 jobId")

      const st = await get(env.h.port, "/api/state")
      assert.equal(st.stats.creditsToday, 100, "签到收益必须进今日积分")
      assert.equal(st.stats.checkinCreditsToday, 100)
      assert.equal(st.stats.runs, 0, "签到不该让运行轮次变成 1")
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })

  test("pending（处理中）→ state=skip、credit 0，绝不入账", async () => {
    const env = await boot([{ ok: true, status: 200, code: 0, msg: "请求处理中，请勿重复操作", data: { credit: 100 } }])
    try {
      const rows = await (await post(env.h.port, "/api/checkin", { uids: ["u-ck01"] })).json()
      assert.equal(rows[0].outcome, "pending")
      const st = await get(env.h.port, "/api/state")
      assert.equal(st.stats.creditsToday, 0, "处理中的收益不落账")
      assert.equal(st.stats.checkinCreditsToday, 0)
      const line = (await get(env.h.port, "/api/history?limit=10")).rows.find((r) => r.leg === "checkin")
      assert.equal(line.state, "skip")
      assert.equal(line.credit, 0)
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })

  test("magpie 本体账本（plugin-checkin.json）当日 workbuddy 条目计入今日积分", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date())
    const env = await boot([{ ok: true, status: 200, code: 0, msg: "签到成功", data: { credit: 100 } }], {
      "workbuddy|workbuddy": { day: today, outcome: "done", credit: 100 },
      "workbuddy|ck02": { day: today, outcome: "claimed", credit: 100 },
      "trae-cn|trae-cn": { day: today, outcome: "claimed", credit: 100 },
      "workbuddy|unknown-login": { day: today, outcome: "claimed", credit: 100 },
      "workbuddy|ck01": { day: "2020-01-01", outcome: "claimed", credit: 100 },
    })
    try {
      // 只调 state（不签到）：账本本身就足以让今日积分不为 0
      const st = await get(env.h.port, "/api/state")
      assert.equal(st.stats.checkinCreditsToday, 200, "两个可识别账号各 100；trae / 陌生键 / 往日条目不计")
      assert.equal(st.stats.creditsToday, 200)
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })

  test("同一天手签历史行 + 本体账本：按账号取较大值，绝不重复相加", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date())
    const env = await boot([{ ok: true, status: 200, code: 0, msg: "今天已签到", data: { credit: 100 } }], {
      "workbuddy|workbuddy": { day: today, outcome: "done", credit: 100 },
    })
    try {
      const rows = await (await post(env.h.port, "/api/checkin", { uids: ["u-ck01"] })).json()
      assert.equal(rows[0].outcome, "done")
      const st = await get(env.h.port, "/api/state")
      assert.equal(st.stats.creditsToday, 100, "同一份收益只能算一次")
      assert.equal(st.stats.checkinCreditsToday, 100)
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })

  // 生产账本的真实形状（2026-11-24 实测）：键是 "<vendor>|<plugin-auth 条目键>"，
  // 条目里除 day/outcome/credit 还带 at/streak/claimed 等字段 —— 多出来的字段不能
  // 影响判定。这条用例把真实账本的整体形状搬进沙箱，防止"只在合成数据上对"。
  test("生产账本真实形状（含 at/streak/claimed 等额外字段）照常计入", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date())
    const env = await boot([{ ok: true, status: 200, code: 0, msg: "签到成功", data: { credit: 100 } }], {
      "workbuddy|workbuddy": {
        day: today,
        at: new Date().toISOString(),
        outcome: "claimed",
        credit: 100,
        streak: 55,
        claimed: new Date().toISOString(),
      },
      "workbuddy|ck02": { day: today, at: new Date().toISOString(), outcome: "claimed", credit: 100, streak: 55 },
      "doubao|doubao": { day: today, at: new Date().toISOString(), outcome: "failed", msg: "豆包返回未知错误" },
      "loomy|loomy": { day: today, at: new Date().toISOString(), outcome: "done", msg: "每日赠送积分已刷新" },
    })
    try {
      const st = await get(env.h.port, "/api/state")
      assert.equal(st.stats.checkinCreditsToday, 200, "只算两个 workbuddy 账号；doubao/loomy 不计")
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })

  // 看板 3 秒轮询 /api/state 会反复调 computeStats：账本按 mtime+size 签名缓存，
  // 文件没变不重复解析；magpie 刚写完（签名变）必须立刻看到新值，不能靠 TTL 等。
  test("账本读盘按签名缓存：未变更不重复解析，变更后立刻生效", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date())
    const env = await boot([{ ok: true, status: 200, code: 0, msg: "签到成功", data: { credit: 100 } }], {
      "workbuddy|workbuddy": { day: today, outcome: "claimed", credit: 100 },
    })
    try {
      const a = await get(env.h.port, "/api/state")
      assert.equal(a.stats.checkinCreditsToday, 100)
      // 再读两次：命中缓存，值不变（且不会因为重复解析而叠加）
      assert.equal((await get(env.h.port, "/api/state")).stats.checkinCreditsToday, 100)
      assert.equal((await get(env.h.port, "/api/state")).stats.checkinCreditsToday, 100)
      // magpie 又给第二个账号签了（签名变）→ 立刻反映，无需等 TTL
      writeFileSync(
        join(env.cfg.dir, "plugin-checkin.json"),
        JSON.stringify({
          "workbuddy|workbuddy": { day: today, outcome: "claimed", credit: 100 },
          "workbuddy|ck02": { day: today, outcome: "claimed", credit: 100 },
        }),
        "utf8",
      )
      const b = await get(env.h.port, "/api/state")
      assert.equal(b.stats.checkinCreditsToday, 200, "账本变更后必须立刻重读，不靠 TTL")
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })
})

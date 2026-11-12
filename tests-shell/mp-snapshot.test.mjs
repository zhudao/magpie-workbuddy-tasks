// tests-shell/mp-snapshot.test.mjs —— 小程序任务并入快照/看板（0.3.0）回归：
//
// 生产背景（2026-11-06 只读实测）：小程序清单（MP_HEADERS）12 项，含
// Sequential_Tasks_1（完成 1 次对话，not_accepted）；引擎早已实现 MP 执行链路
//（engine/miniprogram.mjs），但 MP 任务此前不进快照/看板 —— 用户看不到、也勾不到。
//
// 修复口径（本文件钉死）：
//   1. refreshSnapshots 在 web fetchTasks 之后用 fetchMPTasks 再拉一份 MP 清单，
//      **只合并 web 清单里没有的 code**（同 code 以 web 清单为准，绝不重复/覆盖）；
//      MP 拉取失败只记日志，不影响 web 快照；
//   2. taskkind 对 MP code（MP_TASK_SPECS 命中或 Sequential_Tasks_ 前缀）返回
//      source:"mp"/kind:"mp" → snapTask 投影出完整 14 键 + canAccept/canLight；
//   3. /api/task/accept 按 isMPCode 分流（web → acceptTasks、MP → acceptMPTasks），
//      返回形状不变；/api/task/claim 对 MP code 用 claimMPTask（MP 头族）。
// 零真实网络：fetch 全部注入假后端。
import { test, describe, after } from "node:test"
import assert from "node:assert/strict"

import { startDaemon } from "../daemon.mjs"
import * as tasksMod from "../engine/tasks.mjs"
import * as mpMod from "../engine/miniprogram.mjs"
import * as upstreamMod from "../engine/upstream.mjs"
import {
  cleanupAllSandboxes,
  cleanupSandbox,
  fakeClock,
  makeAcct,
  makeSandbox,
  task,
  wbBackend,
} from "../tests/helpers.mjs"

after(() => {
  cleanupAllSandboxes()
})

const KEY = "test-key-mp-snap"

const account = {
  key: "workbuddy",
  provider: "workbuddy",
  uid: "u1",
  nickname: "阿猫",
  access: "a",
  refresh: "r",
  expires: Date.now() + 86400000,
  domain: "",
  isApiKey: false,
  enterpriseId: "",
}

function storeFake() {
  return {
    readMagpieConfigDir: () => null,
    loadAccounts: () => [account],
    eligibleAccounts: (accounts) =>
      accounts.filter((a) => a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false),
  }
}

function runnerFake() {
  return {
    JobRunner: class JobRunner {
      constructor(ctx) {
        this.ctx = ctx
      }
      start() {
        throw new Error("not used")
      }
      get() {
        return null
      }
      current() {
        return null
      }
      holds() {
        return []
      }
    },
  }
}

// upstream 替身：energy/streak 按 P1 口径回值（data.balance / data.streak.days）
function upstreamFake() {
  return {
    growthBase: () => "https://copilot.tencent.com",
    billBase: () => "https://www.codebuddy.cn",
    webBase: () => "https://www.workbuddy.cn",
    callJSON: async (_acct, _kind, url) => {
      if (String(url).endsWith("/v2/activity/growth/energy")) {
        return { ok: true, status: 200, code: 0, msg: "", data: { balance: 42 } }
      }
      if (String(url).endsWith("/activity/growth/streak")) {
        return { ok: true, status: 200, code: 0, msg: "", data: { streak: { days: 7 } } }
      }
      return { ok: true, status: 200, code: 0, msg: "", data: {} }
    },
  }
}

const WEB_TASKS = () => [
  {
    code: "chat_5",
    title: "和 AI 聊天 5 次",
    acceptStatus: "accepted",
    taskType: "single",
    progress: { current: 3, target: 5 },
    rewardCredit: 100,
    rewardEnergy: 5,
    jumpUrl: "workbuddy://chat",
    unforgeable: false,
    reason: "",
  },
]

// MP 清单：两个 MP 专属 code + 一个与 web 重复的 code（验证「只补缺失」不重复）
const MP_TASKS = () => [
  {
    code: "Sequential_Tasks_1",
    title: "完成 1 次对话",
    acceptStatus: "not_accepted",
    taskType: "single",
    progress: { current: 0, target: 1 },
    rewardCredit: 100,
  },
  {
    code: "Sequential_Tasks_2",
    title: "小程序专家对话",
    acceptStatus: "accepted",
    taskType: "single",
    progress: { current: 0, target: 1 },
    rewardCredit: 200,
  },
  {
    code: "chat_5",
    title: "和 AI 聊天 5 次",
    acceptStatus: "accepted",
    taskType: "single",
    progress: { current: 3, target: 5 },
    rewardCredit: 100,
  },
]

function engineWithMP({ mpImpl } = {}) {
  return {
    store: storeFake(),
    runner: runnerFake(),
    tasks: { fetchTasks: async () => WEB_TASKS().map((t) => ({ ...t })) },
    // mpImpl: undefined（不装 miniprogram）| "ok" | "boom"（拉取即抛）
    ...(mpImpl === "ok" ? { miniprogram: { fetchMPTasks: async () => MP_TASKS().map((t) => ({ ...t })) } } : {}),
    ...(mpImpl === "boom"
      ? { miniprogram: { fetchMPTasks: async () => { throw new Error("mp upstream down") } } }
      : {}),
    upstream: upstreamFake(),
    errors: [],
    ok: true,
  }
}

const SNAP_KEYS = [
  "acceptStatus", "canAccept", "canLight", "code", "description", "desktopOnly", "jumpUrl",
  "lockHint", "locked", "lockedUntil", "pinnedExpertId", "progress", "reason",
  "rewardCredit", "rewardEnergy", "taskType", "title", "unforgeable",
]

describe("MP 任务并入 /api/state 快照（refreshSnapshots 合并）", () => {
  test("MP-only 任务进快照：18 键完整、canAccept/canLight 按状态、重复 code 不并入", async () => {
    const sb = makeSandbox("wb-tasks-mp-snap-")
    const h = await startDaemon({
      key: KEY,
      port: 0,
      stateDir: sb.dir,
      engine: engineWithMP({ mpImpl: "ok" }),
      noTimers: true,
      skipExistingCheck: true,
      sleep: async () => {},
    })
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/api/state?refresh=1`, {
        headers: { authorization: `Bearer ${KEY}` },
      })
      assert.equal(res.status, 200)
      const st = await res.json()
      const snap = st.accounts[0].snapshot
      assert.ok(snap, "快照可用")
      // web 1 项 + MP 专属 2 项（chat_5 重复 → 不并入）
      assert.equal(snap.tasks.length, 3, `应为 web 1 + MP 专属 2，实际 ${snap.tasks.length}`)
      assert.equal(new Set(snap.tasks.map((t) => t.code)).size, 3, "code 无重复")

      const byCode = new Map(snap.tasks.map((t) => [t.code, t]))
      const mp1 = byCode.get("Sequential_Tasks_1")
      assert.ok(mp1, "Sequential_Tasks_1 进快照")
      assert.deepEqual(Object.keys(mp1).sort(), SNAP_KEYS, "MP 任务 18 键完整（判断字段 + 次日锁字段不得 undefined）")
      assert.equal(mp1.desktopOnly, false)
      assert.equal(mp1.unforgeable, false)
      assert.equal(mp1.reason, "")
      assert.equal(mp1.pinnedExpertId, "")
      assert.equal(mp1.locked, false, "无锁记录 → locked=false")
      assert.equal(mp1.lockedUntil, "", "无锁记录 → lockedUntil 空串")
      assert.equal(mp1.lockHint, "", "无锁记录 → lockHint 空串")
      assert.equal(mp1.canAccept, true, "not_accepted → 可接取（看板可勾）")
      assert.equal(mp1.canLight, false)
      assert.equal(mp1.title, "完成 1 次对话")
      assert.equal(mp1.rewardCredit, 100)

      const mp2 = byCode.get("Sequential_Tasks_2")
      assert.ok(mp2, "Sequential_Tasks_2 进快照")
      assert.equal(mp2.canAccept, false, "accepted → 不再给接取结论")
      assert.equal(mp2.canLight, true, "accepted → 小程序链路可点亮")
      assert.equal(mp2.rewardCredit, 200)

      // web 任务原样保留（以 web 清单为准）
      const web = byCode.get("chat_5")
      assert.equal(web.canLight, true, "accepted 的 chat_5 可点亮")
      assert.equal(snap.energy, 42)
      assert.equal(snap.streak, 7)
    } finally {
      await h.stop()
      cleanupSandbox(sb.dir)
    }
  })

  test("MP 拉取失败只记日志，web 快照不受影响", async () => {
    const sb = makeSandbox("wb-tasks-mp-fail-")
    const logs = []
    const h = await startDaemon({
      key: KEY,
      port: 0,
      stateDir: sb.dir,
      engine: engineWithMP({ mpImpl: "boom" }),
      noTimers: true,
      skipExistingCheck: true,
      sleep: async () => {},
      log: (...a) => logs.push(a.join(" ")),
    })
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/api/state?refresh=1`, {
        headers: { authorization: `Bearer ${KEY}` },
      })
      assert.equal(res.status, 200)
      const st = await res.json()
      const snap = st.accounts[0].snapshot
      assert.ok(snap, "web 快照不受 MP 失败影响")
      assert.equal(snap.tasks.length, 1, "只有 web 清单任务")
      assert.equal(snap.tasks[0].code, "chat_5")
      assert.equal(snap.energy, 42)
      assert.ok(logs.some((l) => l.includes("小程序清单拉取失败")), logs.join("\n"))
    } finally {
      await h.stop()
      cleanupSandbox(sb.dir)
    }
  })

  test("引擎没装 miniprogram 模块（旧 fake 引擎形态）→ 快照照常，只有 web 清单", async () => {
    const sb = makeSandbox("wb-tasks-mp-absent-")
    const h = await startDaemon({
      key: KEY,
      port: 0,
      stateDir: sb.dir,
      engine: engineWithMP(), // 无 miniprogram 键
      noTimers: true,
      skipExistingCheck: true,
      sleep: async () => {},
    })
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/api/state?refresh=1`, {
        headers: { authorization: `Bearer ${KEY}` },
      })
      assert.equal(res.status, 200)
      const st = await res.json()
      const snap = st.accounts[0].snapshot
      assert.ok(snap)
      assert.equal(snap.tasks.length, 1)
      assert.equal(snap.tasks[0].code, "chat_5")
    } finally {
      await h.stop()
      cleanupSandbox(sb.dir)
    }
  })
})

// ---- /api/task/accept 与 /api/task/claim 的 isMPCode 分流 ---------------------
// 真实引擎模块（tasks/miniprogram/upstream）+ wbBackend 假上游：断言 web code 走
// chat 头族、MP code 走 MP_HEADERS（X-Client-Platform: miniprogram），响应形状不变。

function realEngineWithBackend(backend) {
  return {
    store: storeFake(),
    runner: runnerFake(),
    tasks: tasksMod,
    miniprogram: mpMod,
    upstream: upstreamMod,
    errors: [],
    ok: true,
    __backend: backend,
  }
}

const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })

describe("单账号操作按 isMPCode 分流（0.3.0）", () => {
  test("/api/task/accept：web/MP 两组分别用 acceptTasks / acceptMPTasks，结果合并形状不变", async () => {
    const clock = fakeClock(Date.now())
    const backend = wbBackend({
      clock,
      tasks: [
        task("chat_5", { title: "和 AI 聊天 5 次", target: 5 }),
        task("Sequential_Tasks_1", { title: "完成 1 次对话" }),
        task("school_season", { title: "校园日活动" }),
      ],
      mpOnly: ["Sequential_Tasks_1", "school_season"], // MP 清单口径：web 清单不含它们
      litRules: {},
    })
    const sb = makeSandbox("wb-tasks-mp-accept-")
    const h = await startDaemon({
      key: KEY,
      port: 0,
      stateDir: sb.dir,
      engine: realEngineWithBackend(backend),
      noTimers: true,
      skipExistingCheck: true,
      sleep: async () => {},
      fetch: backend.fetchImpl,
    })
    try {
      const res = await post(h.port, "/api/task/accept", { uid: "u1", codes: ["chat_5", "Sequential_Tasks_1", "school_season"] })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.deepEqual(body, {
        accepted: ["chat_5", "Sequential_Tasks_1", "school_season"],
        already: [],
        failed: [],
      })

      // 两次 accept：一次 web 头族（chat_5）、一次 MP 头族（两个 MP code）
      const acceptCalls = backend.calls.filter((c) => c.path === "/v2/activity/growth/tasks/accept")
      assert.equal(acceptCalls.length, 2)
      const webCall = acceptCalls.find((c) => c.headers["X-Client-Platform"] !== "miniprogram")
      const mpCall = acceptCalls.find((c) => c.headers["X-Client-Platform"] === "miniprogram")
      assert.ok(webCall && mpCall, "web 与 MP 各一次 accept")
      assert.deepEqual(webCall.body.task_codes, ["chat_5"])
      assert.deepEqual(mpCall.body.task_codes, ["Sequential_Tasks_1", "school_season"])
      assert.equal(backend.state.tasks.find((t) => t.task_code === "Sequential_Tasks_1").accept_status, "accepted")
    } finally {
      await h.stop()
      cleanupSandbox(sb.dir)
    }
  })

  test("/api/task/claim：MP code 用 MP 头族（claimMPTask），web code 走原 claimTask；形状不变", async () => {
    const clock = fakeClock(Date.now())
    const backend = wbBackend({
      clock,
      tasks: [
        task("chat_5", { title: "和 AI 聊天 5 次", status: "completed", current: 5, target: 5 }),
        task("Sequential_Tasks_1", { title: "完成 1 次对话", status: "completed", current: 1, target: 1 }),
      ],
      mpOnly: ["Sequential_Tasks_1"],
      litRules: {},
    })
    const sb = makeSandbox("wb-tasks-mp-claim-")
    const h = await startDaemon({
      key: KEY,
      port: 0,
      stateDir: sb.dir,
      engine: realEngineWithBackend(backend),
      noTimers: true,
      skipExistingCheck: true,
      sleep: async () => {},
      fetch: backend.fetchImpl,
    })
    try {
      const mpRes = await post(h.port, "/api/task/claim", { uid: "u1", code: "Sequential_Tasks_1" })
      assert.equal(mpRes.status, 200)
      const mpBody = await mpRes.json()
      assert.equal(mpBody.ok, true)
      assert.equal(mpBody.credit, 100)
      assert.equal(mpBody.energy, 0)
      assert.deepEqual(Object.keys(mpBody).sort(), ["credit", "energy", "ok", "reason", "via"], "形状与 web 领奖一致")

      const webRes = await post(h.port, "/api/task/claim", { uid: "u1", code: "chat_5" })
      assert.equal(webRes.status, 200)
      const webBody = await webRes.json()
      assert.equal(webBody.ok, true)
      assert.equal(webBody.via, "chat")

      // 头族分流：MP code 的 claim 带 X-Client-Platform: miniprogram，web 的不带
      const claimCalls = backend.calls.filter((c) => c.path.endsWith("/claim"))
      assert.equal(claimCalls.length, 2)
      const mpClaim = claimCalls.find((c) => c.path.includes("Sequential_Tasks_1"))
      const webClaim = claimCalls.find((c) => c.path.includes("chat_5"))
      assert.equal(mpClaim.headers["X-Client-Platform"], "miniprogram", "MP 领奖走小程序头族")
      assert.notEqual(webClaim.headers["X-Client-Platform"], "miniprogram", "web 领奖不带 MP 头")
      assert.deepEqual(backend.state.claims, ["Sequential_Tasks_1", "chat_5"])
    } finally {
      await h.stop()
      cleanupSandbox(sb.dir)
    }
  })
})

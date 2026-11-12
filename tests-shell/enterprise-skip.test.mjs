// tests-shell/enterprise-skip.test.mjs —— 企业版账号整体过滤（社区 issue #3）自测
// （node --test）。企业版（provider==="workbuddy" 且 acct.enterpriseId 非空）没有
// 成长任务与签到，与国际版（intlSkipped）完全同口径处理：
//   1. 不进 /api/state 的 accounts[]；顶层 enterpriseSkipped 只给 count+note
//      （count=0 时字段保留；note 绝不含 uid/昵称/域名/enterpriseId）；
//   2. 与 intlSkipped 各自独立计数（provider 分域，绝不重复统计）；
//   3. 不进 eligibleNow() → /api/run 缺省 uids 与排程选号；显式点名如实失败
//      （/api/run 400、单账号操作「找不到账号」、零上游调用）；
//   4. /api/credits 与 /api/streak 对企业版 uid 404 且给专属文案；
//   5. 未知路由 404 带 hint 指路重启守护进程，error 原文不变。
// 口径见 docs/CONTRACT.md §3。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

import { startDaemon } from "../daemon.mjs"
import { eligibleAccounts, loadAccounts } from "../engine/store.mjs"
import { CN_ISS, INTL_ISS, makeJwt } from "../tests/accountio-fixture.mjs"
import { cleanupAllSandboxes, makeSandbox } from "../tests/helpers.mjs"

// 兜底：boot() 已在 cleanup() 里即删（finally 调用）；这里再兜一层 —— 个别用例
// 漏删时在文件收尾统一回收（每条用例独占沙箱是刻意的并发隔离）。
after(() => {
  cleanupAllSandboxes()
})

const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime()
const DAY = 86400000
const INTL_NOTE = "本插件只服务国内版 workbuddy，国际版账号不列出、不参与任务、不默认导出"
const entNote = (n) => `已忽略 ${n} 个企业版账号：企业版没有成长任务与签到，本插件只服务个人版`
const ENTERPRISE_NO_GROWTH_MSG =
  "企业版账号没有成长体系（无任务与积分查询），已从看板隐藏；如需查看请在 magpie 里切换个人版账号"
const UNKNOWN_API_HINT =
  "守护进程可能还在跑更新前的旧代码：在 magpie 里关掉再开启本插件即可重启（看板顶栏「停止守护进程」后重开也行）"

const CN = { uid: "cn-uid-a", nick: "阿猫", domain: "copilot.tencent.com" }
// 企业版假账号：真实形状（oauth + enterpriseId），中文昵称 + 独立域名，便于断言泄漏
const ENT1 = { uid: "ent-uid-a", nick: "企业阿猫", domain: "ent.workbuddy.cn", enterpriseId: "ent-42" }
const ENT2 = { uid: "ent-uid-b", nick: "企业阿狗", domain: "ent.workbuddy.cn", enterpriseId: "ent-99" }
const INTL = { uid: "intl-uid-a", nick: "GlobalA", domain: "www.workbuddy.ai" }

const oauth = ({ uid, nick, domain, enterpriseId = "", intl = false }) => ({
  type: "oauth",
  access: makeJwt({ sub: uid, iss: intl ? INTL_ISS : CN_ISS, expSec: Math.floor((NOW + 30 * DAY) / 1000) }),
  refresh: `rt-${uid}`,
  expires: NOW + 30 * DAY,
  accountId: nick,
  uid,
  domain,
  refreshExpiresAt: NOW + 120 * DAY,
  tokenType: "Bearer",
  ...(enterpriseId ? { enterpriseId } : {}),
})

// 2 个人版 + 2 企业版 + 1 国际版
function mixedAuth() {
  return {
    workbuddy: oauth(CN),
    "workbuddy#ent01": oauth(ENT1),
    "workbuddy#ent02": oauth(ENT2),
    "workbuddy-ai": oauth({ ...INTL, intl: true }),
  }
}

// runner 替身：只记录 start() 收到的 spec（证明缺省/排程名单不含企业版）
function capturingRunnerEngine(started) {
  return {
    JobRunner: class JobRunner {
      constructor(ctx) {
        this.ctx = ctx
      }
      start(spec) {
        started.push(spec)
        return { id: `job-${started.length}`, state: "running", steps: [], log: [], totals: { credit: 0, energy: 0, tasksLit: 0, tasksClaimed: 0 } }
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

// 单账号操作引擎：store/eligibleAccounts 用真实现，所有会打上游的引擎出口都是
// 记录替身 —— 断言企业版被点名时这些出口一次都不被调（零上游、如实失败）。
function recordingEngine(started = []) {
  const calls = []
  const record = (name) => async (...args) => {
    calls.push(name)
    return { ok: false, reason: "不应被调用" }
  }
  return {
    engine: {
      store: { loadAccounts: (cfg) => loadAccounts(cfg), eligibleAccounts },
      runner: capturingRunnerEngine(started),
      tasks: { fetchTasks: record("fetchTasks"), claimTask: record("claimTask"), acceptTasks: record("acceptTasks") },
      upstream: { callJSON: record("callJSON"), billBase: () => "https://bill.example.invalid" },
      streak: { runStreakSteward: record("runStreakSteward") },
      errors: [],
      ok: true,
    },
    calls,
  }
}

async function boot({ authObj = mixedAuth(), extraOpts = {} } = {}) {
  const cfg = makeSandbox("wb-ent-skip-cfg-") // 每条用例独占 temp 沙箱，用完即删（见 helpers.mjs）
  const state = makeSandbox("wb-ent-skip-state-")
  if (authObj) writeFileSync(join(cfg.dir, "plugin-auth.json"), JSON.stringify(authObj, null, 2) + "\n")
  const started = []
  const { engine: eng, calls } = recordingEngine(started)
  const h = await startDaemon({
    port: 0,
    cfgDir: cfg.dir,
    stateDir: state.dir,
    engine: eng,
    now: () => NOW,
    // 手动操作/快照刷新里的人为节奏 sleep 全部换掉：测试秒级完成（间隔由
    // tests/upstream-spacer.test.mjs 等专项钉死，这里只关心选号与过滤）
    sleep: async () => {},
    noTimers: true,
    skipExistingCheck: true,
    ...extraOpts,
  })
  return {
    h,
    started,
    calls,
    cfg: cfg.dir,
    state: state.dir,
    cleanup: () => {
      cfg.cleanup()
      state.cleanup()
    },
  }
}

const base = (port) => `http://127.0.0.1:${port}`
const get = (port, path) => fetch(base(port) + path)
const post = (port, path, body) =>
  fetch(base(port) + path, {
    method: "POST",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

describe("企业版账号整体过滤（issue #3，与 intlSkipped 同口径）", () => {
  test("/api/state：企业版不进 accounts[]；enterpriseSkipped 只给计数+说明；intlSkipped 不受影响", async () => {
    const env = await boot()
    try {
      const st = await (await get(env.h.port, "/api/state")).json()
      // 列表只剩个人版 cn 一条
      assert.deepEqual(
        st.accounts.map((a) => a.uid),
        [CN.uid],
        "accounts[] 只剩个人版（2 个企业版 + 1 个国际版都不出现）",
      )
      assert.equal(st.accounts[0].eligible, true, "个人版行不受影响")
      assert.ok(st.accounts.every((a) => !("enterpriseId" in a)), "账号行不带 enterpriseId 字段")
      // 顶层诊断计数：count 正确 + note 逐字
      assert.ok(st.enterpriseSkipped, "/api/state 顶层要有 enterpriseSkipped")
      assert.equal(st.enterpriseSkipped.count, 2)
      assert.equal(st.enterpriseSkipped.note, entNote(2))
      // 与国际版各自独立：1 条 intl 只进 intlSkipped，不重复计入企业版
      assert.equal(st.intlSkipped.count, 1)
      assert.equal(st.intlSkipped.note, INTL_NOTE)
      // note/整个 payload 绝不含企业版账号内容（uid/昵称/域名/enterpriseId）
      const text = JSON.stringify(st)
      for (const leak of [ENT1.uid, ENT2.uid, ENT1.nick, ENT2.nick, ENT1.domain, ENT1.enterpriseId, ENT2.enterpriseId]) {
        assert.ok(!text.includes(leak), `企业版账号内容「${leak}」绝不出现在 /api/state`)
      }
      assert.ok(!text.includes("GlobalA") && !text.includes("www.workbuddy.ai"), "国际版内容同样不出现")
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("count=0 时字段保留（{count:0,note}）；没有国际版时 intlSkipped 同样独立归零", async () => {
    const env = await boot({ authObj: { workbuddy: oauth(CN) } })
    try {
      const st = await (await get(env.h.port, "/api/state")).json()
      assert.deepEqual(
        st.enterpriseSkipped,
        { count: 0, note: entNote(0) },
        "没有企业版也保留字段（形状与 intlSkipped 一致）",
      )
      assert.equal(st.intlSkipped.count, 0)
      assert.equal(st.accounts.length, 1)
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })

  test("eligibleNow 口径：/api/run 缺省 uids 与排程选号都不含企业版；显式点名如实失败", async () => {
    const env = await boot()
    try {
      // 缺省：job 名单只有个人版
      const run = await post(env.h.port, "/api/run", {})
      assert.equal(run.status, 200)
      assert.equal(env.started.length, 1)
      assert.deepEqual(env.started[0].uids, [CN.uid], "缺省 uids 不含企业版")

      // 显式只点企业版 → 400 如实失败（WB_NO_ACCOUNTS），绝不静默吞掉
      const only = await post(env.h.port, "/api/run", { uids: [ENT1.uid] })
      assert.equal(only.status, 400)
      assert.match((await only.json()).error, /没有可参与任务的账号/)
      assert.equal(env.started.length, 1, "失败的 run 不启动 job")

      // 混选（个人版 + 企业版）→ 只跑个人版，企业版绝不混入
      const mixed = await post(env.h.port, "/api/run", { uids: [CN.uid, ENT1.uid] })
      assert.equal(mixed.status, 200)
      assert.deepEqual(env.started[1].uids, [CN.uid], "混选名单里企业版被剔除")

      // 排程选号同口径：显式配 travel:[9]（默认 hours 全空 = 不排），拨到北京 09:00
      const st = await post(env.h.port, "/api/settings", { scheduler: true, hours: { travel: [9] } })
      assert.equal(st.status, 200)
      const at9 = Date.UTC(2026, 9, 31, 1, 0) // 北京 2026-10-31 09:00
      const fired = env.h.ticks.checkScheduler(at9)
      assert.ok(fired, "9 点在显式配置的 travel 窗口内应触发")
      assert.deepEqual(env.started[2].uids, [CN.uid], "排程触发的 job 名单不含企业版")
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })

  test("单账号操作：企业版 uid 一律「找不到」如实失败，引擎上游出口零调用", async () => {
    const env = await boot()
    try {
      // 领奖：500 + 「找不到账号」（与 intl 同款），claimTask 不被调
      const claim = await post(env.h.port, "/api/task/claim", { uid: ENT1.uid, code: "Daily_share" })
      assert.equal(claim.status, 500)
      assert.match((await claim.json()).error, /找不到账号 ent-uid-a/)

      // 接取：同款如实失败
      const accept = await post(env.h.port, "/api/task/accept", { uid: ENT1.uid, codes: ["Daily_share"] })
      assert.equal(accept.status, 500)
      assert.match((await accept.json()).error, /找不到账号 ent-uid-a/)

      // 签到：结果行 outcome failed「找不到账号」，绝不打签到上游
      const checkin = await post(env.h.port, "/api/checkin", { uids: [ENT1.uid] })
      assert.equal(checkin.status, 200)
      const rows = await checkin.json()
      assert.equal(rows[0].uid, ENT1.uid)
      assert.equal(rows[0].outcome, "failed", "显式指定的企业版账号如实失败，不静默")
      assert.equal(rows[0].message, "找不到账号")

      // 连登管家手动跑：同款
      const streak = await post(env.h.port, "/api/streak/run", { uids: [ENT1.uid] })
      assert.equal(streak.status, 200)
      const sRows = await streak.json()
      assert.equal(sRows[0].uid, ENT1.uid)
      assert.equal(sRows[0].outcome, "failed")
      assert.equal(sRows[0].message, "找不到账号")

      // 参与任务开关：企业版不在列表里 → 404（同 intl 口径）
      const toggle = await post(env.h.port, "/api/account/toggle", { uid: ENT1.uid, tasksEnabled: true })
      assert.equal(toggle.status, 404)
      assert.match((await toggle.json()).error, /找不到账号 ent-uid-a/)

      // 快照刷新点名企业版 uid → 不拉清单（refreshSnapshots 拿不到账号即跳过）
      const st = await get(env.h.port, `/api/state?refresh=${ENT1.uid}`)
      assert.equal(st.status, 200)

      // 所有引擎上游出口一次都没被调过（零上游）
      assert.deepEqual(env.calls, [], `企业版被点名时不应有任何引擎调用，实际：${JSON.stringify(env.calls)}`)
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })

  test("/api/credits 与 /api/streak 对企业版 uid 404 + 专属文案；intl 与不存在账号文案不变", async () => {
    const env = await boot()
    try {
      const credits = await get(env.h.port, `/api/credits?uid=${ENT1.uid}`)
      assert.equal(credits.status, 404)
      assert.equal((await credits.json()).error, ENTERPRISE_NO_GROWTH_MSG)

      const streak = await get(env.h.port, `/api/streak?uid=${ENT1.uid}`)
      assert.equal(streak.status, 404)
      assert.equal((await streak.json()).error, ENTERPRISE_NO_GROWTH_MSG)

      // 对照组：国际版 uid 的 404 文案保持原样（笼统话只属于它）
      const intl = await get(env.h.port, `/api/credits?uid=${INTL.uid}`)
      assert.equal(intl.status, 404)
      assert.equal((await intl.json()).error, `找不到可参与任务的国内版账号：${INTL.uid}`)

      // 对照组：不存在的 uid 同文案
      const missing = await get(env.h.port, "/api/credits?uid=no-such-uid")
      assert.equal(missing.status, 404)
      assert.equal((await missing.json()).error, "找不到可参与任务的国内版账号：no-such-uid")

      // 专属文案不泄露任何账号内容
      assert.ok(!ENTERPRISE_NO_GROWTH_MSG.includes(ENT1.uid), "404 文案不含 uid")
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })

  test("未知路由 404 带 hint 指路重启守护进程；error 原文不变", async () => {
    const env = await boot()
    try {
      const r = await get(env.h.port, "/api/streak-legacy") // 旧看板才会调的形状：任意未知路由
      assert.equal(r.status, 404)
      const body = await r.json()
      assert.equal(body.error, "未知 API：GET /api/streak-legacy", "error 原文逐字不变")
      assert.equal(body.hint, UNKNOWN_API_HINT)
      // POST 未知路由同样带 hint
      const p = await post(env.h.port, "/api/nope", {})
      assert.equal(p.status, 404)
      const pBody = await p.json()
      assert.equal(pBody.error, "未知 API：POST /api/nope")
      assert.equal(pBody.hint, UNKNOWN_API_HINT)
    } finally {
      await env.h.stop()
      env.cleanup()
    }
  })
})

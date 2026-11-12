// tests-shell/schedule-no-growth.test.mjs —— 排程去掉「成长任务」（CONTRACT §7/§8）
// 与「默认全空 = 默认不排」（需求 4）的外壳回归。
//
// 排程小时窗口只认 mp|buddy|streak|travel|night（0.3.3 起新增 streak，§10.3）：
//   - engine/schedule.SCHEDULE_WINDOWS 只有 09:00/21:00 travel、01:00 night
//     （静态表，仅测试/文档引用；daemon 实际用 settings.hours）；
//   - daemon 的 DEFAULT_SETTINGS.hours = { mp:[], buddy:[], streak:[], travel:[], night:[] }
//     （默认全空 = 默认不排任何腿，留空即不排；用户显式写空的腿不会被默认值复活）；
//   - 旧 settings.json 里遗留的 hours.growth 在读取时丢弃（/api/state 的
//     scheduler.nextRuns 与 settings.hours 都不再出现 growth），tick 因此不会
//     触发 growth job；
//   - POST /api/settings 的 hours 只收 mp|buddy|streak|travel|night（写 growth
//     也不报错、不生效；某条腿显式配了小时才会排程）；
//   - 手动运行不受影响：POST /api/run {legs:["growth"]} 照常启动 growth job
//     （LEGS 常量含 growth|mp|streak|buddy|travel|night，settings.legs 默认
//     0.3.3 起为 ["growth","streak","travel"]，仍含 growth）。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startDaemon, normalizeScheduleHours } from "../daemon.mjs"
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox } from "../tests/helpers.mjs"

function fakeEngine() {
  const specs = []
  let current = null
  const eng = {
    store: {
      loadAccounts: () => [
        { key: "workbuddy", provider: "workbuddy", uid: "u1", nickname: "阿猫", access: "a", refresh: "r", expires: Date.now() + 86400000, domain: "", isApiKey: false, enterpriseId: "" },
      ],
      eligibleAccounts: (accounts) =>
        accounts.filter((a) => a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false),
    },
    runner: {
      JobRunner: class JobRunner {
        start(spec) {
          if (current) throw Object.assign(new Error("runner busy"), { code: 409 })
          specs.push(spec)
          const job = {
            id: `job-${specs.length}`,
            state: "running",
            startedAt: new Date().toISOString(),
            endedAt: null,
            trigger: spec.trigger ?? "manual",
            legs: spec.legs ?? [],
            spec,
            totals: { credit: 0, energy: 0, tasksLit: 0, tasksClaimed: 0 },
            steps: [],
            log: [],
          }
          const t = setTimeout(() => {
            job.state = "done"
            job.endedAt = new Date().toISOString()
            if (current?.id === job.id) current = null
          }, 50)
          t.unref?.()
          current = job
          return job
        }
        get() {
          return null
        }
        current() {
          return current && current.state === "running" ? current : null
        }
      },
    },
    tasks: null,
    upstream: null,
    errors: [],
    ok: true,
    __specs: specs,
  }
  return eng
}

async function boot(stateDir) {
  return startDaemon({
    key: "sched-growth-key-0123456789abcdef",
    port: 0,
    stateDir,
    engine: fakeEngine(),
    noTimers: true,
    skipExistingCheck: true,
  })
}

const get = (port, path) => fetch(`http://127.0.0.1:${port}${path}`)
const post = (port, path, body) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms))

describe("normalizeScheduleHours（纯函数）", () => {
  test("growth 与未知键丢弃、0–23 整数去重升序、非法输入落空表（buddy/mp/streak 键保留）", () => {
    // 旧 settings.json 的形状：growth 原样存在 → 归一后消失；buddy/mp/streak 是合法键
    assert.deepEqual(normalizeScheduleHours({ growth: [9], travel: [21, 9, 9], night: [1, "x", 24, -1], buddy: [3, 3, "y", 25], mp: [8], streak: [6, 6] }), {
      mp: [8],
      buddy: [3],
      streak: [6],
      travel: [9, 21],
      night: [1],
    })
    assert.deepEqual(normalizeScheduleHours({ growth: [1, 2, 3] }), { mp: [], buddy: [], streak: [], travel: [], night: [] })
    assert.deepEqual(normalizeScheduleHours(null), { mp: [], buddy: [], streak: [], travel: [], night: [] })
    assert.deepEqual(normalizeScheduleHours([9, 21]), { mp: [], buddy: [], streak: [], travel: [], night: [] })
    assert.deepEqual(normalizeScheduleHours({ travel: "9,21" }), { mp: [], buddy: [], streak: [], travel: [], night: [] })
  })
})

describe("旧 settings.json 含 hours.growth 的升级读径", () => {
  const keep = []
  after(() => {
    for (const d of keep) cleanupSandbox(d)
    cleanupAllSandboxes()
  })

  test("/api/state 的 settings.hours 与 scheduler.nextRuns 不含 growth；tick 不触发 growth job", async () => {
    const stateDir = makeSandbox("wb-sched-").dir
    keep.push(stateDir)
    // 老版写盘的形状：growth 窗口钉在当前**北京小时**（引擎把窗口小时按北京时间
    // UTC+8 解释，CONTRACT §7/§8）——升级后 tick 绝不能因为它点火。取「对照触发」
    // 那一脚的时间戳 t0+1000 来钉窗口，保证跨整点也必然命中。
    const t0 = Date.now()
    const nowHour = new Date(t0 + 1000 + 8 * 3600 * 1000).getUTCHours()
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({ scheduler: true, hours: { growth: [nowHour], travel: [], night: [] } }),
      "utf8",
    )
    const h = await boot(stateDir)
    try {
      const s = await (await get(h.port, "/api/state")).json()
      assert.equal(s.scheduler.enabled, true)
      assert.deepEqual(Object.keys(s.settings.hours).sort(), ["buddy", "mp", "night", "streak", "travel"], "hours 键限制为 mp|buddy|streak|travel|night")
      assert.ok(!JSON.stringify(s.settings.hours).includes("growth"), "settings.hours 不含 growth")
      assert.ok(
        !s.scheduler.nextRuns.some(([leg]) => leg === "growth"),
        `scheduler.nextRuns 不含 growth: ${JSON.stringify(s.scheduler.nextRuns)}`,
      )

      // tick：当前小时只有（已被丢弃的）growth 窗口 → 不触发任何 job
      const job = h.ticks.checkScheduler(t0)
      assert.equal(job, null, "growth 窗口被丢弃后，tick 不该触发 growth job")

      // 对照：把 travel 窗口钉在同一北京小时 → tick 正常触发，且腿是 travel
      const st = await post(h.port, "/api/settings", { hours: { travel: [nowHour] } })
      assert.equal(st.status, 200)
      const job2 = h.ticks.checkScheduler(t0 + 1000)
      assert.ok(job2, "travel 窗口命中 → 触发")
      assert.deepEqual(job2.legs, ["travel"])
      await tick()
    } finally {
      await h.stop()
    }
  })

  test("POST /api/settings 的 hours 只收 mp|buddy|streak|travel|night（growth 写进来不生效、不落盘；buddy/mp/streak 可配）", async () => {
    const stateDir = makeSandbox("wb-sched-").dir
    keep.push(stateDir)
    const h = await boot(stateDir)
    try {
      const st = await post(h.port, "/api/settings", { hours: { growth: [3], travel: [5], night: [2], buddy: [7], mp: [8], streak: [6] } })
      assert.equal(st.status, 200)
      const body = await st.json()
      assert.deepEqual(Object.keys(body.hours).sort(), ["buddy", "mp", "night", "streak", "travel"])
      assert.deepEqual(body.hours.travel, [5])
      assert.deepEqual(body.hours.night, [2])
      assert.deepEqual(body.hours.buddy, [7], "buddy 窗口可显式配置")
      assert.deepEqual(body.hours.mp, [8], "mp 窗口可显式配置")
      assert.deepEqual(body.hours.streak, [6], "streak 窗口可显式配置（§10.3）")
      assert.ok(!JSON.stringify(body.hours).includes("growth"), "响应的 hours 不含 growth")

      const onDisk = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8"))
      assert.ok(!("growth" in (onDisk.hours ?? {})), "落盘的 settings.json 不含 growth")
      assert.deepEqual(onDisk.hours, { mp: [8], buddy: [7], streak: [6], travel: [5], night: [2] })
    } finally {
      await h.stop()
    }
  })

  test("DEFAULT_SETTINGS.hours 全空 + 默认 legs = [growth, streak, travel]（0.3.3）", async () => {
    const stateDir = makeSandbox("wb-sched-").dir
    keep.push(stateDir)
    const h = await boot(stateDir)
    try {
      const s = await (await get(h.port, "/api/state")).json()
      assert.deepEqual(s.settings.hours, { mp: [], buddy: [], streak: [], travel: [], night: [] })
      assert.ok(!JSON.stringify(s.scheduler.nextRuns).includes("growth"))
      assert.deepEqual(s.scheduler.nextRuns, [], "默认全空 → nextRuns 为空（不排任何腿）")
      // settings.legs 默认 0.3.3 起含 streak（连登管家纯收益且幂等，默认做）
      assert.deepEqual(s.settings.legs, ["growth", "streak", "travel"])
    } finally {
      await h.stop()
    }
  })

  test("buddy 显式配了小时 → nextRuns 含 buddy、tick 触发 buddy 腿", async () => {
    const stateDir = makeSandbox("wb-sched-").dir
    keep.push(stateDir)
    const h = await boot(stateDir)
    try {
      const t0 = Date.now()
      const nowHour = new Date(t0 + 1000 + 8 * 3600 * 1000).getUTCHours()
      const st = await post(h.port, "/api/settings", { scheduler: true, hours: { buddy: [nowHour] } })
      assert.equal(st.status, 200)
      const s = await (await get(h.port, "/api/state")).json()
      assert.ok(
        s.scheduler.nextRuns.some(([leg, hh]) => leg === "buddy" && hh === nowHour),
        `schedulerNextRuns 含 buddy: ${JSON.stringify(s.scheduler.nextRuns)}`,
      )
      const job = h.ticks.checkScheduler(t0)
      assert.ok(job, "buddy 窗口命中 → 触发")
      assert.deepEqual(job.legs, ["buddy"], "排程触发的腿就是 buddy")
      await tick()
    } finally {
      await h.stop()
    }
  })

  test("手动 growth job 仍能启动（LEGS 与手动路径不受排程收窄影响）", async () => {
    const stateDir = makeSandbox("wb-sched-").dir
    keep.push(stateDir)
    const h = await boot(stateDir)
    const specs = h.engine.__specs
    try {
      const r = await post(h.port, "/api/run", { legs: ["growth", "bogus"] })
      assert.equal(r.status, 200)
      const { job } = await r.json()
      assert.ok(job.id)
      await tick()
      const spec = specs.at(-1)
      assert.deepEqual(spec.legs, ["growth"], "未知腿剔除，growth 照常进入 spec")
      assert.equal(spec.taskCodes, null, "手动不传 codes → taskCodes 为 null（全部任务）")

      // 手动默认腿（不传 legs）：settings.legs = ["growth","streak","travel"] 照旧生效
      await tick()
      const r2 = await post(h.port, "/api/run", {})
      assert.equal(r2.status, 200)
      await tick()
      assert.deepEqual(specs.at(-1).legs, ["growth", "streak", "travel"])
    } finally {
      await h.stop()
    }
  })
})

// ---- 需求 4：排程时间留空 = 不排 -------------------------------------------
// DEFAULT_SETTINGS.hours 全空数组；settings.json 里写空的腿保持空（不被默认值
// 复活）；开了 scheduler 到任何整点都不触发 job。

describe("排程时间留空 = 不排（需求 4）", () => {
  const keep = []
  after(() => {
    for (const d of keep) cleanupSandbox(d)
    cleanupAllSandboxes()
  })

  const beijingHourOf = (ms) => new Date(ms + 8 * 3600 * 1000).getUTCHours()

  test("默认 settings 下 schedulerNextRuns 为空；scheduler=true 且 hours 全空时任何整点都不触发", async () => {
    const stateDir = makeSandbox("wb-sched-").dir
    keep.push(stateDir)
    const h = await boot(stateDir)
    const specs = h.engine.__specs
    try {
      // 开排程：hours 不动（保持默认全空）
      const st = await post(h.port, "/api/settings", { scheduler: true })
      assert.equal(st.status, 200)
      // 逐个整点拨表：任何北京小时都不触发 job
      const t0 = Date.UTC(2026, 9, 31, 0, 30) // 北京 08:30 起，覆盖一整天 24 个整点
      for (let i = 0; i < 24; i++) {
        const at = t0 + i * 3600_000 + 1800_000 // 每小时的 :00（含跨日切 UTC 16:00）
        assert.equal(h.ticks.checkScheduler(at), null, `北京 ${beijingHourOf(at)} 点不应触发（hours 全空）`)
      }
      assert.equal(specs.length, 0, "24 个整点都没有启动任何 job")
    } finally {
      await h.stop()
    }
  })

  test("settings.json 只写 hours:{travel:[]} → 空腿保持空、旅行不到点触发；写小时才触发", async () => {
    const stateDir = makeSandbox("wb-sched-").dir
    keep.push(stateDir)
    writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ scheduler: true, hours: { travel: [] } }), "utf8")
    const h = await boot(stateDir)
    const specs = h.engine.__specs
    try {
      // 用户显式写空的 travel 保持空（不会被默认值复活），其余腿补默认（也是空）
      const s = await (await get(h.port, "/api/state")).json()
      assert.deepEqual(s.settings.hours, { mp: [], buddy: [], streak: [], travel: [], night: [] })

      // 北京 09:00（UTC 01:00）— 旧行为的旅行窗口：现在 hours.travel=[] 不触发
      const at9 = Date.UTC(2026, 9, 31, 1, 0)
      assert.equal(h.ticks.checkScheduler(at9), null, "travel 留空 → 北京 09:00 不触发")
      assert.equal(specs.length, 0)

      // 显式写上小时才触发（说明留空是「不排」而不是「坏了」）
      const st = await post(h.port, "/api/settings", { hours: { travel: [9] } })
      assert.equal(st.status, 200)
      const job = h.ticks.checkScheduler(at9)
      assert.ok(job, "travel 显式配 9 点 → 触发")
      assert.deepEqual(job.legs, ["travel"])
      await tick()
    } finally {
      await h.stop()
    }
  })

  test("旧 settings.json 的 travel:[9,21]、night:[1]（升级用户）保持原样生效", async () => {
    const stateDir = makeSandbox("wb-sched-").dir
    keep.push(stateDir)
    // 升级场景：旧版 daemon 已把旧默认落进用户的 settings.json —— 尊重用户现有
    // 配置，不被新默认值清空（清空会静默关掉用户已经在用的排程）。
    writeFileSync(
      join(stateDir, "settings.json"),
      JSON.stringify({ scheduler: true, hours: { buddy: [], travel: [9, 21], night: [1] } }),
      "utf8",
    )
    const h = await boot(stateDir)
    try {
      const s = await (await get(h.port, "/api/state")).json()
      assert.deepEqual(s.settings.hours, { mp: [], buddy: [], streak: [], travel: [9, 21], night: [1] })
      const at9 = Date.UTC(2026, 9, 31, 1, 0) // 北京 09:00
      const job = h.ticks.checkScheduler(at9)
      assert.ok(job, "升级用户的 travel 09:00 窗口照常触发")
      assert.deepEqual(job.legs, ["travel"])
      await tick()
    } finally {
      await h.stop()
    }
  })
})

// tests-shell/schedule-beijing.test.mjs —— 排程北京时间口径（CONTRACT §7/§8）daemon 回归。
//
// 生产事故：magpie 容器时区是 UTC（date 显示 UTC、TZ 为空），daemon 的
// checkScheduler 用 new Date(nowMs).getHours() 把北京 09:00（UTC 01:00）读成 1 点，
// 命中了夜猫子窗口而不是猫猫旅行。本文件用显式 UTC 时间戳 + 假引擎驱动
// checkScheduler，钉死：
//   - 北京 09:00（UTC 01:00）必须启动 legs:["travel"] 的 job，绝不能是 night；
//   - 北京 01:00（UTC 17:00）启动 night；
//   - 同一北京日同一窗口只触发一次（lastFired.json 键的日期段 = 北京日期）；
//   - 跨北京日（UTC 16:00 翻日线）重新允许触发。
// 全程零真实网络：引擎是假壳（只记录 start spec），时钟用显式 UTC 毫秒注入。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startDaemon } from "../daemon.mjs"
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

// 用户真实配置：旅行 hours.travel=[9,21]、夜猫子 hours.night=[1]（北京时间）。
const USER_HOURS = { travel: [9, 21], night: [1] }

async function bootWithHours(stateDir, hours = USER_HOURS) {
  // daemon 只认 stateDir 里的 settings.json（无 opts.settings 注入口），与用户
  // 真实路径一致：先写盘再启动。
  writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ scheduler: true, hours }), "utf8")
  return startDaemon({
    key: "sched-bj-key-0123456789abcdef",
    port: 0,
    stateDir,
    engine: fakeEngine(),
    noTimers: true,
    skipExistingCheck: true,
  })
}

const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms))

describe("checkScheduler 北京时间口径（生产 UTC 容器 bug 回归）", () => {
  const keep = []
  after(() => {
    for (const d of keep) cleanupSandbox(d)
    cleanupAllSandboxes()
  })

  test("北京 09:00（UTC 01:00）启动 travel 绝不是 night；北京 01:00（UTC 17:00）启动 night", async () => {
    const stateDir = makeSandbox("wb-sched-bj-").dir
    keep.push(stateDir)
    const h = await bootWithHours(stateDir)
    try {
      // 生产事故现场：北京 09:00 = UTC 01:00。旧 getHours() 得 1 → 误跑夜猫子。
      const job1 = h.ticks.checkScheduler(Date.UTC(2026, 8, 15, 1, 0))
      assert.ok(job1, "北京 09:00 必须触发窗口")
      assert.deepEqual(job1.legs, ["travel"], `legs 必须是 travel，实际 ${JSON.stringify(job1.legs)}`)
      assert.ok(!JSON.stringify(job1.legs).includes("night"), "绝不能是 night")
      assert.equal(job1.trigger, "schedule")
      await tick()

      // 北京 01:00 = UTC 17:00 → 夜猫子
      const job2 = h.ticks.checkScheduler(Date.UTC(2026, 8, 14, 17, 0))
      assert.ok(job2, "北京 01:00 必须触发窗口")
      assert.deepEqual(job2.legs, ["night"], `legs 必须是 night，实际 ${JSON.stringify(job2.legs)}`)
      await tick()

      // lastFired.json 的去重键日期段 = 北京日期（UTC 17:00 那次也是 09-15）
      const fired = JSON.parse(readFileSync(join(stateDir, "lastFired.json"), "utf8"))
      assert.ok(fired["travel@9@2026-09-15"], `去重键应为北京日期：${JSON.stringify(Object.keys(fired))}`)
      assert.ok(fired["night@1@2026-09-15"], `UTC 17:00 = 北京次日 01:00，日期段仍是 09-15：${JSON.stringify(Object.keys(fired))}`)
      assert.ok(fired.lastCycle, "lastCycle 落盘")
    } finally {
      await h.stop()
    }
  })

  test("同一北京日同一窗口只触发一次；同日不同窗口照常；跨北京日（UTC 16:00 翻日线）重新允许", async () => {
    const stateDir = makeSandbox("wb-sched-bj-").dir
    keep.push(stateDir)
    const h = await bootWithHours(stateDir)
    try {
      // 北京 09-15 09:00（UTC 09-15 01:00）→ travel，触发并标记
      const job1 = h.ticks.checkScheduler(Date.UTC(2026, 8, 15, 1, 0))
      assert.ok(job1)
      assert.deepEqual(job1.legs, ["travel"])
      await tick()

      // 同一北京日同一窗口（半小时后，还是北京 09:00 的窗口）→ 不再触发
      assert.equal(h.ticks.checkScheduler(Date.UTC(2026, 8, 15, 1, 30)), null, "同北京日同窗口只触发一次")

      // 同一北京日不同窗口（北京 09-15 21:00 = UTC 13:00）→ 照常触发
      const job2 = h.ticks.checkScheduler(Date.UTC(2026, 8, 15, 13, 0))
      assert.ok(job2, "同北京日的另一个窗口不受去重影响")
      assert.deepEqual(job2.legs, ["travel"])
      await tick()

      // 跨北京日：UTC 09-16 01:00 = 北京 09-16 09:00（已过 UTC 16:00 翻日线）→ 重新允许
      const job3 = h.ticks.checkScheduler(Date.UTC(2026, 8, 16, 1, 0))
      assert.ok(job3, "新北京日的 09:00 窗口重新触发")
      assert.deepEqual(job3.legs, ["travel"])
      await tick()
      assert.equal(h.ticks.checkScheduler(Date.UTC(2026, 8, 16, 1, 30)), null, "新北京日同样只触发一次")

      const fired = JSON.parse(readFileSync(join(stateDir, "lastFired.json"), "utf8"))
      assert.ok(fired["travel@9@2026-09-16"], "跨北京日的键按北京日期分立（当日键保留）")
      // P3-2：写键时顺带剔除早于北京「今天」的陈旧条目 —— 09-15 的两个键随 09-16
      // 的写入被清掉（日期段已过，永远不可能再命中任何 fireKey，纯垃圾；文件不再
      // 随天数增长）。分立语义本身由上面的重新触发行为（job3 成功）钉死。
      assert.equal(fired["travel@9@2026-09-15"], undefined, "昨日键随跨日写入被剔除（P3-2）")
      assert.equal(fired["travel@21@2026-09-15"], undefined, "昨日键随跨日写入被剔除（P3-2）")
    } finally {
      await h.stop()
    }
  })

  test("去重键跨 UTC 16:00 翻日线：北京次日 01:00（UTC 17:00）与北京当日 01:00 分属两键", async () => {
    const stateDir = makeSandbox("wb-sched-bj-").dir
    keep.push(stateDir)
    const h = await bootWithHours(stateDir)
    try {
      // 北京 09-15 01:00（UTC 09-14 17:00）→ night，日期段 09-15
      const job1 = h.ticks.checkScheduler(Date.UTC(2026, 8, 14, 17, 0))
      assert.ok(job1)
      assert.deepEqual(job1.legs, ["night"])
      await tick()
      // 同一北京日同窗口 → 去重
      assert.equal(h.ticks.checkScheduler(Date.UTC(2026, 8, 14, 17, 30)), null)
      // 北京 09-16 01:00（UTC 09-15 17:00）→ 新北京日，重新允许
      const job2 = h.ticks.checkScheduler(Date.UTC(2026, 8, 15, 17, 0))
      assert.ok(job2, "跨北京日（UTC 16:00 翻日线）后 night 重新允许")
      assert.deepEqual(job2.legs, ["night"])
      await tick()

      const fired = JSON.parse(readFileSync(join(stateDir, "lastFired.json"), "utf8"))
      assert.ok(fired["night@1@2026-09-16"], "当日键保留")
      // P3-2：昨日（09-15）键随 09-16 的写入被剔除 —— job2 能重新触发本身就证明
      // 09-15 键不再命中；文件按「当日键 + lastCycle」收敛。
      assert.equal(fired["night@1@2026-09-15"], undefined, "昨日键随跨日写入被剔除（P3-2）")
    } finally {
      await h.stop()
    }
  })
})

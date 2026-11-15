// tests-shell/job-log-cap.test.mjs —— job.log 出门长度上限（F2）回归。
//
// 旧行为：safeJob() 把完整 log 一起回传给 /api/state（以及 /api/run、SSE job
// 事件、/api/jobs 等一切 job 出口）—— 长跑 job 数百步/数千行时 payload 与前端
// 重绘量随时间线性增长，job.log 没有任何上限。
// 修后：safeJob 统一截到最新的 LOG_MAX_LINES = 2000 行（与看板前端的客户端上限
// LOG_MAX_LINES = 2000 对齐；前端把「来源收缩」当截断信号自行 resync）。只封
// 长度，不改 /api/state 的结构；job 内部的 log 原样保留（截断只发生在出门前）。
//
// 钉死：
//   1. log 超过上限：/api/state 的 job.log 长度 = 2000 且是**最新的那批**
//      （丢头部、保尾部，最后一行 = 内部 log 的最后一行）；
//   2. 未超上限：原样透传（不截断、不重排）；
//   3. 内部 job.log 不被截断污染（runner.current().log 仍是全量，SSE 增量观察
//      与落历史不受影响）。
//
// 全程零真实网络：引擎是假壳（job 同步启动并挂 2300 行日志，保持 running），
// 账号走假 store，/api/run 真实走 daemon 的 startJob。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { startDaemon, LOG_MAX_LINES } from "../daemon.mjs"
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox } from "../tests/helpers.mjs"

const UID = "u-log-cap"
const OVER_LINES = LOG_MAX_LINES + 300 // 2300 行，超上限 300 行

function fakeEngine() {
  const eng = {
    store: {
      loadAccounts: () => [
        {
          key: "workbuddy",
          provider: "workbuddy",
          uid: UID,
          nickname: "阿猫",
          access: "a-log-cap",
          refresh: "r-log-cap",
          expires: Date.now() + 86400000,
          domain: "",
          isApiKey: false,
          enterpriseId: "",
        },
      ],
      eligibleAccounts: (accounts) =>
        accounts.filter((a) => a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false),
    },
    runner: {
      JobRunner: class JobRunner {
        constructor() {
          this.currentJob = null
        }
        start(spec) {
          if (this.currentJob) throw Object.assign(new Error("runner busy"), { code: 409 })
          const log =
            eng.jobs.size === 0
              ? Array.from({ length: OVER_LINES }, (_, i) => {
                  const n = String(i + 1).padStart(4, "0")
                  // 中间埋一条凭据形状的行（Bearer + JWT 形态，在最后 2000 行窗口内），
                  // 钉 scrub 与截断叠加 —— scrub 只洗 Bearer/JWT 形状（见 daemon SECRET_RES）
                  return i + 1 === 1000
                    ? "拉取失败 Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9tail123456"
                    : `log-${n}`
                })
              : ["log-1", "log-2"]
          const job = {
            id: `job-log-${eng.jobs.size + 1}`,
            state: "running",
            startedAt: new Date().toISOString(),
            endedAt: null,
            trigger: spec.trigger ?? "manual",
            legs: spec.legs ?? [],
            spec,
            totals: { credit: 0, energy: 0, tasksLit: 0, tasksClaimed: 0 },
            steps: [],
            log,
          }
          eng.jobs.set(job.id, job)
          this.currentJob = job
          return job
        }
        stop(id) {
          const job = eng.jobs.get(id)
          if (!job) return null
          job.state = "error"
          job.endedAt = new Date().toISOString()
          if (this.currentJob?.id === id) this.currentJob = null
          return job
        }
        get(id) {
          return eng.jobs.get(id) ?? null
        }
        current() {
          return this.currentJob && this.currentJob.state === "running" ? this.currentJob : null
        }
      },
    },
    tasks: null,
    upstream: null,
    errors: [],
    ok: true,
    jobs: new Map(),
  }
  return eng
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))
const keep = []
after(() => {
  for (const d of keep) cleanupSandbox(d)
  cleanupAllSandboxes()
})

async function boot() {
  const stateDir = makeSandbox("wb-log-cap-").dir
  keep.push(stateDir)
  const engine = fakeEngine()
  const h = await startDaemon({
    key: "log-cap-key-0123456789abcdef",
    port: 0,
    stateDir,
    engine,
    noTimers: true,
    skipExistingCheck: true,
  })
  return { h, engine }
}

describe("job.log 出门长度上限（F2：LOG_MAX_LINES=2000，对齐前端客户端上限）", () => {
  test("超过上限：/api/state 的 job.log 长度 ≤2000 且保留的是最新的那批", async () => {
    const { h, engine } = await boot()
    try {
      const run = await fetch(`http://127.0.0.1:${h.port}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uids: [UID] }),
      })
      assert.equal(run.status, 200)
      await tick(20) // 让 watchJobTick 有机会看过一眼（增量 SSE 不受影响）
      const j = await (await fetch(`http://127.0.0.1:${h.port}/api/state`)).json()
      assert.ok(j.job, "/api/state 带当前 job")
      assert.equal(j.job.log.length, LOG_MAX_LINES, `出门 log 必须被截到 ${LOG_MAX_LINES} 行`)
      assert.equal(j.job.log[0], `log-${String(OVER_LINES - LOG_MAX_LINES + 1).padStart(4, "0")}`, "第一行 = 丢头后最早幸存的行（log-0301）")
      assert.equal(j.job.log.at(-1), `log-${String(OVER_LINES).padStart(4, "0")}`, "最后一行 = 内部 log 的最后一行（log-2300）")
      // 内部 log 原样全量（截断只发生在出门前）：runner.current().log 未被污染
      assert.equal(engine.jobs.get(j.job.id).log.length, OVER_LINES, "job 内部 log 仍是全量 2300 行")
    } finally {
      await h.stop()
    }
  })

  test("未超上限：原样透传（不截断、不重排）；/api/run 响应同口径", async () => {
    const { h, engine } = await boot()
    try {
      // 第一个 job 挂了 2300 行并保持 running；先 stop 再开第二个短 log job
      const run1 = await fetch(`http://127.0.0.1:${h.port}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uids: [UID] }),
      })
      assert.equal(run1.status, 200)
      await fetch(`http://127.0.0.1:${h.port}/api/stop`, { method: "POST" })
      await tick(20)
      const run2 = await fetch(`http://127.0.0.1:${h.port}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uids: [UID] }),
      })
      assert.equal(run2.status, 200)
      const runBody = await run2.json()
      assert.deepEqual(runBody.job.log, ["log-1", "log-2"], "/api/run 响应里短 log 原样透传")

      const j = await (await fetch(`http://127.0.0.1:${h.port}/api/state`)).json()
      assert.deepEqual(j.job.log, ["log-1", "log-2"], "/api/state 的短 log 原样透传")
      assert.equal(engine.jobs.get(j.job.id).log.length, 2)
    } finally {
      await h.stop()
    }
  })

  test("scrub 与截断叠加：截断窗口内的凭据行仍被洗掉（出门口径不变）", async () => {
    const { h } = await boot()
    try {
      await fetch(`http://127.0.0.1:${h.port}/api/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uids: [UID] }),
      })
      await tick(20)
      const j = await (await fetch(`http://127.0.0.1:${h.port}/api/state`)).json()
      assert.ok(j.job.log.every((l) => !l.includes("eyJ")), "出门行仍过 scrub（JWT 形态被洗掉）")
      const scrubbed = j.job.log.find((l) => l.startsWith("拉取失败 Bearer "))
      assert.ok(scrubbed, "被埋的凭据行在截断窗口内，必须还在响应里")
      assert.equal(scrubbed, "拉取失败 Bearer ***", `凭据被洗成 Bearer ***，实际 ${JSON.stringify(scrubbed)}`)
      assert.equal(j.job.log.length, LOG_MAX_LINES)
    } finally {
      await h.stop()
    }
  })
})

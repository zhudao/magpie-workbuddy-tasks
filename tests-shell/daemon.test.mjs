// tests-shell/daemon.test.mjs —— 守护进程外壳自测（node --test；不依赖 engine/*）
//
// 用注入的 fake engine（契约 §2 形状）驱动 daemon.mjs，零真实网络、零真实账号：
//   1. 免密钥口径（用户明确要求）：全部路由无 key / 错 key 一律放行，写操作按
//      业务语义响应（绝不 401）；带旧 Bearer/?k= 的调用继续可用
//   2. /api/hello 形状
//   3. 409 busy：同一时刻只允许一个 job
//   4. control.json desired=off → 守护进程优雅退出
//   5. 拒绝双开（已有健康守护进程时，第二个 startDaemon 必须拒绝）
//   6. 附加：凭据不外泄、/api/stop、SSE、/api/checkin、settings、排程窗口

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { startDaemon } from "../daemon.mjs"
import { readControl, writeControl } from "../lifecycle.mjs"
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox } from "../tests/helpers.mjs"

const KEY = "test-key-0123456789abcdef"

// 每条用例独占一个 temp 沙箱（并发隔离是刻意的：node --test 多进程并行 + 用例
// 交错，control.json/settings.json/daemon.json 都以 stateDir 为边界，共享目录会
// 互相踩）；用完即删 —— 有 stateDir 局部量的用例在 finally 里显式删，其余由本
// 文件末尾的 after 兜底统一回收（见 helpers.mjs 三道卫生线）。
function tmpState() {
  return makeSandbox("wb-tasks-").dir
}

// 兜底：boot() 内部创建的沙箱在文件收尾统一回收（正常情况下登记簿已是空的）。
after(() => {
  cleanupAllSandboxes()
})

// ---- fake engine（按契约 §2 的最小形状） ---------------------------------

function fakeEngine() {
  const jobs = new Map()
  let seq = 0
  let current = null
  // 403/11140 冻结名单（CONTRACT §10.5：runner.frozen() -> [{uid, at, code, message}]），
  // 测试可用 engine.__setFrozen 调整；默认为空（冻结账号会被缺省目标排除）
  let frozenList = []

  const makeJob = (spec) => {
    const id = `job-${++seq}`
    const job = {
      id,
      state: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      trigger: spec.trigger ?? "manual",
      legs: spec.legs ?? [],
      totals: { credit: 0, energy: 0, tasksLit: 0, tasksClaimed: 0 },
      steps: [
        { uid: "u1", nickname: "阿猫", leg: "growth", state: "ok", detail: "成长任务完成", credit: 20, energy: 5, at: new Date().toISOString() },
      ],
      log: ["[runner] 假任务开始", "Bearer sk-should-never-leak-1234567890 一条长得像密钥的日志"],
    }
    // 300ms 后自然完成（模拟 fire-and-poll 的对端）
    const timer = setTimeout(() => {
      job.state = "done"
      job.endedAt = new Date().toISOString()
      job.totals = { credit: 20, energy: 5, tasksLit: 3, tasksClaimed: 2 }
      if (current?.id === id) current = null
    }, 300)
    timer.unref?.()
    jobs.set(id, job)
    return job
  }

  // 契约 §2：runner.mjs 导出 JobRunner 类；daemon 用 new JobRunner(ctx) 实例化
  const runnerModule = {
    JobRunner: class JobRunner {
      constructor(ctx) {
        this.ctx = ctx
      }
      start(spec) {
        if (current) throw Object.assign(new Error("runner busy"), { code: 409 })
        const job = makeJob(spec)
        current = job
        return job
      }
      get(id) {
        return jobs.get(id) ?? null
      }
      current() {
        return current && current.state === "running" ? current : null
      }
      holds() {
        return []
      }
      frozen() {
        return frozenList
      }
      isFrozen(uid) {
        return frozenList.some((f) => f.uid === uid)
      }
      unfreeze(uid) {
        const had = frozenList.some((f) => f.uid === uid)
        frozenList = frozenList.filter((f) => f.uid !== uid)
        return had
      }
      stop(id) {
        const job = jobs.get(id)
        if (!job) return null
        job.state = "error"
        job.endedAt = new Date().toISOString()
        job.steps = [...job.steps, { uid: "u1", nickname: "阿猫", leg: "growth", state: "fail", detail: "已手动取消", credit: 0, energy: 0, at: new Date().toISOString() }]
        if (current?.id === id) current = null
        return job
      }
    },
  }

  const eng = {
    store: {
      readMagpieConfigDir: () => null,
      loadAccounts: () => [
        {
          key: "workbuddy",
          provider: "workbuddy",
          uid: "u1",
          nickname: "阿猫",
          access: "SUPERSECRET-ACCESS-TOKEN-abc123",
          refresh: "SUPERSECRET-REFRESH-TOKEN-xyz789",
          expires: Date.now() + 86400000,
          domain: "workbuddy.cn",
          isApiKey: false,
          enterpriseId: "",
        },
      ],
      eligibleAccounts: (accounts) =>
        accounts.filter((a) => a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false),
    },
    runner: runnerModule,
    tasks: {
      // 契约 §2 的规范 Task 形状（camelCase）；快照投影测试依赖这些非空值
      fetchTasks: async () => [
        { code: "first_buddy", title: "首次对话", acceptStatus: "claimed", progress: { current: 1, target: 1 }, rewardCredit: 20, rewardEnergy: 10, jumpUrl: "" },
        { code: "RichMeow_Chat", title: "富猫聊天", acceptStatus: "not_accepted", progress: { current: 0, target: 1 }, rewardCredit: 5, rewardEnergy: 0, jumpUrl: "https://example.com/go" },
      ],
      claimTask: async () => ({ ok: true, credit: 20, energy: 0, via: "chat", reason: "" }),
      acceptTasks: async (_acct, codes) => ({ accepted: codes, already: [], failed: [] }),
    },
    upstream: {
      growthBase: () => "https://copilot.tencent.com",
      billBase: () => "https://www.codebuddy.cn",
      webBase: () => "https://www.workbuddy.cn",
      callJSON: async () => ({ ok: true, status: 200, code: 0, msg: "ok", data: { credit: 5 } }),
    },
    errors: [],
    ok: true,
    // 测试钩子：调整 403/11140 冻结名单
    __setFrozen: (list) => {
      frozenList = list
    },
  }
  return eng
}

async function boot(opts = {}) {
  const engine = opts.engine ?? fakeEngine()
  const h = await startDaemon({
    key: KEY,
    port: 0,
    stateDir: opts.stateDir ?? tmpState(),
    engine,
    noTimers: true,
    skipExistingCheck: true,
    ...opts.extra,
  })
  return { h, engine }
}

const base = (port) => `http://127.0.0.1:${port}`
const get = (port, path, key) => fetch(base(port) + path, { headers: key ? { authorization: `Bearer ${key}` } : {} })
const post = (port, path, body, key) =>
  fetch(base(port) + path, {
    method: "POST",
    headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

// ---- 1–3. HTTP 外壳 ------------------------------------------------------

describe("daemon HTTP 外壳", () => {
  test("全路由免密钥（契约 §3 免密钥口径）：无 key/错 key 一律放行，写操作按业务语义响应", async () => {
    const { h } = await boot()
    try {
      assert.equal((await get(h.port, "/api/hello")).status, 200)

      // 只读路由：无 key、错 key 都 200（不存在「需要密钥」这回事）
      assert.equal((await get(h.port, "/api/state")).status, 200)
      assert.equal((await get(h.port, "/api/history")).status, 200)
      assert.equal((await get(h.port, "/api/state", "wrong-key")).status, 200, "错 key 也不挡（不做任何校验）")

      // 写操作：无 key 放行，按业务语义响应（不再 401）
      assert.equal((await post(h.port, "/api/settings", { claim: true }, null)).status, 200)
      const run = await post(h.port, "/api/run", {}, "wrong-key")
      assert.equal(run.status, 200, "写操作无 key/错 key 照常执行")
      assert.ok((await run.json()).job.id)
      for (let i = 0; i < 100 && h.runner.current(); i++) await tick()
      // 无 job 可停 → 404（业务理由），绝不是 401
      const stopRes = await post(h.port, "/api/stop", undefined, null)
      assert.equal(stopRes.status, 404)
      assert.match((await stopRes.json()).error, /没有正在运行/)

      // 带旧密钥（header 或 ?k=）的调用继续可用：平滑过渡，不报 400/401
      assert.equal((await get(h.port, "/api/state", KEY)).status, 200)
      assert.equal((await get(h.port, `/api/state?k=${encodeURIComponent(KEY)}`)).status, 200)
      assert.equal((await get(h.port, `/api/state?k=${encodeURIComponent("完全无关的旧值")}`)).status, 200)
    } finally {
      await h.stop()
    }
  })

  test("/api/hello 形状 {name, version, ready}；引擎缺失时 ready=false 且 /api/run 503", async () => {
    const { h } = await boot()
    try {
      const j = await (await get(h.port, "/api/hello")).json()
      assert.equal(j.name, "workbuddy-tasks")
      assert.equal(typeof j.version, "string")
      assert.equal(j.ready, true)
    } finally {
      await h.stop()
    }

    const h2 = await startDaemon({
      key: KEY,
      port: 0,
      stateDir: tmpState(),
      engine: { store: null, runner: null, tasks: null, upstream: null, errors: ["engine/runner.mjs 加载失败：不存在"], ok: false },
      noTimers: true,
      skipExistingCheck: true,
    })
    try {
      const j = await (await get(h2.port, "/api/hello")).json()
      assert.equal(j.ready, false)
      const run = await post(h2.port, "/api/run", {}, KEY)
      assert.equal(run.status, 503)
      assert.match((await run.json()).error, /任务引擎不可用/)
      assert.equal((await get(h2.port, "/api/state", KEY)).status, 200)
    } finally {
      await h2.stop()
    }
  })

  test("409 busy：job 运行中再 POST /api/run 得 {error:'busy'}；结束后可再跑", async () => {
    const { h } = await boot()
    try {
      const first = await post(h.port, "/api/run", { legs: ["growth"] }, KEY)
      assert.equal(first.status, 200)
      const job1 = (await first.json()).job
      assert.ok(job1.id)

      const second = await post(h.port, "/api/run", {}, KEY)
      assert.equal(second.status, 409)
      assert.deepEqual(await second.json(), { error: "busy" })

      // 单账号操作同样被全局闸门挡住
      assert.equal((await post(h.port, "/api/task/claim", { uid: "u1", code: "first_buddy" }, KEY)).status, 409)

      for (let i = 0; i < 50 && h.runner.current(); i++) await tick()
      assert.equal((await post(h.port, "/api/run", {}, KEY)).status, 200)

      const got = await get(h.port, `/api/jobs/${job1.id}`, KEY)
      assert.equal(got.status, 200)
      assert.equal((await got.json()).id, job1.id)
      assert.equal((await get(h.port, `/api/jobs/nope`, KEY)).status, 404)
    } finally {
      await h.stop()
    }
  })

  test("凭据不外泄：/api/state、/api/jobs、历史里都没有 access/refresh 原文", async () => {
    const { h } = await boot()
    try {
      const stateText = await (await get(h.port, "/api/state", KEY)).text()
      assert.ok(!stateText.includes("SUPERSECRET"))
      assert.ok(stateText.includes("已登录")) // 掩码字段
      assert.equal(JSON.parse(stateText).accounts[0].uid, "u1")

      const run = await post(h.port, "/api/run", {}, KEY)
      const job = (await run.json()).job
      for (let i = 0; i < 50 && job.state === "running"; i++) await tick()
      h.ticks.watchJob() // noTimers 模式下手动驱动观察者，落历史
      const jobText = await (await get(h.port, `/api/jobs/${job.id}`, KEY)).text()
      assert.ok(!jobText.includes("SUPERSECRET"))
      // 日志里 Bearer 样子的串也要被洗掉
      assert.ok(!jobText.includes("sk-should-never-leak"))
      assert.ok(jobText.includes("***"))

      const hist = await (await get(h.port, "/api/history?limit=50", KEY)).json()
      assert.ok(hist.rows.length >= 1)
      assert.ok(!JSON.stringify(hist).includes("SUPERSECRET"))
    } finally {
      await h.stop()
    }
  })

  test("expiresInMs：2 小时后过期的 token ∈ (0, 86400000) 且 expiresInDays=1；expires 未知则两者皆 null", async () => {
    const { h, engine } = await boot()
    const withExpires = (expires) => ({
      key: "workbuddy",
      provider: "workbuddy",
      uid: "u1",
      nickname: "阿猫",
      access: "SUPERSECRET-ACCESS-TOKEN-abc123",
      refresh: "SUPERSECRET-REFRESH-TOKEN-xyz789",
      expires,
      domain: "workbuddy.cn",
      isApiKey: false,
      enterpriseId: "",
    })
    try {
      // 「还剩 2 小时」的 token：days 口径天花板取整成 1，与「剩 1 天」无法区分；
      // 看板必须用新的 expiresInMs（原始剩余毫秒）才不会误报「token 剩 1 天」
      engine.store.loadAccounts = () => [withExpires(Date.now() + 2 * 3600 * 1000)]
      const row = (await (await get(h.port, "/api/state", KEY)).json()).accounts[0]
      assert.ok(row.expiresInMs > 0 && row.expiresInMs < 86400000, `expiresInMs 应在 (0, 86400000)，实际 ${row.expiresInMs}`)
      assert.equal(row.expiresInDays, 1, "expiresInDays 保持 ceil 兼容口径（2 小时也显示 1）")

      // expires 未知（=0）→ 两个字段都是 null
      engine.store.loadAccounts = () => [withExpires(0)]
      const row2 = (await (await get(h.port, "/api/state", KEY)).json()).accounts[0]
      assert.equal(row2.expiresInMs, null)
      assert.equal(row2.expiresInDays, null)
    } finally {
      await h.stop()
    }
  })

  test("POST /api/stop 取消当前 job；没有 job 时 404", async () => {
    const { h } = await boot()
    try {
      assert.equal((await post(h.port, "/api/stop", undefined, KEY)).status, 404)

      await post(h.port, "/api/run", {}, KEY)
      const stopped = await post(h.port, "/api/stop", undefined, KEY)
      assert.equal(stopped.status, 200)
      const job = (await stopped.json()).job
      assert.equal(job.state, "error")
      assert.ok(job.steps.some((s) => s.detail === "已手动取消"))
    } finally {
      await h.stop()
    }
  })

  test("SSE /api/events：text/event-stream，先发 retry 行；无需任何密钥（免密钥口径）", async () => {
    const { h } = await boot()
    const ctrl = new AbortController()
    try {
      const res = await fetch(base(h.port) + "/api/events", {
        headers: { authorization: `Bearer ${KEY}` },
        signal: ctrl.signal,
      })
      assert.equal(res.status, 200)
      assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/)
      const reader = res.body.getReader()
      const { value } = await reader.read()
      assert.ok(new TextDecoder().decode(value).includes("retry"))

      const anon = await fetch(base(h.port) + "/api/events", { signal: ctrl.signal })
      assert.equal(anon.status, 200, "SSE 无需任何密钥（全部路由免密钥口径）")
      anon.body?.cancel?.().catch(() => {})
    } finally {
      ctrl.abort()
      await h.stop()
    }
  })

  test("/api/checkin、/api/settings、静态回退页", async () => {
    const { h } = await boot()
    try {
      const checkin = await post(h.port, "/api/checkin", { uids: ["u1"] }, KEY)
      assert.equal(checkin.status, 200)
      const rows = await checkin.json()
      assert.equal(rows[0].uid, "u1")
      assert.equal(rows[0].outcome, "claimed")

      const st = await post(h.port, "/api/settings", { scheduler: false, hours: { night: [2] } }, KEY)
      assert.equal(st.status, 200)
      const settings = await st.json()
      assert.equal(settings.scheduler, false)
      assert.deepEqual(settings.hours.night, [2])

      // 静态首页：dashboard/index.html 存在就服务看板，否则服务回退页（两种都 200 / text/html）
      const dashIndex = join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "index.html")
      const home = await fetch(base(h.port) + "/")
      assert.equal(home.status, 200)
      assert.match(home.headers.get("content-type") ?? "", /text\/html/)
      if (existsSync(dashIndex)) {
        assert.ok((await home.text()).includes("WorkBuddy 任务"), "已装看板 → 直接服务看板首页")
      } else {
        assert.match(await home.text(), /看板尚未构建/)
      }
    } finally {
      await h.stop()
    }
  })
})

// ---- 6. 快照投影 / 参与任务开关 / 风控冷却 --------------------------------

describe("快照投影 · 参与任务开关 · 风控冷却", () => {
  const waitJobQuiet = async (h) => {
    for (let i = 0; i < 100 && h.runner.current(); i++) await tick()
  }
  const waitFor = async (pred, what) => {
    for (let i = 0; i < 200; i++) {
      const v = await pred()
      if (v) return v
      await tick(50)
    }
    throw new Error(`等待超时：${what}`)
  }

  test("快照投影：/api/state 的 snapshot.tasks 只出规范字段且非空（缺陷 1 回归）", async () => {
    const stateDir = tmpState()
    const { h } = await boot({ stateDir })
    try {
      const run = await post(h.port, "/api/run", {}, KEY)
      assert.equal(run.status, 200)
      await waitJobQuiet(h)
      h.ticks.watchJob() // job 收尾 → finalizeJob → refreshSnapshots（走注入的假引擎）
      const st = await waitFor(async () => {
        const s = await (await get(h.port, "/api/state", KEY)).json()
        return s.accounts[0]?.snapshot?.tasks?.length ? s : null
      }, "自动任务快照")
      const tasks = st.accounts[0].snapshot.tasks
      assert.equal(tasks.length, 2)
      for (const t of tasks) {
        // 规范拼写逐字断言；daemon 绝不再读第二种键名（snake_case/camel 混猜）。
        // P0-2：六个判断字段（desktopOnly/unforgeable/reason/canAccept/canLight/
        // pinnedExpertId）随投影一并下发（契约 §3）；需求 2 起再加次日锁三字段
        //（locked/lockedUntil/lockHint，无锁时 locked=false、其余空串）。
        assert.deepEqual(
          Object.keys(t).sort(),
          [
            "acceptStatus",
            "canAccept",
            "canLight",
            "code",
            "description",
            "desktopOnly",
            "jumpUrl",
            "lockHint",
            "locked",
            "lockedUntil",
            "pinnedExpertId",
            "progress",
            "reason",
            "rewardCredit",
            "rewardEnergy",
            "taskType",
            "title",
            "unforgeable",
          ],
        )
        assert.ok(t.code.length > 0, "code 非空")
        assert.ok(t.title.length > 0, "title 非空")
        assert.equal(typeof t.acceptStatus, "string", "acceptStatus 是上游字符串状态")
        assert.ok(Number.isInteger(t.rewardCredit) && t.rewardCredit > 0, "rewardCredit 非 0")
        assert.deepEqual(t.progress, { current: t.progress.current, target: t.progress.target })
        assert.equal(typeof t.desktopOnly, "boolean", "desktopOnly 是布尔")
        assert.equal(typeof t.unforgeable, "boolean", "unforgeable 是布尔")
        assert.equal(typeof t.reason, "string", "reason 是字符串")
        assert.equal(typeof t.canAccept, "boolean", "canAccept 是布尔")
        assert.equal(typeof t.canLight, "boolean", "canLight 是布尔")
        assert.equal(typeof t.pinnedExpertId, "string", "pinnedExpertId 是字符串")
      }
      const rich = tasks.find((t) => t.title === "富猫聊天")
      assert.equal(rich.jumpUrl, "https://example.com/go", "jumpUrl 必须透出（否则看板没法展示深链）")
      assert.equal(rich.acceptStatus, "not_accepted")
      // P0-2：引擎判断随投影下发 —— RichMeow 已改走 6 条桌面会话事件链，
      // 不再是 DESKTOP_ONLY（desktopOnly=false）；当前状态 not_accepted，
      // 所以 canLight 仍为 false，接取后才会变 true。
      assert.equal(rich.desktopOnly, false)
      assert.equal(rich.unforgeable, false)
      assert.equal(rich.canAccept, true)
      assert.equal(rich.canLight, false)
      assert.equal(rich.pinnedExpertId, "")
      const fb = tasks.find((t) => t.code === "first_buddy")
      assert.equal(fb.desktopOnly, false)
      assert.equal(fb.canAccept, false, "claimed 的 auto 任务不可再接取")
      assert.equal(fb.canLight, false, "claimed 的任务无可点亮")
    } finally {
      await h.stop()
      cleanupSandbox(stateDir) // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("POST /api/account/toggle：写 accounts.json、回读生效行、影响下一轮筛选", async () => {
    const stateDir = tmpState()
    const { h, engine } = await boot({ stateDir })
    try {
      // 缺 uid / 非布尔 / 未知 uid
      assert.equal((await post(h.port, "/api/account/toggle", {}, KEY)).status, 400)
      assert.equal((await post(h.port, "/api/account/toggle", { uid: "u1", tasksEnabled: "yes" }, KEY)).status, 400)
      assert.equal((await post(h.port, "/api/account/toggle", { uid: "nope", tasksEnabled: true }, KEY)).status, 404)

      // 关掉 u1 → 生效行 tasksEnabled:false / eligible:false，且落盘 accounts.json
      const off = await post(h.port, "/api/account/toggle", { uid: "u1", tasksEnabled: false }, KEY)
      assert.equal(off.status, 200)
      const offRow = await off.json()
      assert.equal(offRow.uid, "u1")
      assert.equal(offRow.tasksEnabled, false)
      assert.equal(offRow.eligible, false)
      assert.equal(offRow.nickname, "阿猫")
      assert.deepEqual(JSON.parse(readFileSync(join(stateDir, "accounts.json"), "utf8")), { u1: false })

      // /api/state 暴露生效值
      const st1 = await (await get(h.port, "/api/state", KEY)).json()
      assert.equal(st1.accounts[0].tasksEnabled, false)

      // 没有可参与账号 → /api/run 400（WB_NO_ACCOUNTS），而不是带病启动
      const runOff = await post(h.port, "/api/run", {}, KEY)
      assert.equal(runOff.status, 400)
      assert.match((await runOff.json()).error, /没有可参与任务的账号/)

      // 显式写 true 可以盖过引擎侧的 false（accounts.json 显式条目优先）
      engine.store.loadAccounts = () => [
        { key: "workbuddy", provider: "workbuddy", uid: "u1", nickname: "阿猫", access: "a", refresh: "r", expires: Date.now() + 86400000, domain: "", isApiKey: false, enterpriseId: "", tasksEnabled: false },
      ]
      const on = await post(h.port, "/api/account/toggle", { uid: "u1", tasksEnabled: true }, KEY)
      assert.equal(on.status, 200)
      assert.equal((await on.json()).tasksEnabled, true)
      const runOn = await post(h.port, "/api/run", {}, KEY)
      assert.equal(runOn.status, 200)
      await waitJobQuiet(h)
    } finally {
      await h.stop()
      cleanupSandbox(stateDir) // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("参与任务开关：job 运行中切换不打断/不污染正在跑的 job", async () => {
    const { h } = await boot()
    try {
      const run = await post(h.port, "/api/run", {}, KEY)
      assert.equal(run.status, 200)
      const jobId = (await run.json()).job.id

      // 运行中切换开关：允许，且立即生效于「下一轮」
      const off = await post(h.port, "/api/account/toggle", { uid: "u1", tasksEnabled: false }, KEY)
      assert.equal(off.status, 200)

      await waitJobQuiet(h)
      h.ticks.watchJob()
      const job = h.runner.get(jobId)
      assert.equal(job.state, "done", "运行中的 job 不受开关影响")
      assert.ok(job.steps.some((s) => s.uid === "u1" && s.state === "ok"), "原步骤原样保留")
      assert.deepEqual(job.totals, { credit: 20, energy: 5, tasksLit: 3, tasksClaimed: 2 })
    } finally {
      await h.stop()
    }
  })

  test("顶层 frozen：runner.frozen() 的 403/11140 冻结名单 + 昵称 + 解冻路由", async () => {
    const { h, engine } = await boot()
    try {
      engine.__setFrozen([
        { uid: "u1", at: new Date(Date.now() - 3600_000).toISOString(), code: 11140, message: "request illegal" },
      ])
      const st = await (await get(h.port, "/api/state", KEY)).json()
      assert.equal(st.frozen.length, 1)
      const f = st.frozen[0]
      assert.deepEqual(Object.keys(f).sort(), ["at", "code", "message", "nickname", "uid"])
      assert.equal(f.uid, "u1")
      assert.equal(f.nickname, "阿猫", "daemon 用账号昵称补全 frozen")
      assert.equal(f.code, 11140)
      assert.ok(!Number.isNaN(Date.parse(f.at)), "at 是 ISO 串")
      // accounts[].frozen 投影同一条记录（形状 {at, code, message}，不带 uid）
      assert.deepEqual(
        Object.keys(st.accounts[0].frozen).sort(),
        ["at", "code", "message"],
      )
      assert.equal(st.accounts[0].frozen.code, 11140)
      // 旧的 scheduler.holds 已被顶层 frozen 替代（CONTRACT §10.3）
      assert.ok(!("holds" in st.scheduler))

      // 冻结清空 → frozen 为空数组
      engine.__setFrozen([])
      const st2 = await (await get(h.port, "/api/state", KEY)).json()
      assert.deepEqual(st2.frozen, [])
      assert.equal(st2.accounts[0].frozen, null)

      // unfreeze 路由：missing = 本来就没冻结
      const uf = await post(h.port, "/api/account/unfreeze", { uid: "u-never" }, KEY)
      assert.equal(uf.status, 200)
      assert.deepEqual(await uf.json(), { ok: true, unfrozen: [], missing: ["u-never"] })
    } finally {
      await h.stop()
    }
  })
})

// ---- 4–5. 生命周期 -------------------------------------------------------

describe("生命周期", () => {
  test("control.json desired=off → checkControl 触发优雅退出", async () => {
    const stateDir = tmpState()
    const { h } = await boot({ stateDir })
    assert.equal(readControl(stateDir).desired, "on")

    try {
      writeControl(stateDir, "off")
      assert.equal(h.ticks.checkControl(), true) // true = 已开始退场
      await h.whenStopped
      assert.ok(h.stopped)
      await assert.rejects(() => fetch(base(h.port) + "/api/hello", { signal: AbortSignal.timeout(1500) }))
    } finally {
      await h.stop().catch(() => {})
      cleanupSandbox(stateDir) // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("拒绝双开：daemon.json 指向一个活着的其他进程且 /api/hello 健康 → 第二个拒绝", async () => {
    const stateDir = tmpState()
    const { h } = await boot({ stateDir })
    // 一个活着但不是守护进程的进程，充当「别人的 pid」
    const dummy = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" })
    try {
      writeFileSync(
        join(stateDir, "daemon.json"),
        JSON.stringify({ pid: dummy.pid, port: h.port, key: KEY, version: "x", startedAt: new Date().toISOString() }),
      )
      await assert.rejects(
        () =>
          startDaemon({
            key: KEY,
            port: 0,
            stateDir,
            engine: fakeEngine(),
            noTimers: true,
            skipExistingCheck: false, // 这道门就是被测对象
          }),
        (e) => e.code === "WB_DAEMON_ALREADY_RUNNING",
      )
      // 原守护进程不受影响
      assert.equal((await get(h.port, "/api/hello")).status, 200)
    } finally {
      dummy.kill()
      await h.stop()
      cleanupSandbox(stateDir) // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("排程窗口：当前小时命中即触发一次，同一天同窗口不重复（默认 hours 全空不触发）", async () => {
    const stateDir = tmpState()
    const { h, engine } = await boot({ stateDir })
    try {
      // 安全默认（C1）：scheduler 缺省 false，tick 一律不动 —— 先显式开启再验窗口逻辑
      const st = await post(h.port, "/api/settings", { scheduler: true }, KEY)
      assert.equal(st.status, 200)
      assert.equal((await st.json()).scheduler, true)

      const d = new Date()
      // 排程小时按北京时间（UTC+8）解释（CONTRACT §7/§8）：这里用与引擎相同的
      // 换算取「当前北京小时」，与 checkScheduler 收到的同一时刻对齐，不依赖宿主时区
      const hour = new Date(d.getTime() + 8 * 3600 * 1000).getUTCHours()
      // 需求 4：默认 hours 全空 = 默认不排任何腿 —— 开了排程也绝不自动触发
      assert.equal(h.ticks.checkScheduler(d.getTime()), null, `默认空窗口：北京 ${hour} 点不触发`)
      // 显式配 travel:[当前小时] → 命中即触发一次；同一天同窗口不重复
      const st2 = await post(h.port, "/api/settings", { hours: { travel: [hour] } }, KEY)
      assert.equal(st2.status, 200)
      const job = h.ticks.checkScheduler(d.getTime())
      assert.ok(job, `小时 ${hour} 在显式配置的 travel 窗口内应触发`)
      assert.ok(job.id)
      for (let i = 0; i < 100 && h.runner.current(); i++) await tick()
      // 同一窗口再 tick：job 已结束，只能是 fired 已标记 —— 不应再启动
      const again = h.ticks.checkScheduler(d.getTime() + 1000)
      assert.ok(again === null)
      void engine
    } finally {
      await h.stop()
      cleanupSandbox(stateDir) // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })
})

// tests-shell/snap-cache-version.test.mjs —— 快照缓存版本戳与升级读（P2）回归：
//
// 缺陷（用户真实环境实测）：daemon 把任务快照缓存写进 state/snapshots.json，
// 读取时原样吐出缓存对象、不重新投影 —— 旧版 daemon 写的 8 键缓存被新版直接
// 返回，P0-2 新增的 6 个判断字段（desktopOnly/unforgeable/reason/canAccept/
// canLight/pinnedExpertId）全是 undefined，前端把按钮可用性判错。
//
// 修复口径（宁可空，不可错）：
//   1. snapshots.json 落盘「投影前」的规范 Task（fetchTasks 返回形状）+ snapVersion；
//   2. /api/state 读取时一律 snapTask 现场重投影（读取路径 = 投影的唯一出口）；
//      snapTask 幂等 —— 旧 8 键缓存恰好保留全部判断输入，重算 6 个判断字段与
//      直接刷新逐字节一致，升级后不必等下一次 ?refresh=；
//   3. 版本不符且条目缺投影所需字段（无法无损重建）→ 整份快照判过期，
//      snapshot:null —— 前端显示「快照已过期，请刷新」，绝不带错误判断渲染。
// 零真实网络：fetch/时钟全注入，并断言缓存读取路径一次上游请求都不发。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { SNAP_VERSION, canReprojectTask, projectSnapshot, snapTask, startDaemon } from "../daemon.mjs"
import { fetchTasks } from "../engine/tasks.mjs"
import {
  cleanupAllSandboxes,
  cleanupSandbox,
  fakeClock,
  localTime,
  makeAcct,
  makeSandbox,
  task,
  wbBackend,
} from "../tests/helpers.mjs"

const KEY = "test-key-snap-cache"

// 兜底：bootWithCache 内部创建的沙箱（每条用例独占，并发隔离是刻意的 —— 缓存
// 形态断言都落在 stateDir/snapshots.json 上）在文件收尾统一回收；见 helpers.mjs
// 三道卫生线。
after(() => {
  cleanupAllSandboxes()
})
const jumpOf = (id) =>
  `https://www.workbuddy.cn/work/launch/?deeplink=workbuddy%3A%2F%2Fexperts%3FexpertId%3D${id}&buddy_type=workbuddy`

// 覆盖各判断族的种子（码/jumpUrl/状态形态来自容器内只读实测，与
// tests-shell/snap-projection.test.mjs 的真实 19 项同一口径）
const SEEDS = () => [
  task("RichMeow_Chat", { title: "桌面端对话1次", status: "not_accepted", current: 0, target: 1, reward: 5, reward_energy: 0, jump_url: "workbuddy://chat" }),
  task("chat_5", { title: "和 AI 聊天 5 次", status: "accepted", current: 3, target: 5, reward: 100, reward_energy: 5, jump_url: "workbuddy://chat" }),
  { task_code: "expert_use_maidehao", title: "体验「中国电商运营专家」", description: "", jump_url: jumpOf("ex_GDl31WahyIH0"), accept_status: "not_accepted", task_type: "single", progress: { current: 0, target: 1 }, reward_credit: 50, reward_energy: 5 },
  task("wb_wechat_oa_subscribe_task", { title: "关注官方公众号", status: "not_accepted", jump_url: "https://www.workbuddy.cn/events/follow-guide/" }),
  task("first_buddy", { title: "领取一只 Buddy", status: "not_accepted", task_type: "auto", jump_url: "workbuddy://chat" }),
  task("skill_1", { title: "尝鲜热门技能", status: "claimed", current: 1, target: 1, jump_url: "workbuddy://skills" }),
]

// 真实引擎 fetchTasks 的 canonical Task（判断字段出自 engine/taskkind 唯一判断源）
async function canonicalTasks() {
  const clock = fakeClock(localTime(2026, 10, 31, 10, 0))
  const backend = wbBackend({ clock, tasks: SEEDS(), litRules: {} })
  return fetchTasks(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl })
}

const SNAP_KEYS = [
  "acceptStatus", "canAccept", "canLight", "code", "description", "desktopOnly", "jumpUrl",
  "lockHint", "locked", "lockedUntil", "pinnedExpertId", "progress", "reason",
  "rewardCredit", "rewardEnergy", "taskType", "title", "unforgeable",
]
const JUDGMENT_KEYS = ["desktopOnly", "unforgeable", "reason", "canAccept", "canLight", "pinnedExpertId"]
// 次日锁字段（需求 2）：无锁调用 → locked=false、其余空串；重投影与直接刷新一致
const LOCK_KEYS = ["locked", "lockedUntil", "lockHint"]

// ---- 单元：snapTask 幂等 + projectSnapshot 分流 -----------------------------

describe("P2 单元：缓存形态重投影 === 直接刷新投影（幂等）", () => {
  test("旧 8 键 / 现行 18 键投影形态再投影，均与直接刷新逐字节一致", async () => {
    const fresh = (await canonicalTasks()).map(snapTask)
    assert.ok(fresh.length >= 5)

    // 现行新版缓存写出的形态：投影后 18 键（判断 + 次日锁字段 + 上游说明齐）
    const round14 = JSON.parse(JSON.stringify(fresh))
    // 旧版 daemon（P0-2 之前）写出的形态：8 键（无 6 个判断字段与 3 个锁字段）
    const round8 = round14.map(({ desktopOnly, unforgeable, reason, canAccept, canLight, pinnedExpertId, locked, lockedUntil, lockHint, description, ...rest }) => rest)
    for (const t of round8) {
      assert.deepEqual(
        Object.keys(t).sort(),
        ["acceptStatus", "code", "jumpUrl", "progress", "rewardCredit", "rewardEnergy", "taskType", "title"],
        "旧版缓存每任务恰好 8 键",
      )
    }

    // 旧 8 键缓存没有 description（该字段 0.3.3 才进投影）：重投影后补空串、其余逐字节一致
    const strip = (t) => { const { description, ...r } = t; return r }
    assert.deepEqual(round8.map(snapTask).map(strip), fresh.map(strip), "旧 8 键缓存重算判断字段后 === 直接刷新投影（description 除外）")
    assert.ok(round8.map(snapTask).every((t) => t.description === ""), "旧缓存缺 description → 补空串，不抛也不 undefined")
    assert.deepEqual(round14.map(snapTask), fresh, "18 键投影形态再投影 === 直接刷新投影（幂等）")
  })

  test("canReprojectTask：8/14 键形态可重建；缺 code/taskType/acceptStatus 等一律不可", () => {
    const good8 = {
      code: "chat_5", title: "和 AI 聊天 5 次", acceptStatus: "accepted",
      progress: { current: 0, target: 5 }, rewardCredit: 100, rewardEnergy: 0,
      jumpUrl: "", taskType: "single",
    }
    assert.equal(canReprojectTask(good8), true)
    assert.equal(canReprojectTask({ ...good8, ...snapTask(good8) }), true, "14 键投影形态可重建")
    // 上游真实会缺的字段允许空串（如实透传，与直接刷新同判）
    assert.equal(canReprojectTask({ ...good8, code: "" }), true)
    assert.equal(canReprojectTask({ ...good8, jumpUrl: "", taskType: "" }), true)
    // 缺键 = 不是任何已知写入路径的产物，无法无损重建
    assert.equal(canReprojectTask({ ...good8, code: undefined }), false)
    assert.equal(canReprojectTask({ ...good8, title: undefined }), false)
    assert.equal(canReprojectTask({ ...good8, acceptStatus: undefined }), false)
    assert.equal(canReprojectTask({ ...good8, acceptStatus: "" }), false, "规范化后 acceptStatus 永不为空")
    assert.equal(canReprojectTask({ ...good8, jumpUrl: undefined }), false)
    assert.equal(canReprojectTask({ ...good8, taskType: undefined }), false)
    assert.equal(canReprojectTask({ ...good8, progress: undefined }), false)
    assert.equal(canReprojectTask({ ...good8, progress: null }), false)
    assert.equal(canReprojectTask({ ...good8, rewardCredit: "x" }), false)
    assert.equal(canReprojectTask(null), false)
    assert.equal(canReprojectTask([good8]), false)
    assert.equal(canReprojectTask("chat_5"), false)
  })

  test("projectSnapshot：旧版/未来版本戳可重建；坏条目整份过期；v2 判断字段按引擎重算", () => {
    const ok8 = () => ({
      code: "RichMeow_Chat", title: "富猫聊天", acceptStatus: "not_accepted",
      progress: { current: 0, target: 1 }, rewardCredit: 5, rewardEnergy: 0,
      jumpUrl: "workbuddy://chat", taskType: "single",
    })

    // 旧 8 键（无版本戳）→ 重投影出确定的判断字段
    const legacy = projectSnapshot({ tasks: [ok8()], energy: 42, streak: 7, days: 7, updatedISO: "2026-10-30T08:00:00.000Z" })
    assert.ok(legacy, "旧缓存可无损重建 → 不判过期")
    // RichMeow 已移出 DESKTOP_ONLY（6 条桌面会话事件链可点亮）：not_accepted
    // → 可接取、不可点亮（desktopOnly=false 与状态无关）
    assert.equal(legacy.tasks[0].desktopOnly, false)
    assert.equal(legacy.tasks[0].canAccept, true)
    assert.equal(legacy.tasks[0].canLight, false)
    assert.equal(legacy.energy, 42)
    assert.equal(legacy.updatedISO, "2026-10-30T08:00:00.000Z")

    // 未来版本戳（999）+ 完整条目 → 重建，既不作废也不原样吐出
    const future = projectSnapshot({ snapVersion: 999, tasks: [ok8()] })
    assert.ok(future)
    for (const k of [...JUDGMENT_KEYS, ...LOCK_KEYS]) assert.notEqual(future.tasks[0][k], undefined, `未来版本戳也不得漏投 ${k}`)

    // 版本不符/无版本戳 + 缺字段 → 整份过期（宁可空，不可错）
    assert.equal(projectSnapshot({ snapVersion: 999, tasks: [{ ...ok8(), taskType: undefined }] }), null)
    assert.equal(projectSnapshot({ tasks: [{ ...ok8(), code: undefined }] }), null)
    // 结构残缺 → 过期
    assert.equal(projectSnapshot({ tasks: "nope" }), null)
    assert.equal(projectSnapshot(null), null)
    assert.equal(projectSnapshot([1]), null)

    // v2 规范 Task：缓存里的 unforgeable/reason 只是内容，读取时按引擎重算
    const stale = projectSnapshot({
      snapVersion: SNAP_VERSION,
      tasks: [{
        code: "chat_5", title: "和 AI 聊天 5 次", description: "", jumpUrl: "workbuddy://chat",
        acceptStatus: "accepted", taskType: "single", progress: { current: 3, target: 5 },
        rewardCredit: 100, rewardEnergy: 5, unforgeable: true, reason: "陈年误标",
      }],
    })
    assert.ok(stale)
    assert.equal(stale.tasks[0].unforgeable, false, "unforgeable 由引擎重算，不信缓存旧值")
    assert.equal(stale.tasks[0].reason, "")
    assert.equal(stale.tasks[0].canLight, true)

    // v2 条目非对象（手改坏文件）→ 整份过期；空任务列表不是过期
    assert.equal(projectSnapshot({ snapVersion: SNAP_VERSION, tasks: [null] }), null)
    assert.deepEqual(projectSnapshot({ snapVersion: SNAP_VERSION, tasks: [] }).tasks, [])
  })
})

// ---- 集成：读缓存路径零上游 --------------------------------------------------

// 读缓存路径的引擎替身：tasks/upstream 一被调用就计数；throwOnCall 时直接爆炸。
function engineFor(recorder, throwOnCall = true) {
  return {
    store: {
      readMagpieConfigDir: () => null,
      loadAccounts: () => [
        {
          key: "workbuddy", provider: "workbuddy", uid: "u1", nickname: "阿猫",
          access: "a", refresh: "r", expires: Date.now() + 86400000,
          domain: "", isApiKey: false, enterpriseId: "",
        },
      ],
      eligibleAccounts: (accounts) =>
        accounts.filter((a) => a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false),
    },
    runner: {
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
    },
    tasks: {
      fetchTasks: async () => {
        if (recorder) recorder.fetchTasks++
        if (throwOnCall) throw new Error("读缓存路径不得打上游（fetchTasks 被调用）")
        return []
      },
    },
    upstream: {
      growthBase: () => "https://copilot.tencent.com",
      billBase: () => "https://www.codebuddy.cn",
      webBase: () => "https://www.workbuddy.cn",
      callJSON: async () => {
        if (recorder) recorder.callJSON++
        if (throwOnCall) throw new Error("读缓存路径不得打上游（callJSON 被调用）")
        return { ok: false, status: 500, code: -1, msg: "not used" }
      },
    },
    errors: [],
    ok: true,
  }
}

async function bootWithCache(cache, hooks) {
  const stateDir = makeSandbox("wb-tasks-cache-").dir
  writeFileSync(join(stateDir, "snapshots.json"), JSON.stringify(cache, null, 2) + "\n")
  const h = await startDaemon({
    key: KEY,
    port: 0,
    stateDir,
    engine: engineFor(hooks?.recorder, hooks?.throwOnCall ?? true),
    noTimers: true,
    skipExistingCheck: true,
    sleep: async () => {},
  })
  return { h, stateDir }
}

const getState = async (h, path = "/api/state") => {
  const res = await fetch(`http://127.0.0.1:${h.port}${path}`, { headers: { authorization: `Bearer ${KEY}` } })
  assert.equal(res.status, 200)
  return res.json()
}

describe("P2 集成：旧版 8 键缓存被新版读出 —— 6 个判断字段有确定值（零上游）", () => {
  test("升级读：desktopOnly/pinnedExpertId 等由引擎重算，与真实数据口径一致", async () => {
    const recorder = { fetchTasks: 0, callJSON: 0 }
    const { h } = await bootWithCache(
      {
        u1: {
          tasks: [
            { code: "RichMeow_Chat", title: "桌面端对话1次", acceptStatus: "not_accepted", progress: { current: 0, target: 1 }, rewardCredit: 5, rewardEnergy: 0, jumpUrl: "workbuddy://chat", taskType: "single" },
            { code: "expert_use_maidehao", title: "体验「中国电商运营专家」", acceptStatus: "not_accepted", progress: { current: 0, target: 1 }, rewardCredit: 50, rewardEnergy: 5, jumpUrl: jumpOf("ex_GDl31WahyIH0"), taskType: "single" },
            { code: "chat_5", title: "和 AI 聊天 5 次", acceptStatus: "accepted", progress: { current: 3, target: 5 }, rewardCredit: 100, rewardEnergy: 5, jumpUrl: "workbuddy://chat", taskType: "single" },
          ],
          energy: 42,
          streak: 7,
          days: 7,
          updatedISO: "2026-10-30T08:00:00.000Z",
        },
      },
      { recorder },
    )
    try {
      const st = await getState(h)
      const snap = st.accounts[0].snapshot
      assert.ok(snap, "8 键缓存可无损重建 → 不判过期")
      assert.equal(snap.energy, 42)
      assert.equal(snap.streak, 7)
      assert.equal(snap.days, 7)
      assert.equal(snap.updatedISO, "2026-10-30T08:00:00.000Z")

      // 键集合逐字：8 规范 + 6 判断，缺的 6 个字段不得是 undefined
      for (const t of snap.tasks) {
        assert.deepEqual(Object.keys(t).sort(), SNAP_KEYS)
        for (const k of JUDGMENT_KEYS) assert.notEqual(t[k], undefined, `${t.code}.${k} 不得是 undefined`)
      }
      const byCode = new Map(snap.tasks.map((t) => [t.code, t]))
      // desktopOnly 与 jumpUrl 形状无关（真实数据 19/19 都有非空 jumpUrl，前端不许按它猜）；
      // RichMeow 已移出 DESKTOP_ONLY：not_accepted → 可接取（升级读由引擎重算，不是缓存旧值）
      assert.equal(byCode.get("RichMeow_Chat").desktopOnly, false)
      assert.equal(byCode.get("RichMeow_Chat").canAccept, true)
      assert.equal(byCode.get("RichMeow_Chat").canLight, false)
      // pinnedExpertId 从缓存 jumpUrl 由引擎解析器重算（不是前端猜的）
      assert.equal(byCode.get("expert_use_maidehao").pinnedExpertId, "ex_GDl31WahyIH0")
      assert.equal(byCode.get("expert_use_maidehao").canAccept, true)
      assert.equal(byCode.get("chat_5").canLight, true, "accepted → 可点亮")
      assert.equal(recorder.fetchTasks, 0, "读取路径零上游请求（fetchTasks 未被调用）")
      assert.equal(recorder.callJSON, 0, "读取路径零上游请求（callJSON 未被调用）")
    } finally {
      await h.stop()
    }
  })
})

describe("P2 集成：版本戳不符 / 缺字段 → 整份过期，宁可空不可错", () => {
  const ok8 = () => ({
    code: "chat_5", title: "和 AI 聊天 5 次", acceptStatus: "accepted",
    progress: { current: 3, target: 5 }, rewardCredit: 100, rewardEnergy: 5,
    jumpUrl: "workbuddy://chat", taskType: "single",
  })

  test("缺投影所需字段（无版本戳/未来版本戳）→ snapshot:null，绝不带病渲染", async () => {
    // JSON.stringify 丢 undefined 键：落盘后就是「缺键」的真实形态
    const cases = [
      ["缺 code（判断会全落「未收录」）", { tasks: [{ ...ok8(), code: undefined }] }],
      ["缺 taskType（auto 会被误判成非 auto）", { tasks: [{ ...ok8(), taskType: undefined }] }],
      ["缺 acceptStatus（未来版本戳同样不信任）", { snapVersion: 999, tasks: [{ ...ok8(), acceptStatus: undefined }] }],
      ["缺 progress", { tasks: [{ ...ok8(), progress: undefined }] }],
      ["tasks 不是数组", { tasks: {} }],
    ]
    for (const [label, cache] of cases) {
      const { h } = await bootWithCache({ u1: { ...cache, energy: 42, updatedISO: "2026-10-30T08:00:00.000Z" } })
      try {
        const st = await getState(h)
        assert.equal(st.accounts[0].snapshot, null, `${label} → 快照判过期（snapshot:null）`)
      } finally {
        await h.stop()
      }
    }
  })

  test("版本戳不符但条目完整 → 重建出确定判断（既不作废也不原样吐出）", async () => {
    const { h } = await bootWithCache({
      u1: { snapVersion: 999, tasks: [ok8()], energy: 1, updatedISO: "2026-10-30T08:00:00.000Z" },
    })
    try {
      const snap = (await getState(h)).accounts[0].snapshot
      assert.ok(snap, "可无损重建 → 不误判过期")
      assert.deepEqual(Object.keys(snap.tasks[0]).sort(), SNAP_KEYS, "返回的是重投影结果，不是缓存原样")
      assert.equal(snap.tasks[0].canLight, true)
      assert.equal(snap.tasks[0].desktopOnly, false)
      assert.equal(snap.energy, 1)
    } finally {
      await h.stop()
    }
  })
})

describe("P2 集成：落盘规范 Task + snapVersion；重启后缓存读出 === 直接刷新（幂等）", () => {
  test("?refresh=1 落盘投影前形状（判断字段不落盘）；换进程读缓存与刷新结果逐字节一致", async () => {
    const stateDir = makeSandbox("wb-tasks-cache-").dir
    const canonical = await canonicalTasks()

    // 进程 A（直接刷新路径）：fetchTasks 吐真实引擎的 canonical Task
    const engineA = { ...engineFor(null, false), tasks: { fetchTasks: async () => canonical.map((t) => ({ ...t })) } }
    const hA = await startDaemon({
      key: KEY, port: 0, stateDir, engine: engineA,
      noTimers: true, skipExistingCheck: true, sleep: async () => {},
    })
    let snapA
    try {
      snapA = (await getState(hA, "/api/state?refresh=1")).accounts[0].snapshot
      assert.ok(snapA && snapA.tasks.length === canonical.length)
      assert.ok(snapA.tasks.every((t) => Object.keys(t).sort().join() === SNAP_KEYS.join()))
    } finally {
      await hA.stop()
    }

    // 落盘格式：snapVersion + 投影前规范 Task（判断字段与锁的**输出**字段不落盘；
    // locked/unlockAt 是 0.3.2 起的投影**输入**字段——上游清单自带，随规范 Task 落盘）
    const disk = JSON.parse(readFileSync(join(stateDir, "snapshots.json"), "utf8"))
    assert.equal(disk.u1.snapVersion, SNAP_VERSION, "缓存带版本戳")
    for (const t of disk.u1.tasks) {
      for (const k of ["desktopOnly", "canAccept", "canLight", "pinnedExpertId", "lockedUntil", "lockHint"]) {
        assert.ok(!(k in t), `判断/锁输出字段 ${k} 不落盘（读取时才投影）`)
      }
      assert.ok("locked" in t && "unlockAt" in t, "上游锁输入字段 locked/unlockAt 随规范 Task 落盘（0.3.2）")
      assert.ok("description" in t && "unforgeable" in t && "reason" in t, "落盘的是规范 Task 形状")
    }

    // 进程 B（缓存读出路径）：fetchTasks/callJSON 一被调用就爆炸 —— 证明读的是缓存
    const recorder = { fetchTasks: 0, callJSON: 0 }
    const hB = await startDaemon({
      key: KEY, port: 0, stateDir, engine: engineFor(recorder, true),
      noTimers: true, skipExistingCheck: true, sleep: async () => {},
    })
    try {
      const snapB = (await getState(hB)).accounts[0].snapshot
      assert.equal(recorder.fetchTasks, 0, "缓存读出路径零上游请求")
      assert.deepEqual(snapB, snapA, "重建投影 === 直接刷新投影（幂等）")
    } finally {
      await hB.stop()
      cleanupSandbox(stateDir) // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })
})

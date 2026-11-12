// tests-shell/snap-projection.test.mjs —— daemon 快照投影（P0-2）与快照字段
// 口径（P1）的回归：
//   1. 真实形态 19 项任务 → engine.fetchTasks → daemon.snapTask：desktopOnly /
//      unforgeable / reason / canAccept / canLight / pinnedExpertId 全表钉死；
//      前端从此不必拿 jumpUrl 形状自己猜（真实数据 19 项全部有非空 jumpUrl）。
//   2. 接取后的中途状态：canLight 翻转、desktopOnly 仍为 false 不可点亮。
//   3. refreshSnapshots 只认 data.balance / data.streak.days（P1 实测口径），
//      上游数据里塞毒键（data.energy / data.days）也不会被误读。
// 零真实网络：fetch 全部注入假后端 / 假引擎。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"

import { snapTask, startDaemon } from "../daemon.mjs"
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

// 兜底：个别用例漏删时在文件收尾统一回收（每条用例独占沙箱是刻意的并发隔离：
// 状态文件以 stateDir 为边界）；见 helpers.mjs 三道卫生线。
after(() => {
  cleanupAllSandboxes()
})

const jumpOf = (id) =>
  `https://www.workbuddy.cn/work/launch/?deeplink=workbuddy%3A%2F%2Fexperts%3FexpertId%3D${id}&buddy_type=workbuddy`

const derivedSeed = (code, title, id) => ({
  task_code: code,
  title,
  description: "",
  jump_url: jumpOf(id),
  accept_status: "not_accepted",
  task_type: "single",
  reward_credit: 50,
  reward_energy: 5,
  progress: null, // 真实形态：not_accepted 的任务 progress 是 null
})

// 真实 19 项（与 tests/taskkind-pipeline.test.mjs 同一套种子：码/状态/奖励/深链
// 形态来自容器内只读实测）。
const REAL_19 = () => [
  task("playbook_prompt", { title: "探索优秀灵感", status: "claimed", current: 1, target: 1, reward: 100, reward_energy: 5, jump_url: "workbuddy://playbook" }),
  task("RichMeow_Chat", { title: "桌面端对话1次", status: "claimed", current: 1, target: 1, reward: 100, reward_energy: 5, jump_url: "workbuddy://chat" }),
  task("Library_read", { title: "体验「资料库」", status: "accepted", current: 0, target: 1, reward: 100, reward_energy: 5, jump_url: "workbuddy://library" }),
  task("Expert_lighthouse", { title: "体验「腾讯轻量云」专家", status: "claimed", current: 1, target: 1, reward: 100, reward_energy: 5, jump_url: "workbuddy://expert" }),
  task("Hp_Appearance", { title: "体验「和平精英」主题", status: "claimed", current: 1, target: 1, reward: 100, reward_energy: 5, jump_url: "workbuddy://settings/appearance" }),
  task("Buddy_App", { title: "体验 WorkBuddy 「发现应用」", status: "accepted", current: 0, target: 1, reward: 100, reward_energy: 5, jump_url: "workbuddy://home?openBuddySwitcher=true" }),
  task("wb_wechat_oa_subscribe_task", { title: "关注「腾讯 WorkBuddy」官方公众号", status: "not_accepted", current: 0, target: 1, reward: 100, reward_energy: 5, jump_url: "https://www.workbuddy.cn/events/follow-guide/" }),
  task("WorkBuddy_Valorant", { title: "体验「无畏契约拼豆专家」", status: "not_accepted", reward: 100, reward_energy: 5, jump_url: "workbuddy://expert" }),
  derivedSeed("expert_use_maidehao", "体验「中国电商运营专家」", "ex_GDl31WahyIH0"),
  derivedSeed("expert_use_douyinyin", "体验「抖音策略师」", "ex_FbY5nlWTqDod"),
  derivedSeed("expert_use_shangjia_xuanchuan", "体验「商家宣传页与海报设计师」", "ex_Weo3x2EZuSDm"),
  derivedSeed("expert_use_bowangwang", "体验「直播电商教练」", "ex_WZY136wV5aMt"),
  task("Expert_team_use_3", { title: "召唤 3 次专家团", status: "claimed", current: 3, target: 3, reward: 100, reward_energy: 5, jump_url: "workbuddy://experts" }),
  task("first_buddy", { title: "领取一只 Buddy", status: "claimed", current: 1, target: 1, reward: 300, reward_energy: 8, task_type: "auto", jump_url: "workbuddy://chat" }),
  task("chat_5", { title: "和 AI 聊天 5 次", status: "claimed", current: 5, target: 5, reward: 100, reward_energy: 5, jump_url: "workbuddy://chat" }),
  task("skill_1", { title: "尝鲜热门技能", status: "claimed", current: 1, target: 1, reward: 100, reward_energy: 5, jump_url: "workbuddy://skills" }),
  task("expert_5", { title: "召唤 5 次专家", status: "claimed", current: 5, target: 5, reward: 100, reward_energy: 5, jump_url: "workbuddy://expert" }),
  task("template_5", { title: "使用 5 个模板", status: "claimed", current: 5, target: 5, reward: 100, reward_energy: 5, jump_url: "workbuddy://templates" }),
  task("automation_1", { title: "设置自动化任务", status: "claimed", current: 1, target: 1, reward: 100, reward_energy: 5, jump_url: "workbuddy://automation" }),
]

async function snapAll(seeds) {
  const clock = fakeClock(localTime(2026, 10, 31, 10, 0))
  const backend = wbBackend({ clock, tasks: seeds, litRules: {} })
  const tasks = await fetchTasks(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl })
  return tasks.map(snapTask)
}

describe("P0-2：snapTask 投影（真实形态 19 项）", () => {
  test("desktopOnly / unforgeable / reason / canAccept / canLight / pinnedExpertId 全表", async () => {
    const snaps = await snapAll(REAL_19())
    assert.equal(snaps.length, 19)

    // 投影键集合逐字钉死（契约 §3）：9 个规范字段（含 description 上游说明）
    // + 6 个判断字段 + 3 个次日锁字段
    //（无锁调用 → locked=false、lockedUntil/lockHint 空串，需求 2）
    for (const s of snaps) {
      assert.deepEqual(Object.keys(s).sort(), [
        "acceptStatus", "canAccept", "canLight", "code", "description", "desktopOnly",
        "jumpUrl", "lockHint", "locked", "lockedUntil", "pinnedExpertId", "progress",
        "reason", "rewardCredit", "rewardEnergy", "taskType", "title", "unforgeable",
      ])
    }

    // code → 判断字段全表（与引擎流水线的接取/点亮决策同源同值）
    const expected = {
      playbook_prompt: { desktopOnly: false, unforgeable: false, reason: "", canAccept: false, canLight: false, pinnedExpertId: "" },
      RichMeow_Chat: { desktopOnly: false, unforgeable: false, reason: "", canAccept: false, canLight: false, pinnedExpertId: "" },
      Library_read: { desktopOnly: false, unforgeable: false, reason: "", canAccept: false, canLight: true, pinnedExpertId: "" },
      Expert_lighthouse: { desktopOnly: false, unforgeable: false, reason: "", canAccept: false, canLight: false, pinnedExpertId: "ex_2cvvUZQhDyeJ" },
      Hp_Appearance: { desktopOnly: false, unforgeable: false, reason: "", canAccept: false, canLight: false, pinnedExpertId: "" },
      Buddy_App: { desktopOnly: false, unforgeable: false, reason: "", canAccept: false, canLight: true, pinnedExpertId: "" },
      wb_wechat_oa_subscribe_task: { desktopOnly: false, unforgeable: true, reason: "需在微信关注「腾讯 WorkBuddy」公众号满 24 小时", canAccept: false, canLight: false, pinnedExpertId: "" },
      WorkBuddy_Valorant: { desktopOnly: false, unforgeable: false, reason: "", canAccept: true, canLight: false, pinnedExpertId: "ex_xQHHD1u5Jkua" },
      expert_use_maidehao: { desktopOnly: false, unforgeable: false, reason: "", canAccept: true, canLight: false, pinnedExpertId: "ex_GDl31WahyIH0" },
      expert_use_douyinyin: { desktopOnly: false, unforgeable: false, reason: "", canAccept: true, canLight: false, pinnedExpertId: "ex_FbY5nlWTqDod" },
      expert_use_shangjia_xuanchuan: { desktopOnly: false, unforgeable: false, reason: "", canAccept: true, canLight: false, pinnedExpertId: "ex_Weo3x2EZuSDm" },
      expert_use_bowangwang: { desktopOnly: false, unforgeable: false, reason: "", canAccept: true, canLight: false, pinnedExpertId: "ex_WZY136wV5aMt" },
      Expert_team_use_3: { desktopOnly: false, unforgeable: false, reason: "", canAccept: false, canLight: false, pinnedExpertId: "" },
      first_buddy: { desktopOnly: false, unforgeable: false, reason: "", canAccept: false, canLight: false, pinnedExpertId: "" },
      chat_5: { desktopOnly: false, unforgeable: false, reason: "", canAccept: false, canLight: false, pinnedExpertId: "" },
      skill_1: { desktopOnly: false, unforgeable: false, reason: "", canAccept: false, canLight: false, pinnedExpertId: "" },
      expert_5: { desktopOnly: false, unforgeable: false, reason: "", canAccept: false, canLight: false, pinnedExpertId: "" },
      template_5: { desktopOnly: false, unforgeable: false, reason: "", canAccept: false, canLight: false, pinnedExpertId: "" },
      automation_1: { desktopOnly: false, unforgeable: false, reason: "", canAccept: false, canLight: false, pinnedExpertId: "" },
    }
    assert.deepEqual(new Set(snaps.map((s) => s.code)), new Set(Object.keys(expected)))
    for (const s of snaps) {
      assert.deepEqual(
        {
          desktopOnly: s.desktopOnly,
          unforgeable: s.unforgeable,
          reason: s.reason,
          canAccept: s.canAccept,
          canLight: s.canLight,
          pinnedExpertId: s.pinnedExpertId,
        },
        expected[s.code],
        `任务 ${s.code} 的判断字段与引擎结论不一致`,
      )
    }

    // 收敛结论的「批量接取」投影：canAccept 集合 = 5 项（Valorant + 4 个 expert_use_*）
    const canAccept = snaps.filter((s) => s.canAccept).map((s) => s.code)
    assert.deepEqual(canAccept, [
      "WorkBuddy_Valorant",
      "expert_use_maidehao",
      "expert_use_douyinyin",
      "expert_use_shangjia_xuanchuan",
      "expert_use_bowangwang",
    ])

    // 派生任务的奖励与深链如实透出（+50 积分 +5 能量）
    const maidehao = snaps.find((s) => s.code === "expert_use_maidehao")
    assert.equal(maidehao.rewardCredit, 50)
    assert.equal(maidehao.rewardEnergy, 5)
    assert.equal(maidehao.jumpUrl, jumpOf("ex_GDl31WahyIH0"))
    assert.deepEqual(maidehao.progress, { current: 0, target: 1 }, "progress null → 归一 0/1")
  })

  test("中途状态（接取后）：canLight 翻转；desktopOnly 依旧不可点亮", async () => {
    const seeds = REAL_19().map((t) => {
      const flip = {
        WorkBuddy_Valorant: "accepted",
        expert_use_maidehao: "accepted",
        expert_use_douyinyin: "accepted",
        expert_use_shangjia_xuanchuan: "accepted",
        expert_use_bowangwang: "accepted",
        chat_5: "accepted",
        RichMeow_Chat: "accepted", // RichMeow 已可经 6 连点亮：接取后即可点亮
        first_buddy: "not_accepted", // auto：未接取也可点亮
      }[t.task_code]
      return flip ? { ...t, accept_status: flip } : t
    })
    const snaps = await snapAll(seeds)
    const byCode = new Map(snaps.map((s) => [s.code, s]))

    for (const code of [
      "WorkBuddy_Valorant",
      "expert_use_maidehao",
      "expert_use_douyinyin",
      "expert_use_shangjia_xuanchuan",
      "expert_use_bowangwang",
      "chat_5",
      "RichMeow_Chat",
    ]) {
      assert.equal(byCode.get(code).canLight, true, `${code} accepted → 可点亮`)
      assert.equal(byCode.get(code).canAccept, false)
    }
    assert.equal(byCode.get("first_buddy").canLight, true, "auto 任务 not_accepted 即可点亮")
    assert.equal(byCode.get("first_buddy").canAccept, false, "auto 任务永不给接取结论")

    // desktop-only 只剩 Buddy_App_QQ（不在本 fixture）；Buddy_App 已实测 5 连可点亮
    const buddy = byCode.get("Buddy_App")
    assert.equal(buddy.desktopOnly, false, "Buddy_App 已移出 DESKTOP_ONLY")
    assert.equal(buddy.canLight, true, "accepted 的 Buddy_App 可经 5 连点亮")
    const richmeow = byCode.get("RichMeow_Chat")
    assert.equal(richmeow.desktopOnly, false, "RichMeow 不再是 desktop-only（6 连事件链已实现）")
    // Library_read 已改走 web 点击事件点亮（引擎 reportLibraryEvent）：不再是
    // desktop-only，accepted 状态即可点亮（真实形态 19 项里它就是 accepted）
    assert.equal(byCode.get("Library_read").desktopOnly, false, "Library_read 不再是 desktop-only")
    assert.equal(byCode.get("Library_read").canLight, true, "accepted 的 Library_read 可点亮")
    // wb_wechat：unforgeable 两头都封死
    assert.equal(byCode.get("wb_wechat_oa_subscribe_task").canAccept, false)
    assert.equal(byCode.get("wb_wechat_oa_subscribe_task").canLight, false)
    // 钉死 id 与状态无关地透出
    assert.equal(byCode.get("Expert_lighthouse").pinnedExpertId, "ex_2cvvUZQhDyeJ")
    assert.equal(byCode.get("WorkBuddy_Valorant").pinnedExpertId, "ex_xQHHD1u5Jkua")
  })
})

// ---- 次日锁投影（0.3.2）：上游字段优先，mp-locks 只是旧缓存回退 ------------

describe("snapTask 次日锁投影（上游 locked/unlock_at 优先）", () => {
  const base = () => ({
    code: "Sequential_Tasks_2",
    title: "小程序专家对话",
    acceptStatus: "not_accepted",
    taskType: "single",
    progress: { current: 0, target: 1 },
    rewardCredit: 200,
    rewardEnergy: 0,
    jumpUrl: "",
  })
  const mpLock = (until) => ({ until, reason: "陈旧锁" })

  test("带自身字段 → 上游为准：locked:true 标锁、locked:false 覆盖 mp-locks 陈旧锁", () => {
    // 上游明说已解锁（实测账号 ST2 实测形态）：即使 mp-locks 里有陈旧锁也不锁
    const unlocked = snapTask({ ...base(), locked: false }, mpLock("2026-11-09"))
    assert.equal(unlocked.locked, false)
    assert.equal(unlocked.lockedUntil, "")
    assert.equal(unlocked.lockHint, "")
    assert.equal(unlocked.canAccept, true)

    // 上游明说锁定（实测账号 B ST3 实测形态）：unlock_at +08:00 → 北京日
    const locked = snapTask({ ...base(), locked: true, unlockAt: "2026-11-08T00:00:00+08:00" }, mpLock("2026-11-09"))
    assert.equal(locked.locked, true)
    assert.equal(locked.lockedUntil, "2026-11-08", "unlock_at 按北京时间取日")
    assert.equal(locked.lockHint, "到第二天才能接取任务（2026-11-08 起可接）")
    assert.equal(locked.canAccept, false)
    assert.equal(locked.canLight, false, "canLight 等其余字段不变")
  })

  test("unlock_at 是 Z 时区 ISO 也按北京日取（不能 slice）；解析失败回退 mp-locks；无日期提示不带日期", () => {
    // 与 "2026-11-08T00:00:00+08:00" 同一时刻的 Z 形态 —— slice 会错成 11-07
    const z = snapTask({ ...base(), locked: true, unlockAt: "2026-11-07T16:00:00Z" })
    assert.equal(z.lockedUntil, "2026-11-08")
    // unlock_at 解析失败 → 回退 mp-locks 的 until
    const fallback = snapTask({ ...base(), locked: true, unlockAt: "not-a-date" }, mpLock("2026-11-12"))
    assert.equal(fallback.locked, true)
    assert.equal(fallback.lockedUntil, "2026-11-12")
    assert.equal(fallback.lockHint, "到第二天才能接取任务（2026-11-12 起可接）")
    // 连 mp-locks 也没有 → 锁定但无日期，提示不带日期
    const noDate = snapTask({ ...base(), locked: true, unlockAt: "" })
    assert.equal(noDate.locked, true)
    assert.equal(noDate.lockedUntil, "")
    assert.equal(noDate.lockHint, "到第二天才能接取任务")
  })

  test("旧缓存（无自身锁字段）→ 回退 mp-locks 锁表；无锁表 = 不锁", () => {
    const viaLocks = snapTask(base(), mpLock("2026-11-07"))
    assert.equal(viaLocks.locked, true, "旧缓存 + 锁表 → 回退锁定")
    assert.equal(viaLocks.lockedUntil, "2026-11-07")
    assert.equal(viaLocks.canAccept, false)
    const noLocks = snapTask(base())
    assert.equal(noLocks.locked, false, "旧缓存 + 无锁表 → 不锁（三字段仍存在）")
    assert.equal(noLocks.lockedUntil, "")
    assert.equal(noLocks.lockHint, "")
    assert.equal(noLocks.canAccept, true)
  })

  test("accepted / claimed 即使带 locked:true 也不标锁（not_accepted 门控）", () => {
    for (const status of ["accepted", "claimed"]) {
      const t = snapTask({ ...base(), acceptStatus: status, locked: true, unlockAt: "2026-11-08T00:00:00+08:00" }, mpLock("2026-11-09"))
      assert.equal(t.locked, false, `${status} 绝不显示锁定徽章/提示`)
      assert.equal(t.lockedUntil, "")
      assert.equal(t.lockHint, "")
      assert.equal(t.canAccept, false)
    }
  })
})

// ---- P1：refreshSnapshots 只认 data.balance / data.streak.days ---------------

function engineWithPoisonedUpstream() {
  const tasks = [
    { code: "chat_5", title: "和 AI 聊天 5 次", acceptStatus: "accepted", progress: { current: 3, target: 5 }, rewardCredit: 100, rewardEnergy: 5, jumpUrl: "workbuddy://chat" },
  ]
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
      fetchTasks: async () => tasks.map((t) => ({ ...t })),
    },
    upstream: {
      growthBase: () => "https://copilot.tencent.com",
      billBase: () => "https://www.codebuddy.cn",
      webBase: () => "https://www.workbuddy.cn",
      // 毒键：data.energy / data.value / data.days / data.streakDays 都存在但
      // 数值是错的 —— daemon 若做「多拼写回退链」就会读错，这里钉死单一读径。
      callJSON: async (_acct, _kind, url) => {
        if (String(url).endsWith("/v2/activity/growth/energy")) {
          return { ok: true, status: 200, code: 0, msg: "", data: { balance: 42, energy: 999, value: 777 } }
        }
        if (String(url).endsWith("/activity/growth/streak")) {
          return { ok: true, status: 200, code: 0, msg: "", data: { days: 99, streakDays: 88, streak: { days: 7 } } }
        }
        return { ok: true, status: 200, code: 0, msg: "", data: {} }
      },
    },
    errors: [],
    ok: true,
  }
}

describe("P1：快照 energy/streak 单一字段口径", () => {
  test("?refresh=1 只读 data.balance 与 data.streak.days（毒键不误读）", async () => {
    const sb = makeSandbox("wb-tasks-snap-") // 独立临时 state（并发隔离），finally 里即删
    const h = await startDaemon({
      key: "test-key-snap-projection",
      port: 0,
      stateDir: sb.dir,
      engine: engineWithPoisonedUpstream(),
      noTimers: true,
      skipExistingCheck: true,
      sleep: async () => {}, // 快照限速 sleep 不真等
    })
    try {
      const res = await fetch(`http://127.0.0.1:${h.port}/api/state?refresh=1`, {
        headers: { authorization: "Bearer test-key-snap-projection" },
      })
      assert.equal(res.status, 200)
      const st = await res.json()
      const snap = st.accounts[0].snapshot
      assert.equal(snap.energy, 42, "energy = data.balance（P1 实测口径），不是 data.energy/value")
      assert.equal(snap.streak, 7, "streak = data.streak.days（P1 实测口径），不是 data.days/streakDays")
      assert.equal(snap.days, 7)
      assert.equal(snap.tasks.length, 1)
      assert.equal(snap.tasks[0].canLight, true, "投影判断字段照常下发")
    } finally {
      await h.stop()
      cleanupSandbox(sb.dir) // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })
})

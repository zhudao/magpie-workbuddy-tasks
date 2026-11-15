// tests-shell/stats-beijing-day.test.mjs —— computeStats「今日」口径（P3-1）回归。
//
// 生产事故形态：magpie 容器时区是 UTC，computeStats 的「今日」以前用宿主时区
// dateKey()、行侧取 ISO 串的 UTC 日期段 —— UTC 容器里「今日积分」要到北京
// 08:00（UTC 00:00 翻宿主日）才翻日；UTC+8 宿主上则是拿宿主日比 UTC 日，两头
// 都是错口径。修后与全仓日期口径（排程窗口/同日去重/连登/夜猫子，CONTRACT §7/§8）
// 一致：一律北京日（engine/constants.beijingDateKey，UTC 16:00 整翻北京日）。
//
// 钉死（宿主时区无关的确定性断言）：时钟拨在北京日刚翻过线的那一刻
// （UTC 2026-11-13 16:30 = 北京 2026-11-14 00:30）：
//   - history 行 at = UTC 15:59（北京 11-13 23:59，**北京昨日**）→ 不计入今日；
//   - history 行 at = UTC 16:01（北京 11-14 00:01，**北京今日**）→ 计入今日。
// 旧实现无论宿主时区是 UTC 还是 UTC+8 都通不过这个断言（UTC 宿主会把昨日行算进
// 今日；UTC+8 宿主会把今日行漏掉）。
//
// 全程零真实网络：引擎是假壳（不跑任何腿），时钟显式注入，历史行直接种 history.json。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startDaemon } from "../daemon.mjs"
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox } from "../tests/helpers.mjs"

// 锚在北京日刚翻线后：2026-11-13 16:30Z = 北京 2026-11-14 00:30（UTC 还是 13 号）。
const NOW = Date.UTC(2026, 10, 13, 16, 30, 0)
const UID = "u-stats-bj"

// ---- 假引擎：不跑任何腿，只喂一个可参与账号 -------------------------------
function fakeEngine() {
  return {
    store: {
      loadAccounts: () => [
        {
          key: "workbuddy",
          provider: "workbuddy",
          uid: UID,
          nickname: "阿猫",
          access: "a-stats-bj",
          refresh: "r-stats-bj",
          expires: NOW + 86400000,
          domain: "",
          isApiKey: false,
          enterpriseId: "",
        },
      ],
      eligibleAccounts: (accounts) =>
        accounts.filter((a) => a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false),
    },
    runner: null,
    tasks: null,
    upstream: null,
    errors: [],
    ok: true,
  }
}

// 历史行：三种北京日归属。credit/energy 只在 state ok|skip 时计入。
function row(atIso, state, credit, energy, jobId) {
  return { at: atIso, uid: UID, nickname: "阿猫", leg: "growth", state, detail: "", credit, energy, jobId, trigger: "manual" }
}

const keep = []
after(() => {
  for (const d of keep) cleanupSandbox(d)
  cleanupAllSandboxes()
})

async function bootWithHistory(history) {
  const stateDir = makeSandbox("wb-stats-bj-").dir
  keep.push(stateDir)
  mkdirSync(stateDir, { recursive: true })
  if (history) writeFileSync(join(stateDir, "history.json"), JSON.stringify(history), "utf8")
  return startDaemon({
    key: "stats-bj-key-0123456789abcdef",
    port: 0,
    stateDir,
    engine: fakeEngine(),
    now: () => NOW,
    noTimers: true,
    skipExistingCheck: true,
  })
}

describe("computeStats 北京日口径（P3-1：UTC 16:00 整翻北京日）", () => {
  test("北京昨日 23:59 的行不计入、北京今日 00:01 的行计入（时钟钉在翻线后半小时）", async () => {
    // 北京日界 = UTC 16:00。15:59Z 属北京 11-13（昨日），16:01Z 属北京 11-14（今日）。
    const history = [
      row("2026-11-13T15:59:00.000Z", "ok", 10, 1, "job-yesterday"),
      row("2026-11-13T16:01:00.000Z", "ok", 20, 2, "job-today"),
      row("2026-11-12T10:00:00.000Z", "ok", 99, 9, "job-older"), // 前天，绝不计入
      row("2026-11-13T16:01:00.000Z", "fail", 50, 5, "job-today"), // 今日但 fail：不计积分
    ]
    const h = await bootWithHistory(history)
    try {
      const j = await (await fetch(`http://127.0.0.1:${h.port}/api/state`)).json()
      assert.equal(j.stats.creditsToday, 20, `今日积分必须只含北京今日 ok 行（20），实际 ${j.stats.creditsToday}`)
      assert.equal(j.stats.energyToday, 2, `今日能量必须只含北京今日 ok 行（2），实际 ${j.stats.energyToday}`)
      assert.equal(j.stats.runs, 1, "runs = 今日行的 jobId 去重数（两条 16:01Z 行同属 job-today）")
    } finally {
      await h.stop()
    }
  })

  test("at 解析不了的脏行视作不属今日（与旧行为「匹配不上就跳过」一致）", async () => {
    const history = [
      row("2026-11-13T16:01:00.000Z", "ok", 7, 0, "job-ok"),
      row("not-a-date", "ok", 1000, 1000, "job-dirty"), // 脏 at：旧版 slice(0,10) 匹配不上，新版 beijingDayFromIso → null
      row(undefined, "ok", 2000, 2000, "job-missing"), // 缺 at：同上
    ]
    const h = await bootWithHistory(history)
    try {
      const j = await (await fetch(`http://127.0.0.1:${h.port}/api/state`)).json()
      assert.equal(j.stats.creditsToday, 7, "脏 at 行绝不计入今日积分")
      assert.equal(j.stats.energyToday, 0)
      assert.equal(j.stats.runs, 1)
    } finally {
      await h.stop()
    }
  })
})

// tests-shell/lastfired-prune.test.mjs —— lastFired.json 防膨胀（P3-2）回归。
//
// 旧行为：checkScheduler 每命中一个窗口就写一个 `legs@h@北京日` 去重键，从不清理
// —— 每天最多写入 legs 组合 × 24 个键，lastFired.json 随天数无限增长。
// 修后：写键时顺带剔除早于北京「今天」的条目（昨日键永远不可能再命中任何未来的
// fireKey，纯垃圾）；lastCycle 是 ISO 时间戳（不是日期键），不属清理对象。
// 读改写走既有 saveFired 的 tmp+rename 原子落盘，无额外并发窗口。
//
// 钉死：
//   1. fire 分支（有可参与账号）：种入昨日/前日的旧键 + 当日键 + lastCycle →
//      触发后旧键被清掉、当日键与 lastCycle 保留；
//   2. skip 分支（无可参与账号）：同样完成清理并写入当日 skip 键；
//   3. 日期段来自键尾 @YYYY-MM-DD，判断基准是北京日（checkScheduler 的同日
//      去重口径），UTC 16:00 翻线后昨日键即被清。
//
// 全程零真实网络：引擎是假壳（只记录 start spec），时钟显式注入。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startDaemon } from "../daemon.mjs"
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox } from "../tests/helpers.mjs"

// 北京 2026-11-14 09:00 = UTC 2026-11-14 01:00（北京 = UTC+8；与宿主时区无关的
// 确定性时刻）。此刻北京「今天」= 2026-11-14，昨日 = 2026-11-13，前日 = 11-12。
const NOW = Date.UTC(2026, 10, 14, 1, 0, 0)
const TODAY_BJ = "2026-11-14" // 北京今日
const UID = "u-fired-prune"

function fakeEngine({ noAccounts = false } = {}) {
  const specs = []
  let current = null
  const eng = {
    store: {
      loadAccounts: () =>
        noAccounts
          ? []
          : [
              {
                key: "workbuddy",
                provider: "workbuddy",
                uid: UID,
                nickname: "阿猫",
                access: "a-fired-prune",
                refresh: "r-fired-prune",
                expires: NOW + 86400000,
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

const keep = []
after(() => {
  for (const d of keep) cleanupSandbox(d)
  cleanupAllSandboxes()
})

// 种 lastFired.json：两个昨日键 + 一个前日键 + 一个当日键 + lastCycle。
function seedFired(stateDir) {
  const firedFile = join(stateDir, "lastFired.json")
  writeFileSync(
    firedFile,
    JSON.stringify({
      "travel@9@2026-11-13": "2026-11-13T01:00:00.000Z", // 北京昨日：清
      "night@1@2026-11-13": "2026-11-13T17:00:00.000Z", // 北京昨日：清
      "streak@8@2026-11-12": "2026-11-12T00:00:00.000Z", // 北京前日：清
      [`travel@21@${TODAY_BJ}`]: "2026-11-13T13:00:00.000Z", // 北京今日（别的窗口）：保留
      lastCycle: "2026-11-13T13:00:00.000Z", // ISO 时间戳：保留
    }),
    "utf8",
  )
  return firedFile
}

async function boot(stateDir, engine) {
  writeFileSync(
    join(stateDir, "settings.json"),
    JSON.stringify({ scheduler: true, hours: { travel: [9] } }),
    "utf8",
  )
  return startDaemon({
    key: "fired-prune-key-0123456789abcdef",
    port: 0,
    stateDir,
    engine,
    now: () => NOW,
    noTimers: true,
    skipExistingCheck: true,
  })
}

describe("lastFired.json 写键时剔除陈旧条目（P3-2）", () => {
  test("fire 分支：触发后昨日/前日键被清掉，当日键与 lastCycle 保留", async () => {
    const stateDir = makeSandbox("wb-fired-prune-").dir
    keep.push(stateDir)
    const firedFile = seedFired(stateDir)
    const engine = fakeEngine()
    const h = await boot(stateDir, engine)
    try {
      // 北京 09:00 命中 travel 窗口 → 走 fire 分支
      const job = h.ticks.checkScheduler(NOW)
      assert.ok(job, "travel 窗口必须触发（当日 9 点键尚未存在）")
      assert.deepEqual(job.legs, ["travel"])

      const fired = JSON.parse(readFileSync(firedFile, "utf8"))
      assert.ok(fired[`travel@9@${TODAY_BJ}`], "本次写入的当日键必须存在")
      assert.equal(fired["travel@9@2026-11-13"], undefined, "北京昨日键必须被剔除")
      assert.equal(fired["night@1@2026-11-13"], undefined, "北京昨日键（另一条腿）必须被剔除")
      assert.equal(fired["streak@8@2026-11-12"], undefined, "北京前日键必须被剔除")
      assert.ok(fired[`travel@21@${TODAY_BJ}`], "当日其它窗口的键必须保留")
      assert.equal(fired.lastCycle, fired[`travel@9@${TODAY_BJ}`], "lastCycle（ISO 时间戳）必须保留并指向本次触发")
      assert.ok(engine.__specs.length === 1, "假引擎恰好收到一次 start")
    } finally {
      await h.stop()
    }
  })

  test("skip 分支（无可参与账号）：同样完成清理并写入当日 skip 键", async () => {
    const stateDir = makeSandbox("wb-fired-prune-skip-").dir
    keep.push(stateDir)
    const firedFile = seedFired(stateDir)
    const h = await boot(stateDir, fakeEngine({ noAccounts: true }))
    try {
      const r = h.ticks.checkScheduler(NOW)
      assert.equal(r, null, "无可参与账号 → 返回 null（skip）")

      const fired = JSON.parse(readFileSync(firedFile, "utf8"))
      assert.ok(fired[`travel@9@${TODAY_BJ}`], "当日 skip 键已写入")
      assert.equal(fired["travel@9@2026-11-13"], undefined, "北京昨日键必须被剔除")
      assert.equal(fired["night@1@2026-11-13"], undefined, "北京昨日键（另一条腿）必须被剔除")
      assert.equal(fired["streak@8@2026-11-12"], undefined, "北京前日键必须被剔除")
      assert.ok(fired[`travel@21@${TODAY_BJ}`], "当日其它窗口的键必须保留")
      assert.ok(fired.lastCycle, "lastCycle 必须保留")
    } finally {
      await h.stop()
    }
  })

  test("窗口键当日已存在 → 提前 return 不写盘，也不误删旧条目（清理只搭写键的便车）", async () => {
    const stateDir = makeSandbox("wb-fired-prune-noop-").dir
    keep.push(stateDir)
    const firedFile = seedFired(stateDir)
    // 当日 9 点键已存在：checkScheduler 在查重处提前 return，不写盘
    writeFileSync(
      firedFile,
      JSON.stringify({
        [`travel@9@${TODAY_BJ}`]: "2026-11-13T01:00:00.000Z",
        "travel@9@2026-11-13": "2026-11-13T01:00:00.000Z", // 昨日旧键：本次没写键 → 不清（原样保留）
        lastCycle: "2026-11-13T01:00:00.000Z",
      }),
      "utf8",
    )
    const h = await boot(stateDir, fakeEngine())
    try {
      assert.equal(h.ticks.checkScheduler(NOW), null, "当日键已存在 → 不触发")
      const fired = JSON.parse(readFileSync(firedFile, "utf8"))
      assert.ok(fired["travel@9@2026-11-13"], "未发生写盘 → 旧条目原样保留（清理只在写键时顺带做）")
      assert.ok(fired.lastCycle)
    } finally {
      await h.stop()
    }
  })

  test("落盘原子性：写入走 saveFired 的 tmp+rename（不留 .tmp 残留）", async () => {
    const stateDir = makeSandbox("wb-fired-prune-atomic-").dir
    keep.push(stateDir)
    const firedFile = seedFired(stateDir)
    const h = await boot(stateDir, fakeEngine({ noAccounts: true }))
    try {
      h.ticks.checkScheduler(NOW)
      assert.ok(existsSync(firedFile), "lastFired.json 存在")
      const leftovers = readdirSync(stateDir).filter((n) => n.startsWith("lastFired.json.tmp-"))
      assert.deepEqual(leftovers, [], "tmp+rename 原子写不残留临时文件")
    } finally {
      await h.stop()
    }
  })
})

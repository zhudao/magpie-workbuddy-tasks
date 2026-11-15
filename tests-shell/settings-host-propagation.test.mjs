// tests-shell/settings-host-propagation.test.mjs —— settings.host 覆盖 → 引擎 bases
// 的端到端传播（P3-5 补测）。
//
// 此前三套测试里只有 engine 级的 opts.bases 用例（tests/upstream*.test.mjs），没有
// 一条「POST /api/settings 写 host.{chat,bill,web} → 引擎实际拿到覆盖值」的断言。
// 本文件走真实 daemon + 假引擎：JobRunner 在 start() 时读取 daemon 交给它的
// ctx.bases（runnerCtx 的 getter，现读 settings.host）并记录，钉死传播链：
//
//   POST /api/settings {host:{chat,bill,web}}
//     → settings.json 落盘（自定义反代是正当用法，无白名单/无校验，trim 原样）
//     → runnerCtx.bases getter 读到覆盖值
//     → 下一次 job 启动时引擎实际拿到覆盖后的 bases（不是默认上游、不是空串）
//
// 空串语义不变：host 留空 = 引擎侧用 engine/upstream 的默认（bases 传空串，
// engine/upstream.chatBase 的 fromOpts 逻辑按空值回退默认上游）。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { startDaemon } from "../daemon.mjs"
import { cleanupAllSandboxes, cleanupSandbox, makeSandbox } from "../tests/helpers.mjs"

const UID = "u-host-prop"

function fakeEngine() {
  const eng = {
    store: {
      loadAccounts: () => [
        {
          key: "workbuddy",
          provider: "workbuddy",
          uid: UID,
          nickname: "阿猫",
          access: "a-host-prop",
          refresh: "r-host-prop",
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
        constructor(opts) {
          this.opts = opts
        }
        start(spec) {
          if (eng.currentJob) throw Object.assign(new Error("runner busy"), { code: 409 })
          // 引擎收 bases 的真实时点：run 内展开 legOpts 时读 this.opts.bases
          //（engine/runner.mjs 同款）。假引擎在 start() 快照一份。
          eng.seenBases.push({ ...this.opts.bases })
          const job = {
            id: `job-host-${eng.seenBases.length}`,
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
          eng.currentJob = job
          const t = setTimeout(() => {
            job.state = "done"
            job.endedAt = new Date().toISOString()
            if (eng.currentJob?.id === job.id) eng.currentJob = null
          }, 50)
          t.unref?.()
          return job
        }
        get() {
          return null
        }
        current() {
          return eng.currentJob && eng.currentJob.state === "running" ? eng.currentJob : null
        }
        stop(id) {
          const job = eng.currentJob
          if (!job || job.id !== id) return null
          job.state = "error"
          job.endedAt = new Date().toISOString()
          eng.currentJob = null
          return job
        }
      },
    },
    tasks: null,
    upstream: null,
    errors: [],
    ok: true,
    seenBases: [],
    currentJob: null,
  }
  return eng
}

const tick = (ms = 90) => new Promise((r) => setTimeout(r, ms))
const keep = []
after(() => {
  for (const d of keep) cleanupSandbox(d)
  cleanupAllSandboxes()
})

async function post(port, path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })
}

describe("settings.host 覆盖 → 引擎 bases 端到端传播（P3-5）", () => {
  test("默认空串 → 引擎拿到空 bases（引擎侧回退默认上游）；写入 host 后 → 引擎拿到覆盖值", async () => {
    const stateDir = makeSandbox("wb-host-prop-").dir
    keep.push(stateDir)
    const engine = fakeEngine()
    const h = await startDaemon({
      key: "host-prop-key-0123456789abcdef",
      port: 0,
      stateDir,
      engine,
      noTimers: true,
      skipExistingCheck: true,
    })
    try {
      // 1) 未配置时：runnerCtx.bases 是全空串（= 引擎用默认上游），不是默认上游字面值
      const run1 = await post(h.port, "/api/run", { uids: [UID] })
      assert.equal(run1.status, 200)
      await tick()
      assert.deepEqual(engine.seenBases[0], { chat: "", bill: "", web: "" }, "默认 bases 全空串（回退语义在引擎侧）")

      // 2) POST /api/settings 写 host：响应回显生效值；settings.json 原样落盘
      const CUSTOM = {
        chat: "https://chat-proxy.example.test",
        bill: "https://bill-proxy.example.test",
        web: "https://web-proxy.example.test",
      }
      const setRes = await post(h.port, "/api/settings", { host: CUSTOM })
      assert.equal(setRes.status, 200)
      const setBody = await setRes.json()
      assert.deepEqual(setBody.host, CUSTOM, "设置响应回显覆盖后的 host（无默认值回填）")
      const persisted = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8"))
      assert.deepEqual(persisted.host, CUSTOM, "settings.json 原样落盘（自建反代正当，无白名单/无改写）")

      // 3) 下一次 job：引擎实际拿到覆盖后的 bases（不是默认上游、不是空串）
      await tick(80) // 等第一个假 job 自然结束，让 /api/run 的 409 闸放开
      const run2 = await post(h.port, "/api/run", { uids: [UID] })
      assert.equal(run2.status, 200)
      await tick()
      assert.deepEqual(engine.seenBases[1], CUSTOM, `引擎必须拿到覆盖后的 bases，实际 ${JSON.stringify(engine.seenBases[1])}`)

      // 4) /api/state 的 settings.host 回显生效值
      const st = await (await fetch(`http://127.0.0.1:${h.port}/api/state`)).json()
      assert.deepEqual(st.settings.host, CUSTOM)
    } finally {
      await h.stop()
    }
  })

  test("写空串 = 回到引擎默认上游语义；带端口/路径的自定义反代地址原样透传（无校验）", async () => {
    const stateDir = makeSandbox("wb-host-prop2-").dir
    keep.push(stateDir)
    const engine = fakeEngine()
    const h = await startDaemon({
      key: "host-prop2-key-0123456789abcdef",
      port: 0,
      stateDir,
      engine,
      noTimers: true,
      skipExistingCheck: true,
    })
    try {
      // 自建反代常见形态：带端口甚至带路径前缀 —— host 允许任意字符串（trim 后），
      // 绝不因「看起来不像官方域名」被拒。
      const custom = { chat: "https://my-proxy.internal:8443/api", bill: "", web: "http://127.0.0.1:9000" }
      const setRes = await post(h.port, "/api/settings", { host: custom })
      assert.equal(setRes.status, 200)
      const setBody = await setRes.json()
      assert.equal(setBody.host.chat, "https://my-proxy.internal:8443/api")
      assert.equal(setBody.host.bill, "https://www.codebuddy.cn", "空串回显 = 生效值（engine/upstream 默认）")
      assert.equal(setBody.host.web, "http://127.0.0.1:9000")

      await tick(60)
      const run = await post(h.port, "/api/run", { uids: [UID] })
      assert.equal(run.status, 200)
      await tick()
      assert.equal(
        engine.seenBases.at(-1).chat,
        "https://my-proxy.internal:8443/api",
        "引擎拿到的是写入值本身（含端口/路径，未改写）",
      )
      assert.equal(engine.seenBases.at(-1).bill, "", "bill 留空 → 引擎收到空串（默认上游语义不变）")
    } finally {
      await h.stop()
    }
  })
})

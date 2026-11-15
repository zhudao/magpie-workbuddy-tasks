// tests-shell/upstream-gap-floor.test.mjs —— /api/settings 的 gapMs 写入下限 = 红线（node --test）。
//
// 背景：POST /api/settings 的 gapMs 下限旧版只到 500，而实际生效的上游间距被
// daemon 的 upstreamGapMs() 兜底抬到 ≥1000ms —— 旋钮能设的与实际生效的不一致
// （面板承诺 500、内部悄悄改写，属于骗人）。修复：写入下限抬到
// MIN_UPSTREAM_GAP_MS(1000)（engine/constants.mjs），上限 10000 不变。
//
// 本文件用 tests-shell 的既有 harness 口径（fake engine + 真实 daemon + 真实
// HTTP，照 tests-shell/daemon.test.mjs 的 boot/post 写法）钉死写入语义：
//   · 传 500 / 999 → 落盘与回读都是 1000（下限抬线，回读值 = 生效值）；
//   · 传 1000（边界）/ 2000 / 10000（上限）→ 原样生效；
//   · 传 20000 → 10000（上限不封顶到更高）；
//   · 非有限数值 → 忽略该键（旧行为），已存的值不动。
// 「500 也要在实际执行层 ≥1000ms」的行为回归在 tests/upstream-gap-floor.test.mjs
//（假时钟，确定性间隔断言）；这里只管 HTTP 写入/回读/落盘一致。

import { test, after } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { startDaemon } from "../daemon.mjs"
import { cleanupAllSandboxes, makeSandbox } from "../tests/helpers.mjs"

const KEY = "gap-floor-key-0123456789abcdef"

// 每条用例独占 temp 沙箱（node --test 并发隔离，与 tests-shell 其余文件同口径）；
// 正常路径用例内 cleanup，本文件末尾 after 兜底统一回收（helpers.mjs 卫生线）。
after(() => {
  cleanupAllSandboxes()
})

// 最小 fake engine（契约 §2 形状）：settings 路由不依赖引擎行为，只要 daemon
// 启动检查能过（store + runner 都在）且 /api/state 可投影账号列表。
function fakeEngine() {
  return {
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
    runner: {
      JobRunner: class JobRunner {
        constructor(ctx) {
          this.ctx = ctx
        }
        start() {
          return null
        }
        get() {
          return null
        }
        current() {
          return null
        }
      },
    },
    errors: [],
    ok: true,
  }
}

async function boot(extraSettings = {}) {
  const sb = makeSandbox("wb-tasks-gapfloor-shell-")
  const h = await startDaemon({
    key: KEY,
    port: 0,
    stateDir: sb.dir,
    engine: fakeEngine(),
    noTimers: true,
    skipExistingCheck: true,
  })
  return { h, sb, stateDir: sb.dir, extraSettings }
}

const base = (port) => `http://127.0.0.1:${port}`
const post = (port, path, body) =>
  fetch(base(port) + path, {
    method: "POST",
    headers: { authorization: `Bearer ${KEY}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
const get = (port, path) => fetch(base(port) + path, { headers: { authorization: `Bearer ${KEY}` } })

// 回读口径：POST 响应（= 落盘后的完整 settings）+ 磁盘上的 settings.json + 
// GET /api/state 的 settings 投影，三处必须一致（「能设的 = 实际生效的」）。
async function postGapMsAndReadBack(h, stateDir, gapMs) {
  const res = await post(h.port, "/api/settings", gapMs === undefined ? undefined : { gapMs })
  assert.equal(res.status, 200)
  const body = await res.json()
  const onDisk = JSON.parse(readFileSync(join(stateDir, "settings.json"), "utf8"))
  const state = await (await get(h.port, "/api/state")).json()
  return {
    echoed: body.gapMs,
    persisted: onDisk.gapMs,
    projected: state.settings?.gapMs,
  }
}

test("写入下限：POST gapMs=500（旧旋钮还收的值）→ 回读/落盘/state 投影都是 1000", async () => {
  const { h, sb, stateDir } = await boot()
  try {
    const r = await postGapMsAndReadBack(h, stateDir, 500)
    for (const [what, v] of [["响应回读", r.echoed], ["settings.json 落盘", r.persisted], ["/api/state 投影", r.projected]]) {
      assert.ok(v >= 1000, `${what}的 gapMs 必须 ≥1000（面板能设的 = 实际生效的），实际 ${v}`)
    }
    assert.equal(r.echoed, 1000, "下限应恰为 MIN_UPSTREAM_GAP_MS=1000（不是回落默认 1500）")
    assert.equal(r.persisted, 1000)
  } finally {
    await h?.stop?.() // 先停 daemon（否则 HTTP server 挂着，node --test 进程不退出）
    sb.cleanup()
  }
})

test("写入下限边界：999 抬到 1000；1000（红线本身）原样收下", async () => {
  const { h, sb, stateDir } = await boot()
  try {
    const below = await postGapMsAndReadBack(h, stateDir, 999)
    assert.equal(below.echoed, 1000, "999 < 红线下限 → 抬到 1000")
    assert.equal(below.persisted, 1000)

    const exact = await postGapMsAndReadBack(h, stateDir, 1000)
    assert.equal(exact.echoed, 1000, "1000 = 红线下限 → 原样接受")
    assert.equal(exact.persisted, 1000)
  } finally {
    await h?.stop?.()
    sb.cleanup()
  }
})

test("正向与上限：2000 原样生效；10000 上限不变；20000 封顶到 10000", async () => {
  const { h, sb, stateDir } = await boot()
  try {
    const up = await postGapMsAndReadBack(h, stateDir, 2000)
    assert.equal(up.echoed, 2000, "调大必须原样生效（不许被吃掉）")
    assert.equal(up.persisted, 2000)

    const capEdge = await postGapMsAndReadBack(h, stateDir, 10000)
    assert.equal(capEdge.echoed, 10000, "上限 10000 不变")

    const over = await postGapMsAndReadBack(h, stateDir, 20000)
    assert.equal(over.echoed, 10000, "超上限封顶到 10000（旧行为不变）")
    assert.equal(over.persisted, 10000)
  } finally {
    await h?.stop?.()
    sb.cleanup()
  }
})

test("非有限数值忽略该键（旧行为）：已存的值不动", async () => {
  const { h, sb, stateDir } = await boot()
  try {
    // 先落一个确定值
    const first = await postGapMsAndReadBack(h, stateDir, 2000)
    assert.equal(first.echoed, 2000)
    // 非有限数值（字符串 "abc"）→ Number.isFinite(Number("abc")) = false → 忽略
    const bad = await postGapMsAndReadBack(h, stateDir, "abc")
    assert.equal(bad.echoed, 2000, "非法值必须忽略该键，已存 2000 不动")
    assert.equal(bad.persisted, 2000)
  } finally {
    await h?.stop?.()
    sb.cleanup()
  }
})

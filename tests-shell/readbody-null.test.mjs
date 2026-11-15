// tests-shell/readbody-null.test.mjs —— B7 回归：readBody 对 JSON 字面量 null 不归一。
//
// 缺陷：JSON.parse("null") 返回 null（text 非空、不触发 {} 兜底），随后
// body.uid / body.activityCode 一类属性读取抛 TypeError → 被最外层 catch 吞成
// 500「守护进程内部错误」—— 合法请求应按业务语义响应。
//
// 修法：readBody 把「解析结果是 null 或非对象」（数字/字符串/布尔）归一为 {}；
// **数组与对象原样返回** —— /api/accounts/import 接受裸数组 body
//（typeof [] === "object"），绝不能把数组吞成 {}。
//
// 测法说明（如实）：**行为断言**。真实 HTTP 请求打到本测试拉起的守护进程：
// 用「无可参与账号」的假引擎让 /api/run 的空 body 落在业务 400
//（WB_NO_ACCOUNTS）上 —— null 归一成 {} 后与显式 {} 完全同路径，若仍走旧代码
// 则是 500 TypeError；裸数组 import 用可导入的国内版行（tests/accountio-fixture
// 同款形状）预览成功，证明数组原样抵达 coerceImportRows。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { startDaemon } from "../daemon.mjs"
import { cleanupAllSandboxes, makeSandbox } from "../tests/helpers.mjs"
import { cnRow } from "../tests/accountio-fixture.mjs"

after(() => {
  cleanupAllSandboxes()
})

// 无账号引擎：/api/run 对任何 body 的业务终点都是 400（WB_NO_ACCOUNTS）。
// runner 必须存在（null 会先撞「引擎不可用」503，测不到账号检查）——注入一个
// 最小 runner 假件：start 永不被调用（startJob 在无账号检查处先抛），其余
// 方法按 daemon 各路由的可选访问给空实现。
function fakeEngine() {
  return {
    store: { loadAccounts: () => [], eligibleAccounts: () => [] },
    runner: null, // 真件经 boot() 的 opts.runner 注入
    tasks: null,
    upstream: null,
    errors: [],
    ok: true,
  }
}

const minimalRunner = {
  start: () => {
    throw new Error("startJob 在无账号检查处就该抛，不应走到 runner.start")
  },
  current: () => null,
  get: () => null,
  stop: () => null,
  holds: () => [],
  frozen: () => [],
  isFrozen: () => false,
  unfreeze: () => false,
}

async function boot(extra = {}) {
  return startDaemon({
    key: "readbody-null-test-key-0123456789",
    port: 0,
    stateDir: makeSandbox("wb-readbody-").dir,
    engine: fakeEngine(),
    runner: minimalRunner,
    noTimers: true,
    skipExistingCheck: true,
    ...extra,
  })
}

// 原文发送请求体（不做 JSON.stringify 包装，控制字面量形状）
const postRaw = (port, path, rawBody) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  })

describe("B7 JSON 字面量归一：null / 数字 / 字符串 / 布尔 → 按 {} 语义响应，绝不 500", () => {
  test("POST /api/run body=null → 400 没有可参与任务的账号（旧版 500 TypeError）", async () => {
    const h = await boot()
    try {
      const r = await postRaw(h.port, "/api/run", "null")
      const text = await r.text()
      assert.equal(r.status, 400, `应 400，实际 ${r.status}：${text}`)
      const j = JSON.parse(text)
      assert.match(j.error, /没有可参与任务的账号/)
      assert.ok(!j.error.includes("内部错误"), "不得落进最外层 500 兜底")
    } finally {
      await h.stop()
    }
  })

  test("其余非对象字面量同归一：42 / \"str\" / true → 400；显式 {} 完全等价", async () => {
    const h = await boot()
    try {
      for (const raw of ["42", '"str"', "true"]) {
        const r = await postRaw(h.port, "/api/run", raw)
        assert.equal(r.status, 400, `body=${raw} 应按 {} 语义得 400`)
        assert.match((await r.json()).error, /没有可参与任务的账号/)
      }
      const obj = await postRaw(h.port, "/api/run", "{}")
      assert.equal(obj.status, 400, "显式 {} 与 null 同一条业务路径（归一等价性）")
      assert.match((await obj.json()).error, /没有可参与任务的账号/)
    } finally {
      await h.stop()
    }
  })

  test("POST /api/task/claim body=null → 400 需要 uid 与 code（旧版 500）", async () => {
    const h = await boot()
    try {
      const r = await postRaw(h.port, "/api/task/claim", "null")
      assert.equal(r.status, 400)
      assert.deepEqual(await r.json(), { error: "需要 uid 与 code" })
    } finally {
      await h.stop()
    }
  })

  test("POST /api/accounts/import body=null → 400 无法读取账号文档（旧版 500）", async () => {
    const h = await boot()
    try {
      const r = await postRaw(h.port, "/api/accounts/import", "null")
      assert.equal(r.status, 400)
      const j = await r.json()
      assert.match(j.error, /无法读取账号文档/)
    } finally {
      await h.stop()
    }
  })
})

describe("B7 不伤合法用法：裸数组与对象 body 原样保留", () => {
  test("裸数组 import 预览仍走原路径：数组没被归一成 {}（旧形状下会是 400 not an account document）", async () => {
    const h = await boot()
    try {
      const row = cnRow({ uid: "u-import-null", expSec: Math.floor(Date.now() / 1000) + 3600 })
      const r = await postRaw(h.port, "/api/accounts/import", JSON.stringify([row]))
      const text = await r.text()
      assert.equal(r.status, 200, `裸数组应照旧预览成功：${text}`)
      const j = JSON.parse(text)
      assert.equal(j.wrote, false)
      assert.match(j.note, /预览/)
      assert.ok(j.preview.totals.adds >= 1, "行被识别为可新增（数组逐行抵达）")
    } finally {
      await h.stop()
    }
  })

  test("对象 body 照旧：/api/run 显式 legs 过滤后仍走业务语义", async () => {
    const h = await boot()
    try {
      const r = await postRaw(h.port, "/api/run", JSON.stringify({ legs: ["growth"], uids: ["u-x"] }))
      assert.equal(r.status, 400, "对象 body 不受归一影响（无账号仍 400）")
      assert.match((await r.json()).error, /没有可参与任务的账号/)
    } finally {
      await h.stop()
    }
  })
})

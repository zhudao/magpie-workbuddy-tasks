// tests-shell/static-traversal.test.mjs —— B5 回归：看板静态文件服务的穿越向量与畸形编码。
//
// 缺陷：
//   ① /%E0%A4%A 这类不完整 UTF-8 百分位序列让 decodeURIComponent 抛 URIError，
//     被最外层 catch 吞成 500「守护进程内部错误」—— 客户端输入错误应为 400；
//   ② 三套测试里没有一条穿越回归 —— 穿越防护（normalize+前缀兜底）本身有效，
//     但没有测试钉住，任何重构都可能悄悄退化。
//
// 实测语义（先跑一遍确认后钉死，全部六条向量统一 403、畸形编码 400）：
//   - WHATWG new URL 会把 "../"、"%2e%2e" 点段**原地规范化**掉、把 "//x" 解析成
//     协议相对地址（host 变 "x"）、"//" 直接抛 Invalid URL —— 所以 daemon 在
//     new URL **之前**对原始请求行做了一道预检（handler.unsafeRawStaticPath），
//     serveStatic 内另有解码后拒绝表 + normalize/前缀兜底（第二道闸）。
//   - `../`、`..\\` 两条字面向量也会被 URL 规范化吃掉，同理由原始请求行预检拦截。
//
// 测法：http.request 把请求行**逐字**发出（Node 客户端不做路径规范化，fetch/
// WHATWG 会先在客户端把 %2e%2e、../ 规范化掉，测不到服务端行为）——真实攻击
// 者裸写报文就是这个形状。零真实网络：本机 127.0.0.1 连自己的测试守护进程。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import { startDaemon } from "../daemon.mjs"
import { cleanupAllSandboxes, makeSandbox } from "../tests/helpers.mjs"

const KEY = "static-traversal-test-key-0123456789"

after(() => {
  cleanupAllSandboxes()
})

function fakeEngine() {
  return {
    store: { loadAccounts: () => [], eligibleAccounts: () => [] },
    runner: null,
    tasks: null,
    upstream: null,
    errors: [],
    ok: false,
  }
}

async function boot(extra = {}) {
  return startDaemon({
    key: KEY,
    port: 0,
    stateDir: makeSandbox("wb-traverse-").dir,
    engine: fakeEngine(),
    noTimers: true,
    skipExistingCheck: true,
    ...extra,
  })
}

// 原始请求：path 原样进请求行（http.request 不做规范化），拿回状态码与响应体
const rawGet = (port, path, method = "GET") =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method }, (res) => {
      const chunks = []
      res.on("data", (c) => chunks.push(c))
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }))
    })
    req.on("error", reject)
    req.end()
  })

describe("B5 穿越向量：统一 403（路径不合法），不再依赖肉眼检查 normalize/前缀兜底", () => {
  // 任务点名的六条向量 + 两条平台变体。全部断言 403（实现选定的语义：
  // 显式拒绝表命中 → 403「路径不合法」，不与 404 混用）。
  const vectors = [
    ["../", "/../style.css"],
    ["../（根级自身）", "/.."],
    ["%2e%2e", "/%2e%2e/style.css"],
    ["%2e%2e（根级自身）", "/%2e%2e"],
    ["..%2f", "/..%2fstyle.css"],
    ["..%5c（..\\ 编码形）", "/..%5cstyle.css"],
    ["..\\（字面反斜杠）", "/..\\style.css"],
    ["C:", "/C:/windows/win.ini"],
    ["C:（小写盘符）", "/c:/windows/win.ini"],
    ["//", "//style.css"],
    ["//（根级自身）", "//"],
  ]

  for (const [name, path] of vectors) {
    test(`向量 ${name} → 403`, async () => {
      const h = await boot()
      try {
        const r = await rawGet(h.port, path)
        assert.equal(r.status, 403, `GET ${JSON.stringify(path)} 应 403，实际 ${r.status}：${r.body.slice(0, 120)}`)
        const j = JSON.parse(r.body)
        assert.equal(j.error, "路径不合法")
      } finally {
        await h.stop()
      }
    })
  }

  test("绝对路径编码形（%2F 开头，绕过开头斜杠剥离）→ 403", async () => {
    const h = await boot()
    try {
      // decode 后为 "//app.js" 形状（绝对/协议相对），serveStatic 解码后拒绝表兜底
      const r = await rawGet(h.port, "/..%2f..%2fstyle.css")
      assert.equal(r.status, 403)
    } finally {
      await h.stop()
    }
  })
})

describe("B5 畸形编码：400（显式错误响应），不是 500「守护进程内部错误」", () => {
  test("不完整 UTF-8 序列 /%E0%A4%A → 400", async () => {
    const h = await boot()
    try {
      const r = await rawGet(h.port, "/%E0%A4%A")
      assert.equal(r.status, 400, `应 400，实际 ${r.status}：${r.body.slice(0, 120)}`)
      const j = JSON.parse(r.body)
      assert.equal(j.error, "URL 编码不合法")
      assert.ok(!r.body.includes("内部错误"), "不得落进最外层 500 兜底")
    } finally {
      await h.stop()
    }
  })

  test("孤立百分号 %zz → 400；坏编码不影响后续请求", async () => {
    const h = await boot()
    try {
      const r = await rawGet(h.port, "/%zzapp.js")
      assert.equal(r.status, 400)
      const ok = await rawGet(h.port, "/app.js")
      assert.equal(ok.status, 200, "坏请求不影响服务")
    } finally {
      await h.stop()
    }
  })
})

describe("B5 不伤及正常语义（正向与既有行为回归）", () => {
  test("/ 与 /app.js、/style.css 正常 200；未知文件仍 404", async () => {
    const h = await boot()
    try {
      const home = await rawGet(h.port, "/")
      assert.equal(home.status, 200)
      assert.ok(home.body.includes("WorkBuddy") || home.body.includes("<!doctype html>"), "首页/回退页正常")
      const app = await rawGet(h.port, "/app.js")
      assert.equal(app.status, 200, "看板资产正常服务")
      const style = await rawGet(h.port, "/style.css")
      assert.equal(style.status, 200, "样式表正常服务")
      const missing = await rawGet(h.port, "/no-such-asset.js")
      assert.equal(missing.status, 404, "普通 404 语义不变")
    } finally {
      await h.stop()
    }
  })

  test("POST 静态路径仍 405；/api/* 路由不做静态预检（API 行为不变）", async () => {
    const h = await boot()
    try {
      const post = await rawGet(h.port, "/", "POST")
      assert.equal(post.status, 405)

      const hello = await rawGet(h.port, "/api/hello")
      assert.equal(hello.status, 200)
      // API 路径里的坏编码维持旧语义：URL 原样进 handleApi → 404 未知 API
      //（API 路由只做字符串匹配、不碰文件系统，预检刻意不覆盖）
      const weirdApi = await rawGet(h.port, "/api/%E0%A4%A")
      assert.equal(weirdApi.status, 404)
      assert.ok(JSON.parse(weirdApi.body).error.includes("未知 API"))
    } finally {
      await h.stop()
    }
  })
})

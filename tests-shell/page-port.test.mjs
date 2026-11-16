// tests-shell/page-port.test.mjs —— magpie 沙箱入口卡（page/app.js）端口解析。
// node --test；零网络。
//
// 背景（issue #5）：守护进程健康在 8761（state/daemon.json），入口卡却一直给硬编码
// 的 4390。卡片跑在 sandbox="allow-scripts" + CSP connect-src 'none' 里，零网络、
// 读不到 daemon.json，也没有任何 magpie.read 权限 —— 端口唯一来源是插件选项 port。
// 这里钉住 resolvePort 的边界（须与后端 normalizePort 一致）与 ①②③④ 地址选择顺序。
//
// page/app.js 是经典 IIFE、不能被 import，所以用 node:vm 造最小 document/location/
// window 桩把它加载起来，再从 window.__wbPagePure 取纯函数断言。

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import vm from "node:vm"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "page", "app.js"), "utf8")

// 加载 page/app.js 到一个隔离的 vm 上下文，返回它挂出的纯函数集。
// document 桩让 start() 走「一切节点都取不到」的静态降级路径：不碰 DOM、不报错。
function loadPage({ hostname = "127.0.0.1" } = {}) {
  const noop = () => {}
  const document = {
    readyState: "complete", // 立即 start()；节点取到 null 即降级，setTimeout 也被桩成 no-op
    documentElement: { setAttribute: noop, removeAttribute: noop },
    addEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ setAttribute: noop, appendChild: noop, remove: noop, select: noop, value: "" }),
    body: { appendChild: noop },
  }
  const window = {}
  const sandbox = {
    window,
    document,
    location: { hostname, protocol: "http:", href: `http://${hostname}/_magpie/plugin/tok/` },
    navigator: {},
    URL,
    clearTimeout: noop,
    setTimeout: noop,
    console,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(SRC, sandbox, { filename: "page/app.js" })
  assert.ok(window.__wbPagePure, "page/app.js 必须挂出 window.__wbPagePure 纯函数集")
  return window.__wbPagePure
}

describe("resolvePort：端口来源与边界（与后端 normalizePort 一致）", () => {
  const { resolvePort } = loadPage()

  test("合法：number 或纯数字字符串、1–65535 整数 → 采用（字符串化）", () => {
    assert.equal(resolvePort({ port: "8761" }), "8761")
    assert.equal(resolvePort({ port: 8761 }), "8761")
    assert.equal(resolvePort({ port: "1" }), "1")
    assert.equal(resolvePort({ port: 1 }), "1")
    assert.equal(resolvePort({ port: "65535" }), "65535")
    assert.equal(resolvePort({ port: 65535 }), "65535")
    assert.equal(resolvePort({ port: "0004390" }), "4390", "前导零仍按数值归一")
    assert.equal(resolvePort({ port: " 8761" }), "8761", "与后端同口径：trim 后纯数字，前导空白合法")
    assert.equal(resolvePort({ port: "8761 " }), "8761", "与后端同口径：trim 后纯数字，尾部空白合法")
  })

  test("非法：空/缺省/0/负数/越界/小数/带尾巴/布尔/null → 回落 4390", () => {
    for (const bad of ["", "   ", undefined, null, 0, "0", -1, "-5", 65536, 70000, "70000", 4390.5, "4390.5", "4390abc", "abc", true, false, {}, []]) {
      assert.equal(resolvePort({ port: bad }), "4390", `port=${JSON.stringify(bad)} 必须回落 4390`)
    }
    assert.equal(resolvePort({}), "4390")
    assert.equal(resolvePort(undefined), "4390")
    assert.equal(resolvePort(null), "4390")
    assert.equal(resolvePort("8761"), "4390", "opts 不是对象时回落")
  })
})

describe("resolveDashboardUrl：①②③④ 顺序不变，仅 ②/④ 的端口来自解析结果", () => {
  test("① dashboardUrl 非回环 → 原样优先，port 不参与", () => {
    const { resolveDashboardUrl } = loadPage({ hostname: "192.0.2.10" })
    assert.equal(
      resolveDashboardUrl("http://nas.example.com:5000/", "8761"),
      "http://nas.example.com:5000/",
      "非回环的 dashboardUrl 整条覆盖，不被 port 改写",
    )
  })

  test("② 无回环 dashboardUrl 时按当前访问主机推导，端口用解析结果", () => {
    const { resolveDashboardUrl } = loadPage({ hostname: "192.0.2.10" })
    assert.equal(resolveDashboardUrl("", "8761"), "http://192.0.2.10:8761")
    assert.equal(resolveDashboardUrl("", "4390"), "http://192.0.2.10:4390")
  })

  test("③ dashboardUrl 是回环且带端口 → 用它（端口不被 port 覆盖）", () => {
    // ③ 只在 ② 不触发时才可见：当前访问主机也得是回环（否则推导出的非回环地址按 ② 胜出）
    const { resolveDashboardUrl } = loadPage({ hostname: "127.0.0.1" })
    assert.equal(resolveDashboardUrl("http://127.0.0.1:5000/", "8761"), "http://127.0.0.1:5000/")
    assert.equal(resolveDashboardUrl("http://localhost:5000/", "8761"), "http://localhost:5000/")
  })

  test("② 优先于 ③：非回环访问主机存在时，回环 dashboardUrl 让位给推导地址", () => {
    const { resolveDashboardUrl } = loadPage({ hostname: "192.0.2.10" })
    assert.equal(resolveDashboardUrl("http://127.0.0.1:5000/", "8761"), "http://192.0.2.10:8761")
  })

  test("④ 回环访问主机 + 无 dashboardUrl → 推导回环地址带解析端口；访问主机异常时兜底 127.0.0.1:<port>", () => {
    assert.equal(loadPage({ hostname: "127.0.0.1" }).resolveDashboardUrl("", "8761"), "http://127.0.0.1:8761")
    assert.equal(loadPage({ hostname: "" }).resolveDashboardUrl("", "8761"), "http://127.0.0.1:8761")
    assert.equal(loadPage({ hostname: "0.0.0.0" }).resolveDashboardUrl("", "8761"), "http://127.0.0.1:8761")
  })

  test("静态兜底（无宿主桥、无选项）仍是 4390，与改动前一致", () => {
    const { resolveDashboardUrl, resolvePort } = loadPage({ hostname: "127.0.0.1" })
    assert.equal(resolvePort(undefined), "4390")
    assert.equal(resolveDashboardUrl("", resolvePort(undefined)), "http://127.0.0.1:4390")
  })
})

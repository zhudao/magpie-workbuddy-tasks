// tests-shell/account-routes.test.mjs —— 账号导入/导出路由 + 免密钥口径自测（node --test）。
// 独立临时 cfg/state + 假 engine（store 用真实的 engine/store.mjs），零真实网络、
// 零真实凭据。口径见 docs/CONTRACT.md §3（免密钥 + 路由登记表）与 §9（导入导出）。

import { test, describe, after } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { startDaemon, routeNeedsKey, API_ROUTE_AUTH } from "../daemon.mjs"
import { eligibleAccounts, loadAccounts } from "../engine/store.mjs"
import { cnRow, makeJwt, nineEntryAuth } from "../tests/accountio-fixture.mjs"
import { cleanupAllSandboxes, makeSandbox } from "../tests/helpers.mjs"

const KEY = "account-routes-test-key-0123456789"

// 兜底：boot() 已在 cleanup() 里即删（finally 调用）；这里再兜一层 —— 个别用例
// 漏删时在文件收尾统一回收（每条用例独占沙箱是刻意的并发隔离）。
after(() => {
  cleanupAllSandboxes()
})
const NOW = new Date(2026, 9, 31, 12, 0, 0).getTime()
const DAY = 86400000
const expSecIn = (days) => Math.floor(NOW / 1000) + days * 86400
const sha256 = (s) => createHash("sha256").update(s).digest("hex")

// engine：store 用真实现（读临时 cfg 里的 plugin-auth.json），其余最小 fake
function realStoreEngine() {
  return {
    store: { loadAccounts: (cfg) => loadAccounts(cfg), eligibleAccounts },
    runner: null,
    tasks: null,
    upstream: null,
    errors: [],
    ok: true,
  }
}

async function boot({ authObj = null, authText = null } = {}) {
  const cfg = makeSandbox("wb-acct-routes-cfg-") // 每条用例独占 temp 沙箱，用完即删（见 helpers.mjs）
  const state = makeSandbox("wb-acct-routes-state-")
  if (authText !== null) writeFileSync(join(cfg.dir, "plugin-auth.json"), authText)
  else if (authObj) writeFileSync(join(cfg.dir, "plugin-auth.json"), JSON.stringify(authObj, null, 2) + "\n")
  const h = await startDaemon({
    key: KEY,
    port: 0,
    cfgDir: cfg.dir,
    stateDir: state.dir,
    engine: realStoreEngine(),
    now: () => NOW,
    noTimers: true,
    skipExistingCheck: true,
  })
  const authFile = join(cfg.dir, "plugin-auth.json")
  return {
    h,
    cfg: cfg.dir,
    state: state.dir,
    authFile,
    cleanup: () => {
      cfg.cleanup()
      state.cleanup()
    },
  }
}

const base = (port) => `http://127.0.0.1:${port}`
const get = (port, path, key) =>
  fetch(base(port) + path, { headers: key ? { authorization: `Bearer ${key}` } : {} })
const post = (port, path, body, key) =>
  fetch(base(port) + path, {
    method: "POST",
    headers: {
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

// ---- 免密钥登记表（routeNeedsKey 单元断言 + 全路由免密钥清单测试）-------------

describe("路由登记表（单一真相：routeNeedsKey 恒 false / API_ROUTE_AUTH 登记表）", () => {
  test("全路由免密钥清单：遍历登记表，任何路由、任何参数组合都不需要密钥", () => {
    assert.ok(Array.isArray(API_ROUTE_AUTH) && API_ROUTE_AUTH.length >= 16, "登记表齐全")
    for (const row of API_ROUTE_AUTH) {
      assert.equal(typeof row.method, "string")
      assert.ok(row.re instanceof RegExp, `${row.method} 路由必须有 re`)
      assert.equal(typeof row.path, "string")
      assert.ok(row.re.test(row.path), `登记表样例路径 ${row.path} 必须能被自己的 re 命中`)
      // 同一路由在无参 / secrets=1（含凭据导出）/ confirm=true（写盘导入）等
      // 一切参数组合下都不需要密钥 —— 用户明确要求「全部改成免密钥」
      assert.equal(routeNeedsKey(row.method, row.path), false, `${row.method} ${row.path} 不需要密钥`)
      assert.equal(routeNeedsKey(row.method, row.path, { secrets: "1", confirm: true }), false, `${row.method} ${row.path}（含凭据/写盘参数）不需要密钥`)
      assert.equal(routeNeedsKey(row.method, row.path, { secrets: "0", confirm: false }), false, `${row.method} ${row.path}（脱敏/预览参数）不需要密钥`)
    }
  })

  test("登记表覆盖全部已知路由（新增路由必须登记，清单测试才放行）", () => {
    const registered = API_ROUTE_AUTH.map((r) => `${r.method} ${r.path.split("?")[0]}`).sort()
    assert.deepEqual(registered, [
      "GET /api/accounts/export",
      "GET /api/credits",
      "GET /api/events",
      "GET /api/hello",
      "GET /api/history",
      "GET /api/jobs/job-1",
      "GET /api/state",
      "GET /api/streak",
      "POST /api/account/toggle",
      "POST /api/account/unfreeze",
      "POST /api/accounts",
      "POST /api/accounts/import",
      "POST /api/checkin",
      "POST /api/run",
      "POST /api/settings",
      "POST /api/shutdown",
      "POST /api/stop",
      "POST /api/streak/run",
      "POST /api/task/accept",
      "POST /api/task/claim",
    ])
  })

  test("未登记路由与旧密钥参数：一律放行（免密钥口径下没有「默认关死」这回事）", () => {
    assert.equal(routeNeedsKey("GET", "/api/whatever"), false)
    assert.equal(routeNeedsKey("POST", "/api/state"), false)
    assert.equal(routeNeedsKey("GET", "/api/accounts/export", { secrets: "whatever" }), false)
    assert.equal(routeNeedsKey("POST", "/api/accounts/import", { confirm: true }), false)
    // 旧的密钥参数语义已废弃：函数对参数完全无感（签名兼容保留）
    assert.equal(routeNeedsKey("GET", "/api/state"), false)
  })
})

// ---- HTTP 实测：无 key 全部可用、写操作按业务语义响应、脱敏路径拿不到 token ----

describe("免密钥口径 HTTP 实测", () => {
  test("只读路由无 key 全部可用（免密钥口径：不存在「需要密钥」这回事）", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      assert.equal((await get(env.h.port, "/api/hello")).status, 200)
      assert.equal((await get(env.h.port, "/api/state")).status, 200)
      assert.equal((await get(env.h.port, "/api/history")).status, 200)
      // 无密钥但资源不存在 → 404（不是 401）
      assert.equal((await get(env.h.port, "/api/jobs/nope")).status, 404)
      // 重扫本地文件无副作用（纯国内版口径：count 只算 provider==="workbuddy"）
      const rescan = await post(env.h.port, "/api/accounts", undefined, null)
      assert.equal(rescan.status, 200)
      const rescanBody = await rescan.json()
      assert.equal(rescanBody.count, 2, "count = 国内版 workbuddy* 条目（fixture 里 2 个 cn；3 条国际版不出现，qoder/qwenwork 系不算）")
      // 脱敏导出无需密钥
      assert.equal((await get(env.h.port, "/api/accounts/export?secrets=0")).status, 200)
      // 预览无需密钥（合法 blob）
      const preview = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [cnRow({ uid: "fresh-1", expSec: expSecIn(5) })] } }, null)
      assert.equal(preview.status, 200)
      assert.equal((await preview.json()).wrote, false)
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("写操作/凭据路由无 key 一律放行（业务语义响应，绝不 401；带旧密钥也照常）", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      // 业务成功类：无 key 直接可用
      assert.equal((await post(env.h.port, "/api/settings", { claim: true }, null)).status, 200)
      const toggle = await post(env.h.port, "/api/account/toggle", { uid: "cn-uid-a", tasksEnabled: true }, null)
      assert.equal(toggle.status, 200)
      assert.equal((await toggle.json()).uid, "cn-uid-a")
      const exp = await get(env.h.port, "/api/accounts/export?secrets=1")
      assert.equal(exp.status, 200, "含凭据的真值导出同样免密钥")
      const imp = await post(
        env.h.port,
        "/api/accounts/import",
        { blob: { accounts: [cnRow({ uid: "cn-fresh-nokey", expSec: expSecIn(5) })] }, confirm: true },
        null,
      )
      assert.equal(imp.status, 200)
      assert.equal((await imp.json()).wrote, true, "导入确认（写盘）免密钥可用")

      // 业务报错类：404（无 job）/ 404（未知 uid）/ 500（本测试引擎没有 tasks 模块）
      // ——都是有业务理由的非 401 响应
      assert.equal((await post(env.h.port, "/api/stop", undefined, null)).status, 404)
      const acceptRes = await post(env.h.port, "/api/task/accept", { uid: "ghost", codes: ["y"] }, null)
      assert.equal(acceptRes.status, 500, "引擎不可用按业务错误返回（非 401）")
      assert.match((await acceptRes.json()).error, /任务引擎不可用/)
      const ghostToggle = await post(env.h.port, "/api/account/toggle", { uid: "ghost", tasksEnabled: true }, null)
      assert.equal(ghostToggle.status, 404)
      // 国际版 uid 在纯国内版口径下「找不到」（与列表同源）
      const intlToggle = await post(env.h.port, "/api/account/toggle", { uid: "intl-uid-a", tasksEnabled: true }, null)
      assert.equal(intlToggle.status, 404, "国际版账号不在列表里，toggle 也找不到")

      // 带旧密钥（对/错都行）继续可用：平滑过渡，不报 400/401
      assert.equal((await post(env.h.port, "/api/settings", { claim: true }, "wrong-key")).status, 200)
      assert.equal((await get(env.h.port, "/api/accounts/export?secrets=1", "wrong-key")).status, 200)
      assert.equal((await get(env.h.port, "/api/accounts/export?secrets=1&k=whatever")).status, 200)
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("脱敏路径实测：secrets=0 与只读端点拿不到 token（逐个端点扫一遍）", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const before = JSON.parse(readFileSync(env.authFile, "utf8"))
      const secrets = Object.values(before)
        .map((e) => [e.access, e.refresh])
        .flat()
        .filter((v) => typeof v === "string" && v.length > 8)

      const maskedBodies = []
      maskedBodies.push(await (await get(env.h.port, "/api/state")).text())
      maskedBodies.push(await (await get(env.h.port, "/api/history")).text())
      maskedBodies.push(await (await get(env.h.port, "/api/accounts/export?secrets=0")).text())
      maskedBodies.push(await (await post(env.h.port, "/api/accounts", undefined, null)).text())
      maskedBodies.push(
        await (
          await post(env.h.port, "/api/accounts/import", {
            blob: { accounts: [cnRow({ uid: "cn-uid-a", expSec: expSecIn(5) })] }, // uid 撞现有 → skip，报告里也不该有 token
          }, null)
        ).text(),
      )
      const all = maskedBodies.join("\n")
      for (const s of secrets) {
        assert.ok(!all.includes(s), "脱敏/只读响应里绝不出现 token 值（铁律 2）")
      }
      assert.ok(!all.includes("eyJ"), "脱敏/只读响应里不出现 JWT 形状的串")
      // 脱敏导出的每一行都根本没有 token 字段（纯国内版口径：默认只出 cn）
      const maskedDoc = JSON.parse(maskedBodies[2])
      assert.equal(maskedDoc.count, 2)
      for (const row of maskedDoc.accounts) {
        assert.ok(!("accessToken" in row) && !("refreshToken" in row))
      }
      // 预览的 skip 报告也不含 token
      assert.ok(!maskedBodies[4].includes("eyJ"))
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })
})

// ---- 导出路由 -----------------------------------------------------------------

describe("GET /api/accounts/export（hub 语义 + 纯国内版默认）", () => {
  test("缺省（secrets=1，无 realm）：免密钥真值导出，且只含国内版", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const res = await get(env.h.port, "/api/accounts/export?secrets=1")
      assert.equal(res.status, 200)
      const doc = await res.json()
      assert.equal(doc.format, "workbuddy-accounts")
      assert.equal(doc.version, 1)
      assert.equal(doc.count, 2, "默认只导出国内版（fixture 里 2 个 cn；3 条国际版不出现）")
      assert.equal(doc.exportedAt, "2026-10-31 12:00:00")
      assert.deepEqual(
        doc.accounts.map((r) => r.realm),
        ["cn", "cn"],
      )
      assert.ok(!doc.accounts.some((r) => r.realm === "intl"), "国际版绝不混进默认导出")
      const cn = doc.accounts.find((r) => r.uid === "cn-uid-a")
      const raw = JSON.parse(readFileSync(env.authFile, "utf8"))
      assert.equal(cn.accessToken, raw.workbuddy.access, "access 真值")
      assert.equal(cn.refreshToken, raw.workbuddy.refresh, "refresh 真值")
      assert.equal(cn.expiresAt, Math.floor(raw.workbuddy.expires / 1000), "毫秒 → 秒")
      assert.equal(cn.realm, "cn")
      assert.equal(cn.nickname, "阿猫")
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("realm 过滤（默认 cn；显式 intl 才出国际版）/ uid 过滤 / download 文件名", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      // 不带 realm：只出 cn（纯国内版口径）
      const def = await (await get(env.h.port, "/api/accounts/export?secrets=0")).json()
      assert.deepEqual(def.accounts.map((r) => r.uid).sort(), ["cn-uid-a", "cn-uid-b"])

      // 显式 realm=intl：逃生口（hub 备份场景；UI 不提供）
      const intl = await (await get(env.h.port, "/api/accounts/export?realm=intl&secrets=0")).json()
      assert.deepEqual(intl.accounts.map((r) => r.realm), ["intl", "intl", "intl"])
      assert.deepEqual(intl.accounts.map((r) => r.uid).sort(), ["intl-uid-a", "intl-uid-b", "intl-uid-c"])

      // 逃生口配 secrets=1：国际版真值导出也只在显式请求时出现
      const intlSecret = await (await get(env.h.port, "/api/accounts/export?realm=intl&secrets=1")).json()
      assert.equal(intlSecret.count, 3)
      assert.ok(intlSecret.accounts.every((r) => typeof r.accessToken === "string" && r.accessToken.length > 8))

      const one = await get(env.h.port, "/api/accounts/export?uid=cn-uid-a&secrets=0&download=1")
      assert.equal(one.status, 200)
      assert.match(one.headers.get("content-disposition") ?? "", /^attachment; filename="workbuddy-accounts-cn-uid-a\d{8}-\d{6}\.json"$/)
      assert.equal(one.headers.get("cache-control"), "no-store")

      const multi = await get(env.h.port, "/api/accounts/export?realm=cn&download=1&secrets=0")
      assert.match(multi.headers.get("content-disposition") ?? "", /filename="workbuddy-accounts-cn-\d{8}-\d{6}\.json"/)

      const missing = await get(env.h.port, "/api/accounts/export?uid=ghost")
      assert.equal(missing.status, 404)
      assert.match((await missing.json()).error, /^no such account: ghost$/)

      // 国际版 uid 在默认（cn）范围里「不存在」；显式 realm=intl 才认
      const intlUid = await get(env.h.port, "/api/accounts/export?uid=intl-uid-a&secrets=0")
      assert.equal(intlUid.status, 404, "默认导出范围内国际版 uid 视为不存在")
      const intlUidOk = await get(env.h.port, "/api/accounts/export?realm=intl&uid=intl-uid-a&secrets=0")
      assert.equal(intlUidOk.status, 200)

      // 坏 realm 值 = 按默认处理（纯国内版口径：只出 cn）
      const weird = await (await get(env.h.port, "/api/accounts/export?realm=moon&secrets=0")).json()
      assert.equal(weird.count, 2)
      assert.ok(weird.accounts.every((r) => r.realm === "cn"))
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })
})

// ---- 导入路由（两段式 + 竞态 + 拒写）------------------------------------------

describe("POST /api/accounts/import（两段式）", () => {
  const freshRow = () => cnRow({ uid: "cn-new-9", nickname: "新号", expSec: expSecIn(9) })

  test("预览不写盘：文件字节不变、目录无新文件", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const beforeBytes = readFileSync(env.authFile, "utf8")
      const dirBefore = readdirSync(env.cfg).sort()
      const res = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] } }, null)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.wrote, false)
      assert.equal(body.note, "预览未写入任何文件")
      assert.equal(body.preview.totals.adds, 1)
      assert.equal(body.preview.adds[0].uid, "cn-new-9")
      assert.match(body.preview.adds[0].key, /^workbuddy#[0-9a-z]{6}$/)
      assert.equal(readFileSync(env.authFile, "utf8"), beforeBytes, "预览后文件逐字节不变")
      assert.deepEqual(readdirSync(env.cfg).sort(), dirBefore, "预览不产生任何新文件（含备份）")
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("确认才写盘：写官方字段、生成备份、needReload 提示、hub-imports 台账", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const beforeBytes = readFileSync(env.authFile, "utf8")
      // 先预览，再确认 —— 两步都不带任何密钥（免密钥口径）
      const pv = await (await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] } }, null)).json()
      assert.equal(pv.wrote, false)
      const res = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] }, confirm: true }, null)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.wrote, true)
      assert.equal(body.added.length, 1)
      assert.equal(body.added[0].uid, "cn-new-9")
      assert.equal(body.updated.length, 0)
      assert.match(body.backedUpTo, /^plugin-auth\.json\.bak-hubimport-\d{8}-\d{6}$/)
      assert.equal(body.needReload, true)
      assert.match(body.reloadHint, /插件管理/)
      // 备份 = 写入前字节
      assert.equal(readFileSync(join(env.cfg, body.backedUpTo), "utf8"), beforeBytes)
      // 新条目官方形状
      const before = JSON.parse(beforeBytes)
      const after = JSON.parse(readFileSync(env.authFile, "utf8"))
      const newKey = Object.keys(after).find((k) => !(k in before))
      assert.match(newKey, /^workbuddy#[0-9a-z]{6}$/)
      assert.equal(after[newKey].type, "oauth")
      assert.equal(after[newKey].accountId, "新号")
      assert.equal(after[newKey].expires, expSecIn(9) * 1000, "hub 秒 → magpie 毫秒")
      // 其它 9 条原样
      for (const k of Object.keys(before)) {
        assert.equal(JSON.stringify(after[k]), JSON.stringify(before[k]), `${k} 未被触碰`)
      }
      // 台账 + /api/state 的 imported 标记
      assert.ok(existsSync(join(env.state, "hub-imports.json")))
      const stateBody = await (await get(env.h.port, "/api/state", KEY)).json()
      const row = stateBody.accounts.find((a) => a.uid === "cn-new-9")
      assert.equal(row.imported, true)
      const untouched = stateBody.accounts.find((a) => a.uid === "cn-uid-a")
      assert.equal(untouched.imported, false)
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("智能合并经 HTTP：未过期 skip / 过期且更新 update（只动 token 三件套）", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      // cn-uid-a 未过期 → skip；cn-uid-b 置为过期 + 导入更新 → update
      const raw = JSON.parse(readFileSync(env.authFile, "utf8"))
      raw["workbuddy#3592pb"].expires = NOW - DAY
      writeFileSync(env.authFile, JSON.stringify(raw, null, 2) + "\n")
      const pv = (
        await (
          await post(env.h.port, "/api/accounts/import", {
            blob: {
              accounts: [
                cnRow({ uid: "cn-uid-a", expSec: expSecIn(1) }), // 现有未过期 → skip
                cnRow({ uid: "cn-uid-b", expSec: expSecIn(40) }),
              ],
            },
          }, null)
        ).json()
      ).preview
      assert.equal(pv.totals.skips, 1)
      assert.match(pv.skips[0].reason, /现有 token 未过期/)
      assert.equal(pv.totals.updates, 1)
      assert.equal(pv.updates[0].key, "workbuddy#3592pb")

      const res = await post(
        env.h.port,
        "/api/accounts/import",
        {
          blob: {
            accounts: [cnRow({ uid: "cn-uid-a", expSec: expSecIn(1) }), cnRow({ uid: "cn-uid-b", expSec: expSecIn(40) })],
          },
          confirm: true,
        },
        null,
      )
      const body = await res.json()
      assert.equal(body.wrote, true)
      assert.equal(body.updated.length, 1)
      assert.equal(body.skipped.length, 1)
      const after = JSON.parse(readFileSync(env.authFile, "utf8"))
      const row = after["workbuddy#3592pb"]
      assert.equal(row.expires, expSecIn(40) * 1000)
      assert.equal(row.accountId, "阿狗", "显示名不覆盖")
      assert.equal(row.access, cnRow({ uid: "cn-uid-b", expSec: expSecIn(40) }).accessToken)
      // 更新后 /api/state 的 imported 也亮（台账记了 update 的 key）
      const stateBody = await (await get(env.h.port, "/api/state", KEY)).json()
      assert.equal(stateBody.accounts.find((a) => a.uid === "cn-uid-b").imported, true)
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("国际版一律拒收：预览给出逐字 reason；确认 wrote:false 且零写盘", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const beforeBytes = readFileSync(env.authFile, "utf8")
      const intlRow = { ...cnRow({ uid: "intl-new", expSec: expSecIn(9) }), realm: "intl", accessToken: makeJwt({ sub: "intl-new", iss: "https://www.workbuddy.ai/oauth", expSec: expSecIn(9) }) }
      const pv = await (await post(env.h.port, "/api/accounts/import", { blob: { accounts: [intlRow] } }, null)).json()
      assert.equal(pv.preview.totals.rejects, 1)
      assert.equal(pv.preview.rejects[0].reason, "只同步国内版 workbuddy，国际版账号不导入")
      const res = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [intlRow] }, confirm: true }, null)
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.wrote, false)
      assert.equal(readFileSync(env.authFile, "utf8"), beforeBytes, "零写盘")
      assert.equal(readdirSync(env.cfg).filter((f) => f.includes(".bak-hubimport")).length, 0, "没有可写变更就不备份")
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("竞态守卫：预览后文件被改（magpie 刷新 token）→ 确认 409 要求重新预览", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const pv = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] } }, null)
      assert.equal(pv.status, 200)
      // 模拟 magpie 刷新：改文件
      const raw = JSON.parse(readFileSync(env.authFile, "utf8"))
      raw.workbuddy.expires = NOW + 5 * DAY
      writeFileSync(env.authFile, JSON.stringify(raw, null, 2) + "\n")
      const res = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] }, confirm: true }, null)
      assert.equal(res.status, 409)
      const body = await res.json()
      assert.equal(body.needRepreview, true)
      assert.match(body.error, /预览后发生了变化/)
      // 重新预览后再确认 → 成功
      await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] } }, null)
      const ok = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] }, confirm: true }, null)
      assert.equal(ok.status, 200)
      assert.equal((await ok.json()).wrote, true)
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("坏 JSON 拒写：预览与确认都 409，文件不动", async () => {
    const env = await boot({ authText: "{broken" })
    try {
      const pv = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] } }, null)
      assert.equal(pv.status, 409)
      assert.match((await pv.json()).error, /解析失败/)
      const cf = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] }, confirm: true }, null)
      assert.equal(cf.status, 409)
      assert.equal(readFileSync(env.authFile, "utf8"), "{broken")
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })

  test("错误分支：文档读不出 → 400；无可写变更的确认 → wrote:false 且无备份", async () => {
    const env = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
    try {
      const bad = await post(env.h.port, "/api/accounts/import", { blob: { hello: 1 } }, null)
      assert.equal(bad.status, 400)
      assert.match((await bad.json()).error, /无法读取账号文档/)

      const empty = await post(env.h.port, "/api/accounts/import", { blob: [] }, null)
      assert.equal(empty.status, 400)
      assert.match((await empty.json()).error, /no accounts found/)

      const none = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [freshRow()] }, confirm: true }, null)
      assert.equal(none.status, 200)
      assert.equal((await none.json()).wrote, true, "有效变更正常写")
      // 全 skip 的确认
      const env2 = await boot({ authObj: nineEntryAuth({ nowMs: NOW }) })
      try {
        const skipConfirm = await post(env.h.port, "/api/accounts/import", { blob: { accounts: [cnRow({ uid: "cn-uid-a", expSec: expSecIn(1) })] }, confirm: true }, null)
        assert.equal(skipConfirm.status, 200)
        const body = await skipConfirm.json()
        assert.equal(body.wrote, false)
        assert.match(body.note, /没有需要写入的变更/)
        assert.equal(body.backedUpTo, null)
      } finally {
        env2.cleanup()
        await env2.h.stop()
      }
    } finally {
      await env.h.stop()
      env.cleanup() // 先停 daemon 再删：避免在途异步写把目录重建出来
    }
  })
})

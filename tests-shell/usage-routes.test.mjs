// tests-shell/usage-routes.test.mjs —— GET /api/usage（B6 积分用量明细）路由与
// state/usage.json 缓存的守护进程回归（真实 daemon + 真实引擎 + 假时钟/假上游，
// 零真实网络）。
//
// 钉死（CONTRACT §3 /api/usage）：
//   1. uid 缺省 = 第一个可参与账号；未知 uid / API key 账号 → 404（同 /api/credits）；
//   2. days 限 1–90：缺省 7，0/91/abc → 400 且不打上游；
//   3. 首次 GET 拉取上游 → 200 {ok,uid,nickname,days,usage} 并原子写回
//      state/usage.json；响应里绝无 input/inputTrunc（prompt 原文，隐私红线）；
//   4. 缓存 < CREDITS_TTL_MS（10 分钟）且未 refresh → 直接回缓存，一次上游都不发；
//      TTL 过期重新拉取；refresh=1 强制拉取；**days 不同 = 没有对应缓存**（重新拉）；
//   5. /api/state 绝不顺带拉用量（只读投影原则：usage 只有显式请求才打上游）。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon, CREDITS_TTL_MS, API_ROUTE_AUTH } from "../daemon.mjs";
import { makeSandbox, cleanupAllSandboxes } from "../tests/helpers.mjs";

const DAEMON_KEY = "{{SECRET_usage0001}}";
const UID = "u-usage001";
const DAY = 86400000;
// 锚在确定的时刻：2026-11-15 17:00Z（北京 2026-11-16 01:00），窗口可复现。
const NOW = Date.UTC(2026, 10, 15, 17, 0, 0);
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dailyClock(startMs) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      await realSleep(Math.min(ms, 15));
    },
    advance: (ms) => {
      t += ms;
    },
    get time() {
      return t;
    },
  };
}
const clock = dailyClock(NOW);

// 假上游：用量行（带 input/inputTrunc —— 引擎必须丢弃）+ 最小 travel/status 应答
//（引擎缺省形状兜底用不到，这里只覆盖用量路径）。
function makeStub() {
  const calls = [];
  const rows = Array.from({ length: 12 }, (_, i) => ({
    requestId: `req-${i}`,
    credit: i + 1,
    model: i % 2 ? "glm-4.7" : "glm-5.2",
    client: "desktop",
    requestTime: `2026-11-1${4 + (i % 3)} 10:0${i % 10}:00`,
    agentPurpose: "conversation",
    appType: "cli",
    subscribeType: "pro",
    input: `prompt 原文 ${i}（绝不外泄）`,
    inputTrunc: `trunc ${i}`,
  }));
  const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ uid: init.headers?.["X-User-Id"] ?? "", path: u.pathname, host: u.host, at: clock.now() });
    if (u.pathname === "/billing/meter/get-user-request-usage") {
      // 真机外壳（2026-11-16 实测）：data.total + data.data[]（行数组）
      const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
      const pageNum = Number(body.pageNum ?? 1);
      const size = Number(body.pageSize ?? 100);
      return respond(200, {
        code: 0,
        data: { total: rows.length, data: rows.slice((pageNum - 1) * size, pageNum * size) },
      });
    }
    if (u.pathname === "/v2/activity/growth/tasks") return respond(200, { code: 0, data: { tasks: [] } });
    return respond(404, { code: -1, msg: "not found" });
  };
  return { calls, fetchImpl, rows };
}

const rootSb = makeSandbox("wb-tasks-usage-");
const root = rootSb.dir;
const cfgDir = join(root, "config");
const stateDir = join(cfgDir, "workbuddy-tasks", "state");
mkdirSync(stateDir, { recursive: true });
writeFileSync(
  join(cfgDir, "plugin-auth.json"),
  JSON.stringify({
    workbuddy: {
      type: "oauth",
      access: "wb-access-USAGE-001",
      refresh: "wb-refresh-USAGE-001",
      expires: NOW + 30 * DAY,
      accountId: "usage-acct",
      uid: UID,
      domain: "copilot.tencent.com",
      tokenType: "Bearer",
    },
    "workbuddy#apikey1": { type: "api", key: "ck_usage.abcdef", accountId: "usage-key" },
  }),
);
writeFileSync(join(cfgDir, "plugins.json"), JSON.stringify({ plugins: [{ spec: "github:me/magpie-workbuddy-tasks" }] }));
writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ scheduler: false }));

const daemonLogs = [];
let h = null;
let stub = makeStub();
const usageFile = join(stateDir, "usage.json");

const base = () => `http://127.0.0.1:${h.port}`;
const usageUrl = (uid, days, refresh) =>
  `${base()}/api/usage?${uid !== undefined ? `uid=${encodeURIComponent(uid)}&` : ""}${days !== undefined ? `days=${days}&` : ""}${refresh ? `refresh=${refresh}` : ""}`;

async function boot({ stubOverrides } = {}) {
  stub = stubOverrides ?? makeStub();
  return startDaemon({
    args: { cfg: cfgDir, state: stateDir, port: "0", key: DAEMON_KEY },
    now: clock.now,
    sleep: clock.sleep,
    fetch: stub.fetchImpl,
    log: (...a) => daemonLogs.push(a.join(" ")),
    noTimers: true,
    skipExistingCheck: true,
  });
}

after(async () => {
  try {
    await h?.stop();
  } catch {}
  cleanupAllSandboxes();
});

test("路由登记表包含 GET /api/usage（全路由免密钥口径）", () => {
  const row = API_ROUTE_AUTH.find((r) => r.path === "/api/usage");
  assert.ok(row, "/api/usage 已登记");
  assert.equal(row.method, "GET");
  assert.ok(row.re.test("/api/usage"));
});

test("首次 GET 拉取上游并写 state/usage.json；响应与落盘绝无 prompt 原文", async () => {
  // 本用例排在最前（缺省 days=7 的首次拉取 —— 此前没有任何上游调用，全局节流器
  // 的 last 为 null，updatedISO 才能精确断言到秒）
  h = await boot();
  const r = await fetch(usageUrl(UID, 7));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.uid, UID);
  assert.equal(j.nickname, "usage-acct");
  assert.equal(j.days, 7);
  assert.ok(j.usage, "usage 形状存在");
  assert.equal(j.usage.count, 12);
  assert.equal(j.usage.totalCredit, 78, "credit 1..12 求和");
  assert.equal(j.usage.days.length, 3, "北京日分桶（requestTime 覆盖 11-14/11-15/11-16 三天）");
  assert.equal(j.usage.models.length, 2, "模型聚合");
  assert.equal(j.usage.startTime, "2026-11-10 00:00:00", "days=7 → 北京今天(11-16)-(6)天 00:00:00");
  assert.equal(j.usage.endTime, "2026-11-16 01:00:00", "endTime = 北京的现在");
  assert.equal(j.usage.updatedISO, "2026-11-16 01:00:00");
  assert.equal(j.usage.models[0].model, "glm-4.7", "按 credit 降序（42 > 36）");
  assert.equal(j.usage.models[0].credit, 42);
  assert.ok(!JSON.stringify(j).includes("prompt 原文"), "响应绝不带 prompt 原文");
  assert.ok(!JSON.stringify(j).includes("inputTrunc"), "响应绝不带 inputTrunc");

  assert.ok(existsSync(usageFile), "usage.json 已落盘");
  const persisted = JSON.parse(readFileSync(usageFile, "utf8"));
  assert.equal(persisted[UID].days, 7);
  assert.ok(!JSON.stringify(persisted).includes("prompt 原文"), "落盘内容同样绝无 prompt 原文");
  assert.ok(Number(persisted[UID].updatedAt) > 0);
  // 上游调用：1 次用量（12 行 < pageSize 100 → 一页）
  assert.equal(stub.calls.filter((c) => c.path === "/billing/meter/get-user-request-usage").length, 1);
});

test("缺 uid → 第一个可参与账号；days 非法 → 400 且不打上游；未知/API key uid → 404", async () => {
  // 复用上一用例的守护进程（h 已在「首次 GET」用例 boot；这里不再另起，避免泄漏）
  const n0 = stub.calls.length;

  // days 非法：0 / 91 / abc —— 400 且零上游
  for (const days of ["0", "91", "abc", "7.5"]) {
    const r = await fetch(usageUrl(UID, days));
    assert.equal(r.status, 400, `days=${days} → 400`);
    const j = await r.json();
    assert.match(j.error, /1–90/);
  }
  assert.equal(stub.calls.length, n0, "参数校验失败绝不打上游");

  // 未知 uid / API key 账号 → 404（可参与口径与 /api/credits 一致）
  const r404 = await fetch(usageUrl("u-nosuch", 7));
  assert.equal(r404.status, 404);
  const st = await (await fetch(`${base()}/api/state`)).json();
  const keyRow = st.accounts.find((a) => a.masked.startsWith("API key"));
  const rKey = await fetch(usageUrl(keyRow.uid, 7));
  assert.equal(rKey.status, 404);
  assert.equal(stub.calls.length, n0, "404 都没打上游");

  // 缺 uid → 第一个可参与账号（这里只有一个 OAuth 账号）+ 缺省 days=7
  //（上一用例已写入 days=7 的 10 分钟新鲜缓存 → 这里直接回缓存，零上游）
  const r = await fetch(`${base()}/api/usage`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.uid, UID, "缺省第一个可参与账号");
  assert.equal(j.days, 7, "缺省 days=7");
  assert.equal(j.ok, true);
  assert.equal(stub.calls.length, n0, "缓存新鲜 → 不打上游");
});

test("TTL 内/不同 days/refresh=1 的缓存口径；/api/state 绝不顺带拉用量", async () => {
  const n0 = stub.calls.filter((c) => c.path === "/billing/meter/get-user-request-usage").length;

  // TTL 内同 days → 直接回缓存
  const r1 = await fetch(usageUrl(UID, 7));
  const j1 = await r1.json();
  assert.equal(j1.ok, true);
  assert.equal(stub.calls.filter((c) => c.path === "/billing/meter/get-user-request-usage").length, n0, "TTL 内一次上游都不发");

  // days 不同 = 没有对应缓存 → 重新拉
  const r2 = await fetch(usageUrl(UID, 3));
  const j2 = await r2.json();
  assert.equal(j2.ok, true);
  assert.equal(j2.days, 3);
  assert.equal(j2.usage.startTime, "2026-11-14 00:00:00", "days=3 窗口不同");
  assert.equal(stub.calls.filter((c) => c.path === "/billing/meter/get-user-request-usage").length, n0 + 1, "days 变了重新拉");

  // refresh=1 → 强制拉取（覆盖缓存）
  const r3 = await fetch(usageUrl(UID, 7, 1));
  const j3 = await r3.json();
  assert.equal(j3.ok, true);
  assert.equal(stub.calls.filter((c) => c.path === "/billing/meter/get-user-request-usage").length, n0 + 2, "refresh=1 强制拉取");

  // TTL 过期 → 重新拉取
  clock.advance(CREDITS_TTL_MS + 1);
  const r4 = await fetch(usageUrl(UID, 7));
  assert.equal(r4.status, 200);
  assert.equal(stub.calls.filter((c) => c.path === "/billing/meter/get-user-request-usage").length, n0 + 3, "TTL 过期重新拉取");

  // /api/state 绝不顺带拉用量（只有显式请求才打上游）
  const n5 = stub.calls.length;
  await (await fetch(`${base()}/api/state`)).json();
  assert.equal(stub.calls.length, n5, "/api/state 不打任何上游");
});

test("上游失败：200 {ok:false, needRelogin?}，旧缓存保留并带回", async () => {
  const before = JSON.parse(readFileSync(usageFile, "utf8"));
  await h.stop();
  // 只有用量路径回 401，其余照常
  const onlyUsage = makeStub();
  const inner = onlyUsage.fetchImpl;
  onlyUsage.fetchImpl = async (url, init = {}) => {
    if (new URL(url).pathname === "/billing/meter/get-user-request-usage") {
      return { status: 401, text: async () => JSON.stringify({ code: 12153, msg: "unauthorized" }) };
    }
    return inner(url, init);
  };
  h = await boot({ stubOverrides: onlyUsage });
  clock.advance(CREDITS_TTL_MS + 1); // 过期，强制走真拉取
  const r = await fetch(usageUrl(UID, 7, 1));
  assert.equal(r.status, 200, "上游失败也是 200（ok:false 表达）");
  const j = await r.json();
  assert.equal(j.ok, false);
  assert.equal(j.needRelogin, true);
  assert.ok(j.error);
  assert.deepEqual(j.usage, before[UID].summary, "旧缓存一并带回");
  const afterFetch = JSON.parse(readFileSync(usageFile, "utf8"));
  assert.deepEqual(afterFetch, before, "失败不清掉旧缓存");
});

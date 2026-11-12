// tests-shell/streak-routes.test.mjs —— 连登管家三条 HTTP 路由（CONTRACT §10.2）
// + state/streak.json 缓存 + 解冻路由的守护进程回归（真实 daemon + 真实引擎 +
// 假时钟/假上游，零真实网络）。
//
// 钉死：
//   1. GET /api/streak：首次拉上游（3 次 chat GET）→ 200 {uid, cached:false, streak}
//      并原子落盘 state/streak.json；TTL 内直接回缓存（零上游）；refresh=1 强制
//      拉取；job 在跑时 refresh=1 → 409 busy、无 refresh → 回缓存（哪怕已过期）；
//   2. POST /api/streak/run：缺省目标 = 未冻结 + tasksEnabled；执行结果
//      results[{uid, outcome, earned, message, detail}]；补签/兑换/抽奖真实发生；
//      显式点名冻结账号 → outcome failed +「恢复」提示；
//   3. POST /api/account/unfreeze：{uid}/{uids} 两种形状；missing = 本来就没冻结；
//      解冻后 frozen.json 清条目、账号回到缺省目标；
//   4. /api/state 投影：accounts[].streak 只读缓存（绝不为它打上游）、
//      accounts[].frozen、顶层 frozen 总览；
//   5. 三条新路由全部登记进 API_ROUTE_AUTH（全路由免密钥口径）。

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon, API_ROUTE_AUTH, CREDITS_TTL_MS } from "../daemon.mjs";
import { makeSandbox, cleanupAllSandboxes } from "../tests/helpers.mjs";

const DAEMON_KEY = "{{SECRET_streakroutes}}";
const DAY = 86400000;
// 锚在确定的北京正午：2026-10-15 12:00 北京 = 04:00Z（与本地时区无关）。
const NOW = Date.UTC(2026, 9, 15, 4, 0, 0);
const YESTERDAY = "2026-10-14"; // 北京昨日
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假时钟：拨表 + 让出事件循环（HTTP 请求能与引擎交错）
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

const UID_OK = "u-streak-ok";
const UID_FROZEN = "u-streak-frozen";

// ---- 假上游：连登三 GET + 四 POST + 最小任务应答 ------------------------
function makeStub() {
  const calls = [];
  const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const ok = (data) => respond(200, { code: 0, msg: "success", data });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const uid = init.headers?.["X-User-Id"] ?? "";
    calls.push({ uid, path: u.pathname, host: u.host, at: clock.now(), body: init.body ?? null });
    if (u.pathname === "/activity/growth/streak") {
      return ok({
        streak: { days: 6 },
        makeup_cards: { balance: 1 },
        redemption_status: { "7d": "available", "14d": "locked", "28d": "claimed" },
      });
    }
    if (u.pathname === "/activity/growth/heatmap") {
      return ok({ days: [{ date: YESTERDAY, score: 0 }] });
    }
    if (u.pathname === "/activity/growth/lottery/summary") return ok({ chances: 2 });
    if (u.pathname === "/activity/growth/makeup-cards/use") return ok({ days: 6 });
    if (u.pathname === "/activity/growth/redeem") return ok({ credit: 70 });
    if (u.pathname === "/activity/growth/lottery/draw") return ok({ name: "50 积分", credit: 50 });
    if (u.pathname === "/billing/meter/claim-gift") return ok({ name: "新手礼包", credit: 100 });
    // 补偿：业务拒绝（已领取过）→ 静默
    if (u.pathname === "/billing/meter/claim-compensation") return respond(200, { code: 2101, msg: "已领取过" });
    if (u.pathname === "/v2/activity/growth/tasks") return ok({ tasks: [] });
    if (u.pathname === "/v2/activity/growth/energy") return ok({ balance: 42 });
    return respond(404, { code: -1, msg: "not found" });
  };
  return { calls, fetchImpl };
}

// ---- 夹具 ---------------------------------------------------------------------
const rootSb = makeSandbox("wb-tasks-streak-routes-");
const root = rootSb.dir;
const cfgDir = join(root, "config");
const stateDir = join(cfgDir, "workbuddy-tasks", "state");
mkdirSync(stateDir, { recursive: true });
writeFileSync(
  join(cfgDir, "plugin-auth.json"),
  JSON.stringify({
    workbuddy: {
      type: "oauth",
      access: "wb-access-STREAK-01",
      refresh: "wb-refresh-STREAK-01",
      expires: NOW + 30 * DAY,
      accountId: "streak-cat",
      uid: UID_OK,
      domain: "copilot.tencent.com",
      tokenType: "Bearer",
    },
    "workbuddy#frozen": {
      type: "oauth",
      access: "wb-access-STREAK-02",
      refresh: "wb-refresh-STREAK-02",
      expires: NOW + 30 * DAY,
      accountId: "streak-owl",
      uid: UID_FROZEN,
      domain: "copilot.tencent.com",
      tokenType: "Bearer",
    },
  }),
);
writeFileSync(join(cfgDir, "plugins.json"), JSON.stringify({ plugins: [{ spec: "github:me/magpie-workbuddy-tasks" }] }));
writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ scheduler: false }));

const daemonLogs = [];
let stub = makeStub();
const streakFile = join(stateDir, "streak.json");
const frozenFile = join(stateDir, "frozen.json");

const base = () => `http://127.0.0.1:${h.port}`;
let h = null;

async function boot({ runner } = {}) {
  stub = makeStub();
  return startDaemon({
    args: { cfg: cfgDir, state: stateDir, port: "0", key: DAEMON_KEY },
    now: clock.now,
    sleep: clock.sleep,
    fetch: stub.fetchImpl,
    log: (...a) => daemonLogs.push(a.join(" ")),
    noTimers: true,
    skipExistingCheck: true,
    ...(runner ? { runner } : {}),
  });
}

after(async () => {
  try {
    await h?.stop();
  } catch {}
  cleanupAllSandboxes();
});

describe("路由登记与缓存口径", () => {
  test("三条新路由全部登记进 API_ROUTE_AUTH（免密钥登记表）", () => {
    for (const [method, path] of [
      ["GET", "/api/streak"],
      ["POST", "/api/streak/run"],
      ["POST", "/api/account/unfreeze"],
    ]) {
      const row = API_ROUTE_AUTH.find((r) => r.path === path);
      assert.ok(row, `${path} 已登记`);
      assert.equal(row.method, method);
      assert.ok(row.re.test(path));
    }
  });

  test("GET /api/streak 首次拉取：3 次 chat GET、cached:false、落盘 streak.json", async () => {
    h = await boot();
    const r = await fetch(`${base()}/api/streak?uid=${UID_OK}`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.uid, UID_OK);
    assert.equal(j.cached, false);
    assert.equal(j.streak.days, 6);
    assert.equal(j.streak.makeupCards, 1);
    assert.equal(j.streak.lotteryChances, 2);
    assert.deepEqual(j.streak.heatmap, [{ date: YESTERDAY, score: 0 }]);
    assert.deepEqual(j.streak.tiers, [
      { tier: "7d", status: "available" },
      { tier: "14d", status: "locked" },
      { tier: "28d", status: "claimed" },
    ]);
    assert.ok(Number.isFinite(Date.parse(j.streak.updatedISO)));
    assert.equal(stub.calls.length, 3, "恰好 3 次上游（streak/heatmap/lottery）");
    assert.ok(stub.calls.every((c) => c.host === "copilot.tencent.com" && c.uid === UID_OK));

    assert.ok(existsSync(streakFile), "streak.json 已落盘");
    const persisted = JSON.parse(readFileSync(streakFile, "utf8"));
    assert.deepEqual(persisted[UID_OK], j.streak, "落盘内容 = 响应里的 streak");
  });

  test("TTL 内直接回缓存（零上游）；refresh=1 强制拉取；TTL 过期重新拉取", async () => {
    const n0 = stub.calls.length;
    const j1 = await (await fetch(`${base()}/api/streak?uid=${UID_OK}`)).json();
    assert.equal(j1.cached, true);
    assert.equal(stub.calls.length, n0, "TTL 内一次上游都不发");

    const n1 = stub.calls.length;
    const j2 = await (await fetch(`${base()}/api/streak?uid=${UID_OK}&refresh=1`)).json();
    assert.equal(j2.cached, false);
    assert.equal(stub.calls.length, n1 + 3, "refresh=1 强制重新拉取");

    clock.advance(CREDITS_TTL_MS + 1);
    const n2 = stub.calls.length;
    const j3 = await (await fetch(`${base()}/api/streak?uid=${UID_OK}`)).json();
    assert.equal(j3.cached, false, "TTL 过期 → 重新拉取");
    assert.equal(stub.calls.length, n2 + 3);
  });

  test("job 在跑：refresh=1 → 409 busy；无 refresh → 回缓存（哪怕已过期）", async () => {
    await h.stop();
    // 预置一份已过期的缓存（updatedISO = NOW - TTL - 1）
    const stale = {
      days: 1, makeupCards: 0, lotteryChances: 0, heatmap: [],
      tiers: [{ tier: "7d", status: "" }, { tier: "14d", status: "" }, { tier: "28d", status: "" }],
      updatedISO: new Date(NOW - CREDITS_TTL_MS - 1).toISOString(),
    };
    writeFileSync(streakFile, JSON.stringify({ [UID_OK]: stale }));
    let h2 = null;
    try {
      stub = makeStub();
      h2 = await startDaemon({
        args: { cfg: cfgDir, state: stateDir, port: "0", key: DAEMON_KEY },
        now: clock.now,
        sleep: clock.sleep,
        fetch: stub.fetchImpl,
        log: (...a) => daemonLogs.push(a.join(" ")),
        noTimers: true,
        skipExistingCheck: true,
        runner: { current: () => ({ id: "job-busy" }) },
      });
      const b = `http://127.0.0.1:${h2.port}`;
      const r1 = await fetch(`${b}/api/streak?uid=${UID_OK}&refresh=1`);
      assert.equal(r1.status, 409, "refresh=1 且 busy → 409");
      assert.deepEqual(await r1.json(), { error: "busy" });
      assert.equal(stub.calls.length, 0);

      const r2 = await fetch(`${b}/api/streak?uid=${UID_OK}`);
      assert.equal(r2.status, 200, "有过期缓存且未 refresh → 直接回缓存");
      const j2 = await r2.json();
      assert.equal(j2.cached, true);
      assert.deepEqual(j2.streak, stale, "旧缓存原样带回");
      assert.equal(stub.calls.length, 0);
    } finally {
      try {
        await h2?.stop();
      } catch {}
    }
    h = await boot(); // 恢复主实例
  });

  test("GET /api/streak：缺 uid → 400；未知/企业号/停用账号 → 404；/api/state 投影缓存", async () => {
    const r0 = await fetch(`${base()}/api/streak`);
    assert.equal(r0.status, 400);
    const r404 = await fetch(`${base()}/api/streak?uid=u-nosuch`);
    assert.equal(r404.status, 404);
    assert.equal(stub.calls.filter((c) => c.uid === "u-nosuch").length, 0, "404 不打上游");

    // /api/state 的 accounts[].streak 只读投影（不为它打上游）
    // /api/state 的 accounts[].streak 只读投影（不为它打上游）。先强制拉一次
    //（上一条用例预置过过期缓存，投影只认缓存内容）
    await fetch(`${base()}/api/streak?uid=${UID_OK}&refresh=1`);
    const n = stub.calls.length;
    const st = await (await fetch(`${base()}/api/state`)).json();
    const row = st.accounts.find((a) => a.uid === UID_OK);
    assert.ok(row.streak && row.streak.days === 6, "state 投影 streak 缓存");
    assert.equal(stub.calls.length, n, "/api/state 没有打上游");
    assert.equal(row.frozen, null, "未冻结账号 frozen 为 null");
  });
});

describe("POST /api/streak/run 与解冻", () => {
  test("缺省目标跑全部未冻结账号：补签/礼包/兑换/抽奖，detail 形状完整", async () => {
    // 预置冻结台账（模拟先前 403/11140 冻结了第二个账号）—— 缺省目标必须排除它
    writeFileSync(
      frozenFile,
      JSON.stringify({ [UID_FROZEN]: { at: new Date(NOW).toISOString(), code: 11140, message: "request illegal" } }),
    );
    await h.stop();
    h = await boot();
    const r = await fetch(`${base()}/api/streak/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
    const results = await r.json();
    assert.deepEqual(
      results.map((x) => x.uid),
      [UID_OK],
      "冻结账号不进缺省目标",
    );
    const okRow = results[0];
    assert.equal(okRow.outcome, "ok");
    assert.equal(okRow.detail.days, 6);
    assert.equal(okRow.detail.makeupUsed, true);
    assert.equal(okRow.detail.makeupDate, YESTERDAY);
    assert.deepEqual(okRow.detail.redeemed, ["7d"]);
    assert.equal(okRow.detail.drawn, 2);
    assert.deepEqual(okRow.detail.gifts, [{ name: "新手礼包", credit: 100 }]);
    // 收益：礼包 100 + 兑换 70 + 抽奖 2×50 = 270
    assert.equal(okRow.earned, 270);
    assert.match(okRow.message, /连登 6 天/);
    // 上游确实发生：1 补签 + 2 礼包 + 1 兑换 + 2 抽奖
    const paths = stub.calls.map((c) => c.path);
    assert.equal(paths.filter((p) => p === "/activity/growth/makeup-cards/use").length, 1);
    assert.equal(
      paths.filter((p) => p.startsWith("/billing/meter/claim-")).length,
      2,
      "礼包与补偿都尝试（拒绝静默）",
    );
    assert.equal(paths.filter((p) => p === "/activity/growth/redeem").length, 1);
    assert.equal(paths.filter((p) => p === "/activity/growth/lottery/draw").length, 2);
  });

  test("显式点名冻结账号 → failed +「恢复」提示；解冻后回到缺省目标", async () => {
    const n0 = stub.calls.length;
    const r = await fetch(`${base()}/api/streak/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uids: [UID_FROZEN] }),
    });
    const results = await r.json();
    assert.equal(results[0].uid, UID_FROZEN);
    assert.equal(results[0].outcome, "failed", "显式指定的冻结账号如实失败");
    assert.match(results[0].message, /账号已冻结/);
    assert.match(results[0].message, /恢复/);
    assert.equal(stub.calls.length, n0, "冻结账号一个上游都不发");

    // /api/state：accounts[].frozen + 顶层 frozen 总览（昵称拼接）
    const st = await (await fetch(`${base()}/api/state`)).json();
    assert.deepEqual(st.accounts.find((a) => a.uid === UID_FROZEN).frozen, {
      at: new Date(NOW).toISOString(),
      code: 11140,
      message: "request illegal",
    });
    assert.equal(st.frozen.length, 1);
    assert.equal(st.frozen[0].uid, UID_FROZEN);
    assert.equal(st.frozen[0].nickname, "streak-owl");
    assert.equal(st.frozen[0].code, 11140);

    // 解冻：missing 报告没冻结的，unfrozen 报告真的解了的
    const uf = await fetch(`${base()}/api/account/unfreeze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uids: [UID_FROZEN, "u-never-frozen"] }),
    });
    assert.equal(uf.status, 200);
    const ufBody = await uf.json();
    assert.deepEqual(ufBody, { ok: true, unfrozen: [UID_FROZEN], missing: ["u-never-frozen"] });
    const frozenOnDisk = JSON.parse(readFileSync(frozenFile, "utf8"));
    assert.ok(!(UID_FROZEN in frozenOnDisk), "frozen.json 的条目已删");
    const st2 = await (await fetch(`${base()}/api/state`)).json();
    assert.deepEqual(st2.frozen, [], "顶层冻结总览清空");
    assert.equal(st2.accounts.find((a) => a.uid === UID_FROZEN).frozen, null);

    // 解冻后回到缺省目标：缺省 streak/run 不再报「已冻结」
    const r2 = await fetch(`${base()}/api/streak/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const results2 = await r2.json();
    assert.ok(results2.some((x) => x.uid === UID_FROZEN && x.outcome !== "failed"), "解冻账号回到缺省目标");
  });

  test("单 uid 形状解冻 + 重复解冻进 missing；缺参数 400", async () => {
    const uf1 = await fetch(`${base()}/api/account/unfreeze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid: UID_FROZEN }),
    });
    assert.equal(uf1.status, 200);
    assert.deepEqual(await uf1.json(), { ok: true, unfrozen: [], missing: [UID_FROZEN] }, "已解冻 → missing");
    const bad = await fetch(`${base()}/api/account/unfreeze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(bad.status, 400);
  });
});

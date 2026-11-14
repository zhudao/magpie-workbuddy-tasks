// tests-shell/campaign-routes.test.mjs —— 运营活动任务三条 HTTP 路由
//（GET /api/campaign、POST /api/campaign/run §11.1、POST /api/campaign/claim
// §11.6）+ state/campaign.json 缓存 + /api/state 只读投影的守护进程回归
//（真实 daemon + 真实引擎 + 假时钟/假上游，零真实网络）。缓存与节流口径镜像
// /api/streak（streak-routes.test.mjs 同款手法）。
//
// 钉死：
//   1. 三条路由登记进 API_ROUTE_AUTH（全路由免密钥）；
//   2. GET /api/campaign：首次拉上游 → 200 {uid, cached:false, campaign} 并原子落盘；
//      TTL 内直接回缓存（零上游）；refresh=1 强制拉取；job 在跑时 refresh=1 →
//      409 busy、无 refresh → 回缓存（哪怕已过期）；
//   3. POST /api/campaign/run：缺省目标 = 未冻结 + tasksEnabled；
//      results[{uid, outcome, earned, message, detail{activities, claimed, unavailable}}]；
//      领奖真实发生（claimed_at 回读）；显式点名冻结账号 → failed +「恢复」提示；
//   4. POST /api/campaign/claim（§11.6 第 3 条）：{uid, activityCode, taskCode}
//      缺一 → 400；200 形状与 /api/task/claim 对齐（{ok, credit, energy, via,
//      reason}）；账号找不到 = /api/task/claim 同口径（500 +「找不到账号」）；
//      冻结账号如实失败（§10.5 文案、零上游）；
//   5. /api/state 投影：accounts[].campaign 只读缓存（绝不为它打上游）。

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon, API_ROUTE_AUTH, CREDITS_TTL_MS } from "../daemon.mjs";
import { makeSandbox, cleanupAllSandboxes } from "../tests/helpers.mjs";

const DAEMON_KEY = "{{SECRET_campaignroutes}}";
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 13, 4, 0, 0);
const RECEIPT_ISO = "2026-11-13T00:00:00Z";
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

const UID_OK = "u-campaign-ok";
const UID_FROZEN = "u-campaign-frozen";

// ---- 假上游：活动 portal 两端点 + MP/桌面事件上报 + 专家市场 + 最小成长应答 -------
function makeStub() {
  const calls = [];
  const completed = new Set();
  const claimed = new Set();
  const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });

  const payloadFor = (campaign) =>
    campaign === "campaign_starbucks_2026"
      ? [
          { task_code: "ai_chat", target_count: 3, reward_credit: 100, need_view: true },
          { task_code: "expert", target_count: 1, reward_credit: 100, need_view: true },
          { task_code: "app", target_count: 1, reward_credit: 100, need_view: true },
        ]
      : [
          { task_code: "expert_chat", target_count: 1, reward_credit: 50, need_view: true },
          { task_code: "skill_use", target_count: 1, reward_credit: 50, need_view: true },
          { task_code: "desktop_same", target_count: 1, reward_credit: 100, need_view: true },
        ];

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = String(init.method || "GET").toUpperCase();
    const headers = init.headers ?? {};
    let body = null;
    if (typeof init.body === "string" && init.body.length) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ host: u.host, path: u.pathname, query: u.search, method, headers, body, at: clock.now() });

    if (u.pathname === "/portal/activity/tasks" && method === "GET") {
      const campaign = u.searchParams.get("activity_code") ?? "";
      const tasks = payloadFor(campaign);
      const progress = tasks
        .filter((t) => completed.has(t.task_code) || claimed.has(t.task_code))
        .map((t) => ({
          task_code: t.task_code,
          progress: t.target_count,
          completed_at: RECEIPT_ISO,
          claimed_at: claimed.has(t.task_code) ? RECEIPT_ISO : null,
        }));
      return respond(200, { code: 0, data: { tasks, progress } });
    }
    const viewMatch = /^\/portal\/activity\/tasks\/([^/]+)\/viewed$/.exec(u.pathname);
    if (viewMatch) return respond(200, { code: 0 });
    const claimMatch = /^\/portal\/activity\/tasks\/([^/]+)\/claim$/.exec(u.pathname);
    if (claimMatch) {
      const task = decodeURIComponent(claimMatch[1]);
      completed.add(task);
      claimed.add(task);
      return respond(200, { code: 0 });
    }
    if (u.pathname === "/v2/report") {
      const events = Array.isArray(body) ? body : [body];
      if (String(headers["X-Client-Product"] ?? "") === "workbuddy-mp") {
        for (const e of events) {
          const page = JSON.stringify({ pageURL: e.pageURL, pageName: e.pageName });
          if (e.eventCode === "chat_request_send") completed.add(page.includes("starbucks") ? "ai_chat" : "skill_use");
          if (e.eventCode === "expert_actual_use") completed.add(page.includes("starbucks") ? "expert" : "expert_chat");
        }
        return respond(200, { code: 0, data: {} });
      }
      for (const e of events) {
        if (e.eventCode === "playbook_prompt_send" && e.id === "cnb-content-calendar") completed.add("desktop_same");
      }
      return respond(200, { code: 0, data: {} });
    }
    if (u.pathname === "/v2/operation-platform/market/expert/list") {
      return respond(200, {
        code: 0,
        data: { experts: [{ expert_id: "ex_BackToSchool01", display_name_zh: { zh: "返校季讲解员" } }] },
      });
    }
    if (u.pathname === "/v2/activity/growth/tasks") return respond(200, { code: 0, data: { tasks: [] } });
    if (u.pathname === "/v2/activity/growth/energy") return respond(200, { code: 0, data: { balance: 42 } });
    if (u.pathname === "/activity/growth/streak") {
      return respond(200, { code: 0, data: { streak: { days: 0 }, makeup_cards: { balance: 0 }, redemption_status: {} } });
    }
    if (u.pathname === "/activity/growth/heatmap") return respond(200, { code: 0, data: { cells: [] } });
    if (u.pathname === "/activity/growth/lottery/summary") return respond(200, { code: 0, data: { chances: 0 } });
    if (u.pathname === "/v2/activity/growth/buddy/quota") {
      return respond(200, { code: 0, data: { affordable: 0, max_open_count: 1 } });
    }
    return respond(404, { code: -1, msg: "not found" });
  };

  return { calls, fetchImpl, completed, claimed };
}

// ---- 夹具 ---------------------------------------------------------------------
const rootSb = makeSandbox("wb-tasks-campaign-routes-");
const root = rootSb.dir;
const cfgDir = join(root, "config");
const stateDir = join(cfgDir, "workbuddy-tasks", "state");
mkdirSync(stateDir, { recursive: true });
writeFileSync(
  join(cfgDir, "plugin-auth.json"),
  JSON.stringify({
    workbuddy: {
      type: "oauth",
      access: "wb-access-CAMP-01",
      refresh: "wb-refresh-CAMP-01",
      expires: NOW + 30 * DAY,
      accountId: "campaign-cat",
      uid: UID_OK,
      domain: "copilot.tencent.com",
      tokenType: "Bearer",
    },
    "workbuddy#frozen": {
      type: "oauth",
      access: "wb-access-CAMP-02",
      refresh: "wb-refresh-CAMP-02",
      expires: NOW + 30 * DAY,
      accountId: "campaign-owl",
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
const campaignFile = join(stateDir, "campaign.json");
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

describe("路由登记与 GET 缓存口径", () => {
  test("三条路由全部登记进 API_ROUTE_AUTH（免密钥登记表）", () => {
    for (const [method, path] of [
      ["GET", "/api/campaign"],
      ["POST", "/api/campaign/run"],
      ["POST", "/api/campaign/claim"],
    ]) {
      const row = API_ROUTE_AUTH.find((r) => r.path === path);
      assert.ok(row, `${path} 已登记`);
      assert.equal(row.method, method);
      assert.ok(row.re.test(path));
    }
  });

  test("GET /api/campaign 首次拉取：cached:false、活动形状完整、落盘 campaign.json", async () => {
    h = await boot();
    const r = await fetch(`${base()}/api/campaign?uid=${UID_OK}`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.uid, UID_OK);
    assert.equal(j.cached, false);
    const st = j.campaign;
    assert.equal(st.ok, true);
    assert.ok(Number.isFinite(Date.parse(st.updatedISO)));
    assert.deepEqual(
      st.activities.map((a) => a.code),
      ["campaign_starbucks_2026", "campaign_reporter_2026"],
    );
    const star = st.activities[0];
    assert.equal(star.label, "星巴克协作");
    assert.equal(star.error, "");
    assert.equal(star.tasks.length, 3);
    const ai = star.tasks.find((t) => t.taskCode === "ai_chat");
    assert.equal(ai.kind, "chat");
    assert.equal(ai.target, 3);
    assert.equal(ai.credit, 100);
    assert.equal(ai.progress, 0);
    assert.equal(ai.completedAt, "");
    assert.equal(ai.claimedAt, "");
    assert.equal(ai.needView, true);
    assert.equal(star.claimable, 0);
    assert.equal(star.claimed, 0);
    assert.deepEqual(st.activities[1].page, {
      pageURL: "subpackages/journalist-benefit/index",
      pageName: "journalist_benefit",
    });
    // 恰好 2 次活动读取（每活动 1 次 GET），都打 codebuddy 域
    const reads = stub.calls.filter((c) => c.path === "/portal/activity/tasks" && c.method === "GET");
    assert.equal(reads.length, 2);
    assert.ok(reads.every((c) => c.host === "www.codebuddy.cn"));

    assert.ok(existsSync(campaignFile), "campaign.json 已落盘");
    const persisted = JSON.parse(readFileSync(campaignFile, "utf8"));
    assert.deepEqual(persisted[UID_OK], st, "落盘内容 = 响应里的 campaign");
  });

  test("TTL 内直接回缓存（零上游）；refresh=1 强制拉取；TTL 过期重新拉取", async () => {
    const n0 = stub.calls.length;
    const j1 = await (await fetch(`${base()}/api/campaign?uid=${UID_OK}`)).json();
    assert.equal(j1.cached, true);
    assert.equal(stub.calls.length, n0, "TTL 内一次上游都不发");

    const n1 = stub.calls.length;
    const j2 = await (await fetch(`${base()}/api/campaign?uid=${UID_OK}&refresh=1`)).json();
    assert.equal(j2.cached, false);
    assert.equal(stub.calls.length, n1 + 2, "refresh=1 强制重新拉取（每活动 1 次）");

    clock.advance(CREDITS_TTL_MS + 1);
    const n2 = stub.calls.length;
    const j3 = await (await fetch(`${base()}/api/campaign?uid=${UID_OK}`)).json();
    assert.equal(j3.cached, false, "TTL 过期 → 重新拉取");
    assert.equal(stub.calls.length, n2 + 2);
  });

  test("job 在跑：refresh=1 → 409 busy；无 refresh → 回缓存（哪怕已过期）", async () => {
    await h.stop();
    const stale = {
      ok: true,
      activities: [],
      updatedISO: new Date(NOW - CREDITS_TTL_MS - 1).toISOString(),
    };
    writeFileSync(campaignFile, JSON.stringify({ [UID_OK]: stale }));
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
      const r1 = await fetch(`${b}/api/campaign?uid=${UID_OK}&refresh=1`);
      assert.equal(r1.status, 409, "refresh=1 且 busy → 409");
      assert.deepEqual(await r1.json(), { error: "busy" });
      assert.equal(stub.calls.length, 0);

      const r2 = await fetch(`${b}/api/campaign?uid=${UID_OK}`);
      assert.equal(r2.status, 200, "有过期缓存且未 refresh → 直接回缓存");
      const j2 = await r2.json();
      assert.equal(j2.cached, true);
      assert.deepEqual(j2.campaign, stale, "旧缓存原样带回");
      assert.equal(stub.calls.length, 0);
    } finally {
      try {
        await h2?.stop();
      } catch {}
    }
    h = await boot(); // 恢复主实例
  });

  test("GET /api/campaign：缺 uid → 400；未知/停用账号 → 404 且不打上游", async () => {
    const r0 = await fetch(`${base()}/api/campaign`);
    assert.equal(r0.status, 400);
    const n = stub.calls.length;
    const r404 = await fetch(`${base()}/api/campaign?uid=u-nosuch`);
    assert.equal(r404.status, 404);
    assert.equal(stub.calls.length, n, "404 不打上游");
  });
});

describe("POST /api/campaign/run 与 /api/state 投影", () => {
  // 预置冻结台账（模拟先前 403/11140 冻结了第二个账号）——缺省目标必须排除它
  test("缺省目标跑全部未冻结账号：判据发射 + 领奖回执，detail 形状完整", async () => {
    writeFileSync(
      frozenFile,
      JSON.stringify({
        [UID_FROZEN]: { at: new Date(NOW).toISOString(), code: 11140, message: "request illegal" },
      }),
    );
    await h.stop();
    h = await boot();
    const r = await fetch(`${base()}/api/campaign/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 200);
    const results = await r.json();
    assert.deepEqual(results.map((x) => x.uid), [UID_OK], "冻结账号不进缺省目标");
    const row = results[0];
    assert.equal(row.outcome, "ok");
    assert.equal(row.earned, 400, "ai_chat 100 + expert 100 + expert_chat 50 + skill_use 50 + desktop_same 100");
    assert.match(row.message, /活动 2 项 · 已领 5/);
    assert.match(row.message, /\+400 积分/);
    const d = row.detail;
    assert.deepEqual(
      d.claimed.slice().sort(),
      ["ai_chat", "desktop_same", "expert", "expert_chat", "skill_use"],
      "app 只提示、不伪造、不领",
    );
    assert.deepEqual(d.unavailable, [], "两个活动都正常下发");
    assert.deepEqual(
      d.activities.map((a) => [a.code, a.viewed, a.fired, a.claimed]),
      [
        ["campaign_starbucks_2026", 3, 2, 2],
        ["campaign_reporter_2026", 3, 3, 3],
      ],
    );
    // viewed（6）与领奖（5）真实发生
    assert.equal(stub.calls.filter((c) => c.path.endsWith("/viewed")).length, 6);
    assert.equal(stub.calls.filter((c) => c.path.endsWith("/claim")).length, 5);
  });

  test("显式点名冻结账号 → failed +「恢复」提示；解冻后回到缺省目标", async () => {
    const n0 = stub.calls.length;
    const r = await fetch(`${base()}/api/campaign/run`, {
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

    // 解冻后回到缺省目标
    const uf = await fetch(`${base()}/api/account/unfreeze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uids: [UID_FROZEN] }),
    });
    assert.equal(uf.status, 200);
    const r2 = await fetch(`${base()}/api/campaign/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const results2 = await r2.json();
    assert.ok(results2.some((x) => x.uid === UID_FROZEN && x.outcome !== "failed"), "解冻账号回到缺省目标");
  });

  test("/api/state 投影：accounts[].campaign 只读缓存（绝不为它打上游）", async () => {
    // doCampaignRun 与 /api/streak/run 同款：不回写缓存 —— 显式 refresh 拉一次最新
    const j = await (await fetch(`${base()}/api/campaign?uid=${UID_OK}&refresh=1`)).json();
    assert.equal(j.cached, false);
    const n = stub.calls.length;
    const st = await (await fetch(`${base()}/api/state`)).json();
    const row = st.accounts.find((a) => a.uid === UID_OK);
    assert.ok(row.campaign && row.campaign.ok === true, "state 投影 campaign 缓存");
    assert.deepEqual(
      row.campaign.activities.map((a) => a.code),
      ["campaign_starbucks_2026", "campaign_reporter_2026"],
    );
    assert.ok(row.campaign.activities[0].tasks.some((t) => t.taskCode === "ai_chat" && t.claimedAt === RECEIPT_ISO));
    assert.equal(row.campaign.activities[0].claimed, 2);
    assert.equal(row.campaign.activities[0].claimable, 0);
    assert.equal(stub.calls.length, n, "/api/state 没有打上游");
    // 排程 hours 里 campaign 默认空、且键存在
    assert.deepEqual(st.settings.hours.campaign, []);
  });
});

describe("POST /api/campaign/claim（单条活动任务领奖，§11.6 第 3 条）", () => {
  // 新开一轮：重写冻结台账（UID_FROZEN 再次冻结）+ 全新假上游，并把星巴克
  // ai_chat 预置成「已达成（completed_at 在）、未领」——成功路径的真实素材。
  test("200 成功：回读 claimed_at 才算，credit 按 reward_credit 记账，形状与 /api/task/claim 对齐", async () => {
    writeFileSync(
      frozenFile,
      JSON.stringify({
        [UID_FROZEN]: { at: new Date(NOW).toISOString(), code: 11140, message: "request illegal" },
      }),
    );
    await h.stop();
    h = await boot();
    stub.completed.add("ai_chat");
    const n0 = stub.calls.length;
    const r = await fetch(`${base()}/api/campaign/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid: UID_OK, activityCode: "campaign_starbucks_2026", taskCode: "ai_chat" }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual(j, { ok: true, credit: 100, energy: 0, via: "", reason: "" }, "形状与 /api/task/claim 对齐（活动领奖无 chat/web 双路，via 恒空串）");
    // 上游真实发生：恰 1 次 claim POST + 初始清单读取与领奖回读（claimed_at）
    assert.equal(stub.calls.filter((c) => c.path.endsWith("/claim")).length, 1);
    assert.ok(stub.calls.filter((c) => c.path === "/portal/activity/tasks" && c.method === "GET").length >= 2, "初始读取 + 回读");
    assert.ok(stub.calls.length > n0);
    assert.ok(stub.calls.every((c) => c.host === "www.codebuddy.cn"));
  });

  test("400：uid/activityCode/taskCode 缺一不可，400 不打上游", async () => {
    const n0 = stub.calls.length;
    for (const body of [
      {},
      { uid: UID_OK },
      { activityCode: "campaign_starbucks_2026", taskCode: "ai_chat" },
      { uid: UID_OK, activityCode: "campaign_starbucks_2026" },
      { uid: UID_OK, taskCode: "ai_chat" },
    ]) {
      const r = await fetch(`${base()}/api/campaign/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 400);
      assert.deepEqual(await r.json(), { error: "需要 uid、activityCode 与 taskCode" });
    }
    assert.equal(stub.calls.length, n0, "参数校验失败零上游");
  });

  test("账号找不到 → 与 /api/task/claim 逐字同口径：500 +「找不到账号」（manualOp 转换），零上游", async () => {
    const n0 = stub.calls.length;
    const r = await fetch(`${base()}/api/campaign/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid: "u-nosuch", activityCode: "campaign_starbucks_2026", taskCode: "ai_chat" }),
    });
    assert.equal(r.status, 500, "/api/task/claim 对未知账号就是 500（不是 404），新路由同口径");
    const j = await r.json();
    assert.match(j.error, /找不到账号 u-nosuch/);
    assert.match(j.error, /plugin-auth\.json/);
    assert.equal(stub.calls.length, n0);
  });

  test("显式点名冻结账号 → 200 {ok:false} + §10.5 冻结文案（与 /api/task/claim 逐字同款），零上游", async () => {
    const n0 = stub.calls.length;
    const r = await fetch(`${base()}/api/campaign/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid: UID_FROZEN, activityCode: "campaign_starbucks_2026", taskCode: "ai_chat" }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.equal(j.credit, 0);
    assert.equal(j.energy, 0);
    assert.equal(j.via, "");
    assert.match(j.reason, /账号已冻结（11140）：request illegal/);
    assert.match(j.reason, /确认无风险后在账号行点「恢复」/);
    assert.equal(stub.calls.length, n0, "冻结账号一个上游都不发");
  });

  test("任务未达成 → 200 {ok:false}，reason 给人话（不硬闯领奖）", async () => {
    const n0 = stub.calls.length;
    // expert 未达成（进度 0/1）——只读一次清单就拒绝，不发 claim POST
    const r = await fetch(`${base()}/api/campaign/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid: UID_OK, activityCode: "campaign_starbucks_2026", taskCode: "expert" }),
    });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.equal(j.credit, 0);
    assert.match(j.reason, /任务未达成/);
    assert.equal(
      stub.calls.filter((c) => c.path === "/portal/activity/tasks/expert/claim").length,
      0,
      "未达成绝不 POST 领奖（成功用例里 ai_chat 的 claim POST 不计入）",
    );
    assert.ok(stub.calls.length > n0, "但清单读取发生了（拿进度与 reward_credit）");
  });
});

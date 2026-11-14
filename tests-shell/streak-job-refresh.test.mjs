// tests-shell/streak-job-refresh.test.mjs —— 连登缓存收尾刷新（CONTRACT §11.5
// 对称缺口的后端半边）：前端「跑一轮」改走 job 后，连登天数/补签卡/抽奖数不再
// 有 POST /api/streak/run 的返回值可即时回填 —— finalizeJob 对真跑过 streak 腿
// 的账号静默 fetchStreakState 写回 state/streak.json。真实 daemon + 真实引擎
//（runner）+ 假时钟/假上游，零真实网络（手法同 streak-routes.test.mjs /
// campaign-job-refresh.test.mjs）。
//
// 钉死：
//   1. legs:["streak"] 的 job（POST /api/run）结束后：streak.json 该 uid 的
//      updatedISO 变新、收尾刷新真实打上游（fetchStreakState 独占的
//      heatmap/lottery 两路径恰好 +1 = 各 1 次读取）、刷新后的缓存完整
//     （days/makeupCards/lotteryChances）；
//   2. 不含 streak 腿的 job（legs:["travel"]）：收尾刷新一次都不发
//     （fetchStreakState 独占路径 0 增量），streak.json 原样不动；
//      注意 /activity/growth/streak 本身会被既有的快照刷新（refreshSnapshots
//      一直就做的 energy/streak 回填）读一次 —— 所以「streak 状态读取」按
//      fetchStreakState 独占的 heatmap/lottery 计数，才能隔离出本刷新；
//   3. 收尾刷新失败（job 结束后连登三端点全部 500）：job 结论不被改写
//     （state 仍 done、steps 原样）、daemon 日志恰有一行
//     「[streak] <uid> 刷新失败：HTTP 500」、旧缓存原样保留、绝不误冻结账号；
//   4. 同一 job 同时含 campaign + streak 腿：两条收尾刷新串行执行，两个缓存
//      （campaign.json / streak.json）都在 job 结束后自动变新。

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon } from "../daemon.mjs";
import { makeSandbox, cleanupAllSandboxes } from "../tests/helpers.mjs";

const DAEMON_KEY = "{{SECRET_streakjobrefresh}}";
const DAY = 86400000;
// 锚在确定的北京正午：2026-10-15 12:00 北京 = 04:00Z（与本地时区无关）。
const NOW = Date.UTC(2026, 9, 15, 4, 0, 0);
const YESTERDAY = "2026-10-14"; // 北京昨日
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

const UID = "u-streak-job";

// ---- 假上游：连登三 GET + 四 POST + 旅行 status + 活动 portal + 最小成长应答 ----
// down=true 时连登三读端点一律 500（callJSON 的 5xx 重试口径照走）——三个都挂
// fetchStreakState 才会 ok:false（任一成功都算部分成功），用于钉死「收尾刷新
// 失败只记日志、不影响 job 结论」。
function makeStub() {
  const calls = [];
  const completed = new Set();
  const claimed = new Set();
  const state = { down: false };
  const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const ok = (data) => respond(200, { code: 0, msg: "success", data });

  const payloadFor = (campaign) =>
    campaign === "campaign_starbucks_2026"
      ? [
          { task_code: "ai_chat", target_count: 3, reward_credit: 100, need_view: true },
          { task_code: "expert", target_count: 1, reward_credit: 100, need_view: true },
        ]
      : [{ task_code: "skill_use", target_count: 1, reward_credit: 50, need_view: true }];

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
    calls.push({ path: u.pathname, query: u.search, method, host: u.host, at: clock.now() });

    // 连登三读（fetchStreakState 的全部依据；down 时全 500）
    if (u.pathname === "/activity/growth/streak") {
      if (state.down) return respond(500, { code: -1, msg: "upstream exploded" });
      return ok({
        streak: { days: 6 },
        makeup_cards: { balance: 1 },
        redemption_status: { "7d": "available", "14d": "locked", "28d": "claimed" },
      });
    }
    if (u.pathname === "/activity/growth/heatmap") {
      if (state.down) return respond(500, { code: -1, msg: "upstream exploded" });
      return ok({ days: [{ date: YESTERDAY, score: 0 }] });
    }
    if (u.pathname === "/activity/growth/lottery/summary") {
      if (state.down) return respond(500, { code: -1, msg: "upstream exploded" });
      return ok({ chances: 2 });
    }
    // 连登四写
    if (u.pathname === "/activity/growth/makeup-cards/use") return ok({ days: 6 });
    if (u.pathname === "/activity/growth/redeem") return ok({ credit: 70 });
    if (u.pathname === "/activity/growth/lottery/draw") return ok({ name: "50 积分", credit: 50 });
    if (u.pathname === "/billing/meter/claim-gift") return ok({ name: "新手礼包", credit: 100 });
    if (u.pathname === "/billing/meter/claim-compensation") return respond(200, { code: 2101, msg: "已领取过" });
    // 猫猫旅行（legs:["travel"] 的负向对照）：直接回「旅行中」，一步成功
    if (u.pathname === "/activity/growth/buddy/travel/status") return ok({ state: "traveling" });
    // 活动 portal（test 4 的 campaign 腿）
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
    if (u.pathname === "/v2/activity/growth/tasks") return ok({ tasks: [] });
    if (u.pathname === "/v2/activity/growth/energy") return ok({ balance: 42 });
    return respond(404, { code: -1, msg: "not found" });
  };

  return { calls, fetchImpl, state };
}

// ---- 夹具 ---------------------------------------------------------------------
const rootSb = makeSandbox("wb-tasks-streak-job-refresh-");
const root = rootSb.dir;
const cfgDir = join(root, "config");
const stateDir = join(cfgDir, "workbuddy-tasks", "state");
mkdirSync(stateDir, { recursive: true });
writeFileSync(
  join(cfgDir, "plugin-auth.json"),
  JSON.stringify({
    workbuddy: {
      type: "oauth",
      access: "wb-access-STREAK-JOB-01",
      refresh: "wb-refresh-STREAK-JOB-01",
      expires: NOW + 30 * DAY,
      accountId: "streak-job-cat",
      uid: UID,
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
const campaignFile = join(stateDir, "campaign.json");

const base = (h) => `http://127.0.0.1:${h.port}`;
let h = null;

async function boot() {
  stub = makeStub();
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

// 轮询直到 fn() 返回真值（假时钟下引擎的等待都是 ≤15ms 真实让步，余量放宽）
async function waitFor(fn, deadlineMs = 10000) {
  const end = Date.now() + deadlineMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await realSleep(20);
  }
}

// fetchStreakState 独占的两次读取（heatmap/lottery）：快照刷新只碰
// /activity/growth/streak，不碰这两个 —— 用它们隔离出收尾刷新的读。
const stateReads = () =>
  stub.calls.filter((c) => (c.path === "/activity/growth/heatmap" || c.path === "/activity/growth/lottery/summary") && c.method === "GET").length;
const readStreakFile = () => {
  if (!existsSync(streakFile)) return null;
  return JSON.parse(readFileSync(streakFile, "utf8"));
};
const runJob = async (body) => {
  const r = await fetch(`${base(h)}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status !== 200) assert.fail(`POST /api/run 应 200：${r.status} ${await r.text()}`);
  const { job } = await r.json();
  const done = await h.runner.wait(job.id);
  return done;
};

after(async () => {
  try {
    await h?.stop();
  } catch {}
  cleanupAllSandboxes();
});

describe("job 收尾刷新连登缓存（CONTRACT §11.5 对称缺口）", () => {
  test("legs:[streak] 的 job 收尾：updatedISO 变新、上游被调用、缓存完整", async () => {
    h = await boot();
    // 种子：job 之前先拉一次连登状态（cached:false → 落盘），updatedISO = T0
    const seed = await (await fetch(`${base(h)}/api/streak?uid=${UID}`)).json();
    assert.equal(seed.cached, false);
    const t0 = Date.parse(seed.streak.updatedISO);
    assert.ok(Number.isFinite(t0));
    assert.deepEqual(readStreakFile()?.[UID], seed.streak, "种子已落盘");

    const readsBeforeJob = stateReads();
    const job = await runJob({ uids: [UID], legs: ["streak"] });
    assert.equal(job.state, "done");
    const step = job.steps.find((s) => s.leg === "streak");
    assert.equal(step.state, "ok", "streak 腿本身成功");
    const readsAtJobEnd = stateReads();
    assert.ok(readsAtJobEnd > readsBeforeJob, "streak 腿本身读过连登状态");

    // job 已结束但收尾要等观察者 tick（noTimers 模式手动驱动，同 campaign 版）
    h.ticks.watchJob();

    // 收尾刷新写回 streak.json：updatedISO 严格变新
    const persisted = await waitFor(() => {
      const j = readStreakFile();
      return j && Number.isFinite(Date.parse(j?.[UID]?.updatedISO ?? "")) && Date.parse(j[UID].updatedISO) > t0 ? j : null;
    });
    assert.ok(persisted, "job 收尾后 streak.json 该 uid 的 updatedISO 变新");

    // 刷新真实打上游：fetchStreakState 独占两路径恰好各 +1（三 GET，一次收齐）
    const delta = stateReads() - readsAtJobEnd;
    assert.equal(delta, 2, `收尾刷新恰好 heatmap+lottery 各 1 次，实际 +${delta}`);
    // 刷新出的缓存形状完整（与 GET /api/streak 成功路径同一落点）
    assert.equal(persisted[UID].days, 6);
    assert.equal(persisted[UID].makeupCards, 1);
    assert.equal(persisted[UID].lotteryChances, 2);
    assert.equal(job.state, "done", "收尾刷新绝不改 job 结论");
  });

  test("不含 streak 腿的 job（legs:[travel]）：零连登状态查询，streak.json 原样", async () => {
    const logsMark = daemonLogs.length; // 只看本用例新增的日志（daemonLogs 跨用例累积）
    await h.stop();
    writeFileSync(streakFile, JSON.stringify({})); // 重置缓存基线
    h = await boot();
    const before = readStreakFile();
    const readsBefore = stateReads();

    const job = await runJob({ uids: [UID], legs: ["travel"] });
    assert.equal(job.state, "done");
    h.ticks.watchJob();

    // 给任何（不该存在的）收尾刷新留出真实时间完成；假时钟下一次刷新全流程
    //（≥1s 红线 + 3 次读取 + 落盘）在真实时间里几十毫秒内就会发生
    await realSleep(800);

    assert.equal(stateReads() - readsBefore, 0, "没跑 streak 腿就一次连登状态查询都不发");
    assert.deepEqual(readStreakFile(), before, "streak.json 原样不动");
    assert.ok(!daemonLogs.slice(logsMark).some((l) => l.includes("[streak]")), "也没有任何收尾刷新日志");
  });

  test("收尾刷新失败（job 后连登三端点 500）：job 结论不被改写，日志恰一行「刷新失败」", async () => {
    await h.stop();
    writeFileSync(streakFile, JSON.stringify({})); // 重置缓存基线
    h = await boot();
    // 种子：job 之前拉一次（cached:false → 落盘 T0）
    const seed = await (await fetch(`${base(h)}/api/streak?uid=${UID}`)).json();
    assert.equal(seed.cached, false);
    const beforeFile = readStreakFile();

    // job 本身健康完成：结论先固定下来
    const job = await runJob({ uids: [UID], legs: ["streak"] });
    assert.equal(job.state, "done");
    assert.equal(job.steps.find((s) => s.leg === "streak").state, "ok");
    const stepsBefore = JSON.stringify(job.steps);

    // job 结束后才把连登三读端点打挂 → 收尾刷新必然失败（fetchStreakState
    // 要三个子请求全部失败才 ok:false，所以三个都 down）
    stub.state.down = true;
    const readsAtJobEnd = stateReads();
    h.ticks.watchJob();

    const failLines = await waitFor(() => {
      const lines = daemonLogs.filter((l) => /\[streak\].*刷新失败/.test(l));
      return lines.length === 1 ? lines : null;
    });
    assert.ok(failLines, "daemon 日志恰有一行「[streak] <uid> 刷新失败：…」");
    assert.equal(failLines[0], `[streak] ${UID} 刷新失败：HTTP 500`);

    // 刷新确实尝试过上游（3 端点 × callJSON 的 5xx 三次尝试，heatmap ≥ 2 次）
    assert.ok(stateReads() - readsAtJobEnd >= 2, "收尾刷新真的试过上游才失败");

    // job 结论与步骤原样：不被收尾失败改写
    assert.equal(job.state, "done");
    assert.equal(JSON.stringify(job.steps), stepsBefore, "steps 一个字段都没变");

    // 旧缓存原样保留：streak.json 与 job 前完全一致（成功路径没走到写盘）
    assert.deepEqual(readStreakFile(), beforeFile, "刷新失败绝不写坏旧缓存");
    assert.ok(!daemonLogs.some((l) => l.includes("[frozen]")), "收尾刷新失败绝不误冻结账号");
  });

  test("同一 job 含 campaign+streak 两腿：两条收尾刷新串行，两个缓存都自动变新", async () => {
    const logsMark = daemonLogs.length; // 只看本用例新增的日志（上一用例留了一行刷新失败）
    await h.stop();
    writeFileSync(streakFile, JSON.stringify({}));
    writeFileSync(campaignFile, JSON.stringify({}));
    h = await boot();
    // 两个缓存都先种一次（各自 updatedISO = 各自的 T0）
    const seedStreak = await (await fetch(`${base(h)}/api/streak?uid=${UID}`)).json();
    const seedCampaign = await (await fetch(`${base(h)}/api/campaign?uid=${UID}`)).json();
    assert.equal(seedStreak.cached, false);
    assert.equal(seedCampaign.cached, false);
    const tStreak = Date.parse(seedStreak.streak.updatedISO);
    const tCampaign = Date.parse(seedCampaign.campaign.updatedISO);

    const job = await runJob({ uids: [UID], legs: ["campaign", "streak"], claim: true });
    assert.equal(job.state, "done");
    assert.equal(job.steps.find((s) => s.leg === "campaign").state, "ok");
    assert.equal(job.steps.find((s) => s.leg === "streak").state, "ok");
    h.ticks.watchJob();

    // 两条刷新串行（campaign → streak）：两个缓存都在收尾后变新
    const both = await waitFor(() => {
      const s = readStreakFile()?.[UID];
      const c = existsSync(campaignFile) ? JSON.parse(readFileSync(campaignFile, "utf8"))?.[UID] : null;
      const okStreak = s && Date.parse(s.updatedISO ?? "") > tStreak;
      const okCampaign = c && Date.parse(c.updatedISO ?? "") > tCampaign;
      return okStreak && okCampaign ? { s, c } : null;
    });
    assert.ok(both, "job 收尾后 campaign.json 与 streak.json 都变新（串行链跑完）");
    assert.equal(both.s.days, 6);
    assert.equal(both.c.ok, true);
    assert.equal(job.state, "done", "收尾刷新绝不改 job 结论");
    assert.ok(!daemonLogs.slice(logsMark).some((l) => l.includes("刷新失败")), "健康路径零失败日志");
  });
});

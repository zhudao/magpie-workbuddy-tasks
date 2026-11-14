// tests-shell/campaign-job-refresh.test.mjs —— job 收尾刷新活动缓存（CONTRACT
// §11.5 后端半边）：finalizeJob 在既有「刷新快照」同一处调用链上，对真跑过
// campaign 腿的账号静默 fetchCampaignState 写回 state/campaign.json，让看板
// 活动明细在 job 完成后自动更新。真实 daemon + 真实引擎（runner）+ 假时钟/假
// 上游，零真实网络（手法同 campaign-routes.test.mjs）。
//
// 钉死：
//   1. legs:["campaign"] 的 job（POST /api/run）结束后：campaign.json 该 uid 的
//      updatedISO 变新、收尾刷新真实打上游（/portal/activity/tasks 恰好 +2 =
//      每活动 1 次读取）、刷新后的缓存反映 job 刚发生的领奖；
//      顺带钉死 §11.5 的步骤/日志粒度：campaign step.detail 点名活动与项数、
//      job.log 有逐项的 ✅/🎁 行（SSE 的 log 事件就流这些）；
//   2. 不含 campaign 腿的 job（legs:["growth"]）：不触发任何活动查询
//     （/portal/activity/tasks 计数 0 增量），campaign.json 原样不动；
//   3. 收尾刷新失败（job 结束后上游 500）：job 结论不被改写（state 仍 done、
//      steps 原样）、daemon 日志恰有一行「[campaign] <uid> 刷新失败：…」、
//      旧缓存原样保留（campaign.json 一个字节都不变）、绝不误冻结账号。

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon } from "../daemon.mjs";
import { makeSandbox, cleanupAllSandboxes } from "../tests/helpers.mjs";

const DAEMON_KEY = "{{SECRET_campaignjobrefresh}}";
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

const UID = "u-campaign-job";

// ---- 假上游：活动 portal 两端点 + MP/桌面事件上报 + 专家市场 + 最小成长应答 -------
// down=true 时 /portal/activity/tasks 一律 500（callJSON 的 5xx 重试口径照走），
// 用于钉死「收尾刷新失败只记日志、不影响 job 结论」。
function makeStub() {
  const calls = [];
  const completed = new Set();
  const claimed = new Set();
  const state = { down: false };
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
      if (state.down) return respond(500, { code: -1, msg: "upstream exploded" });
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

  return { calls, fetchImpl, completed, claimed, state };
}

// ---- 夹具 ---------------------------------------------------------------------
const rootSb = makeSandbox("wb-tasks-campaign-job-refresh-");
const root = rootSb.dir;
const cfgDir = join(root, "config");
const stateDir = join(cfgDir, "workbuddy-tasks", "state");
mkdirSync(stateDir, { recursive: true });
writeFileSync(
  join(cfgDir, "plugin-auth.json"),
  JSON.stringify({
    workbuddy: {
      type: "oauth",
      access: "wb-access-CAMP-JOB-01",
      refresh: "wb-refresh-CAMP-JOB-01",
      expires: NOW + 30 * DAY,
      accountId: "campaign-job-cat",
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
const campaignFile = join(stateDir, "campaign.json");

const base = (h) => `http://127.0.0.1:${h.port}`;
let h = null;
let campaignJob = null; // test 1 跑完的 job（test 2 据此断言 step/log 粒度）

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

const campaignReads = () => stub.calls.filter((c) => c.path === "/portal/activity/tasks" && c.method === "GET").length;
const readCampaignFile = () => {
  if (!existsSync(campaignFile)) return null;
  return JSON.parse(readFileSync(campaignFile, "utf8"));
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

describe("job 收尾刷新活动缓存（CONTRACT §11.5）", () => {
  test("legs:[campaign] 的 job 收尾：updatedISO 变新、上游 +2、缓存反映刚发生的领奖", async () => {
    h = await boot();
    // 种子：job 之前先拉一次活动状态（cached:false → 落盘），updatedISO = T0
    const seed = await (await fetch(`${base(h)}/api/campaign?uid=${UID}`)).json();
    assert.equal(seed.cached, false);
    const t0 = Date.parse(seed.campaign.updatedISO);
    assert.ok(Number.isFinite(t0));
    assert.deepEqual(readCampaignFile()?.[UID], seed.campaign, "种子已落盘");

    const readsBeforeJob = campaignReads();
    const job = await runJob({ uids: [UID], legs: ["campaign"], claim: true });
    assert.equal(job.state, "done");
    const readsAtJobEnd = campaignReads();
    assert.ok(readsAtJobEnd > readsBeforeJob, "job 的 campaign 腿本身读过上游");

    // job 已结束但收尾要等观察者 tick（noTimers 模式手动驱动；与 daemon.test.mjs
    // 的「job 收尾 → finalizeJob」同一手法）
    h.ticks.watchJob();

    // 收尾刷新写回 campaign.json：updatedISO 严格变新
    const persisted = await waitFor(() => {
      const j = readCampaignFile();
      return j && Number.isFinite(Date.parse(j?.[UID]?.updatedISO ?? "")) && Date.parse(j[UID].updatedISO) > t0 ? j : null;
    });
    assert.ok(persisted, "job 收尾后 campaign.json 该 uid 的 updatedISO 变新");

    // 刷新真实打上游：恰 +2（每活动 1 次 GET；200 不触发 callJSON 的 5xx 重试）
    assert.equal(campaignReads() - readsAtJobEnd, 2, "收尾刷新恰好每活动 1 次读取");
    // 刷新出的缓存反映 job 刚发生的领奖（ai_chat 本 job 内 claimed_at 回读成功）
    const ai = persisted[UID].activities[0].tasks.find((t) => t.taskCode === "ai_chat");
    assert.equal(ai.claimedAt, RECEIPT_ISO, "缓存是 job 之后的最新活动状态");
    assert.equal(job.state, "done", "收尾刷新绝不改 job 结论");
    campaignJob = job;
  });

  test("§11.5 步骤/日志粒度：step.detail 点名活动与项数，job.log 有逐项行", async () => {
    // 同一个 job（上一测断言过结论），这里只看 step 与 log 的可读性
    const job = campaignJob;
    const step = job.steps.find((s) => s.leg === "campaign");
    assert.ok(step, "campaign 腿有 step");
    assert.equal(step.state, "ok");
    assert.ok(
      step.detail.includes("活动任务本轮入账 400 积分（星巴克协作×2、记者节福利活动×3）"),
      `step.detail 应点名活动与项数，实际：${step.detail}`,
    );
    // 逐项行进 job.log（SSE 的 kind:"log" 事件实时流的就是这些）
    assert.ok(job.log.some((l) => l.includes("☕️ 星巴克协作（campaign_starbucks_2026）")), "活动头行");
    assert.ok(job.log.some((l) => l.includes("✅ 与 AI 对话3次")), "逐项完成行");
    assert.ok(job.log.some((l) => l.includes("🎁 领奖")), "逐项领奖行");
  });

  test("不含 campaign 腿的 job（legs:[growth]）：零活动查询，campaign.json 原样", async () => {
    await h.stop();
    writeFileSync(campaignFile, JSON.stringify({})); // 重置缓存基线
    h = await boot();
    const before = readCampaignFile();
    const readsBefore = campaignReads();

    const job = await runJob({ uids: [UID], legs: ["growth"] });
    assert.equal(job.state, "done");
    h.ticks.watchJob();

    // 给任何（不该存在的）收尾刷新留出真实时间完成；假时钟下一次刷新全流程
    // （≥1s 红线 + 2 次读取 + 落盘）在真实时间里几十毫秒内就会发生
    await realSleep(800);

    assert.equal(campaignReads() - readsBefore, 0, "没跑 campaign 腿就一次活动查询都不发");
    assert.deepEqual(readCampaignFile(), before, "campaign.json 原样不动");
    assert.ok(!daemonLogs.some((l) => l.includes("[campaign]")), "也没有任何收尾刷新日志");
  });

  test("收尾刷新失败（job 后上游 500）：job 结论不被改写，日志恰一行「刷新失败」", async () => {
    await h.stop();
    writeFileSync(campaignFile, JSON.stringify({})); // 重置缓存基线
    h = await boot();
    // 种子：job 之前拉一次（cached:false → 落盘 T0）
    const seed = await (await fetch(`${base(h)}/api/campaign?uid=${UID}`)).json();
    assert.equal(seed.cached, false);
    const beforeFile = readCampaignFile();

    // job 本身健康完成（领奖 400）：结论先固定下来
    const job = await runJob({ uids: [UID], legs: ["campaign"], claim: true });
    assert.equal(job.state, "done");
    const step = job.steps.find((s) => s.leg === "campaign");
    assert.equal(step.state, "ok");
    const stepsBefore = JSON.stringify(job.steps);

    // job 结束后才把活动读取端点打挂 → 收尾刷新必然失败
    stub.state.down = true;
    const readsAtJobEnd = campaignReads();
    h.ticks.watchJob();

    const failLines = await waitFor(() => {
      const lines = daemonLogs.filter((l) => /\[campaign\].*刷新失败/.test(l));
      return lines.length === 1 ? lines : null;
    });
    assert.ok(failLines, "daemon 日志恰有一行「[campaign] <uid> 刷新失败：…」");
    assert.match(failLines[0], new RegExp(`\\[campaign\\] ${UID} 刷新失败：活动任务读取失败\\[campaign_starbucks_2026\\]: HTTP 500`));

    // 刷新确实尝试过上游（2 活动 × callJSON 的 5xx 三次尝试 ≥ 2 次）
    assert.ok(campaignReads() - readsAtJobEnd >= 2, "收尾刷新真的试过上游才失败");

    // job 结论与步骤原样：不被收尾失败改写
    assert.equal(job.state, "done");
    assert.equal(JSON.stringify(job.steps), stepsBefore, "steps 一个字段都没变");

    // 旧缓存原样保留：campaign.json 与 job 前完全一致（成功路径都没走到写盘）
    assert.deepEqual(readCampaignFile(), beforeFile, "刷新失败绝不写坏旧缓存");
    assert.ok(!daemonLogs.some((l) => l.includes("[frozen]")), "收尾刷新失败绝不误冻结账号");
  });
});

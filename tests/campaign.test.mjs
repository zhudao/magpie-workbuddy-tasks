// tests/campaign.test.mjs —— 运营活动任务（engine/campaign.mjs，CONTRACT §11.1）
// 回归。响应造形照 hub 测试文件（verify-tmp/hub-v2.1.3-campaign-tests.py.diff.txt）。
//
// 钉死：
//   - CAMPAIGN_SPECS 目录形状逐字（两个活动、tasks 顺序、expert/skill/case id）；
//   - 活动读取失败 vs 「没下发」严格区分（HTTP 状态 + 正文片段进日志/state）；
//   - need_view 真值先 viewed；need_view 缺失/假值不 view（hub row.get 的实际语义）；
//   - 进度以 completed_at / progress>=target 为准；达标才领奖；
//   - 领奖只 POST 成功**不算**成功，必须回读到 claimed_at；
//   - 逐轮进度日志（2026-11-13 用户反馈「批量做任务像卡住了」）：判据轮询/
//     领奖回读的每一轮恰一行等待行（行数 = 轮数，带当前进度与「第 i/n 次」），
//     快/慢/桌面/领奖四种文案可区分，绝不刷屏；
//   - app kind 只提示、不伪造（零事件上报）；
//   - 幂等：已领（claimed_at 已在）不再领；
//   - restricted（403/11140）透传且停手；
//   - §11.6 后端一半：claimCampaignTask 单任务领奖（必须回读 claimed_at、
//     credit 按 reward_credit 记账、restricted/不存在/未达成/已领各口径）；
//   - §11.6 第 4 条：runCampaignTasks 的 opts.codes 任务级勾选
//     （<activityCode>:<taskCode>，未勾活动零读取、空数组=全跑、
//     非空但无活动条目=零上游跳过、其它命名空间 code 忽略）；
//   - 与成长腿解耦：成长清单拉空/失败时 campaign 腿照跑（runner 级）；
//   - 事件字段：reporter 专家/技能/桌面判据的 id 逐字；星巴克专家走市场挑选
//     （MP_EXPERT_CATEGORY 分类）；MP 最小头族 + 页面上下文。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CAMPAIGN_CASES,
  CAMPAIGN_CLAIM_POLL_TRIES,
  CAMPAIGN_POLL_TRIES,
  CAMPAIGN_SLOW_POLL_TRIES,
  CAMPAIGN_SPECS,
  MP_EXPERT_CATEGORY,
  campaignChatEvent,
  campaignDesktopEvents,
  campaignExpertEvents,
  campaignSkillEvents,
  claimCampaignTask,
  fetchCampaignState,
  runCampaignTasks,
} from "../engine/campaign.mjs";
import { JobRunner } from "../engine/runner.mjs";
import { fakeClock, makeAcct } from "./helpers.mjs";

const GAP = 1000;
const NOW = Date.UTC(2026, 10, 13, 4, 0, 0); // 2026-11-13 北京正午前后（时钟只影响时间戳）
const RECEIPT_ISO = "2026-11-13T00:00:00Z";

// ---- 活动假上游（造形照 hub 测试的 campaign_payload / fake_urlopen） -----------
// opts:
//   readFailure: {campaignCode: {status, body}} —— 活动读取失败
//   noIssue: {campaignCode: true}               —— 活动未下发（tasks []）
//   claimWithoutReceipt: true                    —— 领奖 POST 成功但不回写 claimed_at
//   needViewFalse: true                          —— 上游 need_view 全 false
//   noNeedView: true                             —— 上游不带 need_view 字段
//   restricted: true                             —— 一律 403/11140
//   growthFails: true                            —— 成长任务清单 500（解耦用例）
//   landOnCheck: {taskCode: n}                   —— 判据事件上报后第 n 次清单检查才
//                                                  落库 completed_at（逐轮进度日志用例）
//   receiptOnRead: {taskCode: n}                 —— 领奖 POST 后第 n 次回读才见
//                                                  claimed_at（领奖等待行用例）
function campaignStub(opts = {}, clock = fakeClock(NOW)) {
  const calls = [];
  const reports = []; // {kind:"mp"|"desktop"|"other", events, headers, host}
  const viewed = []; // {task, campaign}
  const claims = []; // {task, campaign}
  const completed = new Set();
  const claimed = new Set();
  const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  // 延迟落库/回执（缺省立即落库，既有用例口径不变）：pendingLands/receiptReads
  // 记已检查次数，每次成功的清单读取推进一格，到点才把判据挂进 progress。
  const pendingLands = new Map(); // task -> 已检查次数
  const receiptReads = new Map(); // task -> 已回读次数
  const completeTask = (code) => {
    if (opts.landOnCheck?.[code]) pendingLands.set(code, 0);
    else completed.add(code);
  };

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

    if (opts.restricted) return respond(403, { code: 11140, msg: "request illegal" });

    // 活动清单读取
    if (u.pathname === "/portal/activity/tasks" && method === "GET") {
      const campaign = u.searchParams.get("activity_code") ?? "";
      if (opts.readFailure?.[campaign]) {
        const f = opts.readFailure[campaign];
        return respond(f.status ?? 500, f.body ?? { msg: "upstream boom" });
      }
      if (opts.noIssue?.[campaign]) return respond(200, { code: 0, data: { tasks: [], progress: [] } });
      const tasks = payloadFor(campaign).map((t) => ({
        ...t,
        ...(opts.needViewFalse ? { need_view: false } : {}),
        ...(opts.noNeedView ? { need_view: undefined } : {}),
      }));
      // 延迟落库推进：本次读取就是一次「检查/回读」，到点才让判据可见
      for (const [code, n] of pendingLands) {
        if (n + 1 >= opts.landOnCheck[code]) {
          pendingLands.delete(code);
          completed.add(code);
        } else {
          pendingLands.set(code, n + 1);
        }
      }
      for (const [code, n] of receiptReads) {
        if (n + 1 >= opts.receiptOnRead[code]) {
          receiptReads.delete(code);
          completed.add(code);
          claimed.add(code);
        } else {
          receiptReads.set(code, n + 1);
        }
      }
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

    // viewed / claim（portal 契约）
    const viewMatch = /^\/portal\/activity\/tasks\/([^/]+)\/viewed$/.exec(u.pathname);
    if (viewMatch) {
      viewed.push({ task: decodeURIComponent(viewMatch[1]), campaign: u.searchParams.get("activity_code") });
      return respond(200, { code: 0 });
    }
    const claimMatch = /^\/portal\/activity\/tasks\/([^/]+)\/claim$/.exec(u.pathname);
    if (claimMatch) {
      const task = decodeURIComponent(claimMatch[1]);
      claims.push({ task, campaign: u.searchParams.get("activity_code") });
      if (!opts.claimWithoutReceipt) {
        if (opts.receiptOnRead?.[task]) {
          receiptReads.set(task, 0); // 回执延迟：从下一次回读开始计数
        } else {
          completed.add(task);
          claimed.add(task); // hub fake：领奖后回读可见 claimed_at
        }
      }
      return respond(200, { code: 0 });
    }

    // 事件上报：按头族分流（MP 最小头族 = 活动事件；桌面 UA = desktop 判据）
    if (u.pathname === "/v2/report") {
      const events = Array.isArray(body) ? body : [body];
      if (String(headers["X-Client-Product"] ?? "") === "workbuddy-mp") {
        reports.push({ kind: "mp", events, headers, host: u.host });
        for (const e of events) {
          const page = JSON.stringify({ pageURL: e.pageURL, pageName: e.pageName });
          if (e.eventCode === "chat_request_send") completeTask(page.includes("starbucks") ? "ai_chat" : "skill_use");
          if (e.eventCode === "expert_actual_use") completeTask(page.includes("starbucks") ? "expert" : "expert_chat");
        }
        return respond(200, { code: 0, data: {} });
      }
      if (String(headers["User-Agent"] ?? "").includes("WorkBuddy/5.8.3")) {
        reports.push({ kind: "desktop", events, headers, host: u.host });
        for (const e of events) {
          if (e.eventCode === "playbook_prompt_send" && e.id === "cnb-content-calendar") completeTask("desktop_same");
        }
        return respond(200, { code: 0, data: {} });
      }
      // 其它 chat 域上报（runner 的每日活跃等）照单全收
      reports.push({ kind: "other", events, headers, host: u.host });
      return respond(200, { code: 0, data: {} });
    }

    // 专家市场（campaignPickExpert）
    if (u.pathname === "/v2/operation-platform/market/expert/list" && method === "POST") {
      if (opts.expertMarketFails) return respond(500, { code: 500, msg: "market down" });
      return respond(200, {
        code: 0,
        data: { experts: [{ expert_id: "ex_BackToSchool01", display_name_zh: { zh: "返校季讲解员" } }] },
      });
    }

    // 成长体系（解耦用例）：清单拉空/失败
    if (u.pathname === "/v2/activity/growth/tasks") {
      if (opts.growthFails) return respond(500, { code: 500, msg: "growth list down" });
      return respond(200, { code: 0, data: { tasks: [] } });
    }
    if (u.pathname === "/v2/activity/growth/energy") return respond(200, { code: 0, data: { balance: 42 } });

    return respond(404, { code: -1, msg: "not found" });
  };

  return { fetchImpl, calls, reports, viewed, claims, completed, claimed, clock };
}

const run = (stub, extra = {}) =>
  runCampaignTasks(makeAcct(), {
    now: stub.clock.now,
    sleep: stub.clock.sleep,
    fetch: stub.fetchImpl,
    gap: GAP,
    ...extra,
  });

// ---- 目录与事件构造（逐字对照 hub） -------------------------------------------

test("campaign：CAMPAIGN_SPECS 目录逐字（两个活动、判据顺序与 id）", () => {
  assert.deepEqual(
    CAMPAIGN_SPECS.map((s) => s.code),
    ["campaign_starbucks_2026", "campaign_reporter_2026"],
  );
  const [starbucks, reporter] = CAMPAIGN_SPECS;
  assert.deepEqual(
    starbucks.tasks.map((t) => t.task),
    ["ai_chat", "expert", "app"],
  );
  assert.deepEqual(
    reporter.tasks.map((t) => [t.task, t.kind, t.expert_id, t.skill_id, t.case_id, t.credit]),
    [
      ["expert_chat", "expert", "ex_NaiDbO06Adf3", undefined, undefined, 50],
      ["skill_use", "skill", undefined, "skill_2117491159283752960", undefined, 50],
      ["desktop_same", "desktop", undefined, undefined, "content-calendar", 100],
    ],
  );
  assert.equal(starbucks.page.pageURL, "subpackages/secondary/starbucks-activity-428/index");
  assert.equal(reporter.page.pageName, "journalist_benefit");
  assert.equal(CAMPAIGN_CASES["content-calendar"].event_id, "cnb-content-calendar");
  assert.equal(CAMPAIGN_CASES["content-calendar"].prompt_length, 359);
  assert.equal(MP_EXPERT_CATEGORY, "16-BackToSchool");
});

test("campaign：事件构造字段逐字（chat/expert/skill/desktop）", () => {
  const chat = campaignChatEvent(NOW);
  assert.equal(chat.eventCode, "chat_request_send");
  assert.equal(chat.mode, "chat");
  assert.equal(chat.inputLength, 12);
  assert.equal(chat.agentName, "mp");
  assert.equal(chat["codebuddy.session_id"], chat.parentConversationId);
  assert.equal(chat["codebuddy.conversation_request_id"], chat.requestId);
  assert.ok(chat.messageId.startsWith("msg-"));
  assert.equal(chat.messageId, `msg-${chat.requestId.slice(-8)}`);

  const [click, summoned, use, send] = campaignExpertEvents("ex_NaiDbO06Adf3", "媒体工作助理", NOW);
  assert.equal(click.eventCode, "expert_summon_click");
  assert.equal(click.id, "ex_NaiDbO06Adf3");
  assert.equal(click.type, MP_EXPERT_CATEGORY);
  assert.equal(summoned.eventCode, "expert_summoned");
  assert.equal(use.eventCode, "expert_actual_use");
  assert.equal(use.expertType, "builtin");
  assert.equal(use.characterCount, 14);
  assert.equal(send.eventCode, "chat_request_send");
  assert.equal(send.expertId, "ex_NaiDbO06Adf3");
  assert.equal(send.expertName, "媒体工作助理");
  // 同组共享会话与请求 id
  assert.equal(send.conversationId, click.conversationId ?? summoned.conversationId ?? use.conversationId ?? send.conversationId);
  assert.equal(summoned.conversationId, undefined, "expert_summoned 不带会话字段（hub 逐字）");

  const [info, skillSend] = campaignSkillEvents("skill_2117491159283752960", "interview-material-organizer", NOW);
  assert.equal(info.eventCode, "skill_info");
  assert.equal(info.id, "interview-material-organizer");
  assert.equal(info.skillId, "skill_2117491159283752960");
  assert.equal(info.skillType, "market");
  assert.equal(info.skillSource, "market");
  assert.equal(skillSend.eventCode, "chat_request_send");
  assert.equal(skillSend.skillId, "skill_2117491159283752960");
  assert.equal(skillSend.skillCount, 1);
  assert.equal(skillSend.conversationId, info.conversationId);

  const [pb] = campaignDesktopEvents(CAMPAIGN_CASES["content-calendar"], NOW);
  assert.equal(pb.eventCode, "playbook_prompt_send");
  assert.equal(pb.id, "cnb-content-calendar");
  assert.equal(pb.name, "内容发布排期表");
  assert.equal(pb.type, "table");
  assert.equal(pb.promptLength, 359);
  assert.equal(pb.isOfficial, 1);
  assert.equal(pb.source, "discover");
  assert.equal(pb.query, "");
  assert.equal(pb.ext1, "discover");
});

// ---- 主流程 ---------------------------------------------------------------------

test("campaign：全判据跑通 —— viewed/事件/领奖回执/app 只提示（earned 400）", async () => {
  const stub = campaignStub();
  const res = await run(stub);
  assert.equal(res.ok, true, res.logs.join("\n"));
  assert.equal(res.earned, 400, "ai_chat 100 + expert 100 + expert_chat 50 + skill_use 50 + desktop_same 100；app 不伪造不领");
  assert.deepEqual(
    [...res.actions.claimed].sort(),
    ["ai_chat", "desktop_same", "expert", "expert_chat", "skill_use"],
    "app 判据只提示、永不领（真机完成后下轮自动补领）",
  );
  assert.equal(res.claimed, 5);
  // viewed：6 个判据全部 need_view:true → 各 view 一次（app 也先 view）
  assert.equal(stub.viewed.length, 6);
  assert.deepEqual([...new Set(stub.viewed.map((v) => v.task))].sort(), [
    "ai_chat", "app", "desktop_same", "expert", "expert_chat", "skill_use",
  ]);

  // app 只提示、不伪造：MP 上报恰 4 组（ai_chat / 星巴克 expert / reporter expert / skill），
  // 桌面上报恰 1 组（desktop_same）—— app 从未出现在任何事件里
  const mpReports = stub.reports.filter((r) => r.kind === "mp");
  const desktopEvents = stub.reports.filter((r) => r.kind === "desktop").flatMap((r) => r.events);
  assert.equal(mpReports.length, 4, "chat×1 + expert×2 + skill×1，各一次上报");
  assert.ok(desktopEvents.some((e) => e.id === "cnb-content-calendar"));
  assert.equal(desktopEvents.length, 1);

  // MP 事件头族与页面上下文（hub `_campaign_headers` + page env_extra）
  const mpReport = mpReports[0];
  assert.equal(mpReport.headers["X-Client-Platform"], "mp-weixin");
  assert.equal(mpReport.headers["X-Client-Product"], "workbuddy-mp");
  assert.equal(mpReport.headers["X-Client-Version"], "2.4.0");
  assert.equal(mpReport.headers["X-Platform"], "wechatmp");
  assert.equal(mpReport.headers["X-User-Id"], "u-12345678");
  assert.equal(mpReport.headers["Authorization"], "Bearer access-token-abc");
  assert.equal(mpReport.headers["X-Domain"], undefined, "MP 最小头族不带桌面 X-Domain");
  const pageEvent = mpReport.events[0];
  assert.equal(pageEvent.pageURL, "subpackages/secondary/starbucks-activity-428/index");
  assert.equal(pageEvent.pageName, "starbucks_activity");
  assert.equal(pageEvent.ideType, "WorkBuddy_MP", "mpBase 包络已合并");
  assert.equal(pageEvent.userId, "u-12345678");

  // 事件打 codebuddy 域 /v2/report（CAMPAIGN_BASE）
  assert.equal(mpReport.host, "www.codebuddy.cn");
  assert.equal(
    stub.calls.find((c) => c.path === "/v2/report" && c.headers["X-Client-Product"] === "workbuddy-mp").host,
    "www.codebuddy.cn",
  );

  // 日志：app 只提示
  assert.ok(res.logs.some((l) => l.includes("需手机端 App 登录后与 AI 对话一次，脚本不伪造")));
  assert.ok(res.logs.some((l) => l.includes("尚未完成（0/1）")));
  assert.ok(res.logs.some((l) => l.includes("☕️ 活动任务本轮入账 400 积分")));
});

test("campaign：星巴克 expert 判据走市场挑选（MP_EXPERT_CATEGORY + 回落），reporter 判据 id 钉死", async () => {
  const stub = campaignStub();
  await run(stub);
  const pick = stub.calls.find((c) => c.path === "/v2/operation-platform/market/expert/list");
  assert.ok(pick, "星巴克 expert 无 expert_id → 挑市场专家");
  assert.deepEqual(pick.body.categories, ["16-BackToSchool"]);
  assert.equal(pick.body.edition_mode, "all,domestic");
  assert.equal(pick.body.expert_type, "agent");
  assert.equal(pick.host, "www.codebuddy.cn");
  const mpEvents = stub.reports.filter((r) => r.kind === "mp").flatMap((r) => r.events);
  const starbucksExpert = mpEvents.find((e) => e.eventCode === "expert_actual_use" && e.pageName === "starbucks_activity");
  assert.equal(starbucksExpert.id, "ex_BackToSchool01", "用市场返回的真实专家 id");
  assert.equal(starbucksExpert.expertTitle, "返校季讲解员");
  const reporterExpert = mpEvents.find((e) => e.eventCode === "expert_actual_use" && e.pageName === "journalist_benefit");
  assert.equal(reporterExpert.id, "ex_NaiDbO06Adf3", "reporter 的专家 id 钉死不被覆盖");
  const skillInfo = mpEvents.find((e) => e.eventCode === "skill_info");
  assert.equal(skillInfo.skillId, "skill_2117491159283752960");
  const desktop = stub.reports.filter((r) => r.kind === "desktop").flatMap((r) => r.events);
  assert.equal(desktop[0].id, "cnb-content-calendar");
});

test("campaign：读取失败 vs 没下发 —— 严格区分（HTTP 状态 + 正文片段）", async () => {
  // ① 星巴克读取失败、记者节正常：整体 ok:false（hub 的 failed 口径），两者日志可区分
  const a = campaignStub({ readFailure: { campaign_starbucks_2026: { status: 500, body: { msg: "boom" } } } });
  const ra = await run(a);
  assert.equal(ra.ok, false);
  assert.ok(
    ra.logs.some((l) => l.includes("活动任务读取失败[campaign_starbucks_2026]: HTTP 500")),
    ra.logs.join("\n"),
  );
  assert.ok(ra.logs.some((l) => l.includes("☕️ 记者节福利活动")), "另一个活动照跑");
  // state：失败活动 error 非空、tasks 空；正常活动 tasks 3 条
  const starA = ra.state.activities.find((x) => x.code === "campaign_starbucks_2026");
  const repA = ra.state.activities.find((x) => x.code === "campaign_reporter_2026");
  assert.ok(starA.error.includes("HTTP 500"));
  assert.equal(starA.tasks.length, 0);
  assert.equal(repA.error, "");
  assert.equal(repA.tasks.length, 3);

  // ② 全部读取失败 → fetchCampaignState ok:false + error；run ok:false
  const b = campaignStub({
    readFailure: {
      campaign_starbucks_2026: { status: 401, body: { msg: "unauthorized" } },
      campaign_reporter_2026: { status: 500, body: { msg: "server" } },
    },
  });
  const st = await fetchCampaignState(makeAcct(), {
    now: b.clock.now, sleep: b.clock.sleep, fetch: b.fetchImpl, gap: GAP,
  });
  assert.equal(st.ok, false);
  assert.match(st.error, /HTTP/);
  const rb = await run(b);
  assert.equal(rb.ok, false);
  assert.equal(rb.earned, 0);

  // ③ 没下发（读取成功但 tasks 空）：ok:true、日志「活动未下发/已结束，跳过」，
  //    与读取失败是两行不同的日志
  const c = campaignStub({ noIssue: { campaign_starbucks_2026: true } });
  const rc = await run(c);
  assert.equal(rc.ok, true);
  assert.ok(rc.logs.some((l) => l.includes("☕️ 星巴克协作: 活动未下发/已结束，跳过")));
  assert.ok(!rc.logs.some((l) => l.includes("读取失败")), "没下发绝不写成读取失败");
  const starC = rc.state.activities.find((x) => x.code === "campaign_starbucks_2026");
  assert.equal(starC.error, "", "没下发不是错误");
  assert.equal(starC.tasks.length, 0);
});

test("campaign：claimable/claimed 投影 + need_view 语义（真值才 view，缺失不 view）", async () => {
  // 上游 need_view 全 false → 不 view；进度已完成但未领 → claimable=6、claimed=0
  const a = campaignStub({ needViewFalse: true });
  const st = await fetchCampaignState(makeAcct(), {
    now: a.clock.now, sleep: a.clock.sleep, fetch: a.fetchImpl, gap: GAP,
  });
  assert.equal(st.ok, true);
  const totalTasks = st.activities.reduce((s, x) => s + x.tasks.length, 0);
  assert.equal(totalTasks, 6);
  const before = st.activities.map((x) => x.tasks.map((t) => t.needView));
  // 预置全部 completed（不 claimed）→ claimable 6
  for (const code of ["ai_chat", "expert", "app", "expert_chat", "skill_use", "desktop_same"]) a.completed.add(code);
  const st2 = await fetchCampaignState(makeAcct(), {
    now: a.clock.now, sleep: a.clock.sleep, fetch: a.fetchImpl, gap: GAP,
  });
  assert.equal(st2.activities.reduce((s, x) => s + x.claimable, 0), 6);
  assert.equal(st2.activities.reduce((s, x) => s + x.claimed, 0), 0);
  for (const t of st2.activities.flatMap((x) => x.tasks)) assert.equal(t.needView, false);
  assert.ok(before.every((arr) => arr.every((v) => v === false)));
  const ra = await run(a);
  assert.equal(stub_viewedCount(a), 0, "need_view:false → 绝不发 viewed");
  assert.equal(ra.earned, 500, "预置 completed 的 6 项全部领到（含 app 的 100）");
  assert.equal(a.claims.length, 6);

  // 上游不带 need_view 字段 → 同样不 view（hub row.get 的实际语义）
  const b = campaignStub({ noNeedView: true });
  await run(b);
  assert.equal(stub_viewedCount(b), 0);
});

function stub_viewedCount(stub) {
  return stub.viewed.length;
}

test("campaign：领奖必须回读 claimed_at —— 只 POST 成功不算", async () => {
  const stub = campaignStub({ claimWithoutReceipt: true });
  const res = await run(stub);
  assert.equal(res.ok, false, "没有一张回执 → 本轮不算成功");
  assert.equal(res.earned, 0);
  assert.deepEqual(res.actions.claimed, []);
  assert.equal(stub.claims.length, 5, "claim POST 都发出去了（5 个可发射判据都提交过；app 不伪造不提交）");
  assert.ok(
    res.logs.some((l) => l.includes("已提交但未回读到 claimed_at，下轮重试")),
    res.logs.join("\n"),
  );
  // claim POST 之后的回读确实发生了（每张领奖 5 次回读预算）
  const readCalls = stub.calls.filter((c) => c.path === "/portal/activity/tasks" && c.method === "GET");
  assert.ok(readCalls.length > 6);
});

// ---- 逐轮进度日志（2026-11-13 用户反馈「批量做任务像卡住了」：点亮/回读等待
//      最长 60s+，等待期间每一轮都要有一行「生命迹象」） ---------------------------

test("campaign：判据轮询逐轮打点 —— 等待行数 = 检查次数，带进度与轮次", async () => {
  // 第 2 次检查才落库：第 1 轮等（0/3），第 2 轮看到 3/3 即停
  const stub = campaignStub({ landOnCheck: { ai_chat: 2 } });
  const res = await run(stub, { codes: ["campaign_starbucks_2026:ai_chat"] });
  assert.equal(res.ok, true, res.logs.join("\n"));
  assert.equal(res.earned, 100);
  const waits = res.logs.filter((l) => l.includes("等待上游落库"));
  assert.equal(waits.length, 2, "恰两条等待行 —— 一轮一条（行数=检查次数），不是轮询内刷屏");
  assert.ok(waits[0].startsWith("   ⏳ 与 AI 对话3次: "), waits[0]);
  assert.ok(waits[0].endsWith("等待上游落库（0/3，第 1/6 次检查）"), waits[0]);
  assert.ok(waits[1].endsWith("等待上游落库（3/3，第 2/6 次检查）"), waits[1]);
  assert.ok(res.logs.some((l) => l.includes("✅ 与 AI 对话3次: completed 3/3")), res.logs.join("\n"));
});

test("campaign：桌面类长等逐轮打点 —— 「最多 60s」+ 轮次（10×6s 预算）", async () => {
  const stub = campaignStub({ landOnCheck: { desktop_same: 3 } });
  const res = await run(stub, { codes: ["campaign_reporter_2026:desktop_same"] });
  assert.equal(res.ok, true, res.logs.join("\n"));
  assert.equal(res.earned, 100);
  const waits = res.logs.filter((l) => l.includes("桌面端动作需等待"));
  assert.equal(waits.length, 3, "第 3 次检查才落库 → 恰三条等待行");
  assert.ok(waits[0].endsWith("桌面端动作需等待，最多 60s（0/1，第 1/10 次检查）"), waits[0]);
  assert.ok(waits[2].endsWith("桌面端动作需等待，最多 60s（1/1，第 3/10 次检查）"), waits[2]);
});

test("campaign：慢轮询逐轮打点且不刷屏 —— 预算耗尽恰 6+6 条，文案区分两段", async () => {
  // 永不落库：快轮询 6 轮 + 慢轮询 6 轮，各恰 6 条等待行后如实顺延（不算失败）
  const stub = campaignStub({ landOnCheck: { expert: 999 } });
  const res = await run(stub, { codes: ["campaign_starbucks_2026:expert"] });
  assert.equal(res.ok, true, "判据延迟未落库只顺延，不算失败");
  assert.equal(res.earned, 0);
  const fast = res.logs.filter((l) => l.includes("等待上游落库"));
  const slow = res.logs.filter((l) => l.includes("判据延迟，慢轮询加等"));
  assert.equal(fast.length, CAMPAIGN_POLL_TRIES, "快轮询恰 6 条（CAMPAIGN_POLL=6）");
  assert.equal(slow.length, CAMPAIGN_SLOW_POLL_TRIES, "慢轮询恰 6 条（CAMPAIGN_SLOW_POLL=6）");
  assert.ok(fast[0].endsWith("等待上游落库（0/1，第 1/6 次检查）"), fast[0]);
  assert.ok(fast[5].endsWith("等待上游落库（0/1，第 6/6 次检查）"), fast[5]);
  assert.ok(slow[0].endsWith("判据延迟，慢轮询加等（0/1，第 1/6 次检查）"), slow[0]);
  assert.ok(res.logs.some((l) => l.includes("判据延迟未落库（0/1），下轮自动补领")));
  // 整个 run 里「第 1/」开轮次的行恰两条（快/慢各一）—— 没有第三种等待变体混入
  const waitish = res.logs.filter((l) => l.includes("第 1/"));
  assert.equal(waitish.length, 2, waitish.join("\n"));
});

test("campaign：领奖回读逐轮打点 —— 等待行数 = 回读轮数 + 一条成功行", async () => {
  // 第 2 次回读才见 claimed_at：两轮等待行 + 成功行（成功行在等待行之后）
  const stub = campaignStub({ receiptOnRead: { ai_chat: 2 } });
  stub.completed.add("ai_chat"); // 已达成 → 直接进领奖，不发射判据
  const res = await run(stub, { codes: ["campaign_starbucks_2026:ai_chat"] });
  assert.equal(res.ok, true, res.logs.join("\n"));
  assert.equal(res.earned, 100);
  const waits = res.logs.filter((l) => l.includes("已提交，等待回执"));
  assert.equal(waits.length, 2, "恰两条等待行");
  assert.ok(waits[0].endsWith("领奖[campaign_starbucks_2026/ai_chat]: 已提交，等待回执（第 1/5 次）"), waits[0]);
  assert.ok(waits[1].endsWith("领奖[campaign_starbucks_2026/ai_chat]: 已提交，等待回执（第 2/5 次）"), waits[1]);
  const successIdx = res.logs.findIndex((l) => l.includes("🎁 领奖[campaign_starbucks_2026/ai_chat]: +100 积分"));
  assert.ok(successIdx >= 0, "恰一条成功行");
  assert.ok(successIdx > res.logs.indexOf(waits[1]), "成功行在最后一条等待行之后（回执到 → 停）");
  assert.equal(res.logs.filter((l) => l.includes("+100 积分")).length, 1);
});

test("campaign：幂等 —— 已领（claimed_at 已在）不再领、不再上报", async () => {
  const stub = campaignStub();
  for (const code of ["ai_chat", "expert", "app", "expert_chat", "skill_use", "desktop_same"]) stub.claimed.add(code);
  const res = await run(stub);
  assert.equal(res.ok, true);
  assert.equal(res.earned, 0);
  assert.deepEqual(res.actions.claimed, []);
  assert.equal(stub.claims.length, 0, "已领奖绝不重复领");
  assert.equal(stub.viewed.length, 0, "已领奖连 viewed 都不发（claimed 判断在最前）");
  assert.equal(stub.reports.length, 0, "已领奖不上报任何判据事件");
  assert.ok(res.logs.some((l) => l.includes("已领奖（3/3）")) || res.logs.some((l) => l.includes("已领奖（1/1）")));
});

test("campaign：进度已完成但未领 → 直接领（不重复上报判据）", async () => {
  const stub = campaignStub();
  for (const code of ["ai_chat", "expert", "app", "expert_chat", "skill_use", "desktop_same"]) stub.completed.add(code);
  const res = await run(stub);
  assert.equal(res.ok, true);
  assert.equal(res.earned, 500);
  const mpEvents = stub.reports.filter((r) => r.kind === "mp");
  assert.equal(mpEvents.length, 0, "completed_at 已在 → 不再发射判据事件");
  assert.equal(stub.claims.length, 6);
});

test("campaign：restricted（403/11140）透传且立即停手", async () => {
  const stub = campaignStub({ restricted: true });
  const res = await run(stub);
  assert.equal(res.ok, false);
  assert.equal(res.restricted, true);
  assert.equal(res.earned, 0);
  assert.equal(stub.claims.length, 0);
  assert.equal(stub.reports.length, 0);
  // fetchCampaignState 同样透传
  const st = await fetchCampaignState(makeAcct(), {
    now: stub.clock.now, sleep: stub.clock.sleep, fetch: stub.fetchImpl, gap: GAP,
  });
  assert.equal(st.ok, false);
  assert.equal(st.restricted, true);
});

test("campaign：opts.codes 勾选 —— 只跑选中的活动", async () => {
  const stub = campaignStub();
  const res = await run(stub, { codes: ["campaign_reporter_2026"] });
  assert.equal(res.ok, true);
  assert.equal(res.earned, 200);
  const getCalls = stub.calls.filter((c) => c.path === "/portal/activity/tasks" && c.method === "GET");
  assert.ok(getCalls.every((c) => c.query.includes("campaign_reporter_2026")), "只读记者节活动");
  assert.equal(stub.calls.filter((c) => c.path === "/portal/activity/tasks" && c.method === "GET" && c.query.includes("starbucks")).length, 0);
  assert.deepEqual(
    res.state.activities.map((a) => a.code),
    ["campaign_reporter_2026"],
  );
});

// ---- §11.6 后端一半：单任务领奖出口 claimCampaignTask ---------------------------

const claimOne = (stub, target, extra = {}) =>
  claimCampaignTask(makeAcct(), target, {
    now: stub.clock.now,
    sleep: stub.clock.sleep,
    fetch: stub.fetchImpl,
    gap: GAP,
    ...extra,
  });

test("campaign：claimCampaignTask 成功 —— 必须回读 claimed_at 才算，credit 按 reward_credit 记账", async () => {
  const stub = campaignStub();
  stub.completed.add("ai_chat"); // 已达成（completed_at 在）、未领
  const res = await claimOne(stub, { activity: "campaign_starbucks_2026", task: "ai_chat" });
  assert.equal(res.ok, true);
  assert.equal(res.credit, 100, "credit 来自活动清单的 reward_credit（一次初始读取拿到）");
  assert.equal(res.energy, 0);
  assert.equal(res.reason, "");
  // 上游序列：恰好 2 次清单 GET（初始 1 次拿 reward_credit/状态 + 回读第 1 次就
  // 见到 claimed_at 即停）+ 恰 1 次 claim POST（路径与 activity_code 逐字）
  const reads = stub.calls.filter((c) => c.path === "/portal/activity/tasks" && c.method === "GET");
  const claimPosts = stub.calls.filter((c) => c.path.endsWith("/claim"));
  assert.equal(reads.length, 2);
  assert.equal(claimPosts.length, 1);
  assert.ok(claimPosts[0].path.startsWith("/portal/activity/tasks/ai_chat/claim"));
  assert.ok(claimPosts[0].query.includes("activity_code=campaign_starbucks_2026"));
  assert.equal(stub.claims.length, 1);
  // 领奖出口只领不点亮：零 viewed、零判据事件
  assert.equal(stub.viewed.length, 0);
  assert.equal(stub.reports.length, 0);
});

test("campaign：claimCampaignTask —— 只 POST 成功但无回执 → 失败，reason 说明未回读到 claimed_at", async () => {
  const stub = campaignStub({ claimWithoutReceipt: true });
  stub.completed.add("ai_chat");
  const res = await claimOne(stub, { activity: "campaign_starbucks_2026", task: "ai_chat" });
  assert.equal(res.ok, false);
  assert.equal(res.credit, 0, "没回读到 claimed_at 绝不记账");
  assert.equal(res.restricted, undefined);
  assert.ok(res.reason.includes("未回读到 claimed_at"), res.reason);
  // 回读预算沿用 CAMPAIGN_CLAIM_POLL/GAP：初始 1 次 + 5 次回读，全打同一活动
  const reads = stub.calls.filter((c) => c.path === "/portal/activity/tasks" && c.method === "GET");
  assert.equal(reads.length, 1 + CAMPAIGN_CLAIM_POLL_TRIES);
  assert.ok(reads.every((c) => c.query.includes("campaign_starbucks_2026")));
  assert.equal(stub.claims.length, 1);
});

test("campaign：claimCampaignTask —— restricted（403/11140）透传，绝不抛", async () => {
  const stub = campaignStub({ restricted: true });
  const res = await claimOne(stub, { activity: "campaign_starbucks_2026", task: "ai_chat" });
  assert.equal(res.ok, false);
  assert.equal(res.restricted, true);
  assert.equal(res.credit, 0);
  assert.equal(stub.claims.length, 0);
});

test("campaign：claimCampaignTask —— 活动/任务不存在 → 失败且零 POST", async () => {
  // 未知任务：清单读取成功但 rows 里没有该 task
  const a = campaignStub();
  const ra = await claimOne(a, { activity: "campaign_starbucks_2026", task: "nope_task" });
  assert.equal(ra.ok, false);
  assert.ok(ra.reason.includes("nope_task"), ra.reason);
  assert.equal(a.claims.length, 0, "任务不存在绝不 POST 领奖");
  // 清单读取成功但一个任务都没下发（活动不存在/已结束同口径：rows 空）
  const b = campaignStub({ noIssue: { campaign_starbucks_2026: true } });
  const rb = await claimOne(b, { activity: "campaign_starbucks_2026", task: "ai_chat" });
  assert.equal(rb.ok, false);
  assert.ok(rb.reason.includes("未下发"), rb.reason);
  assert.equal(b.claims.length, 0);
});

test("campaign：claimCampaignTask —— 未达成不硬闯、已领幂等成功、参数缺失不抛", async () => {
  // 进度 0/3 → 与批量腿同一道门：拒绝领奖（不 POST），reason 带进度
  const a = campaignStub();
  const ra = await claimOne(a, { activity: "campaign_starbucks_2026", task: "ai_chat" });
  assert.equal(ra.ok, false);
  assert.ok(ra.reason.includes("任务未达成（0/3）"), ra.reason);
  assert.equal(a.claims.length, 0);
  // 清单里 claimed_at 已在 → 幂等成功（不再 POST），credit 照记
  const b = campaignStub();
  b.claimed.add("ai_chat");
  const rb = await claimOne(b, { activity: "campaign_starbucks_2026", task: "ai_chat" });
  assert.equal(rb.ok, true);
  assert.equal(rb.credit, 100);
  assert.equal(b.claims.length, 0, "已领奖不再重复 POST");
  // 参数缺失 → 失败不抛（reason 说明缺什么）
  const rc = await claimOne(campaignStub(), { activity: "", task: "ai_chat" });
  assert.equal(rc.ok, false);
  assert.ok(rc.reason.includes("activity"), rc.reason);
});

// ---- §11.6 第 4 条：runCampaignTasks 的 opts.codes 任务级勾选 -------------------

test("campaign：runCampaignTasks {codes} 任务级勾选 —— 两个活动各选一项，未选的不动", async () => {
  const stub = campaignStub();
  const res = await run(stub, {
    codes: ["campaign_starbucks_2026:ai_chat", "campaign_reporter_2026:desktop_same"],
  });
  assert.equal(res.ok, true, res.logs.join("\n"));
  assert.equal(res.earned, 200, "ai_chat 100 + desktop_same 100；未勾的 expert/skill/app/expert_chat/skill_use 不动");
  assert.deepEqual([...res.actions.claimed].sort(), ["ai_chat", "desktop_same"]);
  // viewed/判据事件只在勾中的两个任务上发生
  assert.deepEqual([...new Set(stub.viewed.map((v) => v.task))].sort(), ["ai_chat", "desktop_same"]);
  const mpReports = stub.reports.filter((r) => r.kind === "mp");
  const desktopEvents = stub.reports.filter((r) => r.kind === "desktop").flatMap((r) => r.events);
  assert.equal(mpReports.length, 1, "恰一次 chat 判据上报（ai_chat）");
  assert.equal(mpReports[0].events[0].pageName, "starbucks_activity");
  assert.equal(desktopEvents.length, 1);
  assert.equal(desktopEvents[0].id, "cnb-content-calendar");
  assert.equal(stub.calls.some((c) => c.path.includes("/market/expert/list")), false, "expert 未勾 → 连专家市场都不挑");
  assert.deepEqual(
    res.state.activities.map((a) => a.code),
    ["campaign_starbucks_2026", "campaign_reporter_2026"],
    "state 只含被勾中的活动",
  );
});

test("campaign：runCampaignTasks {codes} —— 未勾中的活动整块跳过（连读取都省）", async () => {
  const stub = campaignStub();
  const res = await run(stub, { codes: ["campaign_starbucks_2026:ai_chat"] });
  assert.equal(res.ok, true);
  assert.equal(res.earned, 100);
  const starReads = stub.calls.filter(
    (c) => c.path === "/portal/activity/tasks" && c.method === "GET" && c.query.includes("campaign_starbucks_2026"),
  );
  const repReads = stub.calls.filter(
    (c) => c.path === "/portal/activity/tasks" && c.method === "GET" && c.query.includes("campaign_reporter_2026"),
  );
  assert.ok(starReads.length > 0);
  assert.equal(repReads.length, 0, "未勾活动零读取（§11.6：连读取都可以省）");
  assert.deepEqual(
    res.state.activities.map((a) => a.code),
    ["campaign_starbucks_2026"],
  );
});

test("campaign：runCampaignTasks {codes} —— 空数组=全跑；非空但无活动条目=零上游跳过", async () => {
  // 空数组 = 全跑（与成长/小程序腿「未传/空数组 = 全部」同款约定）
  const a = campaignStub();
  const ra = await run(a, { codes: [] });
  assert.equal(ra.ok, true);
  assert.equal(ra.earned, 400, "空数组与不传同义：5 项可领（app 不伪造）");

  // 非空但全是其它命名空间 code（成长/MP/未知）→ 本腿无事可做，零上游
  const b = campaignStub();
  const rb = await run(b, { codes: ["Expert_someone_new", "Sequential_Tasks_1", "growth_whatever"] });
  assert.equal(rb.ok, true);
  assert.equal(rb.earned, 0);
  assert.equal(b.calls.length, 0, "交集为空：一次 /portal/activity/* 都不读");
  assert.deepEqual(rb.state.activities, []);
  assert.ok(rb.logs.some((l) => l.includes("本腿跳过")), rb.logs.join("\n"));

  // 成长/MP code 混在活动勾选里：只跑活动条目，其余忽略且不告警（两套命名空间）
  const c = campaignStub();
  const rc = await run(c, { codes: ["Sequential_Tasks_1", "campaign_starbucks_2026:expert"] });
  assert.equal(rc.ok, true);
  assert.equal(rc.earned, 100);
  assert.equal(
    c.calls.filter((x) => x.path === "/portal/activity/tasks" && x.method === "GET" && x.query.includes("campaign_reporter_2026")).length,
    0,
    "记者节未勾 → 零读取",
  );
  assert.ok(!rc.logs.some((l) => l.includes("Sequential_Tasks_1")), "其它命名空间 code 绝不当成活动匹配/告警");

  // 勾中活动但任务 code 不在清单 → 警告一次，连读取都省（零上游）
  const d = campaignStub();
  const rd = await run(d, { codes: ["campaign_starbucks_2026:ai_chatt"] });
  assert.equal(rd.ok, true);
  assert.equal(rd.earned, 0);
  assert.equal(d.calls.length, 0, "选中的任务都不在清单 → 连读取都省");
  assert.ok(
    rd.logs.some((l) => l.includes("[campaign_starbucks_2026/ai_chatt] 不在活动任务清单")),
    rd.logs.join("\n"),
  );
});

test("campaign：与成长腿解耦 —— 成长清单失败时 campaign 腿照跑（runner）", async () => {
  const stub = campaignStub({ growthFails: true });
  const runner = new JobRunner({
    accounts: [makeAcct()],
    now: stub.clock.now,
    sleep: stub.clock.sleep,
    fetch: stub.fetchImpl,
    gap: GAP,
  });
  const job = runner.start({ legs: ["growth", "campaign"] });
  const done = await runner.wait(job.id);
  assert.deepEqual(
    done.steps.map((s) => s.leg),
    ["growth", "campaign"],
    "spec.legs 归一后按 LEG_ORDER 排序（campaign 在 mp 之后 streak 之前，见 LEG_ORDER）",
  );
  const growthStep = done.steps.find((s) => s.leg === "growth");
  assert.equal(growthStep.state, "fail", "成长清单拉空 → growth 腿失败");
  const campaignStep = done.steps.find((s) => s.leg === "campaign");
  assert.equal(campaignStep.state, "ok", "成长失败不影响活动腿");
  assert.equal(campaignStep.credit, 400, "活动收益独立记账");
  assert.equal(done.totals.credit, 400);
  assert.equal(done.totals.tasksClaimed, 5);
});

test("campaign：LEG_ORDER 顺序钉死 —— campaign 插在 mp 与 streak 之间（runner）", async () => {
  // 全腿跑一遍（假上游对成长/连登/盲盒/旅行都给最小应答），断言七条腿的顺序
  const stub = campaignStub();
  const runner = new JobRunner({
    accounts: [makeAcct()],
    now: stub.clock.now,
    sleep: stub.clock.sleep,
    fetch: stub.fetchImpl,
    gap: GAP,
  });
  const job = runner.start({ legs: ["night", "bogus", "travel", "buddy", "streak", "campaign", "mp", "growth"] });
  const done = await runner.wait(job.id);
  assert.deepEqual(
    done.steps.map((s) => s.leg),
    ["growth", "mp", "campaign", "streak", "buddy", "travel", "night"],
    "CONTRACT §11.1 的 LEG_ORDER",
  );
});

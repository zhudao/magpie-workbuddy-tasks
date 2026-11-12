import { test } from "node:test";
import assert from "node:assert/strict";

import { runGrowthTasks, acceptTasks, progressTask } from "../engine/tasks.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const GAP = 1000;

function collectLog() {
  const logs = [];
  const steps = [];
  const fn = (line) => {
    if (typeof line === "string") logs.push(line);
    else steps.push(line);
  };
  return { logs, steps, fn };
}

const seedTasks = () => [
  task("first_buddy", { task_type: "auto", reward: 300, target: 1 }),
  task("create_canvas", { reward: 300 }),
  task("expert_5", { reward: 200, target: 5 }),
  task("chat_5", { reward: 100, target: 5, status: "accepted" }),
  task("RichMeow_Chat", { reward: 100, jump_url: "workbuddy://chat" }),
  task("black_cat", { reward: 100, target: 3 }),
];

const litRules = {
  chat_request_send: ["first_buddy", "chat_5"],
  wbx_design_canvas_task_create: "create_canvas",
  expert_actual_use: "expert_5",
  agent_task_completed: "RichMeow_Chat", // RichMeow 6 连的最后一条事件推进任务
};

function fullRun(overrides = {}) {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0)); // 本地 10:00，非夜间
  const backend = wbBackend({ clock, tasks: seedTasks(), litRules, ...overrides });
  const { logs, steps, fn } = collectLog();
  const acct = makeAcct({ uid: "uid-A" });
  const promise = runGrowthTasks(acct, {
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
    log: fn,
    gap: GAP,
  });
  return { clock, backend, logs, steps, acct, promise };
}

test("流水线：完整一轮（点亮、接取、领奖的顺序与结算）", async () => {
  const { backend, logs, promise } = fullRun();
  const result = await promise;

  assert.equal(result.ok, true, logs.join("\n"));
  assert.equal(result.earnedCredit, 300 + 300 + 200 + 100 + 100);
  assert.equal(result.lit, 5);
  assert.equal(result.claimed, 5);
  // 结算行里带回能量余额
  assert.ok(logs.join("\n").includes("当前能量 42"), logs.join("\n"));

  const calls = backend.calls;
  const idx = (pred) => calls.findIndex(pred);
  const firstReport = idx((c) => c.path === "/v2/report");
  const firstAccept = idx((c) => c.path === "/v2/activity/growth/tasks/accept");
  const firstClaim = idx((c) => c.path.endsWith("/claim"));

  // auto 任务先点亮再领奖，都发生在批量接取之前（first_buddy 是前置）
  assert.ok(firstReport >= 0 && firstAccept >= 0 && firstClaim >= 0);
  assert.ok(firstReport < firstAccept, "auto 任务上报应先于接取");
  assert.ok(firstClaim < firstAccept, "first_buddy 领奖应先于接取");
  assert.equal(calls[firstClaim].path, "/activity/growth/tasks/first_buddy/claim");

  // 接取批次：20 上限内一批；不含 auto / 已接取
  const acceptBodies = calls.filter((c) => c.path === "/v2/activity/growth/tasks/accept").map((c) => c.body);
  assert.equal(acceptBodies.length, 1);
  assert.deepEqual(acceptBodies[0].task_codes, ["create_canvas", "expert_5", "RichMeow_Chat", "black_cat"]);
  assert.ok(!acceptBodies[0].task_codes.includes("first_buddy"), "auto 任务不进接取批次");
  assert.ok(!acceptBodies[0].task_codes.includes("chat_5"), "已接取的不重接");
  assert.equal(backend.state.acceptCalls, 1, "复查后无遗漏 → 不二次补接");

  // 专家事件：5 次上报、5 个互不相同的 id、都带 userId
  const expertReports = backend.state.reports.filter((e) => e.eventCode === "expert_actual_use");
  assert.equal(expertReports.length, 5);
  assert.equal(new Set(expertReports.map((e) => e.id)).size, 5, "(eventCode,id) 去重 → id 必须轮换");
  for (const e of backend.state.reports) assert.ok(e.userId, "事件缺 userId（服务端会静默丢弃）");

  // 领奖都发生在进度到位之后（假后端只在达标时给领奖成功），且顺序正确
  assert.deepEqual(backend.state.claims, ["first_buddy", "create_canvas", "expert_5", "chat_5", "RichMeow_Chat"]);

  // RichMeow：6 条桌面会话事件链一次上报（一个 report body 恰好 6 条、顺序与
  // timestamp 依次 +20），最后一条 agent_task_completed 推进任务并领奖。
  // 注意不能按 eventCode 裸统计：chat_request_send 与 chat/glmchat/cat 族共用
  // （first_buddy + chat_5 各上报若干），RichMeow 的那条以 agentName:"cli" 区分。
  const CHAIN_CODES = [
    "agent_task_created",
    "chat_message_send",
    "chat_request_send",
    "chat_message_response",
    "chat_request_response",
    "agent_task_completed",
  ];
  const chainBodies = backend.state.bodies.filter(
    (b) => Array.isArray(b) && b.length === 6 && b.every((e) => CHAIN_CODES.includes(e.eventCode)),
  );
  assert.equal(chainBodies.length, 1, "RichMeow 的 6 连恰好一次上报（单 body 6 条链事件）");
  const chain = chainBodies[0];
  assert.deepEqual(
    chain.map((e) => e.eventCode),
    CHAIN_CODES,
    "链事件顺序：agent_task_created → chat_message_send → chat_request_send → chat_message_response → chat_request_response → agent_task_completed",
  );
  for (let i = 1; i < chain.length; i++) {
    assert.equal(chain[i].timestamp, chain[0].timestamp + 20 * i, `链 timestamp 依次 +20（第 ${i} 条）`);
  }
  // 链中带 agentName 的 4 条（message_send/request_send/message_response/
  // request_response）都是 cli —— 与 web chat 族的 "default"、MP 族的 "mp" 区分；
  // agent_task_created / agent_task_completed 无 agentName 字段（hub 原样）。
  const named = chain.filter((e) => "agentName" in e);
  assert.equal(named.length, 4);
  for (const e of named) assert.equal(e.agentName, "cli");
  assert.equal(
    backend.state.reports.filter((e) => e.eventCode === "agent_task_created").length, 1,
    "agent_task_created 只属于 RichMeow 6 连（template 族是 with_template 变体）",
  );
  assert.equal(
    backend.state.reports.filter((e) => e.eventCode === "agent_task_completed").length, 1,
    "恰好一次 agent_task_completed（它推进 RichMeow 进度）",
  );
  assert.equal(backend.state.tasks.find((t) => t.task_code === "RichMeow_Chat").accept_status, "claimed");

  // 夜猫子：10:00 不在窗口 → 诚实跳过
  assert.ok(logs.join("\n").includes("23:00-08:00"));
  const blackCat = backend.state.tasks.find((t) => t.task_code === "black_cat");
  assert.equal(blackCat.accept_status, "accepted");
  assert.equal(backend.state.reports.filter((e) => e.mode === "night").length, 0);
});

test("流水线：选中的任务已领奖时不谎报全部完成", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [task("chat_5", { status: "claimed", current: 5, target: 5, reward: 100 })],
  });
  const logs = [];
  const res = await runGrowthTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
    log: (l) => typeof l === "string" && logs.push(l),
    gap: GAP,
    codes: ["chat_5"],
  });
  assert.equal(res.ok, true);
  assert.equal(res.earnedCredit, 0);
  assert.match(logs.join("\n"), /没有新的收益/);
  assert.ok(!logs.join("\n").includes("全部完成"), "没有新收益时不能谎报全部完成");
});

test("流水线：Buddy_App 5 连上报（桌面头）并领奖", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [task("Buddy_App", { status: "accepted", current: 0, target: 1, reward: 100 })],
    litRules: { buddyapp_enter_click: "Buddy_App" },
  });
  const res = await runGrowthTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
    log: () => {}, gap: GAP, codes: ["Buddy_App"],
  });
  assert.equal(res.ok, true);
  assert.equal(res.earnedCredit, 100);
  assert.ok(res.claimed >= 1);
  const report = backend.calls.find((c) => c.path === "/v2/report");
  assert.ok(report, "必须有 /v2/report");
  assert.equal(report.body.length, 5, "Buddy_App 一次上报 5 条事件");
  assert.equal(report.headers["User-Agent"], "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1");
});

test("流水线：任意两次上游调用间隔 ≥ 1000ms（假时钟断言）", async () => {
  const { backend, promise } = fullRun();
  await promise;
  const calls = backend.calls;
  assert.ok(calls.length > 10, `应有大量上游调用，实际 ${calls.length}`);
  for (let i = 1; i < calls.length; i++) {
    const delta = calls[i].at - calls[i - 1].at;
    assert.ok(delta >= GAP, `第 ${i - 1}→${i} 次调用间隔 ${delta}ms < ${GAP}ms: ${calls[i - 1].path} → ${calls[i].path}`);
  }
});

test("流水线：整批接取被瞬时拒绝 → 复查后二次补接", async () => {
  const { backend, logs, promise } = fullRun({ failAcceptOnce: true });
  const result = await promise;
  assert.equal(result.ok, true);
  assert.equal(backend.state.acceptCalls, 2);
  const text = logs.join("\n");
  assert.ok(text.includes("重试接取一次"));
  assert.ok(text.includes("重试接取成功 4 个"));
  assert.ok(text.includes("接取未成功 4 个"));
});

test("流水线：接取批次上限 20 个一批", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const tasks = Array.from({ length: 25 }, (_, i) => task(`bulk_${i}`, { reward: 1 }));
  const backend = wbBackend({ clock, tasks, litRules: {} });
  const acct = makeAcct();
  const out = await acceptTasks(acct, tasks.map((t) => t.task_code), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
  });
  assert.equal(out.ok, true);
  assert.equal(out.accepted.length, 25);
  assert.equal(backend.state.acceptCalls, 2);
  const bodies = backend.calls.filter((c) => c.path === "/v2/activity/growth/tasks/accept").map((c) => c.body);
  assert.equal(bodies[0].task_codes.length, 20);
  assert.equal(bodies[1].task_codes.length, 5);
  // 批与批之间也有 ≥1s 间隔
  const acceptCalls = backend.calls.filter((c) => c.path === "/v2/activity/growth/tasks/accept");
  assert.ok(acceptCalls[1].at - acceptCalls[0].at >= GAP);
});

test("流水线：进度未落账 → 领奖顺延（不硬闯）", async () => {
  // litRules 里不给 chat 对应规则：上报后进度永远不动
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [task("chat_5", { reward: 100, target: 5, status: "accepted" })],
    litRules: {}, // 无规则 → 上报不计进度
  });
  const { fn } = { fn: () => {} };
  const logs = [];
  const result = await runGrowthTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
    log: (l) => typeof l === "string" && logs.push(l),
  });
  assert.equal(result.ok, true);
  assert.equal(result.earnedCredit, 0);
  assert.equal(backend.state.claims.length, 0);
  assert.ok(logs.join("\n").includes("领奖顺延到下次运行"));
  // 轮询节奏（hub 口径）：1 次初始 + 3 次轮询（attempt<2 两次；第 3 次探测后 break）。
  // 口径按头族分账：web 侧清单调用恰好 4 次；小程序链路（MP_HEADERS）另有 1 次
  // 独立拉取（runGrowthTasks 2b 的 MP 交接，无 MP 任务 → 只查不发）。
  const mpFetch = (c) => c.headers["X-Client-Platform"] === "miniprogram";
  const taskCalls = backend.calls.filter((c) => c.path === "/v2/activity/growth/tasks" && !mpFetch(c));
  assert.equal(taskCalls.length, 4);
  assert.equal(backend.calls.filter((c) => c.path === "/v2/activity/growth/tasks" && mpFetch(c)).length, 1);
});

test("流水线：已完成的任务直接领奖（不重复点亮）", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [task("skill_1", { reward: 100, status: "completed", current: 1, target: 1 })],
    litRules: { skill_info: "skill_1" },
  });
  const logs = [];
  const result = await runGrowthTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
    log: (l) => typeof l === "string" && logs.push(l),
  });
  assert.equal(result.ok, true);
  assert.equal(result.earnedCredit, 100);
  assert.ok(logs.join("\n").includes("领奖成功: +100 积分"));
  assert.equal(backend.state.reports.length, 0, "已完成任务不再上报事件");
});

test("流水线：claim=false 只点亮不领奖", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [task("create_canvas", { reward: 300 })],
    litRules: { wbx_design_canvas_task_create: "create_canvas" },
  });
  const logs = [];
  const result = await runGrowthTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
    log: (l) => typeof l === "string" && logs.push(l),
    claim: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.earnedCredit, 0);
  assert.equal(backend.state.claims.length, 0);
  const t = backend.state.tasks.find((x) => x.task_code === "create_canvas");
  assert.equal(t.accept_status, "completed"); // 点亮了
  assert.ok(logs.join("\n").includes("等待手动领取"));
});

test("流水线：国际版与企业号直接跳过", async () => {
  const intl = await runGrowthTasks(makeAcct({ provider: "workbuddy-ai" }), { fetch: async () => { throw new Error("no network"); } });
  assert.equal(intl.ok, false);
  assert.match(intl.msg, /国际版/);
  const ent = await runGrowthTasks(makeAcct({ enterpriseId: "ent-1" }), { fetch: async () => { throw new Error("no network"); } });
  assert.equal(ent.ok, true);
  assert.match(ent.msg, /企业版/);
});

test("流水线：任务清单拉不到 → 失败收场", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({ clock, tasks: [], litRules: {} });
  const result = await runGrowthTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.ok(result.logs.join("\n").includes("未能获取到任务清单"));
});

test("流水线：MP 任务混进 web 清单 → progressTask 防御性跳过（绝不走 web 事件构造）", async () => {
  // 防御口径：正常 web 清单不含 MP-only 任务；万一上游串台，progressTask 必须
  // 把它交给小程序链路（runGrowthTasks 2b），而不是发 heartbeat 或错误头族事件。
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [task("Sequential_Tasks_1", { title: "完成 1 次对话", status: "accepted", reward: 100 })],
    litRules: {},
  });
  const logs = [];
  const r = await progressTask(
    makeAcct(),
    {
      code: "Sequential_Tasks_1",
      title: "完成 1 次对话",
      acceptStatus: "accepted",
      taskType: "single",
      progress: { current: 0, target: 1 },
      rewardCredit: 100,
      rewardEnergy: 0,
      jumpUrl: "",
    },
    logs,
    { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl },
  );
  assert.deepEqual(r, { credit: 0, energy: 0, lit: 0, claimed: 0 });
  assert.ok(logs.join("\n").includes("小程序任务由小程序链路处理"), logs.join("\n"));
  assert.equal(backend.state.reports.length, 0, "零事件上报");
  assert.equal(backend.state.claims.length, 0, "零领奖");
  assert.equal(
    backend.calls.filter((c) => c.path !== "/v2/activity/growth/tasks").length,
    0,
    "除清单外零上游调用（无 report/claim/accept）",
  );
});

test("流水线：web 清单 locked:true 的任务整条跳过（不接取/不上报/不领奖），解锁后照常", async () => {
  // 2026-11-11 生产实测：Sequential_Tasks_7（PC 灵感功能，web playbook）在 web
  // 清单带 locked:true + unlock_at —— 锁定期间不进接取批次（避免必败的 accept
  // error）、不上报、不领奖，「仍有 N 个任务处于未接取状态」不再被它误报；
  // 解锁（locked:false）后照常接取/点亮/领奖。
  const seed = () => [
    task("Sequential_Tasks_7", {
      title: "体验灵感功能", jump_url: "workbuddy://playbook",
      reward: 500, reward_energy: 5, target: 1,
      locked: true, unlock_at: "2026-11-12T00:00:00+08:00",
    }),
  ];
  const litRules = { playbook_prompt_send: "Sequential_Tasks_7" };

  // 锁定：跳过日志一行、零 accept/零 report/零 claim、状态原封不动
  const clock = fakeClock(localTime(2026, 11, 11, 10, 0));
  const lockedBackend = wbBackend({ clock, tasks: seed(), litRules });
  const lockedLogs = [];
  const lockedRes = await runGrowthTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: lockedBackend.fetchImpl,
    log: (l) => typeof l === "string" && lockedLogs.push(l),
    gap: GAP, mpTasks: false, travel: false,
  });
  const lockedText = lockedLogs.join("\n");
  assert.equal(lockedRes.ok, true, lockedText);
  assert.equal(lockedRes.earnedCredit, 0);
  assert.ok(lockedText.includes("⏳ 任务 [体验灵感功能] 到第二天才能接取任务，跳过"), lockedText);
  assert.equal(
    lockedBackend.calls.some((c) => c.path === "/v2/activity/growth/tasks/accept"),
    false,
    "锁定任务不进接取批次（批次为空 → 连 accept 请求都不发）",
  );
  assert.equal(lockedBackend.state.reports.length, 0, "锁定不上报");
  assert.equal(lockedBackend.state.claims.length, 0, "锁定不领奖");
  assert.ok(!lockedText.includes("未接取状态"), "锁定任务不算「未接取」误报（needsAccept 已排除）");
  const lockedTask = lockedBackend.state.tasks[0];
  assert.equal(lockedTask.accept_status, "not_accepted", "锁定任务状态原封不动");

  // 解锁：同一任务 locked:false（unlock_at 清空，模拟上游次日解锁形态）→
  // 照常接取/点亮/领奖（playbook 双事件推进）
  const clock2 = fakeClock(localTime(2026, 11, 12, 10, 0));
  const unlockedBackend = wbBackend({
    clock: clock2,
    tasks: seed().map((t) => ({ ...t, locked: false, unlock_at: undefined })),
    litRules,
  });
  const unlockedLogs = [];
  const unlockedRes = await runGrowthTasks(makeAcct(), {
    now: clock2.now, sleep: clock2.sleep, fetch: unlockedBackend.fetchImpl,
    log: (l) => typeof l === "string" && unlockedLogs.push(l),
    gap: GAP, mpTasks: false, travel: false,
  });
  const unlockedText = unlockedLogs.join("\n");
  assert.equal(unlockedRes.ok, true, unlockedText);
  assert.ok(!unlockedText.includes("到第二天才能接取任务"), unlockedText);
  assert.ok(unlockedText.includes("✓ 任务 [PC灵感功能] 点亮并领奖成功: +500 积分"), unlockedText);
  assert.equal(unlockedRes.earnedCredit, 500);
  const unlockedTask = unlockedBackend.state.tasks[0];
  assert.equal(unlockedTask.accept_status, "claimed", "解锁后接取→点亮→领奖全链路照常");
});

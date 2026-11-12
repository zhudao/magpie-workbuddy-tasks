// tests/miniprogram.test.mjs —— 微信小程序链式任务（engine/miniprogram.mjs，
// hub 937c179 的 run_miniprogram_tasks 移植）回归。
//
// 口径：
//   - 清单/接取/领奖带 MP_HEADERS（X-Client-Platform: miniprogram + MicroMessenger
//     UA）；上报打 chat /v2/report，头 = chat 头族 + MP_REPORT_HEADERS；
//   - 事件体合并 mpBase（ideType=WorkBuddy_MP、machineId=mp-<uid 前 16> 等）；
//   - per-code 事件：1/3/6/school=chat_request_send（agentName=mp）、2=expert_actual_use
//     WorkspaceBuilder、4=automated_task_create_suc、5=chat_request_send+GLM-5.2；
//     整个 need 的事件一次 report 发完，不逐条轮询进度；
//   - opts.codes 非空 = 只处理选中的 MP 交集；交集为空连清单都不拉；
//   - runGrowthTasks 集成：2b 在普通任务之后、猫猫旅行之前；收益/lit/claimed 并入
//     totals；opts.mpTasks=false 关闭；MP 专属 code 不触发「不在任务表中」误报。

import { test } from "node:test";
import assert from "node:assert/strict";

import { runGrowthTasks } from "../engine/tasks.mjs";
import {
  MP_HEADERS,
  MP_REPORT_HEADERS,
  MP_TASK_SPECS,
  acceptMPTasks,
  claimMPTask,
  fetchMPTasks,
  isMPCode,
  mpBase,
  mpEventForCode,
  parseMPLock,
  reportMPEvents,
  runMiniProgramTasks,
} from "../engine/miniprogram.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const GAP = 1000;
const NOW = localTime(2026, 9, 15, 10, 0);

function collectLog() {
  const logs = [];
  const fn = (line) => {
    if (typeof line === "string") logs.push(line);
  };
  return { logs, fn };
}

// MP 种子任务集（mpOnly：只出现在小程序标头的清单里）
const mpSeed = () => [
  task("Sequential_Tasks_1", { title: "小程序对话", target: 1, reward: 100, status: "accepted" }),
  task("Sequential_Tasks_2", { title: "小程序专家对话", target: 1, reward: 200, status: "accepted" }),
  task("Sequential_Tasks_3", { title: "小程序对话5次", target: 5, reward: 300, status: "accepted" }),
  task("Sequential_Tasks_4", { title: "小程序定时任务", target: 1, reward: 100, status: "accepted" }),
  task("Sequential_Tasks_5", { title: "小程序GLM5.2", target: 1, reward: 100, status: "accepted" }),
  task("Sequential_Tasks_6", { title: "小程序对话10次", target: 10, reward: 400, status: "accepted" }),
  task("school_season", { title: "校园日活动", target: 1, reward: 100, status: "accepted" }),
];

// 把事件点亮到对应任务（与 wbBackend.litRules 对齐 MP 事件族）
const mpLitRules = () => ({
  chat_request_send: ["Sequential_Tasks_1", "Sequential_Tasks_3", "Sequential_Tasks_5", "Sequential_Tasks_6", "school_season"],
  expert_actual_use: "Sequential_Tasks_2",
  automated_task_create_suc: "Sequential_Tasks_4",
});

test("fetchMPTasks：MP 头族拉取 + 规范化形状（spec 补 reward）", async () => {
  const clock = fakeClock(NOW);
  const backend = wbBackend({ clock, tasks: mpSeed(), mpOnly: mpSeed().map((t) => t.task_code) });
  const tasks = await fetchMPTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP,
  });

  const call = backend.calls.find((c) => c.path === "/v2/activity/growth/tasks");
  assert.ok(call, "发出清单查询");
  assert.equal(call.method, "GET");
  assert.equal(call.headers["X-Client-Platform"], MP_HEADERS["X-Client-Platform"], "MP_HEADERS 的平台标头");
  assert.equal(call.headers["User-Agent"], MP_HEADERS["User-Agent"], "MicroMessenger UA");
  assert.ok(call.headers["Authorization"], "MP 清单仍带凭据头（头族合并，Authorization 不可顶替）");

  assert.equal(tasks.length, mpSeed().length);
  const s1 = tasks.find((t) => t.code === "Sequential_Tasks_1");
  assert.deepEqual(
    Object.keys(s1).sort(),
    ["acceptStatus", "code", "locked", "progress", "rewardCredit", "taskType", "title", "unlockAt"].sort(),
    "规范任务形状（CONTRACT §2 拼写 + 次日锁字段）",
  );
  assert.equal(s1.acceptStatus, "accepted");
  assert.deepEqual(s1.progress, { current: 0, target: 1 });
  // reward_credit=0（task() 缺省 100，这里用 school_season 校验 spec 补齐路径）
  const zero = wbBackend({
    clock,
    tasks: [task("school_season", { reward: 0, status: "accepted" })],
    mpOnly: ["school_season"],
  });
  const tasks2 = await fetchMPTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: zero.fetchImpl, gap: GAP,
  });
  assert.equal(tasks2[0].rewardCredit, MP_TASK_SPECS.school_season.reward, "reward 缺失时由 MP_TASK_SPECS 补齐");
});

test("fetchMPTasks：上游 locked/unlock_at 逐字透传；缺失时归一 false/\"\"", async () => {
  const clock = fakeClock(NOW);
  // 实测账号 B 实测形态：ST3 not_accepted + locked:true + unlock_at(+08:00 ISO)
  const backend = wbBackend({
    clock,
    tasks: [
      task("Sequential_Tasks_3", {
        title: "小程序对话5次", status: "not_accepted",
        locked: true, unlock_at: "2026-11-08T00:00:00+08:00",
      }),
      task("school_season", { title: "校园日活动", status: "accepted" }), // 上游没给锁字段
    ],
    mpOnly: ["Sequential_Tasks_3", "school_season"],
    litRules: {},
  });
  const tasks = await fetchMPTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP,
  });
  const s3 = tasks.find((t) => t.code === "Sequential_Tasks_3");
  assert.equal(s3.locked, true, "上游 locked:true 透传");
  assert.equal(s3.unlockAt, "2026-11-08T00:00:00+08:00", "unlock_at 原样透传（解析留给投影）");
  const school = tasks.find((t) => t.code === "school_season");
  assert.equal(school.locked, false, "上游没给 locked → 归一 false");
  assert.equal(school.unlockAt, "", "上游没给 unlock_at → 归一空串");
});

test("mpBase：小程序埋点指纹逐字对齐", () => {
  const base = mpBase("u-1234567890abcdefXYZ", "测试账号", 1_760_000_000_000);
  assert.equal(base.timestamp, 1_760_000_000_000);
  assert.equal(base.ideType, "WorkBuddy_MP");
  assert.equal(base.ideVersion, "2.4.0");
  assert.equal(base.extName, "workbuddy-mp");
  assert.equal(base.extVersion, "2.4.0");
  assert.equal(base.product, "SaaS");
  assert.equal(base.ideName, "wx_app_cloud");
  assert.equal(base.platform, "mini_program");
  assert.equal(base.source, "mini_program");
  assert.equal(base.os, "android");
  assert.equal(base.osVersion, "14");
  assert.equal(base.arch, "arm64");
  assert.equal(base.machineId, "mp-u-1234567890abcd", "uid 前 16 位");
  assert.equal(base.timezone, "Asia/Shanghai");
  assert.equal(base.userId, "u-1234567890abcdefXYZ");
  assert.equal(base.userNickname, "测试账号");
  // uid 缺省 → guest
  assert.equal(mpBase("", "", 0).machineId, "mp-guest");
});

test("reportMPEvents：mpBase 合并、事件字段优先、MP_REPORT_HEADERS", async () => {
  const clock = fakeClock(NOW);
  const backend = wbBackend({ clock, tasks: [], litRules: {} });
  const ok = await reportMPEvents(
    makeAcct({ uid: "u-abcdef", nickname: "小猫" }),
    [{ eventCode: "chat_request_send", agentName: "mp", timestamp: 42 }],
    { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP },
  );
  assert.equal(ok, true);
  const call = backend.calls.find((c) => c.path === "/v2/report");
  assert.ok(call);
  for (const [k, v] of Object.entries(MP_REPORT_HEADERS)) {
    assert.equal(call.headers[k], v, `MP_REPORT_HEADERS.${k} 覆盖/携带`);
  }
  assert.ok(Array.isArray(call.body) && call.body.length === 1);
  const ev = call.body[0];
  assert.equal(ev.eventCode, "chat_request_send");
  assert.equal(ev.timestamp, 42, "事件体字段优先于 mpBase");
  assert.equal(ev.agentName, "mp");
  assert.equal(ev.ideType, "WorkBuddy_MP", "mpBase 合并进每条事件");
  assert.equal(ev.machineId, "mp-u-abcdef");
  assert.equal(ev.userId, "u-abcdef");
  assert.equal(ev.userNickname, "小猫");
});

test("mpEventForCode：per-code 事件族逐字对齐", () => {
  const cid = "wb-mp-1-Sequential_Tasks_1-0";
  const rid = "req-1-Sequential_Tasks_1-0";
  // 1/3/6/school：chat_request_send（agentName=mp）
  for (const code of ["Sequential_Tasks_1", "Sequential_Tasks_3", "Sequential_Tasks_6", "school_season"]) {
    const ev = mpEventForCode(code, 0, `wb-mp-1-${code}-0`, `req-1-${code}-0`, 1);
    assert.equal(ev.eventCode, "chat_request_send", code);
    assert.equal(ev.agentName, "mp");
    assert.equal(ev.agentType, "main");
    assert.equal(ev["codebuddy.session_id"], `wb-mp-1-${code}-0`, "带点键名逐字保留");
    assert.equal(ev["codebuddy.conversation_request_id"], `req-1-${code}-0`);
    assert.ok(!("requestModelId" in ev), `${code} 不带模型字段`);
  }
  // 2：expert_actual_use WorkspaceBuilder
  const e2 = mpEventForCode("Sequential_Tasks_2", 0, cid, rid, 1);
  assert.equal(e2.eventCode, "expert_actual_use");
  assert.equal(e2.id, "WorkspaceBuilder");
  assert.equal(e2.name, "WorkspaceBuilder");
  assert.equal(e2.expertTitle, "工作台搭建师");
  assert.equal(e2.type, "send_message");
  assert.equal(e2.expertType, "agent");
  assert.equal(e2.extVersion, "2.2.8");
  // 4：automated_task_create_suc
  const e4 = mpEventForCode("Sequential_Tasks_4", 0, cid, rid, 1);
  assert.equal(e4.eventCode, "automated_task_create_suc");
  assert.equal(e4.mode, "CLOUD");
  assert.equal(e4.name, "每日任务提醒");
  assert.equal(e4.scheduleType, "daily");
  // 5：chat_request_send + GLM-5.2
  const e5 = mpEventForCode("Sequential_Tasks_5", 0, cid, rid, 1);
  assert.equal(e5.requestModelId, "glm-5.2");
  assert.equal(e5.requestModelName, "GLM-5.2");
  assert.equal(e5.messageId, "msg-1-0");
  // 其它（Sequential_Tasks_7 等）：无事件构造方式 → null
  assert.equal(mpEventForCode("Sequential_Tasks_7", 0, cid, rid, 1), null);
});

test("acceptMPTasks：MP 头接取与分账", async () => {
  const clock = fakeClock(NOW);
  const backend = wbBackend({
    clock,
    tasks: [task("Sequential_Tasks_1", { status: "not_accepted" })],
    mpOnly: ["Sequential_Tasks_1"],
  });
  const out = await acceptMPTasks(makeAcct(), ["Sequential_Tasks_1"], {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP,
  });
  assert.equal(out.ok, true);
  assert.deepEqual(out.accepted, ["Sequential_Tasks_1"]);
  const call = backend.calls.find((c) => c.path === "/v2/activity/growth/tasks/accept");
  assert.equal(call.headers["X-Client-Platform"], "miniprogram", "接取也走 MP 头");
  assert.deepEqual(call.body.task_codes, ["Sequential_Tasks_1"]);
  const t = backend.state.tasks[0];
  assert.equal(t.accept_status, "accepted");
});

test("claimMPTask：达标领奖 + 未达标 400 → web 回退 + restricted 透传", async () => {
  const clock = fakeClock(NOW);
  // 达标：accepted + current>=target → 领到 credit
  const ok = wbBackend({
    clock,
    tasks: [task("Sequential_Tasks_1", { status: "completed", current: 1, target: 1, reward: 100 })],
    mpOnly: ["Sequential_Tasks_1"],
  });
  const r1 = await claimMPTask(makeAcct(), "Sequential_Tasks_1", {
    now: clock.now, sleep: clock.sleep, fetch: ok.fetchImpl, gap: GAP,
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.credit, 100);
  const c1 = ok.calls.find((c) => c.path === "/activity/growth/tasks/Sequential_Tasks_1/claim");
  assert.equal(c1.headers["X-Client-Platform"], "miniprogram", "领奖走 MP 头");

  // 未达标：chat 域 400 → web 域回退也 400 → ok:false
  const bad = wbBackend({
    clock,
    tasks: [task("Sequential_Tasks_1", { status: "accepted", current: 0, target: 1 })],
    mpOnly: ["Sequential_Tasks_1"],
  });
  const r2 = await claimMPTask(makeAcct(), "Sequential_Tasks_1", {
    now: clock.now, sleep: clock.sleep, fetch: bad.fetchImpl, gap: GAP,
  });
  assert.equal(r2.ok, false);
  assert.ok(r2.reason.includes("task not completed"));
  assert.ok(bad.calls.some((c) => c.host === "www.workbuddy.cn" && c.path.includes("/claim")), "400 → web 回退一次");

  // restricted
  const rst = wbBackend({ clock, restrictedUids: ["u-12345678"] });
  const r3 = await claimMPTask(makeAcct(), "Sequential_Tasks_1", {
    now: clock.now, sleep: clock.sleep, fetch: rst.fetchImpl, gap: GAP,
  });
  assert.equal(r3.ok, false);
  assert.equal(r3.restricted, true);
});

test("runMiniProgramTasks：全流程（发现、接取、点亮、领奖）与日志", async () => {
  const clock = fakeClock(NOW);
  const backend = wbBackend({
    clock,
    tasks: mpSeed(),
    mpOnly: mpSeed().map((t) => t.task_code),
    litRules: mpLitRules(),
  });
  const res = await runMiniProgramTasks(makeAcct({ uid: "u-1234567890abcdef00" }), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP,
  });
  const text = res.logs.join("\n");
  assert.equal(res.ok, true, text);
  assert.ok(text.includes("📱 发现 7 个小程序成长任务"), text);
  assert.ok(text.includes("正在点亮小程序任务 [小程序对话] (需上报 1 次)"), text);
  assert.ok(text.includes("正在点亮小程序任务 [小程序对话5次] (需上报 5 次)"), text);
  assert.ok(text.includes("正在点亮小程序任务 [小程序对话10次] (需上报 10 次)"), text);
  assert.ok(text.includes("✓ 小程序任务 [小程序对话] 点亮并领奖成功: +100 积分"), text);
  assert.equal(res.earnedCredit, 100 + 200 + 300 + 100 + 100 + 400 + 100);
  assert.equal(res.claimed, 7);
  assert.equal(res.lit, 7);

  // 全部任务领奖
  for (const t of backend.state.tasks) assert.equal(t.accept_status, "claimed", t.task_code);

  // 上报形状：MP 事件全走一次 report 批量（每个任务一批）；chat 事件 agentName=mp
  const mpReps = backend.state.reports.filter((e) => e.ideType === "WorkBuddy_MP");
  const chat = mpReps.filter((e) => e.eventCode === "chat_request_send");
  assert.equal(chat.length, 1 + 5 + 1 + 10 + 1, "1/3/5/6/school 的全部 chat 事件");
  assert.ok(chat.every((e) => e.agentName === "mp" && e.agentType === "main"));
  // id 形态（hub 口径）：cid=wb-mp-<now>-<code>-<i>、rid=req-…、mid=msg-<now>-<i>
  const s1ev = chat.find((e) => e.conversationId.endsWith("Sequential_Tasks_1-0"));
  assert.ok(s1ev, "Sequential_Tasks_1 的事件在");
  assert.match(s1ev.conversationId, /^wb-mp-\d+-Sequential_Tasks_1-0$/);
  assert.match(s1ev.requestId, /^req-\d+-Sequential_Tasks_1-0$/);
  assert.match(s1ev.messageId, /^msg-\d+-\d+$/, "messageId 带 now（不是 undefined）");
  assert.equal(s1ev.traceId, s1ev.requestId);
  assert.equal(s1ev.rootRequestId, s1ev.requestId);
  assert.equal(s1ev.parentConversationId, s1ev.conversationId);
  const glm = mpReps.filter((e) => e.requestModelName === "GLM-5.2");
  assert.equal(glm.length, 1, "Sequential_Tasks_5 恰好一条 GLM-5.2 事件");
  const expert = mpReps.filter((e) => e.eventCode === "expert_actual_use");
  assert.equal(expert.length, 1);
  assert.equal(expert[0].id, "WorkspaceBuilder");
  const auto = mpReps.filter((e) => e.eventCode === "automated_task_create_suc");
  assert.equal(auto.length, 1);
  const cta = mpReps.filter((e) => e.eventCode === "playbook_prompt_send");
  assert.equal(cta.length, 0, "MP 链路不发 playbook 事件（那是 web 侧 TASK_SPECS 的事）");

  // report 请求头与批量性
  const reportCalls = backend.calls.filter((c) => c.path === "/v2/report");
  assert.ok(reportCalls.length >= 5, "每个任务一批 report");
  for (const c of reportCalls) {
    assert.equal(c.headers["X-Client-Platform"], "mp-weixin");
    assert.equal(c.headers["X-Client-Product"], "workbuddy-mp");
    assert.ok(Array.isArray(c.body), "body 是事件数组");
  }
});

test("runMiniProgramTasks：任意两次上游调用间隔 ≥ gap（假时钟）", async () => {
  const clock = fakeClock(NOW);
  const backend = wbBackend({
    clock,
    tasks: mpSeed(),
    mpOnly: mpSeed().map((t) => t.task_code),
    litRules: mpLitRules(),
  });
  await runMiniProgramTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP,
  });
  const calls = backend.calls;
  assert.ok(calls.length > 10, `应有大量上游调用（7 任务 × 上报+领奖），实际 ${calls.length}`);
  for (let i = 1; i < calls.length; i++) {
    const delta = calls[i].at - calls[i - 1].at;
    assert.ok(delta >= GAP, `第 ${i - 1}→${i} 次调用间隔 ${delta}ms < ${GAP}ms: ${calls[i - 1].path} → ${calls[i].path}`);
  }
});

test("runMiniProgramTasks：接取被锁时记录上游原因、不领奖", async () => {
  const clock = fakeClock(NOW);
  const backend = wbBackend({
    clock,
    tasks: [task("Sequential_Tasks_2", { title: "小程序专家对话", status: "not_accepted", target: 1, reward: 200 })],
    mpOnly: ["Sequential_Tasks_2"],
    litRules: { expert_actual_use: "Sequential_Tasks_2" },
  });
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname.endsWith("/tasks/accept")) {
      return {
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: { results: [{ task_code: "Sequential_Tasks_2", status: "error", message: "task locked until 2026-11-07" }] },
        }),
      };
    }
    return backend.fetchImpl(url, init);
  };
  const res = await runMiniProgramTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: fetchImpl, gap: GAP,
  });
  const text = res.logs.join("\n");
  assert.equal(res.ok, true);
  assert.match(text, /小程序任务接取失败/);
  assert.match(text, /task locked until 2026-11-07/);
  assert.equal(backend.state.claims.length, 0);
});

test("runMiniProgramTasks：claimed 跳过、completed 直接领奖、not_accepted 接取后点亮", async () => {
  const clock = fakeClock(NOW);
  const backend = wbBackend({
    clock,
    tasks: [
      task("Sequential_Tasks_1", { title: "小程序对话", status: "claimed", current: 1, target: 1, reward: 100 }),
      task("Sequential_Tasks_4", { title: "小程序定时任务", status: "completed", current: 1, target: 1, reward: 100 }),
      task("school_season", { title: "校园日活动", status: "not_accepted", target: 1, reward: 100 }),
    ],
    mpOnly: ["Sequential_Tasks_1", "Sequential_Tasks_4", "school_season"],
    litRules: { chat_request_send: "school_season", automated_task_create_suc: "Sequential_Tasks_4" },
  });
  const res = await runMiniProgramTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP,
  });
  const text = res.logs.join("\n");
  assert.equal(res.ok, true, text);
  // claimed：不重复领奖（wbBackend claim 对已领的回 400），并明确记一行跳过
  assert.ok(text.includes("✓ 小程序任务 [小程序对话] 已领奖，跳过"), text);
  assert.ok(!backend.state.claims.includes("Sequential_Tasks_1"), "已领奖的任务不再领");
  assert.ok(!text.includes("[小程序定时任务] 点亮并领奖成功"), "completed 分支只领奖不点亮");
  assert.ok(text.includes("✓ 小程序任务 [小程序定时任务] 领奖成功: +100 积分"), text);
  // not_accepted：先 MP 接取，重新拉清单后点亮领奖
  assert.ok(text.includes("✓ 已接取小程序任务: school_season"), text);
  assert.ok(text.includes("✓ 小程序任务 [校园日活动] 点亮并领奖成功: +100 积分"), text);
  assert.equal(res.earnedCredit, 200);
  assert.equal(res.lit, 1);
  assert.equal(res.claimed, 2);
});

test("runMiniProgramTasks：无任务 / 不支持的任务 → 空结果零请求（codes 交集外不拉清单）", async () => {
  const clock = fakeClock(NOW);
  // 清单为空
  const empty = wbBackend({ clock, tasks: [], litRules: {} });
  const r1 = await runMiniProgramTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: empty.fetchImpl, gap: GAP,
  });
  assert.deepEqual(r1, { ok: true, logs: [], earnedCredit: 0, lit: 0, claimed: 0 });
  assert.equal(empty.calls.length, 1, "只有一次清单查询");

  // 清单里只有 web 任务（无 MP code）→ 拉一次后立即返回
  const webOnly = wbBackend({ clock, tasks: [task("create_canvas", { status: "accepted" })], litRules: {} });
  const r2 = await runMiniProgramTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: webOnly.fetchImpl, gap: GAP,
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.earnedCredit, 0);
  assert.equal(webOnly.calls.length, 1, "无 MP 任务 → 拉一次清单即收");

  // codes 勾选不含任何 MP code → 连清单都不拉
  const none = wbBackend({ clock, tasks: mpSeed(), mpOnly: mpSeed().map((t) => t.task_code), litRules: {} });
  const r3 = await runMiniProgramTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: none.fetchImpl, gap: GAP,
    codes: ["create_canvas", "chat_5"],
  });
  assert.equal(r3.ok, true);
  assert.equal(none.calls.length, 0, "选中集合与 MP 无交集 → 一次上游都不发");
});

test("runMiniProgramTasks：codes 勾选只处理选中的 MP 交集", async () => {
  const clock = fakeClock(NOW);
  const backend = wbBackend({
    clock,
    tasks: mpSeed(),
    mpOnly: mpSeed().map((t) => t.task_code),
    // litRules 直指 Seq3：本用例只勾选它，事件不会被未勾选任务截胡
    litRules: { chat_request_send: "Sequential_Tasks_3" },
  });
  const res = await runMiniProgramTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP,
    codes: ["Sequential_Tasks_3", "nope"],
  });
  const text = res.logs.join("\n");
  assert.equal(res.ok, true, text);
  assert.ok(text.includes("📱 发现 1 个小程序成长任务"), text);
  assert.ok(text.includes("正在点亮小程序任务 [小程序对话5次] (需上报 5 次)..."), text);
  assert.ok(!text.includes("小程序专家对话"), "未选中的任务完全不动作");
  assert.equal(res.earnedCredit, 300);
  // 未选中的任务原封不动
  const s1 = backend.state.tasks.find((t) => t.task_code === "Sequential_Tasks_1");
  assert.equal(s1.accept_status, "accepted");
  assert.equal(s1.current, 0);
});

test("runMiniProgramTasks：清单自带 locked:true 的任务整条跳过（不传 lockedCodes 也生效）", async () => {
  const clock = fakeClock(NOW);
  // 实测账号 B ST3 实测形态：not_accepted + locked:true + unlock_at(+08:00)
  const backend = wbBackend({
    clock,
    tasks: [
      task("Sequential_Tasks_3", {
        title: "小程序对话5次", status: "not_accepted", target: 5, reward: 300,
        locked: true, unlock_at: "2026-11-08T00:00:00+08:00",
      }),
      task("Sequential_Tasks_1", { title: "小程序对话", status: "not_accepted", target: 1, reward: 100 }),
      task("school_season", { title: "校园日活动", status: "accepted", target: 1, reward: 100 }),
    ],
    mpOnly: ["Sequential_Tasks_3", "Sequential_Tasks_1", "school_season"],
    litRules: { chat_request_send: ["Sequential_Tasks_1", "school_season"] },
  });
  const res = await runMiniProgramTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP,
  });
  const text = res.logs.join("\n");
  assert.equal(res.ok, true, text);
  // 跳过日志（与 lockedCodes 跳过同一行口径）
  assert.ok(text.includes("⏳ 小程序任务 [小程序对话5次] 到第二天才能接取任务，跳过"), text);

  // accept 批次只含未锁定任务（ST3 被剔除）；不 report/claim ST3
  const acceptCall = backend.calls.find((c) => c.path === "/v2/activity/growth/tasks/accept");
  assert.ok(acceptCall, "ST1 未锁定 → 照常发起接取批次");
  assert.deepEqual(acceptCall.body.task_codes, ["Sequential_Tasks_1"], "锁定任务不进接取批次");
  const st3 = backend.state.tasks.find((t) => t.task_code === "Sequential_Tasks_3");
  assert.equal(st3.accept_status, "not_accepted", "锁定任务状态原封不动");
  assert.equal(st3.current, 0, "锁定任务不上报（进度不动）");
  assert.equal(backend.state.claims.includes("Sequential_Tasks_3"), false, "锁定任务不领奖");
  // 未锁定任务照常接取/点亮/领奖
  assert.deepEqual(backend.state.claims, ["Sequential_Tasks_1", "school_season"]);
  assert.equal(res.earnedCredit, 200);
});

test("runMiniProgramTasks：claimed 优先于锁判断（陈旧锁记录不挡「已领奖，跳过」）", async () => {
  const clock = fakeClock(NOW);
  const backend = wbBackend({
    clock,
    tasks: [
      task("Sequential_Tasks_1", { title: "小程序对话", status: "claimed", current: 1, target: 1, reward: 100 }),
    ],
    mpOnly: ["Sequential_Tasks_1"],
    litRules: {},
  });
  // 旧缓存形态：claimed 但清单里仍带 locked:true（异常/陈旧数据）
  const fetchImpl = async (url, init) => {
    const res = await backend.fetchImpl(url, init);
    if (new URL(url).pathname === "/v2/activity/growth/tasks") {
      const body = JSON.parse(await res.text());
      for (const t of body.data.tasks) t.locked = true;
      return { status: res.status, text: async () => JSON.stringify(body) };
    }
    return res;
  };
  const res = await runMiniProgramTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: fetchImpl, gap: GAP,
    lockedCodes: ["Sequential_Tasks_1"], // 双来源都命中
  });
  const text = res.logs.join("\n");
  assert.equal(res.ok, true, text);
  assert.ok(text.includes("✓ 小程序任务 [小程序对话] 已领奖，跳过"), text);
  assert.ok(!text.includes("到第二天才能接取任务"), "claimed 不被锁字段挡住");
  assert.equal(backend.state.claims.includes("Sequential_Tasks_1"), false, "已领奖不再重复领");
});

test("runGrowthTasks 集成：2b 在普通任务之后、猫猫旅行之前；收益并入 totals", async () => {
  const clock = fakeClock(NOW);
  const webSeed = [task("create_canvas", { reward: 300 })];
  const backend = wbBackend({
    clock,
    tasks: [...webSeed, ...mpSeed()],
    mpOnly: mpSeed().map((t) => t.task_code),
    litRules: { wbx_design_canvas_task_create: "create_canvas", ...mpLitRules() },
  });
  const { logs, fn } = collectLog();
  const res = await runGrowthTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, log: fn, gap: GAP,
  });
  const text = logs.join("\n");
  assert.equal(res.ok, true, text);
  // totals：web 300 + MP 全套
  assert.equal(res.earnedCredit, 300 + 100 + 200 + 300 + 100 + 100 + 400 + 100);
  assert.equal(res.lit, 1 + 7);
  assert.equal(res.claimed, 1 + 7);
  // MP 日志并入 growth 腿日志
  assert.ok(text.includes("📱 发现 7 个小程序成长任务"), text);
  assert.ok(text.includes("✓ 小程序任务 [小程序对话] 点亮并领奖成功"), text);
  // 顺序：MP 日志在旅行日志之前（2b → 3 顺手猫猫旅行）
  const mpIdx = text.indexOf("小程序成长任务");
  const travelIdx = text.indexOf("猫猫日常");
  assert.ok(mpIdx >= 0 && travelIdx > mpIdx, "小程序链路先于猫猫旅行");
  // 猫猫旅行在 MP 之后确实发生了（假后端 travel 默认 traveling，查一次状态即可）
  assert.ok(backend.calls.some((c) => c.path === "/activity/growth/buddy/travel/status"), "旅行检查照常");
});

test("runGrowthTasks 集成：mpTasks=false 关闭小程序链路；MP code 不误报缺失", async () => {
  const clock = fakeClock(NOW);
  const webSeed = [task("create_canvas", { reward: 300, status: "accepted" })];
  const backend = wbBackend({
    clock,
    tasks: [...webSeed, task("Sequential_Tasks_1", { status: "accepted" })],
    mpOnly: ["Sequential_Tasks_1"],
    litRules: { wbx_design_canvas_task_create: "create_canvas", chat_request_send: "Sequential_Tasks_1" },
  });
  const { logs, fn } = collectLog();

  // mpTasks=false：无 MP 头的请求、无 MP 日志
  const r1 = await runGrowthTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, log: fn, gap: GAP,
    mpTasks: false,
  });
  assert.equal(r1.ok, true);
  assert.ok(!logs.join("\n").includes("小程序"), "mpTasks=false 无小程序日志");
  assert.equal(
    backend.calls.filter((c) => c.headers["X-Client-Platform"] === "miniprogram").length,
    0,
    "mpTasks=false 绝不发 MP 请求",
  );

  // codes 勾选 MP code：不触发「不在任务表中」误报，MP 链路只处理它
  const clock2 = fakeClock(NOW);
  const backend2 = wbBackend({
    clock: clock2,
    tasks: [...webSeed, task("Sequential_Tasks_1", { title: "小程序对话", status: "accepted" })],
    mpOnly: ["Sequential_Tasks_1"],
    litRules: { wbx_design_canvas_task_create: "create_canvas", chat_request_send: "Sequential_Tasks_1" },
  });
  const logs2 = [];
  const r2 = await runGrowthTasks(makeAcct(), {
    now: clock2.now,
    sleep: clock2.sleep,
    fetch: backend2.fetchImpl,
    log: (l) => typeof l === "string" && logs2.push(l),
    gap: GAP,
    codes: ["Sequential_Tasks_1"],
  });
  const text2 = logs2.join("\n");
  assert.equal(r2.ok, true, text2);
  assert.ok(!text2.includes("不在任务表中"), "MP 专属 code 不算 web 清单缺失");
  assert.ok(text2.includes("✓ 小程序任务 [小程序对话] 点亮并领奖成功"), text2);
  assert.equal(r2.earnedCredit, 100);
});

test("isMPCode：MP_TASK_SPECS 命中或 Sequential_Tasks_ 前缀（TASK_SPECS 命中除外）", () => {
  for (const code of Object.keys(MP_TASK_SPECS)) assert.equal(isMPCode(code), true, code);
  assert.equal(isMPCode("Sequential_Tasks_99"), true, "未收录前缀仍算 MP（兼容缝保留）");
  // 2026-11-11 实测：Sequential_Tasks_7 在 TASK_SPECS（web playbook/PC 灵感功能）
  // —— 前缀兼容分支绝不吃掉它：否则 MP 链路把它当 MP 任务跳过（生成不出
  // playbook 事件），web 流水线又用 web 头去接 → 上游必败 error
  assert.equal(isMPCode("Sequential_Tasks_7"), false, "TASK_SPECS 命中 → 不是 MP 任务");
  assert.equal(isMPCode("create_canvas"), false);
  assert.equal(isMPCode(""), false);
});

// ---- 次日锁（需求 2）---------------------------------------------------------

test("parseMPLock：英文/中文/多余空白都解析出 until；无锁语义或垃圾输入返回 null", () => {
  // 已知形态（2026-11-07 生产实测）
  assert.deepEqual(parseMPLock("task locked until 2026-11-07"), { until: "2026-11-07" });
  // 容忍大小写与多余空白
  assert.deepEqual(parseMPLock("Task  Locked   Until  2026-11-07"), { until: "2026-11-07" });
  assert.deepEqual(parseMPLock("locked until 2026-11-07 00:00"), { until: "2026-11-07" });
  // 中文表述
  assert.deepEqual(parseMPLock("任务锁定至 2026-11-08，请次日再试"), { until: "2026-11-08" });
  assert.deepEqual(parseMPLock("锁到 2026-11-07 才可接取"), { until: "2026-11-07" });
  // 解析不出 → null
  assert.equal(parseMPLock("task locked until"), null, "有锁语义没日期");
  assert.equal(parseMPLock("2026-11-07"), null, "裸日期没有锁语义");
  assert.equal(parseMPLock("task not completed"), null);
  assert.equal(parseMPLock(""), null);
  assert.equal(parseMPLock(null), null);
  assert.equal(parseMPLock(undefined), null);
  // 非法日期 → null
  assert.equal(parseMPLock("task locked until 2026-13-40"), null);
});

test("acceptMPTasks：failures 记录每个失败项的上游原因；锁原因触发 onLock 回调", async () => {
  const clock = fakeClock(NOW);
  const backend = wbBackend({
    clock,
    tasks: [task("Sequential_Tasks_2", { title: "小程序专家对话", status: "not_accepted" })],
    mpOnly: ["Sequential_Tasks_2"],
    litRules: {},
  });
  // 上游对 ST2 的接取回「锁到次日」；对不存在的 code 回 unknown_task
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/tasks/accept")) {
      return {
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: { results: [
            { task_code: "Sequential_Tasks_2", status: "error", message: "task locked until 2026-11-07" },
          ] },
        }),
      };
    }
    return backend.fetchImpl(url, init);
  };
  const locks = [];
  const out = await acceptMPTasks(makeAcct(), ["Sequential_Tasks_2", "nope_nope"], {
    now: clock.now, sleep: clock.sleep, fetch: fetchImpl, gap: GAP,
    onLock: (code, until, reason) => locks.push([code, until, reason]),
  });
  // 批次信封成功 → ok 仍为 true（与 tasks.acceptTasks 同款分账语义：条目级失败
  // 只进 failed/failures，不翻转整批）
  assert.equal(out.ok, true);
  assert.deepEqual(out.failed, ["Sequential_Tasks_2", "nope_nope"], "failed 字符串数组保留（兼容旧调用方）");
  assert.equal(out.failures.length, 2, "failures 与 failed 一一对应");
  assert.equal(out.failures[0].code, "Sequential_Tasks_2");
  assert.match(out.failures[0].message, /task locked until 2026-11-07/);
  assert.equal(out.failures[1].code, "nope_nope");
  // 锁原因回调：code/until/原始 message
  assert.deepEqual(locks, [["Sequential_Tasks_2", "2026-11-07", "task locked until 2026-11-07"]]);
  // 回调抛异常不影响主流程
  const out2 = await acceptMPTasks(makeAcct(), ["Sequential_Tasks_2"], {
    now: clock.now, sleep: clock.sleep, fetch: fetchImpl, gap: GAP,
    onLock: () => { throw new Error("callback boom"); },
  });
  assert.equal(out2.ok, true, "回调异常被吞掉，接取结果照常返回");
  assert.equal(out2.failures.length, 1);
  assert.match(out2.failures[0].message, /task locked until 2026-11-07/);
});

test("runMiniProgramTasks：lockedCodes 整条跳过（不进接取批次、不点亮不领奖），日志有提示", async () => {
  const clock = fakeClock(NOW);
  const backend = wbBackend({
    clock,
    tasks: [
      task("Sequential_Tasks_2", { title: "小程序专家对话", status: "not_accepted", target: 1, reward: 200 }),
      task("Sequential_Tasks_4", { title: "小程序定时任务", status: "accepted", target: 1, reward: 100 }),
    ],
    mpOnly: ["Sequential_Tasks_2", "Sequential_Tasks_4"],
    litRules: { automated_task_create_suc: "Sequential_Tasks_4" },
  });
  const claimed = [];
  const res = await runMiniProgramTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP,
    lockedCodes: ["Sequential_Tasks_2"],
    onClaimed: (code) => claimed.push(code),
  });
  const text = res.logs.join("\n");
  assert.equal(res.ok, true, text);
  // 锁定任务：不进接取批次（本用例 ST2 是唯一的 not_accepted，批次为空 → 连接取
  // 请求都不发）、日志有跳过提示、状态原封不动
  const acceptCall = backend.calls.find((c) => c.path === "/v2/activity/growth/tasks/accept");
  assert.equal(acceptCall, undefined, "锁定任务从接取批次剔除后批次为空 → 不发 accept");
  assert.ok(!backend.state.reports.some((e) => e.task_code === "Sequential_Tasks_2"), "锁定任务不上报");
  assert.ok(text.includes("⏳ 小程序任务 [小程序专家对话] 到第二天才能接取任务，跳过"), text);
  assert.equal(backend.state.tasks.find((t) => t.task_code === "Sequential_Tasks_2").accept_status, "not_accepted");
  assert.equal(backend.state.claims.includes("Sequential_Tasks_2"), false, "锁定任务不领奖");
  // 未锁定的任务照常点亮领奖，onClaimed 回调收到它
  assert.ok(text.includes("✓ 小程序任务 [小程序定时任务] 点亮并领奖成功"), text);
  assert.deepEqual(claimed, ["Sequential_Tasks_4"], "领奖成功回调按 code 上报");
  // 空数组 / 不传 = 无锁，行为与旧版一致
  const backend2 = wbBackend({
    clock, tasks: [task("Sequential_Tasks_2", { status: "not_accepted" })], mpOnly: ["Sequential_Tasks_2"], litRules: {},
  });
  const res2 = await runMiniProgramTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend2.fetchImpl, gap: GAP, lockedCodes: [],
  });
  assert.equal(res2.ok, true);
  assert.ok(!res2.logs.join("\n").includes("跳过"), "空锁清单 → 不跳过");
});

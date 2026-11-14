// tests/runner-codes.test.mjs —— JobRunner 的任务级勾选（CONTRACT §2/§3）回归：
// spec.taskCodes = {uid: string[]} | null；growth 腿把它按账号作为 opts.codes
// 传给 runGrowthTasks（未勾选/不在映射/空清单 = 全部任务）；travel/night 腿无
// 任务码，不受影响。归一化防御（脏输入 → null）也在这里钉死。

import { test } from "node:test";
import assert from "node:assert/strict";

import { JobRunner } from "../engine/runner.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const DAY = localTime(2026, 9, 15, 10, 0);

function twoAccounts() {
  return [
    makeAcct({ key: "workbuddy", uid: "uid-A", nickname: "A" }),
    makeAcct({ key: "workbuddy#b", uid: "uid-B", nickname: "B" }),
  ];
}

function backendFor(clock, litRules = {}) {
  return wbBackend({
    clock,
    tasks: [
      task("create_canvas", { reward: 300 }),
      task("chat_5", { reward: 100, target: 5, status: "accepted" }),
    ],
    litRules,
  });
}

test("runner：taskCodes 按 uid 分流 —— 映射内的账号只做选中任务，映射外的全量", async () => {
  const clock = fakeClock(DAY);
  const backendA = backendFor(clock, { wbx_design_canvas_task_create: "create_canvas", chat_request_send: "chat_5" });
  const backendB = backendFor(clock, { wbx_design_canvas_task_create: "create_canvas", chat_request_send: "chat_5" });
  const fetch = (url, init = {}) =>
    init.headers?.["X-User-Id"] === "uid-B" ? backendB.fetchImpl(url, init) : backendA.fetchImpl(url, init);
  const runner = new JobRunner({
    accounts: twoAccounts(),
    now: clock.now,
    sleep: clock.sleep,
    fetch,
  });
  const job = runner.start({ legs: ["growth"], taskCodes: { "uid-A": ["create_canvas", "chat_5"] } });
  const done = await runner.wait(job.id);
  assert.equal(done.state, "done");

  assert.deepEqual(done.spec.taskCodes, { "uid-A": ["create_canvas", "chat_5"] }, "spec 原样携带归一后的 taskCodes");

  // A：只处理选中的两个任务（create_canvas 接取+点亮、chat_5 点亮）
  assert.deepEqual(backendA.state.claims, ["create_canvas", "chat_5"]);
  assert.ok(
    backendA.state.reports.every((e) => ["chat_request_send", "wbx_design_canvas_task_create"].includes(e.eventCode)),
    "A 不该有专家等其它事件",
  );

  // B：不在映射里 = 全部任务（旧行为：first_buddy 不在任务表，接取批次只含 create_canvas）
  const acceptB = backendB.calls.filter((c) => c.path === "/v2/activity/growth/tasks/accept").map((c) => c.body);
  assert.deepEqual(acceptB[0].task_codes, ["create_canvas"]);
  assert.deepEqual(backendB.state.claims, ["create_canvas", "chat_5"]);
});

test("runner：travel 腿不携带 codes（任务级勾选只作用于 growth 腿）", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({ clock, tasks: [task("create_canvas", { reward: 300 })], litRules: {} });
  const runner = new JobRunner({
    accounts: [makeAcct()],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  // 只跑 travel 腿：勾选存在也不该影响 travel（runCatTravel 不吃 codes，
  // 这里通过「travel 照常闭环」与 growth 腿未运行来验证分流）
  const job = runner.start({ legs: ["travel"], taskCodes: { "u-12345678": ["create_canvas"] } });
  const done = await runner.wait(job.id);
  assert.equal(done.state, "done");
  assert.equal(done.steps[0].leg, "travel");
  assert.equal(done.steps[0].state, "ok");
  // growth 腿没跑：没有任何任务接取/领奖
  assert.equal(backend.state.claims.length, 0);
});

test("runner：taskCodes 归一化 —— 脏输入全部落到 null（= 全部任务）", async () => {
  const clock = fakeClock(DAY);
  const cases = [
    null,
    undefined,
    "uid-A",
    ["create_canvas"],
    42,
    {},
    { "uid-A": [] },
    { "": ["create_canvas"] },
    { "uid-A": "create_canvas" },
    { "uid-A": [123, null, ""] },
  ];
  for (const taskCodes of cases) {
    const runner = new JobRunner({ accounts: [], now: clock.now, sleep: clock.sleep });
    const job = runner.start({ legs: ["growth"], taskCodes });
    assert.equal(
      job.spec.taskCodes,
      null,
      `taskCodes=${JSON.stringify(taskCodes)} 应归一成 null`,
    );
    await runner.wait(job.id);
  }
  // 值清洗：去重、剔非字符串、留非空字符串
  const runner2 = new JobRunner({ accounts: [], now: clock.now, sleep: clock.sleep });
  const job2 = runner2.start({
    legs: ["growth"],
    taskCodes: { "uid-A": ["create_canvas", "create_canvas", "", null, 7, " chat_5 "] },
  });
  assert.deepEqual(job2.spec.taskCodes, { "uid-A": ["create_canvas", "chat_5"] });
  await runner2.wait(job2.id);
});

test("runner：taskCodes 清单上限 500（与 daemon 的 API 边界同款）", () => {
  const clock = fakeClock(DAY);
  const runner = new JobRunner({ accounts: [], now: clock.now, sleep: clock.sleep });
  const big = Array.from({ length: 600 }, (_, i) => `code_${i}`);
  const job = runner.start({ legs: ["growth"], taskCodes: { "uid-A": big } });
  assert.equal(job.spec.taskCodes["uid-A"].length, 500);
  void clock;
});

// ---- codes 的两套命名空间（CONTRACT §11.6）--------------------------------------
// 勾选清单是混着的：成长/小程序的裸 code，以及活动任务的 `<activityCode>:<taskCode>`
// （含冒号）。runner 必须**按腿过滤**，且筛完为空时**整腿跳过** —— 绝不能把空数组
// 传给引擎（引擎把「空/未传」当「全部」，那会让「只勾了活动任务」变成「把所有成长
// 任务跑一遍」的反向放大）。

test("runner：codes 按腿过滤 —— 活动任务码（含冒号）只在 campaign 腿生效，不进 growth 接取批次", async () => {
  const clock = fakeClock(DAY);
  const backend = backendFor(clock, { wbx_design_canvas_task_create: "create_canvas", chat_request_send: "chat_5" });
  const runner = new JobRunner({
    accounts: [makeAcct({ uid: "uid-A", nickname: "A" })],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({
    legs: ["growth", "campaign"],
    taskCodes: { "uid-A": ["chat_5", "campaign_starbucks_2026:ai_chat"] },
  });
  const done = await runner.wait(job.id);

  // growth：裸 code 照常处理（chat_5 已是 accepted，所以走点亮/领奖而不是接取），
  //         活动码（含冒号）绝不能出现在 growth 侧的任何请求体里
  assert.ok(backend.state.claims.includes("chat_5"), "裸 code 应当被正常处理（走到领奖）");
  const growthCalls = backend.calls.filter((c) => String(c.path).startsWith("/v2/activity/growth/"));
  assert.ok(growthCalls.length >= 1, "growth 腿应当发过请求");
  for (const c of growthCalls) {
    assert.ok(
      !JSON.stringify(c.body ?? "").includes(":"),
      `活动码不得出现在 growth 侧请求体：${c.path} ${JSON.stringify(c.body)?.slice(0, 80)}`,
    );
  }

  // campaign：只查勾中的活动（reporter 一次都不查）
  const reads = backend.calls.filter((c) => c.path === "/portal/activity/tasks" && c.method === "GET");
  assert.ok(reads.length >= 1, "campaign 腿应当读过活动清单");
  for (const c of reads) {
    assert.match(String(c.url), /campaign_starbucks_2026/, "只读勾中的活动");
    assert.ok(!String(c.url).includes("campaign_reporter_2026"), "没勾的活动不得被读取");
  }
  void done;
});

test("runner：只勾活动任务时 growth 腿整腿跳过（绝不传空数组 = 全部）", async () => {
  const clock = fakeClock(DAY);
  const backend = backendFor(clock, {});
  const runner = new JobRunner({
    accounts: [makeAcct({ uid: "uid-A", nickname: "A" })],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({
    legs: ["growth", "campaign"],
    taskCodes: { "uid-A": ["campaign_starbucks_2026:ai_chat"] },
  });
  const done = await runner.wait(job.id);

  const growthStep = done.steps.find((s) => s.leg === "growth");
  assert.equal(growthStep?.state, "skip", "growth 腿该被整腿跳过");
  assert.match(String(growthStep?.detail ?? ""), /不属于这条腿/);
  assert.equal(
    backend.calls.filter((c) => c.path === "/v2/activity/growth/tasks").length,
    0,
    "跳过时连成长任务清单都不该拉（这是「空数组=全部」的反向放大防护）",
  );
});

// ---- 三套命名空间各归各腿（CONTRACT §11.6；2026-11-14 实测修正）-------------------
// 之前把「非冒号码」一律当成 growth/mp 共用，结果：只勾了一个成长任务，mp 腿也拿到那串码
// → 空跑一遍却显示「完成」，用户以为小程序任务被跑了。现在：mp 腿只接 MP 专属码
// （isMPCode 同一判定源），且当本次 job 含 mp 腿时 growth 不再重复拿 MP 码。

test("runner：只勾成长任务时 mp 腿整腿跳过（不再空跑成「完成」）", async () => {
  const clock = fakeClock(DAY);
  const backend = backendFor(clock, { chat_request_send: "chat_5" });
  const runner = new JobRunner({
    accounts: [makeAcct({ uid: "uid-A", nickname: "A" })],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({
    legs: ["growth", "mp", "campaign"],
    taskCodes: { "uid-A": ["chat_5"] },
  });
  const done = await runner.wait(job.id);

  const mpStep = done.steps.find((s) => s.leg === "mp");
  assert.equal(mpStep?.state, "skip", "mp 腿不该被跑（选中的码里没有 MP 专属码）");
  assert.match(String(mpStep?.detail ?? ""), /不属于这条腿/);
  const growthStep = done.steps.find((s) => s.leg === "growth");
  assert.equal(growthStep?.state, "ok", "growth 腿照常做选中的成长任务");
});

test("runner：只勾 MP 专属码时 —— mp 腿跑、growth 腿跳过（MP 码不再被 growth 重复拿）", async () => {
  const clock = fakeClock(DAY);
  const backend = backendFor(clock, {});
  const runner = new JobRunner({
    accounts: [makeAcct({ uid: "uid-A", nickname: "A" })],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({
    legs: ["growth", "mp"],
    taskCodes: { "uid-A": ["Sequential_Tasks_1"] },
  });
  const done = await runner.wait(job.id);
  const mpStep = done.steps.find((s) => s.leg === "mp");
  const growthStep = done.steps.find((s) => s.leg === "growth");
  assert.equal(growthStep?.state, "skip", "job 含 mp 腿时，MP 码交给 mp 腿，growth 跳过");
  assert.notEqual(mpStep?.state, "skip", "mp 腿应当拿到这条 MP 码（因下游清单无此任务，结果可能是 ok/完成）");
});

test("runner：job 不含 mp 腿时，MP 码仍交给 growth 腿（2b 分支在同腿内处理小程序任务）", async () => {
  const clock = fakeClock(DAY);
  const backend = backendFor(clock, {});
  const runner = new JobRunner({
    accounts: [makeAcct({ uid: "uid-A", nickname: "A" })],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({ legs: ["growth"], taskCodes: { "uid-A": ["Sequential_Tasks_1"] } });
  const done = await runner.wait(job.id);
  const growthStep = done.steps.find((s) => s.leg === "growth");
  assert.ok(growthStep && growthStep.state !== "skip", "没有 mp 腿时 MP 码归 growth（其 2b 分支负责）");
});

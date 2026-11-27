// tests/pipeline-codes.test.mjs —— 任务级勾选（CONTRACT §3/§6/§7）引擎侧回归。
//
// runGrowthTasks(acct, {codes}) 的口径：
//   - 非空数组 = 只对选中的任务接取/点亮/领奖；未选中的任务完全不动作
//     （不进 auto 前置、不进批量接取批次、不点亮、不领奖）；
//   - 每次 fetchTasks 之后都按选中集合过滤（含接取后的复查重取）；
//   - 选中但任务表里不存在的 code 记一次警告并跳过，绝不硬闯；
//   - 空数组 / 未传 / 非法类型 = 全部任务（旧行为，byte 级不变）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { runGrowthTasks } from "../engine/tasks.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const GAP = 1000;

function collectLog() {
  const logs = [];
  const fn = (line) => {
    if (typeof line === "string") logs.push(line);
  };
  return { logs, fn };
}

// 与 pipeline.test.mjs 同一套种子：auto 前置（first_buddy）+ 两个可点亮 +
// 桌面端专属 + 夜猫子，覆盖勾选对每个阶段的过滤。
const seedTasks = () => [
  task("first_buddy", { task_type: "auto", reward: 300 }),
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
};

function runWith(codes, overrides = {}) {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0)); // 本地 10:00，非夜间
  const backend = wbBackend({ clock, tasks: seedTasks(), litRules, ...overrides });
  const { logs, fn } = collectLog();
  const promise = runGrowthTasks(makeAcct({ uid: "uid-A" }), {
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
    log: fn,
    gap: GAP,
    ...(codes === undefined ? {} : { codes }),
  });
  return { backend, logs, promise };
}

test("codes：只接取/点亮/领奖选中的任务，未选中的完全不动作", async () => {
  // first_buddy 未勾选、不会被点亮 —— litRules 里 chat 事件必须直接映射 chat_5，
  // 否则假后端会把事件全记到未满的 first_buddy 头上（夹具口径，与引擎无关）
  const { backend, logs, promise } = runWith(["create_canvas", "chat_5", "missing_code"], {
    litRules: { wbx_design_canvas_task_create: "create_canvas", chat_request_send: "chat_5" },
  });
  const result = await promise;
  const text = logs.join("\n");

  assert.equal(result.ok, true, text);
  // 日志口径：仅处理选中的 N 项任务（去重后 3 项，含任务表里没有的 missing_code）
  assert.ok(text.includes("仅处理选中的 3 项任务"), text);
  assert.ok(text.includes("不在任务表中"), text);
  assert.ok(text.includes("刷新快照"), text);
  assert.ok(text.includes("missing_code"), text);

  // 批量接取批次里只有选中的 create_canvas（chat_5 已接取、missing_code 不存在、
  // 其余任务未选中）
  const acceptBodies = backend.calls
    .filter((c) => c.path === "/v2/activity/growth/tasks/accept")
    .map((c) => c.body);
  assert.equal(acceptBodies.length, 1);
  assert.deepEqual(acceptBodies[0].task_codes, ["create_canvas"]);

  // 上报事件只有选中的两个任务：create_canvas 1 次 canvas 事件 + chat_5 5 次
  // chat 事件；first_buddy/expert_5 未选中 → 无 auto 前置事件、无专家事件；
  // 黑猫/富猫未选中 → 无夜间事件
  const codes = backend.state.reports.map((e) => e.eventCode);
  assert.deepEqual(
    codes.filter((c) => c === "wbx_design_canvas_task_create").length,
    1,
    `create_canvas 只报 1 次 canvas 事件: ${codes}`,
  );
  assert.deepEqual(
    codes.filter((c) => c === "chat_request_send").length,
    5,
    `chat_5 需 5 次上报点亮: ${codes}`,
  );
  assert.ok(!codes.includes("expert_actual_use"), "未选中的 expert_5 不上报");
  assert.ok(backend.state.reports.every((e) => e.mode !== "night"), "未选中的 black_cat 不上报夜间事件");

  // 领奖只有选中的两个（顺序按任务表：create_canvas 在 chat_5 之前）
  assert.deepEqual(backend.state.claims, ["create_canvas", "chat_5"]);
  assert.equal(result.claimed, 2);
  assert.equal(result.lit, 2, "两个选中任务都被点亮后领奖");
  assert.equal(result.earnedCredit, 300 + 100);

  // 未选中任务在假后端里原封不动：没被接取、没被点亮、没被领奖
  const state = (code) => backend.state.tasks.find((t) => t.task_code === code);
  assert.equal(state("first_buddy").accept_status, "not_accepted", "未选中的 auto 前置不被点亮");
  assert.equal(state("expert_5").accept_status, "not_accepted");
  assert.equal(state("RichMeow_Chat").accept_status, "not_accepted");
  assert.equal(state("black_cat").accept_status, "not_accepted");
  assert.equal(state("expert_5").current, 0);
});

test("codes：勾选 auto 任务（first_buddy）→ 只点亮领取它，不进接取批次", async () => {
  const { backend, logs, promise } = runWith(["first_buddy"]);
  const result = await promise;
  const text = logs.join("\n");

  assert.equal(result.ok, true, text);
  assert.ok(text.includes("仅处理选中的 1 项任务"), text);
  assert.deepEqual(backend.state.claims, ["first_buddy"]);
  assert.equal(
    backend.calls.filter((c) => c.path === "/v2/activity/growth/tasks/accept").length,
    0,
    "没有其它选中任务 → 不发生任何接取",
  );
  // 其余任务原封不动
  const state = (code) => backend.state.tasks.find((t) => t.task_code === code);
  assert.equal(state("create_canvas").accept_status, "not_accepted");
  assert.equal(state("chat_5").current, 0);
});

test("codes：选中任务接取成功后的复查重取也按选中集合过滤", async () => {
  // failAcceptOnce：第一批接取整批失败 → 引擎复查后二次补接。两个阶段都只应
  // 包含选中的 code。
  const { backend, logs, promise } = runWith(["create_canvas", "black_cat"], {
    failAcceptOnce: true,
    litRules: { wbx_design_canvas_task_create: "create_canvas" },
  });
  const result = await promise;
  const text = logs.join("\n");

  assert.equal(result.ok, true, text);
  assert.equal(backend.state.acceptCalls, 2, "复查后二次补接");
  const acceptBodies = backend.calls
    .filter((c) => c.path === "/v2/activity/growth/tasks/accept")
    .map((c) => c.body);
  assert.deepEqual(acceptBodies[0].task_codes, ["create_canvas", "black_cat"]);
  assert.deepEqual(acceptBodies[1].task_codes, ["create_canvas", "black_cat"], "补接批次同样只含选中任务");
  assert.deepEqual(backend.state.claims, ["create_canvas"], "黑猫 10:00 不在夜间窗口，诚实跳过（只接取）");
  assert.ok(text.includes("重试接取成功 2 个"), text);
});

test("codes：空数组 / 未传 / 非法类型 = 全部任务（旧行为不变）", async () => {
  const expectedClaims = ["first_buddy", "create_canvas", "expert_5", "chat_5"];
  for (const codes of [undefined, [], "create_canvas", { create_canvas: true }, 42, ["", "   "]]) {
    const { backend, promise } = runWith(codes);
    const result = await promise;
    assert.equal(result.ok, true, `codes=${JSON.stringify(codes)} 应按全量跑`);
    assert.deepEqual(
      backend.state.claims,
      expectedClaims,
      `codes=${JSON.stringify(codes)} 的领奖集合应与旧行为一致`,
    );
    // 全量口径：auto 前置 + 全部未接取任务进批次
    const acceptBodies = backend.calls
      .filter((c) => c.path === "/v2/activity/growth/tasks/accept")
      .map((c) => c.body);
    assert.deepEqual(acceptBodies[0].task_codes, ["create_canvas", "expert_5", "RichMeow_Chat", "black_cat"]);
  }
});

test("codes：选中任务全部不在任务表 → 不接取不点亮不领奖，仍诚实结算", async () => {
  const { backend, logs, promise } = runWith(["nope_1", "nope_2"]);
  const result = await promise;
  const text = logs.join("\n");

  assert.equal(result.ok, true, text);
  assert.ok(text.includes("仅处理选中的 2 项任务"), text);
  assert.ok(text.includes("nope_1"), text);
  assert.equal(backend.calls.filter((c) => c.path === "/v2/activity/growth/tasks/accept").length, 0);
  assert.equal(backend.state.reports.length, 0);
  assert.equal(backend.state.claims.length, 0);
  assert.equal(result.earnedCredit, 0);
  // 猫猫旅行与能量结算照常（growth 腿的收尾不受勾选影响）
  assert.ok(text.includes("猫猫日常"), text);
  assert.ok(text.includes("当前能量"), text);
});

test("codes：勾选对任务表里的重复任务码免疫（去重），空串/非字符串剔除", async () => {
  const { backend, promise } = runWith(["create_canvas", "create_canvas", "", null, 7, " chat_5 "], {
    litRules: { wbx_design_canvas_task_create: "create_canvas", chat_request_send: "chat_5" },
  });
  const result = await promise;
  assert.equal(result.ok, true);
  // " chat_5 " 去空格后命中任务表；空串/null/数字剔除 → 实际选中 2 项
  assert.deepEqual(backend.state.claims, ["create_canvas", "chat_5"]);
  const acceptBodies = backend.calls
    .filter((c) => c.path === "/v2/activity/growth/tasks/accept")
    .map((c) => c.body);
  assert.deepEqual(acceptBodies[0].task_codes, ["create_canvas"]);
});

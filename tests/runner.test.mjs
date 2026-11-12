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

function simpleBackend(clock, overrides = {}) {
  return wbBackend({
    clock,
    tasks: [task("first_buddy", { task_type: "auto", reward: 300 }), task("create_canvas", { reward: 300 })],
    litRules: {
      chat_request_send: "first_buddy",
      wbx_design_canvas_task_create: "create_canvas",
    },
    ...overrides,
  });
}

test("runner：完整 job（两账号 × growth 腿），状态与结算", async () => {
  const clock = fakeClock(DAY);
  // 每个账号一个独立后端（上游状态本来就按账号隔离）
  const backendA = simpleBackend(clock);
  const backendB = simpleBackend(clock);
  const fetch = (url, init = {}) =>
    init.headers?.["X-User-Id"] === "uid-B" ? backendB.fetchImpl(url, init) : backendA.fetchImpl(url, init);
  const saved = [];
  const runner = new JobRunner({
    accounts: twoAccounts(),
    now: clock.now,
    sleep: clock.sleep,
    fetch,
    saveRefresh: (key, patch) => saved.push([key, patch]),
  });
  const job = runner.start({ legs: ["growth"] });
  assert.ok(["queued", "running"].includes(job.state));
  const done = await runner.wait(job.id);

  assert.equal(done.state, "done");
  assert.ok(done.endedAt > done.startedAt);
  assert.equal(done.steps.length, 2);
  for (const step of done.steps) {
    assert.equal(step.leg, "growth");
    assert.equal(step.state, "ok");
    assert.equal(step.credit, 600);
    assert.ok(step.nickname);
    assert.ok(step.at >= done.startedAt);
  }
  assert.deepEqual(done.uids ?? done.spec.uids, null);
  assert.equal(done.totals.credit, 1200);
  // 每日活跃（CONTRACT §7）在开跑前先发一条 chat 事件：litRules 里 chat_request_send
  // 对应 first_buddy，两个账号的 first_buddy 被「每日活跃」提前点亮为 completed，
  // growth 腿直接领奖（claimed 不变、lit 各少 1）—— 4 → 2 是预期移动，不是回归。
  assert.equal(done.totals.tasksLit, 2);
  assert.equal(done.totals.tasksClaimed, 4);
  assert.ok(done.log.some((l) => l.includes("开始为账号")));
  assert.ok(done.log.some((l) => l.includes("每日活跃：已上报")), done.log.join("\n"));
  // 每日活跃打计费域且先于腿（每个账号 job 开始前的固定动作）
  for (const be of [backendA, backendB]) {
    const dailyCalls = be.calls.filter((c) => c.host === "www.codebuddy.cn" && c.path === "/v2/report");
    assert.equal(dailyCalls.length, 1, "每账号一条每日活跃（同北京日首发）");
    assert.equal(be.calls[0].path, "/v2/report", "腿的任何调用之前先发每日活跃");
    assert.equal(be.calls[0].host, "www.codebuddy.cn");
  }
  assert.equal(saved.length, 0, "token 未临期不刷新");
  // 两账号之间 1.5s（manual）
  const aSteps = done.steps.filter((s) => s.uid === "uid-A");
  const bSteps = done.steps.filter((s) => s.uid === "uid-B");
  assert.ok(bSteps[0].at - aSteps.at(-1).at >= 1500);
});

test("runner：job 顶层 trigger = 归一后的 spec.trigger（schedule|manual；非法值按 manual）", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock);
  const runner = new JobRunner({
    accounts: twoAccounts(),
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  // 排程口径（daemon.checkScheduler → startJob 传 trigger:"schedule"）
  const scheduled = runner.start({ legs: ["growth"], trigger: "schedule" });
  assert.equal(scheduled.trigger, "schedule", "顶层 trigger 直接可读（/api/jobs、看板不必钻 spec）");
  assert.equal(scheduled.spec.trigger, "schedule");
  assert.equal(scheduled.trigger, scheduled.spec.trigger, "顶层与 spec 永远一致（同一份归一值）");
  await runner.wait(scheduled.id);

  // 缺省 = manual（daemon 手动 /api/run 不传 trigger）
  const manual = runner.start({ legs: ["growth"] });
  assert.equal(manual.trigger, "manual");
  assert.equal(manual.spec.trigger, "manual");
  await runner.wait(manual.id);

  // 非法值：normalizeSpec 兜底成 manual，绝不透出第三种拼写
  const bogus = runner.start({ legs: ["growth"], trigger: "bogus" });
  assert.equal(bogus.trigger, "manual");
  assert.equal(bogus.spec.trigger, "manual");
  await runner.wait(bogus.id);
});

test("runner：两个 start() → 第二个 409", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock);
  let releaseGap;
  const gate = new Promise((resolve) => {
    releaseGap = resolve;
  });
  let gated = false;
  const runner = new JobRunner({
    accounts: twoAccounts(),
    now: clock.now,
    fetch: backend.fetchImpl,
    sleep: async (ms) => {
      await clock.sleep(ms);
      if (ms >= 1500) {
        gated = true; // 卡在账号间隔上，job 保持 running
        await gate;
      }
    },
  });
  const job1 = runner.start({ legs: ["growth"] });
  // 等 job1 跑完账号 A 并卡在账号间隔
  for (let i = 0; i < 200 && !gated; i++) await new Promise((r) => setImmediate(r));
  assert.ok(gated, "job1 应该正卡在账号间隔上");
  assert.equal(runner.current().id, job1.id);
  assert.throws(() => runner.start({ legs: ["growth"] }), (err) => err.status === 409 && err.code === "busy");
  releaseGap();
  const done = await runner.wait(job1.id);
  assert.equal(done.state, "done");
  // 现在可以再跑
  const job2 = runner.start({ legs: ["travel"] });
  await runner.wait(job2.id);
  assert.equal(job2.state, "done");
});

test("runner：stop() 在步骤边界中止", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock);
  let releaseGap;
  const gate = new Promise((resolve) => {
    releaseGap = resolve;
  });
  let gated = false;
  const runner = new JobRunner({
    accounts: twoAccounts(),
    now: clock.now,
    fetch: backend.fetchImpl,
    sleep: async (ms) => {
      await clock.sleep(ms);
      if (ms >= 1500 && !gated) {
        gated = true;
        await gate;
      }
    },
  });
  const job = runner.start({ legs: ["growth", "night"] });
  for (let i = 0; i < 200 && !gated; i++) await new Promise((r) => setImmediate(r));
  const stopped = runner.stop();
  assert.equal(stopped.id, job.id);
  releaseGap();
  const done = await runner.wait(job.id);
  assert.equal(done.state, "done");
  assert.equal(done.stopped, true);
  assert.deepEqual(done.steps.map((s) => s.uid), ["uid-A"], "B 账号还没开始就被取消了");
  assert.ok(done.log.some((l) => l.includes("取消")));
});

test("runner：403/11140 → 冻结账号（不再自动恢复），本轮跳过该账号", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock, { restrictedUids: ["uid-A"] });
  const onFrozen = [];
  const runner = new JobRunner({
    accounts: twoAccounts(),
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
    onFrozen: (uid, entry) => onFrozen.push([uid, entry]), // daemon 据此落盘 state/frozen.json
  });
  const job = runner.start({ legs: ["growth"] });
  const done = await runner.wait(job.id);
  const aStep = done.steps.find((s) => s.uid === "uid-A");
  const bStep = done.steps.find((s) => s.uid === "uid-B");
  assert.equal(aStep.state, "fail");
  assert.match(aStep.detail, /未能获取到任务清单|风控|restricted|失败/);
  assert.equal(bStep.state, "ok");
  // frozen 形状（CONTRACT §10.5）：[{uid, at:ISO, code, message}] —— 不再有
  // releasedAt/自动恢复，冻结只有 unfreeze 能解除。
  const frozen = runner.frozen();
  assert.equal(frozen.length, 1);
  assert.equal(frozen[0].uid, "uid-A");
  assert.equal(frozen[0].code, 11140);
  assert.ok(!Number.isNaN(Date.parse(frozen[0].at)), "at 是冻结时刻的 ISO 串");
  assert.ok(typeof frozen[0].message === "string");
  // onFrozen 回调（daemon 落盘 state/frozen.json 的接线）收到同一条记录
  assert.deepEqual(onFrozen.map(([uid]) => uid), ["uid-A"]);
  assert.ok(done.log.some((l) => l.includes("风控限制")));

  // 冻结中的账号下一轮直接 skip（绝不重试 —— 冷却期语义已废弃）
  const job2 = runner.start({ legs: ["growth"], uids: ["uid-A"] });
  const done2 = await runner.wait(job2.id);
  assert.equal(done2.steps.length, 1);
  assert.equal(done2.steps[0].state, "skip");
  assert.match(done2.steps[0].detail, /已冻结/);
  // 多次 restricted 不覆盖第一次的记录（第一现场的 at/message 保留）
  const atBefore = runner.frozen()[0].at;
  runner.freeze("uid-A", { code: 11140, message: "again" });
  assert.equal(runner.frozen()[0].at, atBefore, "重复冻结不覆盖记录");
});

test("runner：freeze/unfreeze/frozen 的精确形状（注入时钟）", async () => {
  const clock = fakeClock(DAY);
  const runner = new JobRunner({ accounts: [], now: clock.now, sleep: clock.sleep });
  assert.deepEqual(runner.frozen(), [], "初始无冻结");
  assert.equal(runner.isFrozen("uid-X"), false);
  runner.freeze("uid-X", { code: 11140, message: "request illegal" });
  assert.deepEqual(runner.frozen(), [
    { uid: "uid-X", at: new Date(DAY).toISOString(), code: 11140, message: "request illegal" },
  ]);
  assert.equal(runner.isFrozen("uid-X"), true);
  // 没有 unfreeze 之前永远冻结（hub v2.1.0：绝不自动恢复）
  clock.advance(30 * 86400000);
  assert.equal(runner.isFrozen("uid-X"), true, "冻结没有过期语义");
  // 解除后再冻结 → 新记录
  assert.equal(runner.unfreeze("uid-X"), true);
  assert.deepEqual(runner.frozen(), []);
  assert.equal(runner.unfreeze("uid-X"), false, "没冻结的 unfreeze 返回 false");
  runner.freeze("uid-X", { code: 403, message: "HTTP 403" });
  assert.equal(runner.frozen()[0].code, 403, "code 可为 403（HTTP 层）");
  // frozenMap 初始数据（daemon 从 state/frozen.json 读入同一份对象）
  const seeded = new JobRunner({
    accounts: [],
    now: clock.now,
    sleep: clock.sleep,
    frozenMap: { "uid-Y": { at: new Date(DAY).toISOString(), code: 11140, message: "seeded" } },
  });
  assert.deepEqual(seeded.frozen(), [
    { uid: "uid-Y", at: new Date(DAY).toISOString(), code: 11140, message: "seeded" },
  ]);
});

test("runner：token 临期 → 刷新 + 原子回写 + 内存合并", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock, {
    refreshTokens: [{ accessToken: "at-brand-new", refreshToken: "rt-brand-new", expiresAt: DAY + 3600_000 }],
  });
  const saved = [];
  const acct = makeAcct({ expires: DAY + 60_000, refresh: "rt-old", access: "at-old" }); // 1 分钟后过期
  const runner = new JobRunner({
    accounts: [acct],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
    saveRefresh: (key, patch) => saved.push({ key, patch }),
  });
  const job = runner.start({ legs: ["travel"] });
  const done = await runner.wait(job.id);
  assert.equal(done.state, "done");
  assert.equal(acct.access, "at-brand-new");
  assert.equal(acct.refresh, "rt-brand-new");
  assert.equal(acct.expires, DAY + 3600_000);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].key, "workbuddy");
  assert.equal(saved[0].patch.access, "at-brand-new");
  assert.ok(done.log.some((l) => l.includes("回写")));
  // 刷新请求确实发出（带 X-Refresh-Token）
  const refreshCall = backend.calls.find((c) => c.path.endsWith("/refresh"));
  assert.ok(refreshCall);
  assert.equal(refreshCall.headers["X-Refresh-Token"], "rt-old");
});

test("runner：uids 过滤与 loadAccounts 注入", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock);
  const runner = new JobRunner({
    loadAccounts: async () => twoAccounts(),
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({ legs: ["growth"], uids: ["uid-B"] });
  const done = await runner.wait(job.id);
  assert.deepEqual(done.steps.map((s) => s.uid), ["uid-B"]);
});

test("runner：腿的顺序固定 growth → travel → night；未知腿剔除", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock);
  const runner = new JobRunner({
    accounts: [makeAcct()],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({ legs: ["night", "bogus", "growth", "travel"] });
  const done = await runner.wait(job.id);
  assert.deepEqual(done.steps.map((s) => s.leg), ["growth", "travel", "night"]);
});

// ---- 需求 1：不勾选猫猫旅行时不许跑旅行 ------------------------------------
// 旅行只由 travel 腿触发：growth 腿显式 travel:false（runGrowthTasks 第 3 步整段
// 跳过，一次 travel/status 都不发）。直调 runGrowthTasks 不传 travel 仍是旧行为
//（默认检查，tests/miniprogram.test.mjs 的集成用例保持覆盖）。

test("runner：legs=[growth] 绝不跑旅行（无 travel/status、无 travel 步骤）", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock);
  const runner = new JobRunner({
    accounts: [makeAcct()],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({ legs: ["growth"] });
  const done = await runner.wait(job.id);
  assert.equal(done.state, "done");
  assert.ok(done.steps.every((s) => s.leg === "growth"), "steps 里没有 travel 腿");
  assert.equal(
    backend.calls.filter((c) => c.path.startsWith("/activity/growth/buddy/travel/")).length,
    0,
    "growth 腿收尾不再发任何 travel 请求（status/depart/claim/config 都不发）",
  );
});

test("runner：legs=[travel] 有且仅有一次 travel/status", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock);
  const runner = new JobRunner({
    accounts: [makeAcct()],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({ legs: ["travel"] });
  const done = await runner.wait(job.id);
  assert.equal(done.state, "done");
  assert.deepEqual(done.steps.map((s) => s.leg), ["travel"]);
  const statusCalls = backend.calls.filter((c) => c.path === "/activity/growth/buddy/travel/status");
  assert.equal(statusCalls.length, 1, "travel/status 恰好一次（travel 腿自己查）");
});

test("runner：legs=[growth,travel] travel/status 仍只有一次（growth 收尾 + travel 腿不重复）", async () => {
  const clock = fakeClock(DAY);
  const backend = simpleBackend(clock);
  const runner = new JobRunner({
    accounts: [makeAcct()],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({ legs: ["growth", "travel"] });
  const done = await runner.wait(job.id);
  assert.equal(done.state, "done");
  assert.deepEqual(done.steps.map((s) => s.leg), ["growth", "travel"]);
  const statusCalls = backend.calls.filter((c) => c.path === "/activity/growth/buddy/travel/status");
  assert.equal(statusCalls.length, 1, "travel/status 只由 travel 腿发一次");
});

// ---- 需求 3：小程序链式任务进排程（mp 腿）----------------------------------

function mpBackend(clock, overrides = {}) {
  // 注意选型：runner 在每账号开跑前会发一条 chat_request_send 的「每日活跃」，
  // litRules 若把 chat_request_send 映射到 MP 任务会把它们提前点亮 —— 这里用
  // expert/automation 事件族的 MP 任务，避开事件码撞车（Daily 活动只发 chat）。
  const mpSeeds = [
    task("Sequential_Tasks_2", { title: "小程序专家对话", target: 1, reward: 200, status: "accepted" }),
    task("Sequential_Tasks_4", { title: "小程序定时任务", target: 1, reward: 100, status: "accepted" }),
  ];
  return wbBackend({
    clock,
    tasks: [task("create_canvas", { reward: 300 }), ...mpSeeds],
    mpOnly: mpSeeds.map((t) => t.task_code), // MP 清单口径：web 清单不含它们
    litRules: {
      wbx_design_canvas_task_create: "create_canvas",
      expert_actual_use: "Sequential_Tasks_2",
      automated_task_create_suc: "Sequential_Tasks_4",
    },
    ...overrides,
  });
}

test("runner：单独 legs=[mp] 只跑小程序链路（不发 web 接取），步骤/收益正确", async () => {
  const clock = fakeClock(DAY);
  const backend = mpBackend(clock);
  const runner = new JobRunner({
    accounts: [makeAcct()],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({ legs: ["mp"] });
  const done = await runner.wait(job.id);
  assert.equal(done.state, "done");
  assert.deepEqual(done.steps.map((s) => s.leg), ["mp"]);
  assert.equal(done.steps[0].state, "ok");
  // 收益：ST2 +200、ST4 +100；detail 取最后一条人读日志
  assert.equal(done.totals.credit, 300);
  assert.equal(done.steps[0].credit, 300);
  assert.ok(done.steps[0].detail.includes("小程序定时任务"), `detail=${done.steps[0].detail}`);
  // web 侧成长任务完全没动：没有任何 web 头族的接取
  const webAccept = backend.calls.filter(
    (c) => c.path === "/v2/activity/growth/tasks/accept" && c.headers["X-Client-Platform"] !== "miniprogram",
  );
  assert.equal(webAccept.length, 0, "mp 腿不发 web tasks 接取");
  assert.deepEqual(backend.state.claims.slice().sort(), ["Sequential_Tasks_2", "Sequential_Tasks_4"], "两个 MP 任务都领奖");
  // create_canvas（web 任务）原封不动
  assert.equal(backend.state.tasks.find((t) => t.task_code === "create_canvas").accept_status, "not_accepted");
});

test("runner：legs=[growth,mp] 小程序任务只执行一次（growth 2b 关闭，由 mp 腿负责）", async () => {
  const clock = fakeClock(DAY);
  const backend = mpBackend(clock);
  const runner = new JobRunner({
    accounts: [makeAcct()],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({ legs: ["growth", "mp"] });
  const done = await runner.wait(job.id);
  assert.equal(done.state, "done");
  assert.deepEqual(done.steps.map((s) => s.leg), ["growth", "mp"]);

  // MP 头族只发生一轮：两个任务都是 accepted，无需接取；report 每个任务一批
  //（共 2 批）、领奖各一次 —— 不是 growth 2b + mp 腿各跑一遍
  const mpAccept = backend.calls.filter(
    (c) => c.path === "/v2/activity/growth/tasks/accept" && c.headers["X-Client-Platform"] === "miniprogram",
  );
  assert.equal(mpAccept.length, 0, "两个 MP 任务都已接取，无接取批次");
  const mpReports = backend.calls.filter(
    (c) => c.path === "/v2/report" && c.headers["X-Client-Platform"] === "mp-weixin",
  );
  assert.equal(mpReports.length, 2, "MP 上报只跑一轮（每任务一批）");
  assert.deepEqual(
    backend.state.claims.slice().sort(),
    ["Sequential_Tasks_2", "Sequential_Tasks_4", "create_canvas"],
    "每个 MP 任务恰好领奖一次 + web 任务一次",
  );

  // growth 腿仍然处理 web 任务（勾选语义不受 mp 腿影响）
  assert.ok(backend.state.claims.includes("create_canvas"), "web 任务由 growth 腿完成");
  assert.equal(done.totals.credit, 300 + 300, "growth web 300 + mp 300");
});

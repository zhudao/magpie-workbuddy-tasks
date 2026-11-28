import { test } from "node:test";
import assert from "node:assert/strict";

import { claimTask, buildEvent, fetchTasks, reportEvents } from "../engine/tasks.mjs";
import { runNightTask, runCatTravel } from "../engine/travel.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const DAY = localTime(2026, 9, 15, 10, 0); // 本地 10:00
const NIGHT = localTime(2026, 9, 15, 23, 30); // 本地 23:30

test("claimTask：chat 域成功", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({
    clock,
    tasks: [task("skill_1", { status: "completed", current: 1 })],
  });
  const res = await claimTask(makeAcct(), "skill_1", {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
  });
  assert.deepEqual({ ok: res.ok, credit: res.credit, energy: res.energy, via: res.via }, {
    ok: true, credit: 100, energy: 0, via: "chat",
  });
  const call = backend.calls.at(-1);
  assert.equal(call.host, "copilot.tencent.com");
  assert.equal(call.path, "/activity/growth/tasks/skill_1/claim");
  assert.deepEqual(call.body, {});
});

test("claimTask：HTTP 400「task not completed」→ 试一次 web 域回退", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({
    clock,
    tasks: [task("skill_1", { status: "completed", current: 1 })],
    chatClaimAlways400: true,
  });
  const res = await claimTask(makeAcct(), "skill_1", {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
  });
  assert.equal(res.ok, true);
  assert.equal(res.via, "web");
  assert.equal(res.credit, 100);

  const claims = backend.calls.filter((c) => c.path.endsWith("/claim"));
  assert.equal(claims.length, 2, "只回退一次");
  assert.equal(claims[0].host, "copilot.tencent.com");
  assert.equal(claims[1].host, "www.workbuddy.cn");
  const h = claims[1].headers;
  assert.equal(h["Origin"], "https://www.workbuddy.cn");
  assert.equal(h["Referer"], "https://www.workbuddy.cn/profile/growth-center");
  assert.equal(h["x-client-platform"], "web");
  assert.equal(h["X-Domain"], "https://www.workbuddy.cn");
  assert.equal(h["Authorization"], "Bearer access-token-abc");
  assert.equal(backend.state.webClaims, 1);
});

test("claimTask：web 回退也失败 → ok:false / via web", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({ clock, tasks: [task("skill_1", {})], chatClaimAlways400: true });
  // 任务未达标：chat 与 web 都回 400
  const res = await claimTask(makeAcct(), "skill_1", {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
  });
  assert.equal(res.ok, false);
  assert.equal(res.via, "web");
  assert.match(res.reason, /task not completed/);
});

test("claimTask：信封 code 400（HTTP 200）也触发 web 回退；其它码不回退", async () => {
  const clock = fakeClock(DAY);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(new URL(url));
    if (calls.length === 1) return { status: 200, text: async () => JSON.stringify({ code: 400, msg: "task not completed" }) };
    return { status: 200, text: async () => JSON.stringify({ code: 0, data: { credit: 5, energy: 1 } }) };
  };
  const res = await claimTask(makeAcct(), "x", { now: clock.now, sleep: clock.sleep, fetch: fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.via, "web");
  assert.equal(res.credit, 5);
  assert.equal(res.energy, 1);

  const calls2 = [];
  const res2 = await claimTask(makeAcct(), "x", {
    now: clock.now, sleep: clock.sleep,
    fetch: async (url) => {
      calls2.push(url);
      return { status: 200, text: async () => JSON.stringify({ code: 500, msg: "boom" }) };
    },
  });
  assert.equal(res2.ok, false);
  assert.equal(res2.via, "chat");
  assert.equal(calls2.length, 1, "code 500 不触发 web 回退");
});

test("夜猫子：白天诚实跳过", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({ clock, tasks: [task("black_cat", { target: 3 })], litRules: { chat_request_send: "black_cat" } });
  const res = await runNightTask(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.earnedCredit, 0);
  assert.match(res.logs.join("\n"), /23:00-08:00/);
  assert.equal(backend.calls.length, 0, "白天一个上游请求都不发");
});

test("夜猫子：夜间未接取 → 先接取再上报，当晚 +1", async () => {
  const clock = fakeClock(NIGHT);
  const backend = wbBackend({
    clock,
    tasks: [task("black_cat", { target: 3 })],
    litRules: { chat_request_send: "black_cat" },
  });
  const logs = [];
  const res = await runNightTask(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
    log: (l) => typeof l === "string" && logs.push(l),
  });
  assert.equal(res.ok, true);
  assert.equal(res.earnedCredit, 0);
  assert.equal(backend.state.acceptCalls, 1, "先接取");
  const acceptIdx = backend.calls.findIndex((c) => c.path.endsWith("/accept"));
  const reportIdx = backend.calls.findIndex((c) => c.path === "/v2/report");
  assert.ok(acceptIdx >= 0 && reportIdx > acceptIdx, "接取先于上报");
  assert.match(logs.join("\n"), /夜猫子任务已接取/);
  assert.match(logs.join("\n"), /今晚 \+1 \(1\/3\)/);
  const ev = backend.state.reports[0];
  assert.equal(ev.eventCode, "chat_request_send");
  assert.equal(ev.requestModelId, "glm-5.2");
  assert.equal(ev.mode, "night");
  assert.ok(ev.userId);
  // 轮询间隔 4s
  const polls = backend.calls.filter((c) => c.path === "/v2/activity/growth/tasks");
  assert.ok(polls.length >= 2);
  assert.ok(polls[1].at - polls[0].at >= 4000);
});

test("夜猫子：达标当晚领奖", async () => {
  const clock = fakeClock(NIGHT);
  const backend = wbBackend({
    clock,
    tasks: [task("black_cat", { target: 3, current: 2, status: "accepted", reward: 100 })],
    litRules: { chat_request_send: "black_cat" },
  });
  const res = await runNightTask(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.earnedCredit, 100);
  assert.deepEqual(backend.state.claims, ["black_cat"]);
  assert.match(res.logs.join("\n"), /夜猫子任务完成 3\/3/);
});

test("夜猫子：已领奖 / 企业号 / 国际版", async () => {
  const clock = fakeClock(NIGHT);
  const backend = wbBackend({ clock, tasks: [task("black_cat", { status: "claimed" })] });
  const done = await runNightTask(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.match(done.logs.join("\n"), /已领奖/);

  const ent = await runNightTask(makeAcct({ enterpriseId: "e1" }), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.match(ent.logs.join("\n"), /企业版/);

  const intl = await runNightTask(makeAcct({ provider: "workbuddy-ai" }), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.equal(intl.ok, false);
});

test("夜猫子：清单暂缺 black_cat → 5s 重试后继续接取/上报", async () => {
  const clock = fakeClock(NIGHT);
  const backend = wbBackend({
    clock,
    tasks: [task("black_cat", { target: 3 })],
    litRules: { chat_request_send: "black_cat" },
  });
  const realTasks = backend.state.tasks;
  const black = realTasks.find((t) => t.task_code === "black_cat");
  backend.state.tasks = realTasks.filter((t) => t !== black);
  let firstList = true;
  const fetchImpl = async (url, init) => {
    const res = await backend.fetchImpl(url, init);
    if (firstList && new URL(url).pathname === "/v2/activity/growth/tasks") {
      firstList = false;
      backend.state.tasks = realTasks; // 第二次起上游已下发 black_cat
    }
    return res;
  };

  const res = await runNightTask(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: fetchImpl,
  });
  assert.equal(res.ok, true);
  assert.match(res.logs.join("\n"), /第 1\/4 次/);
  const lists = backend.calls.filter((c) => c.path === "/v2/activity/growth/tasks");
  assert.ok(lists.length >= 2);
  assert.ok(lists[1].at - lists[0].at >= 5000, "缺失后至少等 5s 再重试");
  assert.equal(backend.state.acceptCalls, 1, "重试拿到任务后照常接取");
  assert.ok(backend.state.reports.length >= 1, "照常上报夜间事件");
});

test("夜猫子：4 次重试都没有 black_cat → 如实跳过，不记失败", async () => {
  const clock = fakeClock(NIGHT);
  const backend = wbBackend({ clock, tasks: [] });
  const res = await runNightTask(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
  });
  assert.equal(res.ok, true, "任务未下发不是失败");
  assert.match(res.logs.join("\n"), /第 4\/4 次/);
  assert.match(res.logs.join("\n"), /未下发，跳过/);
  const lists = backend.calls.filter((c) => c.path === "/v2/activity/growth/tasks");
  assert.equal(lists.length, 4, "共查 4 次");
  assert.equal(backend.state.acceptCalls, 0);
  assert.equal(backend.state.reports.length, 0);
  assert.deepEqual(backend.state.claims, []);
  assert.ok(lists[1].at - lists[0].at >= 5000);
  assert.ok(lists[2].at - lists[1].at >= 15000);
  assert.ok(lists[3].at - lists[2].at >= 30000);
});

test("fetchTasks：失败时日志带 HTTP 原因", async () => {
  const clock = fakeClock(DAY);
  const logs = [];
  const fetchImpl = async () => ({ status: 500, text: async () => JSON.stringify({ code: 500, msg: "boom" }) });
  const tasks = await fetchTasks(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: fetchImpl,
    log: (l) => typeof l === "string" && logs.push(l),
  });
  assert.deepEqual(tasks, []);
  assert.match(logs.join("\n"), /拉取任务清单失败/);
  assert.match(logs.join("\n"), /HTTP 500/);
});


test("猫猫旅行：arrived → 领奖 +20", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({ clock, tasks: [], travel: { state: "arrived" } });
  const res = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.action, "claim");
  assert.equal(res.credit, 20);
  assert.match(res.msg, /领奖成功/);
});

test("猫猫旅行：arrived + claim 403 code 403 no unclaimed travel → 成功 no-op，不冻结", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({ clock, tasks: [], travel: { state: "arrived" } });
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/activity/growth/buddy/travel/claim") {
      return {
        status: 403,
        text: async () => JSON.stringify({ code: 403, msg: "no unclaimed travel" }),
      };
    }
    return backend.fetchImpl(url, init);
  };

  const res = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: fetchImpl });
  assert.equal(res.ok, true, res.msg);
  assert.equal(res.action, "idle");
  assert.equal(res.restricted, undefined, "business no-op 不得透传 restricted");
  assert.match(res.msg, /没有可领取|今日已完成/);
});

test("猫猫旅行：idle → 带 location_id 派出", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({ clock, tasks: [], travel: { state: "idle" } });
  const res = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.action, "depart");
  assert.match(res.msg, /外滩/);
  const depart = backend.calls.find((c) => c.path.endsWith("/travel/depart"));
  assert.deepEqual(depart.body, { location_id: 1 }, "body 必须携带 {location_id}");
  const cfgIdx = backend.calls.findIndex((c) => c.path.endsWith("/travel/config"));
  const departIdx = backend.calls.findIndex((c) => c.path.endsWith("/travel/depart"));
  assert.ok(cfgIdx >= 0 && departIdx > cfgIdx);
});

test("猫猫旅行：no active buddy → 补齐 first_buddy 后重试一次", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({
    clock,
    tasks: [task("first_buddy", { task_type: "auto", reward: 300 })],
    litRules: { chat_request_send: "first_buddy" },
    travel: { state: "idle" },
    buddyDepartFails: 1,
  });
  const logs = [];
  const res = await runCatTravel(makeAcct(), {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl,
    log: (l) => typeof l === "string" && logs.push(l),
  });
  assert.equal(res.ok, true, res.msg);
  assert.equal(res.action, "depart");
  const departs = backend.calls.filter((c) => c.path.endsWith("/travel/depart"));
  assert.equal(departs.length, 2, "派出失败后重试一次");
  // 补 first_buddy：上报 + 领奖都发生过
  assert.deepEqual(backend.state.claims, ["first_buddy"]);
  const fb = backend.state.tasks.find((t) => t.task_code === "first_buddy");
  assert.equal(fb.accept_status, "claimed");
});

test("猫猫旅行：补不了 Buddy → 诚实告知", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({
    clock,
    tasks: [], // 清单里没有 first_buddy → ensureBuddy false
    travel: { state: "idle" },
    buddyDepartFails: 1,
  });
  const res = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.equal(res.ok, false);
  assert.match(res.msg, /还没有 Buddy/);
});

// ---- 良性 403（A5，兄弟实现 88lin/workbuddy-auto-signin 实测口径）----------------
// 上游把「还没领养猫猫」也回 HTTP 403（signin.py:2213：403 + msg 全等
// "no active buddy"）—— 这是业务拒绝不是风控：travel 的判序必须先认它再判
// restricted，否则没养猫的账号会被误冻（runner 对 restricted 立即冻结）。
test("猫猫旅行：HTTP 403 + no active buddy（含大小写/空白变体）→ 走 ensureBuddy 兜底，绝不 restricted", async () => {
  for (const msg of ["no active buddy", " No Active Buddy "]) {
    const clock = fakeClock(DAY);
    const backend = wbBackend({
      clock,
      tasks: [task("first_buddy", { task_type: "auto", reward: 300 })],
      litRules: { chat_request_send: "first_buddy" },
      travel: { state: "idle" },
    });
    // 第一次 depart 回兄弟实现实测的 403 + 业务拒绝文案（wbBackend 只有 400 形状，
    // 这里包一层 fetch 把第一次 depart 换成 403）
    let departs = 0;
    const fetchImpl = async (url, init) => {
      if (new URL(url).pathname === "/activity/growth/buddy/travel/depart") {
        departs += 1;
        if (departs === 1) {
          return { status: 403, text: async () => JSON.stringify({ code: 50001, msg }) };
        }
      }
      return backend.fetchImpl(url, init);
    };
    const res = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: fetchImpl });
    assert.equal(res.ok, true, `${msg}: ${res.msg}`);
    assert.equal(res.action, "depart");
    assert.equal(res.restricted, undefined, `${msg}: 良性 403 不得把「没养猫」冻成风控`);
    assert.equal(departs, 2, "补齐 first_buddy 后重试一次");
    assert.deepEqual(backend.state.claims, ["first_buddy"], "ensureBuddy 兜底真实发生");
  }
});

test("猫猫旅行：真风控 403（未知 msg）→ 仍立即 restricted，不进 ensureBuddy 兜底", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({
    clock,
    tasks: [task("first_buddy", { task_type: "auto", reward: 300 })],
    litRules: { chat_request_send: "first_buddy" },
    travel: { state: "idle" },
  });
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname === "/activity/growth/buddy/travel/depart") {
      return { status: 403, text: async () => JSON.stringify({ code: 50001, msg: "request illegal" }) };
    }
    return backend.fetchImpl(url, init);
  };
  const res = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.restricted, true, "非白名单 403 = 风控，红线不变");
  assert.match(res.msg, /派出旅行失败/);
  assert.deepEqual(backend.state.claims, [], "风控 403 不触发 ensureBuddy 补齐动作");
});

test("猫猫旅行：traveling / daily_limit / 未知状态 / 企业号", async () => {
  const clock = fakeClock(DAY);
  const t1 = wbBackend({ clock, tasks: [], travel: { state: "traveling" } });
  const r1 = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: t1.fetchImpl });
  assert.equal(r1.action, "traveling");

  const t2 = wbBackend({ clock, tasks: [], travel: { state: "idle", daily_limit_reached: true } });
  const r2 = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: t2.fetchImpl });
  assert.equal(r2.action, "idle");
  assert.ok(r2.msg.includes("00:00"));

  const t3 = wbBackend({ clock, tasks: [], travel: { state: "mystery" } });
  const r3 = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: t3.fetchImpl });
  assert.equal(r3.action, "mystery");

  const r4 = await runCatTravel(makeAcct({ enterpriseId: "e1" }), {
    now: clock.now, sleep: clock.sleep, fetch: async () => { throw new Error("no"); },
  });
  assert.equal(r4.action, "skip");
});

// ---- B3：旅行 ETA（arrive_at/server_now，epoch 秒）--------------------------------
test("B3 旅行 ETA：arrive_at-server_now → 「约 N 分钟后回来」；0/\"null\"/过去时刻按缺失或即归", async () => {
  const clock = fakeClock(DAY);
  // 30 分钟后回来：arrive_at = server_now + 1800（epoch 秒，真机口径）
  const t1 = wbBackend({
    clock, tasks: [],
    travel: { state: "traveling", arrive_at: 1763251200 + 1800, server_now: 1763251200 },
  });
  const r1 = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: t1.fetchImpl });
  assert.equal(r1.action, "traveling");
  assert.match(r1.msg, /约 30 分钟后回来/, `msg：${r1.msg}`);

  // arrive_at = 0 / "null" 字符串 / 缺失 → 按缺失，绝不显示 1970/负数
  for (const arrive_at of [0, "null", undefined]) {
    const t = wbBackend({
      clock, tasks: [],
      travel: { state: "traveling", ...(arrive_at !== undefined ? { arrive_at } : {}), server_now: 1763251200 },
    });
    const r = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: t.fetchImpl });
    assert.equal(r.action, "traveling");
    assert.equal(r.msg, "猫猫正在旅行途中，请稍后再来查看！", `arrive_at=${arrive_at} 按缺失：${r.msg}`);
  }

  // 已过返回时间（差值为负）→ 「即将归来」文案，绝不出现负数分钟
  const t2 = wbBackend({
    clock, tasks: [],
    travel: { state: "traveling", arrive_at: 1763251200 - 600, server_now: 1763251200 },
  });
  const r2 = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: t2.fetchImpl });
  assert.match(r2.msg, /即将归来/, `msg：${r2.msg}`);

  // server_now 缺失 → 用注入时钟兜底（DAY = 2026-09-15 10:00 本地；arrive_at = 该时刻 +900s）
  const arriveMs = DAY + 900 * 1000;
  const t3 = wbBackend({
    clock, tasks: [],
    travel: { state: "traveling", arrive_at: Math.round(arriveMs / 1000) },
  });
  const r3 = await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: t3.fetchImpl });
  assert.match(r3.msg, /约 15 分钟后回来/, `msg：${r3.msg}`);
});

test("猫猫旅行：两次上游调用间隔 ≥ 1000ms", async () => {
  const clock = fakeClock(DAY);
  const backend = wbBackend({
    clock,
    tasks: [task("first_buddy", { task_type: "auto" })],
    litRules: { chat_request_send: "first_buddy" },
    travel: { state: "idle" },
    buddyDepartFails: 1,
  });
  await runCatTravel(makeAcct(), { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  const calls = backend.calls;
  for (let i = 1; i < calls.length; i++) {
    assert.ok(calls[i].at - calls[i - 1].at >= 1000, `${calls[i - 1].path} → ${calls[i].path}`);
  }
});

test("reportEvents：body 是事件数组", async () => {
  const clock = fakeClock(DAY);
  const bodies = [];
  const res = await reportEvents(makeAcct(), [buildEvent(makeAcct(), "chat", 0, null, { now: clock.now })], {
    now: clock.now, sleep: clock.sleep,
    fetch: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      return { status: 200, text: async () => JSON.stringify({ code: 0 }) };
    },
  });
  assert.equal(res, true);
  assert.ok(Array.isArray(bodies[0]));
  assert.equal(bodies[0].length, 1);
});

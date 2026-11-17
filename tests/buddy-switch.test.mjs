// tests/buddy-switch.test.mjs —— B8 Buddy 选中态（engine/buddy.mjs + travel 腿）回归。
//
// 三态诊断与 switch 触发条件（CONTRACT §10.9）：
//   · 清单为空 → 「还没有 Buddy（需先完成并领取「领取一只 Buddy」任务）」，不发 switch；
//   · 有实例但未选中（info 与 current_buddy 都没有）→ 选一个（优先 source==="gacha"、
//     其次最早 acquired_at、取不到就第一个）switch 后重试原请求一次；
//   · switch 失败 → 如实报错（含上游 msg），绝不报成功；
//   · **没失败绝不发 switch**（绝不主动切换用户的 Buddy）；
//   · 已有选中 / 清单查不到 → 不切换，travel 腿退回 ensureBuddy 老路。
// switch 的 body 形状 {instance_id} 来自 WorkDaddy 参考、尚未真机验证（注释已标注）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { buddyListOf, isNoActiveBuddyMsg, pickBuddyToSelect, runBuddyOpen } from "../engine/buddy.mjs";
import { runCatTravel } from "../engine/travel.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const GAP = 1000;
const NOW = localTime(2026, 9, 15, 10, 0);
const TRAVEL_IDLE = {
  state: "idle",
  buddy_id: 3,
  record_id: "r-travel-1",
  arrive_at: 0,
  server_now: 1763251200,
  daily_limit_reached: true,
  duration_hours: 2,
  reward_credit: 0,
  location: "null",
  letter: "null",
};

// 两个实例：非 gacha 且较晚 / gacha 且最早 —— pickBuddyToSelect 应选 b-early。
const BUDDIES_UNSELECTED = [
  { instance_id: "b-late", name: "晚来猫", rarity: "R", current_buddy: false, source: "gift", acquired_at: "2026-09-01 10:00:00" },
  { instance_id: "b-early", name: "早来猫", rarity: "SR", current_buddy: false, source: "gacha", acquired_at: "2026-08-01 10:00:00" },
];

function boot(backendOpts = {}, acctOpts = {}) {
  const clock = fakeClock(NOW);
  const backend = wbBackend({ clock, tasks: [], litRules: {}, ...backendOpts });
  const acct = makeAcct(acctOpts);
  return { clock, backend, acct };
}

// ---- 纯函数 --------------------------------------------------------------------

test("isNoActiveBuddyMsg：归一全等，绝不模糊包含", () => {
  assert.equal(isNoActiveBuddyMsg("no active buddy"), true);
  assert.equal(isNoActiveBuddyMsg("  No Active Buddy  "), true);
  assert.equal(isNoActiveBuddyMsg("no active buddy: 3"), false, "子串不命中（兄弟实现教训）");
  assert.equal(isNoActiveBuddyMsg(""), false);
  assert.equal(isNoActiveBuddyMsg(undefined), false);
});

test("pickBuddyToSelect：优先 gacha → 最早 acquired_at → 取不到就第一个", () => {
  assert.equal(pickBuddyToSelect(BUDDIES_UNSELECTED).instance_id, "b-early", "gacha 且最早");
  assert.equal(
    pickBuddyToSelect([
      { instance_id: "b1", source: "gift", acquired_at: 1000 },
      { instance_id: "b2", source: "gift", acquired_at: 500 },
    ]).instance_id,
    "b2",
    "无 gacha → 全体里最早",
  );
  assert.equal(
    pickBuddyToSelect([{ instance_id: "b1", source: "gift" }, { instance_id: "b2" }]).instance_id,
    "b1",
    "都没有时间戳 → 第一个",
  );
  assert.equal(pickBuddyToSelect([]), null);
  assert.equal(pickBuddyToSelect([{ name: "缺 id" }]), null, "缺 instance_id 的条目不参与");
});

// ---- buddyListOf（只读探测）------------------------------------------------------

test("buddyListOf：info 优先 current；实例归一 {instance_id,name,rarity,current}", async () => {
  const { clock, backend, acct } = boot({
    buddies: BUDDIES_UNSELECTED,
    buddyInfo: { instance_id: "b-late", name: "晚来猫", personality: "grumpy", rarity: "R" },
  });
  const res = await buddyListOf(acct, { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP });
  assert.equal(res.ok, true);
  assert.equal(res.current, "b-late", "current 来自 info");
  assert.equal(res.instances.length, 2);
  assert.deepEqual(
    res.instances.map((b) => [b.instance_id, b.name, b.rarity, b.current, b.source]),
    [
      ["b-late", "晚来猫", "R", false, "gift"],
      ["b-early", "早来猫", "SR", false, "gacha"],
    ],
  );
  assert.ok(res.instances[1].acquiredAtMs > 0, "acquired_at 解析成 epoch ms");
  const info = backend.calls.filter((c) => c.path === "/activity/growth/buddy/info");
  const list = backend.calls.filter((c) => c.path === "/activity/growth/buddy/list");
  assert.equal(info.length, 1);
  assert.equal(list.length, 1);
  assert.ok(list[0].at - info[0].at >= GAP, "两个探测调用 ≥ gap");
});

test("buddyListOf：info 失败不阻断 list（current 兜底 current_buddy）；list 失败 → ok:false", async () => {
  // info 500：current 从清单的 current_buddy===true 兜底
  const { clock, backend, acct } = boot({
    buddies: [{ instance_id: "b1", current_buddy: true, source: "gacha", acquired_at: 1750000000 }],
  });
  const wrapped = async (url, init) => {
    if (new URL(url).pathname === "/activity/growth/buddy/info") {
      return { status: 500, text: async () => JSON.stringify({ code: -1, msg: "boom" }) };
    }
    return backend.fetchImpl(url, init);
  };
  const res = await buddyListOf(acct, { now: clock.now, sleep: clock.sleep, fetch: wrapped, gap: GAP });
  assert.equal(res.ok, true);
  assert.equal(res.current, "b1", "info 失败 → 清单 current_buddy 兜底");
  assert.ok(res.logs.join("\n").includes("Buddy info 查询失败"), "失败如实记日志");
  assert.ok(res.logs.join("\n").includes("按缺失处理"));

  // list 404：整体 ok:false（三态诊断的依据没了，绝不把「查不到」当「没有」）
  const b2 = boot({});
  const res2 = await buddyListOf(b2.acct, { now: b2.clock.now, sleep: b2.clock.sleep, fetch: b2.backend.fetchImpl, gap: GAP });
  assert.equal(res2.ok, false);
  assert.equal(res2.instances.length, 0);
});

// ---- 盲盒腿：open 被拒后的修理性切换 -----------------------------------------------

test("B8 盲盒：open no active buddy + 有实例未选中 → switch（最早 gacha）后重试成功", async () => {
  const { clock, backend, acct } = boot({
    travel: { ...TRAVEL_IDLE },
    buddyQuota: { affordable: 1, max_open_count: 1 },
    buddies: BUDDIES_UNSELECTED,
  });
  // 第一次 open 拿 "no active buddy"，switch 后的重试走默认成功信封（布丁猫）
  let opens = 0;
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname === "/v2/activity/growth/buddy/open") {
      opens += 1;
      if (opens === 1) {
        return { status: 200, text: async () => JSON.stringify({ code: 400, msg: "no active buddy" }) };
      }
    }
    return backend.fetchImpl(url, init);
  };
  const res = await runBuddyOpen(acct, { now: clock.now, sleep: clock.sleep, fetch: fetchImpl, gap: GAP });
  assert.equal(res.ok, true, res.logs.join("; "));
  assert.equal(res.opened, 1);
  assert.equal(res.name, "布丁猫");
  assert.ok(res.logs.some((l) => l.includes("已有 Buddy（2 个）但未选中，已尝试切换后重试")), `日志：${res.logs.join("; ")}`);
  // switch：一次，body {instance_id}（WorkDaddy 参考形状），选最早 gacha 实例
  assert.equal(backend.state.buddySwitches.length, 1);
  assert.deepEqual(backend.state.buddySwitches[0], { instance_id: "b-early" });
  // 重试：open 共 2 次（第一次的应答在包装 fetch 里手工造，不计入 backend.calls）
  assert.equal(opens, 2, "切换后重试一次");
  // 节流：任意两次上游调用 ≥ gap（switch/重试都是上游调用）
  for (let i = 1; i < backend.calls.length; i++) {
    assert.ok(backend.calls[i].at - backend.calls[i - 1].at >= GAP, `${backend.calls[i - 1].path} → ${backend.calls[i].path}`);
  }
});

test("B8 盲盒：switch 失败 → 如实报错（含上游 msg），绝不报成功", async () => {
  const { clock, backend, acct } = boot({
    travel: { ...TRAVEL_IDLE },
    buddyQuota: { affordable: 1, max_open_count: 1 },
    buddyOpenResponse: { code: 400, msg: "no active buddy" },
    buddies: BUDDIES_UNSELECTED,
    buddySwitchResponse: { code: 500, msg: "switch not allowed" },
  });
  const res = await runBuddyOpen(acct, { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP });
  assert.equal(res.ok, false);
  assert.equal(res.opened, 0, "绝不报成功");
  assert.ok(res.logs.some((l) => l.includes("切换失败")), `日志：${res.logs.join("; ")}`);
  assert.ok(res.logs.some((l) => l.includes("switch not allowed")), "含上游 msg");
  assert.equal(backend.calls.filter((c) => c.path === "/v2/activity/growth/buddy/open").length, 1, "switch 失败不重试");
});

test("B8 盲盒：清单为空 → 不发 switch，三态文案「还没有 Buddy（需先完成并领取…）」", async () => {
  const { clock, backend, acct } = boot({
    travel: { ...TRAVEL_IDLE },
    buddyQuota: { affordable: 1, max_open_count: 1 },
    buddyOpenResponse: { code: 400, msg: "no active buddy" },
    buddies: [],
  });
  const res = await runBuddyOpen(acct, { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP });
  assert.equal(res.ok, false);
  assert.equal(res.opened, 0);
  assert.ok(res.logs.some((l) => l.includes("还没有 Buddy（需先完成并领取「领取一只 Buddy」任务）")), `日志：${res.logs.join("; ")}`);
  assert.equal(backend.state.buddySwitches.length, 0, "清单为空绝不 switch");
});

test("B8 盲盒：没失败不发 switch（正常开盒 / 能量不足 / 已选中）", async () => {
  // 正常开盒（有实例但未选中也没关系 —— 没失败就不动用户的选中态）
  const a = boot({
    travel: { ...TRAVEL_IDLE },
    buddyQuota: { affordable: 1, max_open_count: 1 },
    buddies: BUDDIES_UNSELECTED,
    buddyOpenResponse: { code: 0, data: { buddy: "新猫" } },
  });
  const r1 = await runBuddyOpen(a.acct, { now: a.clock.now, sleep: a.clock.sleep, fetch: a.backend.fetchImpl, gap: GAP });
  assert.equal(r1.ok, true);
  assert.equal(r1.opened, 1);
  assert.equal(a.backend.state.buddySwitches.length, 0, "开盒成功绝不 switch");

  // 能量不足：连 open 都不发，更不发 switch
  const b = boot({
    travel: { ...TRAVEL_IDLE },
    buddyQuota: { affordable: 0 },
    buddies: BUDDIES_UNSELECTED,
  });
  const r2 = await runBuddyOpen(b.acct, { now: b.clock.now, sleep: b.clock.sleep, fetch: b.backend.fetchImpl, gap: GAP });
  assert.equal(r2.ok, true);
  assert.equal(r2.opened, 0);
  assert.equal(b.backend.state.buddySwitches.length, 0);

  // open 失败但清单显示已有选中实例 → 不切换（绝不主动动用户的选中态）
  const c = boot({
    travel: { ...TRAVEL_IDLE },
    buddyQuota: { affordable: 1, max_open_count: 1 },
    buddyOpenResponse: { code: 400, msg: "no active buddy" },
    buddies: BUDDIES_UNSELECTED,
    buddyInfo: { instance_id: "b-late", name: "晚来猫" },
  });
  const r3 = await runBuddyOpen(c.acct, { now: c.clock.now, sleep: c.clock.sleep, fetch: c.backend.fetchImpl, gap: GAP });
  assert.equal(r3.ok, false, "上游自相矛盾时如实失败");
  assert.equal(r3.opened, 0);
  assert.equal(c.backend.state.buddySwitches.length, 0, "已选中绝不 switch");
  assert.ok(r3.logs.some((l) => l.includes("开启失败")));
});

// ---- 旅行腿：depart 被拒后的修理性切换 ----------------------------------------------

test("B8 旅行：depart no active buddy + 有实例未选中 → switch 后重试派出成功", async () => {
  const { clock, backend, acct } = boot({
    travel: { state: "idle" },
    buddyDepartFails: 1,
    buddies: BUDDIES_UNSELECTED,
  });
  const res = await runCatTravel(acct, { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP });
  assert.equal(res.ok, true, res.msg);
  assert.equal(res.action, "depart");
  assert.ok(res.msg.includes("已有 Buddy（2 个）但未选中，已尝试切换后重试"), `msg：${res.msg}`);
  assert.ok(res.msg.includes("外滩"), "重试派出真的成功");
  assert.deepEqual(backend.state.buddySwitches, [{ instance_id: "b-early" }]);
  const departs = backend.calls.filter((c) => c.path.endsWith("/travel/depart"));
  assert.equal(departs.length, 2, "切换后重试一次");
});

test("B8 旅行：清单为空 → 不 switch，退回 ensureBuddy 补 first_buddy（老路保留）", async () => {
  const { clock, backend, acct } = boot({
    travel: { state: "idle" },
    buddyDepartFails: 1,
    buddies: [],
    tasks: [task("first_buddy", { task_type: "auto", reward: 300 })],
    litRules: { chat_request_send: "first_buddy" },
  });
  const res = await runCatTravel(acct, { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP });
  assert.equal(res.ok, true, res.msg);
  assert.equal(res.action, "depart");
  assert.equal(backend.state.buddySwitches.length, 0, "清单为空绝不 switch");
  assert.deepEqual(backend.state.claims, ["first_buddy"], "ensureBuddy 兜底照常发生");
});

test("B8 旅行：switch 失败 → 如实报错含上游 msg；清单查不到 → 诚实文案 + 老路", async () => {
  // switch 失败
  const a = boot({
    travel: { state: "idle" },
    buddyDepartFails: 1,
    buddies: BUDDIES_UNSELECTED,
    buddySwitchResponse: { code: 500, msg: "switch not allowed" },
  });
  const r1 = await runCatTravel(a.acct, { now: a.clock.now, sleep: a.clock.sleep, fetch: a.backend.fetchImpl, gap: GAP });
  assert.equal(r1.ok, false);
  assert.ok(r1.msg.includes("切换失败"), `msg：${r1.msg}`);
  assert.ok(r1.msg.includes("switch not allowed"), "含上游 msg");

  // 清单查不到（端点 404）+ ensureBuddy 也补不了 → 诚实说明「清单查询失败」
  const b = boot({
    travel: { state: "idle" },
    buddyDepartFails: 1,
    tasks: [],
  });
  const r2 = await runCatTravel(b.acct, { now: b.clock.now, sleep: b.clock.sleep, fetch: b.backend.fetchImpl, gap: GAP });
  assert.equal(r2.ok, false);
  assert.match(r2.msg, /还没有 Buddy（Buddy 清单查询失败/);
  assert.match(r2.msg, /领取一只 Buddy/);
  assert.equal(b.backend.state.buddySwitches.length, 0, "查不到清单绝不 switch");
});

test("B8 旅行：切换后重试仍失败 → ok:false 且说明已重试", async () => {
  const { clock, backend, acct } = boot({
    travel: { state: "idle" },
    // 两次都失败：switch 后的重试也拿 no active buddy
    buddyDepartFails: 9,
    buddies: BUDDIES_UNSELECTED,
  });
  const res = await runCatTravel(acct, { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP });
  assert.equal(res.ok, false);
  assert.ok(res.msg.includes("已尝试切换后重试"), `msg：${res.msg}`);
  assert.ok(res.msg.includes("仍派出失败"), "如实说明重试后仍失败");
  assert.ok(backend.calls.filter((c) => c.path.endsWith("/travel/depart")).length === 2, "只重试一次");
});

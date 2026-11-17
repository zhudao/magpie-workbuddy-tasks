// tests/usage.test.mjs —— B6 积分用量明细（engine/usage.mjs）回归。
//
// 钉死：
//   1. beijingTimeStr：UTC 毫秒 → 北京时间 "YYYY-MM-DD HH:MM:SS"（与宿主时区无关）；
//   2. usageWindow：days=N → 北京今天-(N-1)天 00:00:00 ~ 北京现在（UTC 容器口径）；
//   3. summarizeUsage：跨北京日分桶 / 模型聚合 / requestTime 解析失败只计总数
//      （unparsed 计数、不参与分桶）/ 输出排序稳定；
//   4. fetchRequestUsage：翻页直到不足一页 / maxPages 上限（truncated 如实标记）/
//      **归一化行绝无 input/inputTrunc（prompt 原文）—— 隐私红线** / 参数校验 /
//      401 → needRelogin；
//   5. fetchUsageSummary：窗口 + 汇总 + updatedAt（usage.days 是分桶数组，窗口长度
//      在 windowDays）。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  beijingTimeStr,
  fetchRequestUsage,
  fetchUsageSummary,
  summarizeUsage,
  usageWindow,
} from "../engine/usage.mjs";
import { fakeClock, makeAcct, wbBackend } from "./helpers.mjs";

const NOW = Date.UTC(2026, 10, 15, 17, 30, 0); // 2026-11-15 17:30Z = 北京 2026-11-16 01:30

// ---- 纯函数 --------------------------------------------------------------------

test("beijingTimeStr：UTC 毫秒 → 北京时间字符串，非有限值 → 空串", () => {
  assert.equal(beijingTimeStr(Date.UTC(2026, 10, 15, 16, 0, 5)), "2026-11-16 00:00:05", "UTC 16:00 = 北京次日 00:00");
  assert.equal(beijingTimeStr(Date.UTC(2026, 0, 1, 0, 0, 0)), "2026-01-01 08:00:00");
  assert.equal(beijingTimeStr(Number.NaN), "");
  assert.equal(beijingTimeStr(undefined), "");
});

test("usageWindow：days=N → 北京今天-(N-1)天 00:00:00 ~ 北京现在", () => {
  // 北京现在 = 2026-11-16 01:30
  assert.deepEqual(usageWindow(1, NOW), { startTime: "2026-11-16 00:00:00", endTime: "2026-11-16 01:30:00" });
  assert.deepEqual(usageWindow(3, NOW), { startTime: "2026-11-14 00:00:00", endTime: "2026-11-16 01:30:00" });
  // days=32 跨月：北京今天 2026-11-16，往前 31 天 = 2026-10-16
  assert.equal(usageWindow(32, NOW).startTime, "2026-10-16 00:00:00");
  assert.equal(usageWindow(0, NOW).startTime, "2026-11-16 00:00:00", "days<1 按 1 处理");
});

test("summarizeUsage：跨北京日分桶 + 模型聚合 + 排序稳定（requestTime 北京裸串）", () => {
  const rows = [
    { requestId: "r1", credit: 10, model: "glm-5.2", client: "desktop", agentPurpose: "conversation", requestTime: "2026-11-15 23:59:59" },
    { requestId: "r2", credit: 5.5, model: "glm-5.2", client: "desktop", agentPurpose: "conversation", requestTime: "2026-11-16 00:00:01" },
    { requestId: "r3", credit: 3, model: "glm-4.7", client: "web", agentPurpose: "translation", requestTime: "2026-11-16 12:00:00" },
  ];
  const s = summarizeUsage(rows);
  assert.equal(s.totalCredit, 18.5);
  assert.equal(s.count, 3);
  assert.equal(s.unparsed, 0);
  assert.deepEqual(s.days, [
    { date: "2026-11-15", credit: 10, count: 1 }, // 北京日切：23:59:59 仍算 15 日
    { date: "2026-11-16", credit: 8.5, count: 2 },
  ], "按北京日分桶（23:59:59 与 00:00:01 分属两天）——真机裸串手工拆日期段，绝不过宿主时区");
  assert.deepEqual(s.models, [
    { model: "glm-5.2", credit: 15.5, count: 2 },
    { model: "glm-4.7", credit: 3, count: 1 },
  ], "模型按 credit 降序");
});

test("summarizeUsage：requestTime 北京裸串（真机形状）+ 带偏移 ISO 都认，其余 unparsed", () => {
  const s = summarizeUsage([
    // 真机裸串（20/20 行形状）
    { requestId: "a", credit: 1, model: "m", requestTime: "2026-11-15 21:08:01" },
    // T 分隔无偏移 → 同一裸串口径（北京时间）
    { requestId: "b", credit: 1, model: "m", requestTime: "2026-11-15T23:30:00" },
    // 带偏移 ISO：+08:00 → 同一北京日
    { requestId: "c", credit: 1, model: "m", requestTime: "2026-11-15T18:00:00+08:00" },
    // 带偏移 ISO：Z（UTC 23:30）→ 北京日翻到 16 日
    { requestId: "d", credit: 1, model: "m", requestTime: "2026-11-15T23:30:00Z" },
    // 解析不出：裸日期（无时间）、垃圾串、缺失
    { requestId: "e", credit: 1, model: "m", requestTime: "2026-11-15" },
    { requestId: "f", credit: 1, model: "m", requestTime: "not-a-time" },
    { requestId: "g", credit: 1, model: "m" },
  ]);
  assert.equal(s.count, 7);
  assert.equal(s.totalCredit, 7);
  assert.equal(s.unparsed, 3, "裸日期/垃圾串/缺失 → unparsed");
  assert.deepEqual(s.days, [
    { date: "2026-11-15", credit: 3, count: 3 }, // 裸串 + T 无偏移 + +08:00 ISO 同属北京 15 日
    { date: "2026-11-16", credit: 1, count: 1 }, // Z 串换算北京日（+8h）
  ]);
});

test("summarizeUsage：requestTime 缺失/非法 → 只计总数，unparsed 计数，不参与分桶", () => {
  const rows = [
    { requestId: "r1", credit: 4, model: "m1", requestTime: "2026-11-15 10:00:00" },
    { requestId: "r2", credit: 6, model: "m1", requestTime: "not-a-time" },
    { requestId: "r3", credit: 2, model: "m2", requestTime: "" },
    { requestId: "r4", credit: 1, model: "m2" }, // 字段缺失
  ];
  const s = summarizeUsage(rows);
  assert.equal(s.count, 4);
  assert.equal(s.totalCredit, 13);
  assert.equal(s.unparsed, 3);
  assert.deepEqual(s.days, [{ date: "2026-11-15", credit: 4, count: 1 }]);
  // unparsed 行「只计入总数不参与分桶」—— 模型聚合也属于分桶，只统计可解析行
  assert.deepEqual(s.models, [{ model: "m1", credit: 4, count: 1 }]);
  assert.deepEqual(summarizeUsage([]), { totalCredit: 0, count: 0, unparsed: 0, days: [], models: [] });
});

// ---- fetchRequestUsage ---------------------------------------------------------

function usageRow(i, { withPrompt = true } = {}) {
  return {
    requestId: `req-${i}`,
    credit: 1.5,
    model: "glm-5.2",
    client: "desktop",
    requestTime: "2026-11-15 21:08:01",
    agentPurpose: "conversation",
    appType: "cli",
    subscribeType: "pro",
    ...(withPrompt ? { input: `prompt 原文 ${i}（绝不能外泄）`, inputTrunc: `trunc ${i}` } : {}),
  };
}

test("fetchRequestUsage：真机外壳（data.total + data.data[]）翻页直到不足一页；归一化行绝无 input/inputTrunc（隐私红线）", async () => {
  const clock = fakeClock(NOW);
  // 150 行、pageSize 100 → 两页（第二页 50 行 < 100 停）
  const backend = wbBackend({
    clock,
    usageRows: Array.from({ length: 150 }, (_, i) => usageRow(i)),
  });
  const res = await fetchRequestUsage(
    makeAcct(),
    { startTime: "2026-11-14 00:00:00", endTime: "2026-11-16 01:30:00", pageSize: 100, maxPages: 10 },
    { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl },
  );
  assert.equal(res.ok, true);
  assert.equal(res.pages, 2);
  assert.equal(res.total, 150, "total = data.total（唯一的翻页依据）");
  assert.equal(res.rows.length, 150);
  assert.equal(res.truncated, undefined, "不足一页自然结束，不标记 truncated");
  assert.deepEqual(backend.state.usageQueries, [
    { startTime: "2026-11-14 00:00:00", endTime: "2026-11-16 01:30:00", pageNum: 1, pageSize: 100 },
    { startTime: "2026-11-14 00:00:00", endTime: "2026-11-16 01:30:00", pageNum: 2, pageSize: 100 },
  ], "按 pageNum 翻页");
  // 隐私红线：input/inputTrunc（prompt 原文）与白名单之外字段一律不出现
  for (const row of res.rows) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ["agentPurpose", "client", "credit", "model", "requestId", "requestTime"],
      "归一化行只保留 6 个白名单字段",
    );
    assert.ok(!JSON.stringify(row).includes("prompt 原文"), "绝不带走 prompt 原文");
  }
  // 节流：两次上游调用 ≥ 1s
  const calls = backend.calls.filter((c) => c.path === "/billing/meter/get-user-request-usage");
  assert.ok(calls[1].at - calls[0].at >= 1000);
});

test("fetchRequestUsage：total 说没有更多 → 整页也不再翻（不用等不足一页）", async () => {
  const clock = fakeClock(NOW);
  // 恰好 100 行 = pageSize 100：整页，但 total=100 > 1*100 不成立 → 第 1 页后停
  const backend = wbBackend({
    clock,
    usageRows: Array.from({ length: 100 }, (_, i) => usageRow(i, { withPrompt: false })),
  });
  const res = await fetchRequestUsage(
    makeAcct(),
    { startTime: "2026-11-14 00:00:00", endTime: "2026-11-16 01:30:00", pageSize: 100, maxPages: 10 },
    { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl },
  );
  assert.equal(res.ok, true);
  assert.equal(res.pages, 1, "total=100 ≤ pageNum*pageSize → 不发第二页");
  assert.equal(res.rows.length, 100);
  assert.equal(res.truncated, undefined);
  assert.equal(backend.state.usageQueries.length, 1);
});

test("fetchRequestUsage：外壳形状不符 → error 带实际外壳键名与已试路径，绝不把非行数据当行", async () => {
  const clock = fakeClock(NOW);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    // 形状错误的外壳：没有行数组（真机生产出过的故障形状）
    return { status: 200, text: async () => JSON.stringify({ code: 0, msg: "success", data: { total: 5, foo: "bar" } }) };
  };
  const res = await fetchRequestUsage(
    makeAcct(),
    { startTime: "2026-11-14 00:00:00", endTime: "2026-11-16 01:30:00" },
    { now: clock.now, sleep: clock.sleep, fetch: fetchImpl },
  );
  assert.equal(res.ok, false);
  assert.match(res.error, /外壳形状不符/);
  assert.match(res.error, /data 键=\[total,foo\]/, "error 里要带实际看到的外壳键");
  assert.match(res.error, /data\.data/, "error 里要带已试过的路径（真机形状排第一）");
  assert.match(res.error, /data\.Response\.Data\.Records/, "兜底路径链也列出来");
  assert.equal(calls, 1, "外壳不符不重试（不是瞬时故障）");
});

test("fetchRequestUsage：maxPages 上限（truncated:true）+ 参数校验 + needRelogin", async () => {
  const clock = fakeClock(NOW);
  // 250 行、pageSize 100、maxPages 2 → 拉满 2 页仍没到底 → truncated
  const backend = wbBackend({
    clock,
    usageRows: Array.from({ length: 250 }, (_, i) => usageRow(i, { withPrompt: false })),
  });
  const res = await fetchRequestUsage(
    makeAcct(),
    { startTime: "2026-11-14 00:00:00", endTime: "2026-11-16 01:30:00", pageSize: 100, maxPages: 2 },
    { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl },
  );
  assert.equal(res.ok, true);
  assert.equal(res.pages, 2);
  assert.equal(res.total, 250);
  assert.equal(res.rows.length, 200, "绝不无限翻");
  assert.equal(res.truncated, true, "达上限（total=250 > 2×100）仍未到底 → 如实标记，绝不静默截断");

  // 参数校验：非北京时间秒精度 → ok:false，零上游
  const backend2 = wbBackend({ clock });
  const bad = await fetchRequestUsage(
    makeAcct(),
    { startTime: "2026/11/14", endTime: "2026-11-16 01:30:00" },
    { now: clock.now, sleep: clock.sleep, fetch: backend2.fetchImpl },
  );
  assert.equal(bad.ok, false);
  assert.match(bad.error, /YYYY-MM-DD HH:MM:SS/);
  assert.equal(backend2.calls.length, 0);

  // 401 → needRelogin（与 /api/credits 同口径）
  const res401 = await fetchRequestUsage(
    makeAcct(),
    { startTime: "2026-11-14 00:00:00", endTime: "2026-11-16 01:30:00" },
    {
      now: clock.now, sleep: clock.sleep,
      fetch: async () => ({ status: 401, text: async () => JSON.stringify({ code: 12153, msg: "unauthorized" }) }),
    },
  );
  assert.equal(res401.ok, false);
  assert.equal(res401.needRelogin, true);
});

test("fetchUsageSummary：窗口 + 汇总 + updatedISO；usage.days 是分桶数组、窗口长度在 windowDays", async () => {
  const clock = fakeClock(NOW);
  const backend = wbBackend({
    clock,
    usageRows: [
      { requestId: "a", credit: 7, model: "glm-5.2", client: "desktop", requestTime: "2026-11-15 23:00:00", input: "x", inputTrunc: "y" },
      { requestId: "b", credit: 2, model: "glm-4.7", client: "web", requestTime: "2026-11-16 00:10:00", input: "x", inputTrunc: "y" },
    ],
  });
  const res = await fetchUsageSummary(makeAcct(), { days: 2 }, { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.windowDays, 2);
  assert.equal(res.usage.startTime, "2026-11-15 00:00:00");
  assert.equal(res.usage.endTime, "2026-11-16 01:30:00");
  assert.equal(res.usage.totalCredit, 9);
  assert.equal(res.usage.count, 2);
  assert.equal(res.usage.unparsed, 0);
  assert.equal(res.usage.days.length, 2, "usage.days = 北京日分桶数组（命名约定见函数注释）");
  assert.equal(res.usage.models[0].model, "glm-5.2");
  assert.ok(!JSON.stringify(res.usage).includes("prompt"), "汇总结果不带 prompt 原文");
  assert.equal(res.usage.updatedISO, "2026-11-16 01:30:00");
});

// tests/runner-codes-campaign.test.mjs —— 0.3.6 回归修复：裸活动码到不了 campaign 腿。
//
// 现状（修复前）：runner 的 campaign 腿判定写死 `String(c).includes(":")`，而
// engine/campaign.mjs 的 campaignSelection 明确文档化支持裸 `<activityCode>`
//（命中 CAMPAIGN_SPECS = 整个活动，§11.1 旧口径向后兼容）。结果走 /api/run
// 传裸活动码时被 campaign 腿排除 → 落到 growth 腿 → growth 报「选中的 N 项
// 任务不在任务表中」，campaign 腿整腿 skip —— 引擎文档化的能力成了死路径。
//
// 修复：campaign.mjs 导出 isCampaignActivityCode（与 campaignSelection 同一
// 判定源），runner 的 campaign 腿判定改为「裸活动码 || 含冒号」。本文件钉死：
//   1. 只勾裸活动码 → campaign 腿收到并读取该活动（不再整腿 skip）、growth 腿
//      整腿跳过且无「不在任务表中」警告；
//   2. 裸活动码与成长任务码混勾 → 各归各腿（护栏：pair 码的冒号判定不被破坏）；
//   3. isCampaignActivityCode 判定本身的口径（trim / 不认 pair / 不认未知码）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { CAMPAIGN_SPECS, isCampaignActivityCode } from "../engine/campaign.mjs";
import { JobRunner } from "../engine/runner.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const DAY = localTime(2026, 11, 14, 10, 0);

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

test("runner：只勾裸活动码 → campaign 腿收到并读取该活动，growth 腿整腿跳过（0.3.6 回归）", async () => {
  const clock = fakeClock(DAY);
  const backend = backendFor(clock);
  const runner = new JobRunner({
    accounts: [makeAcct({ uid: "uid-A", nickname: "A" })],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({
    legs: ["growth", "campaign"],
    taskCodes: { "uid-A": ["campaign_starbucks_2026"] },
  });
  const done = await runner.wait(job.id);
  assert.equal(done.state, "done");

  // campaign 腿：不再整腿 skip —— campaignSelection 把裸码解析成整活动勾选，
  // 至少读过一次星巴克活动的清单（修复前整腿 skip，一次 GET 都没有）。
  const campaignStep = done.steps.find((s) => s.leg === "campaign");
  assert.notEqual(campaignStep?.state, "skip", "裸活动码必须进 campaign 腿（不再整腿 skip）");
  const reads = backend.calls.filter(
    (c) => c.path === "/portal/activity/tasks" && c.method === "GET",
  );
  assert.ok(reads.length >= 1, "campaign 腿应当读过活动清单");
  assert.ok(
    reads.every((c) => String(c.url).includes("activity_code=campaign_starbucks_2026")),
    "只读勾中的活动",
  );
  assert.ok(
    !reads.some((c) => String(c.url).includes("campaign_reporter_2026")),
    "没勾的活动不得被读取",
  );

  // growth 腿：裸活动码不再落到 growth —— 筛完为空 → 整腿跳过，连成长任务
  // 清单都不拉，也绝不报「选中的 N 项任务不在任务表中」。
  const growthStep = done.steps.find((s) => s.leg === "growth");
  assert.equal(growthStep?.state, "skip", "裸活动码不该归 growth 腿");
  assert.match(String(growthStep?.detail ?? ""), /不属于这条腿/);
  assert.equal(
    backend.calls.filter((c) => String(c.path).startsWith("/v2/activity/growth/")).length,
    0,
    "growth 被跳过时连成长任务清单都不该拉",
  );
  assert.ok(
    !done.log.some((l) => String(l).includes("不在任务表中")),
    "不得出现「不在任务表中」警告（这是修复前的症状）",
  );
});

test("runner：裸活动码与成长任务码混勾 → 各归各腿（pair 码冒号判定不受影响）", async () => {
  const clock = fakeClock(DAY);
  const backend = backendFor(clock, { chat_request_send: "chat_5" });
  const runner = new JobRunner({
    accounts: [makeAcct({ uid: "uid-A", nickname: "A" })],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({
    legs: ["growth", "campaign"],
    taskCodes: { "uid-A": ["chat_5", "campaign_starbucks_2026"] },
  });
  const done = await runner.wait(job.id);

  // growth：处理选中的成长任务 chat_5（已是 accepted → 走点亮/领奖）
  const growthStep = done.steps.find((s) => s.leg === "growth");
  assert.notEqual(growthStep?.state, "skip", "成长任务码照常归 growth 腿");
  assert.ok(backend.state.claims.includes("chat_5"), "chat_5 应当被正常处理（走到领奖）");

  // campaign：裸码照常归 campaign 腿并只读勾中的活动
  const campaignStep = done.steps.find((s) => s.leg === "campaign");
  assert.notEqual(campaignStep?.state, "skip", "裸活动码照常归 campaign 腿");
  const reads = backend.calls.filter(
    (c) => c.path === "/portal/activity/tasks" && c.method === "GET",
  );
  assert.ok(reads.length >= 1, "campaign 腿应当读过活动清单");
  for (const c of reads) {
    assert.match(String(c.url), /activity_code=campaign_starbucks_2026/);
    assert.ok(!String(c.url).includes("campaign_reporter_2026"));
  }
});

test("engine：isCampaignActivityCode —— 与 campaignSelection 同一判定源", () => {
  for (const spec of CAMPAIGN_SPECS) {
    assert.equal(isCampaignActivityCode(spec.code), true, `裸活动码 ${spec.code} 命中`);
    assert.equal(isCampaignActivityCode(` ${spec.code} `), true, "trim 后命中（与 campaignSelection 口径一致）");
    assert.equal(isCampaignActivityCode(`${spec.code}:ai_chat`), false, "pair 码不是裸活动码（归 runner 的冒号分支）");
    assert.equal(isCampaignActivityCode(`${spec.code}_x`), false, "前缀撞码不算命中");
  }
  assert.equal(isCampaignActivityCode("unknown_activity"), false);
  assert.equal(isCampaignActivityCode(""), false);
  assert.equal(isCampaignActivityCode(null), false);
  assert.equal(isCampaignActivityCode(undefined), false);
  assert.equal(isCampaignActivityCode(42), false);
});

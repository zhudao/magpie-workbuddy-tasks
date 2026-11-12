// tests/streak.test.mjs —— 连登管家（engine/streak.mjs，CONTRACT §10.1）回归。
//
// 口径（全部零真实网络，wbBackend 假后端）：
//   - 补签：昨日 heatmap 格 score===0 且 makeup_cards.balance>0 才 POST
//     makeup-cards/use（body {target_date:北京昨日}）；否则一个请求都不发；
//   - 档位兑换：status 为 locked/claimed 跳过、status 空（上游没给）不碰，
//     其余（available）才 redeem（body {tier, client_token}）；
//   - 抽奖：chances=0 不抽；chances=N 抽 N 次，每次带 client_token，之间只走
//     全局节流不额外 sleep；
//   - 礼包/补偿：业务拒绝（「已领取过」等 code!==0）静默；code===0 且 credit>0
//     才计入 actions.gifts；
//   - 顺序固定：补签 → 礼包/补偿 → 兑换 → 抽奖；
//   - 企业版/API key：一个上游请求都不发；
//   - restricted（403/11140）透传；
//   - fetchStreakState：三路 GET 的字段映射（days/makeupCards/chances/heatmap/
//     tiers），单路失败不影响其余，全部失败 → {ok:false, error}；
//   - target_date = beijingDayKey(now - 86400000)：UTC 时钟下也必须对（UTC 17:00
//     = 北京次日 01:00 → 昨日是北京当天减一天）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchStreakState, runStreakSteward } from "../engine/streak.mjs";
import { beijingDayKey } from "../engine/daily.mjs";
import { fakeClock, makeAcct, wbBackend } from "./helpers.mjs";

const GAP = 1000;
// 锚在确定的 UTC 时刻（与本地时区无关）：2026-10-15 17:00Z = 北京 2026-10-16 01:00
const NOW = Date.UTC(2026, 9, 15, 17, 0, 0);
const YESTERDAY = "2026-10-15"; // 北京昨日（beijingDayKey(NOW - 86400000)）

// 「两个礼包都已领取过」：不关心礼包分支的用例用它把礼包静音（wbBackend 的
// 缺省响应是两个礼包各 +50，会污染 earned 断言）。
const GIFTS_CLAIMED = {
  "claim-gift": { code: 2101, msg: "已领取过" },
  "claim-compensation": { code: 2101, msg: "已领取过" },
};

function boot(backendOpts = {}, acctOpts = {}) {
  const clock = fakeClock(NOW);
  const backend = wbBackend({ clock, tasks: [], litRules: {}, ...backendOpts });
  const acct = makeAcct(acctOpts);
  return { clock, backend, acct };
}

const run = (b, extra = {}) =>
  runStreakSteward(b.acct, {
    now: b.clock.now,
    sleep: b.clock.sleep,
    fetch: b.backend.fetchImpl,
    gap: GAP,
    ...extra,
  });

test("streak：fetchStreakState 三路 GET 的字段映射（streak/heatmap/lottery）", async () => {
  const { clock, backend, acct } = boot({
    streak: {
      days: 6,
      makeupBalance: 2,
      chances: 3,
      heatmap: [
        { date: YESTERDAY, score: 0 },
        { date: "2026-10-14", score: 5 },
      ],
      redemption_status: { "7d": "available", "14d": "locked", "28d": "claimed" },
    },
  });
  const s = await fetchStreakState(acct, {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP,
  });
  assert.equal(s.ok, true);
  assert.equal(s.days, 6, "days = data.streak.days");
  assert.equal(s.makeupCards, 2, "makeupCards = data.makeup_cards.balance");
  assert.equal(s.lotteryChances, 3, "lotteryChances = data.chances");
  assert.deepEqual(s.heatmap, [
    { date: YESTERDAY, score: 0 },
    { date: "2026-10-14", score: 5 },
  ]);
  assert.deepEqual(s.tiers, [
    { tier: "7d", status: "available" },
    { tier: "14d", status: "locked" },
    { tier: "28d", status: "claimed" },
  ]);
  assert.ok(typeof s.updatedISO === "string" && Number.isFinite(Date.parse(s.updatedISO)), "updatedISO 是 ISO 串");
  // 恰好 3 次 GET（streak/heatmap/lottery summary），都是 chat 域
  const gets = backend.calls.filter((c) => c.method === "GET");
  assert.deepEqual(gets.map((c) => c.path), [
    "/activity/growth/streak",
    "/activity/growth/heatmap",
    "/activity/growth/lottery/summary",
  ]);
  assert.ok(gets.every((c) => c.host === "copilot.tencent.com"));
  // 相邻两次 GET 间隔 ≥ gap（假时钟断言，铁律 4）
  for (let i = 1; i < gets.length; i++) assert.ok(gets[i].at - gets[i - 1].at >= GAP);
});

test("streak：fetchStreakState 单路失败不影响其余；全部失败 → ok:false + error", async () => {
  // heatmap 打 404（wbBackend 没有的路径回 404）：streak/lottery 的字段照常
  const a = boot({ streak: { days: 2, makeupBalance: 1, chances: 1 } });
  // 让 heatmap 404：wbBackend 固定应答，这里换一个不含 streak 的后端并把
  // heatmap 指到未知路径 —— 直接注入自定义 fetch 更精确。
  const callsA = [];
  const fetchA = async (url, init = {}) => {
    const u = new URL(url);
    callsA.push({ path: u.pathname, at: a.clock.now() });
    const respond = (body) => ({ status: 200, text: async () => JSON.stringify(body) });
    if (u.pathname === "/activity/growth/streak")
      return respond({ code: 0, data: { streak: { days: 2 }, makeup_cards: { balance: 1 } } });
    if (u.pathname === "/activity/growth/heatmap") return respond({ code: -1, msg: "boom" });
    if (u.pathname === "/activity/growth/lottery/summary") return respond({ code: 0, data: { chances: 1 } });
    return { status: 404, text: async () => JSON.stringify({ code: -1, msg: "not found" }) };
  };
  const s1 = await fetchStreakState(a.acct, {
    now: a.clock.now, sleep: a.clock.sleep, fetch: fetchA, gap: GAP,
  });
  assert.equal(s1.ok, true, "只有 heatmap 失败 → 整体仍 ok");
  assert.equal(s1.days, 2);
  assert.equal(s1.makeupCards, 1);
  assert.equal(s1.lotteryChances, 1);
  assert.deepEqual(s1.heatmap, [], "失败的字段落缺省 []");

  // 三路全失败 → {ok:false, error}
  const fetchAll = async () => ({ status: 500, text: async () => JSON.stringify({ code: 500, msg: "server" }) });
  const s2 = await fetchStreakState(a.acct, {
    now: a.clock.now, sleep: a.clock.sleep, fetch: fetchAll, gap: GAP,
  });
  assert.equal(s2.ok, false);
  assert.ok(s2.error, "error 说明原因");
});

test("streak：昨日格 score=0 且有补签卡 → 补签，target_date=北京昨日", async () => {
  const { clock, backend, acct } = boot({
    streak: {
      days: 3,
      makeupBalance: 1,
      chances: 0,
      heatmap: [{ date: YESTERDAY, score: 0 }],
      redemption_status: {},
    },
    giftResponses: GIFTS_CLAIMED,
  });
  const res = await run({ clock, backend, acct });
  assert.equal(res.ok, true);
  assert.deepEqual(res.actions.makeup, { used: true, date: YESTERDAY });
  assert.equal(beijingDayKey(NOW - 86400000), YESTERDAY, "UTC 17:00 的北京昨日 = 2026-10-15");
  const makeups = backend.calls.filter((c) => c.path === "/activity/growth/makeup-cards/use");
  assert.equal(makeups.length, 1);
  assert.equal(makeups[0].method, "POST");
  assert.deepEqual(makeups[0].body, { target_date: YESTERDAY }, "target_date 是北京昨日");
});

test("streak：score≠0 / 没补签卡 / 昨日格缺失 → 都不碰补签端点", async () => {
  const cases = [
    { label: "昨日格 score=5（没断签）", streak: { makeupBalance: 2, chances: 0, heatmap: [{ date: YESTERDAY, score: 5 }] } },
    { label: "补签卡 0 张", streak: { makeupBalance: 0, chances: 0, heatmap: [{ date: YESTERDAY, score: 0 }] } },
    { label: "日历里没有昨日格", streak: { makeupBalance: 2, chances: 0, heatmap: [{ date: "2026-10-13", score: 0 }] } },
  ];
  for (const c of cases) {
    const { clock, backend, acct } = boot({ streak: c.streak, giftResponses: GIFTS_CLAIMED });
    const res = await run({ clock, backend, acct });
    assert.equal(res.ok, true, c.label);
    assert.deepEqual(res.actions.makeup, { used: false, date: "" }, c.label);
    assert.equal(
      backend.calls.filter((x) => x.path === "/activity/growth/makeup-cards/use").length,
      0,
      `${c.label}：绝不发 makeup-cards/use`,
    );
  }
});

test("streak：locked/claimed/空状态跳过，available 才兑换（client_token 必带）", async () => {
  const { clock, backend, acct } = boot({
    streak: {
      days: 8,
      makeupBalance: 0,
      chances: 0,
      heatmap: [],
      redemption_status: { "7d": "available", "14d": "locked", "28d": "claimed" },
    },
    giftResponses: GIFTS_CLAIMED,
  });
  const res = await run({ clock, backend, acct });
  assert.equal(res.ok, true);
  assert.deepEqual(res.actions.redeemed, ["7d"], "只有 available 的 7d 兑换");
  const redeems = backend.calls.filter((c) => c.path === "/activity/growth/redeem");
  assert.equal(redeems.length, 1);
  assert.equal(redeems[0].body.tier, "7d");
  assert.ok(typeof redeems[0].body.client_token === "string" && redeems[0].body.client_token.length >= 32);
});

test("streak：chances=0 不抽；chances=2 抽两次且不额外 sleep（只靠节流）", async () => {
  const zero = boot({ streak: { days: 1, makeupBalance: 0, chances: 0, heatmap: [], redemption_status: {} }, giftResponses: GIFTS_CLAIMED });
  const rz = await run(zero);
  assert.equal(rz.actions.drawn, 0);
  assert.equal(zero.backend.calls.filter((c) => c.path === "/activity/growth/lottery/draw").length, 0);

  const two = boot({
    streak: { days: 1, makeupBalance: 0, chances: 2, heatmap: [], redemption_status: {} },
    lotteryDrawResponse: { code: 0, data: { name: "50 积分", credit: 50 } },
    giftResponses: GIFTS_CLAIMED,
  });
  const r2 = await run(two);
  assert.equal(r2.actions.drawn, 2);
  assert.equal(r2.earned, 100, "两次抽奖各 +50 计入 earned");
  const draws = two.backend.calls.filter((c) => c.path === "/activity/growth/lottery/draw");
  assert.equal(draws.length, 2);
  assert.ok(draws.every((c) => typeof c.body.client_token === "string" && c.body.client_token.length >= 32));
  assert.ok(draws[0].body.client_token !== draws[1].body.client_token, "每次抽奖独立 client_token");
  assert.ok(draws[1].at - draws[0].at >= GAP, "两次抽奖之间 ≥1s（全局节流，不额外 sleep）");
});

test("streak：礼包计入、补偿业务拒绝静默；0 奖励不算收益", async () => {
  const { clock, backend, acct } = boot({
    streak: { days: 1, makeupBalance: 0, chances: 0, heatmap: [], redemption_status: {} },
    giftResponses: {
      "claim-gift": { code: 0, data: { name: "新手礼包", credit: 100 } },
      // 业务拒绝（已领取过）：静默 —— 不进 gifts、不写失败日志
      "claim-compensation": { code: 2101, msg: "已领取过" },
    },
  });
  const res = await run({ clock, backend, acct });
  assert.equal(res.ok, true);
  assert.deepEqual(res.actions.gifts, [{ key: "claim-gift", name: "新手礼包", credit: 100 }]);
  assert.equal(res.earned, 100);
  const giftCalls = backend.calls.filter((c) => c.host === "www.codebuddy.cn" && c.path.startsWith("/billing/meter/claim-"));
  assert.equal(giftCalls.length, 2, "礼包与补偿都尝试过（拒绝也只静默）");
  assert.ok(res.logs.some((l) => l.includes("新手礼包")), "成功领取写一行日志");
  assert.ok(!res.logs.some((l) => l.includes("补偿")), "业务拒绝静默：日志里没有补偿行");

  // code 0 但 credit 0（空礼包）→ 不计入；补偿保持业务拒绝
  const b2 = boot({
    streak: { days: 1, makeupBalance: 0, chances: 0, heatmap: [], redemption_status: {} },
    giftResponses: { ...GIFTS_CLAIMED, "claim-gift": { code: 0, data: { credit: 0 } } },
  });
  const r2 = await run(b2);
  assert.deepEqual(r2.actions.gifts, []);
  assert.equal(r2.earned, 0);
});

test("streak：执行顺序固定 补签 → 礼包/补偿 → 兑换 → 抽奖", async () => {
  const { clock, backend, acct } = boot({
    streak: {
      days: 7,
      makeupBalance: 1,
      chances: 1,
      heatmap: [{ date: YESTERDAY, score: 0 }],
      redemption_status: { "7d": "available", "14d": "locked", "28d": "locked" },
    },
    giftResponses: {
      "claim-gift": { code: 0, data: { credit: 30 } },
      "claim-compensation": { code: 2101, msg: "已领取过" },
    },
    lotteryDrawResponse: { code: 0, data: { name: "100 积分", credit: 100 } },
  });
  const res = await run({ clock, backend, acct });
  assert.equal(res.ok, true);
  const order = backend.calls
    .filter((c) =>
      [
        "/activity/growth/makeup-cards/use",
        "/billing/meter/claim-gift",
        "/billing/meter/claim-compensation",
        "/activity/growth/redeem",
        "/activity/growth/lottery/draw",
      ].includes(c.path),
    )
    .map((c) => c.path);
  assert.deepEqual(order, [
    "/activity/growth/makeup-cards/use",
    "/billing/meter/claim-gift",
    "/billing/meter/claim-compensation",
    "/activity/growth/redeem",
    "/activity/growth/lottery/draw",
  ]);
  assert.equal(res.actions.drawn, 1);
  assert.equal(res.earned, 130, "礼包 30 + 抽奖 100（补偿业务拒绝静默）");
});

test("streak：企业版 / API key 一次上游都不发；国际版不适用", async () => {
  const guard = async () => {
    throw new Error("no upstream allowed");
  };
  const ent = await runStreakSteward(makeAcct({ enterpriseId: "ent-1" }), {
    now: () => NOW, sleep: async () => {}, fetch: guard, gap: GAP,
  });
  assert.equal(ent.ok, true);
  assert.match(ent.logs.join("\n"), /企业版/);
  assert.equal(ent.earned, 0);
  const keyAcct = await runStreakSteward(makeAcct({ isApiKey: true }), {
    now: () => NOW, sleep: async () => {}, fetch: guard, gap: GAP,
  });
  assert.equal(keyAcct.ok, true);
  assert.match(keyAcct.logs.join("\n"), /企业版/);
  const intl = await runStreakSteward(makeAcct({ provider: "workbuddy-ai" }), {
    now: () => NOW, sleep: async () => {}, fetch: guard, gap: GAP,
  });
  assert.equal(intl.ok, false);
  assert.match(intl.logs.join("\n"), /国际版/);
  // fetchStreakState 同样零上游（企业版回零值状态）
  const entState = await fetchStreakState(makeAcct({ enterpriseId: "ent-1" }), {
    now: () => NOW, sleep: async () => {}, fetch: guard, gap: GAP,
  });
  assert.equal(entState.ok, true);
  assert.equal(entState.days, 0);
  assert.deepEqual(entState.heatmap, []);
});

test("streak：restricted（403/11140）透传，后续动作一个都不发", async () => {
  const { clock, backend, acct } = boot({
    restrictedUids: ["u-12345678"],
    streak: { days: 5, makeupBalance: 1, chances: 2, heatmap: [{ date: YESTERDAY, score: 0 }] },
  });
  const res = await run({ clock, backend, acct });
  assert.equal(res.ok, false);
  assert.equal(res.restricted, true, "restricted 透传（调用方走 §10.5 冻结）");
  // 403 在第一路 GET 就撞上：补签/礼包/兑换/抽奖全部没发生
  assert.equal(
    backend.calls.filter((c) => c.path === "/activity/growth/makeup-cards/use").length, 0);
  assert.equal(backend.calls.filter((c) => c.path.startsWith("/billing/meter/claim-")).length, 0);
  assert.equal(backend.calls.filter((c) => c.path === "/activity/growth/lottery/draw").length, 0);
});

test("streak：runner 的 streak 腿 —— 顺序在 mp 之后 buddy 之前，earned 计入 totals", async () => {
  const { JobRunner } = await import("../engine/runner.mjs");
  const clock = fakeClock(NOW);
  const backend = wbBackend({
    clock,
    tasks: [
      {
        task_code: "first_buddy",
        title: "领取一只 Buddy",
        accept_status: "claimed",
        task_type: "auto",
        reward_credit: 300,
        current: 1,
        target: 1,
      },
    ],
    litRules: {},
    streak: { days: 4, makeupBalance: 0, chances: 1, heatmap: [], redemption_status: { "7d": "available" } },
    lotteryDrawResponse: { code: 0, data: { credit: 20 } },
    giftResponses: GIFTS_CLAIMED,
    buddyQuota: { affordable: 0, max_open_count: 1 },
  });
  const runner = new JobRunner({
    accounts: [makeAcct()],
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const job = runner.start({ legs: ["night", "bogus", "streak", "buddy", "growth", "mp", "travel"] });
  const done = await runner.wait(job.id);
  assert.deepEqual(
    done.steps.map((s) => s.leg),
    ["growth", "mp", "streak", "buddy", "travel", "night"],
    "streak 插在 mp 与 buddy 之间（CONTRACT §10.3 的 LEG_ORDER）",
  );
  const step = done.steps.find((s) => s.leg === "streak");
  assert.equal(step.state, "ok");
  assert.equal(step.credit, 20, "earned 计入步骤 credit");
  assert.ok(step.detail.includes("连登"), `detail 取最后一条日志：${step.detail}`);
  // growth 腿：first_buddy 起始即 claimed（无新领奖），本轮积分只来自 streak 腿
  assert.equal(done.totals.credit, 20, "growth 0（无新领奖）+ streak 20");
});

// ---- 真实报文形状回归（2026-11-11 生产实测） -----------------------------------
// 第一版按猜的形状解析：档位状态读 redemption_status["7d"]、日历读 data.days，
// 真实上游给的是**平铺的 tier_7d_status** 与 **data.cells** —— 结果 days/makeupCards
// 正常、三个档位状态全空、日历 0 格（档位兑换永远不会发生）。这两条用照抄真实
// 报文的 payload 把它钉死；假后端（tests/helpers.mjs）也已改成回真实形状。
test("streak：真实报文形状 —— redemption_status.tier_7d_status 与 data.cells 都要解析出来", async () => {
  const { clock, backend, acct } = boot({
    streak: {
      days: 11,
      makeupBalance: 1,
      chances: 0,
      heatmap: [
        { date: "2026-10-13", score: 4 },
        { date: "2026-10-14", score: 2 },
      ],
      // 上游实测形状：状态平铺，另带 tiers 清单
      redemption_status: {
        tiers: [{ tier: "7d" }, { tier: "14d" }, { tier: "28d" }],
        tier_7d_status: "available",
        tier_14d_status: "locked",
        tier_28d_status: "claimed",
      },
    },
    giftResponses: GIFTS_CLAIMED,
  });
  const s = await fetchStreakState(acct, {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP,
  });
  assert.deepEqual(s.tiers, [
    { tier: "7d", status: "available" },
    { tier: "14d", status: "locked" },
    { tier: "28d", status: "claimed" },
  ], "档位状态取平铺的 tier_<档>_status");
  assert.deepEqual(s.heatmap, [
    { date: "2026-10-13", score: 4 },
    { date: "2026-10-14", score: 2 },
  ], "日历取 data.cells");

  // 真实形状下只有 available 的 7d 会被兑换
  const res = await run({ clock, backend, acct });
  assert.deepEqual(res.actions.redeemed, ["7d"]);
  assert.equal(backend.calls.filter((c) => c.path === "/activity/growth/redeem").length, 1);
});

test("streak：data.days / 数组形态仍兼容（旧外壳不丢字段）", async () => {
  // 上游换壳的兜底：data.days 与 redemption_status 为数组 [{tier,status}] 时也要认
  const { clock, backend, acct } = boot({
    streak: {
      days: 3,
      makeupBalance: 0,
      chances: 0,
      heatmap: [{ date: "2026-10-14", score: 1 }],
      redemption_status: [
        { tier: "7d", status: "locked" },
        { tier: "14d", status: "available" },
      ],
    },
    giftResponses: GIFTS_CLAIMED,
  });
  // heatmap 走 data.cells（假后端固定），这里手工换成 data.days 外壳验证兼容
  const raw = backend.fetchImpl;
  const patched = async (url, init) => {
    if (new URL(url).pathname === "/activity/growth/heatmap") {
      return { status: 200, text: async () => JSON.stringify({ code: 0, data: { days: [{ date: "2026-10-14", score: 1 }] } }) };
    }
    return raw(url, init);
  };
  const s = await fetchStreakState(acct, { now: clock.now, sleep: clock.sleep, fetch: patched, gap: GAP });
  assert.deepEqual(s.heatmap, [{ date: "2026-10-14", score: 1 }]);
  assert.deepEqual(s.tiers, [
    { tier: "7d", status: "locked" },
    { tier: "14d", status: "available" },
    { tier: "28d", status: "" },
  ], "数组形态按 tier 匹配 status");
});

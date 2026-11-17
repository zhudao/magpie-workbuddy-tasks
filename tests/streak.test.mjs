// tests/streak.test.mjs —— 连登管家（engine/streak.mjs，CONTRACT §10.1）回归。
//
// 口径（全部零真实网络，wbBackend 假后端）：
//   - 补签（A2 目标选择）：候选 = 当月 / 服务端今天之前（heatmap.data.today.date，
//     绝不用本机时区推的日期）/ score 明确 === 0 / 不在 streak.makeup_dates /
//     不早于上线边界（launch_date|2026-06-17）→ 取**最近的一天** POST
//     makeup-cards/use（body {target_date:选中断点日}）；每轮最多 1 张卡；
//     没补时日志写明原因（无需补签 / 已补过 / 日历读不到 / 没卡，互不混淆）；
//   - 档位兑换：status 为 locked/claimed 跳过、status 空（上游没给）不碰，
//     其余（available）才 redeem（body {tier, client_token}）；
//   - 档位奖励明细（2026-11-16 真机）：redemption_status.tiers[] 项的
//     days/credit/energy/cards/chances 按档位名合并进 tiers（status 口径不变）；
//     合法非负数字（含字符串数字、0）→ 数字，缺失/空串/布尔/脏串/负数 → null；
//     count 收平铺 tier_<档>_count（tiers[] 项的 count 兜底，缺失 null）；
//   - 兑换自检：redeem 成功时对照「预期（tiers[].credit）vs 实发（grantedOf）」
//     写日志 —— 一致「实发 +X 积分（预期 +Y）」、不一致追加「与预期差 ±D，见上游
//     回执」、预期缺失维持旧措辞只写实发；绝不因不一致判失败（earned 按实发）；
//   - 抽奖：chances=0 不抽；chances=N 抽 N 次，每次带 client_token，之间只走
//     全局节流不额外 sleep；
//   - 礼包/补偿：业务拒绝（「已领取过」等 code!==0）静默；code===0 且 credit>0
//     才计入 actions.gifts；
//   - 顺序固定：补签 → 礼包/补偿 → 兑换 → 抽奖；
//   - 企业版/API key：一个上游请求都不发；
//   - restricted（403/11140）透传；
//   - fetchStreakState：三路 GET 的字段映射（days/makeupCards/chances/heatmap/
//     tiers/today/makeupDates/launchDate），单路失败不影响其余，
//     全部失败 → {ok:false, error}；
//   - 奖励回执 grantedOf：*_granted 新字段优先、老字段兜底（A1，兄弟实现实测口径）；
//   - 补签卡 makeupCardsOf：对象 balance / 裸数字 / 缺失三形状（A3）；
//   - 日历格可判定性：score 只有「明确数字 0」才进补签候选，脏数据（null/false/
//     "abc"）归 null 一律不补，绝不误花补签卡（A3）；
//   - 服务端 today 与本机 UTC 差一天时以服务端为准（A2，两个方向都钉）。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fetchStreakState,
  grantedOf,
  LAUNCH_DATE_FALLBACK,
  makeupCardsOf,
  makeupDatesOf,
  makeupTargetOf,
  runStreakSteward,
} from "../engine/streak.mjs";
import { beijingDayKey } from "../engine/daily.mjs";
import { fakeClock, makeAcct, wbBackend } from "./helpers.mjs";

const GAP = 1000;
// 锚在确定的 UTC 时刻（与本地时区无关）：2026-10-15 17:00Z = 北京 2026-10-16 01:00
const NOW = Date.UTC(2026, 9, 15, 17, 0, 0);
const YESTERDAY = "2026-10-15"; // 北京昨日（beijingDayKey(NOW - 86400000)）
const TODAY = "2026-10-16"; // 北京今天 = beijingDayKey(NOW) = 假后端缺省的 data.today.date

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
    { date: YESTERDAY, score: 0, raw: 0 },
    { date: "2026-10-14", score: 5, raw: 5 },
  ], "格形状 {date, score, raw}：score 数字、raw 保留上游原值");
  assert.equal(s.today, TODAY, "today = heatmap data.today.date（假后端缺省 = 假时钟北京日）");
  assert.deepEqual(s.makeupDates, [], "makeupDates = data.streak.makeup_dates（种子没给 → []）");
  assert.equal(s.launchDate, "2026-06-17", "launchDate = data.launch_date（假后端缺省 = 已知上线边界）");
  assert.deepEqual(s.tiers, [
    { tier: "7d", status: "available", days: null, credit: null, energy: null, cards: null, chances: null, count: null },
    { tier: "14d", status: "locked", days: null, credit: null, energy: null, cards: null, chances: null, count: null },
    { tier: "28d", status: "claimed", days: null, credit: null, energy: null, cards: null, chances: null, count: null },
  ], "简写种子不带奖励明细 → 五键 + count 全 null（绝不拿 0 冒充）");
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

test("streak：score≠0 / 没补签卡 / 日历为空 → 都不碰补签端点", async () => {
  const cases = [
    { label: "昨日格 score=5（没断签）", streak: { makeupBalance: 2, chances: 0, heatmap: [{ date: YESTERDAY, score: 5 }] } },
    { label: "补签卡 0 张", streak: { makeupBalance: 0, chances: 0, heatmap: [{ date: YESTERDAY, score: 0 }] } },
    { label: "连登日历为空（读不到格子）", streak: { makeupBalance: 2, chances: 0, heatmap: [] } },
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
    { tier: "7d", status: "available", days: null, credit: null, energy: null, cards: null, chances: null, count: null },
    { tier: "14d", status: "locked", days: null, credit: null, energy: null, cards: null, chances: null, count: null },
    { tier: "28d", status: "claimed", days: null, credit: null, energy: null, cards: null, chances: null, count: null },
  ], "档位状态取平铺的 tier_<档>_status；tiers[] 项只有 tier 无奖励 → 明细全 null");
  assert.deepEqual(s.heatmap, [
    { date: "2026-10-13", score: 4, raw: 4 },
    { date: "2026-10-14", score: 2, raw: 2 },
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
  assert.deepEqual(s.heatmap, [{ date: "2026-10-14", score: 1, raw: 1 }]);
  assert.deepEqual(s.tiers, [
    { tier: "7d", status: "locked", days: null, credit: null, energy: null, cards: null, chances: null, count: null },
    { tier: "14d", status: "available", days: null, credit: null, energy: null, cards: null, chances: null, count: null },
    { tier: "28d", status: "", days: null, credit: null, energy: null, cards: null, chances: null, count: null },
  ], "数组形态按 tier 匹配 status；数组项无奖励明细 → 全 null");
});

// ---- 奖励明细合并（2026-11-16 真机口径）------------------------------------------
// redemption_status.tiers[] 项带每档奖励明细 {tier,days,credit,energy,cards,chances}
// —— 按档位名合并进快照 tiers[]，status 口径不变（平铺 tier_<档>_status 优先）。
// 五键 + count 的取舍：合法非负数字（含字符串数字）→ 数字；缺失/空串/布尔/脏串/负数
// → null；0 是合法值（与「上游没说」可区分，看板据此隐藏）；count 收平铺
// tier_<档>_count（tiers[] 项的 count 兜底）。
test("streak：tiers[] 奖励明细按档位名合并（真机 2026-11-16 形状）—— 取值、0 保留、部分缺失 null、count", async () => {
  const { clock, backend, acct } = boot({
    streak: {
      days: 9,
      chances: 0,
      // 真机形状：状态平铺 + tiers[] 带奖励明细 + 平铺计数键（照 2026-11-16 探测报文合成）
      redemption_status: {
        tier_7d_status: "available",
        tier_14d_status: "locked",
        tier_28d_status: "claimed",
        tier_7d_count: 3,
        tiers: [
          { tier: "7d", days: 7, credit: 120, energy: 0, cards: 0, chances: 0 },
          { tier: "14d", days: 14, credit: 300 }, // 部分字段缺失 → null
          { tier: "28d", days: 28, credit: 800, energy: 10, cards: 2, chances: 2 },
        ],
      },
    },
    giftResponses: GIFTS_CLAIMED,
  });
  const s = await fetchStreakState(acct, {
    now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP,
  });
  assert.deepEqual(s.tiers, [
    { tier: "7d", status: "available", days: 7, credit: 120, energy: 0, cards: 0, chances: 0, count: 3 },
    { tier: "14d", status: "locked", days: 14, credit: 300, energy: null, cards: null, chances: null, count: null },
    { tier: "28d", status: "claimed", days: 28, credit: 800, energy: 10, cards: 2, chances: 2, count: null },
  ], "五键合并自 tiers[] 项；0 如实 0（不抹成 null）、缺失如实 null（不冒充 0）；count 收平铺键");
  // 顺序与固定三档一致（STREAK_TIERS），向后兼容字段 tier/status 原样
  assert.deepEqual(s.tiers.map((t) => t.tier), ["7d", "14d", "28d"]);
});

test("streak：奖励明细兜底 —— tiers[] 缺失 / 项形状异常 / 字符串数字 / 负数 / 布尔 → null 或数字", async () => {
  // a) tiers[] 整个缺失（只有平铺状态）→ 五键 + count 全 null；平铺计数键 0 是合法值
  const a = boot({
    streak: { days: 1, chances: 0, redemption_status: { tier_7d_status: "available", tier_7d_count: 0 } },
  });
  const s1 = await fetchStreakState(a.acct, {
    now: a.clock.now, sleep: a.clock.sleep, fetch: a.backend.fetchImpl, gap: GAP,
  });
  assert.deepEqual(s1.tiers[0], {
    tier: "7d", status: "available", days: null, credit: null, energy: null, cards: null, chances: null, count: 0,
  }, "tiers[] 缺失 → 明细全 null；tier_7d_count=0 如实 0（不抹成 null）");

  // b) 项形状异常（字符串项匹配不上）/ 字符串数字认 / 负数与布尔与脏串 → null；
  //    count 平铺键缺失时回落 tiers[] 项的 count
  const respond = (body) => ({ status: 200, text: async () => JSON.stringify(body) });
  const fetchB = async (url) => {
    const p = new URL(url).pathname;
    if (p === "/activity/growth/streak") {
      return respond({
        code: 0,
        data: {
          streak: { days: 1 },
          redemption_status: {
            tier_7d_status: "available",
            tier_14d_status: "locked",
            tier_7d_count: "9", // 字符串数字 → 9
            tier_28d_count: -2, // 负数 → null（平铺键脏）→ 回落项内 count "5" → 5
            tiers: [
              "7d", // 形状异常项：匹配不上 → 明细全 null，绝不报错
              { tier: "28d", days: 28, credit: "120", energy: "abc", cards: -1, chances: true, count: "5" },
            ],
          },
        },
      });
    }
    if (p === "/activity/growth/heatmap") return respond({ code: 0, data: { cells: [] } });
    return respond({ code: 0, data: { chances: 0 } });
  };
  const s2 = await fetchStreakState(makeAcct(), {
    now: () => NOW, sleep: async () => {}, fetch: fetchB, gap: GAP,
  });
  assert.deepEqual(s2.tiers, [
    { tier: "7d", status: "available", days: null, credit: null, energy: null, cards: null, chances: null, count: 9 },
    { tier: "14d", status: "locked", days: null, credit: null, energy: null, cards: null, chances: null, count: null },
    {
      tier: "28d", status: "", days: 28, credit: 120, energy: null, cards: null, chances: null, count: 5,
    },
  ], "字符串项不炸、字符串数字认（120/9/5）、负数与布尔与脏串 → null；count 平铺优先、项内兜底");
});

// ---- A1：奖励回执 grantedOf（88lin/workbuddy-auto-signin 实测口径）--------------
// 兑换回执的实发字段带 _granted 后缀（credit_granted/energy_granted/cards_granted/
// chances_granted，兄弟实现 _redeem_reward_desc：「直接读 credit 恒为空，会把兑换
// 所得漏计」）；老字段作兜底，两种拼写都认防上游回退。
test("streak：grantedOf —— 新字段优先、老字段兜底、都缺记 0、字符串认、NaN 记 0", () => {
  assert.deepEqual(
    grantedOf({ credit_granted: 50, energy_granted: 3, cards_granted: 1, chances_granted: 1 }),
    { credit: 50, energy: 3, cards: 1, chances: 1 },
    "新信封（*_granted）字段",
  );
  assert.deepEqual(grantedOf({ credit: 20, energy: 2 }), { credit: 20, energy: 2, cards: 0, chances: 0 }, "老字段兜底");
  assert.equal(grantedOf({ credit_granted: 50, credit: 20 }).credit, 50, "新字段优先于老字段");
  assert.equal(grantedOf({ credit_granted: 0, credit: 30 }).credit, 30, "新字段 0 → 老字段兜底");
  assert.equal(grantedOf({ credit_granted: "8" }).credit, 8, "字符串数字认");
  assert.equal(grantedOf({ credit_granted: "abc" }).credit, 0, "非数值串记 0（Number||0）");
  assert.deepEqual(grantedOf({}), { credit: 0, energy: 0, cards: 0, chances: 0 }, "都缺记 0");
  assert.deepEqual(grantedOf(null), { credit: 0, energy: 0, cards: 0, chances: 0 }, "data 缺失不抛");
  assert.equal(grantedOf({ credit: NaN }).credit, 0, "NaN 记 0");
});

test("streak：兑换回执只有 credit_granted → earned 与 actions 正确，日志报全明细", async () => {
  const { clock, backend, acct } = boot({
    streak: { days: 7, makeupBalance: 0, chances: 0, heatmap: [], redemption_status: { "7d": "available" } },
    redeemResponse: { code: 0, data: { credit_granted: 50, energy_granted: 2, cards_granted: 1, chances_granted: 1 } },
    giftResponses: GIFTS_CLAIMED,
  });
  const res = await run({ clock, backend, acct });
  assert.deepEqual(res.actions.redeemed, ["7d"]);
  assert.equal(res.earned, 50, "earned = credit_granted（旧实现只读 credit 恒 0，记错账）");
  const line = res.logs.find((l) => l.includes("档位兑换成功"));
  assert.ok(line, "兑换成功写日志");
  for (const frag of ["+50 积分", "+2 能量", "+1 补签卡", "+1 次抽奖"]) {
    assert.ok(line.includes(frag), `日志要报实发明细 ${frag}：${line}`);
  }
});

test("streak：兑换回执全 0（空 data）→ earned 0，日志保持「成功」措辞、不带 0 明细", async () => {
  const { clock, backend, acct } = boot({
    streak: { days: 7, makeupBalance: 0, chances: 0, heatmap: [], redemption_status: { "7d": "available" } },
    giftResponses: GIFTS_CLAIMED,
  });
  const res = await run({ clock, backend, acct });
  assert.equal(res.earned, 0);
  const line = res.logs.find((l) => l.includes("档位兑换成功"));
  assert.ok(line);
  assert.ok(!line.includes("+0"), "全 0 时不拼 +0 明细");
  assert.ok(!line.includes("积分"), "全 0 时保持旧措辞（档位兑换成功）");
});

// ---- 兑换自检：预期（tiers[].credit）vs 实发（grantedOf）--------------------------
// A1 记账 bug 的自检手段：预期来自快照 tiers[] 奖励明细，实发来自兑换回执 grantedOf。
// 一致 →「实发 +X 积分（预期 +Y）」；不一致 → 追加「与预期差 ±D，见上游回执」；
// 预期缺失（上游没给明细/旧形状）→ 维持旧措辞只写实发。**绝不因不一致判失败**
//（ok:true、earned 按实发记、actions.redeemed 照常）。
test("streak：兑换自检 —— 预期=实发 / 与预期差（±两个方向）/ 预期缺失 三种日志；不一致不判失败", async () => {
  const seed = (overrides = {}) => ({
    streak: {
      days: 8,
      makeupBalance: 0,
      chances: 0,
      heatmap: [],
      redemption_status: {
        tier_7d_status: "available",
        tiers: [{ tier: "7d", days: 7, credit: 120, energy: 0, cards: 0, chances: 0 }],
      },
    },
    giftResponses: GIFTS_CLAIMED,
    ...overrides,
  });

  // a) 一致：实发 +120 = 预期 +120
  const a = boot(seed({ redeemResponse: { code: 0, data: { credit_granted: 120 } } }));
  const ra = await run(a);
  const la = ra.logs.find((l) => l.includes("档位兑换成功"));
  assert.ok(la, "兑换成功写日志");
  assert.ok(la.includes("实发 +120 积分（预期 +120）"), `一致日志：${la}`);
  assert.ok(!la.includes("与预期差"), "一致时没有差值说明");
  assert.equal(ra.earned, 120);
  assert.deepEqual(ra.actions.redeemed, ["7d"]);

  // b) 不一致（少发/多发两个方向）：追加「与预期差 ±D，见上游回执」，但绝不判失败
  for (const [granted, sign] of [[90, "-30"], [150, "+30"]]) {
    const b = boot(
      seed({ redeemResponse: { code: 0, data: { credit_granted: granted, energy_granted: 2 } } }),
    );
    const rb = await run(b);
    const lb = rb.logs.find((l) => l.includes("档位兑换成功"));
    assert.ok(
      lb && lb.includes(`实发 +${granted} 积分（预期 +120，与预期差 ${sign}，见上游回执）`),
      `不一致日志（${sign}）：${lb}`,
    );
    assert.ok(lb.includes("，+2 能量"), "其余实发明细照旧跟在后面");
    assert.equal(rb.ok, true, "不一致 ≠ 失败：整体仍 ok");
    assert.equal(rb.earned, granted, "earned 永远按实发记");
    assert.deepEqual(rb.actions.redeemed, ["7d"], "actions 照常");
  }

  // c) 预期缺失（种子不带奖励明细）：维持旧措辞，只写实发
  const c = boot({
    streak: { days: 8, makeupBalance: 0, chances: 0, heatmap: [], redemption_status: { "7d": "available" } },
    redeemResponse: { code: 0, data: { credit_granted: 120 } },
    giftResponses: GIFTS_CLAIMED,
  });
  const rc = await run(c);
  const lc = rc.logs.find((l) => l.includes("档位兑换成功"));
  assert.ok(lc && lc.includes("档位兑换成功（+120 积分）"), `预期缺失 → 旧措辞：${lc}`);
  assert.ok(!lc.includes("预期"), "预期缺失时绝不出现「预期」字样");
  assert.equal(rc.earned, 120);
});

test("streak：礼包/补偿回执带 *_granted 新字段也认；legacy credit/points/point 不变", async () => {
  // 新信封：credit_granted
  const a = boot({
    streak: { days: 1, makeupBalance: 0, chances: 0, heatmap: [], redemption_status: {} },
    giftResponses: {
      "claim-gift": { code: 0, data: { name: "新手礼包", credit_granted: 88 } },
      "claim-compensation": { code: 2101, msg: "已领取过" },
    },
  });
  const ra = await run({ clock: a.clock, backend: a.backend, acct: a.acct });
  assert.deepEqual(ra.actions.gifts, [{ key: "claim-gift", name: "新手礼包", credit: 88 }], "credit_granted 计入");
  assert.equal(ra.earned, 88);

  // legacy 备用拼写 points 仍认（旧行为不回退）
  const b = boot({
    streak: { days: 1, makeupBalance: 0, chances: 0, heatmap: [], redemption_status: {} },
    giftResponses: {
      "claim-gift": { code: 0, data: { name: "活动补偿", points: 40 } },
      "claim-compensation": { code: 2101, msg: "已领取过" },
    },
  });
  const rb = await run({ clock: b.clock, backend: b.backend, acct: b.acct });
  assert.equal(rb.earned, 40, "legacy points 兜底不变");
});

// ---- A3：补签卡三形状 + 日历脏数据防线 ------------------------------------------
test("streak：makeupCardsOf 三形状 —— 对象 balance / 裸数字 / 缺失；非法值记 0", () => {
  assert.equal(makeupCardsOf({ makeup_cards: { balance: 2 } }), 2, "对象形状（2026-11-11 实测）");
  assert.equal(makeupCardsOf({ makeup_cards: 2 }), 2, "裸数字形状（兄弟实现 signin.py:2012-2014 实测）");
  assert.equal(makeupCardsOf({ makeup_cards: { balance: "3" } }), 3, "字符串数字认");
  assert.equal(makeupCardsOf({}), 0, "都缺 → 0");
  assert.equal(makeupCardsOf({ makeup_cards: { balance: -1 } }), 0, "负数 → 0（宁可少补）");
  assert.equal(makeupCardsOf({ makeup_cards: -2 }), 0, "裸负数 → 0");
  assert.equal(makeupCardsOf({ makeup_cards: "abc" }), 0, "非数值 → 0");
  assert.equal(makeupCardsOf({ makeup_cards: null }), 0, "null → 0");
});

test("streak：上游回裸数字 makeup_cards → 补签卡数正确且照常补签（旧行为恒 0 永不补）", async () => {
  const { clock, backend, acct } = boot({
    streak: {
      days: 3,
      makeupCardsRaw: 2, // 裸数字形状
      chances: 0,
      heatmap: [{ date: YESTERDAY, score: 0 }],
      redemption_status: {},
    },
    giftResponses: GIFTS_CLAIMED,
  });
  const s = await fetchStreakState(acct, { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP });
  assert.equal(s.makeupCards, 2, "裸数字 makeup_cards 直接用");
  const res = await run({ clock, backend, acct });
  assert.deepEqual(res.actions.makeup, { used: true, date: YESTERDAY }, "有卡 + 昨日明确 0 分 → 补签发生");
});

test("streak：makeup_cards 缺失 → 补签卡 0，绝不发补签请求", async () => {
  const { clock, backend, acct } = boot({
    streak: { days: 3, makeupCardsRaw: null, chances: 0, heatmap: [{ date: YESTERDAY, score: 0 }], redemption_status: {} },
    giftResponses: GIFTS_CLAIMED,
  });
  const s = await fetchStreakState(acct, { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP });
  assert.equal(s.makeupCards, 0);
  const res = await run({ clock, backend, acct });
  assert.deepEqual(res.actions.makeup, { used: false, date: "" });
  assert.equal(backend.calls.filter((c) => c.path === "/activity/growth/makeup-cards/use").length, 0);
});

test("streak：日历脏数据 —— score 非明确数字（null/false/\"abc\"/空串/NaN）→ score:null 且一律不补签", async () => {
  for (const dirty of [null, false, "abc", "", NaN]) {
    const { clock, backend, acct } = boot({
      streak: {
        days: 3,
        makeupBalance: 2,
        chances: 0,
        heatmap: [{ date: YESTERDAY, score: dirty }],
        redemption_status: {},
      },
      giftResponses: GIFTS_CLAIMED,
    });
    const s = await fetchStreakState(acct, { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP });
    assert.equal(s.heatmap[0].score, null, `score ${String(dirty)} 不可判定 → null`);
    // NaN 在 JSON 里只能序列化成 null —— 与 null 同一条不可判定路径
    assert.equal(s.heatmap[0].raw, dirty !== dirty ? null : dirty, "raw 保留上游原值");
    const res = await run({ clock, backend, acct });
    assert.deepEqual(res.actions.makeup, { used: false, date: "" }, `脏 score ${JSON.stringify(dirty)} 绝不误花补签卡`);
    assert.equal(
      backend.calls.filter((c) => c.path === "/activity/growth/makeup-cards/use").length,
      0,
      `脏 score ${JSON.stringify(dirty)} 不发补签请求`,
    );
  }
});

test("streak：补签判据 —— 只有明确数字 0 才补；正数/负数不补；昨日格缺失但当月有更早断点 → 补更早断点", async () => {
  // 正数 / 负数：可判定但 ≠ 0 → 不补（负数按脏数据防线同样绝不触发）
  for (const sc of [5, -1]) {
    const { clock, backend, acct } = boot({
      streak: { days: 3, makeupBalance: 2, chances: 0, heatmap: [{ date: YESTERDAY, score: sc }], redemption_status: {} },
      giftResponses: GIFTS_CLAIMED,
    });
    const s = await fetchStreakState(acct, { now: clock.now, sleep: clock.sleep, fetch: backend.fetchImpl, gap: GAP });
    assert.equal(s.heatmap[0].score, sc, `score ${sc} 是明确数字，原样保留`);
    const res = await run({ clock, backend, acct });
    assert.deepEqual(res.actions.makeup, { used: false, date: "" }, `score ${sc} 不补签`);
    assert.equal(backend.calls.filter((c) => c.path === "/activity/growth/makeup-cards/use").length, 0);
  }
  // A2：昨日格不在日历里，但当月更早的日子有明确 0 分格 → 补那个更早的断点
  //（日历是唯一依据：只补日历里明确 0 分的日子，绝不无中生有猜「昨天断了」）
  const miss = boot({
    streak: { days: 3, makeupBalance: 2, chances: 0, heatmap: [{ date: "2026-10-13", score: 0 }], redemption_status: {} },
    giftResponses: GIFTS_CLAIMED,
  });
  const rm = await run({ clock: miss.clock, backend: miss.backend, acct: miss.acct });
  assert.deepEqual(rm.actions.makeup, { used: true, date: "2026-10-13" }, "当月最近断点 = 2026-10-13");
  const makeups = miss.backend.calls.filter((c) => c.path === "/activity/growth/makeup-cards/use");
  assert.equal(makeups.length, 1);
  assert.deepEqual(makeups[0].body, { target_date: "2026-10-13" });
});

// ---- A2：补签目标选择（2026-11-16 真机口径，兄弟实现 _makeup_candidates 同行为）----
// 候选 = 当月 / 服务端今天之前 / score 明确 0 / 不在 makeup_dates / 不早于上线边界
//（launch_date|2026-06-17），取最近的一天；每轮最多补 1 张卡；补签卡的 balance>0
// 才发请求；服务端今天一律取 heatmap.data.today.date。
test("A2①：makeup_dates 含最近断点 → 跳过它，选更早的合法断点", async () => {
  const { clock, backend, acct } = boot({
    streak: {
      days: 3,
      makeupBalance: 2,
      chances: 0,
      heatmap: [
        { date: "2026-10-15", score: 0 }, // 最近断点：已补过
        { date: "2026-10-14", score: 0 }, // 更早断点：合法候选
        { date: "2026-10-13", score: 5 },
      ],
      makeupDates: ["2026-10-15"],
      redemption_status: {},
    },
    giftResponses: GIFTS_CLAIMED,
  });
  const res = await run({ clock, backend, acct });
  assert.deepEqual(res.actions.makeup, { used: true, date: "2026-10-14" }, "已补过的 10-15 被跳过");
  const makeups = backend.calls.filter((c) => c.path === "/activity/growth/makeup-cards/use");
  assert.deepEqual(makeups[0]?.body, { target_date: "2026-10-14" }, "target_date 是更早的合法断点");
  assert.ok(res.logs.some((l) => l.includes("2026-10-14")), "日志写明补的是哪一天");
});

test("A2②：上月断点不选（只补当月）；上线日之前的 0 分格不选", async () => {
  // a) 唯一断点在上月 → 不发请求，日志解释「早于可补边界」且写出该日期
  const lastMonth = boot({
    streak: { days: 3, makeupBalance: 2, chances: 0, heatmap: [{ date: "2026-09-30", score: 0 }], redemption_status: {} },
    giftResponses: GIFTS_CLAIMED,
  });
  const r1 = await run({ clock: lastMonth.clock, backend: lastMonth.backend, acct: lastMonth.acct });
  assert.deepEqual(r1.actions.makeup, { used: false, date: "" }, "上月断点不补");
  assert.equal(lastMonth.backend.calls.filter((c) => c.path === "/activity/growth/makeup-cards/use").length, 0);
  const line1 = r1.logs.find((l) => l.includes("补签跳过"));
  assert.ok(line1 && line1.includes("2026-09-30") && line1.includes("早于可补边界"), `日志解释排除原因：${line1}`);

  // b) 服务端今天在上线月内：上线日之前的 0 分格被边界滤掉，之后的合法断点照补
  const launchMonth = boot({
    streak: {
      days: 3,
      makeupBalance: 2,
      chances: 0,
      today: "2026-06-20", // 服务端今天（上线月）
      heatmap: [
        { date: "2026-06-10", score: 0 }, // 早于上线边界 2026-06-17
        { date: "2026-06-18", score: 0 }, // 合法候选
      ],
      redemption_status: {},
    },
    giftResponses: GIFTS_CLAIMED,
  });
  const r2 = await run({ clock: launchMonth.clock, backend: launchMonth.backend, acct: launchMonth.acct });
  assert.deepEqual(r2.actions.makeup, { used: true, date: "2026-06-18" }, "上线日之前的格子被排除");
});

test("A2③：服务端 today 与本机 UTC 差一天 → 以服务端为准（两个方向）", async () => {
  // a) 服务端今天比本机北京日靠后一天：本机会当成「今天」的 10-16，服务端已是历史 → 补它
  const ahead = boot({
    streak: {
      days: 3, makeupBalance: 1, chances: 0, today: "2026-10-17",
      heatmap: [{ date: "2026-10-16", score: 0 }], // 本机北京今天（2026-10-16）
      redemption_status: {},
    },
    giftResponses: GIFTS_CLAIMED,
  });
  const r1 = await run({ clock: ahead.clock, backend: ahead.backend, acct: ahead.acct });
  assert.deepEqual(r1.actions.makeup, { used: true, date: "2026-10-16" }, "服务端说它已过去 → 可补");

  // b) 服务端今天比本机北京日靠前一天：本机口径的「昨日 10-15」服务端还是今天 → 不补
  const behind = boot({
    streak: {
      days: 3, makeupBalance: 1, chances: 0, today: "2026-10-15",
      heatmap: [{ date: "2026-10-15", score: 0 }],
      redemption_status: {},
    },
    giftResponses: GIFTS_CLAIMED,
  });
  const r2 = await run({ clock: behind.clock, backend: behind.backend, acct: behind.acct });
  assert.deepEqual(r2.actions.makeup, { used: false, date: "" }, "服务端今天不算断点");
  assert.equal(behind.backend.calls.filter((c) => c.path === "/activity/growth/makeup-cards/use").length, 0);
  const line = r2.logs.find((l) => l.includes("补签跳过"));
  assert.ok(line && line.includes("不早于服务端今天"), `日志说明是服务端边界挡的：${line}`);
});

test("A2④：全是 score>0 → 无需补签（不发请求）；与「日历读不到」日志口径不同", async () => {
  // a) 日历有格子但没有 0 分格 → 「无需补签」
  const clean = boot({
    streak: {
      days: 3, makeupBalance: 2, chances: 0,
      heatmap: [{ date: "2026-10-15", score: 7 }, { date: "2026-10-14", score: 3 }],
      redemption_status: {},
    },
    giftResponses: GIFTS_CLAIMED,
  });
  const r1 = await run({ clock: clean.clock, backend: clean.backend, acct: clean.acct });
  assert.deepEqual(r1.actions.makeup, { used: false, date: "" });
  assert.equal(clean.backend.calls.filter((c) => c.path === "/activity/growth/makeup-cards/use").length, 0);
  const line1 = r1.logs.find((l) => l.includes("补签跳过"));
  assert.ok(line1 && line1.includes("无需补签"), `无断签 → 说明无需补签：${line1}`);

  // b) 日历读不到（空格子）→ 「日历为空」，绝不说成「无需补签」
  const blind = boot({
    streak: { days: 3, makeupBalance: 2, chances: 0, heatmap: [], redemption_status: {} },
    giftResponses: GIFTS_CLAIMED,
  });
  const r2 = await run({ clock: blind.clock, backend: blind.backend, acct: blind.acct });
  const line2 = r2.logs.find((l) => l.includes("补签跳过"));
  assert.ok(line2 && line2.includes("日历为空"), `读不到日历 → 如实说：${line2}`);
  assert.ok(!line2.includes("无需补签"), "绝不把读不到混成无需补签");

  // c) 服务端 today 缺失 → 没有边界就不猜
  const noToday = boot({
    streak: {
      days: 3, makeupBalance: 2, chances: 0, today: null,
      heatmap: [{ date: YESTERDAY, score: 0 }], redemption_status: {},
    },
    giftResponses: GIFTS_CLAIMED,
  });
  const r3 = await run({ clock: noToday.clock, backend: noToday.backend, acct: noToday.acct });
  assert.equal(noToday.backend.calls.filter((c) => c.path === "/activity/growth/makeup-cards/use").length, 0, "today 缺失不发请求");
  const line3 = r3.logs.find((l) => l.includes("补签跳过"));
  assert.ok(line3 && line3.includes("today.date 缺失"), `日志写明缺边界：${line3}`);
});

test("A2⑤：有合法断点但补签卡余额 0 → 不发请求，日志写明「余额为 0」", async () => {
  const { clock, backend, acct } = boot({
    streak: { days: 3, makeupBalance: 0, chances: 0, heatmap: [{ date: YESTERDAY, score: 0 }], redemption_status: {} },
    giftResponses: GIFTS_CLAIMED,
  });
  const res = await run({ clock, backend, acct });
  assert.deepEqual(res.actions.makeup, { used: false, date: "" });
  assert.equal(backend.calls.filter((c) => c.path === "/activity/growth/makeup-cards/use").length, 0);
  const line = res.logs.find((l) => l.includes("补签卡余额为 0"));
  assert.ok(line && line.includes(YESTERDAY), `没卡也要说清断点是哪天：${line}`);
});

test("A2⑥：多个断点 + 余额充足 → 一轮只补 1 张（最近的断点），绝不循环补", async () => {
  const { clock, backend, acct } = boot({
    streak: {
      days: 3,
      makeupBalance: 4,
      chances: 0,
      heatmap: [
        { date: "2026-10-15", score: 0 },
        { date: "2026-10-14", score: 0 },
        { date: "2026-10-13", score: 0 },
      ],
      redemption_status: {},
    },
    giftResponses: GIFTS_CLAIMED,
  });
  const res = await run({ clock, backend, acct });
  const makeups = backend.calls.filter((c) => c.path === "/activity/growth/makeup-cards/use");
  assert.equal(makeups.length, 1, "每轮最多 1 张卡（补签会改变连登天数，一张一张来）");
  assert.deepEqual(makeups[0].body, { target_date: "2026-10-15" }, "补最近断点");
  assert.deepEqual(res.actions.makeup, { used: true, date: "2026-10-15" });
});

test("A2⑦：launch_date 缺失/非法 → 回落已知上线边界 2026-06-17", async () => {
  assert.equal(LAUNCH_DATE_FALLBACK, "2026-06-17");
  // 上线月内、断点在 06-17 之前：launch_date 缺失时按回落边界挡掉
  const missing = boot({
    streak: {
      days: 3, makeupBalance: 2, chances: 0, today: "2026-06-20",
      launchDateRaw: null, // 上游没给 launch_date
      heatmap: [{ date: "2026-06-16", score: 0 }], // 早于回落边界
      redemption_status: {},
    },
    giftResponses: GIFTS_CLAIMED,
  });
  const r1 = await run({ clock: missing.clock, backend: missing.backend, acct: missing.acct });
  assert.equal(missing.backend.calls.filter((c) => c.path === "/activity/growth/makeup-cards/use").length, 0, "回落边界挡住上线前的格子");
  const s1 = await fetchStreakState(missing.acct, { now: missing.clock.now, sleep: missing.clock.sleep, fetch: missing.backend.fetchImpl, gap: GAP });
  assert.equal(s1.launchDate, "", "launch_date 缺失 → 快照原样空串（回落发生在选目标时）");

  // 对照：launch_date 合法且更早（2026-06-10）→ 06-16 的断点可补
  const early = boot({
    streak: {
      days: 3, makeupBalance: 2, chances: 0, today: "2026-06-20",
      launchDate: "2026-06-10",
      heatmap: [{ date: "2026-06-16", score: 0 }],
      redemption_status: {},
    },
    giftResponses: GIFTS_CLAIMED,
  });
  const r2 = await run({ clock: early.clock, backend: early.backend, acct: early.acct });
  assert.deepEqual(r2.actions.makeup, { used: true, date: "2026-06-16" }, "launch_date 更早 → 断点可补");

  // launch_date 格式非法（非 YYYY-MM-DD）→ 同样回落
  const bogus = boot({
    streak: {
      days: 3, makeupBalance: 2, chances: 0, today: "2026-06-20",
      launchDateRaw: "2026/06/01",
      heatmap: [{ date: "2026-06-16", score: 0 }],
      redemption_status: {},
    },
    giftResponses: GIFTS_CLAIMED,
  });
  await run({ clock: bogus.clock, backend: bogus.backend, acct: bogus.acct });
  assert.equal(bogus.backend.calls.filter((c) => c.path === "/activity/growth/makeup-cards/use").length, 0, "非法 launch_date 不放大可补范围");
});

test("A2 纯函数：makeupTargetOf 边界（月初即边界 / madeUp 过滤 / 未知日期形状不进候选）", () => {
  const base = {
    heatmap: [
      { date: "2026-10-15", score: 0 },
      { date: "2026-10-10", score: 0 },
      { date: "2026-10-01", score: 0 },
    ],
    today: "2026-10-16",
    makeupDates: [],
    launchDate: "",
  };
  assert.equal(makeupTargetOf(base).date, "2026-10-15", "取最近断点");
  assert.equal(makeupTargetOf({ ...base, makeupDates: ["2026-10-15", "2026-10-14"] }).date, "2026-10-10", "已补过的从新到旧跳过");
  // 服务端今天 = 月初一（10 月没有 1 日之前的当月断点）→ 无候选
  const monthEdge = makeupTargetOf({ ...base, today: "2026-10-01" });
  assert.equal(monthEdge.date, "", "月初无历史格可补");
  // 脏 score（null）不进候选
  const dirty = makeupTargetOf({ ...base, heatmap: [{ date: "2026-10-15", score: null }] });
  assert.equal(dirty.date, "", "score 不可判定 → 不补");
  // 空日历 / today 缺失 的 reason 不同
  assert.ok(makeupTargetOf({ ...base, heatmap: [] }).reason.includes("日历为空"));
  assert.ok(makeupTargetOf({ ...base, today: "" }).reason.includes("today.date"));
});

test("A2 纯函数：makeupDatesOf 形状（streak 层实测 / 顶层兜底 / 非数组 → []）", () => {
  assert.deepEqual(makeupDatesOf({ streak: { makeup_dates: ["2026-10-15", "2026-10-14"] } }), ["2026-10-15", "2026-10-14"]);
  assert.deepEqual(makeupDatesOf({ makeup_dates: ["2026-10-15"] }), ["2026-10-15"], "顶层兜一层");
  assert.deepEqual(makeupDatesOf({}), [], "缺失 → []");
  assert.deepEqual(makeupDatesOf({ streak: { makeup_dates: "2026-10-15" } }), [], "非数组 → []");
  assert.deepEqual(makeupDatesOf({ streak: { makeup_dates: [null, ""] } }), [], "空条目剔除");
});

// ---- B5：连登状态投影字段（nextTier / nextTierRemaining / remainingDays / todayActive）----
// 只读快照字段（2026-11-16 真机口径）：来自 streak 与 heatmap 的同一次查询，
// 绝不为它多发任何请求；缺失/非数字 → null（状态未知，绝不瞎猜）。
test("B5：fetchStreakState 投影 nextTier/nextTierRemaining/remainingDays/todayActive；缺失 → 缺省", async () => {
  const a = boot({
    streak: {
      days: 5,
      chances: 1,
      nextTier: "28d",
      nextTierRemaining: 6,
      remainingDays: 3,
      todayActive: true,
      todayStatusText: "已打卡",
      redemption_status: { "7d": "claimed" },
    },
  });
  const s = await fetchStreakState(a.acct, {
    now: a.clock.now, sleep: a.clock.sleep, fetch: a.backend.fetchImpl, gap: GAP,
  });
  assert.equal(s.ok, true);
  assert.equal(s.nextTier, "28d", "nextTier = data.streak.next_tier");
  assert.equal(s.nextTierRemaining, 6, "nextTierRemaining = data.streak.next_tier_remaining");
  assert.equal(s.remainingDays, 3, "remainingDays = redemption_status.remaining_days");
  assert.deepEqual(s.todayActive, { active: true, statusText: "已打卡" }, "todayActive 来自 heatmap.data.today");
  // 字段是同一次三路 GET 顺带取的：请求数不变（streak/heatmap/lottery summary）
  const gets = a.backend.calls.filter((c) => c.method === "GET");
  assert.equal(gets.length, 3, "绝不为投影字段多发请求");

  // 缺失/非数字/heatmap 失败 → 如实缺省
  const b = boot({ streak: { days: 1 } });
  const s2 = await fetchStreakState(b.acct, {
    now: b.clock.now, sleep: b.clock.sleep, fetch: b.backend.fetchImpl, gap: GAP,
  });
  assert.equal(s2.nextTier, "");
  assert.equal(s2.nextTierRemaining, null);
  assert.equal(s2.remainingDays, null);
  assert.deepEqual(s2.todayActive, { active: false, statusText: "未打卡" }, "假后端缺省形状");

  const c = boot({ streak: { days: 1, nextTierRemaining: "abc", remainingDays: null } });
  const s3 = await fetchStreakState(c.acct, {
    now: c.clock.now, sleep: c.clock.sleep, fetch: c.backend.fetchImpl, gap: GAP,
  });
  assert.equal(s3.nextTierRemaining, null, "非数字 → null");
  assert.equal(s3.remainingDays, null);
});

// ---- B2：抽奖常态与回退源 ----------------------------------------------------------
test("B2：抽奖次数不足（insufficient ... chance 类 400）是常态 —— 不记失败，如实停手", async () => {
  const b = boot({
    streak: { days: 3, chances: 2, redemption_status: {} },
    lotteryDrawResponse: { code: 400, msg: "insufficient lottery chance balance" },
    giftResponses: GIFTS_CLAIMED,
  });
  const r = await run(b);
  assert.equal(r.ok, true, "常态拒绝不是故障");
  assert.equal(r.actions.drawn, 0);
  const line = r.logs.find((l) => l.includes("抽奖"));
  assert.ok(line, "有一行说明");
  assert.ok(line.includes("余额不足"), `日志：${line}`);
  assert.ok(!line.includes("失败"), "「失败」字样绝不出现（B2 口径）");
  assert.equal(backendStreakDraws(b).length, 1, "第一次被拒就停手");
});

test("B2：抽奖回执 need_address / require_address → 提示到成长中心填收件信息", async () => {
  for (const key of ["need_address", "require_address"]) {
    const b = boot({
      streak: { days: 1, chances: 1, redemption_status: {} },
      lotteryDrawResponse: { code: 0, data: { name: "周边礼盒", credit: 0, [key]: true } },
      giftResponses: GIFTS_CLAIMED,
    });
    const r = await run(b);
    assert.equal(r.ok, true);
    assert.equal(r.actions.drawn, 1);
    const line = r.logs.find((l) => l.includes("实物奖"));
    assert.ok(line, `回执 ${key} → 有实物奖提示：${r.logs.join("; ")}`);
    assert.ok(line.includes("收件信息"));
  }
});

test("B2：lottery/summary 失败 → 回退 /lottery/chances 的 data.balance；两源都失败才未知", async () => {
  // summary 500 → chances 回退成功
  const a = boot({
    streak: { days: 1, chances: 0, chancesFallback: 4, lotterySummaryFail: true, redemption_status: {} },
  });
  const s1 = await fetchStreakState(a.acct, {
    now: a.clock.now, sleep: a.clock.sleep, fetch: a.backend.fetchImpl, gap: GAP,
  });
  assert.equal(s1.ok, true, "回退源成功 → 整体仍 ok");
  assert.equal(s1.lotteryChances, 4, "chances 来自 /lottery/chances 的 data.balance");
  assert.equal(s1.lotterySource, "chances", "来源如实标记（诊断用）");
  const gets = a.backend.calls.filter((c) => c.method === "GET");
  assert.ok(gets.some((c) => c.path === "/activity/growth/lottery/chances"), "确实打过回退源");

  // 两源都失败 → lotteryChances 0 + 整体失败原因（若其它路也挂）
  const calls = [];
  const fetchBoth = async (url) => {
    const p = new URL(url).pathname;
    calls.push({ p, at: NOW });
    const respond = (body) => ({ status: 200, text: async () => JSON.stringify(body) });
    if (p === "/activity/growth/streak") return respond({ code: 0, data: { streak: { days: 1 } } });
    if (p === "/activity/growth/heatmap") return respond({ code: 0, data: { cells: [] } });
    return respond({ code: -1, msg: "down" }); // summary 与 chances 都挂
  };
  const b = boot({});
  const s2 = await fetchStreakState(b.acct, {
    now: b.clock.now, sleep: b.clock.sleep, fetch: fetchBoth, gap: GAP,
  });
  assert.equal(s2.lotteryChances, 0, "两源都失败 → 0（未知）");
  assert.equal(s2.lotterySource, "");
  assert.equal(s2.ok, true, "streak/heatmap 成功 → 整体仍 ok（chances 只是缺省）");
  assert.deepEqual(calls.filter((c) => c.p.includes("lottery")).map((c) => c.p), [
    "/activity/growth/lottery/summary",
    "/activity/growth/lottery/chances",
  ], "先 summary 后 chances，各一次");
});

// 小工具：取假后端记录的抽奖请求
function backendStreakDraws(b) {
  return b.backend.state.streakDraws;
}

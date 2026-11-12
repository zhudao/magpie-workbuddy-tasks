// streak.mjs —— 连登管家（wb_tasks.run_streak_bonus 的移植，CONTRACT §10.1）。
//
// 一条独立腿（leg "streak"）：把连登体系的日常收益一次收干净 ——
//   补签昨日（补签卡）→ 新手礼包/活动补偿（计费域）→ 档位兑换 → 抽奖。
// 纯收益且幂等：已做过的事（已补签/已领取过/已兑换/无抽奖次数）一律静默跳过，
// 绝不报错、绝不硬闯重试。
//
// 端点（一律经 upstream.callJSON：自带重试/退避/403-11140 restricted 透传/chat
// 主机回退；调用前 ctx.breathe + 经 opts.spacer 全局节流器排队，铁律 4 对它们
// 同样生效 —— 与 buddy/travel 各腿同款，绝不自己裸 fetch）：
//   连登日历  GET  {chat}/activity/growth/heatmap
//   连登状态  GET  {chat}/activity/growth/streak      （data.streak.days /
//                                                      data.makeup_cards.balance /
//                                                      data.redemption_status 同层，
//                                                      P1 实测口径）
//   补签昨日  POST {chat}/activity/growth/makeup-cards/use  {target_date}
//   档位兑换  POST {chat}/activity/growth/redeem      {tier, client_token}
//   抽奖次数  GET  {chat}/activity/growth/lottery/summary
//   抽奖      POST {chat}/activity/growth/lottery/draw {client_token}
//   新手礼包  POST {bill}/billing/meter/claim-gift     {}
//   活动补偿  POST {bill}/billing/meter/claim-compensation {}
//
// client_token 用 node:crypto 的 randomUUID()（与 engine/buddy.mjs 同款）；
// target_date = 北京昨日 = beijingDayKey(now - 86400000)（复用 engine/daily.mjs，
// 与容器时区无关 —— UTC 16:00 翻北京日的同一日界）。
//
// 红线：企业版 / API key 账号无成长体系 —— 直接 ok:true 跳过，一个上游请求都不
// 发；restricted（HTTP 403 / code 11140）透传给调用方走 §10.5 冻结；本模块绝不抛。

import { randomUUID } from "node:crypto";
import { beijingDayKey } from "./daily.mjs";
import { callJSON, ctxOf, billBase as _billBase, growthBase as _growthBase } from "./upstream.mjs";

// 档位兑换只认这三档（hub 口径）；redemption_status 里的取值见过
// "available"（可兑换）/ "locked"（未达成）/ "claimed"（已兑换）。
export const STREAK_TIERS = ["7d", "14d", "28d"];

// ---- 状态查询 ----------------------------------------------------------------

// fetchStreakState(acct, opts) -> 只读快照
// -> {ok:true, days, makeupCards, lotteryChances,
//     heatmap:[{date:"YYYY-MM-DD", score}], tiers:[{tier, status}], updatedISO}
//    任一子请求失败不影响其余字段（缺省 0 / []）；三个子请求全部失败 ->
//    {ok:false, error}。restricted 透传（调用方冻结）。
export async function fetchStreakState(acct, opts = {}) {
  const ctx = ctxOf(opts);
  const base = {
    ok: true,
    days: 0,
    makeupCards: 0,
    lotteryChances: 0,
    heatmap: [],
    tiers: STREAK_TIERS.map((tier) => ({ tier, status: "" })),
    updatedISO: new Date(ctx.now()).toISOString(),
  };

  // 企业版 / API key / 国际版没有成长体系：静默回零值状态，一个上游请求都不发
  //（runStreakSteward 与 daemon 的 GET /api/streak 都经这里，防御在唯一入口收口）。
  if (acct?.provider !== "workbuddy" || acct?.isApiKey || acct?.enterpriseId) {
    return { ...base, skipped: true };
  }

  let okCount = 0;
  let errText = "";
  let restricted = false;

  // 1) 连登状态：days = data.streak.days；补签卡 = data.makeup_cards.balance；
  //    档位状态 = data.redemption_status（{7d|14d|28d: status}，字段名保持上游原样）
  await ctx.breathe(); // 防风控：与上一次上游调用之间 ≥ gap
  const st = await callJSON(acct, "chat", chatUrl(opts) + "/activity/growth/streak", { method: "GET" }, opts);
  if (st.restricted) {
    return { ...base, ok: false, error: st.msg || "账号已被风控限制", restricted: true };
  }
  if (st.ok) {
    okCount += 1;
    base.days = Number(st.data?.streak?.days ?? 0) || 0;
    base.makeupCards = Number(st.data?.makeup_cards?.balance ?? 0) || 0;
    base.tiers = tiersFromRedemption(st.data?.redemption_status);
  } else {
    errText = st.msg || `HTTP ${st.status ?? 0}`;
  }

  // 2) 连登日历（近 28 天）：[{date, score}]；昨日格 score===0 才有补签一说的依据
  await ctx.breathe();
  const hm = await callJSON(acct, "chat", chatUrl(opts) + "/activity/growth/heatmap", { method: "GET" }, opts);
  if (hm.restricted) {
    return { ...base, ok: false, error: hm.msg || "账号已被风控限制", restricted: true };
  }
  if (hm.ok) {
    okCount += 1;
    base.heatmap = heatmapFrom(hm.data);
  } else if (!errText) {
    errText = hm.msg || `HTTP ${hm.status ?? 0}`;
  }

  // 3) 抽奖次数：chances = data.chances
  await ctx.breathe();
  const lt = await callJSON(acct, "chat", chatUrl(opts) + "/activity/growth/lottery/summary", { method: "GET" }, opts);
  if (lt.restricted) {
    return { ...base, ok: false, error: lt.msg || "账号已被风控限制", restricted: true };
  }
  if (lt.ok) {
    okCount += 1;
    base.lotteryChances = Number(lt.data?.chances ?? 0) || 0;
  } else if (!errText) {
    errText = lt.msg || `HTTP ${lt.status ?? 0}`;
  }

  if (okCount === 0) return { ...base, ok: false, error: errText || "连登状态查询全部失败" };
  return base;
}

// tiersFromRedemption(redemption_status)：把上游 redemption_status 收敛成固定三档
// 的 [{tier, status}]，缺的档 status 为空串 —— 状态未知，绝不瞎兑换。
//
// **上游真实形状（2026-11-11 生产实测 + hub fetch_growth_summary 同源）**：
//   { tiers:[…], tier_7d_status:"…", tier_14d_status:"…", tier_28d_status:"…" }
// 状态在**平铺的 tier_<档>_status** 键上，不在 tiers 数组项里 —— 早先按
// {7d:"available"} / [{tier,status}] 猜的两种形状都拿到空串，导致档位兑换永远
// 不发生（days / makeupCards 却解析正常，所以只有 get 回来看才露馅）。三种都认：
//   ① tier_7d_status（实测）→ ② tiers 数组项的 status/state → ③ {7d:"…"}（兼容）。
function tiersFromRedemption(rs) {
  const obj = rs && typeof rs === "object" ? rs : null; // 数组时本项为 null，走分支 ②
  const arr = Array.isArray(rs)
    ? rs
    : Array.isArray(obj?.tiers)
      ? obj.tiers
      : [];
  return STREAK_TIERS.map((tier) => {
    let status = "";
    if (obj && !Array.isArray(obj)) {
      status = obj[`tier_${tier}_status`] ?? ""; // ① 实测口径
      if (status === "") status = obj[tier] ?? obj[`${tier}_card`] ?? ""; // ③ 兼容旧猜测
    }
    if (status === "") {
      const hit = arr.find((x) => String(x?.tier ?? x?.name ?? "") === tier); // ②
      status = hit?.status ?? hit?.state ?? "";
    }
    return { tier, status: String(status ?? "") };
  });
}

// heatmapFrom(data)：日历格数组。**上游实测形状是 data.cells**（hub 的补签判断
// 就读 cells，2026-11-11 生产实测 heatmap 返回 0 格就是这个原因）—— 另外兼容
// data 本身是数组 / data.days / data.heatmap 三种可能外壳；格内认 date|day + score。
function heatmapFrom(data) {
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data?.cells)
      ? data.cells
      : Array.isArray(data?.days)
        ? data.days
        : Array.isArray(data?.heatmap)
          ? data.heatmap
          : [];
  return arr
    .map((x) => ({
      date: String(x?.date ?? x?.day ?? ""),
      score: Number(x?.score ?? 0) || 0,
    }))
    .filter((x) => x.date);
}

// ---- 主流程（wb_tasks.run_streak_bonus 的移植）-------------------------------

// runStreakSteward(acct, opts) ->
//   {ok, earned, restricted?, streak:<fetchStreakState 结果>, logs, actions}
//   actions = {makeup:{used:boolean, date}, gifts:[{key,name,credit}], redeemed:[], drawn}
// opts: {base?/bases?, gap?, now?, sleep?, fetch?, log(fn), spacer?, signal, env?}
//
// 执行顺序：补签 → 礼包/补偿 → 档位兑换 → 抽奖（每次调用之间自然受 ≥1s 全局
// 节流约束；抽奖多次之间也只靠节流，不额外 sleep）。幂等与静默跳过全部不报错、
// 只写一行说明。
export async function runStreakSteward(acct, opts = {}) {
  const ctx = ctxOf(opts);
  const logs = [];
  const push = (line) => {
    logs.push(line);
    ctx.log?.(line); // runner 通过 opts.log 收集人读日志
  };
  const actions = { makeup: { used: false, date: "" }, gifts: [], redeemed: [], drawn: 0 };
  let earned = 0;

  if (acct?.provider !== "workbuddy") {
    return { ok: false, earned, streak: null, logs: ["国际版不适用国内成长任务中心"], actions };
  }

  // 企业版 / API key：无成长体系，一个上游请求都不发（CONTRACT §10.1）
  if (acct?.enterpriseId || acct?.isApiKey) {
    return { ok: true, earned, streak: null, logs: ["企业版账号无成长体系，跳过"], actions };
  }

  // 0) 状态查询（连登状态 + 日历 + 抽奖次数，一次收齐）。查询整体失败不阻断：
  //    补签/兑换/抽奖失去依据各自跳过，礼包/补偿（不依赖状态）照做。
  const state = await fetchStreakState(acct, opts);
  if (state.restricted) {
    return { ok: false, earned, restricted: true, streak: state, logs, actions };
  }
  if (!state.ok) {
    push(`连登管家: 状态查询失败（${state.error || "未知原因"}），补签/兑换/抽奖本轮跳过`);
  }
  const name = acct.nickname || acct.uid.slice(0, 8);

  // 1) 补签昨日：昨日 heatmap 格 score === 0 且 makeup_cards.balance > 0 才补；
  //    否则不碰（没有补签卡 / 昨天本来就没断 / 日历里没有昨日格，都不发请求）。
  const yesterday = beijingDayKey(ctx.now() - 86400000);
  const ySlot = state.heatmap.find((h) => h.date === yesterday) ?? null;
  if (state.ok && ySlot && ySlot.score === 0 && state.makeupCards > 0) {
    await ctx.breathe();
    const res = await callJSON(
      acct, "chat", chatUrl(opts) + "/activity/growth/makeup-cards/use",
      { method: "POST", body: JSON.stringify({ target_date: yesterday }) },
      opts,
    );
    if (res.restricted) {
      return { ok: false, earned, restricted: true, streak: state, logs, actions };
    }
    if (res.ok) {
      actions.makeup = { used: true, date: yesterday };
      push(`[${name}] 连登管家: 已用补签卡补签 ${yesterday}`);
    } else {
      // 上游拒绝（可能已补过/卡不足）：静默跳过，不报错
      push(`[${name}] 连登管家: 补签未成功（${res.msg || `HTTP ${res.status ?? 0}`}），不重试`);
    }
  }

  // 2) 新手礼包 / 活动补偿（计费域）：业务拒绝（「已领取过」等）静默；只有
  //    code === 0 且 credit > 0 才计入 actions.gifts。
  for (const gift of [
    { key: "claim-gift", name: "新手礼包" },
    { key: "claim-compensation", name: "活动补偿" },
  ]) {
    await ctx.breathe();
    const res = await callJSON(
      acct, "billing", billUrl(opts) + `/billing/meter/${gift.key}`,
      { method: "POST", body: "{}" },
      opts,
    );
    if (res.restricted) {
      return { ok: false, earned, restricted: true, streak: state, logs, actions };
    }
    if (res.ok) {
      // 成功但 0 奖励（空礼包）也不算收益；data 里 credit/points/point 任一拼写
      const credit = Number(res.data?.credit ?? res.data?.points ?? res.data?.point ?? 0) || 0;
      if (credit > 0) {
        const giftName = String(res.data?.name ?? gift.name);
        actions.gifts.push({ key: gift.key, name: giftName, credit });
        earned += credit;
        push(`[${name}] 连登管家: 领取${giftName}成功，+${credit} 积分`);
      }
    }
    // code!==0（已领取过/条件不足等）：静默，一行都不写
  }

  // 3) 档位兑换：status 为 locked / claimed 跳过（幂等）；其余**已知状态**
  //   （如 available）才兑换 —— status 为空 = redemption_status 没给这一档
  //  （多半还没达成），状态未知绝不硬闯。
  if (state.ok) {
    for (const t of state.tiers) {
      const status = String(t.status ?? "").toLowerCase();
      if (!status || status === "locked" || status === "claimed") continue;
      await ctx.breathe();
      const res = await callJSON(
        acct, "chat", chatUrl(opts) + "/activity/growth/redeem",
        { method: "POST", body: JSON.stringify({ tier: t.tier, client_token: randomUUID() }) },
        opts,
      );
      if (res.restricted) {
        return { ok: false, earned, restricted: true, streak: state, logs, actions };
      }
      if (res.ok) {
        actions.redeemed.push(t.tier);
        const credit = Number(res.data?.credit ?? 0) || 0;
        if (credit > 0) earned += credit;
        push(`[${name}] 连登管家: ${t.tier} 档位兑换成功${credit ? `，+${credit} 积分` : ""}`);
      }
      // 业务拒绝（已兑换/未达成）：静默
    }
  }

  // 4) 抽奖：chances 为 0 不抽；抽几次由 chances 决定，每次之间只走全局节流
  //   （callJSON 经 spacer 排队），不额外 sleep（hub 口径）。
  if (state.ok && state.lotteryChances > 0) {
    for (let i = 0; i < state.lotteryChances; i++) {
      await ctx.breathe();
      const res = await callJSON(
        acct, "chat", chatUrl(opts) + "/activity/growth/lottery/draw",
        { method: "POST", body: JSON.stringify({ client_token: randomUUID() }) },
        opts,
      );
      if (res.restricted) {
        return { ok: false, earned, restricted: true, streak: state, logs, actions };
      }
      if (!res.ok) {
        // 抽奖失败（次数口径变动/活动结束）：停手，别把剩余次数硬闯完
        push(`[${name}] 连登管家: 第 ${i + 1} 次抽奖失败（${res.msg || `HTTP ${res.status ?? 0}`}），本轮停`);
        break;
      }
      actions.drawn += 1;
      const credit = Number(res.data?.credit ?? res.data?.points ?? 0) || 0;
      const prize = String(res.data?.name ?? res.data?.prize ?? "");
      if (credit > 0) earned += credit;
      push(`[${name}] 连登管家: 抽奖 ${actions.drawn} 次${prize ? `（${prize}）` : ""}${credit ? `，+${credit} 积分` : ""}`);
    }
  }

  if (!actions.makeup.used && !actions.gifts.length && !actions.redeemed.length && !actions.drawn) {
    push(`[${name}] 连登管家: 今日无可做的连登动作（已补过/已领过/无抽奖次数）`);
  }
  return { ok: true, earned, streak: state, logs, actions };
}

// ---- 内部小工具 ----------------------------------------------------------------

function chatUrl(opts = {}) {
  const fromOpts = String(opts.base || opts.bases?.chat || "").trim();
  return fromOpts ? fromOpts.replace(/\/+$/, "") : _growthBase(opts.env ?? globalThis.process?.env ?? {});
}

function billUrl(opts = {}) {
  const fromOpts = String(opts.bases?.bill || "").trim();
  return fromOpts ? fromOpts.replace(/\/+$/, "") : _billBase();
}

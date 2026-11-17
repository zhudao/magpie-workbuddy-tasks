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
//   连登日历  GET  {chat}/activity/growth/heatmap （data.cells 365 格全量一年 +
//                                                      data.today{date,...} 服务端今天）
//   连登状态  GET  {chat}/activity/growth/streak      （data.streak.days / makeup_dates /
//                                                      data.makeup_cards.balance 或
//                                                      裸数字 data.makeup_cards /
//                                                      data.launch_date /
//                                                      data.redemption_status 同层，
//                                                      P1 实测口径；redemption_status
//                                                      除平铺 tier_<档>_status 外，
//                                                      tiers[] 项还带每档奖励明细
//                                                      {tier,days,credit,energy,cards,
//                                                      chances}，2026-11-16 真机实测）
//   补签断点  POST {chat}/activity/growth/makeup-cards/use  {target_date}
//   档位兑换  POST {chat}/activity/growth/redeem      {tier, client_token}
//   抽奖次数  GET  {chat}/activity/growth/lottery/summary
//              （B2 回退源：拿不到时 GET {chat}/activity/growth/lottery/chances 的
//               data.balance，真机 2026-11-16 实测两源一致）
//   抽奖      POST {chat}/activity/growth/lottery/draw {client_token}
//   新手礼包  POST {bill}/billing/meter/claim-gift     {}
//   活动补偿  POST {bill}/billing/meter/claim-compensation {}
//
// client_token 用 node:crypto 的 randomUUID()（与 engine/buddy.mjs 同款）；
// target_date = 选中的断点日（A2 目标选择，makeupTargetOf：当月 / 服务端今天之前 /
// score 明确 0 / 未补过 / 不早于上线边界里**最近的一天**；服务端今天取
// heatmap.data.today.date，绝不用本机时区推日期当边界）。
//
// 红线：企业版 / API key 账号无成长体系 —— 直接 ok:true 跳过，一个上游请求都不
// 发；restricted（HTTP 403 / code 11140）透传给调用方走 §10.5 冻结；本模块绝不抛。

import { randomUUID } from "node:crypto";
import { callJSON, ctxOf, billBase as _billBase, growthBase as _growthBase } from "./upstream.mjs";

// 档位兑换只认这三档（hub 口径）；redemption_status 里的取值见过
// "available"（可兑换）/ "locked"（未达成）/ "claimed"（已兑换）。
export const STREAK_TIERS = ["7d", "14d", "28d"];

// ---- 回执解析（纯函数，测试直接钉）--------------------------------------------

// grantedOf(data)：奖励回执的统一解析。**实发字段带 _granted 后缀**
// （credit_granted / energy_granted / cards_granted / chances_granted）—— 这是
// 88lin/workbuddy-auto-signin（MIT）的实测口径（其 _redeem_reward_desc，本地只读
// 快照 Temp/wbas-ref/signin.py:1693-1714：「直接读 `credit` 恒为空，会把兑换所得
// 漏计」）。新字段优先、老字段（credit/energy/cards/chances）兜底，两种拼写都认
// 防上游回退；取值一律 Number(...)||0（字符串数字认、NaN/缺失记 0）。
// 返回 {credit, energy, cards, chances}（恒为数字）。
export function grantedOf(data) {
  const d = data && typeof data === "object" ? data : {};
  const num = (v) => Number(v) || 0;
  const pick = (nk, ok) => num(d[nk]) || num(d[ok]);
  return {
    credit: pick("credit_granted", "credit"),
    energy: pick("energy_granted", "energy"),
    cards: pick("cards_granted", "cards"),
    chances: pick("chances_granted", "chances"),
  };
}

// makeupCardsOf(data)：补签卡余额。**上游实测有两种形状**（兄弟实现
// signin.py:2012-2014 与其注释：「余额兼容两种形状：{"makeup_cards":{"balance":2}}
// 与 {"makeup_cards":2}。只认前者的话，接口是后者时整个补登会一声不响地永不执行」）：
//   ① data.makeup_cards.balance（对象，2026-11-11 生产实测口径）
//   ② data.makeup_cards 本身是数字（裸数字）
// 都缺 → 0。归一为数字，非有限/负数一律 0。
export function makeupCardsOf(data) {
  const v = data?.makeup_cards;
  const n = Number(v != null && typeof v === "object" ? v.balance : v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// makeupDatesOf(data)：已补签日期清单 = data.streak.makeup_dates（2026-11-16 真机
// 实测：数组，与 streak.days 同层；兄弟实现 signin.py:1580 同口径）。顶层
// data.makeup_dates 兜一层防换壳。条目归一成字符串；非数组/缺失 → []。
export function makeupDatesOf(data) {
  const raw = data?.streak?.makeup_dates ?? data?.makeup_dates;
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x ?? "").trim()).filter(Boolean);
}

// ---- A2：补签目标选择（纯函数，测试直接钉）------------------------------------

// LAUNCH_DATE_FALLBACK：活动上线边界。launch_date（真机 streak 响应里有）缺失或
// 格式无效时回落到已知上线日 2026-06-17（兄弟实现 signin.py:1576 同款硬边界）。
export const LAUNCH_DATE_FALLBACK = "2026-06-17";

// 合法日期串：YYYY-MM-DD（与上游一致；字符串比较即时间比较，不引入时区/Date 解析）。
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// makeupTargetOf(state)：从日历里选**本轮要补的那一天**。
// state = fetchStreakState 结果（heatmap:[{date,score}], today, makeupDates, launchDate）。
// 候选条件（兄弟实现 _makeup_candidates 逐条对齐，signin.py:1559-1601 —— 只取行为）：
//   当月（服务端今天的年月）∧ 服务端今天之前 ∧ score 明确 === 0（cellScoreOf 已把
//   脏数据归 null，=== 0 天然排除不可判定的格子）∧ 不在 makeup_dates（已补过的
//   日期是历史不是待办）∧ 不早于上线边界 max(月初, launch_date|回落, 2026-06-17)
//   —— 取其中**最近的一天**。
// 为什么用服务端 today（heatmap.data.today.date）而不是本机推的北京日：生产容器
// 是 UTC，本机时区差 8 小时会把月初/午夜前后选错月、把「服务端昨天」漏掉（测试
// ③钉死两个方向）。today 缺失/格式无效 → 不补（没有边界就不猜）；日历为空 → 不补。
// 返回 {date, reason}：date 为空串 = 本轮不补，reason 说明原因 —— 「无需补签」
// 「断点已补过」「日历读不到」是三种不同的原因，日志里绝不混为一谈。
export function makeupTargetOf(state) {
  const cells = Array.isArray(state?.heatmap) ? state.heatmap : [];
  const today = String(state?.today ?? "").trim();
  if (!cells.length) {
    return { date: "", reason: "连登日历为空（读不到格子），无从判断断点" };
  }
  if (!DATE_RE.test(today)) {
    return { date: "", reason: "日历未回服务端今天（today.date 缺失/格式无效），没有时间边界" };
  }
  const launchRaw = String(state?.launchDate ?? "").trim();
  const launch = DATE_RE.test(launchRaw) ? launchRaw : LAUNCH_DATE_FALLBACK;
  const monthStart = today.slice(0, 8) + "01";
  const start = launch > monthStart ? launch : monthStart;
  const madeUp = new Set(
    (Array.isArray(state?.makeupDates) ? state.makeupDates : [])
      .map((d) => String(d ?? "").trim())
      .filter((d) => DATE_RE.test(d)),
  );
  const zeros = cells
    .filter((c) => DATE_RE.test(String(c?.date ?? "")) && c.score === 0)
    .map((c) => String(c.date))
    .sort(); // YYYY-MM-DD 字符串升序 = 时间升序；取尾即最近
  if (!zeros.length) {
    return { date: "", reason: "日历里没有 0 分格（没有断签日），无需补签" };
  }
  const candidates = zeros.filter((d) => d >= start && d < today && !madeUp.has(d));
  if (candidates.length) {
    return { date: candidates[candidates.length - 1], reason: "" };
  }
  // 有 0 分格但没有可用候选：对**最近**的 0 分格解释为什么不能用（日志可读）
  const latest = zeros[zeros.length - 1];
  if (madeUp.has(latest) && latest >= start && latest < today) {
    return { date: "", reason: `最近断点 ${latest} 已补过（makeup_dates 已含），无需再补` };
  }
  const why = latest < start
    ? `早于可补边界 ${start}（仅当月、上线日之后才可补）`
    : latest >= today
      ? "不早于服务端今天"
      : "已补过";
  return { date: "", reason: `最近的 0 分格 ${latest} ${why}，无可补断点` };
}

// cellScoreOf(v)：日历格 score 的**可判定性**归一。只有「明确的有限数字」才返回
// 数字（number 或非空数字字符串），其余（null/undefined/布尔/空串/非数值串/NaN/
// 对象数组）→ null —— 状态未知。旧实现 `Number(x?.score ?? 0) || 0` 会把
// NaN/null/""/"abc" 一律归 0，而补签判据是 score===0 —— 脏数据会把「其实活跃或
// 状态未知」的日子当成断签，误花补签卡。兄弟实现同样只认明确的非负数字分数
//（signin.py:_makeup_candidates：`type(score) not in (int, float) or not
// math.isfinite(score)` 即视为无效，整段停止补登）。
function cellScoreOf(v) {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if ((t !== "number" && t !== "string") || v === "") return null; // 布尔/对象/数组/空串不可判定
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---- 状态查询 ----------------------------------------------------------------

// fetchStreakState(acct, opts) -> 只读快照
// -> {ok:true, days, makeupCards, lotteryChances,
//     heatmap:[{date:"YYYY-MM-DD", score:number|null, raw}],
//     tiers:[{tier:"7d"|"14d"|"28d", status:string,
//             days:number|null, credit:number|null, energy:number|null,
//             cards:number|null, chances:number|null, count:number|null}],
//                                 // 档位状态 + 奖励明细：status 口径不变（平铺
//                                 // tier_<档>_status 优先）；days/credit/energy/
//                                 // cards/chances 合并自 redemption_status.tiers[]
//                                 // 项（2026-11-16 真机口径），count 收平铺
//                                 // tier_<档>_count；上游没给/形状异常/脏值 →
//                                 // null（0 是合法值，与「上游没说」可区分，看板
//                                 // 据此隐藏），绝不报错、绝不猜
//     updatedISO,
//     today:"YYYY-MM-DD",     // 服务端今天 = heatmap data.today.date（A2 的时间边界；缺失 ""）
//     makeupDates:["YYYY-MM-DD"], // 已补签日期 = streak data.streak.makeup_dates（A2 排除已补）
//     launchDate:"YYYY-MM-DD",    // 活动上线日 = streak data.launch_date 原样（缺失 ""，选目标时回落）
//     nextTier:string,            // B5 投影：streak data.streak.next_tier（如 "28d"，缺失 ""）
//     nextTierRemaining:number|null, // B5 投影：data.streak.next_tier_remaining（天，缺失/非数字 null）
//     remainingDays:number|null,  // B5 投影：redemption_status.remaining_days（缺失/非数字 null）
//     todayActive:{active:boolean|null, statusText:string}|null,
//                                 // B5 投影：heatmap data.today.is_active/status_text；
//                                 // heatmap 查询失败 → null（状态未知，绝不瞎猜）
//     lotterySource:"summary"|"chances", // B2：抽奖次数来自哪个上游源（诊断用）
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
    today: "",
    makeupDates: [],
    launchDate: "",
    nextTier: "",
    nextTierRemaining: null,
    remainingDays: null,
    todayActive: null,
    lotterySource: "",
    tiers: STREAK_TIERS.map((tier) => ({
      tier,
      status: "",
      days: null,
      credit: null,
      energy: null,
      cards: null,
      chances: null,
      count: null,
    })),
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

  // 1) 连登状态：days = data.streak.days；补签卡 = data.makeup_cards.balance 或
  //    裸数字 data.makeup_cards（makeupCardsOf 两种形状都认）；
  //    档位状态 = data.redemption_status（{7d|14d|28d: status}，字段名保持上游原样）
  await ctx.breathe(); // 防风控：与上一次上游调用之间 ≥ gap
  const st = await callJSON(acct, "chat", chatUrl(opts) + "/activity/growth/streak", { method: "GET" }, opts);
  if (st.restricted) {
    return { ...base, ok: false, error: st.msg || "账号已被风控限制", restricted: true };
  }
  if (st.ok) {
    okCount += 1;
    base.days = Number(st.data?.streak?.days ?? 0) || 0;
    base.makeupCards = makeupCardsOf(st.data); // 两种形状都认（对象 balance / 裸数字）
    base.makeupDates = makeupDatesOf(st.data); // 已补签日期（A2 排除已补断点用）
    base.launchDate = String(st.data?.launch_date ?? "").trim(); // 上线日（缺失选目标时回落）
    base.tiers = tiersFromRedemption(st.data?.redemption_status);
    // B5 投影（2026-11-16 真机口径）：next_tier("28d") / next_tier_remaining(天) /
    // redemption_status.remaining_days —— 只读快照字段，缺失/非数字如实 null，
    // 绝不为它多发任何上游请求。
    base.nextTier = String(st.data?.streak?.next_tier ?? "").trim();
    // null/undefined/空串是「上游没给」—— Number(null)===0 会把缺失误读成 0，
    // 先剔掉再转数字（0 是合法值，不能误伤）
    const numOrNull = (v) =>
      v === null || v === undefined || v === "" ? Number.NaN : Number(v);
    const ntr = numOrNull(st.data?.streak?.next_tier_remaining);
    base.nextTierRemaining = Number.isFinite(ntr) ? ntr : null;
    const rd = numOrNull(st.data?.redemption_status?.remaining_days);
    base.remainingDays = Number.isFinite(rd) ? rd : null;
  } else {
    errText = st.msg || `HTTP ${st.status ?? 0}`;
  }

  // 2) 连登日历（365 天，真机 cells 全量一年 + data.today 是服务端今天，2026-11-16
  //    实测）：断点判定 = 当月内 score 明确 0 的历史格 —— 全量日历正是 A2 目标选择的依据
  await ctx.breathe();
  const hm = await callJSON(acct, "chat", chatUrl(opts) + "/activity/growth/heatmap", { method: "GET" }, opts);
  if (hm.restricted) {
    return { ...base, ok: false, error: hm.msg || "账号已被风控限制", restricted: true };
  }
  if (hm.ok) {
    okCount += 1;
    base.heatmap = heatmapFrom(hm.data);
    base.today = String(hm.data?.today?.date ?? "").trim(); // 服务端今天（A2 边界）
    // B5 投影：data.today.is_active（布尔）/ status_text（文本）—— 只有真布尔才认，
    // "null" 字符串/缺失 → active:null（状态未知绝不瞎猜）；heatmap 查询失败时
    // 整个 todayActive 保持 null。
    const today = hm.data?.today;
    base.todayActive = {
      active: typeof today?.is_active === "boolean" ? today.is_active : null,
      statusText: String(today?.status_text ?? ""),
    };
  } else if (!errText) {
    errText = hm.msg || `HTTP ${hm.status ?? 0}`;
  }

  // 3) 抽奖次数：chances = data.chances。B2 回退源：/lottery/summary 拿不到 →
  //    GET /activity/growth/lottery/chances 的 data.balance（真机 2026-11-16 实测两源
  //    一致）；两个来源都失败才按未知（0 + errText）处理。
  await ctx.breathe();
  const lt = await callJSON(acct, "chat", chatUrl(opts) + "/activity/growth/lottery/summary", { method: "GET" }, opts);
  if (lt.restricted) {
    return { ...base, ok: false, error: lt.msg || "账号已被风控限制", restricted: true };
  }
  if (lt.ok) {
    okCount += 1;
    base.lotteryChances = Number(lt.data?.chances ?? 0) || 0;
    base.lotterySource = "summary";
  } else {
    await ctx.breathe();
    const fb = await callJSON(acct, "chat", chatUrl(opts) + "/activity/growth/lottery/chances", { method: "GET" }, opts);
    if (fb.restricted) {
      return { ...base, ok: false, error: fb.msg || "账号已被风控限制", restricted: true };
    }
    if (fb.ok) {
      okCount += 1;
      base.lotteryChances = Number(fb.data?.balance ?? 0) || 0;
      base.lotterySource = "chances";
    } else if (!errText) {
      errText = lt.msg || `HTTP ${lt.status ?? 0}`;
    }
  }

  if (okCount === 0) return { ...base, ok: false, error: errText || "连登状态查询全部失败" };
  return base;
}

// tiersFromRedemption(redemption_status)：把上游 redemption_status 收敛成固定三档
// 的 [{tier, status, days, credit, energy, cards, chances, count}]，缺的档 status
// 为空串 —— 状态未知，绝不瞎兑换。
//
// **上游真实形状（2026-11-11 生产实测 + hub fetch_growth_summary 同源；2026-11-16
// 真机补测 tiers[] 项带每档奖励明细）**：
//   { tiers:[{tier:"7d", days:7, credit:N, energy:N, cards:N, chances:N}, …],
//     tier_7d_status:"…", tier_14d_status:"…", tier_28d_status:"…", tier_7d_count?:N }
// 状态在**平铺的 tier_<档>_status** 键上，不在 tiers 数组项里 —— 早先按
// {7d:"available"} / [{tier,status}] 猜的两种形状都拿到空串，导致档位兑换永远
// 不发生（days / makeupCards 却解析正常，所以只有 get 回来看才露馅）。三种都认：
//   ① tier_7d_status（实测）→ ② tiers 数组项的 status/state → ③ {7d:"…"}（兼容）。
// **奖励明细按档位名合并** tiers[] 项（status 来源口径不动）：days/credit/energy/
// cards/chances 上游给了合法数字就归一成数字，没给/脏值 → null（rewardNumOf）；
// count 收平铺的 tier_<档>_count（真机计数键，tiers[] 项的 count 兜底）。tiers[]
// 缺失/形状异常 → 只出 {tier,status} + 五键 + count 全 null，绝不报错、绝不猜；
// 0 是合法值（上游明确说 0 就如实 0），与「上游没说」（null）严格可区分，看板据此隐藏。
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
    const hit = arr.find((x) => String(x?.tier ?? x?.name ?? "") === tier); // 档位项（奖励明细在这里）
    if (status === "") {
      status = hit?.status ?? hit?.state ?? ""; // ②
    }
    return {
      tier,
      status: String(status ?? ""),
      days: rewardNumOf(hit?.days),
      credit: rewardNumOf(hit?.credit),
      energy: rewardNumOf(hit?.energy),
      cards: rewardNumOf(hit?.cards),
      chances: rewardNumOf(hit?.chances),
      count:
        rewardNumOf(obj && !Array.isArray(obj) ? obj[`tier_${tier}_count`] : undefined) ??
        rewardNumOf(hit?.count),
    };
  });
}

// rewardNumOf(v)：奖励明细的可判定性归一（与 cellScoreOf 同思路、口径更收紧）。
// 只有「明确的非负有限数字」（number 或非空数字字符串）才返回数字；其余
//（null/undefined/空串/布尔/对象数组/非数值串/NaN/负数）→ null —— 「上游没说」
// 与「说了脏值」同归 null，绝不拿 0 或负数冒充有效明细（看板对 null 整项隐藏）。
// 0 是合法值：上游明确给 0 就如实 0（与 null 可区分，绝不用 ||0 把它抹掉）。
function rewardNumOf(v) {
  if (v === null || v === undefined || v === "" || typeof v === "boolean" || typeof v === "object") {
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// heatmapFrom(data)：日历格数组。**上游实测形状是 data.cells**（hub 的补签判断
// 就读 cells，2026-11-11 生产实测 heatmap 返回 0 格就是这个原因）—— 另外兼容
// data 本身是数组 / data.days / data.heatmap 三种可能外壳；格内认 date|day + score。
// 2026-11-16 真机实测：cells 365 格全量一年，格内另有 has_new_buddy（当日是否换了
// 新 Buddy）—— 对连登/补签无用，本函数不透传（将来 B8 若要用再扩）；同层的
// range{start_date,end_date,days} 与 updated_at 也不透传。
//
// 格形状 {date, score, raw}：
//   score = 可判定性归一后的数字或 **null**（cellScoreOf：脏/缺失/不可判定 → null）；
//   raw   = 上游 score 原值原样保留（诊断脏数据用；缺失时为 undefined，
//           JSON.stringify 会自动丢掉，不进快照）。
// 向后兼容：看板（dashboard/app.js）只读 date/score 并自带 streakNum 归一，
// score:null 展示为 0 分格 —— 展示层不参与任何逻辑判断（CONTRACT §10.8）。
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
    .map((x) => {
      const raw = x?.score;
      return {
        date: String(x?.date ?? x?.day ?? ""),
        score: cellScoreOf(raw),
        raw,
      };
    })
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

  // 1) 补签（A2 目标选择）：候选 = 当月 / 服务端今天之前 / score 明确 0 / 不在
  //    makeup_dates（已补过的是历史）/ 不早于上线边界（launch_date|2026-06-17），取
  //    **最近的一天**。**每轮最多补 1 张卡**（兄弟实现 MAKEUP_MAX_PER_RUN=1 同口径
  //    signin.py:93/2024 —— 补签会改变连登天数，一张一张来，下轮重新拿最新日历/余额
  //    再补，绝不循环补）。makeupCards > 0 才发请求；score 为 null（脏数据/缺失/
  //    不可判定，cellScoreOf 归一）天然不进候选 —— 宁可少补，绝不误花补签卡；
  //    日历读不到 / 服务端 today 缺失 / 无候选 一律不发请求，且日志写明是哪种原因
  //   （「无需补签」「已补过」「日历读不到」不混为一谈）。
  if (state.ok) {
    const target = makeupTargetOf(state);
    if (target.date && state.makeupCards > 0) {
      await ctx.breathe();
      const res = await callJSON(
        acct, "chat", chatUrl(opts) + "/activity/growth/makeup-cards/use",
        { method: "POST", body: JSON.stringify({ target_date: target.date }) },
        opts,
      );
      if (res.restricted) {
        return { ok: false, earned, restricted: true, streak: state, logs, actions };
      }
      if (res.ok) {
        actions.makeup = { used: true, date: target.date };
        push(`[${name}] 连登管家: 已用补签卡补签 ${target.date}（当月最近断点）`);
      } else {
        // 上游拒绝（可能已补过/卡不足）：静默跳过，不报错
        push(`[${name}] 连登管家: 补签未成功（${res.msg || `HTTP ${res.status ?? 0}`}），不重试`);
      }
    } else if (target.date) {
      push(`[${name}] 连登管家: 有可补断点 ${target.date}，但补签卡余额为 0，本轮不补`);
    } else {
      push(`[${name}] 连登管家: 补签跳过（${target.reason}）`);
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
      // 成功但全 0 奖励（空礼包）也不算收益。回执拼写：legacy 是
      // credit/points/point 任一；若上游换 *_granted 新信封也认（grantedOf 新字段
      // 优先）。兄弟实现没有 claim-gift/claim-compensation 端点（signin.py 全文无
      // 此路径），礼包回执是否带 *_granted 未实测 —— 三种拼写都认，防漏记。
      const credit = grantedOf(res.data).credit ||
        Number(res.data?.points ?? res.data?.point ?? 0) || 0;
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
        // 兑换回执的实发字段带 _granted 后缀（兄弟实现实测，signin.py:1693-1714
        // 「直接读 credit 恒为空，会把兑换所得漏计」）：统一走 grantedOf
        //（新字段优先、老字段兜底）。earned 只记积分；能量/补签卡/抽奖次数进日志。
        const g = grantedOf(res.data);
        earned += g.credit;
        // 兑换自检（A1 记账 bug 的防线）：预期积分 = 该档 tiers[] 奖励明细里的
        // credit（null = 上游没给明细，无从对照）。预期存在时日志写「实发 vs 预期」；
        // 不一致只追加一句说明（上游回执是唯一事实），**绝不因不一致判失败**，
        // earned 永远按实发记。
        const expect = Number.isFinite(t.credit) ? t.credit : null;
        const bits = [];
        if (g.energy > 0) bits.push(`+${g.energy} 能量`);
        if (g.cards > 0) bits.push(`+${g.cards} 补签卡`);
        if (g.chances > 0) bits.push(`+${g.chances} 次抽奖`);
        if (expect === null) {
          // 预期缺失（上游没给奖励明细/旧形状）：维持旧措辞，只写实发
          const all = g.credit > 0 ? [`+${g.credit} 积分`, ...bits] : bits;
          push(`[${name}] 连登管家: ${t.tier} 档位兑换成功${all.length ? `（${all.join(" ")}）` : ""}`);
        } else {
          const diff = g.credit - expect;
          const tail =
            diff === 0
              ? `（预期 +${expect}）`
              : `（预期 +${expect}，与预期差 ${diff > 0 ? "+" : ""}${diff}，见上游回执）`;
          push(
            `[${name}] 连登管家: ${t.tier} 档位兑换成功：实发 +${g.credit} 积分${tail}` +
              `${bits.length ? `，${bits.join(" ")}` : ""}`,
          );
        }
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
        const m = String(res.msg ?? "").toLowerCase();
        if (m.includes("insufficient") && m.includes("chance")) {
          // B2：「insufficient lottery chance balance」类 400 是**常态**业务拒绝
          //（次数口径对不上/刚被别处消费），不是故障 —— 不记失败，如实记一行就停手。
          push(`[${name}] 连登管家: 抽奖次数余额不足（${res.msg || `HTTP ${res.status ?? 0}`}），本轮停`);
          break;
        }
        // 抽奖失败（次数口径变动/活动结束）：停手，别把剩余次数硬闯完
        push(`[${name}] 连登管家: 第 ${i + 1} 次抽奖失败（${res.msg || `HTTP ${res.status ?? 0}`}），本轮停`);
        break;
      }
      actions.drawn += 1;
      const credit = Number(res.data?.credit ?? res.data?.points ?? 0) || 0;
      const prize = String(res.data?.name ?? res.data?.prize ?? "");
      if (credit > 0) earned += credit;
      push(`[${name}] 连登管家: 抽奖 ${actions.drawn} 次${prize ? `（${prize}）` : ""}${credit ? `，+${credit} 积分` : ""}`);
      // B2：中实物奖（回执 need_address / require_address 任一为真）→ 提示到
      // 成长中心填收件信息（插件不代填，也绝不为此多发请求）。
      if (res.data?.need_address === true || res.data?.require_address === true) {
        push(`[${name}] 连登管家: 中实物奖，需到成长中心填收件信息`);
      }
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

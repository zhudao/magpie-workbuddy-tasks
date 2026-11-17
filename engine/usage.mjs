// usage.mjs —— 积分用量明细（只读新能力，B6；看板 UI 由前端同事另做）。
//
// 上游（真机 2026-11-16 生产只读探测 + 2026-11-16 二次实测修正外壳，字段名照抄）：
//   POST {bill}/billing/meter/get-user-request-usage
//        body {startTime:"YYYY-MM-DD HH:MM:SS", endTime:同, pageNum, pageSize}
//        —— **北京时间、秒精度、camelCase**；响应外壳 = **`data.total`（number，
//        命中总数，唯一的「还有没有下一页」依据）+ `data.data[]`（行数组）** ——
//        与 get-user-resource 的腾讯云 PascalCase 壳**不同族**（没有
//        pageNum/pageSize 回显、没有 hasMore/next/totalPages）；
//   行 = requestId(string), credit(number 浮点如 0.28/0.3), model, client,
//        requestTime(string len=19 = **北京时间裸串**), agentPurpose, appType,
//        subscribeType **以及 input/inputTrunc = prompt 原文**。
//
// 隐私红线（本文件存在的底线）：行里的 input / inputTrunc 是 **prompt 原文** ——
// 归一化时**显式丢弃**（白名单字段之外一律不带走），绝不出本模块、绝不落盘、
// 绝不进日志/回执/看板。normalizeRow 只保留
//   {requestId, credit, model, client, agentPurpose, requestTime}
// 六个字段 —— 任何人要扩白名单，先想清楚这三个「绝不」。
//
// 时区口径：上游时间就是北京时间 —— requestTime 的日期段直接就是「北京日」
//（手工拆裸串取日期段，绝不走 new Date() 的宿主时区解释，容器是 UTC 会串日）；
// 带偏移的 ISO 串先换算成 epoch ms 再取北京日。beijingTimeStr 输出与
// engine/credits.epochToBeijingText 同一款（UTC 毫秒 +8h 取 UTC 分量）。
//
// 铁律 4：每次上游调用走 callJSON（billing 头族），调用前 ctx.breathe；翻页是
// 串行循环，绝不并发；分页自带上限（maxPages 默认 10、硬上限 50），绝不无限翻。

import { billBase, callJSON, ctxOf } from "./upstream.mjs";
import { epochToBeijingText } from "./credits.mjs";

const USAGE_PATH = "/billing/meter/get-user-request-usage";

// beijingTimeStr(ms) -> "YYYY-MM-DD HH:MM:SS"（北京时间，秒精度）。
// 复用项目既有的北京时区口径（engine/credits.epochToBeijingText：UTC 毫秒 +8h
// 取 UTC 分量），绝不用本机时区。非有限值 → ""。
export const beijingTimeStr = epochToBeijingText;

// usageWindow(days, nowMs) -> {startTime, endTime}
// 「最近 N 天（含今天）」的查询窗口，两端都是北京时间秒精度字符串：
//   startTime = (北京今天 -(N-1) 天) 的 00:00:00；endTime = 北京的现在。
// nowMs 可注入（测试拨表）。days 非法/小于 1 按 1 处理。
export function usageWindow(days, nowMs) {
  const n = Math.max(1, Math.floor(Number(days) || 1));
  const ms = Number(nowMs);
  const now = Number.isFinite(ms) ? ms : Date.now();
  // 北京日期串（UTC 毫秒 +8h 取 UTC 分量，与 engine/daily.beijingDayKey 同口径）
  const bjDate = (t) => {
    const d = new Date(t + 8 * 3600 * 1000);
    const pad = (x) => String(x).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  const startDay = bjDate(now - (n - 1) * 86400000);
  const startMs = Date.parse(`${startDay}T00:00:00+08:00`);
  return {
    startTime: beijingTimeStr(startMs),
    endTime: beijingTimeStr(now),
  };
}

// 行数组的候选路径链（依序探测，第一个命中的数组即行）。**真机 2026-11-16 二次
// 实测：行数组就在信封 data 的 data 键**（data.total + data.data[]）—— 排第一；
// 其余是早先按 get-user-resource 同族猜测的 PascalCase/snake/camel 外壳（仅作
// 兜底保留，防上游换壳时彻底失明）。
const ROW_PATHS = [
  ["data"],
  ["Response", "Data", "Records"],
  ["Response", "Data", "records"],
  ["Response", "Data", "rows"],
  ["Response", "Data", "List"],
  ["Response", "Records"],
  ["Response", "records"],
  ["Records"],
  ["records"],
  ["rows"],
  ["list"],
  ["items"],
];

// rowsFrom(data)：按 ROW_PATHS 依序找行数组。命中 → {rows, path}（path 用于诊断
// 日志）；全未命中 → null（调用方把「试过哪些路径 + 实际看到的外壳键」写进 error）。
function rowsFrom(data) {
  const d = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  for (const path of ROW_PATHS) {
    let cur = d;
    for (const k of path) {
      cur = cur && typeof cur === "object" ? cur[k] : undefined;
    }
    if (Array.isArray(cur)) return { rows: cur, path: path.join(".") };
  }
  return null;
}

// shellKeysOf(data)：响应 data 顶层键名（外壳不符时的诊断文案用，绝不含行内容）。
function shellKeysOf(data) {
  const d = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return Object.keys(d);
}

// totalOf(data)：命中总数（唯一的「还有没有下一页」依据）。真机 = data.total
//（number）；旧猜测外壳兜 Response.Data.TotalCount / Response.TotalCount；都没有
// → null（退回「不足一页」启发式判页）。
function totalOf(data) {
  const d = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  for (const v of [d.total, d?.Response?.Data?.TotalCount, d?.Response?.TotalCount]) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// normalizeRow(raw)：行归一 —— **白名单制**，见文件头「隐私红线」。
// credit 一律 Number（非有限 → 0）；其余字符串字段 String()。requestTime 原样
// 保留（北京时间的字符串，分桶在 summarizeUsage 里做）。
function normalizeRow(raw) {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const credit = Number(o.credit);
  return {
    requestId: String(o.requestId ?? o.request_id ?? ""),
    credit: Number.isFinite(credit) ? credit : 0,
    model: String(o.model ?? ""),
    client: String(o.client ?? ""),
    agentPurpose: String(o.agentPurpose ?? o.agent_purpose ?? ""),
    requestTime: String(o.requestTime ?? o.request_time ?? ""),
  };
}

// fetchRequestUsage(acct, {startTime, endTime, pageSize=100, maxPages=10}, opts)
//   -> {ok:true, rows, pages, total?, truncated?} | {ok:false, error, needRelogin?}
//
// 翻页（真机 2026-11-16 实测：只有 data.total，没有 hasMore/pageNum 回显）：
//   · 下一页判据 = **total > pageNum*pageSize**（total 缺失/非有限值时退回旧的
//     「整页才继续」启发式）；
//   · 「不足一页」（rows < pageSize）仍可提前停（上游口径下就是最后一页；
//     若此时 total 反而更大，是上游自相矛盾 —— 如实按拿到的行数收工，不硬闯）；
//   · 达 maxPages 仍未到底（total > maxP*pageSize，或 total 未知且末页仍整页）
//     → truncated:true —— 如实告诉调用方「可能还有更多」，绝不静默截断；
//   · 中途失败：整体 {ok:false, error}，**不带回半截 rows**（防调用方把部分聚合
//     当全量展示）。401/403 或错误文本含登录话术 → needRelogin（与 /api/credits
//     同口径）。total 已知时随 ok 结果带回（诊断用）。
// opts: {base?/bases?.bill, gap?, now?, sleep?, fetch?, spacer?, signal, env?}
export async function fetchRequestUsage(acct, { startTime, endTime, pageSize = 100, maxPages = 10 } = {}, opts = {}) {
  const ctx = ctxOf(opts);
  const RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
  if (!RE.test(String(startTime ?? "")) || !RE.test(String(endTime ?? ""))) {
    return { ok: false, error: "startTime/endTime 必须是北京时间秒精度格式：YYYY-MM-DD HH:MM:SS" };
  }
  const size = Math.min(Math.max(Math.floor(Number(pageSize) || 100), 1), 200);
  const maxP = Math.min(Math.max(Math.floor(Number(maxPages) || 10), 1), 50);
  const rows = [];
  let pages = 0;
  let truncated = false;
  let total = null;
  for (let pageNum = 1; pageNum <= maxP; pageNum++) {
    await ctx.breathe(); // 防风控：与上一次上游调用之间 ≥ gap（翻页也照走）
    let res;
    try {
      res = await callJSON(
        acct, "billing", billBase() + USAGE_PATH,
        { method: "POST", body: JSON.stringify({ startTime, endTime, pageNum, pageSize: size }) },
        opts,
      );
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
    if (!res?.ok) {
      const text = `${res?.msg ?? ""} ${res?.raw ?? ""} ${res?.error ?? ""}`;
      const needRelogin = res?.status === 401 || res?.status === 403 || /登录|过期|token|Authorization/i.test(text);
      return {
        ok: false,
        error: String(res?.msg || res?.error || `HTTP ${res?.status ?? 0}`),
        ...(needRelogin ? { needRelogin: true } : {}),
      };
    }
    const found = rowsFrom(res.data);
    if (!found) {
      // 外壳形状不符：把「实际看到的外壳键 + 试过哪些路径」写进 error，下次一眼诊断
      //（路径相对响应信封标注：data.* = 信封 data 的子键，真机行在 data.data）
      const keys = shellKeysOf(res.data);
      return {
        ok: false,
        error:
          `响应里找不到用量行（外壳形状不符：data 键=[${keys.join(",")}]，` +
          `已试路径=[${ROW_PATHS.map((p) => `data.${p.join(".")}`).join("、")}]）`,
      };
    }
    total = totalOf(res.data);
    for (const raw of found.rows) rows.push(normalizeRow(raw));
    pages = pageNum;
    if (found.rows.length < size) break; // 不足一页：提前停（最后一页）
    const moreByTotal = total !== null ? total > pageNum * size : true; // total 未知 → 沿用整页启发式
    if (!moreByTotal) break; // total 明确说没有更多
    if (pageNum === maxP) truncated = true; // 达翻页上限仍未到底 → 如实标记
  }
  return {
    ok: true,
    rows,
    pages,
    ...(total !== null ? { total } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

// beijingDayOfRequestTime(raw)：行时间 → 北京日键 "YYYY-MM-DD"；解析不出 → null。
// **真机 2026-11-16 实测：requestTime 是 "YYYY-MM-DD HH:MM:SS" 的北京时间裸串**
//（20/20 行过该正则，不是时间戳也不是默认 ISO）—— 日期段**手工拆出来直接就是
// 北京日**，绝不走 new Date()（宿主是 UTC 容器会把裸串按本地时区解释，跨日边界
// 必串日）。T 分隔的无偏移串按同一口径（与 credits.beijingTextToMs 一致）；
// 带偏移/Z 的 ISO 串先 Date.parse 成 epoch ms 再 +8h 取北京日。
const NAIVE_BJ_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;
const CN_TZ_OFFSET_MS = 8 * 3600 * 1000;
function beijingDayOfRequestTime(raw) {
  const s = String(raw ?? "").trim();
  const naive = NAIVE_BJ_RE.exec(s);
  if (naive) return naive[1]; // 北京时间裸串：日期段即北京日
  if (/(?:Z|z|[+-]\d{2}:?\d{2})$/.test(s)) {
    // 带明确时区的 ISO 串：换算成 epoch ms 再落北京日（+08:00 口径）
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) {
      const d = new Date(ms + CN_TZ_OFFSET_MS);
      const pad = (x) => String(x).padStart(2, "0");
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
  }
  return null;
}

// summarizeUsage(rows, {tz="+08:00"}) -> 纯函数，测试直接钉
//   {totalCredit, count, unparsed, days:[{date,credit,count}], models:[{model,credit,count}]}
//
// 按**北京日**分桶：requestTime 是北京时间裸串（"YYYY-MM-DD HH:MM:SS"，见
// beijingDayOfRequestTime）—— 手工拆日期段就是北京日，绝不做宿主时区换算。
// tz 参数是接口预留：上游时间恒为北京时间，目前只实现 "+08:00" 语义（其它值按
// +08:00 处理并在调用方注释里说明）。
// 解析失败（requestTime 缺失/裸串格式不符/ISO 带偏移但解析不出）的行：只计入
// 总数（count/totalCredit），不参与分桶，unparsed 计数。days 按日期升序；models
// 按 credit 降序、再按条数降序、再按 model 字典序（输出稳定，前端直接渲染）。
export function summarizeUsage(rows, { tz = "+08:00" } = {}) {
  void tz; // 上游时间恒为北京时间（见函数注释）；参数仅为签名稳定预留
  const list = Array.isArray(rows) ? rows : [];
  let totalCredit = 0;
  let unparsed = 0;
  const dayMap = new Map();
  const modelMap = new Map();
  for (const r of list) {
    const credit = Number(r?.credit);
    const c = Number.isFinite(credit) ? credit : 0;
    totalCredit += c;
    const date = beijingDayOfRequestTime(r?.requestTime);
    if (!date) {
      unparsed += 1;
      continue; // 解析失败：计入总数，不参与分桶
    }
    const day = dayMap.get(date) ?? { date, credit: 0, count: 0 };
    day.credit = Math.round((day.credit + c) * 100) / 100 + 0;
    day.count += 1;
    dayMap.set(date, day);
    const model = String(r?.model ?? "");
    const mkey = model === "" ? "(unknown)" : model;
    const mo = modelMap.get(mkey) ?? { model: mkey, credit: 0, count: 0 };
    mo.credit = Math.round((mo.credit + c) * 100) / 100 + 0;
    mo.count += 1;
    modelMap.set(mkey, mo);
  }
  const days = [...dayMap.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const models = [...modelMap.values()].sort(
    (a, b) => b.credit - a.credit || b.count - a.count || (a.model < b.model ? -1 : 1),
  );
  return { totalCredit: Math.round(totalCredit * 100) / 100 + 0, count: list.length, unparsed, days, models };
}

// fetchUsageSummary(acct, {days=7}, opts) -> 守护进程 /api/usage 的引擎出口
//   {ok:true, usage:{startTime, endTime, totalCredit, count, unparsed,
//                    days:[{date,credit,count}], models:[{model,credit,count}],
//                    truncated?, updatedAt, updatedISO}}
//   | {ok:false, error, needRelogin?}
// 窗口 = usageWindow(days, ctx.now())；行来自 fetchRequestUsage（prompt 原文在
// 模块内就被丢弃，见文件头红线），汇总 = summarizeUsage。
// ⚠️ 命名约定（前端唯一依据）：usage.days 是**北京日分桶数组**（summarizeUsage
// 契约原样）；请求的窗口长度（1–90）由守护进程放在响应顶层的 days 字段，不在
// usage 里重复出现。
export async function fetchUsageSummary(acct, { days = 7 } = {}, opts = {}) {
  const ctx = ctxOf(opts);
  const n = Math.min(Math.max(Math.floor(Number(days) || 7), 1), 90);
  const { startTime, endTime } = usageWindow(n, ctx.now());
  const res = await fetchRequestUsage(
    acct,
    { startTime, endTime, pageSize: 100, maxPages: 10 },
    opts,
  );
  if (!res.ok) {
    return { ok: false, error: res.error, ...(res.needRelogin ? { needRelogin: true } : {}) };
  }
  const summary = summarizeUsage(res.rows);
  const at = ctx.now();
  return {
    ok: true,
    windowDays: n,
    usage: {
      startTime,
      endTime,
      totalCredit: summary.totalCredit,
      count: summary.count,
      unparsed: summary.unparsed,
      days: summary.days, // 北京日分桶 [{date,credit,count}]（与 summarizeUsage 契约同形）
      models: summary.models,
      ...(res.truncated ? { truncated: true } : {}),
      updatedAt: at,
      updatedISO: beijingTimeStr(at),
    },
  };
}

// tasks.mjs —— 国内版成长任务批量自动化流水线（wb_tasks.py 的移植）。
//
// 流程铁序（CONTRACT §7 / wb_tasks.run_growth_tasks）：
//   auto 任务先点亮领取（first_buddy 是前置）→ 批量接取 → 复查 → 二次补接
//   → 逐任务点亮（上报 + 轮询进度）→ 领奖 → 猫猫旅行 → 结算。
//
// 防风控：所有上游调用之间 ≥1 s（ctx.breathe，假时钟下可断言）；上报后等
// 1.5 s、轮询进度最多 6 次（在涨再等 2.5 s），没到位就把领奖顺延到下一轮，
// 绝不硬闯。时钟全部走 opts.now / opts.sleep。

import {
  ACCEPT_CHUNK,
  CLAIM_POLL_ATTEMPTS,
  DESKTOP_UA_CN,
  DESKTOP_VERSION_CN,
  EXPERT_ID_POOL,
  LIBRARY_DOC_URL,
  LIBRARY_ELEMENT_ID,
  LIBRARY_ELEMENT_NAME,
  NIGHT_TASK_CODES,
  PROGRESS_RISING_MS,
  REPORT_SETTLE_MS,
  SKILL_MARKET_URL,
  SKILL_SHARE_CHANNEL_URL,
  SKILL_SHARE_POLL_GAP_MS,
  SKILL_SHARE_POLL_TRIES,
  SKILL_SHARE_PREFERRED_ID,
  TASK_SPECS,
  TEAM_ID_POOL,
  TEMPLATE_FALLBACK_SCENES,
  TEMPLATE_POLL_GAP_MS,
  TEMPLATE_POLL_TRIES,
  TEMPLATE_SCENES_URL,
  WEB_UA,
  inNightWindow,
} from "./constants.mjs";
import { randomUUID } from "node:crypto";
import { deriveId, uuidHex } from "./fingerprint.mjs";
import { defaultNow } from "./identity.mjs";
import { MP_TASK_CODES, runMiniProgramTasks } from "./miniprogram.mjs"; // 小程序链式任务（CONTRACT §7）
import { resolveTaskKind } from "./taskkind.mjs"; // 任务 → kind 解析（CONTRACT §2/§7，唯一判断源）
import { runCatTravel } from "./travel.mjs"; // 循环引用（travel 需要 tasks 的流水线件）；ESM 函数声明提升下安全
import {
  billBase as _billBase,
  callJSON,
  ctxOf,
  growthBase as _growthBase,
  makeCtx,
  webBase as _webBase,
} from "./upstream.mjs";

// ---- 查询 --------------------------------------------------------------------

// fetchTasks(acct, opts) -> Task[]
// Task 是**规范形状**（camelCase，全引擎与 daemon 只认这一种拼写，CONTRACT §2）；
// 上游的 snake_case 字段（task_code/reward_credit/…、顶层 current/target/status/name）
// 在这里一次性归一。非枚举的 raw 字段保留上游原始对象，仅供调试。
export async function fetchTasks(acct, opts = {}) {
  if (acct?.enterpriseId) return []; // 企业版账号无成长体系
  const ctx = ctxOf(opts);
  await ctx.breathe(); // 防风控：任何两次上游调用之间 ≥ gap
  const res = await callJSON(acct, "chat", chatUrl(opts) + "/v2/activity/growth/tasks", { method: "GET" }, opts);
  if (!res.ok) {
    // 以前这里静默返回 []，夜猫子 01:00 失败时只剩「未获取到清单」一句，分不清
    // 是网络/信封失败还是列表里确实没有任务。记一行可读原因（不含 token）。
    ctx.log?.(
      `拉取任务清单失败：HTTP ${res.status ?? 0}` +
      `${res.msg ? ` ${String(res.msg).slice(0, 160)}` : ""}` +
      `${res.restricted ? " (restricted)" : ""}`,
    );
    return [];
  }
  const rawTasks = res.data?.tasks ?? [];
  const tasks = [];
  for (const t of rawTasks) {
    const code = t.task_code || "";
    // Object.hasOwn：上游若回 "constructor" 这类键名，不许吃到原型链上的东西
    const spec = code && Object.hasOwn(TASK_SPECS, code) ? TASK_SPECS[code] : {};
    const prog = t.progress ?? {};
    const task = {
      code,
      title: t.title || spec.name || code,
      description: t.description || t.task_desc || "",
      jumpUrl: t.jump_url || "",
      acceptStatus: t.accept_status || "not_accepted",
      // 次日锁（0.3.2/2026-11-11 实测）：web 清单也带上游锁字段（Sequential_
      // Tasks_7 实测 locked:true + unlock_at:"…+08:00"），与 fetchMPTasks 同口径
      // 归一 —— daemon.snapTask 以上游字段为锁的主依据，流水线用它整条跳过
      // 锁定任务（不接取/不上报/不领奖）
      locked: t.locked === true,
      unlockAt: String(t.unlock_at ?? ""),
      taskType: t.task_type || "",
      progress: {
        current: prog.current ?? 0,
        target: prog.target ?? spec.target ?? 1,
      },
      rewardCredit: t.reward_credit || spec.reward || 0,
      rewardEnergy: t.reward_energy ?? 0,
      unforgeable: false,
      reason: "",
    };
    // kind 解析（CONTRACT §2/§7）：TASK_SPECS 命中沿用 spec 语义；未收录但
    // jump_url 能解出 expertId=ex_… 的按 expert 类点亮；都否则 unforgeable+
    // 「未收录任务」—— needsAccept 据此把它们挡在接取批次之外。
    const rk = resolveTaskKind(task);
    task.unforgeable = rk.unforgeable;
    task.reason = rk.reason;
    // raw 挂成非枚举：不进 JSON.stringify / Object.keys，但调试时拿得到上游原文
    Object.defineProperty(task, "raw", { value: t, enumerable: false });
    tasks.push(task);
  }
  return tasks;
}

// fetchEnergy(acct, opts) -> number（GET /v2/activity/growth/energy）
export async function fetchEnergy(acct, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe();
  const res = await callJSON(acct, "chat", chatUrl(opts) + "/v2/activity/growth/energy", { method: "GET" }, opts);
  return res.ok ? res.data?.balance ?? 0 : 0;
}

// fetchGrowthSummary(acct, opts) -> 能量 / 连登 / 抽奖 / 旅行一次性快照
//（wb_tasks.fetch_growth_summary 的移植；任何一段失败都不拖死其余）。
export async function fetchGrowthSummary(acct, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe();
  const out = { energy: 0, streakDays: 0, makeupCards: 0, tiers: [], tierStatuses: {}, lotteryChances: 0, travel: { state: "unknown" } };
  const log = (msg) => ctx.log?.(msg);
  const get = async (path) =>
    callJSON(acct, "chat", chatUrl(opts) + path, { method: "GET" }, opts);

  let res = await get("/v2/activity/growth/energy");
  if (res.ok) out.energy = res.data?.balance ?? 0;
  else log(`growth/energy query failed: ${res.msg}`);
  await ctx.breathe();

  res = await get("/activity/growth/streak");
  if (res.ok) {
    const data = res.data ?? {};
    out.streakDays = data.streak?.days ?? 0;
    out.makeupCards = data.makeup_cards?.balance ?? 0;
    const redemp = data.redemption_status ?? {};
    out.tiers = redemp.tiers ?? [];
    out.tierStatuses = {
      "7d": redemp.tier_7d_status ?? "locked",
      "14d": redemp.tier_14d_status ?? "locked",
      "28d": redemp.tier_28d_status ?? "locked",
    };
  } else log(`growth/streak query failed: ${res.msg}`);
  await ctx.breathe();

  res = await get("/activity/growth/lottery/summary");
  if (res.ok) out.lotteryChances = res.data?.chances ?? 0;
  else log(`growth/lottery query failed: ${res.msg}`);
  await ctx.breathe();

  res = await get("/activity/growth/buddy/travel/status");
  if (res.ok) out.travel = res.data ?? {};
  else log(`buddy/travel/status query failed: ${res.msg}`);
  return out;
}

// ---- 接取 --------------------------------------------------------------------

// acceptTasks(acct, codes, opts) -> {ok, accepted[], already[], failed[], msg, reasons[], restricted?}
// 20 个一批（ACCEPT_CHUNK）；批内已接/新接分账，整批被拒时把整批记 failed。
export async function acceptTasks(acct, codes, opts = {}) {
  const ctx = ctxOf(opts);
  const out = { ok: true, accepted: [], already: [], failed: [], msg: "", reasons: [] };
  if (!codes || codes.length === 0) return out;
  const url = chatUrl(opts) + "/v2/activity/growth/tasks/accept";
  const chunk = Math.max(1, Number(opts.chunk ?? ACCEPT_CHUNK));
  for (let i = 0; i < codes.length; i += chunk) {
    await ctx.breathe(); // 批与批之间也 ≥ gap（hub 这里漏了，铁律 4 补上）
    const part = codes.slice(i, i + chunk);
    const res = await callJSON(
      acct, "chat", url,
      { method: "POST", body: JSON.stringify({ task_codes: part }) },
      opts,
    );
    if (res.restricted) {
      out.ok = false;
      out.restricted = true;
      out.msg = res.msg || "restricted";
      out.failed.push(...part);
      out.reasons.push(`restricted: ${out.msg}`);
      break;
    }
    if (!res.ok) {
      out.ok = false;
      out.msg = res.msg || `code=${res.code}`;
      out.failed.push(...part);
      out.reasons.push(out.msg);
      ctx.log?.(`accept batch failed: ${out.msg}`);
      continue;
    }
    const results = res.data?.results ?? [];
    const seen = new Set();
    for (const item of results) {
      const code = item.task_code;
      const st = String(item.status ?? "");
      seen.add(code);
      if (st === "accepted") out.accepted.push(code);
      else if (st === "already_accepted") out.already.push(code);
      else {
        out.failed.push(code);
        out.reasons.push(`${code}: ${item.message || st}`);
        ctx.log?.(`task ${code} accept status=${st}`);
      }
    }
    for (const code of part) if (!seen.has(code)) out.failed.push(code);
  }
  return out;
}

// ---- 上报 --------------------------------------------------------------------

// reportEvents(acct, events, opts) -> boolean
// body 是事件数组（CONTRACT §7）；事件缺 userId 服务端 200 但静默丢弃。
export async function reportEvents(acct, events, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe(); // 防风控：与上一次上游调用之间 ≥ gap
  const base = opts.reportBase || chatUrl(opts);
  const kind = base === billUrl() ? "billing" : "chat";
  const res = await callJSON(
    acct, kind, base + "/v2/report",
    { method: "POST", body: JSON.stringify(events) },
    opts,
  );
  return !!res.ok;
}

// reportLibraryEvent(acct, opts) -> boolean
// 「浏览资料库」（Library_read）的点亮事件（wb_tasks.report_web_library 同源）：
// 上游不认 chat 域的伪造事件，只认 web 端在资料库介绍文档页的一次元素点击
//（web_element_click，CONTRACT §7）。事件走 **web 域** /v2/report，头族用
// webHeaders 并覆盖三处：Referer=文档 URL、User-Agent=WEB_UA（与事件里的
// userAgent 同值，冒充同一次浏览器会话）、X-User-Id=空串（web 端点击事件的
// 真实形态 —— 身分靠 Authorization 与事件体内的 userId/machineId 携带）。
export async function reportLibraryEvent(acct, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe(); // 防风控：与上一次上游调用之间 ≥ gap
  const uid = String(acct?.uid ?? "");
  const now = Math.floor(ctx.now());
  const event = {
    eventCode: "web_element_click",
    timestamp: now,
    reportDelay: 0,
    pageURL: LIBRARY_DOC_URL,
    elementId: LIBRARY_ELEMENT_ID,
    elementName: LIBRARY_ELEMENT_NAME,
    os: "Win32",
    arch: "",
    osVersion: "10.0",
    userAgent: WEB_UA,
    machineId: deriveId(uid, "webmachine"), // wb_fingerprint：salt:uid 的 md5 派生
    userId: uid,
    userNickname: String(acct?.nickname ?? ""),
  };
  const res = await callJSON(
    acct, "web", `${webUrl_()}/v2/report`,
    {
      method: "POST",
      body: JSON.stringify([event]),
      headers: {
        Referer: LIBRARY_DOC_URL,
        "User-Agent": WEB_UA,
        "X-User-Id": "",
      },
    },
    opts,
  );
  return !!res.ok;
}

// reportBuddy5Events(acct, events, opts) -> boolean
// Buddy 5 连的专用上报：桌面 UA/头族（connoryang 的 desktopHeaders 口径）。
// 2026-11-06 实测：这 5 条事件 + 桌面指纹一次上报 → code 0、进度 0→1、可领奖。
export async function reportBuddy5Events(acct, events, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe();
  const uid = String(acct?.uid ?? "");
  const base = chatUrl(opts);
  const list = Array.isArray(events) ? events : [events];
  const res = await callJSON(
    acct, "chat", base + "/v2/report",
    {
      method: "POST",
      body: JSON.stringify(list),
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "User-Agent": "WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1",
        "X-Domain": base,
        "X-Product": "SaaS",
        "X-Request-ID": deriveId(uid, "req") + String(Math.floor(ctx.now()) % 1000000),
        "X-User-Id": uid,
      },
    },
    opts,
  );
  return !!res.ok;
}

// ---- 桌面域上报 + skill_share / template_5 流程（CONTRACT §11.2/§11.3，hub 8eede085）----

// desktopFingerprint(uid, nick, nowMs)：桌面端事件上报的公共指纹包络（hub
// `_report_desktop_events` 的 `wb_fingerprint.get_desktop_fingerprint(...)` 对应物）。
// 字段形状与 buildEvent("buddy5") 的实测桌面指纹同源（2026-11-06 真机抓包），但
// ideVersion/extVersion 按 hub 的上报时覆写取 DESKTOP_VERSION_CN（5.8.3）。
function desktopFingerprint(uid, nick, nowMs) {
  const now = Math.floor(nowMs);
  return {
    timezone: "Asia/Shanghai", reportDelay: 2000, userId: uid,
    username: nick, userNickname: nick, product: "SaaS",
    releaseDate: 1789036585355, commit: "5f9692923c93033111c51ad7b003eb80204a9b75",
    ideName: "WorkBuddy", ideType: "WorkBuddy",
    ideVersion: DESKTOP_VERSION_CN, machineId: deriveId(uid, "machine"),
    sessionId: deriveId(uid, "session"),
    extName: "workbuddy-desktop", extVersion: DESKTOP_VERSION_CN,
    os: "win32", arch: "x64", osVersion: "10.0.26220", cpuCores: 20, memorySize: 24,
    timestamp: now, presentAt: now,
  };
}

// reportDesktopEvents(acct, events, opts) -> boolean
// 桌面域事件上报（hub `_report_desktop_events` 的移植）：事件合并桌面指纹包络，
// 打 **chat 域** /v2/report（桌面事件与 chat 同一上游契约，不是 web 域），头在
// chat 头族上覆盖桌面 UA / X-Domain: copilot.tencent.com / X-Product: SaaS /
// X-Request-ID / X-User-Id。hub 口径：desktop 端点常回**空 body** —— 2xx 就是
// 传输层成功；callJSON 对非 JSON 主体按失败结算（code -1），这里按 2xx 翻正，
// 免得把一次成功上报误判成失败而不敢领奖。
export async function reportDesktopEvents(acct, events, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe();
  const uid = String(acct?.uid ?? "");
  const nick = String(acct?.nickname ?? "");
  const envelope = desktopFingerprint(uid, nick, ctx.now());
  const list = (Array.isArray(events) ? events : [events]).map((e) => ({ ...envelope, ...e }));
  const res = await callJSON(
    acct, "chat", chatUrl(opts) + "/v2/report",
    {
      method: "POST",
      body: JSON.stringify(list),
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        "Accept": "application/json, text/plain, */*",
        "User-Agent": DESKTOP_UA_CN,
        "X-Domain": "copilot.tencent.com",
        "X-Product": "SaaS",
        "X-Request-ID": deriveId(uid, "req") + String(Math.floor(ctx.now()) % 1000000),
        "X-User-Id": uid,
      },
    },
    opts,
  );
  if (res.restricted) return false;
  if (res.ok) return true;
  return res.status >= 200 && res.status < 300; // 2xx + 非 JSON body（含空 body）= 成功
}

// newGrowthMessageId(nowMs)：hub `_new_message_id` 的移植
//（"%012x%s" % (int(time.time()*1000), uuid4().hex[:20])）。template_5 的事件
// requestId 用它。
export function newGrowthMessageId(nowMs) {
  const ms = Math.floor(nowMs ?? Date.now());
  return `${ms.toString(16).padStart(12, "0")}${uuidHex().slice(0, 20)}`;
}

// templateEvents(sceneId, sceneName, nowMs) -> 四事件组（hub `_template_events`
// 逐字移植，CONTRACT §11.3）：一组真实模板创建动作把 template_5 推进 1。
// 顺序钉死：agent_task_created → agent_task_created_with_template → template_used
// → playbook_prompt_send；同一组共享 requestId/conversationId。
// 注意事件体本身不带 userId —— 它们只经 reportDesktopEvents 上报，userId 由桌面
// 指纹包络携带（hub 同款）。
export function templateEvents(sceneId, sceneName, nowMs) {
  const requestId = newGrowthMessageId(nowMs);
  const conversationId = randomUUID();
  return [
    { eventCode: "agent_task_created", source: "CLOUD", name: "",
      mode: "craft", requestModelId: "default", action: sceneId,
      has_template: true, template_id: sceneId,
      template_name: sceneName, requestId, conversationId },
    { eventCode: "agent_task_created_with_template",
      templateId: sceneId, templateName: sceneName,
      template_id: sceneId, mode: "working", isCustomModel: true,
      id: sceneId, name: sceneName, requestId, conversationId },
    { eventCode: "template_used", template_id: sceneId,
      templateId: sceneId, templateName: sceneName,
      task_mode: "working", id: sceneId, name: sceneName,
      source: "growth-center", conversationId },
    { eventCode: "playbook_prompt_send", ext1: randomUUID(),
      requestId, id: sceneId, name: sceneName,
      type: "other", promptLength: 30, isOfficial: 1,
      source: "growth-center", conversationId },
  ];
}

// fetchTemplateScenes(acct, opts) -> {ok:true, scenes:[[id,name],...], fallback?}
// 真实场景表（hub `_fetch_template_scenes` 移植）：GET TEMPLATE_SCENES_URL，
// 只看 HTTP 2xx 与 data.scenes（hub 不看信封 code）；请求失败/为空才回落内置表
//（fallback:true 标记回落，测试与调用方据此区分「真场景」与「兜底表」）。
// restricted 透传（绝不吞掉 403/11140）。
export async function fetchTemplateScenes(acct, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe();
  const res = await callJSON(acct, "chat", TEMPLATE_SCENES_URL, { method: "GET" }, opts);
  if (res.restricted) {
    return { ok: false, restricted: true, scenes: [], reason: res.msg || "restricted" };
  }
  if (res.status >= 200 && res.status < 300) {
    const rows = res.data?.scenes ?? [];
    const scenes = [];
    for (const row of rows) {
      if (!row || typeof row !== "object" || row.id === undefined || row.id === null) continue;
      scenes.push([String(row.id), String(row.name ?? "")]);
    }
    if (scenes.length) return { ok: true, scenes };
  }
  return {
    ok: true,
    fallback: true,
    scenes: TEMPLATE_FALLBACK_SCENES.map(([id, nm]) => [String(id), String(nm)]),
    reason: res.ok ? "场景表为空" : `HTTP ${res.status ?? 0} ${res.msg || ""}`.trim(),
  };
}

// skillShareChannelEvents(skillId, skillName, shareCode, nowMs) -> 两条事件
//（hub `_skill_share_channel_events` 逐字移植）：click → success，共享同一
// actionAt 时间戳与 share_code id。只经 reportDesktopEvents 上报（userId 由
// 桌面指纹包络携带）。
export function skillShareChannelEvents(skillId, skillName, shareCode, nowMs) {
  const common = { skillId, skillName, skillType: "market" };
  const now = Math.floor(nowMs);
  return [
    { ...common, eventCode: "skill_share_channel_action",
      action: "link", panelAction: "click", panelType: "clipboard",
      isSuccessful: true, cost: 0, id: shareCode, actionAt: now },
    { ...common, eventCode: "skill_share_channel_action",
      action: "link", panelAction: "success", panelType: "clipboard",
      isSuccessful: true, cost: 0, id: shareCode, actionAt: now },
  ];
}

// skillShareMarketSkill(acct, opts) -> {ok:true, skill:{id,name,description}}
//                                        | {ok:false, reason, restricted?}
// 市场技能目录（hub `_skill_share_market_skill` 移植）：POST SKILL_MARKET_URL
// body {"page":1,"page_size":20}（chat 头）。hub 接受信封 code in (0,200,"0","200")
// —— callJSON 只认 code 0，这里按 hub 口径把 code 200 也翻正。选技能：偏好
// SKILL_SHARE_PREFERRED_ID，否则第一个可用；行内字段容错与 hub 一致
//（skill_id|id、display_name_zh|name|display_name_en、description_zh|description|
// description_en 截 60）。
export async function skillShareMarketSkill(acct, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe();
  const res = await callJSON(
    acct, "chat", SKILL_MARKET_URL,
    { method: "POST", body: JSON.stringify({ page: 1, page_size: 20 }) },
    opts,
  );
  if (res.restricted) {
    return { ok: false, reason: res.msg || "restricted", restricted: true };
  }
  // hub 接受 code in (0, 200, "0", "200")：callJSON 把 "200" 解析成数字 200
  const ok = res.ok || res.code === 200;
  if (!ok) {
    return { ok: false, reason: `市场技能列表被拒: HTTP ${res.status ?? 0} ${String(res.msg || res.raw || "").slice(0, 120)}`.trim() };
  }
  const skills = res.data?.skills ?? [];
  const candidates = [];
  for (const row of skills) {
    if (!row || typeof row !== "object") continue;
    const id = String(row.skill_id ?? row.id ?? "").trim();
    if (!id) continue;
    const nm = String(row.display_name_zh ?? row.name ?? row.display_name_en ?? "").trim();
    if (!nm) continue;
    candidates.push({
      id,
      name: nm,
      description: String(row.description_zh ?? row.description ?? row.description_en ?? "").trim().slice(0, 60),
    });
  }
  if (!candidates.length) return { ok: false, reason: "市场技能目录为空" };
  const skill = candidates.find((r) => r.id === SKILL_SHARE_PREFERRED_ID) ?? candidates[0];
  return { ok: true, skill };
}

// createSkillShareChannel(acct, skill, opts)
//   -> {ok:true, shareCode, channelId} | {ok:false, reason, restricted?, status?}
// **真实上游动作**（hub `_create_skill_share_channel` 逐字移植，CONTRACT §11.2）：
// 在 Open Platform 创建一条 c2c 资产分享渠道 —— 上游会真实生成分享链接，这不是
// 伪造事件，是真实分享动作的自动化。body/头逐字照 hub（asset_ref 是紧凑 JSON
// 字符串；头在 chat 头族上覆盖 Content-Type/Accept/桌面 UA/X-User-Id/X-Domain）。
// 必须同时拿到 share_code 与 ways[share_way=="link"].resource_ref 才算成功
//（缺一 → 上游没给出可用的分享形态，如实失败）。
export async function createSkillShareChannel(acct, skill, opts = {}) {
  const ctx = ctxOf(opts);
  const skillId = String(skill?.id ?? "").trim();
  if (!skillId) return { ok: false, reason: "市场技能 ID 为空" };
  await ctx.breathe();
  const body = {
    asset_kind: "skill",
    asset_source: "market",
    asset_ref: JSON.stringify({ asset_id: skillId }),
    ways: ["link", "wxacode", "wxapath"],
    extra: {
      name: skill.name || "技能",
      description: skill.description || "",
      shareKey: skillId,
      marketplaceSource: "builtin-market",
    },
  };
  const res = await callJSON(
    acct, "chat", SKILL_SHARE_CHANNEL_URL,
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/plain, */*",
        "User-Agent": DESKTOP_UA_CN,
        "X-User-Id": String(acct?.uid ?? ""),
        "X-Domain": "copilot.tencent.com",
      },
    },
    opts,
  );
  if (res.restricted) {
    return { ok: false, reason: res.msg || "restricted", restricted: true, status: res.status };
  }
  const ok = res.ok || res.code === 200; // 与市场列表同款：hub 接受 code 200
  if (!ok) {
    return {
      ok: false,
      reason: String(res.msg || "创建分享渠道失败").slice(0, 160),
      status: res.status,
    };
  }
  const data = res.data ?? {};
  const shareCode = String(data.share_code ?? "").trim();
  let link = "";
  for (const way of data.ways ?? []) {
    if (way && typeof way === "object" && way.share_way === "link") {
      link = String(way.resource_ref ?? "").trim();
      break;
    }
  }
  if (!shareCode || !link) {
    return { ok: false, reason: "分享接口缺少 share_code 或 link", status: res.status };
  }
  return { ok: true, shareCode, link, channelId: String(data.channel_id ?? "") };
}

// waitGrowthProgress(acct, code, target, tries, gapMs, opts) -> Task | null
//（hub `_wait_for_growth_task` 移植）：轮询成长清单直到服务端确认达标或等待
// 预算耗尽。每次轮询之间 breathe(gapMs)（≥1s 铁律由 ctx/spacer 保证）。
export async function waitGrowthProgress(acct, code, target, tries, gapMs, opts = {}) {
  const ctx = ctxOf(opts);
  let fresh = null;
  for (let i = 0; i < Math.max(1, tries); i++) {
    if (i) await ctx.breathe(gapMs);
    fresh = (await fetchTasks(acct, opts)).find((x) => x.code === code) ?? null;
    if (!fresh) continue;
    if (
      fresh.acceptStatus === "completed" ||
      fresh.acceptStatus === "claimed" ||
      (fresh.progress?.current ?? 0) >= target
    ) {
      return fresh;
    }
  }
  return fresh;
}

// finishSpecialTask(acct, t, fresh, logs, opts, lit) -> {credit, energy, lit, claimed, restricted?}
//（hub `_finish_special_task` 移植）：只在**服务端确认完成之后**才领奖 —— 进度
// 未确认就领奖必报 task not completed，所以没确认就顺延下一轮；claim=false 时
// 只记「等待手动领取」。
async function finishSpecialTask(acct, t, fresh, logs, opts, lit = 0) {
  const ctx = ctxOf(opts);
  const claim = opts.claim !== false;
  const name = t.title || t.code;
  const target = t.progress?.target ?? 1;
  const current = fresh?.progress?.current ?? t.progress?.current ?? 0;
  const confirmed =
    !!fresh &&
    (fresh.acceptStatus === "completed" ||
      fresh.acceptStatus === "claimed" ||
      current >= target);
  if (!confirmed) {
    logs.push(`? 任务 [${name}] 进度 ${current}/${target} 未确认，领奖顺延到下次运行`);
    return { credit: 0, energy: 0, lit, claimed: 0 };
  }
  if (fresh.acceptStatus === "claimed") {
    logs.push(`✓ 任务 [${name}] 已领奖`);
    return { credit: 0, energy: 0, lit, claimed: 0 };
  }
  if (!claim) {
    logs.push(`⏸ 任务 [${name}] 已达成，等待手动领取`);
    return { credit: 0, energy: 0, lit, claimed: 0 };
  }
  const res = await claimTask(acct, t.code, opts);
  if (res.ok) {
    logs.push(`✓ 任务 [${name}] 领奖成功: +${res.credit ?? 0} 积分`);
    await ctx.breathe();
    return { credit: res.credit ?? 0, energy: res.energy ?? 0, lit, claimed: 1 };
  }
  logs.push(`! 任务 [${name}] 进度已达成但领奖失败: ${res.reason || "未知原因"}`);
  await ctx.breathe();
  return { credit: 0, energy: 0, lit, claimed: 0, ...(res.restricted ? { restricted: true } : {}) };
}

// runSkillShareTask(acct, t, logs, opts) -> {credit, energy, lit, claimed, restricted?}
// skill_share 完整流程（CONTRACT §11.2，hub `_run_skill_share_task` 移植）：
// 市场技能 → 创建真实分享渠道 → 两条渠道事件 → 轮询进度 → 领奖。
// **创建渠道是真实上游动作（上游会真实生成分享链接），不是伪造事件**；市场/
// 渠道/事件任一步失败都如实跳过、不领奖、不伪造；restricted 透传（冻结）。
export async function runSkillShareTask(acct, t, logs, opts = {}) {
  const name = t.title || t.code;
  const zero = () => ({ credit: 0, energy: 0, lit: 0, claimed: 0 });

  // 1) 市场技能目录
  const market = await skillShareMarketSkill(acct, opts);
  if (market.restricted) return { ...zero(), restricted: true };
  if (!market.ok) {
    logs.push(`⏭ 任务 [${name}] 市场未返回可分享技能，不伪造分享（${market.reason}）`);
    return zero();
  }
  const skill = market.skill;

  // 2) 创建分享渠道（真实动作）
  const channel = await createSkillShareChannel(acct, skill, opts);
  if (channel.restricted) return { ...zero(), restricted: true };
  if (!channel.ok) {
    logs.push(`! 任务 [${name}] 创建分享渠道失败: ${channel.reason}`);
    return zero();
  }

  // 3) 两条 skill_share_channel_action（click → success，桌面头上报）
  const events = skillShareChannelEvents(skill.id, skill.name, channel.shareCode, ctxOf(opts).now());
  if (!(await reportDesktopEvents(acct, events, opts))) {
    logs.push(`! 任务 [${name}] 渠道已创建但事件上报失败，不领奖`);
    return zero();
  }

  // 4) 轮询服务端进度（4 × 3s），确认后才领奖
  logs.push(`正在等待任务 [${name}] 服务端进度落账...`);
  const target = t.progress?.target ?? 1;
  const fresh = await waitGrowthProgress(acct, t.code, target, SKILL_SHARE_POLL_TRIES, SKILL_SHARE_POLL_GAP_MS, opts);
  return finishSpecialTask(acct, t, fresh, logs, opts, 1);
}

// runTemplateTask(acct, t, logs, opts) -> {credit, energy, lit, claimed, restricted?}
// template_5 完整流程（CONTRACT §11.3，hub `_run_template_task` 移植）：按缺口
// 逐组上报四事件（templateEvents），**一组上报必须推进服务端计数才发下一组**
//（计数不动就停手，绝不喷重复事件）；进度未确认不提前领奖。
export async function runTemplateTask(acct, t, logs, opts = {}) {
  const name = t.title || t.code;
  const target = Math.max(1, Number(t.progress?.target ?? 5) || 5);
  let current = Number(t.progress?.current ?? 0) || 0;
  const zero = () => ({ credit: 0, energy: 0, lit: 0, claimed: 0 });

  const scenes = await fetchTemplateScenes(acct, opts);
  if (scenes.restricted) return { ...zero(), restricted: true };
  if (!scenes.scenes.length) {
    logs.push(`⏭ 任务 [${name}] 取不到模板场景，跳过`);
    return zero();
  }

  let fresh = null;
  while (current < target) {
    const [sceneId, sceneName] = scenes.scenes[current % scenes.scenes.length];
    const before = current;
    if (!(await reportDesktopEvents(acct, templateEvents(sceneId, sceneName, ctxOf(opts).now()), opts))) {
      logs.push(`! 任务 [${name}] 场景 ${sceneName || sceneId} 事件上报失败`);
      return zero();
    }
    fresh = await waitGrowthProgress(acct, t.code, target, TEMPLATE_POLL_TRIES, TEMPLATE_POLL_GAP_MS, opts);
    if (!fresh) break;
    const nextCurrent = Number(fresh.progress?.current ?? 0) || 0;
    if (
      fresh.acceptStatus === "completed" ||
      fresh.acceptStatus === "claimed" ||
      nextCurrent >= target
    ) {
      current = Math.max(current, nextCurrent);
      break;
    }
    // 一组四事件必须推进服务端计数才继续下一组；计数不动说明事件没有落账，
    // 留到下次运行，绝不原地补喷重复事件（hub 口径）。
    if (nextCurrent <= before) {
      logs.push(`任务 [${name}] 服务端进度未增长，停止本轮补发`);
      break;
    }
    current = nextCurrent;
  }
  logs.push(`任务 [${name}] 当前服务端进度 ${current}/${target}`);
  return finishSpecialTask(acct, t, fresh, logs, opts, 1);
}

// ---- 领奖 --------------------------------------------------------------------

// claimTask(acct, code, opts) -> {ok, credit, energy, via, reason, restricted?}
// HTTP 400（或信封 code 400）「task not completed」→ 试一次 web 域回退
//（www.workbuddy.cn + webHeaders），且只试一次。
export async function claimTask(acct, code, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe(); // 领奖前也 ≥ gap（hub 在轮询结束后直接领，这里补上）
  const url = `${chatUrl(opts)}/activity/growth/tasks/${encodeURIComponent(code)}/claim`;
  const res = await callJSON(acct, "chat", url, { method: "POST", body: "{}" }, opts);
  if (res.ok) {
    return { ok: true, credit: res.data?.credit ?? 0, energy: res.data?.energy ?? 0, via: "chat", reason: "" };
  }
  if (res.restricted) {
    return { ok: false, credit: 0, energy: 0, via: "chat", reason: res.msg || "restricted", restricted: true };
  }
  const chatReason = res.msg || `code=${res.code}` || `HTTP ${res.status}`;
  if (res.status === 400 || res.code === 400) {
    // 降级到 web 域领奖
    await ctx.breathe();
    const webUrl = `${webUrl_()}/activity/growth/tasks/${encodeURIComponent(code)}/claim`;
    const res2 = await callJSON(acct, "web", webUrl, { method: "POST", body: "{}" }, opts);
    if (res2.ok) {
      return { ok: true, credit: res2.data?.credit ?? 0, energy: res2.data?.energy ?? 0, via: "web", reason: "" };
    }
    ctx.log?.(`task ${code} web claim rejected: code=${res2.code} msg=${res2.msg}`);
    return {
      ok: false, credit: 0, energy: 0, via: "web",
      reason: res2.msg || chatReason,
      ...(res2.restricted ? { restricted: true } : {}),
    };
  }
  ctx.log?.(`task ${code} claim failed: ${chatReason}`);
  return { ok: false, credit: 0, energy: 0, via: "chat", reason: chatReason };
}

// ---- 事件构造（wb_tasks.build_event 逐字拷贝，字段名一个不改）-----------------
//
// expert: [expert_id, expert_name] —— 专家/团队类事件必须每次使用不同的 id，
// 上游按 (eventCode, id) 去重，重复 id 不会推进任务进度。
// 多数 kind 返回单个事件对象；playbook 返回**双事件数组**（cta_click + prompt_send），
// progressTask 对数组与单事件都能处理（见下）。
export function buildEvent(acct, kind, idx = 0, expert = null, opts = {}) {
  const now = Math.floor(opts.now ? opts.now() : defaultNow());
  const cid = `wb-task-${now}-${idx}`;
  const rid = `${cid}-req`;
  const uid = acct.uid;

  if (kind === "canvas") {
    return { eventCode: "wbx_design_canvas_task_create", timestamp: now,
      reportDelay: 0, conversationId: cid, requestId: rid,
      source: "summon_keyword", isCustomModel: false, name: "",
      inputLength: 12, id: `wbx-canvas-${now}`, cost: 0,
      isSuccessful: true, userId: uid };
  }
  // kind:"template"（template_5）不再有单事件构造：旧实现是单条
  // agent_task_created_with_template + 硬编码「幻灯片」，已被 CONTRACT §11.3 的
  // 四事件组（agent_task_created → agent_task_created_with_template →
  // template_used → playbook_prompt_send）+ 服务端真实场景表替换 —— 见本文件
  // runTemplateTask / templateEvents（progressTask 对 kind:"template" 直接分流，
  // 绝不走 buildEvent）。这里不再保留 template 分支：误用会落 heartbeat，
  // 比静默发旧事件更诚实。
  if (kind === "expert" || kind === "team" || kind === "lighthouse") {
    const etype = kind === "team" ? "team" : "agent";
    let exId, name;
    if (expert) [exId, name] = expert;
    else if (kind === "lighthouse") [exId, name] = ["ex_2cvvUZQhDyeJ", "腾讯轻量云专家"];
    else if (kind === "team") [exId, name] = ["CloudOpsTeam", "运维专家团队"];
    else [exId, name] = ["ContentCreator", "内容创作专家"];
    return { eventCode: "expert_actual_use", timestamp: now, reportDelay: 0,
      mode: "CLOUD", id: exId, name, expertTitle: name,
      type: "02-Engineering", expertType: etype, source: "builtin",
      version: "1.0.2", cost: 0, characterCount: 12, conversationId: cid,
      requestId: rid, messageId: rid, requestModelId: "deepseek-v4-flash",
      requestModelName: "DeepSeek V4 Flash", userId: uid };
  }
  if (kind === "skill") {
    return { eventCode: "skill_info", timestamp: now, reportDelay: 0,
      skillId: "skill_2096525080079265792", name: "pptx", userId: uid };
  }
  if (kind === "automation") {
    return { eventCode: "automated_task_create_suc", timestamp: now, reportDelay: 0,
      name: "每周工作整理", type: "cron", source: "manually",
      modelId: "deepseek-v4-flash", modelIsThinking: false,
      conversationId: cid, requestId: rid,
      schedule: { type: "recurring", rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0" },
      prompt: "每周五自动整理本周工作", userId: uid };
  }
  // Buddy 应用（Buddy_App / Buddy_App_QQ）：5 条桌面埋点链（connoryang
  // magpie-workbuddy-growth 的 desktopBuddy5Sequence，2026-11-06 本机实测
  // code 0、进度 0→1、领奖 +100）。事件体必须带桌面指纹（machineId/sessionId/
  // ideVersion 等），并配合 reportBuddy5Events 的桌面头上报。
  if (kind === "buddy5") {
    const nick = acct.nickname || "";
    const buddyId = "cb_y5Dy46tPQGGWtueMxXbe";
    const buddyName = "企鹅教师助手";
    const fp = {
      timezone: "Asia/Shanghai", reportDelay: 2000, userId: uid,
      username: nick, userNickname: nick, product: "SaaS",
      releaseDate: 1789036585355, commit: "5f9692923c93033111c51ad7b003eb80204a9b75",
      ideName: "WorkBuddy", ideType: "WorkBuddy", ideVersion: "5.5.6",
      machineId: deriveId(uid, "machine"), sessionId: deriveId(uid, "session"),
      extName: "workbuddy-desktop", extVersion: "5.5.6",
      os: "win32", arch: "x64", osVersion: "10.0.26220", cpuCores: 20, memorySize: 24,
      timestamp: now, presentAt: now,
    };
    return [
      { ...fp, eventCode: "buddyapp_discover_click", mode: "LOCAL", buddyId, buddyName },
      { ...fp, eventCode: "buddyapp_show", elementId: "growth_buddy", elementName: buddyName, position: 2 },
      { ...fp, eventCode: "buddyapp_enter_click", elementId: "growth_buddy", elementName: buddyName, position: 2, isFirstPage: "1" },
      { ...fp, eventCode: "buddyapp_auth_confirm_click", mode: "LOCAL", buddyId, buddyName },
      { ...fp, eventCode: "buddyapp_bindaccount_skip_click", mode: "LOCAL", buddyId, buddyName },
    ];
  }
  // RichMeow（RichMeow_Chat，桌面端发起 1 次对话）：hub 937c179 的 6 条
  // 桌面会话事件链，必须一次性上报整条链才会推进；字段逐字对齐 hub 的
  // build_desktop_chat_events（timestamp 依次 +20/+40/+60/+80/+100）。
  if (kind === "richmeow") {
    const nick = acct.nickname || "";
    const mid = `msg-${now}-${idx}`;
    const base = { userId: uid, userNickname: nick };
    return [
      { ...base, eventCode: "agent_task_created", timestamp: now,
        source: "LOCAL", name: "working", task_target: "local", mode: "craft",
        requestModelId: "fast-model", requestModelName: "fast-model",
        has_repo: false, repo_type: "none", workspace_type: "empty",
        has_connector: false, connector_types: [], has_mention: false, mention_types: [],
        has_template: false, action: "", template_name: "", has_expert: false,
        expert_id: "", expert_name: "", expert_industry_id: "", has_skill: false,
        skill_names: [], conversationId: cid, messageId: mid, buddyId: "", buddyName: "" },
      { ...base, eventCode: "chat_message_send", timestamp: now + 20,
        messageId: mid + "-ast", historyCount: 0, isContextTruncated: false,
        currentStepCount: 1, traceId: rid, rootRequestId: rid, parentConversationId: cid,
        agentName: "cli", agentType: "main" },
      { ...base, eventCode: "chat_request_send", timestamp: now + 40,
        inputLength: 24, isPlan: false, isAutoExecuteTerminal: false, isAutoModify: false,
        codebaseEnable: false, maxToken: 0, maxSteps: 500, temperature: 0, maxRetries: 0,
        mentionContexts: [], knowledgeId: [], knowledgeName: [], codebaseId: "",
        mentionContextCount: 0, command: "", recommendId: "", skillId: "", skillCount: 0,
        totalCount: 0, traceId: rid, rootRequestId: rid, parentConversationId: cid,
        conversationId: cid, messageId: mid, agentName: "cli", agentType: "main" },
      { ...base, eventCode: "chat_message_response", timestamp: now + 60,
        messageId: mid + "-resp", conversationId: cid, requestId: rid, agentName: "cli" },
      { ...base, eventCode: "chat_request_response", timestamp: now + 80,
        conversationId: cid, requestId: rid, requestModelId: "fast-model",
        requestModelName: "fast-model", toolCallCount: 0, inputToken: 6, outputToken: 12,
        duration: 50, agentName: "cli" },
      { ...base, eventCode: "agent_task_completed", timestamp: now + 100,
        conversationId: cid, messageId: mid, status: "success" },
    ];
  }
  // playbook（灵感案例）是**双事件链**（hub 937c179，2026-11 实测口径）：先
  // cta_click（点开「打工人小账本」文档卡片）再 prompt_send（发送提示词），两个
  // 事件一起上报才推进进度。返回数组，progressTask 会展开成一次 report 发两条。
  if (kind === "playbook") {
    return [
      { eventCode: "playbook_cta_click", timestamp: now, reportDelay: 0,
        id: "worker-ledger-freedom-dashboard", name: "打工人小账本",
        type: "document", categoryId: "", categoryName: "",
        source: "discover", position: 0, conversationId: cid,
        requestId: rid, messageId: rid, userId: uid },
      { eventCode: "playbook_prompt_send", timestamp: now + 50, reportDelay: 0,
        id: "worker-ledger-freedom-dashboard", name: "打工人小账本",
        type: "document", categoryId: "", categoryName: "",
        promptLength: 30, isOfficial: 1, source: "discover",
        conversationId: cid, requestId: rid, messageId: rid,
        skills: "", skillNames: "", userId: uid },
    ];
  }
  if (kind === "skin") {
    return { eventCode: "appearance_skin_apply", timestamp: now, reportDelay: 0,
      action: "apply", source: "settings_close", id: "theme-tkmw7j",
      vipLevel: "free", series: "craft", type: "unknown",
      name: "和平精英激战金秋", userId: uid };
  }
  if (kind === "chat" || kind === "glmchat" || kind === "cat") {
    const mId = kind === "glmchat" || kind === "cat" ? "glm-5.2" : "deepseek-v4-flash";
    const mNm = kind === "glmchat" || kind === "cat" ? "GLM-5.2" : "DeepSeek V4 Flash";
    const mode = kind === "cat" ? "night" : "craft";
    return { eventCode: "chat_request_send", timestamp: now, reportDelay: 0,
      mode, conversationId: cid, requestId: rid,
      inputLength: 12, requestModelId: mId, requestModelName: mNm,
      isPlan: false, agentName: "default", agentType: "conversation",
      userId: uid };
  }
  return { eventCode: "heartbeat", timestamp: now, userId: uid };
}

// ---- 单任务推进（wb_tasks._progress_one 的移植）------------------------------

// progressTask(acct, t, logs, opts) -> {credit, energy, lit, claimed, restricted?}
export async function progressTask(acct, t, logs, opts = {}) {
  const ctx = ctxOf(opts);
  const claim = opts.claim !== false;
  const code = t.code;
  const rk = resolveTaskKind(t);
  const spec = rk.spec;
  const name = spec?.name || t.title || code;

  // 小程序链式任务（0.3.0 起会经快照进看板，但执行链路在 miniprogram 模块）：
  // 绝不走 web 的事件构造/上报/领奖 —— buildEvent 没有 "mp" 分支，硬闯只会发出
  // heartbeat 或错误头族。防御性跳过：正常 web 清单不会出现 MP-only 任务，万一
  // 出现（上游串台），这里兜底，runGrowthTasks 2b 的小程序链路会用正确的头族处理。
  if (rk.kind === "mp") {
    logs.push(`⏭ 任务 [${name}] 小程序任务由小程序链路处理, 跳过 web 事件构造`);
    return { credit: 0, energy: 0, lit: 0, claimed: 0 };
  }

  // 未收录任务（TASK_SPECS 没有、jump_url 也派生不出专家 id）：引擎没有任何
  // 合法的事件构造方式 —— 不接取、不上报、不领奖，诚实标注（P0-1）。
  if (rk.source === "none") {
    logs.push(`⏭ 任务 [${name}] ${rk.reason || "未收录任务"}: 引擎没有该任务的事件构造方式, 跳过接取/上报/领奖`);
    return { credit: 0, energy: 0, lit: 0, claimed: 0 };
  }

  if (rk.unforgeable) {
    if (rk.reason) {
      logs.push(`⏭ 任务 [${name}] 需真实操作完成: ${rk.reason}, 跳过`);
    }
    return { credit: 0, energy: 0, lit: 0, claimed: 0 };
  }

  const status = t.acceptStatus;
  const cur = t.progress?.current ?? 0;
  const tgt = t.progress?.target ?? 1;

  if (status === "claimed") return { credit: 0, energy: 0, lit: 0, claimed: 0 };

  // 已完成的任务先领奖 —— 桌面端/夜间任务也可能被真实操作完成，这类任务必须
  // 先结算，不能因为「只能靠真实操作」就直接跳过丢掉奖励。
  if (status === "completed" || cur >= tgt) {
    if (!claim) {
      logs.push(`⏸ 任务 [${name}] 已达成，等待手动领取`);
      return { credit: 0, energy: 0, lit: 0, claimed: 0 };
    }
    const res = await claimTask(acct, code, opts);
    if (res.ok) {
      const cr = res.credit ?? 0;
      logs.push(`✓ 任务 [${name}] 领奖成功: +${cr} 积分`);
      await ctx.breathe();
      return { credit: cr, energy: res.energy ?? 0, lit: 0, claimed: 1 };
    }
    logs.push(`! 任务 [${name}] 领奖失败: ${res.reason || "未知原因"}`);
    await ctx.breathe();
    return { credit: 0, energy: 0, lit: 0, claimed: 0, ...(res.restricted ? { restricted: true } : {}) };
  }

  // 只认桌面端真实行为的任务：伪造事件不会推进进度，诚实跳过并给出深链。
  if (rk.desktopOnly) {
    const jump = t.jumpUrl || "workbuddy://chat";
    logs.push(`⏭ 任务 [${name}] 需真实操作完成: ${rk.desktopReason || "需在桌面端完成"} (深链 ${jump}), 跳过事件伪造`);
    return { credit: 0, energy: 0, lit: 0, claimed: 0 };
  }

  // 夜猫子任务只在 23:00-08:00 计数（每日 01:00 调度器也会自动执行）
  if (NIGHT_TASK_CODES.has(code) && !inNightWindow(ctx.now())) {
    logs.push(`🌙 任务 [${name}] 仅 23:00-08:00 上报计数, 当前不在窗口, 跳过 (每日 01:00 调度器自动执行, 累计 3 天)`);
    return { credit: 0, energy: 0, lit: 0, claimed: 0 };
  }

  if (status === "not_accepted" && t.taskType !== "auto") {
    // 接取没成功就上报是白费功夫：上游只对已接取的任务累计进度。
    logs.push(`⏭ 任务 [${name}] 仍未接取, 跳过 (先解决接取失败)`);
    return { credit: 0, energy: 0, lit: 0, claimed: 0 };
  }

  const kind = rk.kind;

  // skill_share（CONTRACT §11.2，hub 8eede085）：官方 Open Platform 分享路径 ——
  // 市场技能 → 创建真实分享渠道 → 两条渠道事件 → 轮询 → 领奖。创建渠道是
  // **真实上游动作**（上游会真实生成分享链接），不是伪造事件；任一步失败如实
  // 跳过、不领奖（见 runSkillShareTask）。
  if (kind === "skillshare") {
    return runSkillShareTask(acct, t, logs, opts);
  }

  // template_5（CONTRACT §11.3，hub 8eede085）：真实场景表 + 四事件组
  //（agent_task_created → agent_task_created_with_template → template_used →
  // playbook_prompt_send），按缺口逐组上报；进度未确认不提前领奖
  //（见 runTemplateTask —— 旧的 buildEvent 单事件「幻灯片」实现已删除）。
  if (kind === "template") {
    return runTemplateTask(acct, t, logs, opts);
  }

  // 需点亮上报 —— 专家/团队事件必须使用互不相同的 id，否则上游按
  // (eventCode, id) 去重，进度永远不动。
  const need = Math.max(1, tgt - cur);
  // 「浏览资料库」走 web 域的元素点击事件（CONTRACT §7），不是 chat 域的
  // buildEvent 族 —— 日志也注明路径不同。
  if (kind === "library") {
    logs.push(`正在点亮任务 [${name}]（web 点击事件）(需上报 ${need} 次)...`);
  } else {
    logs.push(`正在点亮任务 [${name}] (需上报 ${need} 次)...`);
  }
  let reportOk = true;
  let idPool = null;
  if (kind === "expert" || kind === "team") idPool = kind === "team" ? TEAM_ID_POOL : EXPERT_ID_POOL;
  let fixedExpert = spec?.expert ?? null;
  if (!fixedExpert && rk.pinnedExpertId) {
    // 钉死/派生专家 id（CONTRACT §7）：lighthouse 的常量钉死与 expert_use_*
    // 从 jump_url 解出的 id 都走这里 —— 上游按 (eventCode,id) 去重，池子里的
    // 通用 id 对这类任务不推进进度。
    fixedExpert = [rk.pinnedExpertId, rk.expertName || name];
  }
  for (let i = 0; i < need; i++) {
    let ok;
    if (kind === "library") {
      // 资料库：每次 need 循环发一条 web 点击事件（不走 buildEvent/专家池）
      ok = await reportLibraryEvent(acct, opts);
    } else {
      let expert = fixedExpert;
      if (expert == null && idPool) {
        const [pid, pnm] = idPool[(cur + i) % idPool.length];
        expert = [pid, pnm];
      }
      const ev = buildEvent(acct, kind, i, expert, { now: ctx.now });
      // playbook / RichMeow / Buddy 连链构造器返回数组：一次 report 带上整条链；
      // Buddy 5 连还要走专用桌面头（reportBuddy5Events），其余 kind 用通用 chat 上报。
      const list = Array.isArray(ev) ? ev : [ev];
      ok = kind === "buddy5"
        ? await reportBuddy5Events(acct, list, opts)
        : await reportEvents(acct, list, opts);
    }
    if (!ok) reportOk = false;
    if (i < need - 1) await ctx.breathe();
  }
  if (!reportOk) logs.push(`! 任务 [${name}] 部分事件上报失败 (上游拒绝), 继续尝试领奖`);
  await ctx.breathe(REPORT_SETTLE_MS);

  // 等上游把进度落账再领奖。进度通常 1-3 秒就可见，因此先快查几次；只有
  // 确实在动才继续等，免得每个卡住的任务都空等 20 秒（整轮要几分钟）。
  let prog = cur;
  for (let attempt = 0; attempt < CLAIM_POLL_ATTEMPTS; attempt++) {
    const fresh = (await fetchTasks(acct, opts)).find((x) => x.code === code) ?? null;
    if (fresh) {
      prog = fresh.progress?.current ?? 0;
      if (prog >= tgt || fresh.acceptStatus === "completed" || fresh.acceptStatus === "claimed") break;
      if (prog > cur) {
        // 已经在涨了，值得多等一会儿
        await ctx.breathe(PROGRESS_RISING_MS);
        continue;
      }
    }
    if (attempt < 2) await ctx.breathe(REPORT_SETTLE_MS);
    else break;
  }
  if (prog < tgt) {
    logs.push(`? 任务 [${name}] 已上报但进度 ${prog}/${tgt} 未达成, 领奖顺延到下次运行`);
    await ctx.breathe();
    return { credit: 0, energy: 0, lit: 0, claimed: 0 };
  }

  // 领奖
  if (!claim) {
    logs.push(`⏸ 任务 [${name}] 已点亮，等待手动领取`);
    await ctx.breathe();
    return { credit: 0, energy: 0, lit: 1, claimed: 0 };
  }
  const res = await claimTask(acct, code, opts);
  if (res.ok) {
    const cr = res.credit ?? 0;
    logs.push(`✓ 任务 [${name}] 点亮并领奖成功: +${cr} 积分`);
    await ctx.breathe();
    return { credit: cr, energy: res.energy ?? 0, lit: 1, claimed: 1 };
  }
  logs.push(`! 任务 [${name}] 进度已达 ${prog}/${tgt} 但领奖失败: ${res.reason || "未知原因"}`);
  await ctx.breathe();
  return { credit: 0, energy: 0, lit: 1, claimed: 0, ...(res.restricted ? { restricted: true } : {}) };
}

// ---- 完整流水线（wb_tasks.run_growth_tasks 的移植）---------------------------

// 任务级勾选（CONTRACT §3/§6/§7）：opts.codes 非空数组 = 只处理这些 code；
// 未传 / 空数组 / 非法类型 = 全部任务（旧行为）。这里做一层防御性归一——只留
// 非空字符串并去重（去重保序不必要，进 Set）；每个 uid 清单的去重/上限（500）
// 由 daemon 的 API 边界负责（startJob），引擎只认「非空集合 = 勾选生效」。
function selectedCodeSet(codes) {
  if (!Array.isArray(codes)) return null;
  const out = new Set();
  for (const c of codes) {
    if (typeof c === "string" && c.trim()) out.add(c.trim());
  }
  return out.size ? out : null;
}

// runGrowthTasks(acct, opts) -> GrowsResult
// opts: {gap=1000, claim=true, codes?: string[], mpTasks?: boolean, log(fn), sleep(fn), now(fn), fetch, signal}
//   opts.codes —— 任务级勾选：非空数组时只对选中的任务接取/点亮/领奖；未选中
//   的任务完全不动作（不接取、不上报、不轮询、不领奖）。每次 fetchTasks 之后
//   都按选中集合过滤；选中但任务表里没有的 code 记一次警告并跳过，绝不硬闯
//  （MP 专属任务除外——它们由小程序链路处理，见 engine/miniprogram.mjs）。
//   空数组/未传 = 全部任务（旧行为）。
//   opts.mpTasks —— 显式 false 关闭 2b 的小程序链式任务（缺省开启）。
//   opts.travel —— 显式 false 关闭第 3 步的猫猫旅行检查（缺省开启；runner 批量
//   编排里旅行只由 travel 腿负责，growth 腿传 false 避免重复跑旅行）。
// GrowsResult: {ok, logs, earnedCredit, credit, energy, lit, claimed, restricted?}
export async function runGrowthTasks(acct, opts = {}) {
  const ctx = makeCtx(opts);
  const run = { ...opts, __ctx: ctx };
  const logs = [];
  // 人读日志既进返回值也走 opts.log（runner/面板靠 opts.log 实时收集）
  const emit = (line) => {
    logs.push(line);
    ctx.log?.(line);
  };
  // progressTask 只对数组 push：给它一个同时 emit 的代理
  const logsOut = { push: (line) => emit(line) };
  const totals = { credit: 0, energy: 0, lit: 0, claimed: 0 };
  const collect = (r) => {
    if (!r) return;
    totals.credit += r.credit || 0;
    totals.energy += r.energy || 0;
    totals.lit += r.lit || 0;
    totals.claimed += r.claimed || 0;
    return r.restricted;
  };

  if (acct.provider !== "workbuddy") {
    return { ok: false, msg: "国际版不适用国内成长任务中心", logs: [], earnedCredit: 0 };
  }
  if (acct.enterpriseId) {
    return { ok: true, msg: "企业版账号无成长体系，跳过", logs: [], earnedCredit: 0 };
  }

  emit(`开始为账号 ${acct.nickname || acct.uid.slice(0, 8)} 运行成长任务自动化...`);
  let tasks = await fetchTasks(acct, run);
  if (!tasks.length) {
    emit("未能获取到任务清单，请检查网络或账号状态");
    return { ok: false, logs, earnedCredit: 0, ...totals };
  }

  // 任务级勾选（CONTRACT §3/§6/§7）：选中集合对「整份任务表」先校验一次——
  // 选中但任务表里不存在的 code 记一次警告并跳过（绝不硬闯），随后每次
  // fetchTasks 之后都重新按集合过滤。selected=null = 未勾选，原样透传（旧行为）。
  const selected = selectedCodeSet(opts.codes);
  const scope = (list) => (selected ? list.filter((t) => selected.has(t.code)) : list);
  if (selected) {
    emit(`仅处理选中的 ${selected.size} 项任务`);
    // 缺失警告只对 web 任务表校验：MP 专属任务（Sequential_Tasks_1–6 +
    // school_season）永远不出现在 web 清单里，由 2b 的小程序链路处理，不误报。
    const missing = [...selected].filter((c) => !tasks.some((t) => t.code === c) && !MP_TASK_CODES.has(c));
    if (missing.length) {
      emit(
        `! 选中的 ${missing.length} 项任务不在任务表中，本轮跳过: ${missing.slice(0, 5).join(", ")}` +
        (missing.length > 5 ? " ..." : ""),
      );
    }
  }
  tasks = scope(tasks);

  // 次日锁（0.3.2/2026-11-11 实测：web 清单也带 locked/unlock_at，如 ST7）：
  // 锁定任务整条跳过 —— 不进接取批次（needsAccept 已排除，避免必败的 accept
  // error）、不上报、不领奖；claimed 优先（已领奖不被陈旧锁字段挡住，与小程序
  // 链路同口径）；解锁（上游 locked:false）后照常处理。
  const isLockedTask = (t) => t.locked === true && t.acceptStatus !== "claimed";
  const lockSkip = (t) => {
    if (!isLockedTask(t)) return false;
    emit(`⏳ 任务 [${t.title || t.code}] 到第二天才能接取任务，跳过`);
    return true;
  };

  // 0. auto 类任务（如 first_buddy）不需要接取，且可能是其他任务与猫猫旅行
  //    的前置：必须先把它们点亮并领奖（first_buddy 的奖励就是 Buddy 实例），
  //    否则 single 任务接取会报 "prerequisite not met: first_buddy"。
  //    只有选中的任务才进这一步（tasks 已按勾选过滤）。
  for (const t of tasks) {
    if (t.taskType === "auto") {
      if (lockSkip(t)) continue; // 锁定的 auto 前置同样不动（解锁后下轮补做）
      if (collect(await progressTask(acct, t, logsOut, run))) {
        return { ok: false, restricted: true, logs, earnedCredit: totals.credit, ...totals };
      }
    }
  }

  // 1. 批量接取未接任务（auto 类不接受接取，unforgeable 无法自动化，锁定任务
  //    接取必被上游拒 —— 都不进批次）
  const needsAccept = (x) =>
    x.acceptStatus === "not_accepted" && !x.unforgeable && x.taskType !== "auto" && x.locked !== true;

  const unaccepted = tasks.filter(needsAccept).map((t) => t.code);
  if (unaccepted.length) {
    emit(`发现 ${unaccepted.length} 个待接取任务，正在批量接取...`);
    const acc = await acceptTasks(acct, unaccepted, run);
    if (acc.restricted) {
      return { ok: false, restricted: true, logs, earnedCredit: totals.credit, ...totals };
    }
    if (acc.failed.length) {
      const why = acc.msg || (acc.reasons ?? []).join("; ").slice(0, 160);
      emit(
        `! 接取未成功 ${acc.failed.length} 个: ${acc.failed.slice(0, 5).join(", ")}` +
        (acc.failed.length > 5 ? " ..." : "") +
        (why ? ` (${why})` : ""),
      );
    }
    if (acc.accepted.length) emit(`✓ 已接取 ${acc.accepted.length} 个任务`);
    await ctx.breathe();
    // 复核一次：上游偶尔会瞬时拒绝整个批次，复查后仍处于未接取的再补一次，
    // 否则后面所有上报都作用在未接取的任务上 —— 进度全是 0。
    // 「清单拉空」按**过滤前**的整表判断（勾选过滤后为空是正常现象，不是拉取失败）。
    let refetched = await fetchTasks(acct, run);
    if (!refetched.length) {
      emit("! 接取后无法获取任务清单，本轮中止");
      return { ok: false, logs, earnedCredit: totals.credit, ...totals };
    }
    tasks = scope(refetched);
    const still = tasks.filter(needsAccept).map((t) => t.code);
    if (still.length) {
      emit(`仍有 ${still.length} 个未接取，重试接取一次...`);
      const retry = await acceptTasks(acct, still, run);
      if (retry.restricted) {
        return { ok: false, restricted: true, logs, earnedCredit: totals.credit, ...totals };
      }
      if (retry.accepted.length) emit(`✓ 重试接取成功 ${retry.accepted.length} 个`);
      await ctx.breathe();
      refetched = await fetchTasks(acct, run);
      if (!refetched.length) {
        emit("! 接取后无法获取任务清单，本轮中止");
        return { ok: false, logs, earnedCredit: totals.credit, ...totals };
      }
      tasks = scope(refetched);
    }
    const stillPending = tasks.filter(needsAccept).map((t) => t.code);
    if (stillPending.length) {
      emit(`! 仍有 ${stillPending.length} 个任务处于未接取状态，对未接取任务上报事件不会计入进度，本轮跳过这些任务`);
    }
  }

  // 2. 处理每个任务（auto 已在第 0 步处理过；tasks 仍是选中集合的投影；
  //    锁定任务整条跳过 —— 复核/重试的 needsAccept 已自动排除它们，
  //    「仍有 N 个任务处于未接取状态」不再被锁定任务误报）
  for (const t of tasks) {
    if (t.taskType === "auto") continue;
    if (lockSkip(t)) continue;
    if (collect(await progressTask(acct, t, logsOut, run))) {
      return { ok: false, restricted: true, logs, earnedCredit: totals.credit, ...totals };
    }
  }

  // 2b. 微信小程序链式任务（Sequential_Tasks_1–6 + school_season，CONTRACT §7）：
  //     独立的小程序埋点链路（MP_HEADERS / mpBase / MP_REPORT_HEADERS），在普通
  //     任务处理完、猫猫旅行之前执行；日志与收益并入本腿。opts.mpTasks === false
  //     可整体关闭；opts.codes 勾选时只处理选中的 MP 交集（交集为空则一次上游
  //     都不发）。异常只记日志，绝不中断后面的旅行与结算。
  if (opts.mpTasks !== false) {
    try {
      const mp = await runMiniProgramTasks(acct, run);
      totals.credit += mp.earnedCredit || 0;
      totals.lit += mp.lit || 0;
      totals.claimed += mp.claimed || 0;
      for (const line of mp.logs ?? []) emit(line);
      if (mp.restricted) {
        return { ok: false, restricted: true, logs, earnedCredit: totals.credit, ...totals };
      }
    } catch (err) {
      emit(`! 小程序成长任务执行异常: ${String(err?.message || err).slice(0, 160)}`);
    }
  }

  // 3. 顺手检查猫猫旅行（opts.travel === false 时整段跳过：一次 travel/status 都
  //     不发、日志也不出现「猫猫日常」）。runner 的批量编排里旅行只由 travel 腿
  //     负责（growth 腿显式传 travel:false），否则「只勾 growth」的批量会跑旅行、
  //     「growth+travel」的批量会跑两次；直接调用本函数（旧测试/嵌入）缺省仍检查。
  if (opts.travel !== false) {
    const trRes = await runCatTravel(acct, run);
    if (trRes.msg) {
      emit(`猫猫日常: ${trRes.msg}`);
      if (trRes.credit) totals.credit += trRes.credit;
    }
    if (trRes.restricted) {
      return { ok: false, restricted: true, logs, earnedCredit: totals.credit, ...totals };
    }
  }

  // 4. 结算（hub 会顺带刷新积分余额，这里以能量余额回显代之）
  const energy = await fetchEnergy(acct, run);
  const acted = totals.lit + totals.claimed;
  if (totals.credit > 0 || acted > 0) {
    emit(`🎉 本轮结束：新增到账 +${totals.credit} 积分（点亮 ${totals.lit}、领取 ${totals.claimed}；当前能量 ${energy}）`);
  } else {
    emit(`本轮结束：没有新的收益（+0 积分；选中的任务可能已领奖、未接取或当前不可做；当前能量 ${energy}）`);
  }
  return { ok: true, logs, earnedCredit: totals.credit, ...totals };
}

// ---- 内部小工具 ----------------------------------------------------------------

function chatUrl(opts = {}) {
  const fromOpts = String(opts.base || opts.bases?.chat || "").trim();
  return fromOpts ? fromOpts.replace(/\/+$/, "") : _growthBase(opts.env ?? globalThis.process?.env ?? {});
}
function billUrl() {
  return _billBase();
}
function webUrl_() {
  return _webBase();
}

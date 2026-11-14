// campaign.mjs —— 运营活动任务腿（星巴克协作 / 记者节福利等 campaign_*，CONTRACT
// §11.1，hub 8eede085 的 wb_tasks.py 逐字移植）。
//
// 与成长体系的**独立契约**：活动清单不在成长任务列表里，走 codebuddy.cn 的
// /portal/activity/* 端点（base = billBase()，计费域同源）；判定/领奖状态按活动
// 各自回读，与成长清单互不影响（成长腿空/失败时本腿照跑，反之亦然）。
//
// 0.3.5 追加（CONTRACT §11.6 任务明细重做的后端一半）：
//   - claimCampaignTask(acct, {activity, task}, opts)：单条活动任务领奖出口
//     （POST /api/campaign/claim 的引擎），语义同 §11.1 领奖（必须回读
//     claimed_at 才算成功）；
//   - runCampaignTasks 的 opts.codes 升级为**任务级**勾选
//     （`<activityCode>:<taskCode>`；裸 activityCode 整活动兼容保留）。
//
// 2026-11-13 追加（用户反馈「批量做任务像卡住了」）：判据轮询/领奖回读的
//   **每一轮**都打一行进度日志（生命迹象）—— 判据是异步落库的，点亮等待最长
//   6×3s、慢轮询 6×10s、桌面类 10×6s、领奖回执 5×4s，此前整段只在收尾打一行，
//   看板「实时进度」长时间没有新行。见 campaignPoll / campaignClaim；节奏常量
//   2026-11-13 对照 hub v2.1.3（CAMPAIGN_GAP=3/POLL=6/SLOW_GAP=10/SLOW_POLL=6/
//   CLAIM_GAP=4/CLAIM_POLL=5/DESKTOP_WAIT=60/DESKTOP_POLL=6）逐一复核，一致未改。
//
// 与 hub 的移植差异（我们的架构要求，逐条对齐）：
//   - hub 的 urllib 直连换我们的 engine/upstream.callJSON（自带 breathe + 全局
//     spacer 排队 + 重试/退避 + 403/11140 restricted 透传 + chat 主机回退）——
//     铁律 4 对每个上游调用照常生效；
//   - hub 的 `_post_mp_events(account, events, base, page, headers)`（页面上下文
//     上报）用我们已有的两块能力拼出：事件体 = miniprogram.mpBase + 页面字段
//     （pageURL/pageName）+ 事件本体（mpBase 与 MP_REPORT_HEADERS 已在
//     engine/miniprogram.mjs 逐字移植）；头族用 upstream.callJSON 新增的
//     init.replaceHeaders 通道原样替换成 hub `_campaign_headers` 的最小头族
//     （MP_REPORT_HEADERS + Authorization + X-User-Id，不带桌面端头族 ——
//     「Activity APIs use the mini-program identity, not the desktop profile」；
//     Authorization 由引擎注入，绝不走外部输入）；
//   - hub `_report_desktop_events`（desktop 类判据）复用 tasks.reportDesktopEvents
//     （同一移植，见该函数注释）。
//
// 红线（CONTRACT §11.1）：
//   - `app`（手机端 App 对话）**只提示、不伪造**；
//   - 领奖只 POST 成功**不算**成功，必须回读到 claimed_at；
//   - 进度以 completed_at 或 progress >= target_count 为准；need_view 真值先 viewed；
//   - 活动读取失败要与「活动没下发」严格区分（日志写明 HTTP 状态与正文片段）；
//   - 绝不抛；restricted（HTTP 403 / code 11140）透传给调用方走 §10.5 冻结。

import { randomUUID } from "node:crypto";
import { MP_REPORT_HEADERS, mpBase } from "./miniprogram.mjs";
import { newGrowthMessageId, reportDesktopEvents } from "./tasks.mjs";
import { billBase as _billBase, callJSON, ctxOf } from "./upstream.mjs";

// ---- 活动清单（hub CAMPAIGN_SPECS 逐字拷贝：code/label/page/tasks 的
// task/label/kind/times/expert_id/expert_name/skill_id/skill_name/case_id/credit
// 一个不改）。kind 取值：chat / expert / app / skill / desktop；app 只提示不伪造。
export const CAMPAIGN_SPECS = [
  {
    code: "campaign_starbucks_2026",
    label: "星巴克协作",
    page: {
      pageURL: "subpackages/secondary/starbucks-activity-428/index",
      pageName: "starbucks_activity",
    },
    tasks: [
      { task: "ai_chat", label: "与 AI 对话3次", kind: "chat", times: 3, credit: 100 },
      { task: "expert", label: "召唤专家并对话", kind: "expert", credit: 100 },
      { task: "app", label: "解锁 App 强大能力", kind: "app", credit: 100 },
    ],
  },
  {
    code: "campaign_reporter_2026",
    label: "记者节福利活动",
    page: {
      pageURL: "subpackages/journalist-benefit/index",
      pageName: "journalist_benefit",
    },
    tasks: [
      { task: "expert_chat", label: "体验「媒体工作助理」专家", kind: "expert",
        expert_id: "ex_NaiDbO06Adf3", expert_name: "媒体工作助理", credit: 50 },
      { task: "skill_use", label: "体验「采访素材整理」技能", kind: "skill",
        skill_id: "skill_2117491159283752960", skill_name: "interview-material-organizer", credit: 50 },
      { task: "desktop_same", label: "体验「内容发布排期」灵感", kind: "desktop",
        case_id: "content-calendar", credit: 100 },
    ],
  },
];

// hub CAMPAIGN_CASES 逐字拷贝：desktop 类判据的内置案例（活动判据认产物目录名，
// 不认注册表 slug 或中文名）。
export const CAMPAIGN_CASES = {
  "content-calendar": {
    event_id: "cnb-content-calendar",
    name: "内容发布排期表",
    type: "table",
    prompt_length: 359,
  },
};

// hub MP_EXPERT_CATEGORY 逐字拷贝：campaignPickExpert 的专家目录分类。
export const MP_EXPERT_CATEGORY = "16-BackToSchool";

// ---- 节奏常量（hub CAMPAIGN_* 逐字换算成毫秒；轮询间隔都 ≥1s，铁律 4 之上再加
// 活动判据异步落库的耐心）-----------------------------------------------
export const CAMPAIGN_GAP_MS = 3000;        // CAMPAIGN_GAP = 3：判据轮询间隔
export const CAMPAIGN_POLL_TRIES = 6;       // CAMPAIGN_POLL = 6
export const CAMPAIGN_SLOW_GAP_MS = 10000;  // CAMPAIGN_SLOW_GAP = 10：慢轮询间隔
export const CAMPAIGN_SLOW_POLL_TRIES = 6;  // CAMPAIGN_SLOW_POLL = 6
export const CAMPAIGN_CLAIM_GAP_MS = 4000;  // CAMPAIGN_CLAIM_GAP = 4：领奖回读间隔
export const CAMPAIGN_CLAIM_POLL_TRIES = 5; // CAMPAIGN_CLAIM_POLL = 5
export const CAMPAIGN_DESKTOP_WAIT_MS = 60000; // CAMPAIGN_DESKTOP_WAIT = 60（秒）
export const CAMPAIGN_DESKTOP_POLL_MS = 6000;  // CAMPAIGN_DESKTOP_POLL = 6（秒）

// ---- 事件构造（hub `_campaign_*_events` 逐字移植；事件体本身不带 userId ——
// 它们经 postCampaignEvents 上报，userId/timestamp 等公共字段由 mpBase 包络携带）--

// hub `_new_conversation_id` = str(uuid.uuid4())。
function newConversationId() {
  return randomUUID();
}

// chat 类判据（与 AI 对话 N 次）：一次对话 = 一条 chat_request_send（mp 身分）。
export function campaignChatEvent(nowMs) {
  const conv = newConversationId();
  const rid = newGrowthMessageId(nowMs);
  return {
    eventCode: "chat_request_send", mode: "chat", inputLength: 12,
    isPlan: false, isAutoExecuteTerminal: false, isAutoModify: false,
    codebaseEnable: false, maxToken: 0, maxSteps: 500,
    temperature: 0, maxRetries: 0, mentionContexts: [],
    knowledgeId: [], knowledgeName: [], codebaseId: "",
    mentionContextCount: 0, command: "", recommendId: "",
    skillId: "", skillCount: 0, totalCount: 0,
    requestId: rid, traceId: rid, rootRequestId: rid,
    parentConversationId: conv, conversationId: conv,
    messageId: "msg-" + rid.slice(-8), agentName: "mp",
    agentType: "main", "codebuddy.session_id": conv,
    "codebuddy.conversation_request_id": rid,
  };
}

// expert 类判据：召唤 → 落地 → 实际使用 → 对话，四条一组一次上报。
export function campaignExpertEvents(expertId, expertName, nowMs) {
  const conv = newConversationId();
  const rid = newGrowthMessageId(nowMs);
  const category = MP_EXPERT_CATEGORY;
  return [
    { eventCode: "expert_summon_click", id: expertId,
      name: expertId, expertTitle: expertName, type: category,
      position: 0 },
    { eventCode: "expert_summoned", id: expertId,
      name: expertId, expertTitle: expertName },
    { eventCode: "expert_actual_use", id: expertId,
      name: expertId, expertTitle: expertName, type: category,
      characterCount: 14, expertType: "builtin" },
    { eventCode: "chat_request_send", inputLength: 14,
      isPlan: false, isAutoExecuteTerminal: false,
      isAutoModify: false, codebaseEnable: false, maxToken: 0,
      maxSteps: 500, temperature: 0, maxRetries: 0,
      mentionContexts: [], knowledgeId: [], knowledgeName: [],
      codebaseId: "", mentionContextCount: 0, command: "",
      recommendId: "", skillId: "", skillCount: 0,
      totalCount: 0, traceId: rid, rootRequestId: rid,
      parentConversationId: conv, conversationId: conv,
      messageId: "msg-" + rid.slice(-8), agentName: "mp",
      agentType: "main", expertId: expertId,
      expertName: expertName, "codebuddy.session_id": conv,
      "codebuddy.conversation_request_id": rid },
  ];
}

// skill 类判据：技能详情 + 带技能的对话，两条一组一次上报。
export function campaignSkillEvents(skillId, skillName, nowMs) {
  const conv = newConversationId();
  const rid = newGrowthMessageId(nowMs);
  return [
    { eventCode: "skill_info", id: skillName, skillId: skillId,
      skillName: skillName, skillType: "market",
      skillSource: "market", position: 0,
      conversationId: conv },
    { eventCode: "chat_request_send", inputLength: 14,
      isPlan: false, isAutoExecuteTerminal: false,
      isAutoModify: false, codebaseEnable: false, maxToken: 0,
      maxSteps: 500, temperature: 0, maxRetries: 0,
      mentionContexts: [], knowledgeId: [], knowledgeName: [],
      codebaseId: "", mentionContextCount: 0, command: "",
      recommendId: "", skillId: skillId, skillCount: 1,
      totalCount: 0, traceId: rid, rootRequestId: rid,
      parentConversationId: conv, conversationId: conv,
      messageId: "msg-" + rid.slice(-8), agentName: "mp",
      agentType: "main", "codebuddy.session_id": conv,
      "codebuddy.conversation_request_id": rid },
  ];
}

// desktop 类判据：一条 playbook_prompt_send（发现页灵感案例，桌面头上报）。
export function campaignDesktopEvents(caseInfo, nowMs) {
  return [{
    eventCode: "playbook_prompt_send",
    id: caseInfo?.event_id || "",
    name: caseInfo?.name || "",
    type: caseInfo?.type || "other",
    promptLength: caseInfo?.prompt_length || 0,
    isOfficial: 1,
    source: "discover",
    query: "",
    ext1: "discover",
    requestId: newGrowthMessageId(nowMs),
    conversationId: newConversationId(),
  }];
}

// campaignPickExpert(acct, opts) -> {id, name, restricted?}
//（hub `_campaign_pick_expert` 逐字移植）：专家目录里挑第一个可用的真实专家；
// 目录不可用/取不到时回落稳定的小程序专家 WorkspaceBuilder（工作台搭建师）。
// hub 这里明确用 account.headers("chat")（桌面头族）——与活动事件上报的 MP 最小
// 头族不同，照抄。
export async function campaignPickExpert(acct, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe();
  const body = {
    edition_mode: "all,domestic", page: 1, page_size: 20,
    sort_by: "use_count", sort_order: "desc",
    categories: [MP_EXPERT_CATEGORY], expert_type: "agent",
  };
  const res = await callJSON(
    acct, "chat", campaignBase(opts) + "/v2/operation-platform/market/expert/list",
    { method: "POST", body: JSON.stringify(body) },
    opts,
  );
  if (res.restricted) return { id: "", name: "", restricted: true };
  if (res.ok) {
    for (const expert of res.data?.experts ?? []) {
      const id = expert?.expert_id;
      if (!id) continue;
      const display = expert.display_name_zh;
      const name =
        (typeof display === "object" && display ? display.zh : display) ||
        expert.name ||
        id;
      return { id: String(id), name: String(name) };
    }
  }
  // hub：任何失败都回落稳定专家（「Resolve a real expert; fall back to the
  // stable mini-program expert」）。
  return { id: "WorkspaceBuilder", name: "工作台搭建师" };
}

// ---- 活动读取 / viewed / 领奖 / 轮询（hub fetch_campaign_tasks / _campaign_view /
// _campaign_claim / _campaign_poll 的移植，一律经 callJSON）---------------------

function campaignBase(opts = {}) {
  const fromOpts = String(opts.bases?.bill || "").trim();
  return fromOpts ? fromOpts.replace(/\/+$/, "") : _billBase();
}

// fetchCampaignRows(acct, campaign, opts, log?) -> {ok:true, rows} | {ok:false, error, restricted?}
// rows: {task_code: {target, progress, completedAt, claimedAt, needView, credit}}。
// 读取失败（HTTP 非 2xx / 信封失败）与「活动没下发」严格区分：失败时 error 里
// 写明 HTTP 状态与正文片段（raw 前 80 字符），rows 恒为 {}。
async function fetchCampaignRows(acct, campaign, opts = {}, log = null) {
  const ctx = ctxOf(opts);
  await ctx.breathe();
  const path = `/portal/activity/tasks?activity_code=${encodeURIComponent(String(campaign))}`;
  const res = await callJSON(acct, "chat", campaignBase(opts) + path, { method: "GET" }, opts);
  if (res.restricted) {
    return { ok: false, restricted: true, rows: {}, error: res.msg || "restricted" };
  }
  if (!res.ok) {
    const snippet = String(res.raw || res.msg || "").slice(0, 80);
    const error = `活动任务读取失败[${campaign}]: HTTP ${res.status ?? 0} ${snippet}`.trim();
    if (log) log(`⚠️ ${error}`);
    return { ok: false, rows: {}, error, status: res.status ?? 0 };
  }
  const data = res.data ?? {};
  const progress = new Map();
  for (const p of data.progress ?? []) {
    if (p && typeof p === "object" && p.task_code) progress.set(p.task_code, p);
  }
  const rows = {};
  for (const task of data.tasks ?? []) {
    if (!task || typeof task !== "object" || !task.task_code) continue;
    const prog = progress.get(task.task_code) ?? {};
    rows[task.task_code] = {
      target: task.target_count || 0,
      progress: prog.progress || 0,
      completedAt: prog.completed_at ?? "",
      claimedAt: prog.claimed_at ?? "",
      // hub 语义（row.get("need_view", True) 的实际行为）：need_view **真值**才
      // view；上游缺失/None → 不 view（hub 把 task.get("need_view") 原样放进
      // row，缺键即 None → falsy）。这里同样原样透传，用真值判断。
      needView: task.need_view,
      credit: task.reward_credit || 0,
    };
  }
  return { ok: true, rows };
}

// activityFromRead(spec, read)：把一次读取结果收敛成 §11.1 的 activity 投影形状。
// 只聚合上游实际下发的 task（spec 里没下发的行不进 tasks —— runCampaignTasks 会
// 为它们记「未下发/已下线」与 unavailable）。error 非空 = 读取失败（与 tasks 为
// 空 = 没下发，两种状态严格区分）。
function activityFromRead(spec, read) {
  if (!read || !read.ok) {
    return {
      code: spec.code, label: spec.label, page: spec.page,
      tasks: [], claimable: 0, claimed: 0,
      error: String(read?.error ?? "未读取"),
    };
  }
  const tasks = [];
  let claimable = 0;
  let claimed = 0;
  for (const taskSpec of spec.tasks) {
    const row = read.rows[taskSpec.task];
    if (!row) continue; // 未下发/已下线
    const target = row.target || taskSpec.times || 1;
    const done = !!row.completedAt || (row.progress || 0) >= target;
    if (row.claimedAt) claimed += 1;
    else if (done) claimable += 1;
    tasks.push({
      taskCode: taskSpec.task,
      label: taskSpec.label,
      kind: taskSpec.kind,
      progress: row.progress || 0,
      target,
      credit: row.credit || taskSpec.credit || 0,
      completedAt: row.completedAt || "",
      claimedAt: row.claimedAt || "",
      needView: !!row.needView,
    });
  }
  return { code: spec.code, label: spec.label, page: spec.page, tasks, claimable, claimed, error: "" };
}

// specFilter(opts.codes)：活动 code 勾选（CONTRACT §11.1 fetchCampaignState 的
// opts.codes）——非空数组只跑选中的活动；未传/空/非法 = 全部。
function specFilter(codes) {
  if (!Array.isArray(codes)) return CAMPAIGN_SPECS;
  const set = new Set(codes.map((c) => String(c ?? "").trim()).filter(Boolean));
  if (!set.size) return CAMPAIGN_SPECS;
  return CAMPAIGN_SPECS.filter((s) => set.has(s.code));
}

// campaignSelection(codes, log) —— runCampaignTasks 的**任务级**勾选解析
//（CONTRACT §11.6 第 4 条）。opts.codes 的条目语义：
//   - 未传 / 非数组 / 空数组 → 全部活动全部任务（现状全跑；与成长/小程序腿
//     「未传/空数组 = 全部」同款约定 —— daemon 的 /api/run 归一化还会把空清单
//     落成 null，引擎侧再兜一道底。所以「空数组 vs 不传」同义，真正的分界在
//     「非空但没有任何活动任务条目」→ 见下一条）
//   - `<activityCode>:<taskCode>`（活动命中 CAMPAIGN_SPECS）→ 只跑该活动、
//     活动内只跑勾中的任务；同一活动同时被裸 code 与 pair 勾中时取并集
//     （整活动勾选优先）
//   - 裸 `<activityCode>`（命中 CAMPAIGN_SPECS）→ 整个活动（§11.1 旧口径，
//     向后兼容保留）
//   - **其它条目一律忽略**：批量 codes 是成长/小程序/活动三套命名空间混在
//     同一个池子里，本腿只认自己的条目 —— 成长任务 code、MP code、未知 code
//     都不是「活动」，绝不拿去匹配 CAMPAIGN_SPECS、也不告警（它们归各自的腿）
//   - 非空数组但一条活动任务条目都没命中 → empty:true：本腿无事可做，零上游
//     跳过（与 runMiniProgramTasks「交集为空连清单都不拉」同款）—— 绝不回退成
//     全跑（用户勾了具体任务，没勾活动 = 活动腿不该动）
//   - 勾中活动但任务 code 不在 CAMPAIGN_SPECS（手滑/版本漂移）→ 警告一次并
//     跳过（同成长腿「缺失 code 警告」口径）
// 过滤在读清单**之前**完成：未选中的活动整块跳过，连每活动一次的 GET 都省
//（上游调用次数 = 选中活动数，而非全部活动数）。
function campaignSelection(codes, log = null) {
  if (!Array.isArray(codes) || !codes.length) {
    return { specs: CAMPAIGN_SPECS, taskSel: null, whole: null, empty: false };
  }
  const whole = new Set(); // 裸活动 code（整活动勾选）
  const pairs = new Map(); // activityCode -> Set(taskCode)
  for (const raw of codes) {
    const s = String(raw ?? "").trim();
    if (!s) continue;
    const i = s.indexOf(":");
    if (i === -1) {
      if (CAMPAIGN_SPECS.some((sp) => sp.code === s)) whole.add(s);
      continue;
    }
    const act = s.slice(0, i).trim();
    const task = s.slice(i + 1).trim();
    if (!task || !CAMPAIGN_SPECS.some((sp) => sp.code === act)) continue;
    if (!pairs.has(act)) pairs.set(act, new Set());
    pairs.get(act).add(task);
  }
  if (!whole.size && !pairs.size) return { specs: [], taskSel: null, whole, empty: true };
  for (const [act, tasks] of pairs) {
    const spec = CAMPAIGN_SPECS.find((sp) => sp.code === act);
    for (const t of tasks) {
      if (spec && !spec.tasks.some((ts) => ts.task === t) && log) {
        log(`⚠️ 勾选的活动任务 [${act}/${t}] 不在活动任务清单，跳过`);
      }
    }
  }
  // pair 勾选的活动：至少一个勾中任务在清单里才纳入（否则只留上面那行警告，
  // 该活动连清单读取都省 —— 也绝不在 state 里留下「未读取」的假错误行）。
  const specs = CAMPAIGN_SPECS.filter(
    (sp) => whole.has(sp.code) || sp.tasks.some((ts) => pairs.get(sp.code)?.has(ts.task)),
  );
  if (!specs.length) return { specs: [], taskSel: null, whole, empty: true };
  return { specs, taskSel: pairs.size ? pairs : null, whole, empty: false };
}

// fetchCampaignState(acct, opts) -> 只读快照（CONTRACT §11.1）
// -> {ok:true, activities:[{code,label,page,tasks:[{taskCode,label,kind,progress,
//     target,credit,completedAt,claimedAt,needView}],claimable,claimed,error}],
//     updatedISO}
// 任一活动读取失败不影响其余（该活动 error 非空、tasks 空）；全部读取失败 →
// {ok:false, error}。restricted 透传。opts.codes 可只查部分活动。
export async function fetchCampaignState(acct, opts = {}) {
  const ctx = ctxOf(opts);
  const updatedISO = new Date(ctx.now()).toISOString();
  if (acct?.provider !== "workbuddy") {
    return { ok: false, error: "国际版不适用国内运营活动任务", activities: [], updatedISO };
  }
  if (acct?.enterpriseId || acct?.isApiKey) {
    return { ok: true, skipped: true, activities: [], updatedISO };
  }
  const wanted = specFilter(opts.codes);
  const activities = [];
  let okCount = 0;
  let errText = "";
  for (const spec of wanted) {
    const read = await fetchCampaignRows(acct, spec.code, opts);
    if (read.restricted) {
      return { ok: false, restricted: true, error: read.error || "账号已被风控限制", activities, updatedISO };
    }
    if (!read.ok) {
      if (!errText) errText = read.error;
    } else {
      okCount += 1;
    }
    activities.push(activityFromRead(spec, read));
  }
  if (wanted.length && okCount === 0) {
    return { ok: false, error: errText || "活动任务读取全部失败", activities, updatedISO };
  }
  return { ok: true, activities, updatedISO };
}

// ---- 事件上报（hub `_post_mp_events(..., page)` + `_campaign_headers` 的移植）--
// 事件体 = mpBase（埋点指纹）+ 页面上下文（pageURL/pageName）+ 事件本体；头族 =
// MP_REPORT_HEADERS + Authorization（引擎注入）+ X-User-Id 的最小集合
//（replaceHeaders 通道，不带桌面端头族）。打 **codebuddy 域** /v2/report
//（CAMPAIGN_BASE，与 hub 的 `_post_mp_events(..., CAMPAIGN_BASE, ...)` 同源）。
async function postCampaignEvents(acct, events, page, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe();
  const base = mpBase(acct?.uid, acct?.nickname, ctx.now());
  const pageCtx = page && typeof page === "object" ? page : {};
  const arr = (Array.isArray(events) ? events : [events]).map((e) => ({ ...base, ...pageCtx, ...e }));
  const res = await callJSON(
    acct, "chat", campaignBase(opts) + "/v2/report",
    {
      method: "POST",
      body: JSON.stringify(arr),
      replaceHeaders: true,
      headers: { ...MP_REPORT_HEADERS, "X-User-Id": String(acct?.uid ?? "") },
    },
    opts,
  );
  return !!res.ok;
}

// viewed（hub `_campaign_view`）：need_view 真值的任务先打一次已浏览。
async function campaignView(acct, campaign, task, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe();
  const path =
    `/portal/activity/tasks/${encodeURIComponent(String(task))}/viewed` +
    `?activity_code=${encodeURIComponent(String(campaign))}`;
  const res = await callJSON(acct, "chat", campaignBase(opts) + path, { method: "POST", body: "{}" }, opts);
  if (res.restricted) return { ok: false, restricted: true };
  return { ok: !!res.ok };
}

// 领奖（hub `_campaign_claim`）：只 POST 成功**不算**成功 —— 提交后最多回读
// CAMPAIGN_CLAIM_POLL_TRIES 次（间隔 CAMPAIGN_CLAIM_GAP_MS），必须看到
// claimed_at 才记成功；没回读到就「下轮重试」。
// -> {ok, reason, restricted?}：reason 是给人话的失败说明（含 HTTP 状态/正文
// 片段；ok:true 时为空串）。批量腿只消费 ok/restricted，reason 供单任务出口
// claimCampaignTask 透传给路由。
async function campaignClaim(acct, campaign, task, credit, opts = {}, log = null) {
  const ctx = ctxOf(opts);
  await ctx.breathe();
  const path =
    `/portal/activity/tasks/${encodeURIComponent(String(task))}/claim` +
    `?activity_code=${encodeURIComponent(String(campaign))}`;
  const res = await callJSON(acct, "chat", campaignBase(opts) + path, { method: "POST", body: "{}" }, opts);
  if (res.restricted) return { ok: false, restricted: true, reason: res.msg || "账号已被风控限制" };
  if (!res.ok) {
    const snippet = String(res.raw || res.msg || "").slice(0, 80);
    if (log) log(`⚠️ 领奖[${campaign}/${task}]: HTTP ${res.status ?? 0} ${snippet}`.trimEnd());
    return {
      ok: false,
      reason: `领奖提交失败[${campaign}/${task}]: HTTP ${res.status ?? 0} ${snippet}`.trim(),
    };
  }
  const total = Math.max(1, CAMPAIGN_CLAIM_POLL_TRIES);
  for (let i = 0; i < total; i++) {
    if (i) await ctx.breathe(CAMPAIGN_CLAIM_GAP_MS);
    // 生命迹象（2026-11-13 用户反馈）：每轮一行 —— 回执异步落库最长 5×4s，
    // 期间看板要有新行；文案与下面成功/失败行同前缀（领奖[活动/任务]）。
    if (log) log(`   🎁 领奖[${campaign}/${task}]: 已提交，等待回执（第 ${i + 1}/${total} 次）`);
    const read = await fetchCampaignRows(acct, campaign, opts, log);
    if (read.restricted) return { ok: false, restricted: true, reason: read.error || "账号已被风控限制" };
    const row = (read.ok ? read.rows[task] : null) || {};
    if (row.claimedAt) {
      if (log) log(`🎁 领奖[${campaign}/${task}]: +${credit} 积分`);
      return { ok: true, reason: "" };
    }
  }
  if (log) log(`⚠️ 领奖[${campaign}/${task}]: 已提交但未回读到 claimed_at，下轮重试`);
  return {
    ok: false,
    reason:
      `领奖[${campaign}/${task}]: 已提交但未回读到 claimed_at` +
      `（重试 ${CAMPAIGN_CLAIM_POLL_TRIES} 次仍无上游回执，判据回执延迟）——稍后重跑「活动任务」会自动补领`,
  };
}

// claimCampaignTask(acct, {activity, task}, opts) -> {ok, credit, energy, reason, restricted?}
// 单条活动任务领奖出口（CONTRACT §11.6 第 3 条，给 POST /api/campaign/claim 用）。
// 语义与 §11.1 的领奖**完全一致**：POST
// /portal/activity/tasks/<task>/claim?activity_code=<activity> → **必须回读到
// claimed_at 才算成功**（只 POST 成功不算），回读预算沿用
// CAMPAIGN_CLAIM_POLL_TRIES / CAMPAIGN_CLAIM_GAP_MS。返回形状与其余 claim 出口
// （tasks.claimTask / miniprogram.claimMPTask）一致：credit 来自活动清单的
// reward_credit（本出口自带**一次**清单读取拿它记账并确认任务存在/已达成，
// 回读阶段复用 campaignClaim 的轮询，不重复拉第二份清单）。
// 绝不抛；restricted 透传；失败 reason 给人话（含 HTTP 状态/正文片段）。
// 幂等：清单里已见 claimed_at → 直接 ok:true（不再 POST）。
export async function claimCampaignTask(acct, target, opts = {}) {
  const activity = String(target?.activity ?? "").trim();
  const task = String(target?.task ?? "").trim();
  const fail = (reason, extra = {}) => ({ ok: false, credit: 0, energy: 0, reason, ...extra });
  if (!activity || !task) return fail("需要 activity 与 task（活动 code 与任务 code 缺一不可）");
  if (acct?.provider !== "workbuddy") return fail("国际版不适用国内运营活动任务");
  if (acct?.enterpriseId || acct?.isApiKey) return fail("企业版账号无成长体系，没有运营活动任务");
  try {
    const read = await fetchCampaignRows(acct, activity, opts);
    if (read.restricted) return fail(read.error || "账号已被风控限制", { restricted: true });
    if (!read.ok) return fail(read.error || "活动任务读取失败");
    const row = read.rows[task];
    if (!row) return fail(`活动 ${activity} 未下发任务 ${task}（未下发/已下线，或活动不存在）`);
    const credit = row.credit || 0;
    if (row.claimedAt) return { ok: true, credit, energy: 0, reason: "" };
    const targetCount = row.target || 1;
    if (!row.completedAt && (row.progress || 0) < targetCount) {
      // 与批量腿同一道门（completed_at 或 progress>=target 才领）：不给未达成的
      // 任务硬闯领奖（上游必 400），reason 里带上进度说清差多少。
      return fail(`任务未达成（${row.progress || 0}/${targetCount}），暂不能领奖`);
    }
    const got = await campaignClaim(acct, activity, task, credit, opts);
    if (got.restricted) return fail(got.reason || "账号已被风控限制", { restricted: true });
    if (!got.ok) return fail(got.reason || "领奖未完成（未回读到 claimed_at）");
    return { ok: true, credit, energy: 0, reason: "" };
  } catch (e) {
    return fail(`活动任务领奖失败：${String(e?.message ?? e).slice(0, 200)}`);
  }
}

// 判据轮询（hub `_campaign_poll`）：每次 breathe(gap) 后重读活动，completed_at
// 或 progress >= target 即达标；预算耗尽返回最新值（可能仍是旧值 —— 判据延迟）。
// 每一轮都打一行进度（2026-11-13 用户反馈「点亮后像卡住了」）：一轮一条（间隔
// 即轮询间隔，≥1s 铁律之上），带本轮读到的进度与「第 i/n 次检查」；label 是任务
// 人话名，note 说明在等什么（等待上游落库 / 慢轮询加等 / 桌面端动作需等待）。
async function campaignPoll(acct, campaign, task, target, tries, gapMs, opts = {}, log = null, label = "", note = "等待上游落库") {
  const ctx = ctxOf(opts);
  let current = 0;
  const total = Math.max(1, tries ?? CAMPAIGN_POLL_TRIES);
  for (let i = 0; i < total; i++) {
    await ctx.breathe(gapMs ?? CAMPAIGN_GAP_MS);
    const read = await fetchCampaignRows(acct, campaign, opts, log);
    if (read.restricted) return { value: current, restricted: true };
    const row = (read.ok ? read.rows[task] : null) || {};
    current = row.progress || 0;
    // 生命迹象：先打点再判达标（落库那一轮也有一行 —— 行数 = 检查次数）
    if (log && label) log(`   ⏳ ${label}: ${note}（${current}/${target}，第 ${i + 1}/${total} 次检查）`);
    if (row.completedAt || current >= target) return { value: Math.max(current, target) };
  }
  return { value: current };
}

// 判据发射（hub `_campaign_fire`）：按 kind 构造一组事件并上报。
// **app 判据只提示、不伪造**（返回 {ok:false, notForged:true}，日志已写）。
async function campaignFire(acct, spec, task, opts = {}, log = null) {
  const kind = task.kind;
  const page = spec.page ?? {};
  const now = ctxOf(opts).now();
  if (kind === "app") {
    if (log) log(`   ⏳ ${task.label}: 需手机端 App 登录后与 AI 对话一次，脚本不伪造`);
    return { ok: false, notForged: true };
  }
  if (kind === "desktop") {
    const caseInfo = Object.hasOwn(CAMPAIGN_CASES, task.case_id) ? CAMPAIGN_CASES[task.case_id] : null;
    if (!caseInfo) {
      if (log) log(`   ⚠️ ${task.label}: 未内置案例 ${task.case_id}`);
      return { ok: false };
    }
    return { ok: await reportDesktopEvents(acct, campaignDesktopEvents(caseInfo, now), opts) };
  }
  if (kind === "chat") {
    return { ok: await postCampaignEvents(acct, [campaignChatEvent(now)], page, opts) };
  }
  if (kind === "expert") {
    let expertId = task.expert_id || "";
    let expertName = task.expert_name || "";
    if (!expertId) {
      const picked = await campaignPickExpert(acct, opts);
      if (picked.restricted) return { ok: false, restricted: true };
      expertId = picked.id;
      expertName = picked.name;
    }
    if (!expertId) {
      if (log) log(`   ✗ ${task.label}: 取不到专家 id，跳过`);
      return { ok: false };
    }
    return { ok: await postCampaignEvents(acct, campaignExpertEvents(expertId, expertName, now), page, opts) };
  }
  if (kind === "skill") {
    return { ok: await postCampaignEvents(acct, campaignSkillEvents(task.skill_id, task.skill_name, now), page, opts) };
  }
  return { ok: false };
}

// runCampaignTasks(acct, opts) -> {ok, earned, restricted?, logs, actions, state,
//                                  unavailable, lit, claimed}
// opts: {codes?: string[]（任务级勾选，§11.6 第 4 条：`<activityCode>:<taskCode>`
//        对 = 只跑命中活动/任务；裸 activityCode = 整活动（§11.1 旧口径兼容）；
//        未传/空数组 = 全跑；非空但无活动条目 = 零上游跳过；其它命名空间的
//        code 一律忽略 —— 详见 campaignSelection 注释）, claim?, log(fn), sleep(fn),
//        now(fn), fetch, gap?, spacer?, signal, bases?, env?}
// 判据是异步落库的：每次发射后有限轮询；没落库的判据留给下一轮，绝不原地补喷。
// 与成长腿解耦：本腿只读 /portal/activity/*，成长清单的成败不影响这里。
export async function runCampaignTasks(acct, opts = {}) {
  const ctx = ctxOf(opts);
  const logs = [];
  const emit = (line) => {
    logs.push(line);
    ctx.log?.(line);
  };
  const actions = { viewed: [], fired: [], claimed: [] };
  const unavailable = [];
  const claim = opts.claim !== false;
  let earned = 0;
  let failed = false;
  let restricted = false;
  let available = 0;

  if (acct?.provider !== "workbuddy") {
    return { ok: false, earned: 0, logs: ["国际版不适用国内运营活动任务"], actions, unavailable, state: null };
  }
  if (acct?.enterpriseId || acct?.isApiKey) {
    return { ok: true, earned: 0, logs: ["企业版账号无成长体系，跳过"], actions, unavailable, state: null };
  }

  const sel = campaignSelection(opts.codes, emit);
  if (sel.empty) {
    // 勾选清单里一条活动任务都没有（全是成长/小程序 code 或未知 code）：
    // 本腿无事可做，零上游（一次 /portal/activity/* 都不读）。
    emit("☕️ 勾选的任务里没有运营活动任务（活动任务勾选格式：<活动code>:<任务code>），本腿跳过");
    return {
      ok: true,
      earned: 0,
      logs,
      actions,
      unavailable,
      state: { ok: true, activities: [], updatedISO: new Date(ctx.now()).toISOString() },
      lit: 0,
      claimed: 0,
    };
  }
  const wanted = sel.specs;
  const lastRead = new Map(); // 活动最后一次读取（成功或失败），结束时据此拼 state
  const updatedISO = () => new Date(ctx.now()).toISOString();
  const stateFrom = () => {
    const activities = wanted.map((spec) => activityFromRead(spec, lastRead.get(spec.code)));
    return {
      ok: activities.some((a) => a && a.error === ""),
      activities,
      updatedISO: updatedISO(),
    };
  };

  for (const spec of wanted) {
    if (restricted) break;
    // 任务级勾选：整活动勾选（裸 code）跑全部任务（tset=null）；pair 勾选只跑
    // 选中的任务（在下面的任务循环里逐项过滤 —— 未勾中的任务不 view、不发射、
    // 不领奖，上游状态原封不动，连「未下发/已下线」都不记它们）。
    const tset = sel.taskSel && !(sel.whole && sel.whole.has(spec.code)) ? sel.taskSel.get(spec.code) : null;
    const read = await fetchCampaignRows(acct, spec.code, opts, emit);
    lastRead.set(spec.code, read);
    if (read.restricted) {
      restricted = true;
      break;
    }
    if (!read.ok) {
      // 读取失败 ≠ 没下发：错误行（HTTP 状态 + 正文片段）已在 fetchCampaignRows
      // 里经 log 写出，这里再标记本轮结果不完美（hub 的 failed 口径）。
      failed = true;
      continue;
    }
    const rows = read.rows;
    if (!Object.keys(rows).length) {
      emit(`☕️ ${spec.label}: 活动未下发/已结束，跳过`);
      continue;
    }
    available += 1;
    emit(`☕️ ${spec.label}（${spec.code}）`);
    for (const taskSpec of spec.tasks) {
      if (restricted) break;
      if (tset && !tset.has(taskSpec.task)) continue;
      const code = taskSpec.task;
      const label = taskSpec.label;
      const row = rows[code];
      if (!row) {
        emit(`   ⏭ ${label}: 未下发/已下线`);
        unavailable.push(code);
        continue;
      }
      const target = row.target || taskSpec.times || 1;
      let credit = row.credit || taskSpec.credit || 0;
      if (row.claimedAt) {
        emit(`   ✅ ${label}: 已领奖（${target}/${target}）`);
        continue;
      }
      if (row.completedAt) {
        if (claim) {
          const got = await campaignClaim(acct, spec.code, code, credit, opts, emit);
          if (got.restricted) {
            restricted = true;
            break;
          }
          if (got.ok) {
            earned += credit;
            actions.claimed.push(code);
          } else {
            failed = true;
          }
        } else {
          emit(`   ⏸ ${label}: 已达成，等待手动领取`);
        }
        continue;
      }
      if (row.needView) {
        const v = await campaignView(acct, spec.code, code, opts);
        if (v.restricted) {
          restricted = true;
          break;
        }
        if (v.ok && !actions.viewed.includes(code)) actions.viewed.push(code);
      }
      let current = row.progress || 0;
      const kind = taskSpec.kind;
      if (kind === "app") {
        // 只提示、不伪造（campaignFire 的 app 分支日志 + 进度提示）
        emit(`   ⏳ ${label}: 需手机端 App 登录后与 AI 对话一次，脚本不伪造`);
        emit(`   ⏳ ${label}: 尚未完成（${current}/${target}），真机完成后重跑会自动领奖`);
        continue;
      }
      if (kind === "desktop") {
        const r = await campaignFire(acct, spec, taskSpec, opts, emit);
        if (r.restricted) {
          restricted = true;
          break;
        }
        if (!r.ok) {
          emit(`   ⚠️ ${label}: 上报失败`);
          continue;
        }
        if (!actions.fired.includes(code)) actions.fired.push(code);
        const poll = await campaignPoll(
          acct, spec.code, code, target,
          Math.max(2, Math.floor(CAMPAIGN_DESKTOP_WAIT_MS / CAMPAIGN_DESKTOP_POLL_MS)),
          CAMPAIGN_DESKTOP_POLL_MS, opts, emit, label,
          `桌面端动作需等待，最多 ${Math.round(CAMPAIGN_DESKTOP_WAIT_MS / 1000)}s`,
        );
        if (poll.restricted) {
          restricted = true;
          break;
        }
        current = poll.value;
      } else {
        // chat / expert / skill：按缺口逐次发射，每次发射后轮询判据
        for (let i = 0; i < Math.max(1, target - current); i++) {
          if (current >= target) break;
          const r = await campaignFire(acct, spec, taskSpec, opts, emit);
          if (r.restricted) {
            restricted = true;
            break;
          }
          if (!r.ok) break;
          if (!actions.fired.includes(code)) actions.fired.push(code);
          const poll = await campaignPoll(acct, spec.code, code, target, CAMPAIGN_POLL_TRIES, CAMPAIGN_GAP_MS, opts, emit, label);
          if (poll.restricted) {
            restricted = true;
            break;
          }
          current = poll.value;
        }
        if (restricted) break;
        if (current < target) {
          // 判据落库慢：慢轮询再等一轮（10s × 6），仍没到位就顺延下次运行
          const poll = await campaignPoll(
            acct, spec.code, code, target,
            CAMPAIGN_SLOW_POLL_TRIES, CAMPAIGN_SLOW_GAP_MS, opts, emit,
            label, "判据延迟，慢轮询加等",
          );
          if (poll.restricted) {
            restricted = true;
            break;
          }
          current = poll.value;
        }
      }
      // 发射后的最终回读：以 completed_at 或 progress>=target 为准（CONTRACT §11.1）
      const fresh = await fetchCampaignRows(acct, spec.code, opts, emit);
      if (fresh.restricted) {
        restricted = true;
        break;
      }
      lastRead.set(spec.code, fresh);
      const freshRow = (fresh.ok ? fresh.rows[code] : null) || {};
      credit = freshRow.credit || taskSpec.credit || 0;
      if (!(freshRow.completedAt || current >= target)) {
        emit(`   ⏳ ${label}: 判据延迟未落库（${current}/${target}），下轮自动补领`);
        continue;
      }
      emit(`   ✅ ${label}: completed ${target}/${target}`);
      if (claim) {
        const got = await campaignClaim(acct, spec.code, code, credit, opts, emit);
        if (got.restricted) {
          restricted = true;
          break;
        }
        if (got.ok) {
          earned += credit;
          actions.claimed.push(code);
        } else {
          failed = true;
        }
      } else {
        emit(`   ⏸ ${label}: 已达成，等待手动领取`);
      }
    }
  }

  // 收尾一行（CONTRACT §11.5 步骤粒度）：runner 的 step.detail 取 logs 最后一条
  // → SSE 步骤/历史文案 —— 只报总数看不出来自哪个活动，点名有领奖的活动与项数
  //（actions.claimed 是任务 code，按 spec.tasks 的 task 归属到活动）。
  if (earned > 0) {
    const parts = wanted
      .map((spec) => {
        const n = actions.claimed.filter((c) => spec.tasks.some((t) => t.task === c)).length;
        return n ? `${spec.label}×${n}` : "";
      })
      .filter(Boolean);
    emit(`☕️ 活动任务本轮入账 ${earned} 积分${parts.length ? `（${parts.join("、")}）` : ""}`);
  }
  const result = {
    ok: !failed && !restricted,
    earned,
    logs,
    actions,
    unavailable,
    state: stateFrom(),
    lit: actions.fired.length,
    claimed: actions.claimed.length,
  };
  if (restricted) result.restricted = true;
  return result;
}

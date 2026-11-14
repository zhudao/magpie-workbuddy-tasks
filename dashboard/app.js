// WorkBuddy 任务看板 —— 纯 vanilla ESM，零依赖、零构建、无内联脚本（对齐 magpie 的 CSP 纪律）。
//
// 数据面（只消费 daemon.mjs 真实存在的路由，绝不发明接口）：
//   GET  /api/hello            -> {name, version, ready}
//        看板启动时查一次，拿 version 与静态文件版本（<meta name="wb-version">）比对：
//        不一致 → 版本一致性横幅（插件文件更新了但老进程还在跑）。不为此每 3 秒轮询。
//   GET  /api/state[?refresh=1|<uid>] -> {serveUrl, bindHost, port, reachableHint,
//                                        accounts, intlSkipped, enterpriseSkipped, scheduler, job, stats, settings, notice?, engineErrors?}
//        enterpriseSkipped = {count, note}：被过滤掉的企业版账号数量与说明（只给数字/一句说明，
//        绝不列出任何企业版账号的 uid / 昵称 / 域名）。
//        看板地址块已按需求整块移除：页面不渲染地址块、不复制 serveUrl。
//        接口里的 serveUrl/bindHost/port/reachableHint 保留（守护进程侧兼容），
//        addrModel 纯函数仅为 tests-shell/serve-url.test.mjs 的形状校验而保留。
//        accounts[] 只含国内版（provider === "workbuddy"）；国际版不再出现在列表里。
//        intlSkipped = {count, note}：被忽略的国际版账号数量与说明（只给数字，绝不给账号内容）。
//        scheduler.holds = [{uid, nickname, releasedAt(ISO)}] —— 真正的风控冷却（403/11140）名单
//        accounts[].tasksEnabled 可写（见 /api/account/toggle）；snapshot.tasks[] 为规范化
//        camelCase：{code,title,acceptStatus,progress:{current,target},rewardCredit,rewardEnergy,
//        jumpUrl,taskType("single"|"auto"|"")} + 六个引擎判断字段（daemon.snapTask 投影自
//        engine/taskkind.resolveTaskKind，与流水线决策同一判断源）：
//        {desktopOnly,unforgeable,reason,canAccept,canLight,pinnedExpertId}
//        + 锁定三元组 {locked,lockedUntil,lockHint}：locked=true 表示现在不能接取
//        （小程序链式任务次日解锁），lockedUntil 为北京时间解锁日期，lockHint 为提示文案；
//        老后端缺这三个字段按 false/空串处理。
//        —— 任务表的所有「能不能自动化」判断只来自这些字段，前端不再自己拼规则
//        （详见下方 taskFlags）。老后端字段缺失时按 legacy 回退，绝不报错。
//        snapshot.expired 若为 true（后端将来下发）按「快照已过期」渲染；前端不发明字段。
//   GET  /api/events           -> SSE {kind:'job'|'step'|'log'|'scheduler'|'accounts'}（只读流）
//   GET  /api/history?limit=   -> {rows:[{at,uid,nickname,leg,state,detail,credit,energy,jobId,trigger}]}
//   POST /api/run {uids?,legs?,claim?,codes?} -> {job} | 409 busy | 400 无账号 | 503 引擎不可用
//        codes 可选：string[]（对所有账号）或 {[uid]: string[]}（按账号）。看板只发按 uid 的对象，
//        且只把「该账号有勾选任务」的 uid 放进去 —— 未出现的账号 = 不限制（全部任务）。
//   POST /api/stop             -> {job} | 404 没有任务在跑
//   POST /api/task/accept {uid,codes[]}   -> {accepted,already,failed}
//   POST /api/task/claim  {uid,code}      -> {ok,credit,energy,via("chat"|"web"|""),reason}
//   POST /api/checkin     {uids?}         -> [{uid,outcome,credit?,streak?,message}]
//        outcome ∈ "claimed"|"done"|"pending"|"failed"（CONTRACT §10.4，hub #596）：
//        "pending" = 上游回「处理中/请勿重复操作/系统繁忙」—— 不算成功、不落账、当天可重试，
//        看板显示「处理中，可重试」，绝不显示成「已签到」。
//   GET  /api/streak?uid=<uid>[&refresh=1]
//                                         -> {uid, cached, streak:<连登状态>|null, error?}
//        连登状态 = {ok, days, makeupCards, lotteryChances, heatmap:[{date,score}],
//        tiers:[{tier:"7d"|"14d"|"28d", status}], updatedISO}（CONTRACT §10.1）；
//        缓存 state/streak.json 新鲜期 10 分钟，refresh=1 强制拉上游（job 在跑 → 409 busy）。
//        accounts[].streak 是同一形状的只读投影（state/streak.json），没查过 = null。
//        后端尚未落地/字段缺失（undefined）时一律按 null 处理 —— 显示「未查询」，不抛错。
//   POST /api/streak/run  {uids?}         -> {results:[{uid,outcome:"ok"|"skipped"|"failed",
//                                                   earned, message, detail:{…}}]}
//        缺省/空 uids = 全部「未冻结 + tasksEnabled」账号；账号间隔 1500ms；
//        冻结账号 → outcome "failed" + 冻结提示（CONTRACT §10.2/§10.5）。
//   POST /api/account/unfreeze {uid} | {uids} -> {ok, unfrozen:[…], missing:[…]}
//        missing = 本来就没冻结（幂等）。冻结不再自动解除，只有这个接口（或看板「恢复」）能解。
//        accounts[].frozen = {at:ISO, code:number|string, message} | null；
//        顶层 frozen = [{uid, nickname, at, code, message}]（冻结总览）。
//   GET  /api/campaign?uid=<uid>[&refresh=1]
//                                         -> {uid, cached, campaign:<活动任务状态>|null, error?}
//        活动任务状态 = {ok, activities:[{code,label,page,tasks:[{taskCode,label,kind,progress,
//        target,credit,completedAt,claimedAt,needView}], claimable, claimed}], updatedISO}
//        （CONTRACT §11.1）；缓存 state/campaign.json 新鲜期 10 分钟，refresh=1 强制拉
//        （job 在跑 → 409 busy）。accounts[].campaign 是同一形状的只读投影
//        （state/campaign.json），没查过 = null。后端尚未落地/字段缺失（undefined）时一律
//        按 null 处理 —— 显示「未查询」，不抛错、不白屏。
//   POST /api/campaign/run  {uids?}       -> {results:[{uid, outcome:"ok"|"skipped"|"failed",
//                                                   earned, message, detail:{activities:[…],
//                                                   claimed:[…], unavailable:[…]}}]}
//        缺省/空 uids = 全部「未冻结 + tasksEnabled」账号；账号间隔 1500ms；
//        冻结账号 → outcome "failed" + 冻结提示（CONTRACT §11.1/§10.5）。
//        活动任务与成长任务解耦：独立跑、独立记账（成长清单为空/失败时活动照跑）。
//   POST /api/settings    (部分字段)       -> 完整 settings {scheduler,claim,legs,gapMs,hours,host}
//        hours 键集合 mp|buddy|campaign|streak|travel|night（campaign = 活动任务）；留空 = 不排程。
//   POST /api/accounts                    -> {count,eligible,added,removed}（重扫本地文件，无副作用）
//   POST /api/account/toggle {uid,tasksEnabled:bool} -> 200 该账号的最新行（accounts[] 元素同形状）
//                                            | 400/404 {error:"…"}（中文）
//   POST /api/shutdown                    -> {ok:true}（随后守护进程退出）
//   GET  /api/accounts/export?secrets=1|0&uid=a,b&download=1
//                                         -> 信封 {format:"workbuddy-accounts",version,exportedAt,count,accounts}
//        不带 realm（或非 intl）时守护进程只导出国内版；secrets=0 脱敏，缺省/1 含 token。
//        download=1 时走 Content-Disposition 附件（文件名取响应头，取不到按 hub 规则本地拼）。
//   POST /api/accounts/import   body = {"blob":<账号数据本体>,"confirm":bool}
//        预览（confirm 缺省/false）不写盘 -> {wrote:false,note,preview:{adds,updates,skips,rejects,totals}}
//        确认（confirm:true）写 plugin-auth.json（写前自动备份）-> {wrote:true,added,updated,skipped,backedUpTo,needReload,reloadHint}
//        409 needRepreview = 预览后 plugin-auth.json 被改动，要求重新预览（契约 §9.2）。
//
// 鉴权：守护进程无鉴权 —— 所有接口都直接放行，fetch 不带 Authorization、URL 不带 ?k=。
// 安全靠网络边界：默认只绑 127.0.0.1；改成 0.0.0.0 后局域网内任何人都能触发写操作，
// 页脚已如实写明。业务错误（400/404/409/503）照常按中文提示透出；SSE 断线回退轮询。
//
// 安全：服务端字符串（任务标题、detail、msg、日志、导入 reason、文件名）一律经
// textContent 进 DOM —— 本文件不使用 innerHTML 注入任何动态内容。token 永不渲染到
// 页面文本（daemon 只给 uid/昵称/掩码；导入响应经后端 planView 剥掉 token；含凭据
// 导出只落下载文件，页面只显示计数/时间/文件名）。

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---- 文案映射（领域词汇对齐 daemon/engine 与 CONTRACT） -----------------------

const LEG_NAMES = { growth: "成长任务", mp: "小程序链式任务", campaign: "活动任务", streak: "连登管家", buddy: "Buddy 盲盒", travel: "猫猫旅行", night: "夜猫子" };
const ACCEPT_NAMES = {
  not_accepted: "未接取",
  accepted: "已接取",
  completed: "已完成 · 待领奖",
  claimed: "已领奖",
};
const JOB_STATE_NAMES = { queued: "排队中", running: "运行中", done: "已完成", error: "出错" };
const STEP_STATE_NAMES = {
  pending: "等待",
  running: "进行中",
  ok: "成功",
  skip: "跳过",
  fail: "失败",
  retry: "重试",
  restricted: "风控冷却",
};
const TRIGGER_NAMES = { manual: "手动", schedule: "排程" };
// 签到回执（CONTRACT §10.4）：claimed=真领到、done=今天本来就签过、pending=上游处理中可重试、
// failed=失败。pending 不是成功，绝不显示成「已签到」。
const OUTCOME_NAMES = { claimed: "已签到", done: "今日已签", pending: "处理中，可重试", failed: "失败" };

const LS_THEME = "wbt.theme"; // 主题：localStorage 持久化

// ---- 全局状态 ------------------------------------------------------------------

const state = {
  hello: null,
  helloBusy: false, // /api/hello 首次拉取中（防并发；拿到后不再重复请求）
  conn: "checking", // checking | online | down | stopped
  feed: "idle", // sse | poll | idle
  data: null, // 最近一次 /api/state
  selected: new Set(), // 勾选的 uid
  taskSel: {}, // 任务级勾选：{ [uid]: Set(code) }（内存；跨 renderAll/快照刷新保留）
  expanded: new Set(), // 展开任务表的 uid
  toggling: new Set(), // 「参与任务」开关正在请求中的 uid（期间禁用该行开关）
  creditBusy: new Set(), // 积分查询正在请求中的 uid（期间按钮显示「查询中…」）
  creditErrors: new Map(), // uid -> {error, needRelogin}（查询失败时只放进按钮 title）
  streakBusy: new Set(), // 连登查询正在请求中的 uid（防重复并发；0.3.4 只由「刷新快照」触发）
  streakErrors: new Map(), // uid -> string：查询失败原因（显示在连登区的说明行里，不弹错）
  streakRuns: new Map(), // uid -> {ok, text}：最近一次「连登管家」结果（跨重绘保留，不静默）
  heatOpen: new Set(), // 展开连登日历的 uid（默认折叠；轮询重绘不丢状态）
  campaignBusy: new Set(), // 活动任务查询/运行正在请求中的 uid（防重复并发）
  campaignErrors: new Map(), // uid -> string：活动任务查询失败原因（显示在活动任务条里，不弹错）
  campaignRuns: new Map(), // uid -> {ok, text}：最近一次「活动任务」结果（来自 job 的 campaign 腿步骤；跨重绘保留，不静默）
  taskDoneFold: new Map(), // `${uid}::${group}` -> bool：「已完成 N 项」折叠块是否展开（默认收起；用户手动展开过则记住）
  campaignJobIds: new Map(), // uid -> jobId：本看板为某账号「跑一轮活动任务」起的 job（驱动按钮禁用 + 收尾补查活动缓存）
  streakJobId: "", // 本看板起的「连登管家」job id（收尾时把该轮 streak 腿步骤回填到各行最近一次结果）
  lastSeenJobId: "", // 最近一次在 /api/state 里看到的运行中 job id（SSE 掉线时轮询兜底判断收尾）
  unfreezing: new Set(), // 「恢复」正在请求中的 uid（期间禁用该行按钮）
  busy: false, // 批量操作进行中
  lastFinished: null, // 最近一个结束的 job（SSE 收尾广播）
  es: null,
  esRetryTimer: 0,
  pollTimer: 0,
  jobTimer: 0,
  elapsedTimer: 0, // 运行时长 1s 计时器（只改既有文本节点，不重绘 —— 见 tickElapsed）
  jobSeenAt: new Map(), // jobId -> ms：前端首次看到该 job 在跑的时刻（job.startedAt 缺失时兜底计时）
  stepSeenAt: new Map(), // `${jobId}#${idx}` -> ms：前端首次看到该步骤 running 的时刻（step.at 缺失时兜底）
  history: { rows: [], page: 0, pageSize: 25, limit: 200 },
};

// ---- DOM 小工具（所有服务端文本只走 textContent，天然免注入） --------------------

function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = String(v);
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else if (k === "dataset" && typeof v === "object") Object.assign(node.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

// SVG 版本：进度条用 <svg> + shape-rendering="crispEdges" 让边沿对齐设备像素，
// 避免不同行的小数 y 坐标导致同一 4px 高度光栅化成 5/6 设备像素。
function svgEl(tag, props, ...kids) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") node.setAttribute("class", v);
      else if (k === "text") node.textContent = String(v);
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else if (v === true) node.setAttribute(k, "");
      else node.setAttribute(k, String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

// ---- 格式化 ---------------------------------------------------------------------

function toDate(v) {
  if (v == null || v === "" || v === 0) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function fmtTime(v) {
  const d = toDate(v);
  return d ? d.toLocaleTimeString("zh-CN", { hour12: false }) : "—";
}
function fmtDateTime(v) {
  const d = toDate(v);
  if (!d) return "—";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmtNum(n) {
  const x = Number(n);
  return Number.isFinite(x) ? x.toLocaleString("zh-CN") : "—";
}
function legName(leg) {
  return LEG_NAMES[leg] ?? String(leg ?? "—");
}

// 风控冷却「解除时间」：相对（X 小时 Y 分后）+ 绝对（今天/明天/MM-DD HH:mm）
function fmtReleaseRel(d) {
  const diff = d.getTime() - Date.now();
  if (diff <= 0) return "即将解除";
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "不足 1 分后";
  if (mins < 60) return `${mins} 分后`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem ? `${hours} 小时 ${rem} 分后` : `${hours} 小时后`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days} 天 ${remH} 小时后` : `${days} 天后`;
}
function fmtReleaseAbs(d) {
  const p = (n) => String(n).padStart(2, "0");
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const dayKey = (x) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  const now = new Date();
  if (dayKey(d) === dayKey(now)) return `今天 ${hm}`;
  const tmr = new Date(now.getTime() + 86400000);
  if (dayKey(d) === dayKey(tmr)) return `明天 ${hm}`;
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
}
function fmtRelease(v) {
  const d = toDate(v);
  if (!d) return "解除时间未知";
  return `${fmtReleaseRel(d)} · ${fmtReleaseAbs(d)}`;
}

// ---- 凭据有效期（token 剩余时间） --------------------------------------------------
// daemon /api/state 账号行字段：
//   expiresInMs   剩余毫秒；API key / 无有效期 → null（新字段，毫秒精度）
//   expiresInDays Math.ceil 的天数；老守护进程只有它（2 小时也会被算成「1 天」）
// 优先用 expiresInMs 渲染人性化剩余时间；字段缺失（undefined）时按 expiresInDays
// 回退；两者都没有 → 「有效期未知」。任一字段缺失/异常都不会抛错。
// warn 色（badge-warn → --warn）规则：已过期、不足 1 小时、≤3 小时、≤3 天。

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

function fmtExpiryAbs(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())} 过期`;
}

// 纯函数：账号行 → {text, cls, title}。cls ∈ "badge-warn" | "badge-quiet" | ""；
// title = 由同一来源值算出的绝对过期时间（悬停提示），未知 → null。
// 导出仅为 Node 下单元验证；浏览器里 <script type="module"> 不受影响。
export function expiryInfo(a) {
  const ms = a?.expiresInMs;
  if (typeof ms === "number" && Number.isFinite(ms)) {
    const title = fmtExpiryAbs(Date.now() + ms);
    if (ms <= 0) return { text: "凭据已过期", cls: "badge-warn", title };
    if (ms < HOUR_MS) return { text: "不足 1 小时", cls: "badge-warn", title };
    if (ms < DAY_MS) {
      return {
        text: `剩 ${Math.floor(ms / HOUR_MS)} 小时`,
        cls: ms <= 3 * HOUR_MS ? "badge-warn" : "",
        title,
      };
    }
    return {
      text: `剩 ${Math.ceil(ms / DAY_MS)} 天`,
      cls: ms <= 3 * DAY_MS ? "badge-warn" : "",
      title,
    };
  }
  if (ms === null) return { text: "有效期未知", cls: "badge-quiet", title: null };
  // 回退：老守护进程只给 expiresInDays（null = 未知；0 = 已过期）
  const days = a?.expiresInDays;
  if (typeof days === "number" && Number.isFinite(days)) {
    const title = fmtExpiryAbs(Date.now() + days * DAY_MS);
    if (days <= 0) return { text: "凭据已过期", cls: "badge-warn", title };
    return { text: `剩 ${Math.ceil(days)} 天`, cls: days <= 3 ? "badge-warn" : "", title };
  }
  return { text: "有效期未知", cls: "badge-quiet", title: null };
}

// ---- API 层 -----------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, data) {
    super((data && typeof data.error === "string" && data.error) || `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

// 守护进程无鉴权：fetch 只带 Content-Type，不设 Authorization，URL 不带 ?k=。
async function apiOnce(path, { method = "GET", body, params } = {}) {
  const url = new URL(path, location.href);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error("连不上守护进程");
    err.network = true;
    throw err;
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

async function api(path, opts = {}) {
  return await apiOnce(path, opts);
}

// 静态文件（看板）自己的版本：读 <head> 里的 <meta name="wb-version">。
// 与守护进程 /api/hello 的 version 不同 = 插件文件更新了但老进程还在跑。
// 导出仅为 Node 下单元验证；浏览器里 <script type="module"> 不受影响。
export function staticVersion(root = typeof document !== "undefined" ? document : null) {
  const m = root?.querySelector?.('meta[name="wb-version"]');
  const v = m ? String(m.getAttribute("content") || "").trim() : "";
  return v;
}

// 「未知 API」展示层改写（0.3.4）：守护进程文件更新后端口上仍是老进程健康，
// 新路由(如 /api/streak)在老进程里一律回 404 {error:"未知 API：GET /api/xxx"}。
// 这句看着像看板坏了，其实只是没重启 —— 改写成「重启插件」的人话。
// 纪律：
//   · 这是纯展示改写，绝不改 ApiError 语义；原始 error 仍 console.error 进控制台。
//   · 后端新加的 hint 字段（响应体 {error, hint}）优先，没有 hint 时用兜底句。
//   · 文本里不含「未知 API」时原样返回（不做任何多余改动）。
const UNKNOWN_API_RE = /未知\s*API/;

// 从「未知 API：GET /api/streak」里取路径（兼容半角/全角冒号与有无 HTTP 方法）。
// 导出仅为 Node 下单元验证；浏览器里 <script type="module"> 不受影响。
export function unknownApiPath(text) {
  const m = /未知\s*API\s*[：:]\s*(?:[A-Za-z]+\s+)?(\S+)/.exec(String(text ?? ""));
  return m ? m[1] : "";
}

// 统一改写函数：所有展示错误的地方都走它（humanErr / 连登查询 / 积分查询 /
// 单账号与批量操作 / 导入导出 / 历史）。返回可直接显示的文案。
// 导出仅为 Node 下单元验证；浏览器里 <script type="module"> 不受影响。
export function humanizeApiErr(text, hint) {
  const raw = String(text ?? "");
  if (!UNKNOWN_API_RE.test(raw)) return raw;
  // 不吞错误：原始 error 打进控制台，便于分辨「真坏了」还是「只是没重启」。
  try { console.error("[看板] 接口返回原始错误（屏幕已改写为友好提示）：", raw); } catch {}
  const h = String(hint ?? "").trim();
  if (h) return h;
  const path = unknownApiPath(raw);
  return `守护进程版本落后（缺少 ${path || "该"} 接口）—— 关掉再开启本插件让它重启。`;
}

// 把异常翻译成人话（后端给的中文原样透出，绝不显示堆栈）
function humanErr(e, prefix = "操作失败") {
  if (e instanceof ApiError) {
    if (e.status === 409) {
      toast("已有批量任务在跑：同一时刻只允许一个 job。等它结束，或先点「停止当前任务」。", "warn", 7000);
      return;
    }
    toast(`${prefix}（HTTP ${e.status}）：${humanizeApiErr(e.message, e.data?.hint)}`, "warn", 8000);
    return;
  }
  if (e && e.network) {
    state.conn = "down";
    renderTop();
    toast("连不上守护进程：它可能已停止。可在 magpie 里重开本插件自动拉起，或用顶栏「启动命令」手动启动。", "warn", 9000);
    return;
  }
  toast(`${prefix}：${humanizeApiErr(e && e.message ? e.message : String(e))}`, "warn", 8000);
}

// ---- 主题（默认跟随系统；显式选择持久化到 localStorage） -----------------------------

function themePref() {
  try {
    return localStorage.getItem(LS_THEME) || "auto";
  } catch {
    return "auto";
  }
}
function applyTheme() {
  const p = themePref();
  const root = document.documentElement;
  if (p === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", p);
  const name = p === "auto" ? "跟随系统" : p === "dark" ? "深色" : "浅色";
  const glyph = $("#themeGlyph");
  const label = $("#themeLabel");
  const btn = $("#themeBtn");
  if (glyph) glyph.textContent = p === "auto" ? "◐" : p === "dark" ? "☾" : "☀";
  if (label) label.textContent = `主题：${name}`;
  if (btn) {
    btn.title = `主题：${name}（点击切换）`;
    btn.setAttribute("aria-label", `切换主题，当前${name}`);
  }
}
function cycleTheme() {
  const order = ["auto", "light", "dark"];
  const next = order[(order.indexOf(themePref()) + 1) % order.length];
  try {
    localStorage.setItem(LS_THEME, next);
  } catch {}
  applyTheme();
}

// ---- Toast -----------------------------------------------------------------------------

function toast(msg, kind = "info", ms = 5200) {
  const box = $("#toasts");
  if (!box) return;
  while (box.children.length >= 4) box.firstChild.remove();
  const t = el("div", { class: kind === "warn" ? "toast toast-warn" : "toast", text: msg });
  box.append(t);
  setTimeout(() => t.remove(), ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  try {
    const ta = el("textarea", { style: { position: "fixed", top: "0", left: "0", opacity: "0" } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// ---- 顶栏渲染 -----------------------------------------------------------------------------

// ---- addrModel（兼容保留；页面不再渲染任何看板地址） ---------------------------------------
// 看板地址块已整块移除：页面不显示地址、不提供复制按钮，也不把地址写进 title。
// 这个纯函数保留下来只为 tests-shell/serve-url.test.mjs 继续校验 serveUrl 的形状
// （http(s)://host[:port]/，绝不含 0.0.0.0/::/*）与老后端兜底逻辑。
// 导出仅为 Node 下单元验证；浏览器里 <script type="module"> 不受影响。

const DEFAULT_PORT = 4390;
// serveUrl 形状防御：http(s) + 主机字面量（字母数字 . - _ []）+ 可选端口 + 结尾 /。
// 不收 @（userinfo）、?、#、空白等——老后端/异常值一律不采用，走原有兜底。
const SERVE_URL_RE = /^https?:\/\/[\w.\-\[\]]+(:\d{1,5})?\/$/;

function isWildcardBind(host) {
  return host === "0.0.0.0" || host === "::";
}
function hostForUrl(host) {
  return host.includes(":") ? `[${host}]` : host; // IPv6 字面量要加方括号
}

// 纯函数：/api/state payload → {mode, url, port, hint, bindHost, docker}。
export function addrModel(d) {
  const rawPort = Number(d?.port);
  const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : null;
  const bindHost = typeof d?.bindHost === "string" && d.bindHost.trim() ? d.bindHost.trim() : "";
  const hint = typeof d?.reachableHint === "string" ? d.reachableHint.trim() : null;
  const served = typeof d?.serveUrl === "string" ? d.serveUrl.trim() : "";
  if (SERVE_URL_RE.test(served)) {
    return { mode: "served", url: served, port, hint: hint || "", bindHost, docker: bindHost === "0.0.0.0" };
  }
  if (port == null || !bindHost || hint == null) {
    let url = "";
    try {
      if (typeof location !== "undefined" && (location.protocol === "http:" || location.protocol === "https:")) {
        url = `${location.origin}/`;
      }
    } catch {}
    return { mode: "fallback", url: url || `http://127.0.0.1:${DEFAULT_PORT}/`, port, hint: "", bindHost, docker: false };
  }
  if (hint || isWildcardBind(bindHost)) {
    return {
      mode: "wildcard",
      url: `http://<本机可达地址>:${port}/`,
      port,
      hint,
      bindHost,
      docker: bindHost === "0.0.0.0",
    };
  }
  return { mode: "loopback", url: `http://${hostForUrl(bindHost)}:${port}/`, port, hint: "", bindHost, docker: false };
}

function jobMentionsRisk(job) {
  if (!job) return false;
  const inSteps = (job.steps || []).some((s) => /风控|restricted/i.test(String(s.detail ?? "")));
  const inLogs = (job.log || []).some((l) => /风控|restricted/i.test(String(l)));
  return inSteps || inLogs;
}

// 顶栏「风控冷却」判定：以 scheduler.holds（daemon 给的真实冷却名单）为准；
// 只有老守护进程没给 holds 字段时才退回日志文本推断。
function holdsActive() {
  const holds = state.data?.scheduler?.holds;
  if (Array.isArray(holds)) return holds.length > 0;
  return jobMentionsRisk(state.data?.job);
}

function renderTop() {
  const pill = $("#daemonPill");
  pill.className = "pill";
  if (state.conn === "checking") {
    pill.classList.add("pill-quiet");
    pill.textContent = "检查中…";
  } else if (state.conn === "stopped") {
    pill.classList.add("pill-off");
    pill.textContent = "已停止";
  } else if (state.conn === "down") {
    pill.classList.add("pill-off");
    pill.textContent = "已停用（连不上）";
  } else if (holdsActive()) {
    pill.classList.add("pill-warn");
    pill.textContent = "风控冷却";
  } else {
    pill.classList.add("pill-ok");
    pill.textContent = "运行中";
  }

  const feed = $("#feedPill");
  feed.className = "pill";
  if (state.conn === "stopped" || state.conn === "down") {
    feed.classList.add("pill-off");
    feed.textContent = "已断开";
  } else if (state.feed === "sse") {
    feed.classList.add("pill-quiet");
    feed.textContent = "实时 · SSE";
  } else if (state.feed === "poll") {
    feed.classList.add("pill-warn");
    feed.textContent = "轮询 · 3s";
  } else {
    feed.classList.add("pill-quiet");
    feed.textContent = "连接中…";
  }

  const st = state.data?.stats;
  $("#statCredits").textContent = st ? fmtNum(st.creditsToday) : "—";
  $("#statEnergy").textContent = st ? fmtNum(st.energyToday) : "—";
  $("#statRuns").textContent = st ? fmtNum(st.runs) : "—";

  const sub = $("#brandSub");
  if (state.hello) {
    sub.textContent = `看板 · v${state.hello.version}${state.hello.ready ? "" : " · 引擎未就绪"}`;
  }
}

// ---- 账号区 -------------------------------------------------------------------------------

function eligibleAccounts() {
  return (state.data?.accounts ?? []).filter((a) => a.eligible);
}
function targetAccounts() {
  const list = eligibleAccounts();
  if (!state.selected.size) return list;
  return list.filter((a) => state.selected.has(a.uid));
}
function accountByUid(uid) {
  return (state.data?.accounts ?? []).find((a) => a.uid === uid) ?? null;
}

function badge(text, cls = "") {
  return el("span", { class: cls ? `badge ${cls}` : "badge", text });
}

function acceptBadge(st) {
  const name = ACCEPT_NAMES[st] ?? (st == null || st === "" ? "未知" : String(st));
  let cls = "";
  if (st === "completed") cls = "badge-warn";
  else if (st === "claimed") cls = "badge-quiet";
  else if (st === "accepted") cls = "badge-strong";
  return badge(name, cls);
}

function stepBadge(st) {
  const name = STEP_STATE_NAMES[st] ?? String(st ?? "—");
  let cls = "";
  if (st === "fail" || st === "skip" || st === "restricted") cls = "badge-warn";
  else if (st === "ok") cls = "badge-strong";
  else if (st === "pending") cls = "badge-quiet";
  return badge(name, cls);
}

function progressCell(prog) {
  const cur = Number(prog?.current) || 0;
  const tgt = Number(prog?.target) || 0;
  const pct = tgt > 0 ? Math.min(100, Math.round((cur / tgt) * 100)) : cur > 0 ? 100 : 0;
  return el(
    "div",
    { class: "prog-cell" },
    el(
      "div",
      {
        class: "prog",
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": String(tgt),
        "aria-valuenow": String(cur),
        "aria-label": `进度 ${cur}/${tgt}`,
      },
      el("div", { class: "prog-fill", style: { width: `${pct}%` } }),
    ),
    el("span", { class: "prog-text", text: tgt > 0 ? `${cur}/${tgt}` : `${cur}` }),
  );
}

function rewardCell(t) {
  const c = Number(t.rewardCredit) || 0;
  const e = Number(t.rewardEnergy) || 0;
  const parts = [];
  if (c > 0) parts.push(`+${fmtNum(c)} 积分`);
  if (e > 0) parts.push(`+${fmtNum(e)} 能量`);
  return el("span", { class: "mono", text: parts.length ? parts.join(" · ") : "—" });
}

// ---- 任务判断字段（P0-2：只消费 daemon 下发的六个字段，前端不自己拼规则） --------------
// daemon.snapTask 把引擎判断（engine/taskkind.resolveTaskKind）投影进 snapshot.tasks[]：
//   desktopOnly    true = 只能在本机桌面 App 完成（伪造事件不推进、领奖必失败）
//   unforgeable    true = 根本无法自动化（关注公众号满 24 小时、真实捐赠，以及未收录任务）
//   reason         unforgeable / desktopOnly 的人话原因（可为空串）
//   canAccept      true = 能进「批量接取」（引擎口径，已排除 auto / unforgeable / 未收录）
//   canLight       true = 能被自动化点亮（上报进度事件）
//   pinnedExpertId 非空 = 事件 id 钉死该专家（ex_…）；空串 = 走池子轮换
//   locked         true = 现在不能接取（小程序链式任务次日解锁）；lockedUntil / lockHint 是
//                  解锁日期（北京时间 YYYY-MM-DD）与提示文案。老后端没有这三个字段时按
//                  false / 空串处理 —— 锁定只影响接取与勾选，不影响 completed 领奖。
// 纪律：**绝不**拿 jumpUrl 形状猜「需桌面端完成」—— 真实账号 19 项 jumpUrl 全部非空
// （14 项 workbuddy:// 深链、5 项 https），其中只有 3 项真是桌面端专属。
// 老后端（六个字段 undefined）→ legacy 回退：不显示桌面端 / 无法自动化标注，接取按钮照旧
// 按状态显示（由后端 400/404 兜底），绝不禁用整列。
// 导出仅为 Node 下单元验证；浏览器里 <script type="module"> 不受影响。
export function taskFlags(t) {
  const isBool = (k) => typeof t?.[k] === "boolean";
  const code = String(t?.code ?? "");
  const status = String(t?.acceptStatus ?? "");
  const unforgeable = t?.unforgeable === true;
  return {
    // 后端给了任一新判断字段 = 新口径；否则整行按 legacy 渲染
    modern: isBool("desktopOnly") || isBool("unforgeable") || isBool("canAccept") || isBool("canLight"),
    desktopOnly: t?.desktopOnly === true,
    unforgeable,
    reason: String(t?.reason ?? "").trim(),
    // canLight 用 null 表示「老后端没给」——与 false（引擎判定不点亮）语义分开
    canLight: isBool("canLight") ? t.canLight === true : null,
    // 接取门控：新后端只认 canAccept（再兜一层缺码 / unforgeable 守卫）；
    // 老后端回退旧口径 not_accepted && 非 auto && 有 code
    canAccept: isBool("canAccept")
      ? t.canAccept === true && code !== "" && !unforgeable
      : status === "not_accepted" && t?.taskType !== "auto" && code !== "",
    pinnedExpertId: String(t?.pinnedExpertId ?? "").trim(),
    // 排程/接取锁定：只读后端真值字段，老后端缺字段 = 不锁定
    locked: t?.locked === true,
    lockedUntil: String(t?.lockedUntil ?? "").trim(),
    lockHint: String(t?.lockHint ?? "").trim(),
  };
}

// 微信小程序任务识别（纯展示：只决定任务行「小程序」徽章，不参与勾选 / 接取 / 领奖门控）。
// MP 专属任务码口径与 engine/miniprogram.mjs 的 isMPCode 一致：Sequential_Tasks_ 前缀，
// 或校园日 school_season。后端把 MP-only 任务并入快照后，前端据此标注执行通道。
// 显式排除 Sequential_Tasks_7：它在 engine/constants.mjs 的 TASK_SPECS 里是
// kind:"playbook"（PC 灵感功能），不走小程序链路。前端不引 constants，故此码在此硬编码排除，
// 与后端 isMPCode「前缀命中但在 TASK_SPECS 里就不算 MP」的口径对齐。
// 导出仅为 Node 下单元验证；浏览器里 <script type="module"> 不受影响。
export function isMPTask(t) {
  const code = String(t?.code ?? "");
  if (code === "Sequential_Tasks_7") return false;
  return code === "school_season" || code.startsWith("Sequential_Tasks_");
}

// 领奖门控（维持既有口径）：acceptStatus==="completed"，或进度已达标（current>=target>0）。
// 已领奖（claimed）的不再给按钮 —— 真实快照里 11 项 claimed 都是 1/1，不排除会长出
// 11 个必然失败的按钮。缺码不在这里挡：真正要 POST 的调用方再过滤（行内按钮 / 批量 codes）。
export function claimableTask(t) {
  const status = String(t?.acceptStatus ?? "");
  if (status === "completed") return true;
  if (status === "claimed") return false;
  const cur = Number(t?.progress?.current) || 0;
  const tgt = Number(t?.progress?.target) || 0;
  return tgt > 0 && cur >= tgt;
}

// 快照过期语义：snapshot === null → 「快照为空」；后端将来下发 snapshot.expired === true
// 也按过期处理。只认后端真值字段，前端不发明 expiredAt / stale 之类。
export function snapExpired(snap) {
  return snap?.expired === true;
}

// pinnedExpertId 是次要信息：短串展示（等宽、--ink3），全值走 title。
function pinShort(id) {
  const s = String(id ?? "");
  return s.length > 18 ? `${s.slice(0, 17)}…` : s;
}

// jumpUrl 只决定「用什么方式打开」，不决定任务性质：
//   非 http(s) 深链（workbuddy://…）浏览器打不开 → 只给「复制深链」
//   http(s) → 「打开链接」
// 「需在桌面端完成」徽章由 desktopOnly 字段单独负责（见 taskRow）。
function jumpCell(t) {
  const url = String(t.jumpUrl ?? "");
  if (!url) return el("span", { class: "muted", text: "—" });
  if (!/^https?:/i.test(url)) {
    return el("button", {
      type: "button",
      class: "mini-btn",
      text: "复制深链",
      title: `${url}（浏览器打不开自定义协议，复制到本机桌面 App 用）`,
      onclick: async (ev) => {
        const ok = await copyText(url);
        toast(ok ? `深链已复制：${url}` : `复制失败，请手动复制：${url}`, ok ? "info" : "warn", 7000);
        ev.target.blur();
      },
    });
  }
  return el(
    "a",
    { href: url, target: "_blank", rel: "noopener noreferrer", class: "mini-btn", text: "打开链接" },
  );
}

async function acceptOne(uid, code, btn) {
  btn.disabled = true;
  btn.textContent = "接取中…";
  try {
    const r = await api("api/task/accept", { method: "POST", body: { uid, codes: [code] } });
    const accepted = (r?.accepted ?? []).length;
    const already = (r?.already ?? []).length;
    const f0 = (r?.failed ?? [])[0];
    const reason = typeof f0 === "string" ? f0 : f0?.reason;
    let text;
    let cls;
    if (accepted > 0) {
      text = "已接取";
      cls = "badge-strong";
    } else if (already > 0) {
      text = "早已接取";
      cls = "badge-quiet";
    } else {
      text = `未接取：${reason || "上游未说明原因"}`;
      cls = "badge-warn";
    }
    btn.replaceWith(badge(text, cls));
    toast(`${code}：${text}`, cls === "badge-warn" ? "warn" : "info");
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "接取";
    humanErr(e, "接取失败");
  }
}

async function claimOne(uid, code, btn) {
  btn.disabled = true;
  btn.textContent = "领奖中…";
  try {
    const r = await api("api/task/claim", { method: "POST", body: { uid, code } });
    // via:"web" = 桌面端通道被拒、网页兜底成功 —— 低调标注一下
    const viaNote = r?.via === "web" ? " · 已走网页通道" : "";
    const okBadge = r?.ok
      ? badge(`已领奖 +${fmtNum(r.credit)} 积分${Number(r.energy) > 0 ? ` +${fmtNum(r.energy)} 能量` : ""}${viaNote}`, "badge-strong")
      : badge(`未领到：${r?.reason || "上游未说明原因"}`, "badge-warn");
    btn.replaceWith(okBadge);
    toast(r?.ok ? `领奖成功：+${fmtNum(r.credit)} 积分${viaNote}` : `领奖未成功：${r?.reason || "见任务行提示"}`, r?.ok ? "info" : "warn");
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "领奖";
    humanErr(e, "领奖失败");
  }
}

// ---- 任务级勾选（只收窄批量操作，不影响单任务「接取 / 领奖」按钮） -----------------
// state.taskSel = { [uid]: Set(code) }：按账号保存勾选的任务码，只存在内存里（UI 仍按账号勾选）。
// · 跨 renderAll()/快照刷新保留；某账号的集合清空时删掉该键。
// · 无 code 的行不可勾选（无从提交）；locked === true 的行（小程序链式任务次日解锁）
//   同样不可勾选，且不计入「全选 / 已选 N 项」。
// · 勾选不影响 buddy / travel / night 腿（它们没有任务码）；小程序链式任务随 growth 腿内嵌执行。
// · 2026-11-14 起：勾选 = 本轮 job 的【全局任务范围】—— 只要任一账号有勾选，就把所有账号勾选的
//   并集下发给每个目标账号（见 pickedUnion）；完全无勾选才回落到「未勾选 = 全部任务」。

function pickedSet(uid) {
  return state.taskSel[uid] ?? null;
}

function isPicked(uid, code) {
  const set = pickedSet(uid);
  return !!set && set.has(String(code ?? ""));
}

// 快照里仍可勾选的任务：有 code 且未锁定（locked 只来自后端字段，老后端 = false）；
// 再加上活动任务的可勾选码（CONTRACT §11.6：活动任务行与成长/小程序任务共用同一套勾选 state）。
function selectableCodes(a) {
  const tasks = Array.isArray(a?.snapshot?.tasks) ? a.snapshot.tasks : [];
  const snap = tasks.filter((t) => !taskFlags(t).locked).map((t) => String(t?.code ?? "")).filter(Boolean);
  return [...snap, ...campaignPickCodes(a)];
}

// 活动任务行的勾选码 = `<activityCode>:<taskCode>`（CONTRACT §11.6）。
// 已领（claimedAt 非空）的活动任务没有可跑的动作，不给码、也不可勾选；缺 activityCode / taskCode 的项同样跳过。
// 活动状态来自 accounts[].campaign 投影（§11.1），没查过 / 后端未落地时为 []，不抛错。
function campaignPickCodes(a) {
  const out = [];
  for (const act of campaignActivities(campaignOf(a))) {
    const ac = String(act?.code ?? "").trim();
    if (!ac) continue;
    for (const t of Array.isArray(act?.tasks) ? act.tasks : []) {
      const tc = String(t?.taskCode ?? "").trim();
      if (tc && !campaignTaskClaimed(t)) out.push(`${ac}:${tc}`);
    }
  }
  return out;
}

// 勾选的全局并集（跨所有账号）—— 「勾选 = 本轮 job 的全局任务范围」的唯一来源：
// 批量做任务 / 批量接任务 / 只领奖 三个入口都从这里取范围，别再各写一套（用户 2026-11-14）。
// 语义（用户明确确认，勿当 bug）：账号 A 勾 A、账号 B 勾 B → 两个目标账号都做 A+B（并集）；
// 无任何勾选 → 空集，各入口回落到「未勾选 = 全部任务」的老口径。
function pickedUnion() {
  const out = new Set();
  const all = state.taskSel ?? {};
  for (const uid of Object.keys(all)) {
    const set = all[uid];
    if (set && set.size) for (const c of set) out.add(String(c));
  }
  return out;
}

// 快照刷新后把已选集合里「已锁定」的任务码剔除（只剔这些，不动用户其它勾选）。
// 没有快照可比对时什么都不做。
function pruneLockedPicks(uid) {
  const set = pickedSet(uid);
  if (!set || !set.size) return;
  const a = accountByUid(uid);
  const tasks = Array.isArray(a?.snapshot?.tasks) ? a.snapshot.tasks : null;
  if (!tasks) return;
  const locked = new Set(
    tasks.filter((t) => taskFlags(t).locked).map((t) => String(t?.code ?? "")).filter(Boolean),
  );
  if (!locked.size) return;
  let changed = false;
  for (const c of [...set]) {
    if (locked.has(c)) {
      set.delete(c);
      changed = true;
    }
  }
  if (changed && !set.size) delete state.taskSel[uid];
}

// 「已选 N 项」只数当前快照里真实存在的任务码；没有快照时才退回集合大小
function pickedVisibleCount(uid) {
  const set = pickedSet(uid);
  if (!set || !set.size) return 0;
  const avail = selectableCodes(accountByUid(uid));
  if (!avail.length) return set.size;
  let n = 0;
  for (const c of avail) if (set.has(c)) n++;
  return n;
}

function setPicked(uid, code, on) {
  const c = String(code ?? "");
  if (!c) return;
  let set = state.taskSel[uid];
  if (on) {
    if (!set) set = state.taskSel[uid] = new Set();
    set.add(c);
  } else if (set) {
    set.delete(c);
    if (!set.size) delete state.taskSel[uid];
  }
  updateTaskSelUI(uid);
}

function setPickedAll(uid, on) {
  const codes = selectableCodes(accountByUid(uid));
  if (on && codes.length) state.taskSel[uid] = new Set(codes);
  else delete state.taskSel[uid];
  updateTaskSelUI(uid);
}

function taskAllBoxes(uid) {
  return $$("input[data-task-all]").filter((i) => i.dataset.taskAll === uid);
}
function taskRowBoxes(uid) {
  return $$("input[data-task-pick]").filter((i) => i.dataset.taskPick === uid);
}

// 同步某账号的勾选控件（行 checkbox / 表头与提示条的「全选」/ 已选计数），不整页重绘
function updateTaskSelUI(uid) {
  // 快照刷新后锁定的任务码从内存勾选里剔除（只剔锁定项，其它勾选保持原样）
  pruneLockedPicks(uid);
  const set = pickedSet(uid);
  const avail = selectableCodes(accountByUid(uid));
  const availSet = new Set(avail);
  for (const cb of taskRowBoxes(uid)) {
    const c = String(cb.dataset.code ?? "");
    // 锁定 / 缺码的勾选框显示为未选（DOM 里已 disabled）
    cb.checked = availSet.has(c) && !!set && set.has(c);
  }
  const n = pickedVisibleCount(uid);
  for (const box of taskAllBoxes(uid)) {
    box.checked = avail.length > 0 && n >= avail.length;
    box.indeterminate = n > 0 && n < avail.length;
    box.disabled = avail.length === 0;
  }
  for (const bar of $$("[data-task-sel-bar]").filter((b) => b.dataset.taskSelBar === uid)) {
    const out = $(".task-sel-count", bar);
    if (out) out.textContent = `已选 ${n} 项`;
  }
  updateTaskSelNote();
}

// 批量条上的全局提示：有任何任务级勾选时显示
// 「已选 N 项任务 · 本轮所有目标账号只做这些」。N = 勾选并集（跨账号去重），
// 与真正下发给每个目标账号的 codes 一致；勾选生效时绝不静默。
function updateTaskSelNote() {
  const box = $("#taskSelSummary");
  if (!box) return;
  const n = pickedUnion().size;
  box.textContent = n ? `已选 ${n} 项任务 · 本轮所有目标账号只做这些` : "";
  box.hidden = n === 0;
}

// 批量请求的 codes 形状：{ [uid]: string[] }（后端形状不变，仍是按 uid 的对象）。
// 2026-11-14 语义：勾选 = 全局范围 —— 任一账号有勾选 → 每个目标账号都带同一份并集；
// 完全无勾选 → {}（不提交 codes，保持「未勾选 = 全部任务」的老口径）。
function selectionBody(accounts) {
  const union = pickedUnion();
  if (!union.size) return {};
  const codes = [...union];
  const out = {};
  for (const a of accounts) out[a.uid] = codes.slice();
  return out;
}

// 表格上方的短提示条：全选 + 说明 + 已选计数（窄屏 thead 被隐藏时也能全选）
function taskSelBar(uid) {
  return el(
    "div",
    { class: "task-sel-bar", dataset: { taskSelBar: uid } },
    el(
      "label",
      { class: "check task-sel-all", title: "勾选 / 取消该账号的全部任务" },
      el("input", {
        type: "checkbox",
        dataset: { taskAll: uid },
        "aria-label": "全选该账号任务",
        onchange: (ev) => setPickedAll(uid, ev.target.checked),
      }),
      el("span", { text: "全选" }),
    ),
    el("span", { class: "task-sel-hint", text: "勾选 = 本轮所有目标账号只做选中任务（取并集）；不勾选 = 全部" }),
    el("span", { class: "task-sel-count", text: "已选 0 项" }),
  );
}

// 单行任务（2026-11-13 重做为清单行 .trow：div 网格六格 —— 勾选 | 主 | 状态 | 进度 | 奖励 | 操作；
// 不再是 <table> 里的六列，见 style.css 的 .trow）。所有「能不能自动化」的标注与门控都来自
// taskFlags（后端字段），服务端字符串（title / code / reason / id）一律走 textContent。
function taskRow(a, t) {
  const code = String(t.code ?? "");
  const f = taskFlags(t);
  const status = String(t.acceptStatus ?? "");
  const isAuto = t.taskType === "auto";
  const actions = el("div", { class: "row-actions" });
  // 锁定提示：后端锁定说明优先，缺省给一句通用文案（老后端 locked 恒 false，不会走到这里）
  const lockText = f.lockHint || "到第二天才能接取任务";

  // 接取：锁定行不在这里输出任何提示（锁文案只在任务列渲染：row-note / 「次日可接取」徽章 /
  // 勾选框 title，见下方 lockNote）——操作列对锁定行只留 jumpCell(t)。
  // 锁定行一律不显示「接取」按钮（即使老数据里 canAccept 仍为 true）；
  // 非锁定行仅当后端 canAccept === true（老后端回退旧口径，见 taskFlags）
  if (!f.locked && f.canAccept) {
    actions.append(
      el("button", {
        type: "button",
        class: "mini-btn",
        text: "接取",
        title: f.desktopOnly
          ? "可以接取，但引擎不会为它伪造进度：需在本机桌面 App 完成后再领奖"
          : null,
        onclick: (ev) => acceptOne(a.uid, code, ev.target),
      }),
    );
  } else if (isAuto && (status === "not_accepted" || status === "accepted")) {
    // taskType:"auto"：上游拒绝接取，不给「接取」按钮
    actions.append(el("span", { class: "muted", text: "自动任务，无需接取" }));
  } else if (f.unforgeable && status === "not_accepted") {
    // unforgeable：不能自动接取/上报进度，但上游完成后可以手动领奖。
    // 只在「未接取」时提示；accepted / completed / claimed 不再显示这条，避免噪音。
    actions.append(
      el("span", {
        class: "muted",
        text: "不参与自动做任务",
        title: "完成后仍可点「领奖」；自动做任务/上报进度不可用",
      }),
    );
  } else if (status === "not_accepted" && code === "") {
    // 窄守卫：快照真缺任务码时才提示（规范化后的快照 code 恒非空）
    actions.append(el("span", { class: "muted", text: "快照缺任务码，无法接取" }));
  } else if (status === "not_accepted" && f.modern && !f.locked) {
    // 引擎判定现在不能接（已接过 / 未收录 / 桌面端族）—— 不静默，给一句说明。
    // 锁定行排除在外：锁文案已由任务列承担，这里再放一句就是重复（reason 为空时还会退化成
    // 「引擎判定不可自动接取」，对锁定行是误导）。
    actions.append(el("span", { class: "muted", text: f.reason || "引擎判定不可自动接取" }));
  }

  // 领奖：维持既有条件（completed，或进度已达标；claimed 不再给按钮）。
  // 缺码不给按钮（无从 POST）—— 缺码守卫在调用方，不在 claimableTask 里。
  if (claimableTask(t) && code !== "") {
    actions.append(
      el("button", {
        type: "button",
        class: "mini-btn",
        text: "领奖",
        onclick: (ev) => claimOne(a.uid, code, ev.target),
      }),
    );
  } else if (status === "completed" && code === "") {
    actions.append(el("span", { class: "muted", text: "快照缺任务码，改用「批量做任务」" }));
  }

  // 规则 3：canLight === false 且既非桌面端也非不可自动化 → 没有「点亮」类操作可给，
  // 说明原因（reason 原文优先）。已领奖 / 已锁定的行不再堆提示。
  if (f.canLight === false && !f.desktopOnly && !f.unforgeable && !f.locked && status !== "claimed") {
    actions.append(
      el("span", {
        class: "muted",
        text: f.reason || "引擎暂不点亮这项",
        title: f.reason || "守护进程判定 canLight=false：引擎不会为这项上报进度事件（状态变化后会重新判定）",
      }),
    );
  }

  actions.append(jumpCell(t));

  // 任务列标注：小程序徽章 ⇐ code 命中 MP 口径（Sequential_Tasks_ 前缀 / school_season）；
  // 锁定徽章 ⇐ locked === true；桌面端徽章 ⇐ desktopOnly === true；
  // 无法自动化徽章 ⇐ unforgeable === true（附 reason 原文）；
  // pinnedExpertId 非空时给一个等宽短串（次要信息，全值在 title）。
  // 「不可自动化 / 需桌面端」的原因两条来源说的是同一件事（例：skill_share 的 reason
  // 「需电脑端 5.9.0+ 的技能详情页用「分享」发给好友」 vs description 上游原文「升级到电脑端
  // 至5.9.0或以上…」），同一行渲染两遍就是重复。规则：**description 非空只显示它**（上游原文
  // 信息更全），reason 收进徽章 title；description 为空时才退回显示 reason。
  const banner = f.unforgeable || f.desktopOnly;
  const descNote = banner ? String(t.description ?? "").trim() : "";
  const bannerReason = banner ? f.reason : "";
  const reasonInTitle = descNote && bannerReason ? `\n上游说明：${bannerReason}` : "";

  const marks = [];
  if (isMPTask(t)) {
    const b = badge("小程序", "badge-quiet");
    b.title = "通过微信小程序埋点链路执行";
    marks.push(b);
  }
  if (f.locked) {
    const b = badge("次日可接取", "badge-warn");
    b.title = lockText;
    marks.push(b);
  }
  if (f.desktopOnly) {
    const b = badge("需在桌面端完成", "badge-warn");
    b.title = `引擎判定：伪造事件不推进、领奖必失败，只能在本机桌面 App 完成${reasonInTitle}`;
    marks.push(b);
  }
  if (f.unforgeable) {
    const b = badge("无法自动化", "badge-warn");
    b.title = `引擎判定：不能自动接取/上报进度；完成后仍可在看板手动领奖${reasonInTitle}`;
    marks.push(b);
  }
  if (f.pinnedExpertId) {
    marks.push(
      el("span", {
        class: "pin-id",
        text: pinShort(f.pinnedExpertId),
        title: `事件 id 钉死该专家：${f.pinnedExpertId}`,
      }),
    );
  }
  // 行说明只留一条：description 非空时它就是唯一说明（reason 已在徽章 title 里），
  // 为空才退回 reason —— 两行不会再说同一件事。
  const reasonNote = descNote ? "" : bannerReason;
  // 锁定行在任务标题下给可见提示（不只放 title）；上游原文说明单独占一行
  const lockNote = f.locked ? lockText : "";
  const pickTitle = f.locked
    ? lockText
    : code
      ? "勾选后批量操作只作用于选中任务；不勾选 = 全部"
      : "快照缺任务码，无法勾选";
  const pickAria = f.locked
    ? `任务已锁定：${lockText}`
    : code
      ? `选择任务 ${String(t.title ?? code)}`
      : "该任务无任务码，无法勾选";

  return el(
    "div",
    { class: "trow", role: "listitem" },
    el(
      "div",
      { class: "trow-pick" },
      el(
        "label",
        { class: "check", title: pickTitle },
        el("input", {
          type: "checkbox",
          dataset: { taskPick: a.uid, code },
          checked: !f.locked && !!code && isPicked(a.uid, code),
          disabled: !code || f.locked,
          "aria-label": pickAria,
          onchange: (ev) => setPicked(a.uid, code, ev.target.checked),
        }),
      ),
    ),
    el(
      "div",
      { class: "trow-main" },
      el("span", { class: "trow-title", text: String(t.title ?? code ?? "（无标题）") }),
      code ? el("span", { class: "trow-code", text: code }) : null,
      marks.length ? el("div", { class: "cell-badges" }, marks) : null,
      lockNote ? el("div", { class: "row-note", text: lockNote }) : null,
      reasonNote ? el("div", { class: "row-note", text: reasonNote }) : null,
      descNote ? el("div", { class: "row-note row-desc", text: descNote, title: descNote }) : null,
    ),
    el("div", { class: "trow-status" }, acceptBadge(status)),
    el("div", { class: "trow-prog" }, progressCell(t.progress)),
    el("div", { class: "trow-reward" }, rewardCell(t)),
    el("div", { class: "trow-act" }, actions),
  );
}

// 只读刷新的说明：刷新快照只读取上游，不会接取任务也不会上报进度。
const REFRESH_NOTE = "点账号行右侧「刷新快照」读取（只读，不会接取或上报；守护进程内置限速：两次上游调用至少间隔 1 秒）。";

// 一张任务明细、三个来源分组（CONTRACT §11.6）：成长任务 → 小程序任务 → 活动任务。
// 分组按来源拆分（成长 = 快照里非 MP code；小程序 = isMPTask()；活动 = accounts[].campaign 投影），
// 各分组标题带计数、**恒展开、不可折叠**（纯标题头，无 <details>/折叠箭头/点击行为）。
// 组内「未完成在上、已领奖沉底」：已领奖的任务收进一个默认收起的「已完成 N 项」<details>，
// 用户手动展开过就记住（state.taskDoneFold）。空分组不渲染标题（否则会满屏空壳）。
function taskTable(a) {
  const snap = a.snapshot;
  const tasks = Array.isArray(snap?.tasks) ? snap.tasks : [];
  // 活动任务来自 accounts[].campaign 投影（§11.1）：没查过 / 后端未落地 = []（不显示该分组）
  const campaignActs = campaignActivities(campaignOf(a));

  const groups = [];
  const growth = tasks.filter((t) => !isMPTask(t));
  const mp = tasks.filter((t) => isMPTask(t));
  if (growth.length) groups.push({ key: "growth", title: "成长任务", type: "snap", tasks: growth });
  if (mp.length) groups.push({ key: "mp", title: "小程序任务", type: "snap", tasks: mp });
  // 活动分组只在真有活动任务行时出现（活动存在但一个任务都没有 = 空壳，不显示空标题）
  const campaignTaskTotal = campaignActs.reduce((n, act) => n + (Array.isArray(act?.tasks) ? act.tasks.length : 0), 0);
  if (campaignTaskTotal) groups.push({ key: "campaign", title: "活动任务", type: "campaign", acts: campaignActs });

  const wrap = el("div", { class: "task-sel-wrap" });
  // 任务级勾选提示条始终最上方（跨三个分组）：说明「不勾选 = 全部」，并显示已选计数
  wrap.append(taskSelBar(a.uid));

  if (!groups.length) {
    wrap.append(el("p", { class: "muted", style: { padding: "10px 20px" } }, emptyTaskText(snap)));
    return wrap;
  }
  // 后端标记过期：数据仍展示（比空白有用），但明确说明陈旧并给只读刷新入口
  if (snap && snapExpired(snap)) {
    wrap.append(
      el("p", { class: "snap-stale", text: `快照已过期（${fmtDateTime(snap.updatedISO)} 更新），${REFRESH_NOTE}` }),
    );
  }
  for (const g of groups) wrap.append(taskGroupBlock(a, g));
  return wrap;
}

// 无任何任务时的说明文案（快照为空 / 过期 / 真的没任务），与旧口径一致。
function emptyTaskText(snap) {
  if (!snap) return `快照为空，${REFRESH_NOTE}`;
  if (snapExpired(snap)) return `快照已过期（${fmtDateTime(snap.updatedISO)} 更新），${REFRESH_NOTE}`;
  return `快照为空（${fmtDateTime(snap.updatedISO)} 更新）：该账号当前没有任务，或上游返回为空。`;
}

// 分组标题计数：`成长任务 · 12 项 · 待领 2`（活动组：总任务数 / 可领合计）。
function groupCountText(g) {
  if (g.type === "campaign") {
    let total = 0;
    let pending = 0;
    for (const act of g.acts) {
      const ts = Array.isArray(act?.tasks) ? act.tasks : [];
      total += ts.length;
      pending += campaignNum(act?.claimable);
    }
    return `· ${total} 项 · 待领 ${pending}`;
  }
  const pending = g.tasks.filter((t) => String(t?.acceptStatus ?? "") === "completed").length;
  return `· ${g.tasks.length} 项 · 待领 ${pending}`;
}

// 一组任务行的容器（rows 已是 .trow 数组）：清单重做（2026-11-13）后不再是「每组一张
// 带列头的表」，而是同一条清单里的连续行 —— 所有 .trow 共用同一份网格模板
// （style.css .trow 的 grid-template-areas），列跨行、跨组自然对齐，不再需要 colgroup/thead。
function taskRowList(rows) {
  return el("div", { class: "trows", role: "list" }, ...rows);
}

// 「已完成 N 项」折叠块：默认收起；用户手动展开过就记住（state.taskDoneFold）。
// 块内每行都是已领奖的行，一律不给勾选框（见 stripPickCell）。
function taskDoneBlock(key, rows) {
  const dk = `${key}::done`;
  const details = el("details", { class: "tdone", dataset: { taskDone: key } });
  if (state.taskDoneFold.get(dk) === true) details.open = true;
  details.append(
    el(
      "summary",
      { class: "tdone-summary", title: "已领奖的任务（默认收起；展开后 3 秒轮询重绘不丢）" },
      el("span", { text: `已完成 ${rows.length} 项` }),
    ),
  );
  if (rows.length) details.append(taskRowList(rows.map(stripPickCell)));
  details.addEventListener("toggle", () => state.taskDoneFold.set(dk, details.open));
  return details;
}

// 已领奖的行去掉勾选框：清空行首勾选格的内容（空 .trow-pick 保留 —— 网格列宽与未完成行
// 完全一致，只是这一格不再有 checkbox / 「选」提示）。
function stripPickCell(row) {
  const cell = row && row.querySelector ? row.querySelector(".trow-pick") : null;
  if (cell) cell.replaceChildren();
  return row;
}

// 一个分组：纯标题头（**恒展开、不可折叠** —— 无 <details>/折叠箭头/点击行为）+ 组体
// （未完成在前，已领奖收进「已完成」折叠块）。重做（2026-11-13）后组头只靠排版分层：
// 加粗标题 + 等宽计数 + 一条 hairline，不再有底色块与左侧色条；与「活动子标题」
// （.tact-head：缩进、更小、更轻）和「任务行」（.trow）三层分明，见 style.css。
function taskGroupBlock(a, g) {
  const head = el(
    "div",
    { class: "tgroup-head", dataset: { taskGroup: `${a.uid}::${g.key}` } },
    el("span", { class: "tgroup-title", text: g.title }),
    el("span", { class: "tgroup-count", text: groupCountText(g) }),
    g.key === "campaign" ? campaignRunButton(a) : null,
  );
  const body = el("div", { class: "tgroup-body" });
  if (g.type === "campaign") fillCampaignGroup(a, body, g);
  else fillSnapGroup(a, body, g);
  return el("section", { class: "tgroup", "aria-label": `${g.title} ${groupCountText(g)}` }, head, body);
}

// 成长 / 小程序组：未领奖（未接取 / 已接取 / 待领奖）在上；已领奖沉底并收进折叠块。
function fillSnapGroup(a, body, g) {
  const undone = g.tasks.filter((t) => String(t?.acceptStatus ?? "") !== "claimed");
  const done = g.tasks.filter((t) => String(t?.acceptStatus ?? "") === "claimed");
  if (undone.length) body.append(taskRowList(undone.map((t) => taskRow(a, t))));
  if (done.length) body.append(taskDoneBlock(`${a.uid}::${g.key}`, done.map((t) => taskRow(a, t))));
}

// 活动组：活动作为子标题（`星巴克协作 · 可领 0 · 已领 0/3`），其未领任务行紧随其后；
// 全部活动的已领任务统一沉底进一个「已完成 N 项」折叠块（活动名随行显示，上下文不丢）。
// 组体最上方补一行状态说明（最近一次结果 / 查询失败）——活动摘要条从账号行移除后，
// 这些「绝不静默」的诊断信息就近落在活动分组里。
function fillCampaignGroup(a, body, g) {
  const note = campaignStatusNote(a);
  if (note) body.append(note);
  const claimed = [];
  for (const act of campaignSortedActivities(g.acts)) {
    const tasks = campaignSortedTasks(Array.isArray(act?.tasks) ? act.tasks : []);
    const undone = tasks.filter((t) => !campaignTaskClaimed(t));
    for (const t of tasks) if (campaignTaskClaimed(t)) claimed.push({ act, t });
    if (!undone.length) continue; // 整组已领的活动不在这里出头（行都在折叠块里）
    body.append(campaignActHead(act));
    body.append(taskRowList(undone.map((t) => campaignTaskRow(a, act, t))));
  }
  if (claimed.length) {
    body.append(
      taskDoneBlock(
        `${a.uid}::campaign`,
        claimed.map(({ act, t }) => campaignTaskRow(a, act, t, { showAct: true })),
      ),
    );
  }
}

// 活动分组的状态说明行（原账号行活动条的那几行说明搬到这里）：最近一次结果 / 读取失败 /
// 查询失败，三者按序叠加；全都没有 → null（不占位置）。沿用 .campaign-note 一族的样式。
function campaignStatusNote(a) {
  const uid = String(a.uid ?? "");
  const st = campaignOf(a);
  const err = state.campaignErrors.get(uid);
  const run = state.campaignRuns.get(uid);
  const kids = [];
  if (run) kids.push(el("span", { class: run.ok ? "campaign-note campaign-run" : "campaign-note campaign-run warn-text", text: run.text, title: run.text }));
  if (st?.ok === false && st.error) {
    kids.push(el("span", { class: "campaign-note campaign-err warn-text", text: `活动任务读取失败：${String(st.error)}` }));
  }
  if (err) {
    const t = `活动任务查询失败：${err}`;
    kids.push(el("span", { class: "campaign-note campaign-err warn-text", text: t, title: t }));
  }
  return kids.length ? el("div", { class: "campaign-notes" }, ...kids) : null;
}

// 活动子标题：`星巴克协作 · 可领 0 · 已领 0/3`（`·` 是独立分隔 span，视觉与文本都对齐契约）。
// 重做（2026-11-13）后是清单里的一行纯文字（不再塞进表格行）：缩进落在组头与任务行之间，
// 字号更小、字重更轻、颜色更浅 —— 与「活动任务」组头、任务行三层分明。
function campaignActHead(act) {
  const tasks = Array.isArray(act?.tasks) ? act.tasks : [];
  const label = String(act?.label ?? act?.code ?? "活动").trim() || "活动";
  const sep = () => el("span", { class: "tact-sep", text: "·" });
  return el(
    "div",
    { class: "tact-head" },
    el("span", { class: "tact-name", text: label }),
    sep(),
    el("span", { class: "tact-meta", text: `可领 ${campaignNum(act?.claimable)}` }),
    sep(),
    el("span", { class: "tact-meta", text: `已领 ${campaignClaimedCount(act)}/${tasks.length}` }),
  );
}

// 活动任务行（CONTRACT §11.6）：勾选码 = `<activityCode>:<taskCode>`；可领给「领取」按钮
// （新路由 POST /api/campaign/claim {uid, activityCode, taskCode}）；未完成不给按钮、行内指到
// 分组标题的「跑一轮活动任务」；kind==="app" 的行说明「需手机端 App 完成，脚本不伪造」。
function campaignTaskRow(a, act, t, opts = {}) {
  const uid = String(a.uid ?? "");
  const activityCode = String(act?.code ?? "").trim();
  const taskCode = String(t?.taskCode ?? "").trim();
  const code = activityCode && taskCode ? `${activityCode}:${taskCode}` : "";
  const claimed = campaignTaskClaimed(t);
  const claimable = campaignTaskClaimable(t);
  const isApp = String(t?.kind ?? "") === "app";
  const label = String(t?.label ?? taskCode ?? "任务");

  const actions = el("div", { class: "row-actions" });
  if (claimable && activityCode && taskCode) {
    actions.append(
      el("button", {
        type: "button",
        class: "mini-btn",
        text: "领取",
        title: "POST /api/campaign/claim：领这一项活动任务的奖励（引擎会回读 claimed_at 才算成功）",
        onclick: (ev) => claimCampaignOne(uid, activityCode, taskCode, ev.target),
      }),
    );
  } else if (isApp && !claimed) {
    actions.append(el("span", { class: "muted", text: "需手机端完成" }));
  } else if (!claimed) {
    actions.append(el("span", { class: "muted", text: "待跑一轮活动任务" }));
  }

  // 徽章：来源「活动」；kind==="app" 再挂「需手机端」。
  const marks = [badge("活动", "badge-quiet")];
  marks[0].title = "运营活动任务（独立契约，不在成长任务快照里）";
  if (isApp) {
    const b = badge("需手机端", "badge-warn");
    b.title = "kind=app：需手机端 App 完成，脚本不伪造（§11.1 诚实口径）";
    marks.push(b);
  }
  if (opts.showAct) marks.push(el("span", { class: "pin-id", text: String(act?.label ?? act?.code ?? "活动") }));

  const notes = [];
  if (isApp) notes.push("需手机端 App 完成，脚本不伪造");
  if (!claimed && !claimable && !isApp) notes.push("点分组标题的「跑一轮活动任务」执行");

  const status = claimed
    ? badge(ACCEPT_NAMES.claimed, "badge-quiet")
    : claimable
      ? badge(ACCEPT_NAMES.completed, "badge-warn")
      : badge("未完成", "badge-quiet");
  const target = campaignNum(t?.target);
  const cur = campaignNum(t?.progress);
  const reward = campaignNum(t?.credit);
  const pickTitle = claimed
    ? "已领奖，无需再跑"
    : code
      ? "勾选后批量操作只作用于选中任务；不勾选 = 全部"
      : "缺少活动码 / 任务码，无法勾选";

  return el(
    "div",
    { class: "trow trow-campaign", role: "listitem" },
    el(
      "div",
      { class: "trow-pick" },
      el(
        "label",
        { class: "check", title: pickTitle },
        el("input", {
          type: "checkbox",
          dataset: { taskPick: uid, code },
          checked: !claimed && !!code && isPicked(uid, code),
          disabled: !code || claimed,
          "aria-label": `选择活动任务 ${label}`,
          onchange: (ev) => setPicked(uid, code, ev.target.checked),
        }),
      ),
    ),
    el(
      "div",
      { class: "trow-main" },
      el("span", { class: "trow-title", text: label }),
      code ? el("span", { class: "trow-code", text: code }) : null,
      el("div", { class: "cell-badges" }, marks),
      ...notes.map((n) => el("div", { class: "row-note", text: n })),
    ),
    el("div", { class: "trow-status" }, status),
    el("div", { class: "trow-prog" }, progressCell({ current: cur, target })),
    el("div", { class: "trow-reward" }, el("span", { class: "mono", text: reward > 0 ? `+${fmtNum(reward)} 积分` : "—" })),
    el("div", { class: "trow-act" }, actions),
  );
}

// 活动任务是否「可领」（CONTRACT §11.6）：`completedAt` 非空且 `claimedAt` 空。
function campaignTaskClaimable(t) {
  return String(t?.completedAt ?? "").trim() !== "" && !campaignTaskClaimed(t);
}

// 单行「领取」活动任务：POST /api/campaign/claim {uid, activityCode, taskCode}（CONTRACT §11.6）。
// 结果行文案与单任务领奖（claimOne）同款：成功 → 「已领奖 +N 积分…」，失败 → 「未领到：<原因>」。
// 后端未落地（404）时按 humanErr 如实报错，不白屏、不抛。
async function claimCampaignOne(uid, activityCode, taskCode, btn) {
  btn.disabled = true;
  btn.textContent = "领取中…";
  try {
    const r = await api("api/campaign/claim", { method: "POST", body: { uid, activityCode, taskCode } });
    const viaNote = r?.via === "web" ? " · 已走网页通道" : "";
    const okBadge = r?.ok
      ? badge(
          `已领奖 +${fmtNum(r.credit)} 积分${Number(r.energy) > 0 ? ` +${fmtNum(r.energy)} 能量` : ""}${viaNote}`,
          "badge-strong",
        )
      : badge(`未领到：${r?.reason || "上游未说明原因"}`, "badge-warn");
    btn.replaceWith(okBadge);
    toast(
      r?.ok ? `活动任务领取成功：+${fmtNum(r.credit)} 积分${viaNote}` : `活动任务领取未成功：${r?.reason || "见任务行提示"}`,
      r?.ok ? "info" : "warn",
    );
    if (r?.ok) await queryCampaign(uid); // 成功后就地补查活动缓存，让分组计数/进度跟手更新
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "领取";
    humanErr(e, "领取活动任务失败");
  }
}

// 账号行的轻量汇总：状态分布 + 后端判断字段的计数（共 N 项 · 桌面端 N · 无法自动化 N ·
// 可接取 N）。数字全部来自同一批字段统计，绝不硬编码；老后端没给字段时不追加这三项。
// 导出仅为 Node 下单元验证；浏览器里 <script type="module"> 不受影响。
export function taskSummary(snap) {
  const tasks = snap ? (Array.isArray(snap.tasks) ? snap.tasks : []) : [];
  if (!snap) return "任务快照：无（点「刷新快照」读取，只读，不会接取或上报）";
  const count = (st) => tasks.filter((t) => t.acceptStatus === st).length;
  const parts = [
    `共 ${tasks.length} 项`,
    `未接取 ${count("not_accepted")}`,
    `已接取 ${count("accepted")}`,
    `待领奖 ${count("completed")}`,
    `已领奖 ${count("claimed")}`,
  ];
  const flags = tasks.map(taskFlags);
  if (flags.some((f) => f.modern)) {
    const n = (pred) => flags.filter(pred).length;
    parts.push(
      `桌面端 ${n((f) => f.desktopOnly)}`,
      `无法自动化 ${n((f) => f.unforgeable)}`,
      `可接取 ${n((f) => f.canAccept)}`,
    );
  }
  return `任务快照${snapExpired(snap) ? "（已过期）" : ""}：${parts.join(" · ")}`;
}

// 批量接取计划（规则 4）：codes 只取 canAccept === true 的项（判断只来自后端字段），
// 同时把「未接取但引擎判定不可自动接取」的项数分开统计，好在按钮旁说明，而不是静默少接。
// 导出仅为 Node 下单元验证。
export function acceptPlan(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const codes = [];
  let blocked = 0; // 桌面端 / 未收录 / 引擎判定不可接
  let auto = 0; // taskType:"auto"：上游无需接取
  let noCode = 0; // 快照真缺任务码
  let locked = 0; // locked === true：次日才解锁，不算「不可自动接取」
  let pending = 0; // 未接取项总数
  for (const t of list) {
    if (String(t?.acceptStatus ?? "") !== "not_accepted") continue;
    pending++;
    const f = taskFlags(t);
    if (f.locked) {
      locked++;
      continue;
    }
    if (!String(t?.code ?? "")) {
      noCode++;
      continue;
    }
    if (f.canAccept) {
      codes.push(String(t.code));
      continue;
    }
    if (t?.taskType === "auto") auto++;
    else blocked++;
  }
  return { codes, blocked, auto, noCode, pending, locked };
}

async function refreshSnap(uid, btn) {
  btn.disabled = true;
  btn.textContent = "刷新中…";
  try {
    const d = await api("api/state", { params: { refresh: uid } });
    state.data = d;
    renderAll();
    toast(`已刷新 ${accountByUid(uid)?.nickname || uid} 的任务快照`);
    // 0.3.4：账号行里的「查询 / 重新查询连登」按钮已删 —— 刷新快照成功后顺带静默补查一次连登
    // （GET /api/streak?uid=<uid>&refresh=1），只更新该账号的连登区。
    // 静默口径：不弹任何 toast；批量任务在跑时 daemon 回 409 busy，直接跳过（刷新快照本身不失败）。
    await queryStreak(uid);
    // 0.3.5：活动任务同款 —— accounts[].campaign 为 null 时不自动打上游，只在「刷新快照」后
    // 顺带静默补查一次（GET /api/campaign?uid=<uid>&refresh=1），结果写进本地缓存。
    await queryCampaign(uid);
  } catch (e) {
    humanErr(e, "刷新快照失败");
    const b = $(`[data-snap-refresh="${uid}"]`);
    if (b) {
      b.disabled = false;
      b.textContent = "刷新快照";
    }
  }
}

// 把一行账号数据（/api/account/toggle 的 200 响应 = accounts[] 元素同形状）合并回
// 本地 state —— 不整页重载；失去 eligible 的账号同时从批量勾选里移除。
function mergeAccountRow(row) {
  const list = state.data?.accounts;
  if (!row || !Array.isArray(list)) return;
  const i = list.findIndex((x) => x.uid === row.uid);
  if (i >= 0) list[i] = { ...list[i], ...row };
  if (row.eligible === false) state.selected.delete(row.uid);
}

// 「参与任务」开关：乐观更新 → POST /api/account/toggle → 成功用服务端回读的行合并，
// 失败回滚并原样透出服务端的中文错误。请求期间该行开关禁用（state.toggling）。
async function toggleTasksEnabled(uid, want) {
  if (state.toggling.has(uid)) return;
  const acct = accountByUid(uid);
  if (!acct) return;
  const prev = { ...acct };
  const wasSelected = state.selected.has(uid);
  const isApiKey = String(acct.masked ?? "").startsWith("API key");
  state.toggling.add(uid);
  // 乐观：先本地生效（关闭 → eligible=false → 批量勾选里灰掉并取消勾选）
  mergeAccountRow({ uid, tasksEnabled: want, eligible: want ? !isApiKey : false });
  renderAccounts();
  try {
    const row = await api("api/account/toggle", { method: "POST", body: { uid, tasksEnabled: want } });
    mergeAccountRow(row && typeof row === "object" && row.uid ? row : { uid, tasksEnabled: want });
    toast(
      want
        ? `${acct.nickname || uid}：已恢复参与任务`
        : `${acct.nickname || uid}：已停用任务参与（批量操作与排程都会跳过它）`,
    );
  } catch (e) {
    // 回滚到切换前的整行（含 eligible / selected 语义）
    mergeAccountRow(prev);
    if (wasSelected && prev.eligible) state.selected.add(uid);
    humanErr(e, "切换「参与任务」失败");
  } finally {
    state.toggling.delete(uid);
    renderAccounts();
  }
}

// 单行状态：只给一枚徽章（凭据状态），剩余时间作为 --ink3 次要文本；
// 不再把「已登录 / 有效期未知 / 不参与任务」叠成多枚徽章。
function accountBadge(a) {
  const isApiKey = String(a.masked ?? "").startsWith("API key");
  const info = expiryInfo(a);
  const expired = !isApiKey && info.text === "凭据已过期";
  let node;
  if (isApiKey) node = badge("API key", "badge-quiet");
  else if (expired) node = badge("凭据已过期", "badge-warn");
  else node = badge("已登录", "badge-strong");
  if (!isApiKey && info.title) node.title = info.title;
  return {
    node,
    sub: isApiKey ? "无有效期" : expired ? "需要重新登录" : info.text,
    subWarn: !isApiKey && !expired && info.cls === "badge-warn",
  };
}

// 账号任务总量【统一口径】（成长 + 小程序 + 活动）—— 账号行进度条 / 账号行「待接取 · 待领奖」/
// 任务明细汇总 三处共用同一份统计，杜绝「进度条满了但明细里还有未完成」这类自相矛盾
// （用户 2026-11-14：进度条 26/26 而明细 32 项）。字段与消费者（谁用哪些）：
//   · hasSnap              —— 无快照时各消费方显示「无快照」而不是 0（不再各写一套判空）；
//   · total / claimed      —— 账号行进度条（`已领奖 claimed / total` + 百分比）；
//   · total / pending      —— 账号行「待领奖」、明细折叠标题「N 项 · 待领奖 y」；
//   · notAccepted/accepted —— 账号行「待接取」、明细汇总；
//   · canAccept/snapModern —— 明细里「可接取」一项（活动任务无「接取」概念，只算成长/小程序）；
//   · desktopOnly/unforgeable —— 明细里后端判断字段的计数。
// 口径：total = 成长 + 小程序 + 活动；claimed 含活动里 claimedAt 非空的项；
//   pending = 成长/小程序 completed + 活动里 completedAt 非空且 claimedAt 空（campaignTaskClaimable）的项。
function taskTotals(a) {
  const hasSnap = Array.isArray(a?.snapshot?.tasks);
  const tasks = hasSnap ? a.snapshot.tasks : [];
  const flags = tasks.map(taskFlags);
  const count = (st) => tasks.filter((t) => String(t?.acceptStatus ?? "") === st).length;
  let campTotal = 0;
  let campPending = 0;
  let campClaimed = 0;
  for (const act of campaignActivities(campaignOf(a))) {
    const ts = Array.isArray(act?.tasks) ? act.tasks : [];
    campTotal += ts.length;
    campPending += ts.filter(campaignTaskClaimable).length;
    campClaimed += ts.filter(campaignTaskClaimed).length;
  }
  return {
    hasSnap,
    total: tasks.length + campTotal,
    notAccepted: count("not_accepted"),
    accepted: count("accepted"),
    pending: count("completed") + campPending,
    claimed: count("claimed") + campClaimed,
    canAccept: flags.filter((f) => f.canAccept).length,
    desktopOnly: flags.filter((f) => f.desktopOnly).length,
    unforgeable: flags.filter((f) => f.unforgeable).length,
    snapModern: flags.some((f) => f.modern),
  };
}

// 分项小格：数值在上、标签在下；换行只发生在格与格之间，绝不把一句长文案劈开
function metric(value, label) {
  return el(
    "span",
    { class: "metric" },
    el("span", { class: "metric-l", text: label }),
    el("span", { class: "metric-v", text: String(value) }),
  );
}

// 任务明细三组的合并计数统一走 taskTotals(a)（同上），此处只负责渲染。
function snapMetrics(a) {
  const t = taskTotals(a);
  if (!t.hasSnap) {
    return el("span", {
      class: "acct-metrics-empty",
      text: "无快照：点「刷新快照」读取（只读，不接取、不上报）",
    });
  }
  const cells = [
    metric(t.total, "任务总量"), // 三组之和（成长 + 小程序 + 活动）
    metric(t.notAccepted, "未接取"),
    metric(t.accepted, "已接取"),
    metric(t.pending, "待领奖"), // 成长/小程序 completed + 活动可领
    metric(t.claimed, "已领奖"), // 成长/小程序 claimed + 活动已领
  ];
  if (t.snapModern) {
    cells.push(
      metric(t.desktopOnly, "桌面端"),
      metric(t.unforgeable, "无法自动化"),
      metric(t.canAccept, "可接取"), // 成长/小程序 canAccept（活动无「接取」概念）
    );
  }
  return el("span", { class: "acct-metrics" }, ...cells);
}

// 折叠标题只留一行紧凑文字（完整汇总在 title）：任务明细 · N 项 · 可接取 x · 待领奖 y。
// N / 待领奖按三组之和（成长 + 小程序 + 活动），可接取只算成长/小程序（活动任务没有「接取」
// 概念）。仅当快照带判断字段时才展示「可接取」这一项（老后端不硬编造）。数字全部来自 taskTotals。
function snapBrief(a) {
  const t = taskTotals(a);
  if (!t.hasSnap) return "任务明细 · 无快照";
  const parts = ["任务明细", `${t.total} 项`];
  if (t.snapModern) parts.push(`可接取 ${t.canAccept}`);
  parts.push(`待领奖 ${t.pending}`);
  return parts.join(" · ");
}

function accountRow(a) {
  const isApiKey = String(a.masked ?? "").startsWith("API key");
  const uid = String(a.uid ?? "");
  const name = String(a.nickname || uid || "（无昵称）");
  // 域名 + uid 不再单独占一行（.acct-sub 已删）：并进昵称的 title，信息不丢、行高不涨。
  const metaBits = [a.domain, uid].filter((x) => x != null && x !== "");
  const nameTitle = metaBits.length ? `${name} · ${metaBits.join(" · ")}` : name;

  const check = el("input", {
    type: "checkbox",
    class: "acct-check",
    value: uid,
    checked: state.selected.has(uid),
    disabled: !a.eligible,
    "aria-label": `选择账号 ${name}`,
    onchange: (ev) => {
      if (ev.target.checked) state.selected.add(uid);
      else state.selected.delete(uid);
      updateSelectionUI();
    },
  });

  const st = accountBadge(a);
  // 冻结（CONTRACT §10.5）是行级状态：醒目红色徽章放在凭据栏（同一列组，一眼看到）。
  // frozen 非空 → 该账号不进排程 / 批量缺省目标；参与开关与任务按钮按现状保留，
  // 但整行加 .acct-frozen 视觉标注「不会被调度」。
  const frozen = frozenOf(a);
  const statusCell = el(
    "div",
    { class: "acct-cell acct-status", dataset: { label: "凭据" } },
    el(
      "span",
      { class: "cell-stack" },
      st.node,
      frozen ? frozenBadge(frozen) : null,
      el("span", { class: st.subWarn ? "acct-note warn-text" : "acct-note", text: st.sub }),
    ),
  );

  // 账号行进度与「待接取 · 待领奖」一律走 taskTotals（与任务明细同一口径，含活动任务）
  const t = taskTotals(a);
  const claimedPct = t.total > 0 ? Math.round((t.claimed / t.total) * 100) : 0;
  const progressCell = el(
    "div",
    {
      class: "acct-cell acct-progress",
      dataset: { label: "任务" },
      title: isApiKey ? "API key 账号不参与任务，没有任务快照" : taskSummary(a.snapshot),
    },
    el("span", { class: "acct-prog-main", text: t.hasSnap ? `已领奖 ${t.claimed} / ${t.total}` : "无快照" }),
    t.hasSnap
      ? svgEl(
          "svg",
          {
            class: "acct-bar",
            role: "progressbar",
            "aria-valuemin": "0",
            "aria-valuemax": String(t.total),
            "aria-valuenow": String(t.claimed),
            "aria-label": `已领奖 ${t.claimed} / ${t.total}`,
            width: "100%",
            height: "4",
            "shape-rendering": "crispEdges",
          },
          svgEl("rect", {
            class: "acct-bar-track",
            x: "0",
            y: "0",
            width: "100%",
            height: "100%",
            rx: "2",
            ry: "2",
          }),
          svgEl("rect", {
            class: "acct-bar-fill",
            x: "0",
            y: "0",
            width: `${claimedPct}%`,
            height: "100%",
            rx: "2",
            ry: "2",
            style: { width: `${claimedPct}%` },
          }),
        )
      : null,
    el("span", {
      class: "acct-prog-sub",
      text: t.hasSnap
        ? `待接取 ${t.notAccepted} · 待领奖 ${t.pending}`
        : isApiKey
          ? "不参与任务"
          : "刷新快照后可查看",
    }),
  );

  const toggling = state.toggling.has(uid);
  const toggleTitle = isApiKey
    ? "API key 账号不参与任务（批量与排程都会跳过）"
    : frozen
      ? `已冻结（${frozenCode(frozen)}）：开关照旧可切，但冻结解除前批量操作与排程都会跳过它`
      : "参与任务：关闭后该账号不进入批量操作与排程（POST /api/account/toggle，立即生效并持久化）";
  const toggle = el(
    "label",
    {
      class: "switch-inline acct-toggle",
      title: toggleTitle,
    },
    el("input", {
      type: "checkbox",
      checked: isApiKey ? false : !!a.tasksEnabled,
      disabled: toggling || isApiKey,
      "aria-label": `账号 ${name} 参与任务`,
      onchange: (ev) => toggleTasksEnabled(uid, ev.target.checked),
    }),
    el("span", { class: "switch-track", "aria-hidden": "true" }),
    el("span", { class: "toggle-text", text: toggling ? "提交中…" : "参与任务" }),
  );

  const sideCell = el(
    "div",
    { class: "acct-cell acct-side", dataset: { label: "操作" } },
    isApiKey && !frozen
      ? el("span", { class: "muted", text: "—" })
      : el(
          "div",
          { class: "side-actions" },
          // 冻结行第一位就是「恢复」：解冻是唯一的解锁动作，别让它藏在别处
          frozen ? unfreezeButton(uid) : null,
          isApiKey
            ? null
            : el("button", {
                type: "button",
                class: "mini-btn",
                dataset: { snapRefresh: uid },
                text: "刷新快照",
                title: "只读刷新：读取上游任务快照，不会接取任务也不会上报进度",
                onclick: (ev) => refreshSnap(uid, ev.target),
              }),
        ),
  );

  const expired = snapExpired(a.snapshot);
  const snapMetaText = a.snapshot
    ? `${expired ? "已过期" : "快照"} · ${fmtTime(a.snapshot.updatedISO)}`
    : "未读取";
  const tasks = el(
    "details",
    { class: "acct-tasks" },
    el(
      "summary",
      {
        class: "acct-tasks-summary",
        title: a.snapshot ? taskSummary(a.snapshot) : "任务快照：无（点「刷新快照」读取）",
      },
      el("span", {
        class: expired ? "acct-tasks-label warn-text" : "acct-tasks-label",
        text: snapBrief(a),
      }),
      el("span", { class: "acct-tasks-meta", text: snapMetaText }),
    ),
    // 连登日历搬进「任务明细」详情里（任务表上方，0.3.4）：它是「这个账号最近发生了什么」
    // 的明细，和任务表同属展开区；账号行只留昵称右侧那两行数字 + 档位。
    el("div", { class: "acct-tasks-body" }, snapMetrics(a), heatPanel(a), taskTable(a)),
  );
  if (state.expanded.has(uid)) tasks.open = true;
  tasks.addEventListener("toggle", () => {
    if (tasks.open) state.expanded.add(uid);
    else state.expanded.delete(uid);
  });

  return el(
    "div",
    {
      class: frozen ? "acct acct-frozen" : "acct",
      role: "group",
      "aria-label": `账号 ${name}${frozen ? `（已冻结 ${frozenCode(frozen)}）` : ""}`,
      dataset: { acct: uid }, // 锚点：updateCampaignArea() 用它找到整行 replaceWith 局部重绘
    },
    el(
      "div",
      { class: "acct-grid" },
      el("div", { class: "acct-cell acct-pick" }, el("label", { class: "check" }, check)),
      // 账号单元格：左边昵称，右边紧跟连登两行。活动任务摘要条已移除（用户 2026-11-13：
      // 「活动任务和跑一轮可以去掉了」）——活动任务的入口只剩任务明细「活动任务」分组标题
      // 右侧那个「跑一轮活动任务」按钮。
      el(
        "div",
        { class: "acct-cell acct-id" },
        el("span", { class: "acct-name", text: name, title: nameTitle }),
        el("div", { class: "acct-id-stack" }, streakCellBlock(a)),
      ),
      statusCell,
      progressCell,
      creditsCell(a),
      el("div", { class: "acct-cell acct-toggle-cell" }, toggle),
      sideCell,
    ),
    tasks,
  );
}

// 版本一致性横幅（0.3.4）：静态文件版本（<meta name="wb-version">）vs 守护进程
// /api/hello 的 version。不一致 = 「插件文件更新了、端口上还是老进程健康复用」这个坑 ——
// 报「重启插件」这一步。一致 / hello 没拿到（引擎与守护进程都没起来）→ 不显示，不多报。
// 版本不一致提示：挂在 appbar 的「实时 · SSE」右边（用户 2026-11-11 指定位置），
// 做成一颗告警胶囊 —— 顶栏是横条，放整段解释会把状态栏撑高，所以可见文案只留
// 短句（两个版本号），完整解释进 title。守护进程健康（版本一致）时整颗隐藏。
function renderVersionPill() {
  const pill = $("#verPill");
  if (!pill) return;
  const fileV = staticVersion();
  const svcV = String(state.hello?.version ?? "").trim();
  if (!fileV || !svcV || fileV === svcV) {
    pill.hidden = true;
    pill.textContent = "";
    pill.removeAttribute("title");
    return;
  }
  pill.hidden = false;
  pill.textContent = `守护进程版本落后（v${svcV} ≠ v${fileV}）`;
  pill.title =
    `插件文件是 v${fileV}，守护进程还在跑 v${svcV} —— 通常是更新后没重启守护进程；` +
    "在 magpie 里关掉再开启本插件即可（或点看板顶栏「停止守护进程」后重新拉起）。";
}

function renderBanners() {
  renderVersionPill(); // 顶栏胶囊，与账号区横幅无关；每次都按当前 hello 重算
  const box = $("#accountsBanners");
  box.replaceChildren();
  const d = state.data;
  if (!d) return;
  if (d.notice) {
    box.append(
      el("div", { class: "banner banner-warn" },
        el("strong", { text: "账号读取提示" }),
        el("p", { text: String(d.notice) }),
      ),
    );
  }
  if (Array.isArray(d.engineErrors) && d.engineErrors.length) {
    box.append(
      el("div", { class: "banner banner-warn" },
        el("strong", { text: "任务引擎不可用" }),
        el("ul", {}, d.engineErrors.map((m) => el("li", { text: String(m) }))),
        el("p", { class: "muted", text: "批量操作与快照刷新都依赖引擎（engine/*.mjs）。装好完整插件后重启守护进程。" }),
      ),
    );
  }
}

// 国际版只剩一行诊断文字：数字取 /api/state 的 intlSkipped.count；
// 缺失或为 0 时整行不显示，绝不渲染任何国际版账号行。
function renderIntlNote() {
  const box = $("#intlNote");
  if (!box) return;
  const count = Number(state.data?.intlSkipped?.count);
  if (!Number.isFinite(count) || count <= 0) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  box.textContent = `已忽略 ${count} 个国际版账号（workbuddy-ai）：本插件只服务国内版`;
  box.hidden = false;
}

// 企业版说明行：与 #intlNote 一模一样的样式与位置。数字取 /api/state 顶层
// enterpriseSkipped.count，文案优先用后端的 note；缺失或为 0 时整行不显示。
// 纪律：绝不渲染任何企业版账号内容（uid / 昵称 / 域名），只出计数与说明。
function renderEnterpriseNote() {
  const box = $("#enterpriseNote");
  if (!box) return;
  const count = Number(state.data?.enterpriseSkipped?.count);
  if (!Number.isFinite(count) || count <= 0) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  const note = String(state.data?.enterpriseSkipped?.note ?? "").trim();
  box.textContent =
    note || `已忽略 ${count} 个企业版账号：企业版没有成长任务与签到，本插件只服务个人版`;
  box.hidden = false;
}

function renderAccounts() {
  const box = $("#accountsList");
  box.replaceChildren();
  const accounts = state.data?.accounts ?? [];
  const head = $("#acctHead");
  if (head) head.hidden = accounts.length === 0;
  const count = $("#acctCount");
  if (count) {
    const eligible = accounts.filter((a) => a.eligible).length;
    count.textContent = accounts.length ? `${accounts.length} 个账号 · ${eligible} 个参与` : "暂无账号";
  }
  renderIntlNote();
  renderEnterpriseNote();
  renderFrozenNote();
  if (!accounts.length) {
    box.append(
      el(
        "div",
        { class: "empty" },
        el("strong", {}, "还没有账号"),
        "在 magpie 里登录 WorkBuddy 国内版后点「重新扫描」，或从另一台机器导出的账号 JSON 导入。凭据文件：",
        el("code", { text: "<magpie 配置目录>/plugin-auth.json" }),
        "。",
        el(
          "div",
          {},
          el("button", {
            type: "button",
            class: "ghost-btn",
            text: "导入账号…",
            onclick: () => setIoOpen(true, "import"),
          }),
        ),
      ),
    );
    updateSelectionUI();
    return;
  }
  for (const a of accounts) box.append(accountRow(a));
  // 清掉已不存在的勾选（账号级 / 任务级都按 uid 收口）
  const uids = new Set(accounts.map((a) => a.uid));
  for (const s of [...state.selected]) if (!uids.has(s)) state.selected.delete(s);
  for (const uid of Object.keys(state.taskSel)) if (!uids.has(uid)) delete state.taskSel[uid];
  // 重建 DOM 后把勾选控件同步回 state（表头全选/半选、已选计数）
  for (const a of accounts) updateTaskSelUI(a.uid);
  updateSelectionUI();
}

// ---- 积分（账号行余额列 + 明细弹窗） ------------------------------------------------
// 数据面：
//   GET /api/credits?uid=<uid>&refresh=0|1
//     成功      -> {ok:true, uid, nickname, credits}
//     上游失败  -> {ok:false, uid, nickname, error, needRelogin?}（HTTP 200）
//     404       -> 未知账号
//     409       -> {error:"busy"}（批量任务运行中）
//   /api/state 的 accounts[].credits 是同一形状的缓存（对象或 null）。
// credits 全部为 camelCase；数值一律先经 creditNum/parsePercent，缺字段不抛错。
// 行内只做「余额 + 明细入口」；完整权益包表格、筛选、排序都在弹窗里。

const SOON_DAYS = 7;
const CREDITS_FILTERS = ["all", "remain", "soon", "dead"];
const CREDITS_SORTS = ["expiry", "remain", "used", "size"];

const creditCache = new Map(); // uid -> credits：跨 /api/state 轮询保留本地已查到的值
const creditAutoTried = new Set(); // 自动查询过的 uid：失败后不再反复打上游
const creditQueue = { list: [], active: 0, max: 2 }; // 页面加载后的自动查询最多 2 并发
let lastBusyToastAt = 0;

function creditNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 后端时间形如 "2026-11-04 00:22:56"（本地时间）；Safari 不认空格分隔，换成 T。
function creditDate(v) {
  if (v == null || v === "") return null;
  let s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(" ", "T");
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtMonthDay(v) {
  const d = creditDate(v);
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function creditDaysLeft(daysLeft, dateStr) {
  if (typeof daysLeft === "number" && Number.isFinite(daysLeft)) return daysLeft;
  if (typeof daysLeft === "string" && daysLeft.trim() !== "" && Number.isFinite(Number(daysLeft))) {
    return Number(daysLeft);
  }
  const d = creditDate(dateStr);
  if (!d) return null;
  return Math.ceil((d.getTime() - Date.now()) / DAY_MS);
}

function parsePercent(v) {
  if (typeof v === "number" && Number.isFinite(v)) return Math.max(0, Math.min(100, v));
  const m = String(v ?? "").match(/-?\d+(?:\.\d+)?/);
  if (!m) return 0;
  const n = Number(m[0]);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

function fmtPctNum(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0%";
  return `${Number.isInteger(x) ? x : x.toFixed(1)}%`;
}

function creditUsagePct(c) {
  const raw = String(c?.usedPercent ?? "").trim();
  if (raw !== "") return parsePercent(raw);
  const size = creditNum(c?.size);
  return size > 0 ? Math.max(0, Math.min(100, (creditNum(c?.used) / size) * 100)) : 0;
}

function creditUsageText(c) {
  const raw = String(c?.usedPercent ?? "").trim();
  if (/^-?\d+(?:\.\d+)?%$/.test(raw)) return raw;
  return fmtPctNum(creditUsagePct(c));
}

function creditTierName(c) {
  const pkg = String(c?.tier?.package ?? "").trim();
  if (pkg) return pkg;
  return c?.isPaidUser ? "付费用户" : "普通用户";
}

function creditsPkgExpired(p) {
  if (!p || p.noExpiry) return false;
  if (p.isExpired === true) return true;
  const d = creditDate(p.expireTime || p.cycleEndTime);
  return d ? d.getTime() <= Date.now() : false;
}

function creditPkgDaysLeft(p) {
  return creditDaysLeft(p?.daysLeft, p?.expireTime || p?.cycleEndTime);
}

function creditPkgExpiryTs(p) {
  if (p?.noExpiry) return Number.POSITIVE_INFINITY;
  const d = creditDate(p?.expireTime || p?.cycleEndTime);
  return d ? d.getTime() : Number.POSITIVE_INFINITY;
}

function creditPkgUsagePct(p) {
  const size = creditNum(p?.size);
  if (size <= 0) return null;
  return Math.max(0, Math.min(100, (creditNum(p?.used) / size) * 100));
}

function creditBusyFor(uid) {
  return state.creditBusy.has(uid) || creditQueue.list.includes(uid);
}

// 行内「N 天内到期」小徽章：只认 earliestExpiring.daysLeft（缺失时用到期日期算）；
// ≤3 天 warn，4–7 天 quiet，>7 天不显示。
function creditsSoonBadge(c) {
  const ee = c?.earliestExpiring;
  if (!ee) return null;
  const days = creditDaysLeft(ee.daysLeft, ee.cycleEndTime || ee.expireTime);
  if (days == null || days > SOON_DAYS) return null;
  const n = Math.max(1, Math.ceil(days));
  return el("span", {
    class: `badge credits-soon ${n <= 3 ? "badge-warn" : "badge-quiet"}`,
    text: `${n} 天内到期`,
    title: ee.name
      ? `${ee.name}：${String(ee.cycleEndTime || ee.expireTime || "").trim() || "到期时间未知"}`
      : "最近将过期的权益包",
  });
}

function creditsCellContent(a) {
  const uid = String(a.uid ?? "");
  const c = a.credits;
  const busy = creditBusyFor(uid);
  const err = state.creditErrors.get(uid);
  if (!c || typeof c !== "object") {
    const errText = err ? `${err.error}${err.needRelogin ? "（需要重新登录 WorkBuddy）" : ""}` : "";
    return [
      el("span", { class: "credits-main credits-main-empty", text: "未查询" }),
      el("div", { class: "credits-actions" },
        el("button", {
          type: "button",
          class: "mini-btn",
          dataset: { creditsQuery: uid },
          text: busy ? "查询中…" : "查询",
          disabled: busy,
          title: busy ? "正在查询积分…" : errText || "查询该账号的积分余额（只读）",
          onclick: () => queryCredits(uid),
        }),
      ),
    ];
  }
  const remain = creditNum(c.remain);
  const size = creditNum(c.size);
  const updated = String(c.updatedIso ?? "").trim();
  return [
    el("span", {
      class: "credits-main",
      title: `剩余 ${fmtNum(remain)} / 总额度 ${fmtNum(size)}${updated ? ` · 更新于 ${updated}` : ""}`,
    },
      el("b", { class: "credits-remain", text: fmtNum(remain) }),
      el("span", { class: "credits-dim", text: " / " }),
      el("span", { class: "credits-size", text: fmtNum(size) }),
    ),
    el("div", { class: "credits-actions" },
      el("button", {
        type: "button",
        class: "mini-btn",
        dataset: { creditsOpen: uid },
        text: "明细",
        title: `查看积分明细${updated ? `（数据更新于 ${updated}）` : ""}`,
        onclick: () => openCreditsDialog(uid),
      }),
      creditsSoonBadge(c),
    ),
  ];
}

function creditsCell(a) {
  const uid = String(a.uid ?? "");
  return el(
    "div",
    { class: "acct-cell acct-credits", dataset: { label: "积分", creditsCell: uid } },
    ...creditsCellContent(a),
  );
}

// 只重绘积分列（不整页 renderAccounts），避免轮询/查询时打断任务勾选与展开状态。
function updateCreditsCell(uid) {
  const cell = $(`[data-credits-cell="${uid}"]`);
  if (!cell) return;
  const acct = accountByUid(uid);
  if (!acct) return;
  cell.replaceChildren(...creditsCellContent(acct));
}

function applyCredits(uid, credits, nickname) {
  const acct = accountByUid(uid);
  if (acct) {
    acct.credits = credits;
    if (nickname && !acct.nickname) acct.nickname = String(nickname);
  }
  if (credits && typeof credits === "object") creditCache.set(uid, credits);
  state.creditErrors.delete(uid);
  updateCreditsCell(uid);
  if (creditsDialog.uid === uid && $("#creditsDialog")?.open) {
    creditsDialog.credits = credits;
    renderCreditsDialog();
  }
}

// 统一把 HTTP 错误 / 200 里的 ok:false 转成可渲染的结果；绝不抛给调用方。
async function requestCredits(uid, refresh = false) {
  try {
    const d = await api("api/credits", { params: { uid, refresh: refresh ? 1 : 0 } });
    if (d && d.ok && d.credits && typeof d.credits === "object") {
      return { ok: true, credits: d.credits, nickname: d.nickname };
    }
    if (d && d.ok === false) {
      return {
        ok: false,
        kind: "upstream",
        error: humanizeApiErr(String(d.error || "上游查询失败"), d.hint),
        needRelogin: !!d.needRelogin,
        nickname: d.nickname,
      };
    }
    return { ok: false, kind: "bad", error: "返回数据不完整（缺少 credits）" };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 409) return { ok: false, kind: "busy", error: "批量任务运行中，稍后再查" };
      // 404 既可能是「账号不存在」，也可能是「老守护进程没这个路由（未知 API）」。
      // 后者是版本落后，不能误报成账号不存在 —— 交给统一改写函数区分。
      if (e.status === 404 && !UNKNOWN_API_RE.test(e.message)) {
        return { ok: false, kind: "notfound", error: "未知账号（可能已被移除）" };
      }
      return { ok: false, kind: "http", error: humanizeApiErr(e.message || `HTTP ${e.status}`, e.data?.hint) };
    }
    if (e && e.network) return { ok: false, kind: "network", error: "连不上守护进程" };
    return { ok: false, kind: "error", error: humanizeApiErr(String((e && e.message) || e)) };
  }
}

function toastCreditsBusy() {
  const now = Date.now();
  if (now - lastBusyToastAt < 6000) return; // 多个账号同时 409 时只提示一次
  lastBusyToastAt = now;
  toast("批量任务运行中，稍后再查", "warn", 6500);
}

// 行内查询：refresh=0（读缓存/只读查询），失败只写按钮 title，不弹错。
async function loadCredits(uid, { refresh = false } = {}) {
  if (state.creditBusy.has(uid)) return null;
  state.creditBusy.add(uid);
  updateCreditsCell(uid);
  try {
    const r = await requestCredits(uid, refresh);
    if (r.ok) {
      applyCredits(uid, r.credits, r.nickname);
    } else {
      state.creditErrors.set(uid, { error: r.error, needRelogin: !!r.needRelogin });
      if (r.kind === "busy") toastCreditsBusy();
    }
    return r;
  } finally {
    state.creditBusy.delete(uid);
    updateCreditsCell(uid);
  }
}

function queryCredits(uid) {
  const queued = creditQueue.list.indexOf(uid);
  if (queued >= 0) creditQueue.list.splice(queued, 1);
  if (state.creditBusy.has(uid)) return;
  loadCredits(uid, { refresh: false });
}

// 页面加载后：对 credits === null 的可参与账号自动查一次（最多 2 并发）。
// 失败不重试（creditAutoTried 记账），避免每次 /api/state 轮询都打上游。
function autoFetchCredits() {
  for (const a of eligibleAccounts()) {
    const uid = String(a.uid ?? "");
    if (!uid || a.credits != null) continue;
    if (creditAutoTried.has(uid) || state.creditBusy.has(uid) || creditQueue.list.includes(uid)) continue;
    creditAutoTried.add(uid);
    creditQueue.list.push(uid);
    updateCreditsCell(uid);
  }
  pumpCreditQueue();
}

function pumpCreditQueue() {
  while (creditQueue.active < creditQueue.max && creditQueue.list.length) {
    const uid = creditQueue.list.shift();
    creditQueue.active++;
    loadCredits(uid, { refresh: false }).finally(() => {
      creditQueue.active--;
      pumpCreditQueue();
    });
  }
}

// ---- 积分明细弹窗 ----------------------------------------------------------------

const creditsDialog = {
  uid: "",
  nickname: "",
  credits: null,
  filter: "all",
  sort: "expiry",
  query: "",
  loading: false,
  error: "",
  needRelogin: false,
  req: 0, // 刷新序号：关闭/重新打开后让在途请求的结果失效
};

function creditsAllPackages() {
  const list = creditsDialog.credits?.packages;
  return Array.isArray(list) ? list : [];
}

function creditPkgMatchesFilter(p) {
  const remain = creditNum(p?.remain);
  const expired = creditsPkgExpired(p);
  switch (creditsDialog.filter) {
    case "remain":
      return remain > 0;
    case "soon": {
      const days = creditPkgDaysLeft(p);
      return !expired && remain > 0 && days != null && days <= SOON_DAYS;
    }
    case "dead":
      return expired || remain <= 0;
    default:
      return true;
  }
}

function creditPkgMatchesQuery(p, q) {
  if (!q) return true;
  const fields = [p?.name, p?.packageCode, p?.productName, p?.subProductName, p?.grantReason, p?.resourceId, p?.dealName];
  return fields.some((x) => String(x ?? "").toLowerCase().includes(q));
}

function creditsFilteredPackages() {
  const q = creditsDialog.query.trim().toLowerCase();
  const rows = creditsAllPackages().filter((p) => creditPkgMatchesFilter(p) && creditPkgMatchesQuery(p, q));
  if (creditsDialog.sort === "remain") rows.sort((a, b) => creditNum(b.remain) - creditNum(a.remain));
  else if (creditsDialog.sort === "used") rows.sort((a, b) => creditNum(b.used) - creditNum(a.used));
  else if (creditsDialog.sort === "size") rows.sort((a, b) => creditNum(b.size) - creditNum(a.size));
  else {
    rows.sort(
      (a, b) =>
        creditPkgExpiryTs(a) - creditPkgExpiryTs(b) ||
        creditNum(b.remain) - creditNum(a.remain),
    );
  }
  return rows;
}

function creditsPkgRow(p) {
  const remain = creditNum(p?.remain);
  const size = creditNum(p?.size);
  const used = creditNum(p?.used);
  const expired = creditsPkgExpired(p);
  const days = creditPkgDaysLeft(p);

  const name = String(p?.name ?? "").trim() || "（未命名套餐）";
  const source = [p?.productName, p?.subProductName]
    .map((x) => String(x ?? "").trim())
    .filter((x) => x && x !== name);
  const sourceText = [...new Set(source)].join(" · ");
  const code = String(p?.packageCode ?? "").trim();
  const grant = String(p?.grantReason ?? "").trim();

  let expiryText;
  let expiryCls;
  if (p?.noExpiry) {
    expiryText = "长期有效";
    expiryCls = "badge-quiet";
  } else if (expired) {
    expiryText = "已过期";
    expiryCls = "badge-warn";
  } else if (days != null) {
    const n = Math.max(0, Math.ceil(days));
    expiryText = `剩 ${n} 天`;
    expiryCls = n <= 3 ? "badge-warn" : n <= SOON_DAYS ? "badge-quiet" : "";
  } else {
    expiryText = "有效期未知";
    expiryCls = "badge-quiet";
  }

  const expireTime = String(p?.expireTime ?? "").trim();
  const createTime = String(p?.createTime ?? "").trim();
  const pct = creditPkgUsagePct(p);

  return el(
    "tr",
    {},
    el("td", { dataset: { label: "套餐包" } },
      el("span", {
        class: "credits-pkg-main",
        text: name,
        title: String(p?.resourceId ?? "").trim() || undefined,
      }),
      sourceText ? el("span", { class: "credits-pkg-sub", text: sourceText }) : null,
      code ? el("span", { class: "credits-pkg-sub", text: code }) : null,
      grant ? el("span", { class: "credits-pkg-note", text: grant }) : null,
    ),
    el("td", { dataset: { label: "有效期" } },
      el("span", { class: `badge ${expiryCls}`.trim(), text: expiryText }),
      expireTime ? el("span", { class: "credits-exp-main", text: `到期 ${expireTime}` }) : null,
      createTime ? el("span", { class: "credits-exp-sub", text: `创建 ${createTime}` }) : null,
    ),
    el("td", { class: "num", text: fmtNum(size) }),
    el("td", { class: "num", text: fmtNum(used) }),
    el("td", {
      class: `num credits-remain-cell${remain <= 0 ? " credits-zero" : ""}`,
      text: fmtNum(remain),
    }),
    el("td", { dataset: { label: "利用率" } },
      pct == null
        ? el("span", { class: "credits-mini-text", text: "—" })
        : el("span", { class: "credits-mini" },
            el("span", { class: "credits-mini-bar", "aria-hidden": "true" },
              el("span", { class: "credits-mini-fill", style: { width: `${pct}%` } }),
            ),
            el("span", { class: "credits-mini-text", text: fmtPctNum(pct) }),
          ),
    ),
  );
}

function renderCreditsPkgs() {
  const tbody = $("#creditsPkgRows");
  if (!tbody) return;
  const rows = creditsFilteredPackages();
  tbody.replaceChildren(...rows.map(creditsPkgRow));
  const table = $("#creditsTable");
  const empty = $("#creditsEmpty");
  if (table) table.hidden = rows.length === 0;
  if (empty) empty.hidden = rows.length !== 0;
}

function creditsMetricCard(label, value, sub, valueCls) {
  return el("div", { class: "credits-metric" },
    el("span", { class: "credits-metric-l", text: label }),
    el("span", { class: valueCls ? `credits-metric-v ${valueCls}` : "credits-metric-v", text: String(value) }),
    sub ? el("span", { class: "credits-metric-sub", text: sub }) : null,
  );
}

function renderCreditsMetrics(c) {
  const box = $("#creditsMetrics");
  if (!box) return;
  const cards = [
    creditsMetricCard("剩余可用积分", fmtNum(creditNum(c.remain)), "当前可用", "is-remain"),
    creditsMetricCard("已消耗积分", fmtNum(creditNum(c.used)), "累计消耗"),
    creditsMetricCard("总额度容量", fmtNum(creditNum(c.size)), "全部权益包合计"),
  ];
  const ee = c.earliestExpiring;
  if (!ee) {
    cards.push(creditsMetricCard("最近将过期", "无", "没有即将到期的权益包", "is-muted"));
  } else {
    const days = creditDaysLeft(ee.daysLeft, ee.cycleEndTime || ee.expireTime);
    const n = days == null ? null : Math.max(1, Math.ceil(days));
    const date = fmtMonthDay(ee.cycleEndTime || ee.expireTime);
    const sub = [date ? `${date} 到期` : "", `${fmtNum(creditNum(ee.remain))} 积分`].filter(Boolean).join(" · ");
    cards.push(creditsMetricCard("最近将过期", n == null ? "即将到期" : `剩 ${n} 天`, sub));
  }
  box.replaceChildren(...cards);
}

function renderCreditsUsage(c) {
  const box = $("#creditsUsage");
  if (!box) return;
  const pct = creditUsagePct(c);
  const text = creditUsageText(c);
  const updated = String(c.updatedIso ?? "").trim() || "—";
  box.replaceChildren(
    el("div", { class: "credits-usage-row" },
      el("div", {
        class: "credits-bar",
        role: "progressbar",
        "aria-valuemin": "0",
        "aria-valuemax": "100",
        "aria-valuenow": String(Math.round(pct)),
        "aria-label": `额度利用率 ${text}`,
        title: `已消耗 ${fmtNum(creditNum(c.used))} / 总额度 ${fmtNum(creditNum(c.size))}`,
      },
        el("span", { class: "credits-bar-fill", style: { width: `${pct}%` } }),
      ),
      el("div", { class: "credits-usage-meta" },
        el("span", { class: "credits-usage-pct", text: `额度利用率: ${text}` }),
        el("span", { text: `更新时间: ${updated}` }),
      ),
    ),
  );
}

function renderCreditsStatus() {
  const box = $("#creditsStatus");
  if (!box) return;
  let text = "";
  let cls = "credits-status";
  if (creditsDialog.error) {
    text = creditsDialog.error;
    if (creditsDialog.needRelogin) text += "（需要重新登录 WorkBuddy）";
    if (creditsDialog.credits) text = `刷新失败，显示缓存数据：${text}`;
    cls += " credits-status-error";
  } else if (creditsDialog.loading) {
    text = creditsDialog.credits ? "刷新中…" : "加载中…";
    cls += " credits-status-loading";
  }
  box.className = cls;
  box.textContent = text;
  box.hidden = !text;
}

function syncCreditsControls() {
  for (const b of $$("[data-credits-filter]")) {
    const on = b.dataset.creditsFilter === creditsDialog.filter;
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }
  const search = $("#creditsSearch");
  if (search) search.value = creditsDialog.query;
  const sort = $("#creditsSort");
  if (sort) sort.value = creditsDialog.sort;
}

function renderCreditsDialog() {
  const dlg = $("#creditsDialog");
  if (!dlg) return;
  const acct = creditsDialog.uid ? accountByUid(creditsDialog.uid) : null;
  const nick = creditsDialog.nickname || String(acct?.nickname ?? "") || creditsDialog.uid || "账号";
  const c = creditsDialog.credits && typeof creditsDialog.credits === "object" ? creditsDialog.credits : null;

  const title = $("#creditsTitle");
  if (title) title.textContent = `${nick} · 积分明细`;

  const badges = $("#creditsBadges");
  if (badges) {
    badges.replaceChildren(badge("国内版", "badge-quiet"));
    if (c) {
      const paid = !!c.isPaidUser || !!c.tier?.paid;
      badges.append(badge(creditTierName(c), paid ? "badge-strong" : "badge-quiet"));
    } else {
      badges.append(badge("会员类型未知", "badge-quiet"));
    }
  }

  renderCreditsStatus();

  const has = !!c;
  const metrics = $("#creditsMetrics");
  const usage = $("#creditsUsage");
  const filters = $("#creditsFilters");
  const tableWrap = $("#creditsTableWrap");
  if (metrics) metrics.hidden = !has;
  if (usage) usage.hidden = !has;
  if (filters) filters.hidden = !has;
  if (tableWrap) tableWrap.hidden = !has;
  if (has) {
    renderCreditsMetrics(c);
    renderCreditsUsage(c);
    renderCreditsPkgs();
  } else {
    const tbody = $("#creditsPkgRows");
    if (tbody) tbody.replaceChildren();
  }

  const refreshBtn = $("#creditsRefreshBtn");
  if (refreshBtn) {
    refreshBtn.disabled = creditsDialog.loading;
    refreshBtn.textContent = creditsDialog.loading ? "刷新中…" : "刷新明细";
  }
}

async function refreshCreditsInDialog() {
  const uid = creditsDialog.uid;
  if (!uid || creditsDialog.loading) return;
  const req = ++creditsDialog.req;
  creditsDialog.loading = true;
  creditsDialog.error = "";
  creditsDialog.needRelogin = false;
  renderCreditsDialog();
  const r = await requestCredits(uid, true);
  // 请求期间弹窗已关闭/切换账号/发起了更新的一次刷新：丢弃本次结果。
  if (creditsDialog.req !== req || creditsDialog.uid !== uid) return;
  if (r.ok) applyCredits(uid, r.credits, r.nickname);
  creditsDialog.loading = false;
  if (r.ok) {
    creditsDialog.credits = r.credits;
    if (r.nickname) creditsDialog.nickname = String(r.nickname);
    creditsDialog.error = "";
    creditsDialog.needRelogin = false;
  } else {
    creditsDialog.error = r.error;
    creditsDialog.needRelogin = !!r.needRelogin;
    if (r.kind === "busy") toastCreditsBusy();
  }
  renderCreditsDialog();
}

function openCreditsDialog(uid) {
  const acct = accountByUid(uid);
  const dlg = $("#creditsDialog");
  if (!acct || !dlg) return;
  creditsDialog.uid = uid;
  creditsDialog.nickname = String(acct.nickname || uid);
  creditsDialog.credits =
    acct.credits && typeof acct.credits === "object" ? acct.credits : creditCache.get(uid) ?? null;
  creditsDialog.filter = "all";
  creditsDialog.sort = "expiry";
  creditsDialog.query = "";
  creditsDialog.loading = false;
  creditsDialog.error = "";
  creditsDialog.needRelogin = false;
  syncCreditsControls();
  renderCreditsDialog();
  if (!dlg.open) {
    try {
      dlg.showModal();
    } catch {}
  }
  // 秒开后立刻 refresh=1 一次：缓存可能已被后端更新（与 hub 行为一致）。
  refreshCreditsInDialog();
}

function closeCreditsDialog() {
  const dlg = $("#creditsDialog");
  creditsDialog.req++; // 关闭后在途刷新结果一律丢弃
  if (dlg?.open) dlg.close();
  creditsDialog.uid = "";
  creditsDialog.loading = false;
}

function wireCreditsDialog() {
  const dlg = $("#creditsDialog");
  if (!dlg) return;
  $("#creditsCloseBtn").addEventListener("click", closeCreditsDialog);
  $("#creditsDoneBtn").addEventListener("click", closeCreditsDialog);
  $("#creditsRefreshBtn").addEventListener("click", () => refreshCreditsInDialog());
  for (const b of $$("[data-credits-filter]")) {
    b.addEventListener("click", () => {
      const f = b.dataset.creditsFilter;
      if (!CREDITS_FILTERS.includes(f)) return;
      creditsDialog.filter = f;
      syncCreditsControls();
      renderCreditsPkgs();
    });
  }
  const search = $("#creditsSearch");
  if (search) {
    search.addEventListener("input", () => {
      creditsDialog.query = search.value;
      renderCreditsPkgs();
    });
  }
  const sort = $("#creditsSort");
  if (sort) {
    sort.addEventListener("change", () => {
      creditsDialog.sort = CREDITS_SORTS.includes(sort.value) ? sort.value : "expiry";
      renderCreditsPkgs();
    });
  }
  // 原生 close 事件是异步排队的：若已重新打开（快速切换账号），不要清掉新状态。
  dlg.addEventListener("close", () => {
    if (dlg.open) return;
    creditsDialog.req++;
    creditsDialog.uid = "";
    creditsDialog.loading = false;
  });
  // 点遮罩关闭（内容在 .credits-body 里，点中 dialog 本身即遮罩区域）
  dlg.addEventListener("click", (ev) => {
    if (ev.target === dlg) closeCreditsDialog();
  });
}

// ---- 连登管家 / 冻结账号（0.3.3，CONTRACT §10） -----------------------------------------
// 数据面（后端并行实现期间按「字段可能缺席」处理）：
//   GET  /api/streak?uid=<uid>&refresh=0|1 -> {uid, cached, streak|null, error?}
//   POST /api/streak/run {uids?}           -> {results:[{uid,outcome,earned,message,detail}]}
//   POST /api/account/unfreeze {uid}|{uids}-> {ok, unfrozen[], missing[]}
//   /api/state：accounts[].streak / accounts[].frozen / 顶层 frozen[] 都是只读投影。
// 容错铁律：streak / frozen 为 undefined（后端还没落地）一律按 null 处理 —— 显示「未查询」，
// 绝不抛错、绝不白屏；每个形状都先过 typeof / Array.isArray 守卫，缺字段不猜。
// 纪律：结果不静默 —— 查询失败写进按钮 title（同积分列口径），连登管家的每个账号结果
// 都同时进「行内状态行（state.streakRuns）」+ toast，轮询重绘后仍看得见。

const STREAK_TIERS = ["7d", "14d", "28d"];
const TIER_NAMES = { "7d": "7 天", "14d": "14 天", "28d": "28 天" };
// 档位状态：engine/streak.mjs 只有 locked / claimed / available（available 才兑换）；
// 上游将来给别的字符串原样展示，不硬映射成已知值。
const TIER_STATUS_TEXT = { available: "可兑换", claimed: "已兑换", locked: "未达成" };
// 三种状态必须一眼分得开（0.3.4）：可兑换 = 实心主色（可用态）、已兑换 = 成功色 + ✓、
// 未达成 = 中性灰弱化（透明底 + 灰边灰字）。未知状态走 .tier-unknown（中性虚线），
// 绝不落进成功色 —— 不把「不知道」显示成「已完成」。
const TIER_STATUS_CLS = { available: "tier-available", claimed: "tier-claimed", locked: "tier-locked" };
const TIER_STATUS_UNKNOWN_CLS = "tier-unknown";

// 本地已查到的连登状态：跨 /api/state 轮询保留（同 creditCache 的理由 —— 后端投影为 null /
// 尚未落地时，不会把刚查到的值刷回「未查询」）。
const streakCache = new Map(); // uid -> 连登状态

function streakNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// accounts[i].streak 的对象形状，或本地缓存；undefined / null / 非对象 → null（= 未查询）
function streakOf(a) {
  const s = a?.streak;
  if (s && typeof s === "object") return s;
  const c = streakCache.get(String(a?.uid ?? ""));
  return c && typeof c === "object" ? c : null;
}

function streakTierOf(st, tier) {
  const list = Array.isArray(st?.tiers) ? st.tiers : [];
  const hit = list.find((t) => String(t?.tier ?? "") === tier);
  return hit ? String(hit.status ?? "").trim() : "";
}

// accounts[i].frozen = {at, code, message}｜null；非空 = 已冻结（403 / 11140）。
// undefined → null；形状异常（布尔 / 裸字符串）也不抛错，按「已冻结 + 无详情」渲染。
function frozenOf(a) {
  const f = a?.frozen;
  if (f == null || f === false) return null;
  if (f === true) return {};
  if (typeof f === "object") return f;
  return { message: String(f) };
}

function frozenCode(f) {
  const c = f?.code;
  return c == null || c === "" ? "11140" : String(c);
}

// 冻结徽章：醒目红色（.badge-danger）；悬停给时间 / 原因 / 处置口径（CONTRACT §10.5）
function frozenBadge(f) {
  const b = badge(`已冻结（${frozenCode(f)}）`, "badge-danger");
  const at = f?.at ? fmtDateTime(f.at) : "时间未知";
  const why = String(f?.message ?? "").trim() || "上游返回 403 / code 11140";
  b.title = `冻结于 ${at}：${why}\n同设备连坐，需人工确认后恢复（点右侧「恢复」，冻结不会再自动解除）`;
  return b;
}

// 档位徽章：7d / 14d / 28d 三个状态；tiers 缺失时显示「未知」，不硬编造状态。
// 三种已知状态各有一枚专属 class（.tier-available / .tier-claimed / .tier-locked），
// 状态字符串不认识时原样显示，走 .tier-unknown（中性，非成功色）。
function streakTierBadges(st) {
  return STREAK_TIERS.map((tier) => {
    const status = streakTierOf(st, tier);
    const b = badge(
      `${TIER_NAMES[tier]}：${TIER_STATUS_TEXT[status] ?? (status || "未知")}`,
      TIER_STATUS_CLS[status] ?? TIER_STATUS_UNKNOWN_CLS,
    );
    b.title = status
      ? `连登 ${TIER_NAMES[tier]} 档：${status}（available 可兑换 / claimed 已兑换 / locked 未达成）`
      : `连登 ${TIER_NAMES[tier]} 档：上游未给出状态`;
    return b;
  });
}

// 连登日历：纯 CSS grid 小格子（7 列 = 周一…周日），默认折叠（避免账号行过高）。
// 上游一次给一整年（365 格），全渲染。
// 每格 title = 日期 + score；score=0 淡色，>0 按固定阈值分 3 档深浅（阈值写死在 heatLevel，
// 与上游数值量级无关，只做视觉分档）。日历数据只读后端给的 heatmap 数组，前端不自己算区间。
const HEAT_WEEK = ["一", "二", "三", "四", "五", "六", "日"];

function heatLevel(score) {
  const s = streakNum(score);
  if (s <= 0) return 0;
  if (s <= 2) return 1;
  if (s <= 5) return 2;
  return 3;
}

// 北京日期 "YYYY-MM-DD" 的星期（0=周日）。用 Date.UTC 解析：本地时区在东八区以西时
// new Date("YYYY-MM-DD") 会退到前一天，getDay() 就错一列。
function dayOfWeek(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr ?? "").trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d.getUTCDay();
}

// 日历显示窗口（天）。上游 /activity/growth/heatmap 一次回**一整年** 365 格，
// 全铺出来在账号行里是 53 行、807px 高的细长条，而且近期才有分的格子全压在底部 ——
// 看着就像布局坏了（2026-11-11 实测确认：网格与配色本身没错，是窗口太大）。
// 只渲染最近 28 天（正好对齐 28d 档位的口径）：4–5 行、约 75px 高。
const HEAT_WINDOW_DAYS = 28;

function heatmapBlock(a, st) {
  const uid = String(a.uid ?? "");
  const all = (Array.isArray(st?.heatmap) ? st.heatmap : [])
    .map((h) => ({ date: String(h?.date ?? "").trim(), score: streakNum(h?.score) }))
    .filter((h) => h.date);
  // 上游按日期升序返回，取尾部 = 最近 28 天
  const cells = all.slice(-HEAT_WINDOW_DAYS);
  const details = el("details", { class: "heat", dataset: { heat: uid } });
  if (state.heatOpen.has(uid)) details.open = true;
  const hit = cells.filter((h) => h.score > 0).length;
  const total = cells.reduce((n, h) => n + h.score, 0);
  // 全年口径的一年一次统计只放在汇总文案里（不渲染出来），免得又变成细长条
  const yearHit = all.filter((h) => h.score > 0).length;
  const summary = el(
    "summary",
    {
      class: "heat-summary",
      title: `连登日历：每格一天，颜色越深当天连登分越高（只画最近 ${HEAT_WINDOW_DAYS} 天；上游一次给一整年）`,
    },
    el("span", { class: "heat-label", text: `连登日历 · 近 ${HEAT_WINDOW_DAYS} 天` }),
    el("span", {
      class: "heat-meta",
      text: cells.length
        ? `${hit}/${cells.length} 天有记录 · 合计 ${total}${all.length > cells.length ? ` · 全年 ${yearHit} 天` : ""}`
        : "无数据",
    }),
  );
  const grid = el("div", { class: "heat-grid" });
  for (const w of HEAT_WEEK) grid.append(el("span", { class: "heat-w", text: w, "aria-hidden": "true" }));
  if (!cells.length) {
    grid.append(el("span", { class: "heat-none", text: "暂无日历数据（点账号行「刷新快照」读取）" }));
  } else {
    // 周一起排：周日(0) 要补 6 格，其它补 dow-1 格
    const dow = dayOfWeek(cells[0].date);
    const lead = dow == null ? 0 : (dow + 6) % 7;
    for (let i = 0; i < lead; i++) grid.append(el("span", { class: "heat-pad", "aria-hidden": "true" }));
    for (const c of cells) {
      grid.append(
        el("span", {
          class: `heat-cell heat-l${heatLevel(c.score)}`,
          title: `${c.date} · score ${c.score}`,
          "aria-label": `${c.date} score ${c.score}`,
        }),
      );
    }
  }
  details.append(summary, el("div", { class: "heat-body" }, grid));
  // 折叠状态存进 state：renderAccounts 每 3s 重建 DOM，不记就每次都被折回去
  details.addEventListener("toggle", () => {
    if (details.open) state.heatOpen.add(uid);
    else state.heatOpen.delete(uid);
  });
  return details;
}

// 连登日历面板（0.3.4）：从账号行的连登块搬进「任务明细」详情里（任务表上方）。
// 单独包一层带锚点的 div（[data-heat-cell]），好让连登查询后就地替换这一块，
// 不必整行重绘（整行重绘会打散任务勾选与展开状态）。日历本身仍是默认折叠的 <details>，
// 展开状态按 uid 记在 state.heatOpen —— 3 秒轮询重建 DOM 不会把它折回去。
function heatPanel(a) {
  const uid = String(a.uid ?? "");
  return el("div", { class: "heat-panel", dataset: { heatCell: uid } }, heatmapBlock(a, streakOf(a)));
}

// 账号单元格里的「连登」两行（0.3.4）：昵称右边紧跟 —— 第 1 行数字（连登 / 补签卡 / 抽奖），
// 第 2 行三档状态徽章。原来是账号网格下方一整条 .acct-streak：查询 / 连登管家两个按钮没了
// （连登查询并进「刷新快照」，连登管家在批量操作条上），日历搬进了「任务明细」。
// 锚点仍是 [data-streak-cell="uid"]，updateStreakArea() 依赖它 replaceWith 局部重绘，
// 所以它必须**唯一存在**（一个账号一个）。
// 额外说明行（冻结 / 最近一次连登管家结果 / 连登查询失败）只在有内容时追加，
// 正常情况就是干净的两行；不静默、也不凭空多占行高。
function streakCellBlock(a) {
  const uid = String(a.uid ?? "");
  const st = streakOf(a);
  const err = state.streakErrors.get(uid);
  const run = state.streakRuns.get(uid);
  const frozen = frozenOf(a);
  const kids = [];

  if (!st) {
    // 未查询就如实说未查询（后端还没落地 / 还没查过），绝不拿 0 冒充「连登 0 天」。
    kids.push(el("span", { class: "streak-line streak-empty", text: "连登：未查询" }));
    kids.push(el("span", { class: "streak-line streak-empty", text: "档位：未查询" }));
  } else {
    const updated = String(st.updatedISO ?? "").trim();
    kids.push(
      el(
        "span",
        {
          class: "streak-line",
          title: updated ? `更新于 ${fmtDateTime(updated)}` : "上游未给更新时间",
        },
        el(
          "span",
          { class: "streak-item", title: "连登天数（streak.days）" },
          "连登 ",
          el("b", { class: "streak-v", text: `${streakNum(st.days)} 天` }),
        ),
        " · ",
        el(
          "span",
          { class: "streak-item", title: "补签卡余额（makeup_cards.balance）：>0 且昨日为 0 才补签" },
          "补签卡 ",
          el("b", { class: "streak-v", text: String(streakNum(st.makeupCards)) }),
        ),
        " · ",
        el(
          "span",
          { class: "streak-item", title: "抽奖机会（lottery/summary 的 chances）：为 0 时连登管家不抽" },
          "抽奖 ",
          el("b", { class: "streak-v", text: `${streakNum(st.lotteryChances)} 次` }),
        ),
      ),
      el("span", { class: "streak-line streak-tiers" }, ...streakTierBadges(st)),
    );
    // 全部子请求都失败时 streak 里带 ok:false + error（部分失败仍是 ok:true）——如实说出来
    if (st.ok === false && st.error) {
      kids.push(el("span", { class: "streak-note streak-err warn-text", text: `上游读取失败：${String(st.error)}` }));
    }
  }

  if (frozen) {
    const t = `已冻结（${frozenCode(frozen)}）：批量操作 / 排程 / 签到 / 连登管家都会跳过它；显式点到会如实失败。确认风险解除后点「恢复」。`;
    kids.push(el("span", { class: "streak-note warn-text", text: t, title: t }));
  }
  // 最近一次「连登管家」结果（含批量那次）：原来在连登条上，现在跟在两行信息后面
  // （账号单元格窄，CSS 限两行 + title 给全文，行高不被一句长文案顶起来）
  if (run) {
    kids.push(
      el("span", {
        class: run.ok ? "streak-note streak-run" : "streak-note streak-run warn-text",
        text: run.text,
        title: run.text,
      }),
    );
  }
  // 连登查询失败（含「刷新快照」顺带补查时失败）：按钮没了，失败原因就落在这里，不弹错也不吞掉
  if (err) {
    const t = `连登查询失败：${err}`;
    kids.push(el("span", { class: "streak-note streak-err warn-text", text: t, title: t }));
  }
  return el("div", { class: "acct-streak", dataset: { streakCell: uid } }, ...kids);
}

// 只重绘连登区（同 updateCreditsCell 的理由：不打散任务勾选 / 折叠 / 输入焦点）。
// 两个锚点：[data-streak-cell]（昵称右侧两行）+ [data-heat-cell]（任务明细里的日历面板）。
function updateStreakArea(uid) {
  const acct = accountByUid(uid);
  if (!acct) return;
  const box = $(`[data-streak-cell="${uid}"]`);
  if (box) box.replaceWith(streakCellBlock(acct));
  const heat = $(`[data-heat-cell="${uid}"]`);
  if (heat) heat.replaceWith(heatPanel(acct));
}

function applyStreak(uid, streak) {
  const acct = accountByUid(uid);
  if (acct) acct.streak = streak;
  if (streak && typeof streak === "object") streakCache.set(uid, streak);
  state.streakErrors.delete(uid);
  updateStreakArea(uid);
}

// HTTP 错误 / 空返回统一转成可渲染结果，绝不抛（调用方不用 try/catch）。
async function requestStreak(uid, refresh) {
  try {
    const d = await api("api/streak", { params: { uid, refresh: refresh ? 1 : 0 } });
    const s = d?.streak;
    if (s && typeof s === "object") return { ok: true, streak: s };
    // streak:null + error = 上游读不到；streak:null 无 error = 该账号还没查过（后端也没缓存）
    return { ok: false, kind: "empty", error: humanizeApiErr(String(d?.error || "上游没有返回连登状态"), d?.hint) };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 409) return { ok: false, kind: "busy", error: "批量任务运行中，稍后再查" };
      if (e.status === 404) {
        // 「未知 API：GET /api/streak」= 老守护进程没有这个路由（版本落后，改写成人话）；
        // 其余 404 = 账号不存在。两者都如实说，后者保留原文兜底。
        const hasBody = e.message && e.message !== "HTTP 404";
        return {
          ok: false,
          kind: "absent",
          error: hasBody
            ? humanizeApiErr(e.message, e.data?.hint)
            : "账号不存在，或 /api/streak 还没实现（后端需 0.3.3）",
        };
      }
      return { ok: false, kind: "http", error: humanizeApiErr(e.message || `HTTP ${e.status}`, e.data?.hint) };
    }
    if (e && e.network) return { ok: false, kind: "network", error: "连不上守护进程" };
    return { ok: false, kind: "error", error: humanizeApiErr(String((e && e.message) || e)) };
  }
}

// 查询连登状态（refresh=1；是否真打上游由 daemon 的 10 分钟缓存定）。
// 0.3.4：账号行里的「查询 / 重新查询」按钮取消 —— 唯一触发点是单账号「刷新快照」的顺带补查，
// 所以默认 silent：不弹任何 toast；批量任务在跑时 daemon 回 409 busy → 静默跳过（连错误行都不留）。
// 其它失败仍如实写进 state.streakErrors，由连登区那行「连登查询失败：…」显示（不弹错 ≠ 吞掉）。
// silent:false 留给「将来若再给显式查询入口」用（显式点击要即时反馈）。
async function queryStreak(uid, { silent = true } = {}) {
  if (state.streakBusy.has(uid)) return { ok: false, kind: "pending", error: "正在查询连登状态" };
  state.streakBusy.add(uid);
  updateStreakArea(uid);
  try {
    const r = await requestStreak(uid, true);
    const who = accountByUid(uid)?.nickname || uid;
    if (r.ok) {
      applyStreak(uid, r.streak);
      if (!silent) {
        const s = r.streak;
        toast(`${who}：连登 ${streakNum(s.days)} 天 · 补签卡 ${streakNum(s.makeupCards)} · 抽奖 ${streakNum(s.lotteryChances)} 次`);
      }
      return r;
    }
    // 批量任务在跑：静默跳过（刷新快照的主动作不该被这条补查带出错误提示）
    if (silent && r.kind === "busy") return r;
    state.streakErrors.set(uid, r.error);
    if (!silent) {
      if (r.kind === "busy") toastCreditsBusy();
      else toast(`${who}：连登查询失败 —— ${r.error}`, "warn", 8000);
    }
    return r;
  } finally {
    state.streakBusy.delete(uid);
    updateStreakArea(uid);
  }
}

// 「连登管家」结果 → 一行中文（CONTRACT §10.2 的 results[i]）。
// 只认契约字段：outcome ok|skipped|failed、earned、message、detail{makeupUsed,makeupDate,
// gifts[],redeemed[],drawn}；缺字段不猜、不抛。纯函数（导出仅供 Node 下校验）。
export function streakResultText(r, who) {
  const name = String(who || r?.uid || "账号");
  const outcome = String(r?.outcome ?? "");
  const detail = r?.detail && typeof r.detail === "object" ? r.detail : {};
  const bits = [];
  if (detail.makeupUsed) bits.push(`补签 ${String(detail.makeupDate ?? "").trim() || "昨日"}`);
  // 礼包只报名字：金额统一走 earned（后端已汇总，避免同一笔积分报两遍）
  for (const g of Array.isArray(detail.gifts) ? detail.gifts : []) {
    if (g == null) continue;
    const gn = String(g?.name ?? "").trim();
    if (gn) bits.push(gn);
  }
  const redeemed = (Array.isArray(detail.redeemed) ? detail.redeemed : [])
    .map((t) => TIER_NAMES[String(t)] ?? String(t))
    .filter(Boolean);
  if (redeemed.length) bits.push(`兑换 ${redeemed.join(" / ")}档`);
  const drawn = streakNum(detail.drawn);
  if (drawn > 0) bits.push(`抽奖 ${drawn} 次`);
  const earned = streakNum(r?.earned);
  if (earned > 0) bits.push(`+${fmtNum(earned)} 积分`);
  // outcome 只认契约三值；其它/缺失一律「结果未知」—— 绝不把未知说成成功
  const head = outcome === "failed" ? "失败" : outcome === "skipped" ? "跳过" : outcome === "ok" ? "完成" : "结果未知";
  const tail = bits.length ? `：${bits.join(" · ")}` : "";
  const msg = String(r?.message ?? "").trim();
  // 失败 / 跳过时 message 是重点（冻结原因、企业版说明…）；成功且有明细时不重复 message
  const msgPart = msg && (outcome !== "ok" || !bits.length) ? `（${msg}）` : "";
  return `${name}：连登管家${head}${tail}${msgPart}`;
}

// （0.3.5 §11.5）连登管家改走 job 后，各行「最近一次连登管家结果」由 job 的 streak 腿步骤渲染
//（rememberStreakStep / settleTrackedJob），不再有 /api/streak/run 的 results[] 可合并 —— 原
// mergeStreakDetail / rememberStreakRun 随之删除。streakResultText 保留为契约形状的纯函数出口。

// 0.3.4：账号行里的「连登管家」按钮已删（用户口径：连登管家在批量条上已经有一个了）。
// 单账号要跑就连登写清 uid 走批量接口 POST /api/streak/run {uids:[uid]}；界面入口统一在批量条。

// 批量「连登管家」（批量操作条）：作用于勾选账号；未勾选 = 全部可参与账号（同 /api/run 口径）。
// 0.3.5（CONTRACT §11.5）：改走 job（POST /api/run {legs:["streak"]}），实时步骤 / 日志由既有 SSE 推给
// 「实时进度」区，结果进「历史」，与「批量做任务」完全同款；不再从看板调 POST /api/streak/run（该路由保留给 MCP / 外部）。
async function runStreakSelected() {
  await withBusy(async () => {
    const uids = [...state.selected];
    const body = { legs: ["streak"] };
    if (uids.length) body.uids = uids;
    setBatchStatus(`正在启动连登管家：${uids.length ? `${uids.length} 个账号` : "全部可参与账号"}（补签 → 礼包/补偿 → 档位兑换 → 抽奖）…`);
    try {
      const r = await api("api/run", { method: "POST", body });
      const jobId = r?.job?.id ? String(r.job.id) : "";
      state.streakJobId = jobId; // 收尾时按该轮的 streak 腿步骤回填各行最近一次结果
      setBatchStatus(`已启动 ${jobId || "连登管家"}：进度见「实时进度」区（SSE 推送）。`);
      state.lastFinished = null;
      await loadState();
      connectSSE();
    } catch (e) {
      setBatchStatus("");
      humanErr(e, "启动连登管家失败");
    }
  });
}

// 冻结总览：优先用顶层 frozen[]（CONTRACT §10.3），缺席时回退 accounts[].frozen。
// 只出 [{uid, nickname, at, code, message}]；两处都不存在 = 空数组（老后端）。
function frozenRows() {
  const out = [];
  const seen = new Set();
  const top = state.data?.frozen;
  if (Array.isArray(top)) {
    for (const item of top) {
      const f = item && typeof item === "object" ? item : null;
      const uid = String(f?.uid ?? (typeof item === "string" ? item : "")).trim();
      if (!uid || seen.has(uid)) continue;
      seen.add(uid);
      out.push({ uid, nickname: String(f?.nickname ?? ""), at: f?.at, code: f?.code, message: f?.message });
    }
  }
  for (const a of state.data?.accounts ?? []) {
    const uid = String(a?.uid ?? "");
    if (!uid || seen.has(uid)) continue;
    const f = frozenOf(a);
    if (!f) continue;
    seen.add(uid);
    out.push({ uid, nickname: String(a?.nickname ?? ""), at: f.at, code: f.code, message: f.message });
  }
  return out;
}

// 批量区的冻结提示条：N 个账号已冻结 + 「全部恢复」。冻结账号不进排程 / 批量缺省目标，
// 显式点到会如实失败（§10.5）—— 所以这里必须显式说出来，不能让它悄悄消失。
function renderFrozenNote() {
  const box = $("#frozenNote");
  if (!box) return;
  const rows = frozenRows();
  box.replaceChildren();
  if (!rows.length) {
    box.hidden = true;
    return;
  }
  const names = rows.map((r) => r.nickname || r.uid);
  box.hidden = false;
  box.append(
    el("span", {
      class: "frozen-text warn-text",
      text: `${rows.length} 个账号已冻结（${names.slice(0, 3).join("、")}${names.length > 3 ? " 等" : ""}）`,
      title: "冻结 = 上游 403 / code 11140：同设备账号会连坐，需人工确认后在账号行点「恢复」",
    }),
    el("button", {
      type: "button",
      class: "mini-btn",
      id: "btnUnfreezeAll",
      text: "全部恢复",
      title: "POST /api/account/unfreeze {uids}：确认风险已解除后再恢复（会被二次确认）",
      onclick: () => unfreezeSelected(),
    }),
  );
}

// 单账号恢复：POST /api/account/unfreeze {uid}（幂等；missing = 本来就没冻结）
async function unfreezeOne(uid) {
  if (state.unfreezing.has(uid)) return;
  const who = accountByUid(uid)?.nickname || uid;
  state.unfreezing.add(uid);
  renderAccounts();
  try {
    const r = await api("api/account/unfreeze", { method: "POST", body: { uid } });
    const missing = (Array.isArray(r?.missing) ? r.missing : []).map((x) => String(x));
    toast(
      missing.includes(uid)
        ? `${who}：本来就没有冻结（无需恢复）`
        : `${who}：已恢复 —— 冻结解除，可重新参与批量操作与排程`,
    );
    await loadState();
  } catch (e) {
    humanErr(e, "恢复失败");
  } finally {
    state.unfreezing.delete(uid);
    renderAccounts();
  }
}

// 批量恢复：POST /api/account/unfreeze {uids}（先二次确认：解冻是风控决定，不能手滑）
async function unfreezeSelected() {
  const rows = frozenRows();
  if (!rows.length) {
    toast("当前没有已冻结的账号。");
    return;
  }
  const names = rows.map((r) => r.nickname || r.uid).join("、");
  const ok = confirm(
    `恢复 ${rows.length} 个已冻结账号？\n\n${names}\n\n冻结来自上游 403 / code 11140，同设备账号会连坐：请先确认风险已解除再恢复。恢复后它们会重新进入批量操作与排程。`,
  );
  if (!ok) return;
  const uids = rows.map((r) => r.uid);
  for (const u of uids) state.unfreezing.add(u);
  renderAccounts();
  try {
    const r = await api("api/account/unfreeze", { method: "POST", body: { uids } });
    const unfrozen = (Array.isArray(r?.unfrozen) ? r.unfrozen : []).length;
    const missing = (Array.isArray(r?.missing) ? r.missing : []).length;
    toast(`已恢复 ${unfrozen} 个账号${missing ? `；${missing} 个本来就没冻结` : ""}`);
    await loadState();
  } catch (e) {
    humanErr(e, "批量恢复失败");
  } finally {
    for (const u of uids) state.unfreezing.delete(u);
    renderAccounts();
  }
}

// 账号行里的「恢复」按钮（冻结时替换掉普通操作；刷新快照按钮保留在下一行位置由 sideCell 决定）
function unfreezeButton(uid) {
  const busy = state.unfreezing.has(uid);
  return el("button", {
    type: "button",
    class: "mini-btn danger-btn",
    dataset: { unfreeze: uid },
    text: busy ? "恢复中…" : "恢复",
    disabled: busy,
    title: "POST /api/account/unfreeze {uid}：解除该账号的 403/11140 冻结（确认风险已解除再点）",
    onclick: () => unfreezeOne(uid),
  });
}

// ---- 运营活动任务（0.3.5，CONTRACT §11.1） ------------------------------------------------
// 数据面（后端并行实现期间按「字段可能缺席」处理）：
//   GET  /api/campaign?uid=<uid>&refresh=0|1 -> {uid, cached, campaign|null, error?}
//   POST /api/campaign/run {uids?}           -> {results:[{uid,outcome,earned,message,detail}]}
//   /api/state：accounts[].campaign 是只读投影。
// 容错铁律：campaign 为 undefined（后端还没落地）一律按 null 处理 —— 显示「未查询」，
// 绝不抛错、绝不白屏；每个形状先过 typeof / Array.isArray 守卫，缺字段不猜。
// 与连登同款纪律：查询失败写进条内说明行（不弹错）；运行结果进 state.campaignRuns
// + toast，轮询重绘后仍看得见；活动任务与成长任务解耦（独立契约，不进任务快照）。

// 本地已查到的活动任务状态：跨 /api/state 轮询保留（后端投影为 null / 尚未落地时，
// 不会把刚查到的值刷回「未查询」）。
const campaignCache = new Map(); // uid -> 活动任务状态

function campaignNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// accounts[i].campaign 的对象形状，或本地缓存；undefined / null / 非对象 → null（= 未查询）
function campaignOf(a) {
  const c = a?.campaign;
  if (c && typeof c === "object") return c;
  const cached = campaignCache.get(String(a?.uid ?? ""));
  return cached && typeof cached === "object" ? cached : null;
}

// 活动列表（只读契约字段 activities[]，缺字段归一 []）
function campaignActivities(st) {
  return Array.isArray(st?.activities)
    ? st.activities.filter((x) => x && typeof x === "object")
    : [];
}

// 任务是否已领（claimedAt 非空）。
function campaignTaskClaimed(t) {
  return String(t?.claimedAt ?? "").trim() !== "";
}

// 活动已领数：claimed 是数字就用它；null / "" / 缺失（没给）退回按任务的 claimedAt 计数
// —— 不把「没给」当 0。
function campaignClaimedCount(act) {
  const tasks = Array.isArray(act?.tasks) ? act.tasks : [];
  const hasCount = act?.claimed != null && act.claimed !== "" && Number.isFinite(Number(act.claimed));
  return hasCount ? campaignNum(act.claimed) : tasks.filter(campaignTaskClaimed).length;
}

// 活动是否「已完成」（CONTRACT §11.5 口径）：可领 0 且全部任务 claimedAt 非空。
// 没有任务的活动（tasks 为空）按「全部已领」成立，也归入已完成 —— 没什么可做的就该折叠下去。
function campaignActDone(act) {
  if (campaignNum(act?.claimable) !== 0) return false;
  const tasks = Array.isArray(act?.tasks) ? act.tasks : [];
  return tasks.every(campaignTaskClaimed);
}

// 活动排序：未完成在前、已完成在后（稳定：同组保持后端给的原始顺序）。
function campaignSortedActivities(acts) {
  return acts
    .map((act, i) => ({ act, i }))
    .sort((a, b) => (campaignActDone(a.act) ? 1 : 0) - (campaignActDone(b.act) ? 1 : 0) || a.i - b.i)
    .map((x) => x.act);
}

// 活动内任务排序：未领在前、已领在后（稳定）。
function campaignSortedTasks(tasks) {
  return tasks
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (campaignTaskClaimed(a.t) ? 1 : 0) - (campaignTaskClaimed(b.t) ? 1 : 0) || a.i - b.i)
    .map((x) => x.t);
}

// 一行汇总文案 `活动任务：星巴克协作 2/3 · 可领 1` 与账号行活动摘要条已随「账号行的活动任务块」
// 一起移除（用户 2026-11-13）：活动任务现在只在任务明细的「活动任务」分组里，分组标题右侧的
// 「跑一轮活动任务」按钮是唯一入口（见 fillCampaignGroup / campaignStatusNote）。

// 「跑一轮活动任务」按钮（CONTRACT §11.6 第 6 条）：只出现在「活动任务」分组标题右侧。
// 触发同一路径 POST /api/run {uids:[uid], legs:["campaign"]}（起 job，实时进度走既有 SSE）。
function campaignRunButton(a) {
  const uid = String(a.uid ?? "");
  const busy = state.campaignBusy.has(uid) || campaignJobRunning(uid);
  return el("button", {
    type: "button",
    class: "mini-btn campaign-btn",
    dataset: { campaignRun: uid },
    text: busy ? "运行中…" : "跑一轮活动任务",
    disabled: busy,
    title:
      'POST /api/run {uids:[uid], legs:["campaign"]}：起一轮 job，只对这一个账号跑运营活动任务' +
      "（真实写动作），实时步骤 / 日志见「实时进度」区（SSE 推送）。活动任务与成长任务解耦，独立跑、独立记账。",
    onclick: (ev) => {
      // 分组标题头里也可能被点击：不连带其它默认行为
      if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
      if (ev && typeof ev.stopPropagation === "function") ev.stopPropagation();
      runCampaignOne(uid);
    },
  });
}

// 活动数据更新时就地重绘该账号的账号行：活动明细现在只在任务明细「活动任务」分组里，重绘整
// 账号行最省事。勾选 / 任务明细展开 / 「已完成」折叠 / 连登日历展开等状态都记在 state 里，
// 重绘即还原，不打散用户正在做的事（[data-acct="uid"] 锚点在 accountRow 上）。
function updateCampaignArea(uid) {
  const acct = accountByUid(uid);
  if (!acct) return;
  const row = $(`[data-acct="${uid}"]`);
  if (row) row.replaceWith(accountRow(acct));
}

function applyCampaign(uid, campaign) {
  const acct = accountByUid(uid);
  if (acct) acct.campaign = campaign;
  if (campaign && typeof campaign === "object") campaignCache.set(uid, campaign);
  state.campaignErrors.delete(uid);
  updateCampaignArea(uid);
}

// HTTP 错误 / 空返回统一转成可渲染结果，绝不抛（调用方不用 try/catch）。
async function requestCampaign(uid, refresh) {
  try {
    const d = await api("api/campaign", { params: { uid, refresh: refresh ? 1 : 0 } });
    const c = d?.campaign;
    if (c && typeof c === "object") return { ok: true, campaign: c };
    // campaign:null + error = 上游读不到；campaign:null 无 error = 该账号还没查过（后端也没缓存）
    return { ok: false, kind: "empty", error: humanizeApiErr(String(d?.error || "上游没有返回活动任务状态"), d?.hint) };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 409) return { ok: false, kind: "busy", error: "批量任务运行中，稍后再查" };
      if (e.status === 404) {
        const hasBody = e.message && e.message !== "HTTP 404";
        return {
          ok: false,
          kind: "absent",
          error: hasBody
            ? humanizeApiErr(e.message, e.data?.hint)
            : "账号不存在，或 /api/campaign 还没实现（后端需 0.3.5）",
        };
      }
      return { ok: false, kind: "http", error: humanizeApiErr(e.message || `HTTP ${e.status}`, e.data?.hint) };
    }
    if (e && e.network) return { ok: false, kind: "network", error: "连不上守护进程" };
    return { ok: false, kind: "error", error: humanizeApiErr(String((e && e.message) || e)) };
  }
}

// 查询活动任务状态（refresh=1；是否真打上游由 daemon 的 10 分钟缓存定）。
// 与连登完全同款：唯一触发点是单账号「刷新快照」的顺带补查（默认 silent）；
// 批量任务在跑时 daemon 回 409 busy → 静默跳过（连错误行都不留）。
// 其它失败仍如实写进 state.campaignErrors，由活动任务条那行显示（不弹错 ≠ 吞掉）。
async function queryCampaign(uid, { silent = true } = {}) {
  if (state.campaignBusy.has(uid)) return { ok: false, kind: "pending", error: "正在查询活动任务" };
  state.campaignBusy.add(uid);
  updateCampaignArea(uid);
  try {
    const r = await requestCampaign(uid, true);
    if (r.ok) {
      applyCampaign(uid, r.campaign);
      return r;
    }
    if (silent && r.kind === "busy") return r;
    state.campaignErrors.set(uid, r.error);
    return r;
  } finally {
    state.campaignBusy.delete(uid);
    updateCampaignArea(uid);
  }
}

// 「活动任务」结果 → 一行中文（CONTRACT §11.1 的 results[i]）。
// 只认契约字段：outcome ok|skipped|failed、earned、message、detail{activities[],claimed[],unavailable[]}；
// 缺字段不猜、不抛。纯函数（导出仅供 Node 下校验）。
export function campaignResultText(r, who) {
  const name = String(who || r?.uid || "账号");
  const outcome = String(r?.outcome ?? "");
  const detail = r?.detail && typeof r.detail === "object" ? r.detail : {};
  const bits = [];
  const earned = campaignNum(r?.earned);
  if (earned > 0) bits.push(`+${fmtNum(earned)} 积分`);
  const claimed = Array.isArray(detail.claimed) ? detail.claimed.length : 0;
  if (claimed > 0) bits.push(`新领 ${claimed} 项`);
  const unavailable = Array.isArray(detail.unavailable) ? detail.unavailable.length : 0;
  if (unavailable > 0) bits.push(`${unavailable} 项不可用`);
  // 活动明细计数（形状未定，容错）：activities[].viewed/fired/claimed 是数字时汇总
  const acts = Array.isArray(detail.activities) ? detail.activities : [];
  const fired = acts.reduce((n, act) => n + campaignNum(act?.fired), 0);
  if (fired > 0) bits.push(`点亮 ${fired} 项`);
  // outcome 只认契约三值；其它/缺失一律「结果未知」—— 绝不把未知说成成功
  const head = outcome === "failed" ? "失败" : outcome === "skipped" ? "跳过" : outcome === "ok" ? "完成" : "结果未知";
  const tail = bits.length ? `：${bits.join(" · ")}` : "";
  const msg = String(r?.message ?? "").trim();
  // 失败 / 跳过时 message 是重点（冻结原因…）；成功且有明细时不重复 message
  const msgPart = msg && (outcome !== "ok" || !bits.length) ? `（${msg}）` : "";
  return `${name}：活动任务${head}${tail}${msgPart}`;
}

// 从 job 的步骤里取某账号某腿的最后一条（该腿的 campaign 步骤：状态 + detail）。
function jobStepFor(job, uid, leg) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  let found = null;
  for (const s of steps) {
    if (String(s?.uid ?? "") === String(uid) && String(s?.leg ?? "") === leg) found = s;
  }
  return found;
}

// job 步骤状态 → 人话（与 stepBadge 同一套取值；未知一律「结果未知」，绝不冒充成功）。
function stepOutcomeHead(stateName) {
  if (stateName === "fail") return "失败";
  if (stateName === "skip") return "跳过";
  if (stateName === "restricted") return "风控冷却";
  if (stateName === "ok") return "完成";
  return "结果未知";
}

// 该账号这一轮活动任务是否还在跑：由 job 状态驱动（/api/state 的 job / SSE 的 job 事件），
// job 结束后 state.data.job 为空 → 自动恢复。
// ① 本看板起的那一轮（state.campaignJobIds 记录在案）；② 兜底：当前 job 只跑 campaign 腿且点名了该账号
//   （页面刷新后本地记录丢了也认得出，避免运行期间按钮又变可点）。
function campaignJobRunning(uid) {
  const j = state.data?.job;
  if (!j) return false;
  const key = String(uid);
  const tracked = state.campaignJobIds.get(key);
  if (tracked && tracked === String(j.id ?? "")) return true;
  const legs = Array.isArray(j.spec?.legs) ? j.spec.legs : Array.isArray(j.legs) ? j.legs : [];
  if (!legs.length || legs.some((l) => l !== "campaign")) return false;
  const uids = Array.isArray(j.spec?.uids) ? j.spec.uids.map(String) : null;
  if (uids && uids.includes(key)) return true;
  return Array.isArray(j.steps) && j.steps.some((s) => String(s?.uid ?? "") === key && String(s?.leg ?? "") === "campaign");
}

// 用 job 步骤回填「该账号最近一次活动任务结果」那一行（批量条那套手法：结果来自 job.steps，不再是 results[]）。
function rememberCampaignStep(uid, job, who) {
  const key = String(uid ?? "").trim();
  const step = jobStepFor(job, uid, "campaign");
  if (!key || !step) return null;
  const stateName = String(step.state ?? "");
  const detail = String(step.detail ?? "").trim();
  const ok = stateName !== "fail" && stateName !== "restricted";
  const text = `${who}：活动任务${stepOutcomeHead(stateName)}${detail ? `：${detail}` : ""}`;
  state.campaignRuns.set(key, { ok, text });
  return { ok, text };
}

// 「连登管家」job 收尾：把该轮 streak 腿步骤回填到各账号的最近一次结果行（保住既有那行，不因改走 job 而空掉）。
function rememberStreakStep(uid, job, who) {
  const key = String(uid ?? "").trim();
  const step = jobStepFor(job, uid, "streak");
  if (!key || !step) return null;
  const stateName = String(step.state ?? "");
  const detail = String(step.detail ?? "").trim();
  const ok = stateName !== "fail" && stateName !== "restricted";
  state.streakRuns.set(key, { ok, text: `${who}：连登管家${stepOutcomeHead(stateName)}${detail ? `：${detail}` : ""}` });
  return { ok };
}

// job 收尾统一处理（SSE 收尾广播 / 轮询兜底都走这里）：
//   ① 活动任务：清掉本地 job 记录 → 从步骤回填结果行 → 主动补查一次活动缓存（后端 finishJob 也会刷，这里双保险；409 busy 静默跳过）；
//   ② 连登管家：清掉 job 记录 → 从步骤回填各行结果行。
function settleTrackedJob(job) {
  if (!job || !job.id) return;
  const jobId = String(job.id);
  for (const [uid, id] of [...state.campaignJobIds]) {
    if (id !== jobId) continue;
    state.campaignJobIds.delete(uid);
    const who = accountByUid(uid)?.nickname || uid;
    rememberCampaignStep(uid, job, who);
    // 主动查一次明细（refresh=1）：成功就覆盖本地缓存并重绘；busy 静默跳过，其它失败照旧落条内说明行
    queryCampaign(uid, { silent: true });
    updateCampaignArea(uid);
  }
  if (state.streakJobId && state.streakJobId === jobId) {
    state.streakJobId = "";
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const s of steps) {
      if (String(s?.leg ?? "") !== "streak") continue;
      const uid = String(s?.uid ?? "");
      if (!uid) continue;
      rememberStreakStep(uid, job, accountByUid(uid)?.nickname || uid);
    }
  }
}

// job 收尾兜底（SSE 掉线只剩 3 秒轮询时）：/api/state 的 job 从「有」变「无」= 上一轮结束了。
function reconcileJobs() {
  const id = state.data?.job?.id ? String(state.data.job.id) : "";
  const prev = state.lastSeenJobId;
  if (prev && prev !== id) {
    const finished = state.lastFinished && String(state.lastFinished.id ?? "") === prev ? state.lastFinished : null;
    settleTrackedJob(finished ?? { id: prev, steps: [] });
  }
  state.lastSeenJobId = id;
}

// 单账号「跑一轮活动任务」：POST /api/run {uids:[uid], legs:["campaign"]}（与「批量做任务」同款，走 job）。
// 实时步骤 / 日志由既有 SSE 推给「实时进度」区；按钮由 job 状态驱动禁用 / 恢复；结果从 job 的
// campaign 腿步骤回填进行内说明行；job 结束后由 settleTrackedJob 补查一次活动明细。
async function runCampaignOne(uid) {
  const who = accountByUid(uid)?.nickname || uid;
  if (state.campaignBusy.has(uid) || campaignJobRunning(uid)) return;
  state.campaignBusy.add(uid); // 起 job 的这次请求期间先显示「运行中…」，拿到 job id 后交给 job 状态驱动
  updateCampaignArea(uid);
  try {
    const r = await api("api/run", { method: "POST", body: { uids: [uid], legs: ["campaign"] } });
    const jobId = r?.job?.id ? String(r.job.id) : "";
    if (jobId) state.campaignJobIds.set(String(uid), jobId);
    state.lastFinished = null;
    await loadState();
    connectSSE();
  } catch (e) {
    // 已有 job 在跑（409）沿用与「批量做任务」一致的提示口径（humanErr 统一处理）。
    if (e instanceof ApiError && e.status === 409) {
      humanErr(e, "启动活动任务失败");
    } else {
      const msg = e instanceof ApiError
        ? humanizeApiErr(e.message || `HTTP ${e.status}`, e.data?.hint)
        : e && e.network
          ? "连不上守护进程"
          : humanizeApiErr(String((e && e.message) || e));
      const text = `${who}：活动任务失败 —— ${msg}`;
      state.campaignRuns.set(uid, { ok: false, text });
      toast(text, "warn", 9000);
    }
  } finally {
    state.campaignBusy.delete(uid);
    updateCampaignArea(uid);
  }
}

// 「批量接任务」按钮旁的常驻说明（规则 4）：勾选范围内有多少未接取项被引擎判定为
// 不可自动接取（桌面端 / 未收录）。数字只来自后端 canAccept 字段；老后端没给字段、
// 或计数为 0 时不显示（不猜、不静默少接）。
function renderAcceptNote() {
  const box = $("#acceptNote");
  if (!box) return;
  let blocked = 0;
  let locked = 0;
  let noSnap = 0;
  let modern = false;
  // 勾选 = 全局范围：说明文字按「全账号勾选并集」算，与实际会提交的范围保持一致
  const union = pickedUnion();
  for (const a of targetAccounts()) {
    const all = a.snapshot?.tasks;
    if (!Array.isArray(all)) {
      noSnap++;
      continue;
    }
    const tasks = union.size ? all.filter((t) => union.has(String(t?.code ?? ""))) : all;
    if (tasks.some((t) => taskFlags(t).modern)) modern = true;
    const plan = acceptPlan(tasks);
    blocked += plan.blocked;
    locked += plan.locked;
  }
  // 文案要短：这三段挤在批量条右侧的 280px 里，长了会折行（折行后右对齐 → 左侧参差，
  // 看着像错位）。详细口径留在按钮 title 与 README 里，这里只给数字与最短说明。
  const parts = [];
  if (modern && blocked > 0) parts.push(`${blocked} 项不可自动接取`);
  if (locked > 0) parts.push(`${locked} 项锁定中（接取会跳过）`);
  if (noSnap > 0) parts.push(`${noSnap} 个账号无快照（先只读刷新）`);
  box.textContent = parts.join(" · ");
  box.hidden = parts.length === 0;
}

function updateSelectionUI() {
  const elig = eligibleAccounts();
  const selCount = state.selected.size;
  $("#selCount").textContent = selCount
    ? `已选 ${selCount} 个账号`
    : `未选择 = 全部可参与账号（${elig.length} 个）`;
  const all = $("#selectAll");
  all.checked = elig.length > 0 && selCount === elig.length;
  all.indeterminate = selCount > 0 && selCount < elig.length;
  all.disabled = elig.length === 0;

  const jobRunning = !!state.data?.job;
  const offline = state.conn !== "online";
  const noElig = elig.length === 0;
  for (const id of ["#btnAccept", "#btnRun", "#btnClaim", "#btnCheckin", "#btnStreak"]) {
    const b = $(id);
    if (b) b.disabled = state.busy || jobRunning || offline || noElig;
  }
  // 批量连登管家的按钮说明随勾选范围变：与 /api/streak/run 的 uids 口径一致
  const btnStreak = $("#btnStreak");
  if (btnStreak) {
    btnStreak.textContent = jobRunning ? "任务运行中…" : "连登管家";
    btnStreak.title = noElig
      ? "没有可参与任务的账号"
      : state.selected.size
        ? `对勾选的 ${state.selected.size} 个账号跑连登管家（补签 → 礼包/补偿 → 档位兑换 → 抽奖）`
        : "对全部可参与账号跑连登管家（补签 → 礼包/补偿 → 档位兑换 → 抽奖）；冻结账号会被守护进程跳过";
  }
  $("#btnRun").textContent = jobRunning ? "任务运行中…" : "批量做任务";
  if (noElig && !offline) {
    $("#btnRun").title = "没有可参与任务的账号";
  } else if (pickedUnion().size > 0) {
    $("#btnRun").title =
      "完整流水线：接取 → 点亮（上报进度）→ 领奖；仅做勾选并集里的任务，对本轮所有目标账号生效（旅行/夜猫子/Buddy 腿不受影响）";
  } else {
    $("#btnRun").title = "完整流水线：接取 → 点亮（上报进度）→ 领奖";
  }
  // 批量接取只提交 canAccept === true 的 codes；不可接取的项数在按钮旁说明
  $("#btnAccept").title = "只接取守护进程判定 canAccept 的任务（桌面端 / 未收录 / 自动任务不会进名单）；有任务勾选时只接勾选项";
  renderAcceptNote();
  updateTaskSelNote();
}

// ---- 实时进度区 --------------------------------------------------------------------------

// ---- 运行时长反馈（用户 2026-11-13：「开始批量任务会卡住没反应」） --------------------------
// 活动腿按上游节奏跑（点亮后轮询 6×3s、桌面类任务最多 60s），期间步骤/日志很稀疏 ——
// 面板据此每秒展示真实计时：job 级一行「已运行 1:23 · 最近事件 12:03:45」，running 的
// 步骤行「进行中 · 已 32s」。只显示已运行时长与最后一次事件的时刻，**绝不伪造进度百分比**。
// 时间来源优先契约字段 job.startedAt / step.at（engine runner 都有）；缺失时用前端首次
// 看到 running 的时刻起算（state.jobSeenAt / state.stepSeenAt），绝不显示空白。

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, "0")}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function jobStartMs(job) {
  const d = toDate(job?.startedAt ?? job?.createdAt);
  if (d) return d.getTime();
  const id = String(job?.id ?? "");
  if (!state.jobSeenAt.has(id)) state.jobSeenAt.set(id, Date.now());
  return state.jobSeenAt.get(id);
}

function stepStartMs(job, idx, s) {
  const d = toDate(s?.at);
  if (d) return d.getTime();
  const key = `${job?.id ?? ""}#${idx}`;
  if (!state.stepSeenAt.has(key)) state.stepSeenAt.set(key, Date.now());
  return state.stepSeenAt.get(key);
}

// 最后一次事件的时刻：steps[] 里最近的 at（步骤按时间追加，取最大值）；没有步骤 → job 开始时刻。
function lastEventMs(job) {
  let best = 0;
  for (const s of Array.isArray(job?.steps) ? job.steps : []) {
    const d = toDate(s?.at);
    if (d && d.getTime() > best) best = d.getTime();
  }
  return best || jobStartMs(job);
}

function jobElapsedText(job) {
  return `已运行 ${fmtElapsed(Date.now() - jobStartMs(job))} · 最近事件 ${fmtTime(lastEventMs(job))}`;
}

// 每秒只改既有文本节点的 textContent（不重绘、不动结构）：3s 轮询 / SSE 重绘之间
// 时长也在走，且不会打断用户交互。
function tickElapsed() {
  const job = state.data?.job;
  if (!job || job.state === "done" || job.state === "error") return;
  const je = $("#jobBody [data-job-elapsed]");
  if (je) je.textContent = jobElapsedText(job);
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const node of $$("#jobBody [data-step-elapsed]")) {
    const idx = Number(node.dataset.stepElapsed);
    const s = steps[idx];
    if (s && s.state === "running") node.textContent = `· 已 ${fmtElapsed(Date.now() - stepStartMs(job, idx, s))}`;
  }
}

// 有 running job 就开 1s 计时器，没有就停（幂等，renderJob 每次收尾都调用）。
function syncElapsedTimer() {
  const job = state.data?.job;
  const active = !!job && job.state !== "done" && job.state !== "error";
  if (active && !state.elapsedTimer) {
    state.elapsedTimer = setInterval(tickElapsed, 1000);
    tickElapsed();
  } else if (!active && state.elapsedTimer) {
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = 0;
    pruneElapsedSeen();
  }
}

// 收尾清掉兜底计时缓存（job/step 自带时间戳时它本来就是空的；防止长跑实例缓慢积累）。
function pruneElapsedSeen() {
  state.jobSeenAt.clear();
  state.stepSeenAt.clear();
}

function stepRow(s, idx, job) {
  const gain = [];
  if (Number(s.credit) > 0) gain.push(`+${fmtNum(s.credit)} 积分`);
  if (Number(s.energy) > 0) gain.push(`+${fmtNum(s.energy)} 能量`);
  const running = s.state === "running";
  return el(
    "tr",
    {},
    el("td", { "data-label": "账号" },
      el("span", { class: "cell-main", text: String(s.nickname || s.uid || "—") }),
      s.uid ? el("span", { class: "cell-sub", text: String(s.uid) }) : null,
    ),
    el("td", { "data-label": "腿", text: legName(s.leg) }),
    el("td", { "data-label": "状态" },
      stepBadge(s.state),
      // running 的步骤实时显示已运行时长（每秒由 tickElapsed 更新文本，不重绘）
      running
        ? el("span", {
            class: "step-elapsed",
            dataset: { stepElapsed: String(idx) },
            text: `· 已 ${fmtElapsed(Date.now() - stepStartMs(job, idx, s))}`,
            title: "该步骤进入「进行中」以来的真实时长（活动腿按上游节奏跑，日志稀疏不代表卡死）",
          })
        : null,
    ),
    el("td", { "data-label": "详情", class: "detail-cell", text: String(s.detail ?? "") || "—" }),
    el("td", { "data-label": "收益", class: "num", text: gain.length ? gain.join(" · ") : "—" }),
    el("td", { "data-label": "时间", class: "num", text: fmtTime(s.at) }),
  );
}

function renderJobLogs() {
  const pane = $("#jobLogPane");
  if (!pane) return;
  const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 30;
  const job = state.data?.job ?? state.lastFinished;
  const lines = Array.isArray(job?.log) ? job.log : [];
  pane.replaceChildren(...lines.map((l) => document.createTextNode(String(l) + "\n")));
  if (atBottom) pane.scrollTop = pane.scrollHeight;
}

function renderJob() {
  const box = $("#jobBody");
  const actions = $("#jobActions");
  actions.replaceChildren();
  const job = state.data?.job ?? state.lastFinished;

  if (!job) {
    box.replaceChildren(
      el(
        "div",
        { class: "empty job-empty" },
        el("strong", { text: "当前没有任务在跑" }),
        "勾选账号与任务腿后点「批量做任务」启动一轮：接取 → 点亮 → 领奖；排程到点也会自动运行。",
      ),
    );
    syncElapsedTimer(); // 没有 job：停掉秒级计时器
    return;
  }

  const finished = job.state === "done" || job.state === "error";
  if (!finished) {
    actions.append(
      el("button", {
        type: "button",
        class: "ghost-btn ghost-danger",
        text: "停止当前任务",
        onclick: stopJob,
      }),
    );
  }

  const totals = job.totals ?? {};
  // job 级时长行：运行中 → 每秒走动的「已运行 1:23 · 最近事件 12:03:45」（tickElapsed 只改文本）；
  // 已结束 → 静态「用时 X」（startedAt/endedAt 都解析得出才显示，绝不编数）。
  const startD = toDate(job.startedAt);
  const endD = toDate(job.endedAt);
  const meta = el(
    "div",
    { class: "job-meta" },
    finished && !state.data?.job ? badge("最近一轮（已结束）", "badge-quiet") : null,
    badge(JOB_STATE_NAMES[job.state] ?? String(job.state ?? "—"), job.state === "error" ? "badge-warn" : "badge-strong"),
    job.stopped ? badge("已被要求停止", "badge-warn") : null,
    !finished
      ? el("span", {
          class: "job-elapsed",
          dataset: { jobElapsed: "1" },
          text: jobElapsedText(job),
          title: "本轮开始以来的真实时长与最后一次步骤/事件的时刻（活动腿按上游节奏跑，日志稀疏不代表卡死）",
        })
      : startD && endD
        ? el("span", { class: "mono muted", text: `用时 ${fmtElapsed(endD.getTime() - startD.getTime())}` })
        : null,
    el("span", { class: "mono muted", text: String(job.id ?? "") }),
    el("span", { class: "muted", text: `触发：${TRIGGER_NAMES[job.trigger] ?? job.trigger ?? "—"}` }),
    el("span", { class: "muted", text: `开始 ${fmtDateTime(job.startedAt)}` }),
    job.endedAt ? el("span", { class: "muted", text: `结束 ${fmtDateTime(job.endedAt)}` }) : null,
    job.error ? el("span", { class: "warn-text", text: String(job.error) }) : null,
  );

  const totalsBar = el(
    "dl",
    { class: "job-totals", "aria-label": "本轮累计" },
    el("div", {}, el("dt", { text: "本轮积分" }), el("dd", { text: `+${fmtNum(totals.credit)}` })),
    el("div", {}, el("dt", { text: "本轮能量" }), el("dd", { text: `+${fmtNum(totals.energy)}` })),
    el("div", {}, el("dt", { text: "点亮" }), el("dd", { text: fmtNum(totals.tasksLit) })),
    el("div", {}, el("dt", { text: "领奖" }), el("dd", { text: fmtNum(totals.tasksClaimed) })),
  );

  const steps = Array.isArray(job.steps) ? job.steps : [];
  const stepsTable = steps.length
    ? el(
        "div",
        { class: "tbl-wrap" },
        el(
          "table",
          { class: "tbl tbl-steps" },
          el("thead", {},
            el("tr", {},
              el("th", { text: "账号" }),
              el("th", { text: "腿" }),
              el("th", { text: "状态" }),
              el("th", { text: "详情" }),
              el("th", { text: "收益", class: "num" }),
              el("th", { text: "时间", class: "num" }),
            ),
          ),
          el("tbody", {}, steps.map((s, i) => stepRow(s, i, job))),
        ),
      )
    : el("p", { class: "muted", text: "还没有步骤产出。" });

  const logPane = el("div", { class: "logpane", id: "jobLogPane", "aria-label": "运行日志" });

  box.replaceChildren(
    meta,
    totalsBar,
    el("div", { class: "subhead" }, el("span", { class: "label", text: "步骤" })),
    stepsTable,
    el("div", { class: "subhead" }, el("span", { class: "label", text: "日志" })),
    logPane,
  );
  renderJobLogs();
  syncElapsedTimer(); // 运行中 → 秒级计时器接管时长文本；已结束 → 停表
}

// ---- 批量操作 ------------------------------------------------------------------------------

function setBatchStatus(text) {
  $("#batchStatus").textContent = text ?? "";
}

// 顶部「任务腿」是唯一选择源：勾选由 settings.legs 回写，HTML 里不再写死 checked。
// settings.legs 缺失/为空时回退到出厂默认。0.3.3（CONTRACT §10.3）起的默认腿是
// ["growth","streak","travel"]（连登管家是幂等纯收益，默认做）—— 老后端不给 legs 时
// 前端兜底同一份默认；用户存过 legs 的实例由服务端值决定，不受这里影响。
const DEFAULT_LEGS = ["growth", "streak", "travel"];
// 「积分任务」胶囊（value="points"）= 一次控制 growth + mp + campaign 三条腿：
// 界面上是一个胶囊，settings.legs 里仍写真实腿名，/api/run 的 legs 也仍是三个名字。
const POINTS_LEGS = ["growth", "mp", "campaign"];
let syncedLegsKey = null; // 最近一次从 settings.legs 同步到顶部的值（排序后拼接）

function legsFromSettings(v) {
  const legs = Array.isArray(v) ? v.filter((l) => typeof l === "string" && l) : [];
  return legs.length ? legs : DEFAULT_LEGS;
}

// 按 settings.legs 同步顶部 .leg-check。默认只在服务端值变化（或 force）时覆盖：
// 3s/5s 的后台轮询也会走 renderScheduler，不能把用户尚未保存的勾选改回去。
function syncLegChecks(legs, { force = false } = {}) {
  const list = legsFromSettings(legs);
  const key = [...list].sort().join(",");
  if (!force && key === syncedLegsKey) return;
  syncedLegsKey = key;
  for (const cb of $$(".leg-check")) {
    // 「积分任务」= growth / mp / campaign 任一条存在即显示为已勾选
    // （老设置里只存了 growth 的实例也要显示勾上，不能显示成没选）。
    const on = cb.value === "points" ? POINTS_LEGS.some((l) => list.includes(l)) : list.includes(cb.value);
    setChecked(cb, on);
  }
}

function selectedLegs() {
  // 「积分任务」胶囊展开成 growth + mp + campaign 三条真实腿（唯一来源，不再另设隐藏 input）。
  const out = [];
  for (const i of $$(".leg-check:checked")) {
    if (i.value === "points") out.push(...POINTS_LEGS);
    else out.push(i.value);
  }
  return out;
}

function withBusy(fn) {
  if (state.busy) return Promise.resolve();
  state.busy = true;
  updateSelectionUI();
  return Promise.resolve()
    .then(fn)
    .catch((e) => humanErr(e, "批量操作失败"))
    .finally(() => {
      state.busy = false;
      updateSelectionUI();
    });
}

async function runFull() {
  const legs = selectedLegs();
  if (!legs.length) {
    toast("请至少勾选一条任务腿（积分任务 / 连登管家 / Buddy 盲盒 / 猫猫旅行 / 夜猫子）。", "warn");
    return;
  }
  await withBusy(async () => {
    const uids = [...state.selected];
    // 任务级勾选 = 全局范围（2026-11-14）：任一账号有勾选 → 每个目标账号都带同一份并集
    // （selectionBody 取并集下发到每个 uid）；完全无勾选才不带 codes = 全部任务。
    // buddy / travel / night 腿没有任务码，后端会忽略 codes，不受勾选影响；
    // 小程序链式任务由 growth 腿内嵌执行（2b），不作为独立腿提交。
    const codes = selectionBody(targetAccounts());
    const picked = pickedUnion().size;
    const body = { legs, claim: $("#claimToggle").checked };
    if (uids.length) body.uids = uids;
    if (picked) body.codes = codes;
    setBatchStatus(
      `正在启动批量任务：${legs.map(legName).join(" + ")}，${uids.length ? `${uids.length} 个账号` : "全部可参与账号"}，` +
        `${picked ? `仅选中任务（${picked} 项 · 本轮所有目标账号只做这些），` : ""}${body.claim ? "自动领奖" : "手动领奖（做完不领，之后可「只领奖」）"}…`,
    );
    try {
      const r = await api("api/run", { method: "POST", body });
      setBatchStatus(`已启动 ${r?.job?.id ?? "批量任务"}：进度见「实时进度」区（SSE 推送）。`);
      state.lastFinished = null;
      await loadState();
      connectSSE();
    } catch (e) {
      setBatchStatus("");
      humanErr(e, "启动批量任务失败");
    }
  });
}

// 强制刷新某账号的最新快照（?refresh=<uid>，走上游、daemon 自带限速）。
// 成功后用整份 state 覆盖本地并重绘，返回刷新后的账号行（账号消失时为 null）。
async function refreshSnapshotNow(uid) {
  const d = await api("api/state", { params: { refresh: uid } });
  state.data = d;
  renderAll();
  return accountByUid(uid) ?? null;
}

// 拿账号的可操作任务码：没有快照就先刷一次（保持「无快照才刷」的原语义；有快照直接用）
async function ensureSnapshot(a) {
  if (a.snapshot) return a;
  return (await refreshSnapshotNow(a.uid)) ?? a;
}

async function acceptSelected() {
  await withBusy(async () => {
    const targets = targetAccounts();
    if (!targets.length) return toast("没有可参与任务的账号。", "warn");
    let accepted = 0,
      already = 0,
      failed = 0;
    const noCode = [];
    const blockedNotes = [];
    const pickedEmpty = [];
    const notes = [];
    let usedPicked = false;
    // 勾选 = 全局范围（2026-11-14）：范围取自「全账号勾选并集」，对本轮每个目标账号生效。
    // 无勾选 → 空集 = 接该账号全部（老口径）。活动码不在 acceptPlan.codes 里，天然被过滤。
    const union0 = pickedUnion();
    const hadPick = union0.size > 0;
    if (hadPick) usedPicked = true;
    for (let i = 0; i < targets.length; i++) {
      const a0 = targets[i];
      setBatchStatus(`批量接取（${i + 1}/${targets.length}）：${a0.nickname || a0.uid} …`);
      let a = a0;
      try {
        a = await ensureSnapshot(a0);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setBatchStatus("已有批量任务在跑，接取中止（守护进程限速保护）。");
          return;
        }
        notes.push(`${a0.nickname || a0.uid}：快照刷新失败（${humanizeApiErr(e.message, e.data?.hint)}）`);
        continue;
      }
      let plan = acceptPlan(a.snapshot?.tasks);
      // 只提交本账号可接项与「全账号勾选并集」的交集；勾选项全被过滤掉时明确说明，
      // 绝不静默退回「接该账号全部」（无勾选才是全部）。
      let codes = hadPick ? plan.codes.filter((c) => union0.has(c)) : plan.codes;
      let refreshed = false;
      // 有勾选但按当前快照筛不出可接项：本地快照可能停在旧状态（上游已接取、快照仍显示
      // 未接）。强制刷新一次最新快照再判断；已有可接项 / 本来就没有待接项时不做无谓刷新。
      if (hadPick && !codes.length && plan.pending > 0) {
        let fresh = null;
        try {
          fresh = await refreshSnapshotNow(a.uid);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            setBatchStatus("已有批量任务在跑，接取中止（守护进程限速保护）。");
            return;
          }
          notes.push(`${a.nickname || a.uid}：快照刷新失败（${humanizeApiErr(e.message, e.data?.hint)}）`);
          continue;
        }
        if (!fresh) {
          notes.push(`${a.nickname || a.uid}：快照刷新失败`);
          continue;
        }
        a = fresh;
        refreshed = true;
        plan = acceptPlan(a.snapshot?.tasks);
        // 刷新后重读并集（renderAll 可能把锁定项剔除）；并集空了 = 无待接项，不退回全部
        const union2 = pickedUnion();
        codes = union2.size ? plan.codes.filter((c) => union2.has(c)) : [];
      }
      // 规则 4：不可自动接取的项要说出来，不能静默少接
      if (plan.blocked) {
        blockedNotes.push(`${a.nickname || a.uid}：${plan.blocked} 项不可自动接取（桌面端/未收录）`);
      }
      if (hadPick && !codes.length) {
        pickedEmpty.push(`${a.nickname || a.uid}：已选任务都不可自动接取/无待接${refreshed ? "（已刷新最新快照）" : ""}`);
        continue;
      }
      if (!codes.length) {
        const why = plan.noCode
          ? "快照缺任务码"
          : plan.blocked
            ? `${plan.blocked} 项不可自动接取（桌面端/未收录）`
            : plan.locked
              ? `${plan.locked} 项次日可接取（已跳过）`
              : plan.auto
                ? `仅 ${plan.auto} 项自动任务，无需接取`
                : "无未接任务";
        noCode.push(`${a.nickname || a.uid}（${why}）`);
        continue;
      }
      try {
        const r = await api("api/task/accept", { method: "POST", body: { uid: a.uid, codes } });
        accepted += (r?.accepted ?? []).length;
        already += (r?.already ?? []).length;
        failed += (r?.failed ?? []).length;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setBatchStatus("已有批量任务在跑，接取中止（守护进程限速保护）。");
          return;
        }
        notes.push(`${a.nickname || a.uid}：${humanizeApiErr(e.message, e.data?.hint)}`);
      }
    }
    const parts = [
      `批量接取完成${usedPicked ? "（仅选中任务 · 本轮所有目标账号只做这些）" : ""}：新接 ${accepted} · 已接过 ${already} · 失败 ${failed}`,
    ];
    if (blockedNotes.length) parts.push(`不可自动接取：${blockedNotes.join("、")}`);
    if (pickedEmpty.length) parts.push(`按勾选跳过：${pickedEmpty.join("、")}`);
    if (noCode.length) parts.push(`跳过：${noCode.join("、")}`);
    if (notes.length) parts.push(notes.join("；"));
    setBatchStatus(parts.join("。"));
    await loadState();
  });
}

async function claimSelected() {
  await withBusy(async () => {
    const targets = targetAccounts();
    if (!targets.length) return toast("没有可参与任务的账号。", "warn");
    let okCount = 0,
      credit = 0,
      energy = 0,
      viaWeb = 0;
    const failNotes = [];
    const noCode = [];
    const pickedEmpty = [];
    let usedPicked = false;
    // 勾选 = 全局范围（2026-11-14）：范围取自「全账号勾选并集」，对本轮每个目标账号生效。
    // 无勾选 → null = 领该账号全部可领项（老口径）。活动码不在快照 tasks 里，天然被过滤。
    const union0 = pickedUnion();
    const hadPick = union0.size > 0;
    if (hadPick) usedPicked = true;
    for (let i = 0; i < targets.length; i++) {
      const a0 = targets[i];
      setBatchStatus(`只领奖（${i + 1}/${targets.length}）：${a0.nickname || a0.uid} …`);
      let a = a0;
      try {
        a = await ensureSnapshot(a0);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setBatchStatus("已有批量任务在跑，领奖中止。");
          return;
        }
        failNotes.push(`${a0.nickname || a0.uid}：快照刷新失败`);
        continue;
      }
      // pending 任务按「全账号勾选并集」过滤；有勾选但无匹配待领奖时明确说明。
      // 领奖不受 locked 限制，直接用内存里的原始并集（不剔除锁定项）。
      let pick = hadPick ? union0 : null;
      // 与单行「领奖」按钮同一口径：completed，或进度已达标（current >= target > 0）
      let pending = (a.snapshot?.tasks ?? []).filter((t) => claimableTask(t));
      let scoped = pick ? pending.filter((t) => pick.has(String(t?.code ?? ""))) : pending;
      // 勾选了任务却按当前快照筛不出可领项：多半是本地快照还停在接取时的旧状态
      // （上游已完成、快照仍是 accepted 0/N）。强制刷新一次最新快照再判断；
      // 已有可领项时绝不额外刷新（避免每次「只领奖」都多打一次上游）。
      if (hadPick && !scoped.length) {
        let fresh = null;
        try {
          fresh = await refreshSnapshotNow(a.uid);
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            setBatchStatus("已有批量任务在跑，领奖中止。");
            return;
          }
          failNotes.push(`${a.nickname || a.uid}：快照刷新失败`);
          continue;
        }
        if (!fresh) {
          failNotes.push(`${a.nickname || a.uid}：快照刷新失败`);
          continue;
        }
        a = fresh;
        // 刷新后重读并集（renderAll 可能把锁定项剔除）；并集空了 = 无可领项，不退回全部
        const union2 = pickedUnion();
        pick = union2.size ? union2 : null;
        pending = (a.snapshot?.tasks ?? []).filter((t) => claimableTask(t));
        scoped = pick ? pending.filter((t) => pick.has(String(t?.code ?? ""))) : [];
        if (!scoped.length) {
          pickedEmpty.push(`${a.nickname || a.uid}：已选任务都不可领奖/无待领奖（已刷新最新快照）`);
          continue;
        }
      }
      const codes = scoped.filter((t) => t.code).map((t) => t.code);
      if (scoped.length && !codes.length) noCode.push(a.nickname || a.uid);
      for (const code of codes) {
        try {
          const r = await api("api/task/claim", { method: "POST", body: { uid: a.uid, code } });
          if (r?.ok) {
            okCount++;
            credit += Number(r.credit) || 0;
            energy += Number(r.energy) || 0;
            if (r?.via === "web") viaWeb++;
          } else {
            failNotes.push(`${a.nickname || a.uid}/${code}：${r?.reason || "上游未说明"}`);
          }
        } catch (e) {
          if (e instanceof ApiError && e.status === 409) {
            setBatchStatus("已有批量任务在跑，领奖中止。");
            return;
          }
          failNotes.push(`${a.nickname || a.uid}/${code}：${humanizeApiErr(e.message, e.data?.hint)}`);
        }
      }
    }
    const parts = [
      `领奖完成${usedPicked ? "（仅选中任务 · 本轮所有目标账号只做这些）" : ""}：成功 ${okCount} 项，+${fmtNum(credit)} 积分，+${fmtNum(energy)} 能量`,
    ];
    if (viaWeb) parts.push(`其中 ${viaWeb} 项已走网页通道（桌面端领奖被拒，网页兜底成功）`);
    if (pickedEmpty.length) parts.push(`按勾选跳过：${pickedEmpty.join("、")}`);
    if (noCode.length) parts.push(`无法领取（快照缺任务码）：${noCode.join("、")}`);
    if (failNotes.length) parts.push(`未成功：${failNotes.slice(0, 6).join("；")}${failNotes.length > 6 ? " 等" : ""}`);
    parts.push("任务表里的状态以快照为准，可点账号旁「刷新快照」查看最新。");
    setBatchStatus(parts.join("。"));
    await loadState();
  });
}

async function checkinSelected() {
  await withBusy(async () => {
    const uids = [...state.selected];
    setBatchStatus("每日签到中…（账号之间守护进程会间隔至少 1.5 秒）");
    try {
      const body = uids.length ? { uids } : {};
      const rows = await api("api/checkin", { method: "POST", body });
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) {
        setBatchStatus("签到完成：没有可签到的账号。");
        return;
      }
      // 回执细分（CONTRACT §10.4）：claimed=真签到、done=今天本来就签过、failed=失败，
      // pending=上游「处理中 / 请勿重复操作 / 系统繁忙」—— 不算成功、不落账、当天可重试。
      // pending 单独计数、行内如实标注，绝不混进「已签到」。
      let claimed = 0;
      let done = 0;
      let pending = 0;
      let failed = 0;
      const lines = list.map((r) => {
        const who = accountByUid(r.uid)?.nickname || r.uid;
        const oc = String(r.outcome ?? "");
        const outcome = OUTCOME_NAMES[oc] ?? (oc || "—");
        if (oc === "claimed") claimed++;
        else if (oc === "done") done++;
        else if (oc === "pending") pending++;
        else failed++;
        // pending 不带收益（上游没落账）；积分 / 连登只在真领到时显示
        const gain = oc !== "pending" && Number(r.credit) > 0 ? `，+${fmtNum(r.credit)} 积分` : "";
        const streak = oc !== "pending" && r.streak != null ? `，连登 ${r.streak} 天` : "";
        const msg = r.message ? `（${r.message}）` : "";
        const retry = oc === "pending" ? " —— 不算已签，稍后可再点「每日签到」重试" : "";
        return `${who}：${outcome}${gain}${streak}${msg}${retry}`;
      });
      const parts = [`${list.length} 个账号`];
      if (claimed) parts.push(`新签到 ${claimed}`);
      if (done) parts.push(`今天已签 ${done}`);
      if (pending) parts.push(`处理中 ${pending}（可重试）`);
      if (failed) parts.push(`失败 ${failed}`);
      setBatchStatus(`每日签到完成：${parts.join(" · ")}\n${lines.join("\n")}`);
      if (pending) {
        // 不静默：处理中的账号最容易被误当成签到成功（上游原话就是「请勿重复操作」）
        toast(`${pending} 个账号签到「处理中」：上游还没处理完，不算已签 —— 稍后再点「每日签到」重试。`, "warn", 8000);
      }
      await loadState();
    } catch (e) {
      setBatchStatus("");
      humanErr(e, "签到失败");
    }
  });
}

async function stopJob() {
  try {
    await api("api/stop", { method: "POST" });
    toast("已请求停止：在当前步骤边界生效（不打断进行中的上游调用）。");
    await loadState();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      toast("当前没有正在运行的任务。");
      await loadState();
      return;
    }
    humanErr(e, "停止失败");
  }
}

async function rescanAccounts() {
  const btn = $("#rescanBtn");
  btn.disabled = true;
  try {
    const r = await api("api/accounts", { method: "POST" });
    toast(`账号扫描完成：workbuddy 条目 ${r?.count ?? 0} 个，可参与 ${r?.eligible ?? 0} 个`);
    await loadState();
    await loadHistory();
  } catch (e) {
    humanErr(e, "扫描失败");
  } finally {
    btn.disabled = false;
  }
}

// ---- 账号导出 / 导入（契约 §9；hub 移植口径）------------------------------------------
// 纪律：
//   - 守护进程无鉴权：导出走 fetch，不带 Authorization，URL 不带 ?k=。
//     下载走 fetch → Blob → URL.createObjectURL。
//   - token 只出现在下载的导出文件里：页面文本绝不渲染 accessToken/refreshToken
//     （导入响应经后端 planView 本就剥掉 token；导出只读 count/exportedAt 做摘要）。
//   - uid / 目标 key / 文件名 / 备份名一律等宽（.mono / code）。
//   - 服务端字符串（note/reason/reloadHint/inputHint/error）全部经 el() 的 textContent。

// 纯函数：解析 Content-Disposition 里的文件名（后端 download=1 时给
// attachment; filename="workbuddy-accounts-….json"，已净化为 ASCII）。
// RFC 5987 的 filename*=UTF-8''… 优先；解析不出返回 ""（调用方按 hub 规则本地拼）。
// 顺手再挡一遍路径分隔符（纵深防御，正常后端不会给）。导出仅为 Node 下单元验证。
export function filenameFromDisposition(cd) {
  const s = String(cd ?? "");
  if (!s) return "";
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/i.exec(s);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim()).replace(/^"|"$/g, "").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
    } catch {}
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(s);
  const name = plain ? plain[1].trim() : "";
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120);
}

// Content-Disposition 取不到时的本地兜底文件名：与 hub 规则
//（engine/accountio.exportFileName）逐字同款。导出仅为 Node 下单元验证。
export function localExportFileName({ uids = [], realm = null, now = Date.now() } = {}) {
  const p = (n) => String(n).padStart(2, "0");
  const d = new Date(Number(now) || Date.now());
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const label = Array.isArray(uids) && uids.length === 1 ? String(uids[0]).slice(0, 8) : realm ? `${realm}-` : "";
  const safe = `workbuddy-accounts-${label}${stamp}.json`.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return safe || "export.json";
}

const SCOPE_NAMES = { all: "全部（国内版）", selected: "仅勾选的账号" };

function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename, style: { display: "none" } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// 后端不带 realm 时只导出国内版；「仅勾选」用 uid 列表收窄。
function exportScope() {
  const radio = $('input[name="expScope"]:checked');
  const scope = radio ? radio.value : "all";
  if (scope === "selected") return { scope, realm: null, uids: [...state.selected] };
  return { scope: "all", realm: null, uids: [] };
}

// 「含凭据」勾选联动：默认勾上（与 hub 一致）；勾/取消各自给一行说明
function syncExportHints() {
  const secrets = $("#expSecrets").checked;
  $("#expSecretsWarn").hidden = !secrets;
  $("#expSanitizedNote").hidden = secrets;
  $("#expCredHint").textContent = secrets
    ? "含凭据导出会下载含 accessToken / refreshToken 的文件（等同钥匙，别外发）。"
    : "脱敏导出删掉 accessToken / refreshToken 两个键，只能看不能登录。";
}

async function exportAccounts(btn) {
  const secrets = $("#expSecrets").checked;
  const { scope, realm, uids } = exportScope();
  const status = $("#expStatus");
  if (scope === "selected" && !uids.length) {
    toast("「仅勾选的账号」需要先在下方账号区勾选至少一个账号。", "warn", 6500);
    return;
  }
  btn.disabled = true;
  status.textContent = `正在导出（${SCOPE_NAMES[scope] ?? scope} · ${secrets ? "含凭据" : "脱敏"}）…`;
  const doFetch = async () => {
    const url = new URL("api/accounts/export", location.href);
    url.searchParams.set("secrets", secrets ? "1" : "0");
    url.searchParams.set("download", "1");
    if (uids.length) url.searchParams.set("uid", uids.join(","));
    let res;
    try {
      res = await fetch(url);
    } catch {
      const err = new Error("连不上守护进程");
      err.network = true;
      throw err;
    }
    if (!res.ok) {
      let data = null;
      try {
        data = await res.json();
      } catch {}
      throw new ApiError(res.status, data);
    }
    return res;
  };
  try {
    const res = await doFetch();
    const name = filenameFromDisposition(res.headers.get("Content-Disposition")) || localExportFileName({ uids, realm });
    const blob = await res.blob();
    // 摘要只取 count / exportedAt（绝不把账号行、token 渲染进页面）
    let doc = null;
    try {
      doc = JSON.parse(await blob.text());
    } catch {}
    triggerBlobDownload(blob, name);
    const count = Number(doc?.count);
    const parts = [
      Number.isFinite(count) ? `已导出 ${count} 个账号` : "已导出",
      `${SCOPE_NAMES[scope] ?? scope} · ${secrets ? "含凭据" : "脱敏"}`,
    ];
    if (typeof doc?.exportedAt === "string" && doc.exportedAt) parts.push(doc.exportedAt);
    status.replaceChildren(
      el("span", { text: `${parts.join(" · ")}：` }),
      el("code", { class: "mono", text: name }),
      secrets
        ? el("span", { class: "warn-text", text: " · 文件内含 accessToken/refreshToken，等同钥匙，别外发。" })
        : el("span", { class: "muted", text: " · 脱敏清单不能用于登录，只能用来看。" }),
    );
  } catch (e) {
    if (e && e.network) {
      status.textContent = "";
      humanErr(e, "导出失败");
    } else if (e instanceof ApiError) {
      // 后端中文 error 原样透出（如 404 no such account），不显示堆栈；未知 API → 人话改写
      status.textContent = `导出失败（HTTP ${e.status}）：${humanizeApiErr(e.message, e.data?.hint)}`;
    } else {
      status.textContent = `导出失败：${humanizeApiErr(String(e?.message ?? e))}`;
    }
  } finally {
    btn.disabled = false;
  }
}

// ---- 导入（两段式：预览只读不写盘 → 确认写入 plugin-auth.json）-----------------------
// impState.blob = 预览用的已解析对象（确认必须与预览同一份内容）；previewOk = 预览
// 成功才显示「确认写入」。textarea / 文件的任何变动都让预览失效 —— 后端的哈希竞态
// 守卫只盯 plugin-auth.json 的变化，「导入内容改了没重新预览」只能前端挡。
const impState = { blob: null, previewOk: false, totals: null };

function impInvalidate(note) {
  const wasOk = impState.previewOk;
  impState.blob = null;
  impState.previewOk = false;
  impState.totals = null;
  $("#impConfirmBtn").hidden = true;
  if (wasOk && note) setImpStatus(note);
}

function setImpStatus(text) {
  $("#impStatus").textContent = text ?? "";
}

function readImportJson() {
  const text = $("#impText").value.trim();
  if (!text) {
    setImpStatus("请先粘贴账号 JSON，或选择本地 .json 文件读入。");
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    setImpStatus(`本地 JSON 解析失败（还没有发请求）：${e?.message ?? e}`);
    return undefined;
  }
}

async function importPreview() {
  const btn = $("#impPreviewBtn");
  const parsed = readImportJson();
  if (parsed === undefined) return;
  btn.disabled = true;
  $("#impConfirmBtn").hidden = true;
  $("#impResult").replaceChildren();
  setImpStatus("正在预览…（只读，不写盘）");
  try {
    // body = {"blob":<账号数据本体>}：confirm 缺省 = 预览分支（只读）
    const r = await api("api/accounts/import", { method: "POST", body: { blob: parsed, confirm: false } });
    impState.blob = parsed;
    impState.previewOk = true;
    impState.totals = r?.preview?.totals ?? null;
    renderImportPreview(r);
    setImpStatus(String(r?.note ?? "预览未写入任何文件"));
    $("#impConfirmBtn").hidden = false;
  } catch (e) {
    impInvalidate();
    renderImportError(e, "预览失败");
  } finally {
    btn.disabled = false;
  }
}

// 预览四组列表：adds/updates 常规色；skips 用 --ink3（muted）；rejects 用 --warn ——
// 不用刺眼的红。每条显示 uid、昵称、目标 key 与 reason 原文（全部 textContent）。
function impWho(x) {
  return String(x?.nickname || x?.uid || "—");
}

function impUidKeyCells(x) {
  const cells = [];
  if (x?.uid != null && x.uid !== "") cells.push(el("span", { class: "mono imp-uid", text: String(x.uid) }));
  if (x?.key) cells.push(el("span", { class: "mono imp-key", text: String(x.key) }));
  return cells;
}

function impGroup(title, rows, rowCls) {
  if (!rows.length) return null;
  return el(
    "div",
    { class: "imp-group" },
    el("p", { class: "label imp-group-title", text: `${title}（${rows.length}）` }),
    ...rows.map((x) => el("div", { class: `imp-row ${rowCls}`.trim() }, ...x)),
  );
}

function renderImportPreview(r) {
  const box = $("#impResult");
  box.replaceChildren();
  const pv = r?.preview ?? {};
  const t = pv.totals ?? {};
  const adds = Array.isArray(pv.adds) ? pv.adds : [];
  const updates = Array.isArray(pv.updates) ? pv.updates : [];
  const skips = Array.isArray(pv.skips) ? pv.skips : [];
  const rejects = Array.isArray(pv.rejects) ? pv.rejects : [];

  box.append(
    el("p", {
      class: "imp-totals",
      text: `新增 ${Number(t.adds) || 0} · 更新 ${Number(t.updates) || 0} · 跳过 ${Number(t.skips) || 0} · 拒绝 ${Number(t.rejects) || 0}`,
    }),
  );

  const groups = [
    impGroup(
      "新增",
      adds.map((x) => [
        el("span", { class: "imp-name", text: impWho(x) }),
        ...impUidKeyCells(x),
      ]),
      "",
    ),
    impGroup(
      "更新（覆盖 access/refresh/expires）",
      updates.map((x) => [
        el("span", { class: "imp-name", text: impWho(x) }),
        ...impUidKeyCells(x),
        el("span", {
          class: "mono imp-expiry",
          text: `${fmtDateTime(x?.fromExpires)} → ${fmtDateTime(x?.toExpires)}`,
        }),
        el("span", { class: "imp-reason", text: String(x?.reason ?? "") }),
      ]),
      "",
    ),
    impGroup(
      "跳过（不写入）",
      skips.map((x) => [
        el("span", { class: "imp-name", text: impWho(x) }),
        ...impUidKeyCells(x),
        el("span", { class: "imp-reason", text: String(x?.reason ?? "") }),
      ]),
      "imp-row-skip",
    ),
    impGroup(
      "拒绝（不导入）",
      rejects.map((x) => [
        el("span", { class: "mono imp-index", text: `#${Number(x?.index) || 0}` }),
        el("span", { class: "imp-reason", text: String(x?.reason ?? "") }),
        x?.inputHint ? el("span", { class: "mono imp-hint", text: String(x.inputHint) }) : null,
      ]),
      "imp-row-reject",
    ),
  ].filter(Boolean);

  if (!groups.length) {
    box.append(el("p", { class: "muted", text: "文档里没有可解析的行。" }));
    return;
  }
  box.append(...groups);
}

async function importConfirm() {
  const btn = $("#impConfirmBtn");
  if (!impState.previewOk || impState.blob == null) {
    setImpStatus("请先「预览」成功后再确认写入。");
    return;
  }
  const t = impState.totals ?? {};
  // 明示三行后果（备份名规则来自后端 applyImport：bak-hubimport-<YYYYMMDD-HHMMSS>）
  const ok = confirm(
    "确认写入 magpie？\n\n" +
      `· 将写入 <magpie 配置目录>/plugin-auth.json：新增 ${Number(t.adds) || 0} · 更新 ${Number(t.updates) || 0}` +
      `（跳过 ${Number(t.skips) || 0} · 拒绝 ${Number(t.rejects) || 0} 不写入）\n` +
      "· 写前自动逐字节备份为 plugin-auth.json.bak-hubimport-<YYYYMMDD-HHMMSS>\n" +
      "· 国际版（intl）账号不会写入（已在拒绝列表里）\n\n" +
      "写入后需要在 magpie「插件管理」里把 WorkBuddy 关掉再打开，新账号才会被认到。",
  );
  if (!ok) return;
  btn.disabled = true;
  setImpStatus("正在写入 plugin-auth.json…");
  try {
    // confirm:true 写盘（写前自动备份）
    const r = await api("api/accounts/import", { method: "POST", body: { blob: impState.blob, confirm: true } });
    impInvalidate(); // 本次预览已被消耗：再写必须重新预览
    $("#impResult").replaceChildren();
    renderImportResult(r);
    setImpStatus("");
    await loadState(); // 账号列表变了：重拉只读 state（SSE 的 accounts 广播也会触发一次，无害）
  } catch (e) {
    renderImportError(e, "确认写入失败");
  } finally {
    btn.disabled = false;
  }
}

function renderImportResult(r) {
  const box = $("#impResult");
  box.replaceChildren();
  if (!r || typeof r !== "object") {
    box.append(el("div", { class: "banner" }, el("p", { text: "写入完成（守护进程未返回详情）。" })));
    return;
  }
  if (r.wrote !== true) {
    // 无变更分支：{wrote:false, note:"没有需要写入的变更…"}
    box.append(
      el("div", { class: "banner" },
        el("strong", { text: "未写入" }),
        el("p", { text: String(r.note ?? "没有需要写入的变更（新增/更新均为 0）。") }),
      ),
    );
    return;
  }
  const added = Array.isArray(r.added) ? r.added.length : 0;
  const updated = Array.isArray(r.updated) ? r.updated.length : 0;
  const skipped = Array.isArray(r.skipped) ? r.skipped.length : 0;
  box.append(
    el("p", { class: "imp-totals", text: `已写入：新增 ${added} · 更新 ${updated} · 跳过 ${skipped}` }),
    r.backedUpTo
      ? el("p", { class: "imp-line" },
          el("span", { text: "写前已备份：" }),
          el("code", { class: "mono", text: String(r.backedUpTo) }),
        )
      : el("p", { class: "imp-line muted", text: "本次没有生成备份（原 plugin-auth.json 不存在，从零建）。" }),
    el("p", { class: "imp-line", text: String(r.reloadHint ?? "在 magpie「插件管理」里把 WorkBuddy 关掉再打开，新账号才会被 magpie 认到") }),
    el("div", { class: "banner banner-warn imp-reload" },
      el("strong", { text: "导入后需要重载" }),
      el("p", { text: "magpie 只有重启插件宿主才会认到新账号（插件管理里关掉再打开 WorkBuddy）。" }),
    ),
  );
}

function renderImportError(e, prefix) {
  const box = $("#impResult");
  if (e instanceof ApiError && e.status === 409 && e.data?.needRepreview) {
    // 竞态守卫：预览后 plugin-auth.json 被改动（magpie 可能刷新过 token）→ 一键重预览
    impState.previewOk = false;
    $("#impConfirmBtn").hidden = true;
    setImpStatus("凭据文件在预览后被改动，请重新预览后再确认。");
    box.replaceChildren(
      el("div", { class: "banner banner-warn" },
        el("strong", { text: "需要重新预览" }),
        el("p", { text: String(e.message || "plugin-auth.json 在预览后发生了变化，为防覆盖已拒绝写入。") }),
        el("p", {},
          el("button", {
            type: "button",
            class: "ghost-btn",
            text: "重新预览",
            onclick: () => importPreview(),
          }),
        ),
      ),
    );
    return;
  }
  box.replaceChildren();
  if (e instanceof ApiError) {
    // 400 无可导入账号 / 409 auth 解析失败 等：后端中文 error 原样透出，不显示堆栈；未知 API → 人话改写
    setImpStatus(`${prefix}（HTTP ${e.status}）：${humanizeApiErr(e.message, e.data?.hint)}`);
    return;
  }
  if (e && e.network) {
    setImpStatus("");
    humanErr(e, prefix);
    return;
  }
  setImpStatus(`${prefix}：${humanizeApiErr(String(e?.message ?? e))}`);
}

// ---- 导入 / 导出抽屉（已合并进账号卡片） ------------------------------------------------
// 账号卡片右上角按钮控制 ioPanel 的开合；内部两个标签页共用同一套导出/导入逻辑，
// 任何 DOM 文案都还是走 textContent，不新增注入面。

const ioUi = { tab: "export" };

function selectIoTab(tab, { focus = false } = {}) {
  const want = tab === "import" ? "import" : "export";
  ioUi.tab = want;
  const isImport = want === "import";
  const tabExport = $("#ioTabExport");
  const tabImport = $("#ioTabImport");
  const paneExport = $("#ioExportPane");
  const paneImport = $("#ioImportPane");
  if (!tabExport || !tabImport || !paneExport || !paneImport) return;
  tabExport.classList.toggle("is-active", !isImport);
  tabImport.classList.toggle("is-active", isImport);
  tabExport.setAttribute("aria-selected", String(!isImport));
  tabImport.setAttribute("aria-selected", String(isImport));
  tabExport.tabIndex = isImport ? -1 : 0;
  tabImport.tabIndex = isImport ? 0 : -1;
  paneExport.hidden = isImport;
  paneImport.hidden = !isImport;
  if (focus) (isImport ? tabImport : tabExport).focus();
}

function setIoOpen(open, tab) {
  const panel = $("#ioPanel");
  const btn = $("#ioToggleBtn");
  if (!panel || !btn) return;
  panel.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  btn.classList.toggle("is-open", open);
  if (open && tab) selectIoTab(tab);
  if (open) {
    const active = ioUi.tab === "import" ? $("#impText") : $("#expBtn");
    if (active) active.focus({ preventScroll: true });
  }
}

function toggleIo() {
  const panel = $("#ioPanel");
  if (!panel) return;
  setIoOpen(panel.hidden, ioUi.tab);
}

function wireIoTabs() {
  const list = $(".tabs");
  if (!list) return;
  list.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    selectIoTab(ioUi.tab === "export" ? "import" : "export", { focus: true });
  });
}

function wireImportFile() {
  $("#impFile").addEventListener("change", (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = ""; // 允许再次选择同一文件
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      $("#impText").value = String(reader.result ?? "");
      $("#impFileNote").textContent = `已读入 ${f.name}（${f.size} 字节）`;
      $("#impResult").replaceChildren();
      impInvalidate();
      setImpStatus("文件已读入：点「预览（不写入）」看看会写入什么。");
    };
    reader.onerror = () => {
      $("#impFileNote").textContent = "";
      setImpStatus(`读取文件失败：${f.name}`);
    };
    reader.readAsText(f);
  });
  $("#impText").addEventListener("input", () => {
    if (impState.previewOk) {
      $("#impResult").replaceChildren();
      impInvalidate("内容已修改：上次预览已失效，请重新预览后再确认。");
    }
  });
}

// ---- 排程区 ----------------------------------------------------------------------------------

function setVal(elm, v) {
  if (elm && document.activeElement !== elm) elm.value = v ?? "";
}
function setChecked(elm, v) {
  if (elm && document.activeElement !== elm) elm.checked = !!v;
}

function nextRunItems(runs) {
  // runs: [[leg, hour], ...]（daemon 已按小时排序）→ 按小时分组，算下一次到点时间
  const byHour = new Map();
  for (const r of runs ?? []) {
    const [leg, hour] = Array.isArray(r) ? r : [];
    const h = Number(hour);
    if (!Number.isFinite(h)) continue;
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h).push(leg);
  }
  const now = new Date();
  const items = [];
  for (const [h, legs] of byHour) {
    const d = new Date(now);
    d.setHours(h, 0, 0, 0);
    let dayLabel = "今天";
    if (d.getTime() <= now.getTime()) {
      d.setDate(d.getDate() + 1);
      dayLabel = "明天";
    }
    items.push({ at: d, dayLabel, legs: legs.map(legName).join(" + ") });
  }
  items.sort((a, b) => a.at - b.at);
  return items;
}

function renderScheduler() {
  const d = state.data;
  if (!d) return;
  const sch = d.scheduler ?? {};
  const settings = d.settings ?? {};

  setChecked($("#schedEnabled"), sch.enabled);
  // 小时窗口只暴露四条腿：小程序链式任务 / 连登管家 / Buddy 盲盒 / 猫猫旅行
  //（2026-11-13 用户要求：排程里去掉「活动任务」与「夜猫子」两行）。
  // **活动任务与夜猫子仍在后端支持排程**（hours.campaign / hours.night），只是没有输入框：
  // 保存时不显示的那两条腿按当前设置原样回传，绝不因为「界面上看不见」就被清成 []。
  // settings.hours.growth 即使老后端还带也一律忽略。mp 默认 []（不排程）。
  const hours = settings.hours ?? {};
  setVal($("#hoursMp"), (hours.mp ?? []).join(","));
  setVal($("#hoursStreak"), (hours.streak ?? []).join(","));
  setVal($("#hoursBuddy"), (hours.buddy ?? []).join(","));
  setVal($("#hoursTravel"), (hours.travel ?? []).join(","));
  setChecked($("#defClaim"), settings.claim);
  setVal($("#gapMs"), settings.gapMs);
  // 顶部任务腿跟 settings.legs 同步（唯一选择源；不再有独立的默认腿控件）
  syncLegChecks(settings.legs);

  $("#lastCycle").textContent = sch.lastCycle ? `上次触发 ${fmtDateTime(sch.lastCycle)}` : "尚未触发过";

  // 下一次运行预览
  const nr = $("#nextRuns");
  nr.replaceChildren();
  if (!sch.enabled) {
    nr.append(el("p", { class: "muted", text: "排程已停用：打开上方开关后，到点会自动跑一轮。" }));
  } else {
    // 防御性过滤：后端不再返回 growth，但老/脏数据里若带 [ "growth", h ] 也不展示
    const runs = (Array.isArray(sch.nextRuns) ? sch.nextRuns : []).filter(
      (r) => Array.isArray(r) && String(r[0]) !== "growth",
    );
    const items = nextRunItems(runs);
    if (!items.length) {
      nr.append(el("p", { class: "muted", text: "没有配置任何小时窗口。" }));
    } else {
      for (const it of items) {
        const p = (n) => String(n).padStart(2, "0");
        nr.append(
          el("div", { class: "next-run" },
            el("time", { text: `${it.dayLabel} ${p(it.at.getHours())}:00` }),
            el("span", { text: it.legs }),
          ),
        );
      }
    }
  }

  // holds：daemon.mjs 给的是真实风控冷却（403/11140）名单
  // [{uid, nickname, releasedAt(ISO)}]；冷却期内批量运行会跳过这些账号。
  const holdsBox = $("#holdsBox");
  holdsBox.replaceChildren();
  const holds = Array.isArray(sch.holds) ? sch.holds : [];
  if (!holds.length) {
    holdsBox.append(el("span", { class: "muted", text: "无账号处于风控冷却" }));
  } else {
    for (const h of holds) {
      if (h && typeof h === "object") {
        holdsBox.append(
          el("div", { class: "hold-item" },
            el("span", { class: "hold-name", text: String(h.nickname || h.uid || "—") }),
            el("span", { class: "hold-uid mono", text: String(h.uid ?? "") }),
            el("span", { class: "hold-release", text: `解除时间：${fmtRelease(h.releasedAt)}` }),
          ),
        );
      } else {
        // 老守护进程给裸 uid 字符串：至少别丢掉信息
        holdsBox.append(el("div", { class: "hold-item" }, el("span", { class: "hold-uid mono", text: String(h) })));
      }
    }
  }

  // hosts（生效值，只读）
  const hostsBox = $("#hostsBox");
  hostsBox.replaceChildren();
  const host = settings.host ?? {};
  for (const k of ["chat", "bill", "web"]) {
    hostsBox.append(el("span", { text: `${k}: ${host[k] || "（引擎默认）"}` }));
  }
}

function parseHoursInput(v) {
  return String(v ?? "")
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 23 && Number.isInteger(n));
}

async function saveHours() {
  // 排程界面只暴露四条腿：小程序链式任务 / 连登管家 / Buddy 盲盒 / 猫猫旅行（留空 = 不排程）。
  // 成长任务不在排程里（手工运行仍可选它）；**活动任务与夜猫子没有输入框**（用户 2026-11-13 要求去掉），
  // 但后端仍支持它们的小时窗口。这里**故意不传这两条腿**：daemon 的 /api/settings 对 hours 是
  // **按键合并**（`{...settings.hours}` 只覆盖 body 里出现的腿），所以省略 = 保留现值。
  // 绝不能「回传页面缓存的旧值」—— 页面缓存在别处改过设置后会过期，那样保存一次就会把
  // 别处刚配好的窗口清掉（2026-11-13 实测踩到过：night=[5] 被清成 []）。
  const hours = {
    mp: parseHoursInput($("#hoursMp").value),
    streak: parseHoursInput($("#hoursStreak").value),
    buddy: parseHoursInput($("#hoursBuddy").value),
    travel: parseHoursInput($("#hoursTravel").value),
  };
  try {
    const s = await api("api/settings", { method: "POST", body: { hours } });
    applySettings(s);
    toast("小时窗口已保存，排程立即生效。");
  } catch (e) {
    humanErr(e, "保存窗口失败");
  }
}

async function saveDefaults() {
  // 顶部 .leg-check 是唯一选择源：「保存默认」保存的就是此刻顶部的勾选。
  const legs = selectedLegs();
  if (!legs.length) {
    toast("请至少勾选一条任务腿（积分任务 / 连登管家 / Buddy 盲盒 / 猫猫旅行 / 夜猫子）。", "warn");
    return;
  }
  const gapMs = Number($("#gapMs").value);
  const body = { legs, claim: $("#defClaim").checked };
  if (Number.isFinite(gapMs)) body.gapMs = gapMs;
  try {
    const s = await api("api/settings", { method: "POST", body });
    applySettings(s);
    toast("运行默认已保存（对下一次运行生效）。");
  } catch (e) {
    humanErr(e, "保存默认失败");
  }
}

async function toggleScheduler(ev) {
  const want = ev.target.checked;
  try {
    const s = await api("api/settings", { method: "POST", body: { scheduler: want } });
    applySettings(s);
    toast(want ? "排程已启用：到点自动运行。" : "排程已停用：只保留手动运行。");
  } catch (e) {
    ev.target.checked = !want;
    humanErr(e, "切换排程失败");
  }
}

// POST /api/settings 的响应就是完整 settings（{scheduler,claim,legs,gapMs,hours,host}）
function applySettings(s) {
  if (!s || !state.data) return;
  state.data.settings = {
    claim: s.claim,
    legs: s.legs,
    gapMs: s.gapMs,
    hours: s.hours,
    host: s.host,
  };
  if (typeof s.scheduler === "boolean") {
    state.data.scheduler = { ...(state.data.scheduler ?? {}), enabled: s.scheduler };
  }
  // 保存后强制用服务端返回的 settings.legs 回写顶部勾选（保存的是顶部选择，这里保证两边一致）。
  syncLegChecks(state.data.settings.legs, { force: true });
  renderScheduler();
}

// ---- 历史区 -----------------------------------------------------------------------------------

async function loadHistory() {
  try {
    const limit = state.history.limit;
    const r = await api("api/history", { params: { limit } });
    state.history.rows = Array.isArray(r?.rows) ? r.rows : [];
    const maxPage = Math.max(0, Math.ceil(state.history.rows.length / state.history.pageSize) - 1);
    if (state.history.page > maxPage) state.history.page = maxPage;
    renderHistory();
  } catch (e) {
    renderHistoryError(e);
  }
}

function renderHistoryError(e) {
  $("#histBody").replaceChildren(
    el("div", { class: "empty", text: `历史读取失败：${humanizeApiErr(String(e?.message ?? e), e?.data?.hint)}` }),
  );
  $("#histPager").replaceChildren();
}

function historyRow(r) {
  const gain = [];
  if (Number(r.credit) > 0) gain.push(`+${fmtNum(r.credit)} 积分`);
  if (Number(r.energy) > 0) gain.push(`+${fmtNum(r.energy)} 能量`);
  return el(
    "tr",
    {},
    el("td", { "data-label": "时间", class: "num", text: fmtDateTime(r.at) }),
    el("td", { "data-label": "账号" },
      el("span", { class: "cell-main", text: String(r.nickname || r.uid || "—") }),
      r.uid ? el("span", { class: "cell-sub", text: String(r.uid) }) : null,
    ),
    el("td", { "data-label": "腿", text: legName(r.leg) }),
    el("td", { "data-label": "结果" }, stepBadge(r.state)),
    el("td", { "data-label": "说明", class: "detail-cell", text: String(r.detail ?? "") || "—" }),
    el("td", { "data-label": "收益", class: "num", text: gain.length ? gain.join(" · ") : "—" }),
    el("td", { "data-label": "触发", text: TRIGGER_NAMES[r.trigger] ?? String(r.trigger ?? "—") }),
  );
}

function renderHistory() {
  const box = $("#histBody");
  const pager = $("#histPager");
  const rows = state.history.rows;
  if (!rows.length) {
    box.replaceChildren(
      el("div", { class: "empty", text: "还没有历史记录。跑一轮批量任务后，每次尝试（成功 / 跳过 / 失败）都会记一行。" }),
    );
    pager.replaceChildren();
    return;
  }
  const { page, pageSize } = state.history;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const slice = rows.slice(page * pageSize, (page + 1) * pageSize);
  box.replaceChildren(
    el(
      "table",
      { class: "tbl tbl-history" },
      el("thead", {},
        el("tr", {},
          el("th", { text: "时间" }),
          el("th", { text: "账号" }),
          el("th", { text: "腿" }),
          el("th", { text: "结果" }),
          el("th", { text: "说明" }),
          el("th", { text: "收益", class: "num" }),
          el("th", { text: "触发" }),
        ),
      ),
      el("tbody", {}, slice.map(historyRow)),
    ),
  );
  pager.replaceChildren(
    el("button", {
      type: "button",
      class: "mini-btn",
      text: "上一页",
      disabled: page <= 0,
      onclick: () => {
        state.history.page--;
        renderHistory();
      },
    }),
    el("span", { class: "mono", text: `${page + 1} / ${pages}` }),
    el("button", {
      type: "button",
      class: "mini-btn",
      text: "下一页",
      disabled: page >= pages - 1,
      onclick: () => {
        state.history.page++;
        renderHistory();
      },
    }),
    el("span", { text: `共 ${rows.length} 条` }),
  );
}

// ---- SSE + 轮询回退 ------------------------------------------------------------------------------

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => {
    loadState({ quiet: true });
    // /api/hello 只在启动探一次；失败后按这个既有轮询节奏（3s）重试，绝不为版本检查另开快循环。
    ensureHello();
  }, 3000);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = 0;
}

// job 运行期间即使 SSE 正常，也每 5s 拉一次 /api/state：daemon 只在步骤「新增」时推 step
// 事件，步骤完成态与 totals 的变化要靠 state 里的 job 快照拿到（纯本地读取，不触发上游）。
function syncJobTimer() {
  const active = !!state.data?.job && state.feed === "sse";
  if (active && !state.jobTimer) {
    state.jobTimer = setInterval(() => loadState({ quiet: true }), 5000);
  } else if (!active && state.jobTimer) {
    clearInterval(state.jobTimer);
    state.jobTimer = 0;
  }
}

function disconnectSSE() {
  if (state.esRetryTimer) {
    clearTimeout(state.esRetryTimer);
    state.esRetryTimer = 0;
  }
  if (state.es) {
    state.es.onopen = state.es.onerror = state.es.onmessage = null;
    try {
      state.es.close();
    } catch {}
    state.es = null;
  }
}

function connectSSE() {
  disconnectSSE();
  if (state.conn === "stopped") return;
  // 守护进程无鉴权：SSE 地址不带任何鉴权参数。
  const url = new URL("api/events", location.href);
  let es;
  try {
    es = new EventSource(url);
  } catch {
    state.feed = "poll";
    startPolling();
    renderTop();
    return;
  }
  state.es = es;
  let opened = false;
  let errs = 0;
  es.onopen = () => {
    opened = true;
    state.feed = "sse";
    stopPolling();
    renderTop();
    syncJobTimer();
  };
  es.onmessage = (e) => {
    try {
      handleSSE(JSON.parse(e.data));
    } catch {}
  };
  es.onerror = () => {
    if (state.feed !== "poll") {
      state.feed = "poll";
      renderTop();
    }
    startPolling();
    errs++;
    if (!opened && errs >= 2) {
      // 守护进程没起来：别再无限重连，30s 后再试一次（此间用 3s 轮询）
      disconnectSSE();
      state.esRetryTimer = setTimeout(() => {
        state.esRetryTimer = 0;
        connectSSE();
      }, 30000);
    }
  };
}

function handleSSE(evt) {
  if (!evt || typeof evt !== "object") return;
  if (evt.kind === "job" && evt.job) {
    const j = evt.job;
    if (j.state === "done" || j.state === "error") {
      state.lastFinished = j;
      if (state.data) state.data.job = null;
      state.lastSeenJobId = "";
      settleTrackedJob(j); // 活动任务收尾补查 / 连登管家结果回填
      renderJob();
      renderTop();
      syncJobTimer();
      loadState({ quiet: true });
      loadHistory();
    } else {
      state.lastFinished = null;
      if (state.data) state.data.job = j;
      else state.data = { job: j };
      state.lastSeenJobId = String(j.id ?? "");
      renderJob();
      renderTop();
      updateSelectionUI();
      syncJobTimer();
    }
    return;
  }
  if (evt.kind === "step" && evt.step) {
    const j = state.data?.job;
    if (j) {
      j.steps = [...(j.steps ?? []), evt.step];
      renderJob();
    }
    return;
  }
  if (evt.kind === "log") {
    const j = state.data?.job;
    if (j) {
      j.log = [...(j.log ?? []), String(evt.line ?? "")];
      renderJobLogs();
    }
    return;
  }
  if (evt.kind === "accounts") {
    // daemon 的账号变更广播（导入写入 / 重扫）：账号列表走只读 state 重拉
    if (evt.event === "import") {
      toast(`账号导入已写入：新增 ${Number(evt.added) || 0} · 更新 ${Number(evt.updated) || 0}`);
    }
    loadState({ quiet: true });
    return;
  }
  if (evt.kind === "scheduler") {
    const legs = (evt.legs ?? []).map(legName).join(" + ");
    if (evt.event === "fire") {
      toast(`排程触发：${evt.hour}:00 窗口 · ${legs}`);
      loadState({ quiet: true });
    } else if (evt.event === "skip") {
      toast(`排程跳过 ${evt.hour}:00 窗口（${legs || "—"}）：${evt.reason || "无可参与账号"}`, "warn", 7000);
    } else if (evt.event === "shutdown") {
      state.conn = "stopped";
      disconnectSSE();
      stopPolling();
      if (state.jobTimer) clearInterval(state.jobTimer);
      state.jobTimer = 0;
      if (state.elapsedTimer) clearInterval(state.elapsedTimer); // 秒级时长计时器一并停
      state.elapsedTimer = 0;
      state.feed = "idle";
      renderTop();
      toast(`守护进程已退出：${evt.reason || ""}`, "warn", 10000);
    }
  }
}

// ---- state 加载与总渲染 -------------------------------------------------------------------------

function renderAll() {
  renderTop();
  renderBanners();
  renderAccounts();
  renderJob();
  renderScheduler();
  updateSelectionUI();
  syncJobTimer();
}

async function loadState({ quiet = false } = {}) {
  try {
    const d = await api("api/state");
    state.data = d;
    // 老后端/后端并行实现期间 /api/state 可能暂时没带 credits：用本地已查到的值兜底，
    // 避免 3s 轮询把刚查到的余额刷回「未查询」。
    for (const a of Array.isArray(d?.accounts) ? d.accounts : []) {
      if (a.credits == null) {
        const cached = creditCache.get(String(a.uid ?? ""));
        if (cached) a.credits = cached;
      }
      // 连登状态同理（0.3.3 后端未落地时 streak 恒为 undefined）：本地已查到的值兜底，
      // 否则 3s 轮询会把连登数字刷回「未查询」。
      if (a.streak == null) {
        const cached = streakCache.get(String(a.uid ?? ""));
        if (cached) a.streak = cached;
      }
      // 活动任务同理（0.3.5 后端未落地时 campaign 恒为 undefined）：本地已查到的值兜底，
      // 否则 3s 轮询会把活动任务条刷回「未查询」（后端的 null 绝不能盖掉刚查到的结果）。
      if (a.campaign == null) {
        const cached = campaignCache.get(String(a.uid ?? ""));
        if (cached) a.campaign = cached;
      }
    }
    if (state.conn !== "stopped") state.conn = "online";
    reconcileJobs(); // job 从「有」变「无」= 上一轮结束（SSE 掉线时靠这里兜底收尾）
    renderAll();
    autoFetchCredits();
  } catch (e) {
    if (e && e.network) {
      if (state.conn !== "stopped") state.conn = "down";
      state.feed = "idle";
      renderTop();
    } else if (!quiet) {
      humanErr(e, "读取状态失败");
    }
  }
}

// ---- 守护进程启停 --------------------------------------------------------------------------------

async function stopDaemon() {
  const ok = confirm(
    "停止守护进程？\n\n正在运行的批量任务会在步骤边界中止，排程停止。\n注意：若 magpie 仍开启本插件，守护进程可能在下次加载时被重新拉起；要长期停用，请在 magpie 插件管理里关闭本插件（control.json 会写 desired=off）。",
  );
  if (!ok) return;
  try {
    await api("api/shutdown", { method: "POST" });
    state.conn = "stopped";
    state.feed = "idle";
    disconnectSSE();
    stopPolling();
    renderTop();
    toast("守护进程已停止。需要时用「启动命令」里的命令手动拉起，或在 magpie 里重开本插件。");
  } catch (e) {
    humanErr(e, "停止守护进程失败");
  }
}

// ---- 初始化 ------------------------------------------------------------------------------------

function wireStatic() {
  $("#themeBtn").addEventListener("click", cycleTheme);
  $("#daemonStopBtn").addEventListener("click", stopDaemon);
  $("#daemonStartBtn").addEventListener("click", () => $("#cmdDialog").showModal());
  $("#cmdCopyBtn").addEventListener("click", async () => {
    const ok = await copyText("node daemon.mjs");
    toast(ok ? "已复制：node daemon.mjs" : "复制失败，请手动选择文本复制。", ok ? "info" : "warn");
  });

  $("#selectAll").addEventListener("change", (ev) => {
    const elig = eligibleAccounts();
    state.selected.clear();
    if (ev.target.checked) for (const a of elig) state.selected.add(a.uid);
    for (const cb of $$(".acct-check")) cb.checked = state.selected.has(cb.value);
    updateSelectionUI();
  });
  $("#rescanBtn").addEventListener("click", rescanAccounts);

  $("#btnRun").addEventListener("click", runFull);
  $("#btnAccept").addEventListener("click", acceptSelected);
  $("#btnClaim").addEventListener("click", claimSelected);
  $("#btnCheckin").addEventListener("click", checkinSelected);
  $("#btnStreak").addEventListener("click", runStreakSelected);

  // 账号导出 / 导入（合并在账号卡片内的抽屉里）
  $("#ioToggleBtn").addEventListener("click", toggleIo);
  $("#ioTabExport").addEventListener("click", () => selectIoTab("export"));
  $("#ioTabImport").addEventListener("click", () => selectIoTab("import"));
  wireIoTabs();
  $("#expBtn").addEventListener("click", (ev) => exportAccounts(ev.currentTarget));
  $("#expSecrets").addEventListener("change", syncExportHints);
  $("#impPreviewBtn").addEventListener("click", importPreview);
  $("#impConfirmBtn").addEventListener("click", importConfirm);
  wireImportFile();

  $("#schedEnabled").addEventListener("change", toggleScheduler);
  $("#saveHoursBtn").addEventListener("click", saveHours);
  $("#saveDefaultsBtn").addEventListener("click", saveDefaults);

  $("#histRefreshBtn").addEventListener("click", loadHistory);
  $("#histLimit").addEventListener("change", (ev) => {
    state.history.limit = Number(ev.target.value) || 200;
    state.history.page = 0;
    loadHistory();
  });

  wireCreditsDialog();

  // 系统主题变化时（跟随系统模式下）刷新一次渲染即可（CSS 媒体查询自动换色）
  try {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme());
  } catch {}
}

// 拉一次 /api/hello 做版本一致性检查。拿到结果就不再打（不为版本检查每 3 秒发请求）；
// 失败返回错误实例交给调用方判断，并由 3s 轮询里的同一次调用重试。
async function ensureHello() {
  if (state.hello || state.helloBusy) return null;
  state.helloBusy = true;
  try {
    state.hello = await api("api/hello");
    renderTop();
    renderBanners();
    return null;
  } catch (e) {
    return e;
  } finally {
    state.helloBusy = false;
  }
}

async function boot() {
  renderTop();
  // 守护进程无鉴权：首屏直接渲染，hello / state / history / SSE 都不需要任何凭据。
  const helloErr = await ensureHello();
  if (helloErr && helloErr.network) {
    state.conn = "down";
    renderTop();
    $("#accountsList").replaceChildren(
      el("div", { class: "empty" },
        el("strong", {}, "连不上守护进程。"),
        "它可能没有启动：magpie 开启本插件时会自动拉起；也可在插件目录手动执行 ",
        el("code", { text: "node daemon.mjs" }),
        "，启动后刷新本页。实际端口与绑定地址写在 ",
        el("code", { text: "<状态目录>/daemon.json" }),
        "。",
      ),
    );
    return;
  }
  // 其余错误（含 hello 暂时拿不到）：继续读 state，让它把话说全
  if (state.conn !== "stopped") state.conn = "checking";
  await loadState();
  if (state.conn === "online") {
    connectSSE();
    loadHistory();
  }
}

function init() {
  applyTheme();
  wireStatic();
  syncExportHints(); // 「含凭据」默认勾上：警示/提示行按初始状态就位
  boot();
}

// Node 下 import 本模块（tests-shell 校验 addrModel 等纯函数）时没有 document：跳过启动。
// 浏览器行为不变。
if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
}

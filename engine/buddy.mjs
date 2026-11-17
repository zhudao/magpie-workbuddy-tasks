// buddy.mjs —— Buddy 盲盒腿（wb_tasks.do_buddy_open 的移植，参考
// 88lin/workbuddy-auto-signin 的开盒流程，hub commit 937c179）。
//
// 用积累的成长能量开启 Buddy 盲盒（/v2/activity/growth/buddy/open），避免能量
// 闲置。这是一条**独立腿**（CONTRACT §7）：
//   - 旅行状态门（A4，2026-11-16）：**开盒会覆盖在途旅行记录**（兄弟实现实测：
//     开盒接口会重置旅行，猫猫在外面/刚回来奖励没领时开盒 = 白丢一次旅行），所以
//     开盒前必须先 GET /activity/growth/buddy/travel/status，只有猫在家（idle）
//     才开；traveling/arrived/查询失败/状态未知一律跳过 —— 这条腿本来「不给明确
//     授权绝不自动花能量」，跳过永远比冒险开盒优先；
//   - 批量口径：quota 读出 affordable（当前能量还能开几个）与 max_open_count
//     （单次开盒上限），一次 POST 按 min(affordable, max(1, max_open_count)) 开；
//   - 排程口径：daemon 的 SCHEDULE_HOURS_LEGS 收 buddy，但默认 hours.buddy=[]
//     （开盲盒消耗成长能量，默认绝不自动跑，用户显式配窗口才生效）。
//   - 腿序说明：LEG_ORDER 仍是 buddy → travel，不需要调整 —— 状态门已保证开盒
//     只发生在 idle；buddy 在 travel 前意味着「arrived 先由 travel 腿领奖、下一轮
//     盲盒腿再开」，两腿各司其职（CONTRACT §7）。
//
// 红线：**不领积分、不加 credit** —— 开盒本身不产出积分，能量消耗也不计入收益；
// 本腿的产物只有 logs（人读过程）与 opened/name。所有上游调用走 callJSON
//（自带重试/退避/403-11140 restricted 透传 + chat 主机回退），经 opts.spacer 全局
// 节流器与其它路径共用「任意两次上游调用 ≥ gap」的红线；调用前 ctx.breathe。

import { randomUUID } from "node:crypto";
import { callJSON, ctxOf, growthBase as _growthBase } from "./upstream.mjs";

// runBuddyOpen(acct, opts) -> {ok, opened, name?, logs, restricted?}
// opts: {base?/bases?, gap?, now?, sleep?, fetch?, log(fn), spacer?, signal, env?}
export async function runBuddyOpen(acct, opts = {}) {
  const ctx = ctxOf(opts);
  const logs = [];

  if (acct?.provider !== "workbuddy") {
    return { ok: false, opened: 0, logs: ["国际版不适用国内成长任务中心"] };
  }
  if (acct?.enterpriseId) {
    return { ok: true, opened: 0, logs: ["企业版账号无成长体系，跳过"] };
  }

  // 0. 旅行状态门（A4）：开盒会覆盖在途旅行记录，只有 idle 才往下走。
  //    真机字段（2026-11-16 只读实测）：state（idle/traveling/arrived）、buddy_id、
  //    record_id、arrive_at/server_now（epoch 秒，idle 时 arrive_at=0）、
  //    daily_limit_reached、duration_hours、reward_credit；idle 时 location/letter
  //    是字符串 "null"（真 JSON null 都不是）—— 我们只读 state，其余字段不碰。
  await ctx.breathe(); // 防风控：与上一次上游调用之间 ≥ gap
  const ts = await callJSON(
    acct, "chat", chatUrl(opts) + "/activity/growth/buddy/travel/status",
    { method: "GET" },
    opts,
  );
  if (ts.restricted) {
    return { ok: false, opened: 0, logs: ["Buddy 盲盒: 账号已被风控限制"], restricted: true };
  }
  if (!ts.ok) {
    // 状态查询失败 → 保守跳过（不花能量、不冒覆盖旅行的险），ok:true 如实说明
    logs.push(`Buddy 盲盒: 旅行状态查询失败（${ts.msg || `HTTP ${ts.status ?? 0}`}），为免覆盖在途旅行，保守跳过开盒`);
    return { ok: true, opened: 0, logs };
  }
  const tstate = String(ts.data?.state ?? "");
  if (tstate === "traveling") {
    logs.push("Buddy 盲盒: 猫猫在外旅行，开盒会覆盖旅行记录，本轮跳过");
    return { ok: true, opened: 0, logs };
  }
  if (tstate === "arrived") {
    logs.push("Buddy 盲盒: 旅行归来有奖励待领，先由旅行腿领取，本轮跳过开盒");
    return { ok: true, opened: 0, logs };
  }
  if (tstate !== "idle") {
    // 未知状态值（上游新增/字段缺失）：同样保守跳过 —— 跳过永远比冒险开盒优先
    logs.push(`Buddy 盲盒: 旅行状态未知（state=${tstate || "缺失"}），保守跳过开盒`);
    return { ok: true, opened: 0, logs };
  }
  // idle：放行。daily_limit_reached 是**旅行自己的**每日名额，与开盒无关，不据此跳过。

  // 1. 配额查询：affordable = 当前成长能量还够开几个；max_open_count = 单次上限
  await ctx.breathe(); // 防风控：与上一次上游调用之间 ≥ gap
  const res = await callJSON(
    acct, "chat", chatUrl(opts) + "/v2/activity/growth/buddy/quota",
    { method: "GET" },
    opts,
  );
  if (res.restricted) {
    return { ok: false, opened: 0, logs: ["Buddy 盲盒: 账号已被风控限制"], restricted: true };
  }
  if (!res.ok) {
    const why = res.msg || `HTTP ${res.status ?? 0}`;
    logs.push(`Buddy 盲盒: 查询成长能量配额失败 (${why})`);
    return { ok: false, opened: 0, logs };
  }
  const affordable = Number(res.data?.affordable ?? 0) || 0;
  const maxOpen = Number(res.data?.max_open_count ?? 1) || 1;
  if (affordable <= 0) {
    // 能量不够是常态而非故障：ok:true，一步都不多发
    return { ok: true, opened: 0, logs: ["成长能量不足以开启 Buddy 盲盒"] };
  }
  const count = Math.min(affordable, Math.max(1, maxOpen));

  // 2. 开盒：body {count, client_token}（client_token 每次随机，幂等键由上游持有）
  await ctx.breathe();
  const open = await callJSON(
    acct, "chat", chatUrl(opts) + "/v2/activity/growth/buddy/open",
    { method: "POST", body: JSON.stringify({ count, client_token: randomUUID() }) },
    opts,
  );
  if (open.restricted) {
    return { ok: false, opened: 0, logs: ["Buddy 盲盒: 账号已被风控限制"], restricted: true };
  }
  if (!open.ok) {
    // B8：open 被 "no active buddy" 类拒绝 → 修理性检查/切换后**重试原请求一次**
    //（只在失败之后动手；没失败绝不发 switch）。三态文案见 repairActiveBuddy。
    if (isNoActiveBuddyMsg(open.msg)) {
      const rep = await repairActiveBuddy(acct, opts);
      if (rep.restricted) {
        return { ok: false, opened: 0, logs: [...logs, ...rep.logs], restricted: true };
      }
      logs.push(...rep.logs);
      if (rep.state === "switched") {
        await ctx.breathe();
        // 重试原请求：count 沿用本次配额；client_token 重新生成（上一次 open
        // 已失败未被消费，新 token 避免撞上一次的幂等键）
        const retry = await callJSON(
          acct, "chat", chatUrl(opts) + "/v2/activity/growth/buddy/open",
          { method: "POST", body: JSON.stringify({ count, client_token: randomUUID() }) },
          opts,
        );
        if (retry.restricted) {
          return { ok: false, opened: 0, logs, restricted: true };
        }
        if (retry.ok) {
          const data = retry.data ?? {};
          let rname = data.buddy || data.name || data.buddies || "新 Buddy";
          if (Array.isArray(rname)) rname = rname.length ? rname.join(", ") : "新 Buddy";
          logs.push(`Buddy 盲盒: ${rep.message}，重试成功 (${rname})`);
          return { ok: true, opened: count, name: String(rname), logs };
        }
        // 切换后重试仍失败：如实报错（绝不报成功）
        logs.push(`Buddy 盲盒: ${rep.message}，重试仍失败 (${retry.msg || `HTTP ${retry.status ?? 0}`})`);
        return { ok: false, opened: 0, logs };
      }
      if (rep.state === "switch_failed") {
        logs.push(`Buddy 盲盒: ${rep.message}：${rep.error}`);
        return { ok: false, opened: 0, logs };
      }
      if (rep.state === "none") {
        logs.push(`Buddy 盲盒: ${rep.message}`);
        return { ok: false, opened: 0, logs };
      }
      // already_selected / list_failed：状态可判但不在修复范围 —— 如实落到下面的
      // 通用失败行（rep.logs 已带清单失败/已选中的说明）
    }
    logs.push(`Buddy 盲盒: 开启失败 (${open.msg || `HTTP ${open.status ?? 0}`})`);
    return { ok: false, opened: 0, logs };
  }

  // 3. 解析开出的 Buddy 名：上游口径有 buddy / name / buddies（数组）三种拼写
  const data = open.data ?? {};
  let name = data.buddy || data.name || data.buddies || "新 Buddy";
  if (Array.isArray(name)) name = name.length ? name.join(", ") : "新 Buddy";
  logs.push(`Buddy 盲盒: 开启 ×${count} 成功 (${name})`);
  return { ok: true, opened: count, name: String(name), logs };
}

// ---- B8：Buddy 选中态（只读探测 + 修理性切换）--------------------------------
//
// 背景：兄弟实现有 buddy/switch{instance_id}；账号**已有 Buddy 实例但未被选中**
// 时，travel/depart 与 buddy/open 都会被上游以 "no active buddy" 拒绝 —— 旧逻辑
// 只会去补 first_buddy，错报「还没有 Buddy」。这里的口径（保守、只在需要时动手）：
//   - 探测（buddyListOf）随时可做，只读；
//   - 切换（POST /activity/growth/buddy/switch）**只**在「修理性」时机发生：
//     travel 腿 depart 失败且 msg 命中 "no active buddy"、或盲盒腿 open 拿到同类
//     拒绝之后 —— 先查清单：有实例但 current_buddy 全为 false 才选一个切过去，
//     再重试原请求一次。**没失败绝不发 switch**（绝不主动切换用户的 Buddy）。
// 真机事实（2026-11-16 生产只读探测，字段名照抄）：
//   GET {chat}/activity/growth/buddy/info  → data.buddy{instance_id,name,
//       personality,rarity,...} —— 这就是**当前选中的** Buddy；
//   GET {chat}/activity/growth/buddy/list  → data.buddies[]、data.count；每项含
//       current_buddy(bool)、instance_id、template_id、source("gacha")、
//       acquired_at、rarity。

// isNoActiveBuddyMsg(msg)：归一（trim+lower）后与 "no active buddy" **精确全等**
//（与 upstream.BENIGN_403_MSGS 的同一条目、同一匹配口径 —— 绝不模糊包含，
// 兄弟实现的教训：子串匹配会误伤真风控文案）。
export function isNoActiveBuddyMsg(msg) {
  return String(msg ?? "").trim().toLowerCase() === "no active buddy";
}

// acquireAtMs(v)：acquired_at 归一成 epoch ms。真机形状未逐字记录 —— 数字按
// hub normalize_epoch 口径（>1e11 已是毫秒），纯数字串同样处理，其余按 ISO 串
// Date.parse；解析不出 → 0（只影响「最早获得」的排序，不影响正确性）。
function acquireAtMs(v) {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e11 ? v : Math.round(v * 1000);
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 1e11 ? n : Math.round(n * 1000);
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : 0;
}

// pickBuddyToSelect(instances)：切换目标的选择（纯函数，测试直接钉）。
// 优先 source === "gacha"；其中取最早 acquired_at（acquireAtMs 升序第一个，
// 兼容原始 acquired_at 与归一后的 acquiredAtMs 两种输入）；都没有时间戳/取不到
// → 池子里第一个。返回实例对象或 null。
export function pickBuddyToSelect(instances) {
  const arr = (Array.isArray(instances) ? instances : []).filter(
    (b) => b && b.instance_id !== undefined && b.instance_id !== null && b.instance_id !== "",
  );
  if (!arr.length) return null;
  const gacha = arr.filter((b) => String(b.source ?? "") === "gacha");
  const pool = gacha.length ? gacha : arr;
  const withTs = pool
    .map((b) => ({ b, ts: acquireAtMs(b.acquired_at ?? b.acquiredAtMs) }))
    .filter((x) => x.ts > 0);
  if (withTs.length) {
    withTs.sort((a, x) => a.ts - x.ts);
    return withTs[0].b;
  }
  return pool[0];
}

// buddyListOf(acct, opts) -> {ok, current, instances, logs, error?, restricted?}
// 只读探测，buddy/travel 两腿共用：
//   current   = 当前选中的 instance_id | null（info 的 data.buddy.instance_id 优先，
//               info 缺失时用清单里 current_buddy===true 的那一项兜底）
//   instances = [{instance_id, name, rarity, current, source, acquiredAtMs}]
//   info 与 list 互不阻断：任一失败按缺失处理并如实记日志（logs）。**清单**是
//   三态诊断（为空 / 有实例未选中 / 已选中）的唯一依据 —— list 查询失败时整体
//   ok:false（调用方退回 ensureBuddy 老路，绝不把「查不到」误报成「没有」）。
export async function buddyListOf(acct, opts = {}) {
  const ctx = ctxOf(opts);
  const logs = [];
  let current = null;
  let infoError = "";

  // 1) info：当前选中的 Buddy（真机：data.buddy{instance_id,...}）
  await ctx.breathe(); // 防风控：与上一次上游调用之间 ≥ gap
  const info = await callJSON(
    acct, "chat", chatUrl(opts) + "/activity/growth/buddy/info",
    { method: "GET" },
    opts,
  );
  if (info.restricted) {
    return { ok: false, current: null, instances: [], logs, error: info.msg || "restricted", restricted: true };
  }
  if (info.ok) {
    const iid = info.data?.buddy?.instance_id;
    if (iid !== undefined && iid !== null && iid !== "") current = iid;
  } else {
    infoError = info.msg || `HTTP ${info.status ?? 0}`;
    logs.push(`Buddy info 查询失败（${infoError}），按缺失处理`);
  }

  // 2) list：实例清单（真机：data.buddies[]，每项 current_buddy/instance_id/...）
  await ctx.breathe();
  const list = await callJSON(
    acct, "chat", chatUrl(opts) + "/activity/growth/buddy/list",
    { method: "GET" },
    opts,
  );
  if (list.restricted) {
    return { ok: false, current, instances: [], logs, error: list.msg || "restricted", restricted: true };
  }
  if (!list.ok) {
    const error = list.msg || `HTTP ${list.status ?? 0}`;
    logs.push(`Buddy list 查询失败（${error}），按缺失处理`);
    return { ok: false, current, instances: [], logs, error };
  }
  const raw = Array.isArray(list.data?.buddies) ? list.data.buddies : [];
  const instances = raw
    .map((b) => ({
      instance_id: b?.instance_id,
      name: String(b?.name ?? ""),
      rarity: b?.rarity,
      current: b?.current_buddy === true,
      source: String(b?.source ?? ""),
      acquiredAtMs: acquireAtMs(b?.acquired_at),
    }))
    .filter((b) => b.instance_id !== undefined && b.instance_id !== null && b.instance_id !== "");
  if (!current) {
    const hit = instances.find((b) => b.current);
    if (hit) current = hit.instance_id;
  }
  return {
    ok: true,
    current,
    instances,
    logs,
    ...(infoError ? { infoError } : {}),
  };
}

// switchBuddy(acct, instanceId, opts)：POST {chat}/activity/growth/buddy/switch
// body {instance_id}。⚠️ **body 形状来自 WorkDaddy 参考、尚未真机验证**（2026-11-16
// 只读探测没有覆盖这个写接口）—— 上游若要求别的键名（如 instanceId / buddy_id），
// switch 会失败并如实报错，绝不静默换形重试。
async function switchBuddy(acct, instanceId, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe(); // 防风控：与上一次上游调用之间 ≥ gap
  return callJSON(
    acct, "chat", chatUrl(opts) + "/activity/growth/buddy/switch",
    { method: "POST", body: JSON.stringify({ instance_id: instanceId }) },
    opts,
  );
}

// repairActiveBuddy(acct, opts) -> {state, instances, logs, message?, error?, instanceId?, restricted?}
// 修理性选中态修复（只在 travel/buddy 两腿拿到 "no active buddy" 拒绝之后调用）。
// 三态诊断（state）：
//   "none"             清单为空 → 「还没有 Buddy（需先完成并领取「领取一只 Buddy」任务）」
//   "switched"         有实例但未选中 → 已 switch（pickBuddyToSelect），调用方重试原请求
//                      message = 「已有 Buddy（N 个）但未选中，已尝试切换后重试」
//   "switch_failed"    有实例但未选中 → switch 被拒 → message + error（上游 msg 原文），
//                      **绝不报成功**
//   "already_selected" 有实例且已有选中（info/current_buddy 给了 current）→ 不切换
//                     （绝不动用户已选中的 Buddy），调用方走原兜底
//   "list_failed"      清单查询失败 → 状态不可判，调用方走原兜底（如实带 error）
// restricted（403/11140）透传，由调用方走 §10.5 冻结。
export async function repairActiveBuddy(acct, opts = {}) {
  const logs = [];
  const probe = await buddyListOf(acct, opts);
  logs.push(...probe.logs);
  if (probe.restricted) return { state: "none", instances: [], logs, restricted: true };
  if (!probe.ok) {
    return { state: "list_failed", instances: [], logs, error: probe.error };
  }
  const instances = probe.instances;
  if (!instances.length) {
    return {
      state: "none",
      instances,
      logs,
      message: "还没有 Buddy（需先完成并领取「领取一只 Buddy」任务）",
    };
  }
  if (probe.current) {
    return { state: "already_selected", current: probe.current, instances, logs };
  }
  const pick = pickBuddyToSelect(instances);
  if (!pick) {
    return { state: "list_failed", instances, logs, error: "清单条目缺 instance_id，无法切换" };
  }
  const sw = await switchBuddy(acct, pick.instance_id, opts);
  if (sw.restricted) {
    return { state: "none", instances, logs, restricted: true };
  }
  if (!sw.ok) {
    return {
      state: "switch_failed",
      instances,
      logs,
      message: `已有 Buddy（${instances.length} 个）但未选中，切换失败`,
      error: sw.msg || `HTTP ${sw.status ?? 0}`,
    };
  }
  logs.push(`Buddy 选中态: 已切换到实例 ${pick.instance_id}`);
  return {
    state: "switched",
    instances,
    logs,
    instanceId: pick.instance_id,
    message: `已有 Buddy（${instances.length} 个）但未选中，已尝试切换后重试`,
  };
}

// ---- 内部小工具 ----------------------------------------------------------------

function chatUrl(opts = {}) {
  const fromOpts = String(opts.base || opts.bases?.chat || "").trim();
  return fromOpts ? fromOpts.replace(/\/+$/, "") : _growthBase(opts.env ?? globalThis.process?.env ?? {});
}

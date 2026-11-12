// miniprogram.mjs —— 微信小程序链式任务（Sequential_Tasks_1–6 + school_season，
// wb_tasks.run_miniprogram_tasks / MP_HEADERS / MP_REPORT_HEADERS / mp_base 的移植，
// 参考 L0NE-6/WorkBuddy-Daily 的小程序埋点协议与任务链设计，hub commit 937c179）。
//
// 与 web 侧成长任务（tasks.mjs）的关键差异：
//   - 清单/接取/领奖走同一批 growth 端点，但带**小程序专属标头**（MP_HEADERS：
//     X-Client-Platform: miniprogram + MicroMessenger UA）；
//   - 事件上报打 chat 域 /v2/report，但头是 chat 头族 + MP_REPORT_HEADERS
//     （X-Client-Product: workbuddy-mp / X-Client-Platform: mp-weixin /
//     X-Platform: wechatmp），事件体合并 mpBase（ideType=WorkBuddy_MP 等埋点指纹）；
//   - 事件按 code 生成（1/3/6/school=chat_request_send；2=expert_actual_use
//     WorkspaceBuilder；4=automated_task_create_suc；5=chat_request_send + GLM-5.2），
//     整个 need 的事件一次 report 发完，不逐条轮询进度（hub 口径：上报后等
//     1.5s 直接领，领不到就顺延下一轮）。
//
// 说明：0.3.0 起小程序任务**进任务快照/看板**——daemon.refreshSnapshots 在 web
// 清单之后用 fetchMPTasks 再拉一份 MP 清单，只合并 web 清单里没有的 code（同一
// code 以 web 清单为准）；/api/task/accept|claim 按 isMPCode 分流到本模块的
// acceptMPTasks / claimMPTask。批量执行链路不变：runGrowthTasks 在普通任务处理
// 完、猫猫旅行之前调用这里（opts.mpTasks === false 可整体关闭），日志与收益并入
// growth 腿。taskkind.resolveTaskKind 对 MP code（本表命中或未被 TASK_SPECS
// 收录的 Sequential_Tasks_ 前缀）返回 source:"mp"/kind:"mp"，tasks.progressTask
// 据此防御性跳过 web 事件构造 —— 本模块是 MP 任务唯一的执行出口。
//
// 防风控：所有上游调用走 callJSON（重试/退避/403-11140 restricted 透传/chat 主机
// 回退 + opts.spacer 全局节流）与 ctx.breathe，任意两次调用间隔 ≥ gap。

import { ACCEPT_CHUNK, REPORT_SETTLE_MS, TASK_SPECS, WEB_BASE } from "./constants.mjs";
import { defaultNow } from "./identity.mjs";
import { callJSON, ctxOf, growthBase as _growthBase } from "./upstream.mjs";

// ---- 小程序专属标头（wb_tasks.MP_HEADERS / MP_REPORT_HEADERS 逐字拷贝）--------
export const MP_HEADERS = {
  "X-Client-Platform": "miniprogram",
  "User-Agent":
    "Mozilla/5.0 (Linux; Android 14; MicroMessenger/8.0.49 WeChat/0.8.0 MiniProgramEnv/android; wkbrowser xweb)",
};

export const MP_REPORT_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json",
  "X-Client-Product": "workbuddy-mp",
  "X-Client-Version": "2.4.0",
  "X-Client-Platform": "mp-weixin",
  "X-Platform": "wechatmp",
};

// ---- 小程序任务规格（wb_tasks.MP_TASK_SPECS 逐字拷贝）-------------------------
// 注意 Sequential_Tasks_7 是 web 侧的 playbook 任务（constants.TASK_SPECS），
// 不在本表：MP 清单里出现它时 isMPCode（前缀兼容分支排除 TASK_SPECS 命中）
// 判它不算 MP → 本模块的清单过滤直接无视，执行权完全归 web 流水线（playbook
// 双事件链在 tasks.buildEvent 的 "playbook" 分支）。
export const MP_TASK_SPECS = {
  Sequential_Tasks_1: { name: "小程序对话", target: 1, reward: 100 },
  Sequential_Tasks_2: { name: "小程序专家对话", target: 1, reward: 200 },
  Sequential_Tasks_3: { name: "小程序对话5次", target: 5, reward: 300 },
  Sequential_Tasks_4: { name: "小程序定时任务", target: 1, reward: 100 },
  Sequential_Tasks_5: { name: "小程序GLM5.2", target: 1, reward: 100 },
  Sequential_Tasks_6: { name: "小程序对话10次", target: 10, reward: 400 },
  school_season: { name: "校园日活动", target: 1, reward: 100 },
};

// MP_TASK_CODES —— MP 专属 code 集合。runGrowthTasks 的「选中的任务不在任务表」
// 警告用它过滤：MP 任务永远不出现在 web 清单里，不能因为勾选了它们就误报。
export const MP_TASK_CODES = new Set(Object.keys(MP_TASK_SPECS));

// 支持的小程序 code：MP_TASK_SPECS 命中，或 Sequential_Tasks_ 前缀且**不在
// TASK_SPECS**（hub 口径，给未来同系列任务留兼容缝）。
// 2026-11-11 生产只读实测：web 清单也下发 Sequential_Tasks_7（体验灵感功能，
// constants.TASK_SPECS 的 PC/playbook 任务）——前缀兼容分支绝不吃掉它：否则
// runMiniProgramTasks 把它当 MP 任务「诚实跳过」（MP 头族生成不出 playbook
// 事件），web 流水线却还用 web 头去 acceptTasks 接它 → 上游必败 error。
// Sequential_Tasks_99 这类未收录前缀仍算 MP（兼容缝保留）。
export function isMPCode(code) {
  const c = String(code ?? "");
  if (MP_TASK_CODES.has(c)) return true;
  return c.startsWith("Sequential_Tasks_") && !Object.hasOwn(TASK_SPECS, c);
}

// ---- 埋点指纹（wb_tasks.mp_base 逐字拷贝）-------------------------------------
// mpBase(uid, nick, nowMs) -> 每条 MP 事件都要合并的公共字段。timestamp 一批
// 事件共用（一次 report 只取一次 now，与 hub 一致）。
export function mpBase(uid, nick, nowMs) {
  const now = Math.floor(nowMs ?? defaultNow());
  const safeUid = String(uid ?? "");
  return {
    timestamp: now,
    ideType: "WorkBuddy_MP",
    ideVersion: "2.4.0",
    extName: "workbuddy-mp",
    extVersion: "2.4.0",
    product: "SaaS",
    ideName: "wx_app_cloud",
    platform: "mini_program",
    source: "mini_program",
    os: "android",
    osVersion: "14",
    arch: "arm64",
    machineId: `mp-${safeUid.slice(0, 16) || "guest"}`,
    timezone: "Asia/Shanghai",
    userId: safeUid,
    userNickname: String(nick ?? ""),
  };
}

// ---- 查询 ----------------------------------------------------------------------

// fetchMPTasks(acct, opts) -> 规范任务数组（camelCase，CONTRACT §2 拼写）；
// name/target/reward 用 MP_TASK_SPECS 补齐（MP 清单的上游裸字段常缺这些）。
// 次日锁（0.3.2）：上游清单自带 locked/unlock_at（2026-11-07 实测：链式任务未
// 解锁时 locked:true + unlock_at:"…+08:00"，已解锁 locked:false）—— 原样归一
// 进规范 Task，快照投影（daemon.snapTask）以上游字段为唯一主依据。
export async function fetchMPTasks(acct, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe(); // 防风控：与上一次上游调用之间 ≥ gap
  const res = await callJSON(
    acct, "chat", chatUrl(opts) + "/v2/activity/growth/tasks",
    { method: "GET", headers: MP_HEADERS },
    opts,
  );
  if (!res.ok) return [];
  const rawTasks = res.data?.tasks ?? [];
  const tasks = [];
  for (const t of rawTasks) {
    const code = t.task_code || "";
    const spec = code && Object.hasOwn(MP_TASK_SPECS, code) ? MP_TASK_SPECS[code] : {};
    const prog = t.progress ?? {};
    tasks.push({
      code,
      title: t.title || spec.name || code,
      acceptStatus: t.accept_status || "not_accepted",
      // 上游锁字段逐字透传（上游缺失时归一 false/""，保证规范形状字段完备）
      locked: t.locked === true,
      unlockAt: String(t.unlock_at ?? ""),
      taskType: t.task_type || "",
      progress: {
        current: prog.current ?? 0,
        target: prog.target ?? spec.target ?? 1,
      },
      rewardCredit: t.reward_credit || spec.reward || 0,
    });
  }
  return tasks;
}

// ---- 接取 / 领奖 ----------------------------------------------------------------

// parseMPLock(message) -> { until: "YYYY-MM-DD" } | null（纯函数，导出供 daemon 的
// 防御层复用）。从上游接取失败原因里解析「锁到哪天」，已知形态（2026-11-07 生产
// 实测）："task locked until 2026-11-07"；容忍大小写、多余空白与中文表述
//（"锁定至/锁到/锁至 2026-11-07" 等）。只有日期而没有锁语义的消息不判锁（避免
// 把无关失败原因误判成锁）。解析不出 / 日期非法 → null。
export function parseMPLock(message) {
  const s = String(message ?? "");
  if (!s) return null;
  if (!/(?:task\s*)?locked|锁/i.test(s)) return null; // 必须带「锁」语义
  const m = /(\d{4}-\d{2}-\d{2})/.exec(s);
  if (!m || !isValidDayKey(m[1])) return null;
  return { until: m[1] };
}

// isValidDayKey("YYYY-MM-DD") -> 日历上真实存在的日期（2026-13-40 这类垃圾一律 false）
function isValidDayKey(s) {
  const [y, mo, d] = s.split("-").map(Number);
  if (!(mo >= 1 && mo <= 12)) return false;
  const t = Date.UTC(y, mo - 1, d);
  const dt = new Date(t);
  return Number.isFinite(t) && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// acceptMPTasks(acct, codes, opts) -> {ok, accepted[], failed[], failures[], msg, restricted?}
// 与 tasks.acceptTasks 同款批次语义（ACCEPT_CHUNK 上限、results 分账），头用 MP。
// failures[] 记录每个失败项的上游原因（{code, message}，与 failed 一一对应）；
// 原因里解析出锁（parseMPLock）时回调 opts.onLock?.(code, until, message)——
// daemon 据此落盘 mp-locks.json，回调异常只吞掉，绝不影响接取主流程。
export async function acceptMPTasks(acct, codes, opts = {}) {
  const ctx = ctxOf(opts);
  const out = { ok: true, accepted: [], failed: [], failures: [], msg: "" };
  if (!Array.isArray(codes) || !codes.length) return out;
  // 失败登记的唯一入口：failed/failures 同步维护，顺带解析锁回调
  const noteFailure = (code, message) => {
    const msg = String(message ?? "");
    out.failed.push(code);
    out.failures.push({ code, message: msg });
    const lock = parseMPLock(msg);
    if (lock) {
      try {
        opts.onLock?.(code, lock.until, msg);
      } catch {} // 回调是旁路信息收集，异常绝不打断接取
    }
  };
  const url = chatUrl(opts) + "/v2/activity/growth/tasks/accept";
  for (let i = 0; i < codes.length; i += Math.max(1, Number(opts.chunk ?? ACCEPT_CHUNK))) {
    await ctx.breathe(); // 批与批之间 ≥ gap
    const part = codes.slice(i, Math.max(1, Number(opts.chunk ?? ACCEPT_CHUNK)));
    const res = await callJSON(
      acct, "chat", url,
      { method: "POST", body: JSON.stringify({ task_codes: part }), headers: MP_HEADERS },
      opts,
    );
    if (res.restricted) {
      out.ok = false;
      out.restricted = true;
      out.msg = res.msg || "restricted";
      for (const code of part) noteFailure(code, out.msg);
      break;
    }
    if (!res.ok) {
      out.ok = false;
      out.msg = res.msg || `code=${res.code}`;
      for (const code of part) noteFailure(code, out.msg);
      continue;
    }
    const results = res.data?.results ?? [];
    const seen = new Set();
    for (const item of results) {
      const code = item.task_code;
      const st = String(item.status ?? "");
      seen.add(code);
      if (st === "accepted" || st === "already_accepted") out.accepted.push(code);
      else {
        noteFailure(code, item.message || st);
        out.msg = `${code}: ${item.message || st}`;
      }
    }
    for (const code of part) if (!seen.has(code)) noteFailure(code, "");
  }
  return out;
}

// claimMPTask(acct, code, opts) -> {ok, credit, energy, reason?, restricted?}
// MP 头族领奖；HTTP/信封 400（进度未落账）→ 按 tasks.claimTask 的同款思路降级
// 到 web 域（www.workbuddy.cn + webHeaders）再试一次。
export async function claimMPTask(acct, code, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe();
  const url = `${chatUrl(opts)}/activity/growth/tasks/${encodeURIComponent(code)}/claim`;
  const res = await callJSON(acct, "chat", url, { method: "POST", body: "{}", headers: MP_HEADERS }, opts);
  if (res.ok) {
    return { ok: true, credit: res.data?.credit ?? 0, energy: res.data?.energy ?? 0, reason: "" };
  }
  if (res.restricted) {
    return { ok: false, credit: 0, energy: 0, reason: res.msg || "restricted", restricted: true };
  }
  const chatReason = res.msg || `code=${res.code}` || `HTTP ${res.status}`;
  if (res.status === 400 || res.code === 400) {
    await ctx.breathe();
    const webUrl = `${WEB_BASE}/activity/growth/tasks/${encodeURIComponent(code)}/claim`;
    const res2 = await callJSON(acct, "web", webUrl, { method: "POST", body: "{}" }, opts);
    if (res2.ok) {
      return { ok: true, credit: res2.data?.credit ?? 0, energy: res2.data?.energy ?? 0, reason: "" };
    }
    return {
      ok: false, credit: 0, energy: 0,
      reason: res2.msg || chatReason,
      ...(res2.restricted ? { restricted: true } : {}),
    };
  }
  return { ok: false, credit: 0, energy: 0, reason: chatReason };
}

// ---- 上报 ----------------------------------------------------------------------

// reportMPEvents(acct, events, opts) -> boolean（信封 code===0）
// 每条事件合并 mpBase 公共字段（事件体字段优先），一次 POST 带整个数组；
// 头 = chat 头族 + MP_REPORT_HEADERS（Authorization 仍由 callJSON 的头族守护，
// 自定义头不可顶替凭据）。
export async function reportMPEvents(acct, events, opts = {}) {
  const ctx = ctxOf(opts);
  await ctx.breathe();
  const base = mpBase(acct?.uid, acct?.nickname, ctx.now());
  const arr = (Array.isArray(events) ? events : [events]).map((e) => ({ ...base, ...e }));
  const res = await callJSON(
    acct, "chat", chatUrl(opts) + "/v2/report",
    { method: "POST", body: JSON.stringify(arr), headers: MP_REPORT_HEADERS },
    opts,
  );
  return !!res.ok;
}

// ---- 事件构造（wb_tasks.run_miniprogram_tasks 的 per-code 分支逐字拷贝）--------
// mpEventForCode(code, i, cid, rid, now) -> 事件对象；不支持的 code 返回 null（跳过）。
export function mpEventForCode(code, i, cid, rid, now) {
  if (code === "Sequential_Tasks_2") {
    return {
      eventCode: "expert_actual_use", id: "WorkspaceBuilder", name: "WorkspaceBuilder",
      expertTitle: "工作台搭建师", type: "send_message", characterCount: 12,
      expertType: "agent", extVersion: "2.2.8",
    };
  }
  if (code === "Sequential_Tasks_4") {
    return {
      eventCode: "automated_task_create_suc", mode: "CLOUD",
      name: "每日任务提醒", source: "manually", skills: "",
      skillCount: 0, scheduleType: "daily",
    };
  }
  // Sequential_Tasks_1 / 3 / 6 / school_season / 5：chat_request_send（5 带 GLM-5.2）
  if (code === "Sequential_Tasks_1" || code === "Sequential_Tasks_3" ||
      code === "Sequential_Tasks_6" || code === "school_season" || code === "Sequential_Tasks_5") {
    const ev = {
      eventCode: "chat_request_send", mode: "chat", inputLength: 12,
      isPlan: false, isAutoExecuteTerminal: false, isAutoModify: false,
      codebaseEnable: false, maxToken: 0, maxSteps: 500, temperature: 0,
      maxRetries: 0, mentionContexts: [], knowledgeId: [], knowledgeName: [],
      codebaseId: "", mentionContextCount: 0, command: "",
      requestId: rid, traceId: rid, rootRequestId: rid,
      parentConversationId: cid, conversationId: cid,
      messageId: `msg-${now}-${i}`,
      agentName: "mp", agentType: "main",
      "codebuddy.session_id": cid,
      "codebuddy.conversation_request_id": rid,
    };
    if (code === "Sequential_Tasks_5") {
      ev.requestModelId = "glm-5.2";
      ev.requestModelName = "GLM-5.2";
    }
    return ev;
  }
  return null;
}

// ---- 主流程（wb_tasks.run_miniprogram_tasks 的移植）----------------------------

// runMiniProgramTasks(acct, opts) -> {ok, logs, earnedCredit, lit, claimed, restricted?}
// opts: {gap?, claim?, codes?: string[], mpTasks?: boolean（仅 runGrowthTasks 用）,
//        lockedCodes?: string[] | Set<string>（mp-locks 台账仍锁定的 code，整条跳过）,
//        onLock?(code, until, reason), onClaimed?(code),
//        log(fn), sleep(fn), now(fn), fetch, signal, spacer}
// opts.codes 非空 = 只处理选中的 MP 交集；交集为空时**连清单都不拉**（不白发请求）。
// 次日锁（0.3.2）双来源整条跳过（不进接取批次、不点亮、不领奖，记同一行跳过日志
// —— 不能把锁定任务塞进 accept 批次白撞一次）：清单自带 t.locked===true（上游
// 权威，2026-11-07 实测 实测账号 B ST3 形态）+ opts.lockedCodes（daemon 注入，来自
// state/mp-locks.json，旧缓存/防御回退）。claimed 优先判断：已领奖任务即使带着
// 陈旧锁记录也只记「已领奖，跳过」，不被锁字段挡住。
export async function runMiniProgramTasks(acct, opts = {}) {
  const ctx = ctxOf(opts);
  const logs = [];
  const claim = opts.claim !== false;

  if (acct?.provider !== "workbuddy" || acct?.enterpriseId) {
    return { ok: true, logs, earnedCredit: 0, lit: 0, claimed: 0 };
  }

  // 勾选交集预判：选中集合里没有任何 MP code → 小程序侧无事可做（不发上游）。
  const selected = mpSelectedSet(opts.codes);
  if (selected && ![...selected].some(isMPCode)) {
    return { ok: true, logs, earnedCredit: 0, lit: 0, claimed: 0 };
  }

  // 次日锁清单归一：空集合 = 无锁（null，省一次 has 判断）
  const locked = mpSelectedSet(opts.lockedCodes ?? []);

  let mpTasks = await fetchMPTasks(acct, opts);
  if (!mpTasks.length) {
    return { ok: true, logs, earnedCredit: 0, lit: 0, claimed: 0 };
  }

  const inScope = (code) => isMPCode(code) && (!selected || selected.has(code));
  let supported = mpTasks.filter((t) => inScope(t.code));
  if (!supported.length) {
    return { ok: true, logs, earnedCredit: 0, lit: 0, claimed: 0 };
  }

  logs.push(`📱 发现 ${supported.length} 个小程序成长任务，开始执行自动化...`);
  // 待接取批次剔除双来源锁定项（上游 t.locked 权威 + mp-locks 台账回退）：
  // 锁定任务接取必被上游拒，塞进批次只会白撞一次
  const unaccepted = supported
    .filter((t) => t.acceptStatus === "not_accepted" && t.locked !== true && !(locked && locked.has(t.code)))
    .map((t) => t.code);
  if (unaccepted.length) {
    const acc = await acceptMPTasks(acct, unaccepted, opts);
    if (acc.restricted) {
      return { ok: false, restricted: true, logs, earnedCredit: 0, lit: 0, claimed: 0 };
    }
    if (acc.accepted.length) {
      logs.push(`✓ 已接取小程序任务: ${acc.accepted.join(", ")}`);
    }
    if (acc.failed?.length) {
      const why = acc.msg || (acc.reasons ?? []).join("; ");
      logs.push(`! 小程序任务接取失败: ${acc.failed.join(", ")}${why ? `（${why}）` : ""}`);
    }
    await ctx.breathe();
    mpTasks = await fetchMPTasks(acct, opts);
  }

  let totalEarned = 0;
  let lit = 0;
  let claimed = 0;
  const now = Math.floor(ctx.now());
  // 领奖成功的统一出口：计数 + onClaimed 回调（daemon 记领奖日期并给链上下一环
  // 记锁）；回调是旁路信息收集，异常只吞掉，绝不影响主流程。
  const onClaimed = (code) => {
    try {
      opts.onClaimed?.(code);
    } catch {}
  };

  for (const t of mpTasks) {
    const code = t.code;
    if (!inScope(code)) continue;
    const status = t.acceptStatus;
    const cur = t.progress?.current ?? 0;
    const tgt = t.progress?.target ?? 1;
    const name = t.title || code;

    // claimed 优先判断：已领奖任务即使带着陈旧锁记录（mp-locks 台账/上游锁字段）
    // 也只记「已领奖，跳过」，不被锁字段挡住
    if (status === "claimed") {
      logs.push(`✓ 小程序任务 [${name}] 已领奖，跳过`);
      continue;
    }

    // 次日锁双来源（上游 t.locked 权威 + mp-locks 台账回退）：整条跳过，记同一行
    if ((locked && locked.has(code)) || t.locked === true) {
      logs.push(`⏳ 小程序任务 [${name}] 到第二天才能接取任务，跳过`);
      continue;
    }

    if (status === "completed" || cur >= tgt) {
      if (claim) {
        const res = await claimMPTask(acct, code, opts);
        if (res.ok) {
          totalEarned += res.credit ?? 0;
          claimed += 1;
          logs.push(`✓ 小程序任务 [${name}] 领奖成功: +${res.credit ?? 0} 积分`);
          onClaimed(code);
        } else {
          logs.push(`! 小程序任务 [${name}] 领奖失败: ${res.reason || "未知原因"}`);
          if (res.restricted) {
            return { ok: false, restricted: true, logs, earnedCredit: totalEarned, lit, claimed };
          }
        }
      }
      continue;
    }

    if (status === "not_accepted") continue; // 接取没成功：上报也是白费功夫

    // 已接取未完成：按 code 生成整批事件，一次 report 发完
    const need = Math.max(1, tgt - cur);
    const events = [];
    for (let i = 0; i < need; i++) {
      const cid = `wb-mp-${now}-${code}-${i}`;
      const rid = `req-${now}-${code}-${i}`;
      const ev = mpEventForCode(code, i, cid, rid, now);
      if (ev) events.push(ev);
    }
    if (!events.length) continue; // 无事件构造方式（未来未收录的 MP-only code）→ 跳过

    logs.push(`正在点亮小程序任务 [${name}] (需上报 ${need} 次)...`);
    await reportMPEvents(acct, events, opts);
    await ctx.breathe(REPORT_SETTLE_MS); // 上报后等上游落账（hub: time.sleep(1.5)）
    if (claim) {
      const res = await claimMPTask(acct, code, opts);
      if (res.ok) {
        totalEarned += res.credit ?? 0;
        lit += 1;
        claimed += 1;
        logs.push(`✓ 小程序任务 [${name}] 点亮并领奖成功: +${res.credit ?? 0} 积分`);
        onClaimed(code);
      } else {
        logs.push(`? 小程序任务 [${name}] 已上报，领奖将在下轮重试`);
        if (res.restricted) {
          return { ok: false, restricted: true, logs, earnedCredit: totalEarned, lit, claimed };
        }
      }
    }
    await ctx.breathe();
  }

  return { ok: true, logs, earnedCredit: totalEarned, lit, claimed };
}

// ---- 内部小工具 ----------------------------------------------------------------

// mpSelectedSet(opts.codes)：与 tasks.selectedCodeSet 同款防御归一（非空字符串
// 去重），非数组 / 空集合 → null（= 全部 MP 任务）。
function mpSelectedSet(codes) {
  if (!Array.isArray(codes)) return null;
  const out = new Set();
  for (const c of codes) {
    if (typeof c === "string" && c.trim()) out.add(c.trim());
  }
  return out.size ? out : null;
}

function chatUrl(opts = {}) {
  const fromOpts = String(opts.base || opts.bases?.chat || "").trim();
  return fromOpts ? fromOpts.replace(/\/+$/, "") : _growthBase(opts.env ?? globalThis.process?.env ?? {});
}

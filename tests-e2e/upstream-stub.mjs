// tests-e2e/upstream-stub.mjs —— e2e 专用的「假 WorkBuddy 上游」。
//
// 不是 mock 引擎，而是顶替网络本身：以 fetchImpl 的形状（{status, text}）实现
// 契约 §7 的真实端点，按 URL host/path 路由（引擎打向 copilot.tencent.com /
// www.codebuddy.cn / www.workbuddy.cn 的 URL 原样出现，不作弊改写）。带活状态：
// accept 翻 accept_status，report 按 (eventCode,id) 规则推进进度（专家事件按
// id 去重，夜猫事件只在 23:00-08:00 计数），claim 只在进度到位时成功，refresh
// 轮换 refresh token。每次到达都记 calls（含注入时钟时间戳），供「任意两次上游
// 调用 ≥1000ms」的全链路断言。

const DAY = 86400000;

export function makeUpstreamStub(clock, seed = {}) {
  const calls = [];
  const reports = [];
  const refreshes = [];
  const webClaims = [];
  const chatClaimRejects = [];
  const forcedChat400 = new Set(seed.forceChat400Once ?? []); // "uid|code"：chat 域首领 400 → 走 web 回退
  const seenExpertIds = new Set(); // "uid|id"：上游按 (eventCode,id) 去重
  let refreshSeq = 0;

  const tasks = new Map();
  for (const [uid, list] of Object.entries(seed.tasks ?? {})) {
    tasks.set(uid, list.map((t) => ({ ...t })));
  }
  const travel = new Map();
  for (const [uid, st] of Object.entries(seed.travel ?? {})) travel.set(uid, { ...st });

  const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });

  const findTask = (uid, code) => (tasks.get(uid) ?? []).find((t) => t.task_code === code);

  const inNightWindow = () => {
    const h = new Date(clock.now()).getHours();
    return h >= 23 || h < 8;
  };

  // 进度只在已接取（或 auto）任务上累计；到位即 completed。
  const lit = (uid, code) => {
    const t = findTask(uid, code);
    if (!t) return false;
    if ((t.current ?? 0) >= (t.target ?? 1)) return false;
    if (t.accept_status === "not_accepted" && t.task_type !== "auto") return false;
    t.current = (t.current ?? 0) + 1;
    if (t.current >= (t.target ?? 1)) t.accept_status = "completed";
    return true;
  };

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    const method = String(init.method || "GET").toUpperCase();
    const headers = init.headers ?? {};
    const uid = headers["X-User-Id"] ?? "";
    let body = null;
    try {
      body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    } catch {
      body = init.body;
    }
    const at = clock.now();
    calls.push({ at, url: String(url), host: u.host, path, method, uid, headers, body });

    // ---- token 刷新（轮换 refresh token；响应嵌套 data.data） ------------------
    if (path.endsWith("/refresh")) {
      const n = ++refreshSeq;
      const issued = {
        accessToken: `wb-access-ROTATED-${n}`,
        refreshToken: `wb-refresh-ROTATED-${n}`,
        expiresAt: clock.now() + 30 * DAY,
        refreshExpiresAt: clock.now() + 90 * DAY,
      };
      refreshes.push({
        uid,
        at,
        sentRefresh: headers["X-Refresh-Token"] ?? "",
        source: headers["X-Auth-Refresh-Source"] ?? "",
        issued,
      });
      return respond(200, { code: 0, data: { data: issued } });
    }

    // ---- 成长任务清单 -----------------------------------------------------------
    if (path === "/v2/activity/growth/tasks") {
      const list = (tasks.get(uid) ?? []).map((t) => ({
        task_code: t.task_code,
        title: t.title ?? t.task_code,
        description: "",
        jump_url: t.jump_url ?? "",
        accept_status: t.accept_status,
        task_type: t.task_type ?? "single",
        progress: { current: t.current ?? 0, target: t.target ?? 1 },
        reward_credit: t.reward_credit ?? 0,
        reward_energy: t.reward_energy ?? 0,
      }));
      return respond(200, { code: 0, data: { tasks: list } });
    }

    // ---- 批量接取 ---------------------------------------------------------------
    if (path === "/v2/activity/growth/tasks/accept") {
      const results = (body?.task_codes ?? []).map((code) => {
        const t = findTask(uid, code);
        if (!t) return { task_code: code, status: "unknown_task", message: "no such task" };
        if (t.accept_status === "not_accepted") {
          t.accept_status = "accepted";
          return { task_code: code, status: "accepted" };
        }
        return { task_code: code, status: "already_accepted" };
      });
      return respond(200, { code: 0, data: { results } });
    }

    // ---- 事件上报（body 是数组；缺 userId 静默丢弃） -----------------------------
    if (path === "/v2/report") {
      const list = Array.isArray(body) ? body : [];
      for (const ev of list) {
        reports.push({ uid, ev, at });
        if (!ev?.userId) continue;
        if (ev.eventCode === "skill_info") {
          lit(uid, "skill_1");
        } else if (ev.eventCode === "expert_actual_use") {
          if (ev.id === "ex_2cvvUZQhDyeJ") lit(uid, "Expert_lighthouse");
          else {
            const k = `${uid}|${ev.id}`;
            if (seenExpertIds.has(k)) continue; // 去重：进度不动
            seenExpertIds.add(k);
            lit(uid, "expert_5");
          }
        } else if (ev.eventCode === "chat_request_send") {
          if (ev.mode === "night") {
            if (inNightWindow()) lit(uid, "black_cat"); // 夜猫子只在 23:00-08:00 计数
          } else {
            const fb = findTask(uid, "first_buddy");
            if (fb && (fb.current ?? 0) < (fb.target ?? 1)) lit(uid, "first_buddy");
            else lit(uid, "chat_5");
          }
        }
        // 其余 eventCode：本 e2e 不依赖，忽略
      }
      return respond(200, { code: 0, data: {} });
    }

    // ---- 领奖（chat 域 400 → 引擎自己走 web 域回退） -----------------------------
    const claimMatch = /^\/activity\/growth\/tasks\/([^/]+)\/claim$/.exec(path);
    if (claimMatch) {
      const code = claimMatch[1];
      const onWeb = u.host === "www.workbuddy.cn";
      if (onWeb) webClaims.push({ uid, code, at });
      const t = findTask(uid, code);
      if (t && t.accept_status === "claimed") {
        if (!onWeb) chatClaimRejects.push({ uid, code, reason: "already claimed", at });
        return respond(400, { code: 400, msg: "already claimed" });
      }
      if (!onWeb && forcedChat400.has(`${uid}|${code}`)) {
        forcedChat400.delete(`${uid}|${code}`);
        chatClaimRejects.push({ uid, code, reason: "task not completed", at });
        return respond(400, { code: 400, msg: "task not completed" });
      }
      const done = !!t && (t.current ?? 0) >= (t.target ?? 1) && t.accept_status !== "not_accepted";
      if (done) {
        t.accept_status = "claimed";
        return respond(200, { code: 0, data: { credit: t.reward_credit ?? 0, energy: t.reward_energy ?? 0 } });
      }
      if (!onWeb) chatClaimRejects.push({ uid, code, reason: "task not completed", at });
      return respond(400, { code: 400, msg: "task not completed" });
    }

    // ---- 能量 / 连登 -------------------------------------------------------------
    if (path === "/v2/activity/growth/energy") {
      return respond(200, { code: 0, data: { balance: 42 } });
    }
    if (path === "/activity/growth/streak") {
      return respond(200, { code: 0, data: { streak: { days: 3 }, makeup_cards: { balance: 1 }, redemption_status: {} } });
    }

    // ---- 连登管家（0.3.3 streak 腿的其余端点）------------------------------------
    if (path === "/activity/growth/heatmap") {
      return respond(200, { code: 0, data: { days: [] } });
    }
    if (path === "/activity/growth/lottery/summary") {
      return respond(200, { code: 0, data: { chances: 0 } });
    }
    if (path === "/activity/growth/makeup-cards/use") {
      return respond(200, { code: 0, data: {} });
    }
    if (path === "/activity/growth/redeem") {
      return respond(200, { code: 0, data: {} });
    }
    if (path === "/activity/growth/lottery/draw") {
      return respond(200, { code: 0, data: { name: "5 积分" } });
    }
    if (path === "/billing/meter/claim-gift" || path === "/billing/meter/claim-compensation") {
      // 缺省「已领取过」：e2e 的账号都不是首日新号，业务拒绝走静默分支
      return respond(200, { code: 2101, msg: "already claimed" });
    }

    // ---- 猫猫旅行 -----------------------------------------------------------------
    if (path === "/activity/growth/buddy/travel/status") {
      return respond(200, { code: 0, data: travel.get(uid) ?? { state: "idle" } });
    }
    if (path === "/activity/growth/buddy/travel/config") {
      return respond(200, { code: 0, data: { locations: [{ id: 1, name: "外滩" }, { id: 2, name: "西湖" }] } });
    }
    if (path === "/activity/growth/buddy/travel/depart") {
      // first_buddy 的奖励就是 Buddy 实例：没领到就是 "no active buddy"
      const fb = findTask(uid, "first_buddy");
      if (!fb || fb.accept_status !== "claimed") {
        return respond(400, { code: 400, msg: "no active buddy" });
      }
      travel.set(uid, { state: "traveling" });
      return respond(200, { code: 0, data: { location: { id: body?.location_id ?? 1, name: "外滩" } } });
    }
    if (path === "/activity/growth/buddy/travel/claim") {
      travel.set(uid, { state: "idle" });
      return respond(200, { code: 0, data: { reward_credit: 20 } });
    }

    // ---- 计费侧（每日签到，手动 /api/checkin 用） ----------------------------------
    if (path === "/billing/meter/daily-checkin") {
      return respond(200, { code: 0, data: { credit: 5, streak: 3 } });
    }

    return respond(404, { code: -1, msg: "not found" });
  };

  return { fetchImpl, calls, reports, refreshes, webClaims, chatClaimRejects, tasks, travel };
}

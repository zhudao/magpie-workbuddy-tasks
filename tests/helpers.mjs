// tests/helpers.mjs —— 测试共用工具：假时钟 + 有状态的 WorkBuddy 假后端 + 测试沙箱。
// 全程零真实网络；所有等待走假时钟（sleep 只拨表，不真等）。

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function fakeClock(startMs) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
    get time() {
      return t;
    },
  };
}

// 本地某天某时的 epoch 毫秒（与时区无关的确定性测试时间）。
export function localTime(y, monthIndex, day, hour, minute = 0) {
  return new Date(y, monthIndex, day, hour, minute, 0, 0).getTime();
}

function cloneTask(t) {
  // 内部形态：current/target 拍平（引擎看到的列表响应里它们住在 progress 里）
  // 上游锁字段（0.3.2 实测）：种子带了才透传（模拟上游清单自带 locked/unlock_at）
  return {
    task_code: t.task_code,
    title: t.title ?? t.task_code,
    description: t.description ?? "",
    jump_url: t.jump_url ?? "",
    accept_status: t.accept_status ?? t.status ?? "not_accepted",
    task_type: t.task_type ?? "single",
    reward_credit: t.reward_credit ?? 100,
    reward_energy: t.reward_energy ?? 0,
    current: t.progress?.current ?? t.current ?? 0,
    target: t.progress?.target ?? t.target ?? 1,
    ...(t.locked !== undefined ? { locked: t.locked } : {}),
    ...(t.unlock_at !== undefined ? { unlock_at: t.unlock_at } : {}),
  };
}

// wbBackend 造一个记录全部请求的假 WorkBuddy：
// - state.tasks 是活状态：accept 会翻 accept_status，report 按 litRules 推进
//   current（到 target 且已接取则 completed），claim 在达标时翻 claimed；
// - litRules: { eventCode: taskCode | [taskCode...] }（同 eventCode 多任务时
//   依序找第一个未满的）；
// - failAcceptOnce: 第一次 accept 整批回信封错误（测二次补接）；
// - buddyDepartFails: 前 N 次 depart 回 400 "no active buddy"（测补 first_buddy
//   后重试）；
// - chatClaimAlways400: chat 域领奖永远 400（测 web 回退）；
// - restrictedUids: 这些 uid 一律 403/code 11140；
// - refreshTokens: 刷新路由按序吐 {accessToken, ...}。
// - buddyQuota: {affordable, max_open_count}（Buddy 盲盒配额，缺省 affordable 0）；
//   buddyOpenResponse: 开盒响应信封（缺省 code 0 + data.buddies）；buddyOpens
//   记录每次开盒请求体。
// - mpOnly: 这批 task_code 只出现在小程序标头的清单里（X-Client-Platform:
//   miniprogram 的 GET /v2/activity/growth/tasks 只回它们；web 清单不回）——
//   模拟真实环境「web 清单与 MP 清单是两份」的口径。
// - streak（0.3.3 连登管家腿）：{days, makeupBalance, chances, heatmap:[{date,score}],
//   redemption_status:{...}} —— 三个 GET（streak/heatmap/lottery summary）的响应；
//   makeupResponse / redeemResponse / lotteryDrawResponse：对应 POST 的信封
//   （缺省 code 0）；giftResponses: {"claim-gift"| "claim-compensation": 信封}
//   （缺省 code 0 + credit）。streakMakeups/streakRedeems/streakDraws/giftClaims
//   记录每次 POST 请求体。
// redemptionBody(raw)：把测试里好写的档位写法转成**上游真实形状**（见上面 streak 分支
// 的注释）：
//   {"7d":"available","14d":"locked"} -> {tiers:[{tier:"7d"},{tier:"14d"}],
//                                         tier_7d_status:"available", tier_14d_status:"locked"}
//   已经是真实形状（带 tier_*_status / tiers）-> 原样透传，供「照真实报文钉死解析」的用例用。
function redemptionBody(raw) {
  if (Array.isArray(raw)) return raw; // 数组形态 [{tier,status}]：原样透传（引擎也认）
  const rs = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  if (Object.keys(rs).some((k) => /^tier_\d+d_status$/.test(k))) return rs; // 真实形状：原样
  const out = { tiers: [] };
  for (const tier of ["7d", "14d", "28d"]) {
    if (rs[tier] != null && rs[tier] !== "") {
      out.tiers.push({ tier });
      out[`tier_${tier}_status`] = rs[tier];
    }
  }
  if (Array.isArray(rs.tiers)) out.tiers = rs.tiers;
  return out;
}

export function wbBackend(opts = {}) {
  const clock = opts.clock;
  const calls = [];
  const litRules = opts.litRules ?? {};
  const state = {
    tasks: (opts.tasks ?? []).map((t) => ({ ...cloneTask(t) })),
    travel: opts.travel ? { ...opts.travel } : { state: "traveling" },
    claims: [],
    acceptCalls: 0,
    reports: [],
    bodies: [],
    failAcceptOnce: opts.failAcceptOnce ?? false,
    buddyDepartFails: opts.buddyDepartFails ?? 0,
    chatClaimAlways400: opts.chatClaimAlways400 ?? false,
    restrictedUids: new Set(opts.restrictedUids ?? []),
    refreshTokens: [...(opts.refreshTokens ?? [])],
    webClaims: 0,
    buddyQuota: opts.buddyQuota ?? { affordable: 0, max_open_count: 1 },
    buddyOpenResponse: opts.buddyOpenResponse ?? { code: 0, data: { buddies: ["布丁猫"] } },
    buddyOpens: [],
    mpOnly: new Set(opts.mpOnly ?? []),
    checkinResponse: opts.checkinResponse ?? null,
    // 连登管家（0.3.3）：GET 三件套的固定快照 + POST 的响应/台账
    streak: opts.streak ?? null,
    makeupResponse: opts.makeupResponse ?? { code: 0, data: {} },
    redeemResponse: opts.redeemResponse ?? { code: 0, data: {} },
    lotteryDrawResponse: opts.lotteryDrawResponse ?? { code: 0, data: { name: "5 积分" } },
    giftResponses: opts.giftResponses ?? {},
    streakMakeups: [],
    streakRedeems: [],
    streakDraws: [],
    giftClaims: [],
  };
  const find = (code) => state.tasks.find((t) => t.task_code === code);
  const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = String(init.method || "GET").toUpperCase();
    const headers = init.headers ?? {};
    const uid = headers["X-User-Id"] ?? "";
    let body = null;
    if (typeof init.body === "string" && init.body.length) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, host: u.host, path: u.pathname, method, headers, body, at: clock.now(), uid });

    if (state.restrictedUids.has(uid)) {
      return respond(403, { code: 11140, msg: "request illegal" });
    }

    if (u.pathname.endsWith("/refresh")) {
      const tok = state.refreshTokens.shift();
      if (!tok) return respond(401, { code: 12153, msg: "refresh token failed: invalid_grant" });
      return respond(200, { code: 0, data: tok });
    }

    if (u.pathname === "/v2/activity/growth/tasks") {
      // mpOnly：小程序标头的清单只回 MP 任务，web 清单不含它们（真实两份清单口径）
      const isMPFetch = headers["X-Client-Platform"] === "miniprogram";
      const tasks = state.tasks
        .filter((t) => (isMPFetch ? state.mpOnly.has(t.task_code) : !state.mpOnly.has(t.task_code)))
        .map((t) => ({
          task_code: t.task_code,
          title: t.title,
          description: t.description,
          jump_url: t.jump_url,
          accept_status: t.accept_status,
          // 上游锁字段（0.3.2）：种子带了才出现在响应里（缺失 = 上游没给，
          // 引擎 fetchMPTasks 归一 false/""）
          ...(t.locked !== undefined ? { locked: t.locked } : {}),
          ...(t.unlock_at !== undefined ? { unlock_at: t.unlock_at } : {}),
          task_type: t.task_type,
          progress: { current: t.current, target: t.target },
          reward_credit: t.reward_credit,
          reward_energy: t.reward_energy,
        }));
      return respond(200, { code: 0, data: { tasks } });
    }

    if (u.pathname === "/v2/activity/growth/tasks/accept") {
      state.acceptCalls += 1;
      if (state.failAcceptOnce && state.acceptCalls === 1) {
        return respond(200, { code: 500, msg: "upstream hiccup" });
      }
      const results = (body?.task_codes ?? []).map((code) => {
        const t = find(code);
        if (!t) return { task_code: code, status: "unknown_task", message: "no such task" };
        if (t.accept_status === "not_accepted") {
          t.accept_status = "accepted";
          return { task_code: code, status: "accepted" };
        }
        return { task_code: code, status: "already_accepted" };
      });
      return respond(200, { code: 0, data: { results } });
    }

    if (u.pathname === "/v2/report") {
      state.bodies.push(body);
      for (const ev of Array.isArray(body) ? body : [body]) {
        state.reports.push(ev);
        const rule = litRules[ev.eventCode];
        const targets = Array.isArray(rule) ? rule : rule ? [rule] : [];
        for (const code of targets) {
          const t = find(code);
          if (!t || (t.current ?? 0) >= (t.target ?? 1)) continue;
          t.current = (t.current ?? 0) + 1;
          // auto 任务（first_buddy）不需要接取也能点亮完成
          if (t.current >= (t.target ?? 1) && (t.accept_status !== "not_accepted" || t.task_type === "auto")) {
            t.accept_status = "completed";
          }
          break; // 一个事件只推一个任务
        }
      }
      return respond(200, { code: 0, data: {} });
    }

    const claimMatch = /^\/activity\/growth\/tasks\/([^/]+)\/claim$/.exec(u.pathname);
    if (claimMatch) {
      const code = decodeURIComponent(claimMatch[1]);
      const onWebHost = u.host === "www.workbuddy.cn";
      if (!onWebHost && state.chatClaimAlways400) {
        return respond(400, { code: 400, msg: "task not completed" });
      }
      if (onWebHost) state.webClaims += 1;
      const t = find(code);
      if (t && (t.current ?? 0) >= (t.target ?? 1) && (t.accept_status !== "not_accepted" || t.task_type === "auto")) {
        t.accept_status = "claimed";
        state.claims.push(code);
        return respond(200, { code: 0, data: { credit: t.reward_credit ?? 0, energy: t.reward_energy ?? 0 } });
      }
      return respond(400, { code: 400, msg: "task not completed" });
    }

    if (u.pathname === "/v2/activity/growth/energy") {
      return respond(200, { code: 0, data: { balance: 42 } });
    }

    // ---- 连登管家（0.3.3，engine/streak.mjs）------------------------------------
    // 三个 GET 一律按**上游真实外壳**回（不然引擎按真实字段解析的回归测不出来）：
    //   streak  → data.streak.days / data.makeup_cards.balance / data.redemption_status
    //             （状态是**平铺的 tier_7d_status / tier_14d_status / tier_28d_status**，
    //              另带 tiers 清单；2026-11-11 生产实测）
    //   heatmap → data.cells:[{date,score}]（同上；0.3.3 第一版按 data.days 解析，
    //             真实环境一直 0 格 —— 假后端照真实形状回才能钉住这类错）
    //   lottery → data.chances
    if (u.pathname === "/activity/growth/streak") {
      const s = state.streak;
      return respond(200, {
        code: 0,
        data: {
          streak: { days: s?.days ?? 0 },
          makeup_cards: { balance: s?.makeupBalance ?? 0 },
          redemption_status: redemptionBody(s?.redemption_status),
        },
      });
    }

    if (u.pathname === "/activity/growth/heatmap") {
      return respond(200, { code: 0, data: { cells: state.streak?.heatmap ?? [] } });
    }

    if (u.pathname === "/activity/growth/lottery/summary") {
      return respond(200, { code: 0, data: { chances: state.streak?.chances ?? 0 } });
    }

    if (u.pathname === "/activity/growth/makeup-cards/use") {
      state.streakMakeups.push(body);
      return respond(200, state.makeupResponse);
    }

    if (u.pathname === "/activity/growth/redeem") {
      state.streakRedeems.push(body);
      return respond(200, state.redeemResponse);
    }

    if (u.pathname === "/activity/growth/lottery/draw") {
      state.streakDraws.push(body);
      return respond(200, state.lotteryDrawResponse);
    }

    if (u.pathname === "/billing/meter/claim-gift" || u.pathname === "/billing/meter/claim-compensation") {
      const key = u.pathname.endsWith("claim-gift") ? "claim-gift" : "claim-compensation";
      state.giftClaims.push({ key, body });
      const override = state.giftResponses[key];
      return respond(200, override ?? { code: 0, data: { name: key === "claim-gift" ? "新手礼包" : "活动补偿", credit: 50 } });
    }

    if (u.pathname === "/billing/meter/daily-checkin") {
      // 手动签到（daemon.doCheckin）：响应形状由 checkinResponse 控制（0.3.3 回执
      // 细分用），缺省 = 签到成功 +5
      return respond(200, state.checkinResponse ?? { code: 0, data: { credit: 5, streak: 3 } });
    }

    if (u.pathname === "/v2/activity/growth/buddy/quota") {
      return respond(200, {
        code: 0,
        data: { affordable: state.buddyQuota.affordable, max_open_count: state.buddyQuota.max_open_count },
      });
    }

    if (u.pathname === "/v2/activity/growth/buddy/open") {
      state.buddyOpens.push(body);
      return respond(200, state.buddyOpenResponse);
    }

    if (u.pathname === "/activity/growth/buddy/travel/status") {
      return respond(200, { code: 0, data: state.travel });
    }

    if (u.pathname === "/activity/growth/buddy/travel/config") {
      return respond(200, { code: 0, data: { locations: [{ id: 1, name: "外滩" }, { id: 2, name: "西湖" }] } });
    }

    if (u.pathname === "/activity/growth/buddy/travel/depart") {
      if (state.buddyDepartFails > 0) {
        state.buddyDepartFails -= 1;
        return respond(400, { code: 400, msg: "no active buddy" });
      }
      state.travel = { state: "traveling" };
      return respond(200, { code: 0, data: { location: { id: body?.location_id ?? 1, name: "外滩" } } });
    }

    if (u.pathname === "/activity/growth/buddy/travel/claim") {
      state.travel = { state: "idle" };
      return respond(200, { code: 0, data: { reward_credit: 20 } });
    }

    return respond(404, { code: -1, msg: "not found" });
  };

  return { fetchImpl, calls, state };
}

// 构造 Account（引擎内部形状）。
export function makeAcct(overrides = {}) {
  return {
    key: "workbuddy",
    provider: "workbuddy",
    uid: "u-12345678",
    nickname: "测试账号",
    access: "access-token-abc",
    refresh: "refresh-token-xyz",
    expires: 0,
    refreshExpiresAt: 0,
    domain: "",
    enterpriseId: "",
    tokenType: "",
    source: "oauth",
    isApiKey: false,
    tasksEnabled: true,
    ...overrides,
  };
}

// 任务种子的简写。extra.locked / extra.unlock_at（可选）：上游清单的次日锁字段，
// 只有用例显式给了才出现在清单响应里（模拟「上游带/不带锁字段」两种形态）。
export function task(code, extra = {}) {
  return {
    task_code: code,
    title: extra.title ?? code,
    description: "",
    jump_url: extra.jump_url ?? "",
    accept_status: extra.status ?? "not_accepted",
    task_type: extra.task_type ?? "single",
    progress: { current: extra.current ?? 0, target: extra.target ?? 1 },
    reward_credit: extra.reward ?? 100,
    reward_energy: extra.reward_energy ?? 0,
    ...(extra.locked !== undefined ? { locked: extra.locked } : {}),
    ...(extra.unlock_at !== undefined ? { unlock_at: extra.unlock_at } : {}),
  };
}

// ---- 测试沙箱（temp 临时目录）卫生 -----------------------------------------
//
// 为什么每条测试要「独立」目录：刻意为之的并发隔离 —— node --test 会把不同测试
// 文件并行跑在不同进程里，同一文件内的用例也可能交错执行；daemon 状态文件
// （control.json / settings.json / daemon.json / daemon.heartbeat / snapshots.json）
// 全都以 stateDir 为唯一边界，共享目录会让用例互相踩到对方的状态。所以每条用例
// 通过 makeSandbox 独占一个 mkdtemp 目录，用完即删。
//
// 历史缺陷（本节存在的理由）：早期测试只 mkdtemp 不删除，跑一次全套 temp 里就涨
// 一批 wb-* 沙箱（曾积到 2463+ 个）。卫生线有三道，全部零轮询：
//   1. 用例自己 cleanup()（finally / t.after 里）—— 正常路径，用完即删；
//   2. 每个测试文件顶层 after(() => cleanupAllSandboxes()) —— 用例漏删的兜底；
//   3. process.on("exit") 钩子 —— 进程异常退出（未捕获异常 / process.exit）时
//      同步删掉所有已登记沙箱。'exit' 回调只能做同步事，rmSync 正合适。
// 删除失败不升级成测试失败：Windows 上文件被占用（杀毒/句柄未释放）会出现
// EBUSY/EPERM，force 之外重试一次，仍失败打印一行提示并放弃。
//
// 「迟到写」防御（墓碑文件）：daemon 的 refreshSnapshots 是 fire-and-forget
// （finalizeJob → refreshSnapshots().catch()，首笔写之前还有 ≥1s 的真实限速
// sleep）。用例收尾时目录已删，这条在途链之后才醒来落盘 —— 而 daemon 的
// writeJson 会 mkdirSync(dirname) 把已删目录原地重建（实测只剩一个
// snapshots.json）。防法：rmSync 成功后立刻在原路径放一个同名空文件，迟到的
// writeJson 会 mkdirSync 撞上「路径已是文件」而被它自己的 try/catch 静默吞掉，
// 目录再也建不回来。墓碑在进程 exit 时统一摘除（那时事件循环已排空 —— 挂着
// 的 sleep 定时器都 firing 完了，不可能再有任何写）。

const sandboxes = new Set(); // 已登记、尚未删掉的沙箱绝对路径
const tombstones = new Set(); // 沙箱删掉后压在原路径上的墓碑文件（exit 时摘除）
let exitHookInstalled = false;

function installSandboxExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    cleanupAllSandboxes();
    removeTombstones();
  });
}

// 在已删沙箱的原路径放一个空文件，挡住迟到的写盘把目录重建出来。
function placeTombstone(dir) {
  try {
    writeFileSync(dir, "");
    tombstones.add(dir);
  } catch {
    // 放不上也不影响正确性：只是这条沙箱对「迟到写」不设防（概率极低）
  }
}

// 摘除全部墓碑（进程退出前；事件循环已排空，不再有任何写盘竞争者）。
function removeTombstones() {
  for (const t of [...tombstones]) {
    try {
      unlinkSync(t);
    } catch {
      // 删不掉就留着：0 字节文件，无内容、无风险
    }
    tombstones.delete(t);
  }
}

// 删一个沙箱：成功或最终放弃都会从登记簿销账（放弃只告警，不抛 —— 卫生问题
// 不该把测试判失败）。对未登记/不存在的路径幂等（不会误放假墓碑）。
export function cleanupSandbox(dir) {
  const owned = sandboxes.has(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    const retryable = e.code === "EBUSY" || e.code === "EPERM" || e.code === "ENOTEMPTY";
    if (retryable) {
      try {
        rmSync(dir, { recursive: true, force: true }); // Windows 文件占用：稍顷重试一次
      } catch (e2) {
        console.warn(`[tests/helpers] 沙箱清理失败（已放弃，不影响测试结果）：${dir} (${e2.code ?? e2.message})`);
        return;
      }
    } else {
      console.warn(`[tests/helpers] 沙箱清理失败（已放弃，不影响测试结果）：${dir} (${e.code ?? e.message})`);
      return;
    }
  }
  sandboxes.delete(dir);
  if (owned) placeTombstone(dir);
}

// mkdtemp 一个独立沙箱并登记到本进程；返回 { dir, cleanup }。
// prefix 形如 "wb-tasks-"（mkdtemp 会在尾部补 6 位随机串）。
export function makeSandbox(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  sandboxes.add(dir);
  installSandboxExitHook();
  return {
    dir,
    cleanup: () => cleanupSandbox(dir),
  };
}

// 仍在登记簿里的沙箱（创建了但还没被 cleanup 的），按创建序返回。
export function pendingSandboxes() {
  return [...sandboxes];
}

// 一次性清理登记簿里的全部沙箱（after 兜底与 exit 钩子共用），返回回收个数。
export function cleanupAllSandboxes() {
  let swept = 0;
  for (const dir of [...sandboxes]) {
    cleanupSandbox(dir);
    if (!sandboxes.has(dir)) swept += 1;
  }
  return swept;
}

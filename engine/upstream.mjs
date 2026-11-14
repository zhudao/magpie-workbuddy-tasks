// upstream.mjs —— 上游调用的统一入口：信封、重试、退避、403/11140 限权、
// chat 主机失联回退（CONTRACT §2）；以及跨路径共用的全局节流器 makeSpacer
//（铁律 4：任意两次上游调用 ≥1s、绝不在途并行）。
//
// 零真实网络：fetch 一律来自 opts.fetch ?? globalThis.fetch，测试注入假
// responder。时钟同理：opts.now / opts.sleep，引擎逻辑里绝不直接摸
// Date.now()/setTimeout（兜底 defaultNow 仅在调用方什么都不给时用）。

import * as identity from "./identity.mjs";
import {
  BILL_BASE,
  CHAT_BASE,
  CHAT_FALLBACK_BASE,
  DEFAULT_GAP_MS,
  REFRESH_PATH,
  WEB_BASE,
} from "./constants.mjs";

// 兜底时钟（生产 runner/daemon 会注入真时钟；测试注入假时钟）。
export const clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// ---- base -------------------------------------------------------------------
// growthBase：默认 https://copilot.tencent.com；环境变量 WB_GROWTH_BASE /
// WB_CN_CHAT_UPSTREAM 可覆盖（与 hub 的 wb_identity.CN_CHAT_BASE 同口径）。
export function growthBase(env = globalThis.process?.env ?? {}) {
  const raw = String(env.WB_GROWTH_BASE || env.WB_CN_CHAT_UPSTREAM || "").trim();
  if (!raw) return CHAT_BASE;
  const base = raw.replace(/\/+$/, "");
  const m = /^(https?:\/\/)/.exec(base);
  return m ? base : CHAT_BASE;
}

export function billBase() {
  return BILL_BASE;
}

export function webBase() {
  return WEB_BASE;
}

// chatBase：growthBase，可被 opts.base / opts.bases.chat（daemon 的
// settings.host）覆盖。
export function chatBase(opts = {}) {
  const fromOpts = String(opts.base || opts.bases?.chat || "").trim();
  return fromOpts ? fromOpts.replace(/\/+$/, "") : growthBase(opts.env ?? globalThis.process?.env ?? {});
}

// ---- makeSpacer：跨路径共享的全局节流器（铁律 4 的归属，daemon 进程级唯一）--
//
// makeCtx 的 breathe 只对「同一个 ctx」负责：daemon 里快照刷新、手动操作、
// token 刷新各自新建 opts/ctx（engineOpts() 每次都是新对象），彼此的节奏器
// 互不知晓 —— 只要两个入口的等待窗重叠，两次上游调用就能贴着发出去（间隔 0ms，
// 真实环境就是 403/11140 红线）。makeSpacer 记录「上一次上游调用真正发出的
// 时刻」，任何带它的调用都必须：
//   1. 排队串行：前一个调用完整结束（release）后才轮到下一个 —— 绝不允许两个
//      调用同时在途（hub 口径：成长任务绝不并行）；
//   2. 对齐：与上一次放行时刻间隔 ≥ gap（start-to-start 口径，与 e2e 的
//      「任意两次上游调用间隔 ≥1000ms」断言一致）。
// 归属与并发策略见 CONTRACT 铁律 4：由 daemon 创建唯一实例并注入所有上游路径
// （engineOpts()/runnerCtx），engine 自身不建进程级单例 —— 各测试的假时钟
// 互不污染；不带 spacer 的调用行为与旧版完全一致。
// gap 可以是数字，也可以是函数（daemon 传 () => settings.gapMs，改设置即时生效）。
export function makeSpacer(opts = {}) {
  const now = opts.now ?? clock.now;
  const sleep = opts.sleep ?? clock.sleep;
  const gapOf =
    typeof opts.gap === "function"
      ? () => Math.max(0, Number(opts.gap()) || 0)
      : () => Math.max(0, Number(opts.gap ?? DEFAULT_GAP_MS));
  let last = null; // 上次放行（调用真正发出）时刻；null = 还没打过上游
  let tail = Promise.resolve(); // FIFO 队尾：resolve 即前一个调用已完整结束
  async function slot() {
    const prev = tail;
    let release;
    tail = new Promise((r) => {
      release = r;
    });
    await prev; // 排队：等前一个调用完整结束，绝不在途并行
    if (last !== null) {
      const wait = gapOf() - (now() - last);
      if (wait > 0) await sleep(wait); // 与上一次放行时刻补足 ≥ gap
    }
    last = now();
    return release;
  }
  return {
    async run(fn) {
      const release = await slot();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    peekLast: () => last, // 只读：测试与诊断用
  };
}

// ---- makeCtx：一次流水线共享的时钟 + 节奏器 ----------------------------------
// breathe(ms) 保证「自上一次 breathe 至少过了 ms 毫秒」（假时钟上就是把时钟
// 拨过去），这是 ≥1 s 防风控间隔的实现载体：所有上游调用前都 breathe 一下。
// opts.spacer（可选）是跨路径的全局节流器：带上它，本 ctx 的每次上游调用都会
// 先经 spacer 排队对齐（见 makeSpacer）—— daemon 把同一个实例注入所有路径。
export function makeCtx(opts = {}) {
  const now = opts.now ?? clock.now;
  const sleep = opts.sleep ?? clock.sleep;
  const gap = Math.max(0, Number(opts.gap ?? DEFAULT_GAP_MS));
  let last = now() - gap; // 首个调用前不空等（与 hub 行为一致：调用后才睡）
  return {
    now,
    sleep,
    gap,
    spacer: opts.spacer ?? null,
    signal: opts.signal ?? null,
    fetch: opts.fetch ?? globalThis.fetch,
    log: typeof opts.log === "function" ? opts.log : null,
    async breathe(ms = gap) {
      const wait = Math.max(0, ms - (now() - last));
      if (wait > 0) await sleep(wait);
      last = now();
    },
  };
}

// 取 ctx：顶层流水线用 makeCtx 建一个并挂到 opts.__ctx 上层层传递；单独调用
// 的低层函数就地建一个并记在 opts 上（同一个 opts 对象此后共享同一个时钟与
// 节奏器 —— 否则跨函数的 ≥1s 间隔会失效）。
export function ctxOf(opts) {
  if (opts.__ctx === undefined) opts.__ctx = makeCtx(opts);
  return opts.__ctx;
}

function stepOf(opts, acct) {
  const ctx = ctxOf(opts);
  return (state, detail) =>
    ctx.log?.({ uid: acct?.uid ?? "", leg: opts.leg ?? "upstream", state, detail });
}

// ---- 头 ----------------------------------------------------------------------
export function headersFor(acct, kind, ids = {}, opts = {}) {
  if (kind === "billing") return identity.billingHeaders(acct, opts);
  if (kind === "web") return identity.webHeaders(acct);
  return identity.chatHeaders(acct, ids, opts);
}

// mergeInitHeaders(base, extra)：把 init.headers 的自定义头按「大小写敏感覆盖」
// 合并进 kind 决定的头族（web 点击事件等场景要改写 Referer / User-Agent /
// X-User-Id）。唯一的例外是凭据头 Authorization：无论调用方用什么大小写写它，
// 都会被剥掉、保留 base 里的 Bearer token —— 自定义头是引擎内部的构建细节，
// 绝不能成为 token 被顶替/漏发的通道。
function mergeInitHeaders(base, extra) {
  if (!extra || typeof extra !== "object") return base;
  const merged = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) continue;
    if (String(k).toLowerCase() === "authorization") continue; // 凭据头不可被覆盖
    merged[String(k)] = String(v);
  }
  return merged;
}

// replaceInitHeaders(acct, extra)：init.replaceHeaders === true 时用 init.headers
// **原样替换**整个头族（而不是合并进 kind 头族）。背景（CONTRACT §11.1）：运营
// 活动的 MP 事件上报在 hub 里用的是**最小头族** —— `_campaign_headers` =
// MP_REPORT_HEADERS + Authorization + X-User-Id（「Activity APIs use the
// mini-program identity, not the desktop profile」），与桌面端 chat 头族的差异不是
// 「多几个头」而是「不带桌面身分」；mergeInitHeaders 只能覆盖、删不掉 base 里的
// 桌面 UA/X-Domain 一族，所以要一条替换通道。红线不变：Authorization 只能由
// 引擎自己注入 —— replace 集合里无论大小写写了什么 Authorization 一律剥掉，
// 换成 acct.access 的 Bearer token（凭据头永不被外部输入顶替、也绝不漏发）。
function replaceInitHeaders(acct, extra) {
  const out = {};
  if (extra && typeof extra === "object") {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === null) continue;
      if (String(k).toLowerCase() === "authorization") continue; // 凭据头不可被顶替
      out[String(k)] = String(v);
    }
  }
  out["Authorization"] = "Bearer " + String(acct?.access ?? ""); // 凭据头由引擎注入
  return out;
}

// ---- 信封 --------------------------------------------------------------------
function parseEnvelope(text) {
  let env = {};
  try {
    env = JSON.parse(text);
  } catch {
    return { env: null };
  }
  if (!env || typeof env !== "object" || Array.isArray(env)) return { env: null };
  const code = typeof env.code === "number" ? env.code : Number.parseInt(env.code, 10) || 0;
  return { env, code };
}

function shortPath(url) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || "");
  } catch {
    return url;
  }
}

function fallbackUrl(url) {
  // chat 主机失联 → 回退 https://www.workbuddy.cn：只换 host，路径与
  // X-Domain 都不动（CONTRACT §2）。
  try {
    const u = new URL(url);
    const fb = new URL(CHAT_FALLBACK_BASE);
    u.protocol = fb.protocol;
    u.host = fb.host;
    return u.toString();
  } catch {
    return url;
  }
}

// 一次 HTTP 尝试。返回 {kind:"http", status, text} 或 {kind:"error", error}。
async function attempt(fetchImpl, url, method, headers, body, signal) {
  try {
    const res = await fetchImpl(url, { method, headers, body: body ?? undefined, signal });
    const text = await res.text();
    return { kind: "http", status: res.status, text };
  } catch (err) {
    return { kind: "error", error: err };
  }
}

// callJSON(acct, kind, url, init, opts) -> {ok, status, code, data, msg, raw, restricted?}
//
// - kind: 'chat' | 'billing' | 'web'（决定头族）
// - init: {method, body, headers?, ids?, replaceHeaders?}（body 已是字符串/undefined；
//   headers 是可选的自定义头，按大小写敏感合并进 kind 头族 —— Authorization 除外，
//   见 mergeInitHeaders；replaceHeaders===true（引擎内部专用）时 init.headers 原样
//   替换整个头族、Authorization 由引擎注入，见 replaceInitHeaders）
// - opts: {fetch, now, sleep, signal, log, leg, env, base, bases, gap, spacer, __ctx}
// - 信封：{code, msg, data}，code===0 视为成功（2xx 且 code 0）
// - 3 次线性退避重试，只重试「瞬时网络故障 / 5xx」（hub 的 _retryable 口径）
// - HTTP 403 或信封 code 11140 → restricted:true，绝不重试（runner 记冷却）
// - chat 主机网络级失败 → 最后用 https://www.workbuddy.cn 再试一次，X-Domain 不变
// - opts.spacer（可选）：本次调用（含重试全程）先经全局节流器排队对齐 ——
//   跨路径的 ≥gap 间隔与「绝不在途并行」由它保证（铁律 4）
export async function callJSON(acct, kind, url, init = {}, opts = {}) {
  const ctx = ctxOf(opts);
  if (ctx.spacer) return ctx.spacer.run(() => callJSONInto(acct, kind, url, init, opts, ctx));
  return callJSONInto(acct, kind, url, init, opts, ctx);
}

async function callJSONInto(acct, kind, url, init = {}, opts = {}, ctx = ctxOf(opts)) {
  const fetchImpl = opts.fetch ?? ctx.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? ctx.sleep;
  const method = String(init.method || "GET").toUpperCase();
  const step = stepOf(opts, acct);
  // init.replaceHeaders === true（引擎内部专用，CONTRACT §11.1）：init.headers 原样
  // 成为整个头族（Authorization 仍由引擎注入，见 replaceInitHeaders）；其余调用
  // 走「kind 头族 + 大小写敏感合并」的老路。
  const headers =
    init.replaceHeaders === true
      ? replaceInitHeaders(acct, init.headers)
      : mergeInitHeaders(headersFor(acct, kind, init.ids ?? {}, opts), init.headers);
  const body = init.body === undefined ? undefined : String(init.body);
  const signal = opts.signal ?? ctx.signal ?? undefined;

  let lastError = null;
  let lastStatus = 0;
  let lastText = "";
  // 铁律 4 的「任意两次」也包括同一逻辑调用内的重试/回退：记录上一次 HTTP 尝试
  // 真正发出的时刻，回退主机（以及任何缺退避的后续尝试）发之前补足 ≥ gap。
  // （重试退避本身是 1s/2s，已满足；唯独第三次失败 → 主机回退这一脚此前是 0ms。）
  const gapMs = Math.max(0, Number(opts.gap ?? ctx.gap ?? DEFAULT_GAP_MS));
  let lastAttemptAt = 0;
  const topUpGap = async () => {
    const wait = gapMs - (ctx.now() - lastAttemptAt);
    if (wait > 0) await sleep(wait);
  };

  for (let i = 1; i <= 3; i++) {
    if (i > 1) await topUpGap(); // 双保险：退避 sleep 之外再对齐一次（幂等）
    lastAttemptAt = ctx.now();
    const r = await attempt(fetchImpl, url, method, headers, body, signal);
    lastAttemptAt = ctx.now();

    if (r.kind === "error") {
      lastError = r.error;
      step("retry", `${method} ${shortPath(url)} 网络错误 (${String(r.error?.message || r.error)})`);
      // TLS verify 一类不该重试的错误这里无法可靠区分（Node 里没有独立类型），
      // 与 hub 一致按「网络故障」处理；重试预算用尽后走下方失败路径。
      if (i < 3) {
        await sleep(1000 * i); // 线性退避 1s, 2s（hub http_json 的 backoff*attempt）
        continue;
      }
      break;
    }

    lastStatus = r.status;
    lastText = r.text || "";

    if (r.status === 403) {
      // 账号级风控限制（hub note_restricted：立即停手，绝不换头再试）
      const { env, code } = parseEnvelope(lastText);
      step("restricted", `${method} ${shortPath(url)} HTTP 403${env?.msg ? ` ${env.msg}` : ""}`);
      return {
        ok: false, status: 403, code: code ?? 0, data: env?.data ?? null,
        msg: env?.msg || "HTTP 403", raw: lastText.slice(0, 400), restricted: true,
      };
    }

    if (r.status >= 500 || r.status === 429 || r.status === 408) {
      step("retry", `${method} ${shortPath(url)} HTTP ${r.status}`);
      if (i < 3) {
        await sleep(1000 * i);
        continue;
      }
      break;
    }

    // 2xx/4xx：不再重试，按信封结算
    const { env, code } = parseEnvelope(lastText);
    if (env) {
      if (code === 11140) {
        step("restricted", `${method} ${shortPath(url)} code 11140 ${env.msg || ""}`);
        return {
          ok: false, status: r.status, code, data: env.data ?? null,
          msg: env.msg || "request illegal", raw: lastText.slice(0, 400), restricted: true,
        };
      }
      const ok = r.status >= 200 && r.status < 300 && code === 0;
      step(ok ? "ok" : "fail", `${method} ${shortPath(url)} HTTP ${r.status} code ${code}${env.msg ? ` ${env.msg}` : ""}`);
      return {
        ok,
        status: r.status,
        code,
        data: env.data ?? null,
        msg: ok ? "" : env.msg || `code=${code}`,
        raw: lastText.slice(0, 400),
      };
    }
    // 非 JSON 主体：2xx 也没有信封可看 —— 按失败结算
    step("fail", `${method} ${shortPath(url)} HTTP ${r.status} (非 JSON 响应)`);
    return {
      ok: false,
      status: r.status,
      code: -1,
      data: null,
      msg: r.status >= 200 && r.status < 300 ? "invalid JSON response" : `HTTP ${r.status}`,
      raw: lastText.slice(0, 400),
    };
  }

  // 三次都撞网络错误：chat 主机失联（TLS reset 一类）→ 回退到
  // https://www.workbuddy.cn 再试一次；头不变（X-Domain 仍是账号 domain）。
  if (lastError && kind === "chat") {
    const alt = fallbackUrl(url);
    if (alt !== url) {
      await topUpGap(); // 铁律 4：回退尝试也是一次上游调用，与上一次尝试 ≥ gap
      lastAttemptAt = ctx.now();
      step("retry", `${method} ${shortPath(url)} 主机失联，回退 ${CHAT_FALLBACK_BASE}`);
      const r = await attempt(fetchImpl, alt, method, headers, body, signal);
      if (r.kind === "http") {
        const { env, code } = parseEnvelope(r.text || "");
        if (env) {
          if (code === 11140) {
            step("restricted", `${method} ${shortPath(alt)} code 11140`);
            return {
              ok: false, status: r.status, code, data: env.data ?? null,
              msg: env.msg || "request illegal", raw: (r.text || "").slice(0, 400), restricted: true,
            };
          }
          const ok = r.status >= 200 && r.status < 300 && code === 0;
          step(ok ? "ok" : "fail", `${method} ${shortPath(alt)} HTTP ${r.status} code ${code}`);
          return {
            ok, status: r.status, code, data: env.data ?? null,
            msg: ok ? "" : env.msg || `code=${code}`, raw: (r.text || "").slice(0, 400),
          };
        }
        step("fail", `${method} ${shortPath(alt)} HTTP ${r.status} (非 JSON 响应)`);
        return { ok: false, status: r.status, code: -1, data: null, msg: `HTTP ${r.status}`, raw: (r.text || "").slice(0, 400) };
      }
      step("fail", `${method} ${shortPath(alt)} 回退也失败 (${String(r.error?.message || r.error)})`);
    }
  }

  const detail = lastError
    ? `网络错误: ${String(lastError?.message || lastError)}`
    : `HTTP ${lastStatus}`;
  step("fail", `${method} ${shortPath(url)} ${detail}`);
  return {
    ok: false,
    status: lastStatus,
    code: -1,
    data: null,
    msg: detail,
    raw: (lastText || "").slice(0, 400),
    ...(lastError ? { error: String(lastError?.message || lastError) } : {}),
  };
}

// ---- token 刷新（wb_accounts.Account._refresh_locked + magpie merge 口径）--
// POST {chat} + engine/constants.REFRESH_PATH（字面值只在 constants.mjs）；
// 头 X-Refresh-Token / X-Auth-Refresh-Source: workbuddy / X-Domain；响应
// data.accessToken（可能嵌套 data.data），refreshToken 轮换时一并带回。
// 调用方（runner）负责原子回写 plugin-auth.json（铁律 3：单一凭据血统）。
// opts.spacer（可选）：刷新请求也是上游调用，同样先经全局节流器对齐 ——
// 否则「临期刷新」会绕开铁律 4 贴着别的路径发出。
export async function refreshAccount(acct, opts = {}) {
  if (opts.spacer) return opts.spacer.run(() => refreshAccountInto(acct, opts));
  return refreshAccountInto(acct, opts);
}

async function refreshAccountInto(acct, opts = {}) {
  const now = opts.now ?? clock.now;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const step = stepOf(opts, acct);
  if (!acct?.refresh) return { ok: false, reason: "no refresh token" };
  const url = chatBase(opts) + REFRESH_PATH;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: identity.refreshHeaders(acct),
      body: "{}",
      signal: opts.signal,
    });
    const text = await res.text();
    let env = {};
    try {
      env = JSON.parse(text);
    } catch {}
    let data = env.data ?? {};
    data = data.data ?? data; // 响应可能嵌套 data.data
    const access = data.accessToken;
    const okStatus = res.status >= 200 && res.status < 300;
    if (!okStatus || !access) {
      step("fail", `refresh HTTP ${res.status} ${env.msg || ""}`);
      return { ok: false, reason: env.msg || `HTTP ${res.status}` };
    }
    const patch = { access };
    if (data.refreshToken) patch.refresh = data.refreshToken;
    const expires =
      data.expiresAt > 0 ? data.expiresAt : data.expiresIn > 0 ? now() + data.expiresIn * 1000 : 0;
    if (expires) patch.expires = expires;
    if (data.refreshExpiresAt > 0) patch.refreshExpiresAt = data.refreshExpiresAt;
    else if (data.refreshExpiresIn > 0) patch.refreshExpiresAt = now() + data.refreshExpiresIn * 1000;
    if (data.domain) patch.domain = data.domain;
    if (data.tokenType) patch.tokenType = data.tokenType;
    step("ok", "refresh 刷新成功");
    return { ok: true, patch };
  } catch (err) {
    step("fail", `refresh 网络错误 (${String(err?.message || err)})`);
    return { ok: false, reason: String(err?.message || err) };
  }
}

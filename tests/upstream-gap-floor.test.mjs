// tests/upstream-gap-floor.test.mjs —— 上游间距红线下限（MIN_UPSTREAM_GAP_MS）回归。
//
// 红线（CONTRACT 铁律 4）：任意两次上游调用之间的间隔（start-to-start）≥1s。
// 历史缺陷：这条 1s 曾被面板旋钮突破 —— POST /api/settings 的 gapMs 下限只到
// 500，而 spacer / engineOpts / runnerCtx 直读 settings.gapMs，旋钮设 500 时
// 红线实际只剩 500ms。修法（0.3.7）：daemon 侧把所有「读 settings.gapMs 并交给
// spacer / engineOpts / runnerCtx」的读法收敛进唯一 helper upstreamGapMs()
//（= Math.max(MIN_UPSTREAM_GAP_MS, Number(settings.gapMs) || DEFAULT_GAP_MS)），
// /api/settings 的写入下限也对齐到 1000（能设的 = 实际生效的）。
//
// 本文件钉死三件事（真实 daemon + 真实引擎 + 假时钟/假上游，写法参考
// tests-e2e/boundary-throttle.test.mjs 与 tests/upstream-spacer.test.mjs）：
//   A. 核心回归：settings.gapMs = 500（旧版落盘的遗留值，直接构造 settings ——
//      修复后 /api/settings 已不可能再写入 500）时，两次上游调用的 start-start
//      实际 ≥1000ms（不是 ≥500），且不低于默认档的 1500 —— 证明兜底是「抬到
//      红线」而不是「回落默认」。
//   B. 正向：gapMs = 2000（走 POST /api/settings）→ 间隔 ≈2000ms —— 旋钮调大
//      仍然生效，防止把上限/正常路径一起写死。
//   C. 接线钉死（假引擎，逐点断言数值）：spacer 的 gap 提供者、engineOpts 的
//      gap、runnerCtx 的 get gap、runner.start 的 spec.gapMs 四个出口拿到的都
//      是抬线后的值 —— 任何一处将来改回直读 settings.gapMs 都会在这里挂。
// 全程零真实网络、零长真实等待（假时钟 sleep 只拨表 + 让出事件循环）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon } from "../daemon.mjs";
import { makeSpacer as realMakeSpacer } from "../engine/upstream.mjs";
import { makeSandbox } from "./helpers.mjs";

const KEY = "gap-floor-key-0123456789abcdef";
const UID = "u-gap0001";
const DAY = 86400000;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假时钟：sleep 先拨表再让出 ≤15ms 真实时间（HTTP 轮询/响应仍走真实事件循环；
// 假钟只在 daemon/引擎 sleep 时前进 —— 间隔断言因此完全确定）。
function gapClock(startMs) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      await realSleep(Math.min(ms, 15));
    },
    get time() {
      return t;
    },
  };
}

const FAKE_START = (() => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d.getTime();
})(); // 正午：夜猫子窗口外，无关腿不会被排程牵进来

// （每用例自带沙箱并在 finally 里 cleanup + stop；helpers.mjs 的登记簿 exit
// 钩子再兜一道泄漏，与 tests/ 其余文件同一卫生线。）

// ---- 假上游（真实引擎用的 stub）：记录每次调用的假钟时刻 ------------------------
function stubUpstream(clock) {
  const calls = [];
  const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init = {}) => {
    const path = decodeURIComponent(new URL(url).pathname);
    calls.push({ at: clock.now(), path, method: String(init.method || "GET").toUpperCase() });
    // 积分三连（fetchCredits：summary → free → paid）。summary 带 Packages 才会
    // 触发后两脚 —— 一个 GET /api/credits?refresh=1 = 恰好 3 次上游调用。
    if (path === "/billing/meter/get-user-resource-summary") {
      return respond(200, { code: 0, msg: "ok", data: { Balance: 100, Packages: [{ PackageCode: "p-test" }] } });
    }
    if (path === "/billing/meter/get-user-resource-free-packages") return respond(200, { code: 0, msg: "ok", data: { Accounts: [] } });
    if (path === "/billing/meter/get-user-resource-paid-packages") return respond(200, { code: 0, msg: "ok", data: { Accounts: [] } });
    return respond(404, { code: -1, msg: "not found" });
  };
  return { fetchImpl, calls };
}

// ---- 夹具：临时沙箱 + 凭据 +（可选）遗留 settings.json --------------------------
function makeFixture({ settings } = {}) {
  const sb = makeSandbox("wb-tasks-gap-floor-");
  const cfgDir = join(sb.dir, "config");
  const stateDir = join(cfgDir, "workbuddy-tasks", "state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(cfgDir, "plugin-auth.json"),
    JSON.stringify({
      workbuddy: {
        type: "oauth",
        access: "wb-access-GAP-0001",
        refresh: "wb-refresh-GAP-0001",
        expires: FAKE_START + 30 * DAY, // 假钟起点后 30 天才过期 → 不触发 token 刷新
        accountId: "gap-cat",
        uid: UID,
        domain: "copilot.tencent.com",
        tokenType: "Bearer",
      },
    }),
  );
  writeFileSync(join(cfgDir, "plugins.json"), JSON.stringify({ plugins: [{ spec: "github:me/magpie-workbuddy-tasks" }] }));
  if (settings !== undefined) {
    // 直接构造 settings（遗留值口径）：修复后 /api/settings 已写不进 500，
    // 所以「gapMs=500」只能以旧版落盘文件的形式存在于这个世界上。
    writeFileSync(join(stateDir, "settings.json"), JSON.stringify(settings));
  }
  return { sb, cfgDir, stateDir };
}

async function bootRealEngine({ settings } = {}) {
  const { sb, cfgDir, stateDir } = makeFixture({ settings });
  const clock = gapClock(FAKE_START);
  const up = stubUpstream(clock);
  const logs = [];
  let h = null;
  h = await startDaemon({
    args: { cfg: cfgDir, state: stateDir, port: "0", key: KEY },
    now: clock.now,
    sleep: clock.sleep,
    fetch: up.fetchImpl,
    log: (...a) => logs.push(a.join(" ")),
    noTimers: true,
    skipExistingCheck: true,
  });
  const api = {
    base: () => `http://127.0.0.1:${h.port}`,
    get: (path) => fetch(api.base() + path, { headers: { authorization: `Bearer ${KEY}` } }),
    post: (path, body) =>
      fetch(api.base() + path, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    json: async (p) => {
      const res = await p;
      return { status: res.status, data: await res.json().catch(() => null) };
    },
  };
  const stop = async () => {
    await h?.stop?.();
    sb.cleanup();
  };
  return { h, clock, up, api, stop, logs, cfgDir, stateDir };
}

// 两次「强制拉积分」= 两条独立 HTTP 路径各 3 次上游调用（summary→free→paid），
// 每一脚之前的间隔全部来自 ctx.breathe（engineOpts 的 gap）与全局 spacer
//（gap 提供者）—— 正是被测的三个接线出口。
async function twoCreditsFetches(api) {
  const r1 = await api.json(api.get(`/api/credits?uid=${UID}&refresh=1`));
  const r2 = await api.json(api.get(`/api/credits?uid=${UID}&refresh=1`));
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
}

// 断言窗口内任意相邻两次上游调用 start-start ∈ [floor, ceil)。
// ceil 不是摆设：它证明间隔是「抬到下限」而不是「回落到某个更大的默认档」
// —— 若接线被改回直读默认值（1500），floor 断言会过、ceil 断言必挂。
function assertGapBand(up, { from = 0, floor, ceil, what }) {
  const c = up.calls.slice(from);
  assert.ok(c.length >= 2, `${what}：应有 ≥2 次上游调用，实际 ${c.length}`);
  const deltas = [];
  for (let i = 1; i < c.length; i++) {
    const d = c[i].at - c[i - 1].at;
    deltas.push(d);
    assert.ok(
      d >= floor,
      `${what}：第 ${i - 1}→${i} 次调用 start 间隔 ${d}ms < ${floor}ms（红线被突破）` +
        `：${c[i - 1].method} ${c[i - 1].path} → ${c[i].method} ${c[i].path}`,
    );
    assert.ok(
      d < ceil,
      `${what}：第 ${i - 1}→${i} 次调用间隔 ${d}ms ≥ ${ceil}ms —— 这是「回落默认档」而不是「抬到下限」，接线疑似被改回直读`,
    );
  }
  return deltas;
}

// ---- A. 核心回归：遗留 gapMs=500 → 实际间隔 ≥1000（不是 ≥500） ------------------

test("红线兜底：settings.gapMs=500（旧版落盘遗留值）时，任意两次上游调用 start-start ≥1000ms", async () => {
  const env = await bootRealEngine({ settings: { gapMs: 500, scheduler: false } });
  try {
    const hello = await (await env.api.get("/api/hello")).json();
    assert.equal(hello.ready, true);

    const from = env.up.calls.length;
    await twoCreditsFetches(env.api);

    // 两次请求 × 每次积分三连（summary/free/paid）= 6 次上游调用；少了说明
    // 场景没真正跑起来（断言会变 vacuous），必须钉住。
    assert.ok(
      env.up.calls.length - from >= 6,
      `应触发 ≥6 次上游调用（2 次 refresh × 积分三连），实际 ${env.up.calls.length - from}`,
    );
    // 核心断言：全部相邻间隔 ≥1000 且 <1500 —— ≥1000 是红线本身；<1500 证明
    // 兜底是「500 抬到 1000」而非「无效值回落默认 1500」（修复前这里是 500）。
    const deltas = assertGapBand(env.up, { from, floor: 1000, ceil: 1500, what: "gapMs=500 兜底" });
    assert.equal(Math.min(...deltas), 1000, `最小间隔应恰为抬线值 1000ms，实际 ${Math.min(...deltas)}`);
  } finally {
    await env.stop();
  }
});

// ---- B. 正向：旋钮调大仍生效（gapMs=2000 → 间隔 ≈2000） -------------------------

test("正向：POST /api/settings gapMs=2000 后，任意两次上游调用 start-start ≈2000ms（旋钮调大仍生效）", async () => {
  const env = await bootRealEngine({ settings: { scheduler: false } }); // 不预写 gapMs → 默认 1500
  try {
    const hello = await (await env.api.get("/api/hello")).json();
    assert.equal(hello.ready, true);

    // 走 /api/settings 把旋钮调到 2000：写入路径必须原样接受（≥下限、≤上限）
    const set = await env.api.json(env.api.post("/api/settings", { gapMs: 2000 }));
    assert.equal(set.status, 200);
    assert.equal(set.data.gapMs, 2000, "调大必须原样生效（不许被下限/默认吃掉）");

    const from = env.up.calls.length;
    await twoCreditsFetches(env.api);
    assert.ok(env.up.calls.length - from >= 6, `应触发 ≥6 次上游调用，实际 ${env.up.calls.length - from}`);
    // 2000 级别：≥2000（不是被钉在 1000）且 <2600（不是被钉死/膨胀）
    assertGapBand(env.up, { from, floor: 2000, ceil: 2600, what: "gapMs=2000 正向" });
  } finally {
    await env.stop();
  }
});

// ---- C. 接线钉死（假引擎）：四个出口拿到的都是抬线后的值 ------------------------

test("接线钉死：settings.gapMs=500 时，spacer gap 提供者 / engineOpts.gap / runnerCtx.get gap / runner spec.gapMs 全部 = 1000", async () => {
  const { sb, cfgDir, stateDir } = makeFixture({ settings: { gapMs: 500, scheduler: false } });
  const clock = gapClock(FAKE_START);
  const seen = {
    engineOptsGaps: [], // engineOpts() 交给 engine.credits.fetchCredits 的 opts.gap（daemon.mjs engineOpts）
    spacerCalls: [], // 经 daemon 全局 spacer 排队的上游放行时刻（gap 提供者出口）
    runnerCtxGaps: [], // 假 runner 在 start() 里读到的 ctx.gap（runnerCtx 出口）
    specGapMs: [], // runner.start(spec) 收到的 spec.gapMs（startRun 出口）
  };
  // 假引擎：upstream.makeSpacer 复用真实现（daemon 只负责传 gap 提供者，被测的
  // 正是「daemon 传了什么」）；credits.fetchCredits 记录 opts.gap 并经 spacer
  // 放行一次「上游调用」；runner 是记录 ctx.gap 的最小 JobRunner。
  const engine = {
    store: {
      readMagpieConfigDir: () => null,
      loadAccounts: () => [
        {
          key: "workbuddy",
          provider: "workbuddy",
          uid: UID,
          nickname: "阿猫",
          access: "wb-access-x",
          refresh: "wb-refresh-x",
          expires: FAKE_START + 30 * DAY,
          domain: "workbuddy.cn",
          isApiKey: false,
          enterpriseId: "",
        },
      ],
      eligibleAccounts: (accounts) =>
        accounts.filter((a) => a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false),
    },
    runner: {
      JobRunner: class JobRunner {
        constructor(ctx) {
          this.ctx = ctx;
        }
        start(spec) {
          // 与 engine/runner.mjs 同款读法（腿间 sleep 与 daily 上报都读 opts.gap）
          seen.runnerCtxGaps.push(this.ctx.gap);
          seen.specGapMs.push(spec.gapMs);
          return {
            id: "job-gap-floor",
            state: "done",
            startedAt: new Date(clock.time).toISOString(),
            endedAt: new Date(clock.time).toISOString(),
            trigger: spec.trigger ?? "manual",
            legs: spec.legs ?? [],
            totals: { credit: 0, energy: 0, tasksLit: 0, tasksClaimed: 0 },
            steps: [],
            log: [],
          };
        }
        get() {
          return null;
        }
        current() {
          return null;
        }
      },
    },
    upstream: {
      makeSpacer: (o) => realMakeSpacer(o),
    },
    credits: {
      fetchCredits: async (_acct, opts) => {
        seen.engineOptsGaps.push(opts.gap);
        await opts.spacer.run(async () => {
          seen.spacerCalls.push(opts.now());
        });
        return { ok: true, credits: { balance: 42 } };
      },
    },
    errors: [],
    ok: true,
  };
  const logs = [];
  let h = null;
  try {
    h = await startDaemon({
      args: { cfg: cfgDir, state: stateDir, port: "0", key: KEY },
      engine,
      now: clock.now,
      sleep: clock.sleep,
      log: (...a) => logs.push(a.join(" ")),
      noTimers: true,
      skipExistingCheck: true,
    });
    const base = `http://127.0.0.1:${h.port}`;
    const get = (path) => fetch(base + path, { headers: { authorization: `Bearer ${KEY}` } });
    const post = (path, body) =>
      fetch(base + path, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // 出口 1+2：engineOpts 的 gap 与 spacer 放行间隔（两次强制拉积分 = 两次经
    // spacer 排队的「上游调用」）。settings.gapMs=500 → 两个出口都必须是 1000。
    const c1 = await get(`/api/credits?uid=${UID}&refresh=1`);
    const c2 = await get(`/api/credits?uid=${UID}&refresh=1`);
    assert.equal(c1.status, 200);
    assert.equal(c2.status, 200);
    assert.ok(seen.engineOptsGaps.length >= 2, "engineOpts gap 出口应被读到 ≥2 次");
    for (const g of seen.engineOptsGaps) {
      assert.equal(g, 1000, `engineOpts() 交给引擎的 opts.gap 必须抬线到 1000（直读 settings.gapMs 会是 500），实际 ${g}`);
    }
    assert.equal(seen.spacerCalls.length, 2, "两次拉积分应恰好经 spacer 放行两次");
    const d = seen.spacerCalls[1] - seen.spacerCalls[0];
    assert.equal(d, 1000, `spacer 的 gap 提供者必须抬线到 1000（两次放行 start-start 间隔），实际 ${d}ms`);

    // 出口 3+4：runnerCtx 的 get gap 与 runner.start 的 spec.gapMs
    const runRes = await post("/api/run", { uids: [UID] });
    assert.equal(runRes.status, 200);
    const run = await runRes.json();
    assert.equal(run.job?.id, "job-gap-floor");
    assert.equal(seen.runnerCtxGaps.length, 1, "假 runner 应在 start() 里读一次 ctx.gap");
    assert.equal(
      seen.runnerCtxGaps[0],
      1000,
      `runnerCtx 的 get gap 必须抬线到 1000（直读 settings.gapMs 会是 500），实际 ${seen.runnerCtxGaps[0]}`,
    );
    assert.equal(seen.specGapMs[0], 1000, `runner.start 的 spec.gapMs 必须是抬线值 1000，实际 ${seen.specGapMs[0]}`);
  } finally {
    await h?.stop?.();
    sb.cleanup();
  }
});

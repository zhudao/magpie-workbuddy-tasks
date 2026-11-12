// tests-e2e/full-loop.test.mjs —— 真实集成回路的端到端验证（node --test）。
//
// 不 mock 引擎的任何一层：真实 daemon.mjs（startDaemon 工厂 + 全部定时器）
// + 真实 engine/*（store/runner/tasks/travel/upstream），凭据来自按真实
// OpenCode/magpie 格式拼出来的 plugin-auth.json，唯一被替换的是网络本身
// （fetch 级假上游，daemon 的 opts.fetch 注入缝，契约 §2/§8）与时钟
// （假时钟：sleep 推进假钟并让出事件循环，使 HTTP 请求能与 job 交错）。
//
// 覆盖：
//   1. /api/accounts + /api/state：3 个 workbuddy* 条目，恰好 2 个可参与 OAuth
//   2. /api/run → job：批量接取 → 逐任务点亮 → 领奖（顺序按假上游调用日志断言）
//   3. 过期账号 refresh + 原子回写 plugin-auth.json（轮换 token、未知字段与
//      其它 provider 条目原样保留 —— 读文件 diff）
//   4. 运行中第二个 /api/run 409；/api/stop 在步骤边界中止
//   5. /api/state、/api/jobs、/api/history、SSE 零凭据泄漏（无 token 原文、无 Bearer）
//   6. /api/history 记录该轮；job 结束后自动快照
//   7. 风控红线端到端：整个测试期间任意两次上游调用间隔 ≥1000ms（假时钟戳）
//   8. 夜猫子（black_cat）在 23:00-08:00 窗口内经 /api/run 真实计数
//   9. 手动 claim（已领→400→web 回退链）、accept、API-key 账号被排除、checkin
//  10. 生命周期（§4）：真实子进程 daemon —— 拒绝双开；plugins.json off:true 自杀；
//      ensureDaemon 在 desired=off 时不拉起、重新启用后由宿主路径拉起并就绪
//  11. 任务快照回归（缺陷 1）：snake_case 上游 → /api/state 的 snapshot.tasks 是
//      规范 camelCase 且 code/rewardCredit/jumpUrl 非空
//  12. 参与任务开关（缺陷 2）：POST /api/account/toggle 停用的账号被排除出 job

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../daemon.mjs";
import {
  ensureDaemon,
  pidAlive,
  probeDaemon,
  readControl,
  readDaemonInfo,
  shutdownDaemon,
  writeControl,
} from "../lifecycle.mjs";
import { makeUpstreamStub } from "./upstream-stub.mjs";
import { makeSandbox } from "../tests/helpers.mjs";

const PLUGIN_ROOT = fileURLToPath(new URL("../", import.meta.url));

const DAEMON_KEY = "e2e-daemon-key-0123456789abcdef";
const DAY = 86400000;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 假时钟：sleep 推进假钟 + 真实让出事件循环（job 与 HTTP 请求可交错） --------
function e2eClock(startMs) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      await realSleep(Math.min(ms, 4));
    },
    set: (ms) => {
      t = ms;
    },
    get time() {
      return t;
    },
  };
}

// ---- 场景数据 ------------------------------------------------------------------

const todayAt = (h, m = 0) => {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
};

const FAKE_START = todayAt(12, 0); // 正午：夜猫子白天诚实跳过；夜测再拨到 23:30

const UID_OK = "u-hh1122"; // 健康 OAuth
const UID_EXP = "u-oo3344"; // 过期 OAuth（走 refresh + 回写）
const KEY_EXP = "workbuddy#a1b2c3d4";

// token 有效期相对「假时钟起点」取值：引擎的刷新判定走注入时钟，与真实
// 墙钟无关（这样测试在一天任何时刻跑都成立）。
const authOriginal = {
  "workbuddy-tasks": { type: "api", key: "shared" }, // 我们自己的 provider 占位 → 不是账号
  "another-provider-inc": { type: "api", key: "sk-other-provider-KEEPME" },
  workbuddy: {
    type: "oauth",
    access: "wb-access-HEALTHY-0001",
    refresh: "wb-refresh-HEALTHY-0001",
    expires: FAKE_START + 30 * DAY,
    refreshExpiresAt: FAKE_START + 60 * DAY,
    accountId: "healthy-cat",
    uid: UID_OK,
    domain: "copilot.tencent.com",
    tokenType: "Bearer",
    customUnknownField: { keep: "me" },
  },
  [KEY_EXP]: {
    type: "oauth",
    access: "wb-access-EXPIRED-0002",
    refresh: "wb-refresh-EXPIRED-0002",
    expires: FAKE_START - 3600_000, // 已过期 → 必须走 refresh + 回写
    accountId: "expired-owl",
    uid: UID_EXP,
    unknownFieldNumber: 42,
    unknownFieldText: "preserve-me",
  },
  "workbuddy#yyy777": { type: "api", key: "ck_6688.supersecretkeyvalue" }, // API key → 排除
};

const seedTasks = {
  [UID_OK]: [
    { task_code: "first_buddy", title: "领取一只 Buddy", accept_status: "not_accepted", task_type: "auto", current: 0, target: 1, reward_credit: 300 },
    { task_code: "skill_1", title: "体验技能", accept_status: "not_accepted", task_type: "single", current: 0, target: 1, reward_credit: 100 },
    { task_code: "expert_5", title: "使用专家助手", accept_status: "not_accepted", task_type: "single", current: 0, target: 5, reward_credit: 200 },
    { task_code: "chat_5", title: "发起 5 次对话", accept_status: "accepted", task_type: "single", current: 3, target: 5, reward_credit: 100 },
    { task_code: "Expert_lighthouse", title: "轻量云专家使用", accept_status: "not_accepted", task_type: "single", current: 0, target: 1, reward_credit: 100 },
    { task_code: "RichMeow_Chat", title: "桌面对话事件链", accept_status: "not_accepted", task_type: "single", current: 0, target: 1, reward_credit: 100, jump_url: "workbuddy://chat" },
    { task_code: "black_cat", title: "夜猫子任务 (23:00-08:00)", accept_status: "not_accepted", task_type: "single", current: 0, target: 3, reward_credit: 100 },
    { task_code: "wb_wechat_oa_subscribe_task", title: "关注官方公众号", accept_status: "not_accepted", task_type: "single", current: 0, target: 1, reward_credit: 100 },
  ],
  [UID_EXP]: [
    { task_code: "first_buddy", title: "领取一只 Buddy", accept_status: "claimed", task_type: "auto", current: 1, target: 1, reward_credit: 300 },
    { task_code: "chat_5", title: "发起 5 次对话", accept_status: "completed", task_type: "single", current: 5, target: 5, reward_credit: 100 },
  ],
};
const seedTravel = { [UID_OK]: { state: "arrived" }, [UID_EXP]: { state: "traveling" } };

const SECRET_STRINGS = [
  "wb-access-HEALTHY-0001",
  "wb-refresh-HEALTHY-0001",
  "wb-access-EXPIRED-0002",
  "wb-refresh-EXPIRED-0002",
  "wb-access-ROTATED-",
  "wb-refresh-ROTATED-",
  "supersecretkeyvalue",
  "sk-other-provider-KEEPME",
];

// ---- 全局夹具 ------------------------------------------------------------------

// 全文件共用一个 temp 沙箱：e2e 全回路是一条连续故事（同一 daemon、同一
// plugin-auth.json、同一 state 被跨用例断言），共享目录在这里是有意设计；
// 与 tests/、tests-shell/ 的「每用例独立沙箱」并发隔离不冲突 —— 那些文件的
// 用例之间零共享状态。登记进 helpers 卫生线（after 兜底 + exit 钩子都回收它）。
const rootSb = makeSandbox("wb-tasks-e2e-");
const root = rootSb.dir;
const cfgDir = join(root, "config");
const stateDir = join(cfgDir, "workbuddy-tasks", "state"); // 生产布局 stateDirFor(cfgDir)
mkdirSync(stateDir, { recursive: true });
const authPath = join(cfgDir, "plugin-auth.json");
writeFileSync(authPath, JSON.stringify(authOriginal, null, 2) + "\n");
writeFileSync(join(cfgDir, "plugins.json"), JSON.stringify({
  plugins: [{ spec: "github:foo/bar" }, { spec: "github:me/magpie-workbuddy-tasks" }],
}));
writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ scheduler: false })); // 排程关掉，测试手动触发

// 假 magpie 网关（§4：daemon 每 15s TCP 探测，连续探测不到会自杀）
const gateway = net.createServer(() => {});
await new Promise((ok) => gateway.listen(0, "127.0.0.1", ok));
process.env.MAGPIE_ADDR = `127.0.0.1:${gateway.address().port}`;

const clock = e2eClock(FAKE_START); // 正午起步

// 可选闸门：把某个 job 停在第一拍 1500ms 节奏上（stop 测试用，消除真实时序竞态）
let stopGate = null;
const gatedSleep = async (ms) => {
  if (stopGate && ms === 1500) {
    const g = stopGate;
    stopGate = null;
    g.tripped = true;
    await g.promise;
  }
  await clock.sleep(ms);
};

const stub = makeUpstreamStub(clock, {
  tasks: seedTasks,
  travel: seedTravel,
  forceChat400Once: [`${UID_OK}|Expert_lighthouse`], // chat 域首领 400 → 引擎走 web 回退
});

const daemonLogs = [];
let h = null; // startDaemon 句柄
let job1Id = null;
let refreshRecord = null;

const api = {
  base: () => `http://127.0.0.1:${h.port}`,
  get: (path) => fetch(api.base() + path, { headers: { authorization: `Bearer ${DAEMON_KEY}` } }),
  post: (path, body) =>
    fetch(api.base() + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${DAEMON_KEY}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  json: async (p) => {
    const res = await p;
    return { status: res.status, data: await res.json().catch(() => null) };
  },
};

// SSE 收集 + watchJobTick 泵（真实定时器是 1s 一跳，泵把步进事件及时广播出来）
const sseEvents = [];
let sseCtrl = null;
function startSse() {
  sseCtrl = new AbortController();
  fetch(`http://127.0.0.1:${h.port}/api/events`, {
    headers: { authorization: `Bearer ${DAEMON_KEY}` },
    signal: sseCtrl.signal,
  })
    .then(async (res) => {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = /^data: (.*)$/m.exec(frame);
          if (m) {
            try {
              sseEvents.push(JSON.parse(m[1]));
            } catch {}
          }
        }
      }
    })
    .catch(() => {});
}
const pump = setInterval(() => {
  try {
    h?.ticks.watchJob();
  } catch {}
}, 15);

async function waitJobDone(jobId, timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    const r = await api.json(api.get(`/api/jobs/${jobId}`));
    assert.equal(r.status, 200, `job ${jobId} 查询失败`);
    if (r.data.state === "done" || r.data.state === "error") return r.data;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`job ${jobId} 未在时限内结束：${JSON.stringify(r.data).slice(0, 400)}`);
    }
    await realSleep(25);
  }
}

async function waitFor(pred, timeoutMs = 15000, what = "条件") {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待 ${what} 超时`);
    await realSleep(50);
  }
}

after(async () => {
  clearInterval(pump);
  try {
    sseCtrl?.abort();
  } catch {}
  try {
    await h?.stop();
  } catch {}
  try {
    gateway.closeAllConnections?.();
    gateway.close();
  } catch {}
  try {
    rootSb.cleanup();
  } catch {}
});

// ==============================================================================
// 1. 启动真实 daemon（真实引擎 + 全部定时器），HTTP 门禁与就绪
// ==============================================================================

test("e2e 启动：真实 daemon + 真实引擎，/api/hello ready，全路由免密钥", async () => {
  h = await startDaemon({
    args: { cfg: cfgDir, state: stateDir, port: "0", key: DAEMON_KEY },
    now: clock.now,
    sleep: gatedSleep,
    fetch: stub.fetchImpl, // 唯一的网络替换点（daemon opts.fetch 注入缝）
    log: (...a) => daemonLogs.push(a.join(" ")),
  });
  assert.ok(h.port > 0);

  const hello = await (await fetch(api.base() + "/api/hello")).json();
  assert.equal(hello.name, "workbuddy-tasks");
  assert.equal(hello.ready, true, "真实引擎应完整装载");

  // 免密钥口径（契约 §3）：全部路由一律不需要密钥。只读免 key；写操作无 key
  // 也放行（用点名不存在账号的 /api/run 探一个「有业务理由的非 401」——
  // WB_NO_ACCOUNTS → 400，绝不 401；不真启动 job，避免扰动后续用例）
  assert.equal((await fetch(api.base() + "/api/state")).status, 200);
  const noKeyRun = await fetch(api.base() + "/api/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uids: ["__no_such_uid__"] }),
  });
  assert.equal(noKeyRun.status, 400);
  assert.match((await noKeyRun.json()).error, /没有可参与任务的账号/);
  // 带旧密钥（header 或 ?k=）的调用继续可用：平滑过渡，不报 400/401
  assert.equal((await api.json(api.get("/api/state"))).status, 200);
  assert.equal((await fetch(api.base() + `/api/state?k=${encodeURIComponent(DAEMON_KEY)}`)).status, 200);

  startSse();
});

// ==============================================================================
// 2. 账号发现：恰好 2 个可参与 OAuth；API key 与其它 provider 不参与
// ==============================================================================

test("/api/accounts 扫描 + /api/state：恰好 2 个可参与 OAuth 账号，API key 被标记排除", async () => {
  const acc = await api.json(api.post("/api/accounts"));
  assert.equal(acc.status, 200);
  // count = workbuddy* 全部条目（2 个 OAuth + 1 个 API key；其它 provider / 我们自己的占位不算）
  assert.equal(acc.data.count, 3);
  assert.equal(acc.data.eligible, 2, "恰好 2 个可参与 OAuth 账号");
  assert.deepEqual(acc.data.added, []);
  assert.deepEqual(acc.data.removed, []);

  const st = (await api.json(api.get("/api/state"))).data;
  assert.equal(st.accounts.length, 3);
  assert.deepEqual(
    st.accounts
      .filter((a) => a.eligible)
      .map((a) => a.uid)
      .sort(),
    [UID_OK, UID_EXP],
  );
  const keyRow = st.accounts.find((a) => a.uid === "apikey-6688");
  assert.ok(keyRow, "API key 条目要可见但不参与");
  assert.equal(keyRow.eligible, false);
  assert.equal(keyRow.masked, "API key（不参与任务）");
  const expRow = st.accounts.find((a) => a.uid === UID_EXP);
  assert.equal(expRow.expiresInDays, 0, "过期账号剩余 0 天");
  const okRow = st.accounts.find((a) => a.uid === UID_OK);
  assert.equal(okRow.expiresInDays, Math.max(0, Math.ceil((authOriginal.workbuddy.expires - clock.time) / DAY)));

  // settings API 可用（排程保持关闭）
  const set = await api.json(api.post("/api/settings", { scheduler: false }));
  assert.equal(set.status, 200);
  assert.equal(set.data.scheduler, false);
});

// ==============================================================================
// 3. 主回路：/api/run → 批量接取 → 点亮 → 领奖 → 旅行；409；凭据回写；无泄漏
// ==============================================================================

test("主回路：/api/run 启动 job；运行中第二个 /api/run 得 409 {error:busy}", async () => {
  const r1 = await api.json(api.post("/api/run", { legs: ["growth", "travel", "night"] }));
  assert.equal(r1.status, 200);
  assert.ok(r1.data.job.id);
  assert.equal(r1.data.job.state, "running");
  job1Id = r1.data.job.id;

  // job 在跑：全局闸门（409）+ 单账号操作同样被挡
  const r2 = await api.json(api.post("/api/run", {}));
  assert.equal(r2.status, 409);
  assert.deepEqual(r2.data, { error: "busy" });
  const busyClaim = await api.json(api.post("/api/task/claim", { uid: UID_OK, code: "skill_1" }));
  assert.equal(busyClaim.status, 409);
});

test("主回路：job 完成，步骤/结算/日志/上游调用顺序全部对齐契约 §7", async () => {
  const job = await waitJobDone(job1Id);
  assert.equal(job.state, "done");
  assert.equal(job.error, null);
  // 顶层 trigger = 归一后的 spec.trigger（真实引擎口径；手动 /api/run → manual）
  assert.equal(job.trigger, "manual", "/api/jobs 的 job 顶层 trigger");
  assert.equal(job.spec.trigger, "manual");

  // 步骤：2 账号 × 3 腿，顺序固定 growth→travel→night；全部 ok
  assert.deepEqual(
    job.steps.map((s) => `${s.uid}:${s.leg}`),
    [`${UID_OK}:growth`, `${UID_OK}:travel`, `${UID_OK}:night`, `${UID_EXP}:growth`, `${UID_EXP}:travel`, `${UID_EXP}:night`],
  );
  for (const s of job.steps) assert.equal(s.state, "ok", `${s.uid}/${s.leg}: ${s.detail}`);

  // 结算：u-hh 成长 300+100+200+100+100+旅行20=820；u-oo 成长 100；共 920。
  // tasksLit 5→4：每日活跃（CONTRACT §7，每个账号 job 开始前的固定动作）先发
  // 一条 chat 事件把 u-hh 的 first_buddy 提前点亮成 completed，growth 腿直接
  // 领奖（claimed 数不变、lit 少 1）。
  assert.equal(job.totals.credit, 920);
  assert.equal(job.totals.tasksLit, 4);
  assert.equal(job.totals.tasksClaimed, 6);

  // 每日活跃：两账号各一条 chat 事件、打计费域、含 userId、先于成长腿任何调用。
  // 计费域是唯一可靠的判别口径（腿内的 chat_5 点亮事件同为 chat_request_send，
  // 但走 chat 域 copilot.tencent.com）。
  const dailyCalls = stub.calls.filter((x) => x.host === "www.codebuddy.cn" && x.path === "/v2/report");
  assert.equal(dailyCalls.length, 2, "两账号各一条每日活跃（计费域 /v2/report）");
  const dailyReps = dailyCalls.map((x) => x.body?.[0]).filter(Boolean);
  assert.equal(dailyReps.length, 2);
  for (const ev of dailyReps) {
    assert.equal(ev.eventCode, "chat_request_send", "每日活跃 = 一条 chat 事件");
    assert.ok(ev.userId, "每日活跃事件含 userId");
  }
  assert.ok(
    stub.calls.findIndex((x) => x.host === "www.codebuddy.cn" && x.path === "/v2/report") <
      stub.calls.findIndex((x) => x.path === "/v2/activity/growth/tasks"),
    "每日活跃先于成长腿的任何调用",
  );
  assert.ok(job.log.some((l) => l.includes("每日活跃：已上报")), "每日活跃日志");

  // 人读日志：批量接取、已接取 5 个、过期账号回写
  const logText = job.log.join("\n");
  assert.ok(logText.includes("正在批量接取"));
  assert.ok(logText.includes("已接取 5 个任务"));
  assert.ok(logText.includes("回写 plugin-auth.json"), "过期账号应刷新并回写");
  assert.ok(logText.includes("23:00-08:00"), "夜猫子白天诚实跳过");

  // ---- 上游调用顺序（假上游按到达顺序记录） ----
  const c = stub.calls;
  const idx = (pred) => c.findIndex(pred);
  const firstReport = idx((x) => x.path === "/v2/report");
  const firstAccept = idx((x) => x.path === "/v2/activity/growth/tasks/accept");
  const firstClaim = idx((x) => x.path.endsWith("/claim"));
  assert.ok(firstReport >= 0 && firstAccept > 0 && firstClaim >= 0);
  // 全链路第一条 /v2/report 是每日活跃（计费域 chat 事件）；它先点亮了
  // first_buddy，growth 腿的领奖仍先于批量接取（first_buddy 是前置）
  assert.equal(c[firstReport].host, "www.codebuddy.cn", "第一条上报即每日活跃（计费域）");
  assert.ok(firstReport < firstAccept, "每日活跃/auto 点亮先于批量接取");
  assert.ok(firstClaim < firstAccept, "first_buddy 领奖先于批量接取（它是前置）");
  assert.equal(c[firstClaim].path, "/activity/growth/tasks/first_buddy/claim");

  // 批量接取批次内容：不含 auto（first_buddy）、不含 unforgeable（wb_wechat）、不含已接取
  const acceptBody = c[firstAccept].body;
  assert.deepEqual(acceptBody.task_codes, [
    "skill_1",
    "expert_5",
    "Expert_lighthouse",
    "RichMeow_Chat",
    "black_cat",
  ]);

  // 专家事件：5 次上报、5 个互不相同 id、全部带 userId（去重红线）
  const exReps = stub.reports.filter(
    (r) => r.uid === UID_OK && r.ev.eventCode === "expert_actual_use" && r.ev.id !== "ex_2cvvUZQhDyeJ",
  );
  assert.equal(exReps.length, 5);
  assert.equal(new Set(exReps.map((r) => r.ev.id)).size, 5, "(eventCode,id) 去重 → id 必须轮换");
  for (const r of stub.reports) assert.ok(r.ev.userId, "事件缺 userId 会被服务端静默丢弃");

  // DESKTOP_ONLY：接上了但绝不伪造事件；正午不上报夜猫事件
  const richmeow = stub.tasks.get(UID_OK).find((t) => t.task_code === "RichMeow_Chat");
  assert.equal(richmeow.accept_status, "accepted");
  assert.ok(!stub.reports.some((r) => r.uid === UID_OK && r.ev.mode === "night"));

  // 400 → web 回退：chat 域首领 400，web 域（www.workbuddy.cn + webHeaders）成功
  const webCall = c.find((x) => x.host === "www.workbuddy.cn" && x.path.includes("/Expert_lighthouse/claim"));
  assert.ok(webCall, "Expert_lighthouse 应经 web 域回退领奖");
  assert.equal(webCall.headers["x-client-platform"], "web");
  assert.ok(
    stub.chatClaimRejects.some((x) => x.uid === UID_OK && x.code === "Expert_lighthouse"),
    "chat 域对该任务先 400",
  );

  // 猫猫旅行（需求 1 新口径：旅行只由 travel 腿触发，growth 腿不再顺手跑）：
  // travel 腿查一次状态（arrived）→ 领奖归位（idle）；一条腿只查一次状态，
  // 本轮不再派出 —— 下轮 travel 腿才会 depart（growth+travel 不重复跑）。
  const travelStatuses = c.filter((x) => x.path === "/activity/growth/buddy/travel/status" && x.uid === UID_OK);
  assert.equal(travelStatuses.length, 1, "travel/status 恰好一次（growth 收尾不再跑旅行）");
  assert.ok(c.some((x) => x.path === "/activity/growth/buddy/travel/claim" && x.uid === UID_OK), "travel 腿领奖（旅行归来）");
  assert.ok(
    !c.some((x) => x.path === "/activity/growth/buddy/travel/depart" && x.uid === UID_OK),
    "arrived 领奖后本轮不再派出（下轮 travel 腿才 depart）",
  );
  assert.equal(stub.travel.get(UID_OK).state, "idle");

  // 上游请求身分：全部是两个 OAuth 账号的 Bearer，API key 从不出现在线上
  for (const call of c) {
    const auth = String(call.headers.authorization ?? "");
    if (auth) assert.match(auth, /^Bearer wb-access-/);
    assert.ok(!auth.includes("supersecretkeyvalue"));
  }
  assert.ok(!c.some((x) => x.uid === "apikey-6688"), "API key 账号绝不参与任务");

  // 刷新请求本身：X-Refresh-Token / X-Auth-Refresh-Source 逐字对齐 §7
  refreshRecord = stub.refreshes.find((x) => x.uid === UID_EXP);
  assert.ok(refreshRecord, "过期账号应发出刷新请求");
  assert.equal(refreshRecord.sentRefresh, "wb-refresh-EXPIRED-0002");
  assert.equal(refreshRecord.source, "workbuddy");
  assert.ok(!stub.refreshes.some((x) => x.uid === UID_OK), "健康账号不刷新");
});

test("铁律 3：过期账号的新 token 原子回写 plugin-auth.json（diff 读回断言）", () => {
  assert.ok(refreshRecord, "前置：刷新已发生");
  const after = JSON.parse(readFileSync(authPath, "utf8"));

  const exp = after[KEY_EXP];
  assert.equal(exp.access, refreshRecord.issued.accessToken, "access 换成轮换结果");
  assert.equal(exp.refresh, refreshRecord.issued.refreshToken, "refresh 轮换后回写（不互踢社区插件）");
  assert.equal(exp.expires, refreshRecord.issued.expiresAt);
  assert.equal(exp.refreshExpiresAt, refreshRecord.issued.refreshExpiresAt);
  // 未知字段与账号自身字段保留
  assert.equal(exp.type, "oauth");
  assert.equal(exp.accountId, "expired-owl");
  assert.equal(exp.unknownFieldNumber, 42);
  assert.equal(exp.unknownFieldText, "preserve-me");

  // 兄弟条目一个字节都不动
  assert.deepEqual(after.workbuddy, authOriginal.workbuddy, "健康账号条目不变");
  assert.equal(after.workbuddy.access, "wb-access-HEALTHY-0001");
  assert.deepEqual(after["workbuddy#yyy777"], authOriginal["workbuddy#yyy777"]);
  assert.deepEqual(after["another-provider-inc"], authOriginal["another-provider-inc"]);
  assert.deepEqual(after["workbuddy-tasks"], authOriginal["workbuddy-tasks"]);
  assert.deepEqual(Object.keys(after), Object.keys(authOriginal), "顶层键序不变");
});

test("铁律 2：/api/state、/api/jobs、/api/history、守护日志零凭据泄漏", async () => {
  const paths = ["/api/state", `/api/jobs/${job1Id}`, "/api/history?limit=200"];
  for (const p of paths) {
    const text = await (await api.get(p)).text();
    for (const s of SECRET_STRINGS) {
      assert.ok(!text.includes(s), `${p} 泄漏 ${s}`);
    }
    assert.doesNotMatch(text, /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i, `${p} 出现 Bearer 凭据`);
    assert.ok(!text.includes("eyJ"), `${p} 出现 JWT 形状的串`);
  }
  const logText = daemonLogs.join("\n");
  for (const s of SECRET_STRINGS) assert.ok(!logText.includes(s), "守护进程日志泄漏凭据");
});

test("/api/history 记录该轮；job 结束后自动快照回填 /api/state", async () => {
  // finalize（落历史）由 watchJobTick 在 job 结束后触发 —— 等它落齐
  await waitFor(async () => {
    const hist = (await api.json(api.get("/api/history?limit=200"))).data;
    return hist.rows.filter((r) => r.jobId === job1Id).length >= 6;
  }, 15000, "history 落齐 6 行");

  const hist = (await api.json(api.get("/api/history?limit=200"))).data;
  const rows = hist.rows.filter((r) => r.jobId === job1Id);
  assert.equal(rows.length, 6, "每个账号×腿一行");
  assert.equal(rows.filter((r) => r.leg === "growth" && r.state === "ok").length, 2);
  assert.ok(rows.every((r) => typeof r.at === "string" && !Number.isNaN(Date.parse(r.at))), "history.at 应为 ISO 串（stats 口径）");
  assert.ok(rows.some((r) => r.uid === UID_EXP && r.detail.includes("+100")));
  // trigger 口径（真实引擎端到端）：手动 /api/run 的行 = manual；
  // 排程行的 schedule 拼写由 tests-shell/history-trigger.test.mjs 钉死
  assert.ok(rows.every((r) => r.trigger === "manual"), `手动运行的历史行 trigger=manual，实际：${JSON.stringify([...new Set(rows.map((r) => r.trigger))])}`);

  const st = (await api.json(api.get("/api/state"))).data;
  assert.equal(st.stats.creditsToday, 920);
  assert.equal(st.stats.runs, 1);

  // 自动快照（finalizeJob → refreshSnapshots，经注入 fetch）
  await waitFor(async () => {
    const s = (await api.json(api.get("/api/state"))).data;
    return s.accounts.find((a) => a.uid === UID_OK)?.snapshot?.tasks?.length > 0;
  }, 15000, "自动任务快照");
  const st2 = (await api.json(api.get("/api/state"))).data;
  const snap = st2.accounts.find((a) => a.uid === UID_OK).snapshot;
  assert.equal(snap.tasks.length, 8);
  assert.equal(snap.energy, 42);
  assert.equal(snap.days, 3);

  // 缺陷 1 回归：假上游给的是 snake_case（task_code/reward_credit/jump_url、
  // 顶层 progress），经真实引擎 + daemon 投影后，/api/state 里必须是规范
  // camelCase 且 code/rewardCredit/jumpUrl 全部非空 —— 此前这里是空串/0，
  // 看板的「批量接任务」「领奖」只能发空 code。
  for (const t of snap.tasks) {
    assert.deepEqual(
      Object.keys(t).sort(),
      [
        "acceptStatus",
        "canAccept",
        "canLight",
        "code",
        "description",
        "desktopOnly",
        "jumpUrl",
        "lockHint",
        "locked",
        "lockedUntil",
        "pinnedExpertId",
        "progress",
        "reason",
        "rewardCredit",
        "rewardEnergy",
        "taskType",
        "title",
        "unforgeable",
      ],
    );
    assert.ok(typeof t.code === "string" && t.code.length > 0, `快照任务 code 非空（${t.title}）`);
    assert.ok(t.title.length > 0, "快照任务 title 非空");
    assert.ok(
      ["not_accepted", "accepted", "completed", "claimed"].includes(t.acceptStatus),
      `acceptStatus 是上游字符串状态（${t.acceptStatus}）`,
    );
    assert.ok(Number.isFinite(t.rewardCredit) && t.rewardCredit > 0, "rewardCredit 非零数值");
    assert.ok(Number.isFinite(t.progress.current) && Number.isFinite(t.progress.target));
    assert.equal(typeof t.desktopOnly, "boolean", "desktopOnly 是布尔（契约 §3）");
    assert.equal(typeof t.canAccept, "boolean", "canAccept 是布尔（契约 §3）");
    assert.equal(typeof t.canLight, "boolean", "canLight 是布尔（契约 §3）");
  }
  const richmeowSnap = snap.tasks.find((t) => t.title === "桌面对话事件链");
  assert.equal(richmeowSnap.jumpUrl, "workbuddy://chat", "深链必须透出");
  assert.equal(richmeowSnap.taskType, "single");
  assert.equal(richmeowSnap.desktopOnly, false, "RichMeow 已改走 6 条桌面会话事件链");
  // 整轮已把它接取（上面对 stub 状态断言 accept_status=accepted）：6 连已实现
  // → 快照回填时 canLight 翻真、canAccept 收敛为 false。
  assert.equal(richmeowSnap.canLight, true, "已接取的 RichMeow 可经 6 连点亮");
  assert.equal(richmeowSnap.canAccept, false, "已接取后不再给接取结论");
  const wechatSnap = snap.tasks.find((t) => t.code === "wb_wechat_oa_subscribe_task");
  assert.equal(wechatSnap.unforgeable, true, "unforgeable 语义沿用（公众号关注）");
  assert.match(wechatSnap.reason, /微信/, "reason 随投影下发");
  assert.equal(wechatSnap.canAccept, false, "unforgeable 不给接取结论");
  const fbSnap = snap.tasks.find((t) => t.code === "first_buddy");
  assert.equal(fbSnap.acceptStatus, "claimed", "auto 任务经整轮后应已领奖");
  assert.equal(fbSnap.taskType, "auto");

  const expRow = st2.accounts.find((a) => a.uid === UID_EXP);
  assert.equal(expRow.expiresInDays, 30, "回写后的新过期时间生效");
});

// ==============================================================================
// 4. /api/stop 在步骤边界中止
// ==============================================================================

test("/api/stop：运行中取消，步骤边界生效（后续腿不再开始）", async () => {
  // 先把 job 停在第一拍节奏（账号 1 growth 腿开跑前），彻底消除真实时序竞态：
  // stop 必然落在 growth 腿内部 → growth 跑完（腿内不查中止），travel 腿在
  // 步骤边界被拦下。
  const gate = { tripped: false, promise: null, release: null };
  gate.promise = new Promise((r) => (gate.release = r));
  stopGate = gate;
  const r = await api.json(api.post("/api/run", { legs: ["growth", "travel"] }));
  assert.equal(r.status, 200);
  await waitFor(() => gate.tripped, 10000, "job 停在第一拍节奏上");

  const stop = await api.json(api.post("/api/stop"));
  assert.equal(stop.status, 200);
  assert.equal(stop.data.job.id, r.data.job.id);
  gate.release();

  const job = await waitJobDone(r.data.job.id);
  assert.equal(job.state, "done", "取消不算 error");
  assert.equal(job.stopped, true);
  assert.ok(job.log.some((l) => l.includes("取消")), "日志注明已按要求取消");
  assert.deepEqual(
    job.steps.map((s) => s.leg),
    ["growth"],
    "只有第一条腿开跑，travel 腿在边界处被中止",
  );
  assert.ok(job.steps.every((s) => s.uid === UID_OK), "第二个账号从未开始");
});

// ==============================================================================
// 5. 夜猫子 black_cat：拨到 23:30，经 /api/run 真实计数（不领奖，明晚继续）
// ==============================================================================

test("夜猫子：23:00-08:00 窗口内经 /api/run 上报 +1，未达标不硬闯领奖", async () => {
  clock.set(todayAt(23, 30)); // 拨入夜间窗口
  const r = await api.json(api.post("/api/run", { uids: [UID_OK], legs: ["night"] }));
  assert.equal(r.status, 200);
  const job = await waitJobDone(r.data.job.id);
  assert.equal(job.state, "done");
  assert.equal(job.steps.length, 1);
  assert.equal(job.steps[0].state, "ok");
  assert.ok(job.log.some((l) => l.includes("今晚 +1")), `夜猫日志：${job.log.join("|")}`);

  const nightRep = stub.reports.filter((x) => x.uid === UID_OK && x.ev.mode === "night");
  assert.equal(nightRep.length, 1);
  assert.equal(nightRep[0].ev.eventCode, "chat_request_send");
  assert.equal(stub.tasks.get(UID_OK).find((t) => t.task_code === "black_cat").current, 1);
  assert.ok(!stub.calls.some((x) => x.path.endsWith("/black_cat/claim")), "1/3 未达标绝不领奖");
});

// ==============================================================================
// 6. 手动操作：claim（已领 → 400 → web 回退链）、accept、排除、checkin
// ==============================================================================

test("手动 claim/accept/checkin 走 HTTP API；API key 账号被排除", async () => {
  // 已领过的任务：chat 域 400 → web 域 400 → ok:false 且原因如实返回
  const cl = await api.json(api.post("/api/task/claim", { uid: UID_OK, code: "chat_5" }));
  assert.equal(cl.status, 200);
  assert.equal(cl.data.ok, false);
  assert.equal(cl.data.via, "web", "chat 域 400 后按契约试一次 web 回退");
  assert.ok(cl.data.reason);

  const ac = await api.json(api.post("/api/task/accept", { uid: UID_OK, codes: ["chat_5"] }));
  assert.equal(ac.status, 200);
  assert.deepEqual(ac.data, { accepted: [], already: ["chat_5"], failed: [] });

  // API key 账号：没有可参与账号 → 400
  const ex = await api.json(api.post("/api/run", { uids: ["apikey-6688"] }));
  assert.equal(ex.status, 400);
  assert.match(ex.data.error, /没有可参与任务的账号/);

  // 签到走计费侧（X-Machine-ID / X-Session-ID 按账号派生）
  const ci = await api.json(api.post("/api/checkin", { uids: [UID_OK] }));
  assert.equal(ci.status, 200);
  assert.deepEqual(
    { uid: ci.data[0].uid, outcome: ci.data[0].outcome, credit: ci.data[0].credit },
    { uid: UID_OK, outcome: "claimed", credit: 5 },
  );
  const bill = stub.calls.find((x) => x.host === "www.codebuddy.cn");
  assert.ok(bill, "签到应打向计费域名");
  assert.ok(bill.headers["X-Machine-ID"], "计费头必须带 X-Machine-ID");
  assert.ok(bill.headers["X-Session-ID"]);
});

// ==============================================================================
// 7. 风控红线端到端 + SSE 形状
// ==============================================================================

test("风控红线：全程任意两次上游调用间隔 ≥1000ms（假时钟戳）；SSE 事件形状正确", () => {
  const c = stub.calls;
  assert.ok(c.length > 40, `应有大量上游调用，实际 ${c.length}`);
  for (let i = 1; i < c.length; i++) {
    const d = c[i].at - c[i - 1].at;
    assert.ok(
      d >= 1000,
      `第 ${i - 1}→${i} 次上游调用间隔 ${d}ms < 1000ms：${c[i - 1].method} ${c[i - 1].path} → ${c[i].path}`,
    );
  }

  const kinds = new Set(sseEvents.map((e) => e.kind));
  assert.ok(kinds.has("job") && kinds.has("step") && kinds.has("log"), `SSE kinds: ${[...kinds]}`);
  const doneEv = sseEvents.find((e) => e.kind === "job" && e.job?.state === "done");
  assert.ok(doneEv, "SSE 应广播 job 收尾");
  assert.equal(doneEv.job.totals.credit, 920);
  const stepEv = sseEvents.find((e) => e.kind === "step");
  assert.ok(stepEv.jobId && stepEv.step.uid && stepEv.step.leg && stepEv.step.state, "step 事件字段齐全");
  const logEv = sseEvents.find((e) => e.kind === "log");
  assert.ok(typeof logEv.line === "string");
  const sseText = JSON.stringify(sseEvents);
  for (const s of SECRET_STRINGS) assert.ok(!sseText.includes(s), "SSE 泄漏凭据");
});

// ==============================================================================
// 7.5 参与任务开关（缺陷 2）：POST /api/account/toggle 真实写路径
// ==============================================================================

test("参与任务开关：停用账号被排除出 job；参数校验与持久化；恢复后回归", async () => {
  // 停用 u-oo3344：回读行 + /api/state 都要暴露生效值
  const off = await api.json(api.post("/api/account/toggle", { uid: UID_EXP, tasksEnabled: false }));
  assert.equal(off.status, 200);
  assert.equal(off.data.uid, UID_EXP);
  assert.equal(off.data.tasksEnabled, false);
  assert.equal(off.data.eligible, false);
  assert.equal(off.data.nickname, "expired-owl");
  const st1 = (await api.json(api.get("/api/state"))).data;
  assert.equal(st1.accounts.find((a) => a.uid === UID_EXP).tasksEnabled, false);

  // 显式点名被停用账号 → runner 的 eligibleAccounts 把它滤掉，job 只跑 UID_OK
  const r = await api.json(api.post("/api/run", { uids: [UID_OK, UID_EXP], legs: ["travel"] }));
  assert.equal(r.status, 200);
  const job = await waitJobDone(r.data.job.id);
  assert.deepEqual(
    [...new Set(job.steps.map((s) => s.uid))],
    [UID_OK],
    "被停用的账号不得进入 job（下一轮筛选生效）",
  );

  // 参数守卫：缺 uid → 400；未知 uid → 404
  assert.equal((await api.json(api.post("/api/account/toggle", { tasksEnabled: true }))).status, 400);
  assert.equal((await api.json(api.post("/api/account/toggle", { uid: "ghost", tasksEnabled: true }))).status, 404);

  // 恢复参与：显式 true 落盘（accounts.json），生效行回到 true
  const on = await api.json(api.post("/api/account/toggle", { uid: UID_EXP, tasksEnabled: true }));
  assert.equal(on.status, 200);
  assert.equal(on.data.tasksEnabled, true);
  assert.equal(on.data.eligible, true);
  const saved = JSON.parse(readFileSync(join(stateDir, "accounts.json"), "utf8"));
  assert.equal(saved[UID_EXP], true, "开关状态要持久化到 state/accounts.json");
});

// ==============================================================================
// 8. 生命周期（§4）：真实子进程 —— 拒绝双开 + plugins.json off:true 自杀
// ==============================================================================

test("生命周期：真实 daemon 子进程拒绝双开；plugins.json off:true 后自行退出", async () => {
  const childCfg = join(root, "config-child");
  const childState = join(childCfg, "workbuddy-tasks", "state");
  mkdirSync(childState, { recursive: true });
  writeFileSync(join(childCfg, "plugins.json"), JSON.stringify({
    plugins: [{ spec: "github:foo/bar" }, { spec: "github:me/magpie-workbuddy-tasks" }],
  }));
  writeFileSync(join(childState, "settings.json"), JSON.stringify({ scheduler: false }));

  const daemonPath = fileURLToPath(new URL("../daemon.mjs", import.meta.url));
  const child = spawn(process.execPath, [daemonPath, "--cfg", childCfg, "--state", childState, "--port", "0"], {
    env: { ...process.env, MAGPIE_ADDR: process.env.MAGPIE_ADDR },
    stdio: "ignore",
  });

  try {
    // 等子进程就绪（daemon.json + /api/hello）
    const info = await waitFor(async () => {
      const d = readDaemonInfo(childState);
      if (!d) return null;
      return (await probeDaemon(d.port, d.key)) ? d : null;
    }, 20000, "子进程守护进程就绪");

    // §4：已有健康守护进程 → 第二个 startDaemon 拒绝（WB_DAEMON_ALREADY_RUNNING）
    await assert.rejects(
      () =>
        startDaemon({
          cfgDir: childCfg,
          stateDir: childState,
          args: {},
          port: 0,
          key: "another-key",
          noTimers: true,
          skipExistingCheck: false, // 这道门就是被测对象
        }),
      (e) => e.code === "WB_DAEMON_ALREADY_RUNNING",
    );
    assert.equal(child.exitCode, null, "原守护进程不受影响");

    // §4：plugins.json 本插件条目 off:true → 守护进程自己退出（10s 检查周期）
    writeFileSync(
      join(childCfg, "plugins.json"),
      JSON.stringify({ plugins: [{ spec: "github:foo/bar" }, { spec: "github:me/magpie-workbuddy-tasks", off: true }] }),
    );
    const exited = await waitFor(async () => child.exitCode !== null, 25000, "子进程自杀退出");
    assert.ok(exited);
    assert.equal(child.exitCode, 0);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test("生命周期：ensureDaemon 在 desired=off 时不拉起；重新启用后由宿主路径拉起并就绪（§4 反方向）", async () => {
  const cfg = join(root, "config-ensure");
  const st = join(cfg, "workbuddy-tasks", "state");
  mkdirSync(st, { recursive: true });
  writeFileSync(join(cfg, "plugins.json"), JSON.stringify({
    plugins: [{ spec: "github:me/magpie-workbuddy-tasks" }],
  }));

  // 关闭态：ensureDaemon 必须直接返回 off:true，绝不 spawn（守方向）
  writeControl(st, "off");
  assert.equal(readControl(st).desired, "off");
  const r1 = await ensureDaemon({ cfgDir: cfg, pluginDir: PLUGIN_ROOT, log: () => {}, budgetMs: 3000 });
  assert.equal(r1.off, true);
  assert.equal(r1.info, null);
  assert.equal(r1.spawned, false);
  assert.equal(readDaemonInfo(st), null, "关闭态不该留下 daemon.json");

  // 重新启用（用户在插件管理里重新打开插件 → 宿主重新加载 index.mjs → ensureDaemon）
  writeControl(st, "on");
  const r2 = await ensureDaemon({ cfgDir: cfg, pluginDir: PLUGIN_ROOT, log: () => {}, budgetMs: 20000 });
  assert.equal(r2.spawned, true, "desired=on 且无健康守护进程 → 应当 spawn");
  assert.ok(r2.info?.port > 0, "spawn 后应在 daemon.json 留下端口");
  const hello = await probeDaemon(r2.info.port, r2.info.key);
  assert.ok(hello, "重新拉起的守护进程应健康就绪（enable-again 方向）");
  assert.equal(readControl(st).desired, "on");

  // 收尾：通知子进程退出，不留孤儿进程
  await shutdownDaemon(r2.info);
  await waitFor(async () => !pidAlive(r2.info.pid), 10000, "ensureDaemon 拉起的子进程退出");
});

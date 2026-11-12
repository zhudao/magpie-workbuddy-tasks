// tests-shell/frozen.test.mjs —— 403/11140 冻结（CONTRACT §10.5）的守护进程回归：
// 真实 daemon + 真实引擎 + 假时钟/假上游，零真实网络。
//
// 钉死（hub v2.1.0 口径：restricted 不是可自动恢复的冷却，直接冻结）：
//   1. job 腿收到 restricted → 立即冻结，原子落盘 state/frozen.json
//      （{uid:{at:ISO, code, message}}，tmp+rename）；
//   2. /api/state：顶层 frozen 总览（昵称拼接）+ accounts[].frozen；
//   3. 冻结账号被缺省目标排除（/api/run 的 job 名单不再有它）；
//      显式点名 /api/run → 400 没有可参与账号（缺省过滤）；
//   4. 重启后仍冻结（frozen.json → runner frozenMap 读回）；
//   5. POST /api/account/unfreeze → 解冻生效，账号回到缺省目标（再撞 403 会再次
//      冻结 —— 冻结可重复触发，记录不覆盖）。

import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startDaemon } from "../daemon.mjs";
import { makeSandbox, cleanupAllSandboxes } from "../tests/helpers.mjs";

const DAEMON_KEY = "{{SECRET_frozen11}}";
const DAY = 86400000;
// 北京正午锚点：2026-10-15 12:00 北京 = 04:00Z（与本地时区无关）
const NOW = Date.UTC(2026, 9, 15, 4, 0, 0);
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dailyClock(startMs) {
  let t = startMs;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      await realSleep(Math.min(ms, 15));
    },
    advance: (ms) => {
      t += ms;
    },
    get time() {
      return t;
    },
  };
}
const clock = dailyClock(NOW);

const UID_OK = "u-freeze-ok";
const UID_BAD = "u-freeze-bad"; // 撞 403/11140 的账号

// 假上游：u-bad 一律 403 code 11140；u-ok 走最小端点
function makeStub() {
  const calls = [];
  const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const ok = (data) => respond(200, { code: 0, msg: "success", data });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const uid = init.headers?.["X-User-Id"] ?? "";
    calls.push({ uid, path: u.pathname, host: u.host, at: clock.now() });
    if (uid === UID_BAD) return respond(403, { code: 11140, msg: "request illegal" });
    if (u.pathname === "/v2/report") return ok({});
    if (u.pathname === "/v2/activity/growth/tasks") return ok({ tasks: [] });
    if (u.pathname === "/v2/activity/growth/energy") return ok({ balance: 7 });
    if (u.pathname === "/activity/growth/streak") {
      return ok({ streak: { days: 2 }, makeup_cards: { balance: 0 }, redemption_status: {} });
    }
    if (u.pathname === "/activity/growth/heatmap") return ok({ days: [] });
    if (u.pathname === "/activity/growth/lottery/summary") return ok({ chances: 0 });
    if (u.pathname === "/activity/growth/buddy/travel/status") return ok({ state: "traveling" });
    if (u.pathname === "/billing/meter/claim-gift") return respond(200, { code: 2101, msg: "已领取过" });
    if (u.pathname === "/billing/meter/claim-compensation") return respond(200, { code: 2101, msg: "已领取过" });
    return respond(404, { code: -1, msg: "not found" });
  };
  return { calls, fetchImpl };
}

// ---- 夹具 ---------------------------------------------------------------------
const rootSb = makeSandbox("wb-tasks-frozen-");
const root = rootSb.dir;
const cfgDir = join(root, "config");
const stateDir = join(cfgDir, "workbuddy-tasks", "state");
mkdirSync(stateDir, { recursive: true });
writeFileSync(
  join(cfgDir, "plugin-auth.json"),
  JSON.stringify({
    workbuddy: {
      type: "oauth",
      access: "wb-access-FRZ-01",
      refresh: "wb-refresh-FRZ-01",
      expires: NOW + 30 * DAY,
      accountId: "freeze-cat",
      uid: UID_OK,
      domain: "copilot.tencent.com",
      tokenType: "Bearer",
    },
    "workbuddy#bad": {
      type: "oauth",
      access: "wb-access-FRZ-02",
      refresh: "wb-refresh-FRZ-02",
      expires: NOW + 30 * DAY,
      accountId: "freeze-owl",
      uid: UID_BAD,
      domain: "copilot.tencent.com",
      tokenType: "Bearer",
    },
  }),
);
writeFileSync(join(cfgDir, "plugins.json"), JSON.stringify({ plugins: [{ spec: "github:me/magpie-workbuddy-tasks" }] }));
writeFileSync(join(stateDir, "settings.json"), JSON.stringify({ scheduler: false }));

const daemonLogs = [];
const frozenFile = join(stateDir, "frozen.json");
const base = () => `http://127.0.0.1:${h.port}`;
let h = null;
let stub = makeStub();

async function boot() {
  stub = makeStub();
  return startDaemon({
    args: { cfg: cfgDir, state: stateDir, port: "0", key: DAEMON_KEY },
    now: clock.now,
    sleep: clock.sleep,
    fetch: stub.fetchImpl,
    log: (...a) => daemonLogs.push(a.join(" ")),
    noTimers: true,
    skipExistingCheck: true,
  });
}

const post = (path, body) =>
  fetch(`${base()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

async function waitJobDone(jobId) {
  const t0 = Date.now();
  for (;;) {
    const j = await (await fetch(`${base()}/api/jobs/${jobId}`)).json().catch(() => null);
    if (j && (j.state === "done" || j.state === "error")) return j;
    if (Date.now() - t0 > 20000) throw new Error("等待 job 结束超时");
    await realSleep(5);
  }
}

after(async () => {
  try {
    await h?.stop();
  } catch {}
  cleanupAllSandboxes();
});

describe("403/11140 → 冻结（§10.5）", () => {
  test("restricted → 立即冻结 + 落盘 + state 总览；不再有自动恢复", async () => {
    h = await boot();
    const r = await post("/api/run", { uids: [UID_BAD] });
    assert.equal(r.status, 200);
    const { job } = await r.json();
    const done = await waitJobDone(job.id);
    assert.equal(done.state, "done");
    // 步骤 fail + 日志说明「已冻结」
    assert.ok(done.steps.some((s) => s.uid === UID_BAD && s.state === "fail"));
    assert.ok(done.log.some((l) => l.includes("已冻结账号")), done.log.join("\n"));

    // frozen.json 原子落盘，形状 {uid:{at:ISO, code, message}}
    assert.ok(existsSync(frozenFile), "frozen.json 已落盘");
    const persisted = JSON.parse(readFileSync(frozenFile, "utf8"));
    assert.ok(persisted[UID_BAD], "冻结条目存在");
    assert.equal(persisted[UID_BAD].code, 11140);
    assert.ok(!Number.isNaN(Date.parse(persisted[UID_BAD].at)), "at 是 ISO 串");
    assert.ok(persisted[UID_BAD].message.includes("403"), `message 带上游现场：${persisted[UID_BAD].message}`);

    // /api/state：顶层 frozen 总览（昵称拼接）+ accounts[].frozen
    const st = await (await fetch(`${base()}/api/state`)).json();
    assert.equal(st.frozen.length, 1);
    assert.equal(st.frozen[0].uid, UID_BAD);
    assert.equal(st.frozen[0].nickname, "freeze-owl", "冻结总览拼上昵称");
    assert.equal(st.frozen[0].code, 11140);
    assert.equal(st.accounts.find((a) => a.uid === UID_BAD).frozen.code, 11140);
    assert.equal(st.accounts.find((a) => a.uid === UID_OK).frozen, null);
    // 旧 scheduler.holds 字段已被顶层 frozen 替代
    assert.ok(!("holds" in st.scheduler), "scheduler.holds 已被顶层 frozen 替代");
  });

  test("冻结账号被缺省目标排除；显式点名 /api/run → 400", async () => {
    const n0 = stub.calls.filter((c) => c.uid === UID_BAD).length;
    const r = await post("/api/run", {});
    assert.equal(r.status, 200);
    const { job } = await r.json();
    assert.deepEqual(job.spec.uids, [UID_OK], "缺省名单只有未冻结账号");
    await waitJobDone(job.id);
    assert.equal(
      stub.calls.filter((c) => c.uid === UID_BAD).length,
      n0,
      "冻结账号零上游（此前 4 次是第一条用例里它自己撞 403 的调用）",
    );

    const r2 = await post("/api/run", { uids: [UID_BAD] });
    assert.equal(r2.status, 400, "显式点名冻结账号在 /api/run 里按无可参与账号处理");
    assert.match((await r2.json()).error, /没有可参与任务的账号/);
  });

  test("重启后仍冻结（frozen.json 读回 runner）；unfreeze 生效后回到缺省目标", async () => {
    await h.stop();
    h = await boot();
    const st = await (await fetch(`${base()}/api/state`)).json();
    assert.equal(st.frozen.length, 1, "重启后冻结状态从 state/frozen.json 恢复");
    assert.equal(st.frozen[0].uid, UID_BAD);
    const r = await post("/api/run", {});
    const { job } = await r.json();
    assert.deepEqual(job.spec.uids, [UID_OK], "重启后缺省名单仍排除冻结账号");
    await waitJobDone(job.id);

    // 解冻：{uid} 单账号形状
    const uf = await post("/api/account/unfreeze", { uid: UID_BAD });
    assert.equal(uf.status, 200);
    assert.deepEqual(await uf.json(), { ok: true, unfrozen: [UID_BAD], missing: [] });
    const onDisk = JSON.parse(readFileSync(frozenFile, "utf8"));
    assert.ok(!(UID_BAD in onDisk), "frozen.json 条目已删");
    const st2 = await (await fetch(`${base()}/api/state`)).json();
    assert.deepEqual(st2.frozen, []);

    // 解冻后回到缺省目标：再撞 403 → 再次冻结（记录不覆盖旧的语义：先解才可再冻）
    const r2 = await post("/api/run", {});
    const { job: job2 } = await r2.json();
    assert.deepEqual(job2.spec.uids.sort(), [UID_BAD, UID_OK].sort(), "解冻账号回到缺省名单");
    const done = await waitJobDone(job2.id);
    assert.ok(done.steps.some((s) => s.uid === UID_BAD && s.state === "fail"), "403 再现 → 步骤失败");
    const persisted = JSON.parse(readFileSync(frozenFile, "utf8"));
    assert.ok(persisted[UID_BAD], "再次冻结并落盘");
    assert.equal(persisted[UID_BAD].code, 11140);
    const missing = await post("/api/account/unfreeze", { uid: UID_OK });
    assert.deepEqual(await missing.json(), { ok: true, unfrozen: [], missing: [UID_OK] }, "没冻结的进 missing");
  });

  test("显式指定冻结账号的单账号操作（claim/accept）如实失败并给「恢复」提示", async () => {
    await h.stop();
    h = await boot();
    const n0 = stub.calls.filter((c) => c.uid === UID_BAD).length;
    // claim：{ok:false, reason 带「恢复」提示}（响应形状不变，不 4xx）
    const cl = await post("/api/task/claim", { uid: UID_BAD, code: "chat_5" });
    assert.equal(cl.status, 200);
    const clBody = await cl.json();
    assert.equal(clBody.ok, false);
    assert.match(clBody.reason, /账号已冻结/);
    assert.match(clBody.reason, /恢复/);
    // accept：全部请求 code 进 failed，reason 同款提示
    const ac = await post("/api/task/accept", { uid: UID_BAD, codes: ["chat_5", "skill_1"] });
    assert.equal(ac.status, 200);
    const acBody = await ac.json();
    assert.deepEqual(acBody.accepted, []);
    assert.deepEqual(acBody.failed.map((f) => f.code), ["chat_5", "skill_1"]);
    assert.match(acBody.failed[0].reason, /账号已冻结/);
    // 零上游：冻结拦截发生在引擎调用之前
    assert.equal(stub.calls.filter((c) => c.uid === UID_BAD).length, n0);
  });
});

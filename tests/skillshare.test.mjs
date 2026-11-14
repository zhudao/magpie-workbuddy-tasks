// tests/skillshare.test.mjs —— skill_share 自动化（CONTRACT §11.2，hub 8eede085）
// 回归。spec 从 unforgeable 改 kind:"skillshare"；流程 = 市场技能 → 创建真实分享
// 渠道 → 两条 skill_share_channel_action（桌面头上报）→ 轮询进度 → 领奖。
//
// 钉死：
//   - 市场请求体 {page:1,page_size:20}、code 200 信封也认（hub 口径）、偏好技能
//     skill_2097350077599879168 优先、缺偏好取第一个可用；
//   - 渠道请求体/头逐字（asset_ref 紧凑 JSON、ways 三形态、桌面 UA + X-Domain:
//     copilot.tencent.com）；必须同时拿到 share_code 与 link，缺一跳过不领奖；
//   - 两条事件字段与顺序（click → success，同 actionAt、id=share_code）+ 桌面
//     指纹包络；一次 report 发两条；
//   - 桌面端点 2xx 空 body = 成功（hub 传输契约）；
//   - 进度未确认不提前领奖；restricted 透传；该 code 由 growth 腿执行（不再
//     unforgeable，会进接取批次）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { DESKTOP_UA_CN, DESKTOP_VERSION_CN, SKILL_MARKET_URL, SKILL_SHARE_CHANNEL_URL, SKILL_SHARE_PREFERRED_ID, TASK_SPECS } from "../engine/constants.mjs";
import { deriveId } from "../engine/fingerprint.mjs";
import { resolveTaskKind } from "../engine/taskkind.mjs";
import { progressTask, reportDesktopEvents, runGrowthTasks, skillShareChannelEvents } from "../engine/tasks.mjs";
import { fakeClock, makeAcct } from "./helpers.mjs";

const GAP = 1000;
const NOW = Date.UTC(2026, 10, 13, 4, 0, 0);

// ---- 假上游 ----------------------------------------------------------------------
// opts: {acceptStatus, marketResponse, channelResponse, reportResponse,
//        completeAfterEvents, restricted}
function skillShareStub(opts = {}, clock = fakeClock(NOW)) {
  const calls = [];
  const reports = [];
  const state = {
    task: {
      task_code: "skill_share",
      title: "分享一个技能给好友",
      description: "",
      jump_url: "",
      accept_status: opts.acceptStatus ?? "accepted",
      task_type: "single",
      current: 0,
      target: 1,
      reward_credit: 100,
    },
    claims: [],
  };
  const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const okBody = opts.marketResponse ?? {
    code: 0,
    data: {
      skills: [
        { skill_id: "skill_111", display_name_zh: "普通技能A", description_zh: "A 的描述" },
        { skill_id: SKILL_SHARE_PREFERRED_ID, name: "偏好技能P" },
      ],
    },
  };

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = String(init.method || "GET").toUpperCase();
    const headers = init.headers ?? {};
    let body = null;
    if (typeof init.body === "string" && init.body.length) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ host: u.host, path: u.pathname, method, headers, body, at: clock.now() });

    if (opts.restricted) return respond(403, { code: 11140, msg: "request illegal" });

    if (u.pathname === "/v2/activity/growth/tasks") {
      const t = state.task;
      return respond(200, {
        code: 0,
        data: {
          tasks: [{
            task_code: t.task_code, title: t.title, description: t.description, jump_url: t.jump_url,
            accept_status: t.accept_status, task_type: t.task_type,
            progress: { current: t.current, target: t.target }, reward_credit: t.reward_credit,
          }],
        },
      });
    }
    if (u.pathname === "/v2/activity/growth/tasks/accept") {
      const results = (body?.task_codes ?? []).map((code) => {
        if (code !== state.task.task_code) return { task_code: code, status: "unknown_task", message: "no such task" };
        if (state.task.accept_status === "not_accepted") {
          state.task.accept_status = "accepted";
          return { task_code: code, status: "accepted" };
        }
        return { task_code: code, status: "already_accepted" };
      });
      return respond(200, { code: 0, data: { results } });
    }
    if (u.pathname === "/v2/operation-platform/market/skill/list") {
      return respond(opts.marketStatus ?? 200, opts.marketStatus ? { code: 500, msg: "market down" } : okBody);
    }
    if (u.host === "open.workbuddy.cn" && u.pathname === "/api/v2/open-platform/asset-shares/c2c/channels") {
      if (opts.channelStatus) return respond(opts.channelStatus, { code: 500, msg: "channel down" });
      return respond(200, opts.channelResponse ?? {
        code: 0,
        data: {
          share_code: "sc-20261113",
          channel_id: "ch-9",
          ways: [
            { share_way: "wxacode", resource_ref: "data:image/png;base64,xxx" },
            { share_way: "link", resource_ref: "https://www.workbuddy.cn/s/sc-20261113" },
          ],
        },
      });
    }
    if (u.pathname === "/v2/report") {
      reports.push({ events: Array.isArray(body) ? body : [body], headers, host: u.host });
      if (opts.completeAfterEvents) {
        state.task.current = 1;
        state.task.accept_status = "completed";
      }
      if (opts.reportStatus) return { status: opts.reportStatus, text: async () => "" };
      return respond(200, { code: 0, data: {} });
    }
    const claimMatch = /^\/activity\/growth\/tasks\/([^/]+)\/claim$/.exec(u.pathname);
    if (claimMatch) {
      const t = state.task;
      if (t.current >= t.target && t.accept_status !== "not_accepted") {
        t.accept_status = "claimed";
        state.claims.push(t.task_code);
        return respond(200, { code: 0, data: { credit: t.reward_credit, energy: 0 } });
      }
      return respond(400, { code: 400, msg: "task not completed" });
    }
    if (u.pathname === "/v2/activity/growth/energy") return respond(200, { code: 0, data: { balance: 42 } });
    return respond(404, { code: -1, msg: "not found" });
  };

  return { fetchImpl, calls, reports, state, clock };
}

const baseOpts = (stub) => ({ now: stub.clock.now, sleep: stub.clock.sleep, fetch: stub.fetchImpl, gap: GAP });

function taskFrom(stub) {
  const t = stub.state.task;
  return {
    code: t.task_code, title: t.title, description: t.description, jumpUrl: t.jump_url,
    acceptStatus: t.accept_status, locked: false, unlockAt: "", taskType: t.task_type,
    progress: { current: t.current, target: t.target },
    rewardCredit: t.reward_credit, rewardEnergy: 0, unforgeable: false, reason: "",
  };
}

// ---- spec / kind 判定 ------------------------------------------------------------

test("skillshare：spec 改 kind:\"skillshare\"，不再 unforgeable（growth 腿可接可点亮）", () => {
  const spec = TASK_SPECS.skill_share;
  assert.equal(spec.kind, "skillshare");
  assert.equal(spec.target, 1);
  assert.equal(spec.reward, 100);
  assert.equal(spec.name, "分享一个技能给好友");
  assert.equal(spec.unforgeable, undefined);
  const rk = resolveTaskKind({ code: "skill_share", acceptStatus: "accepted", taskType: "single", title: "分享一个技能给好友", jumpUrl: "" });
  assert.equal(rk.source, "spec");
  assert.equal(rk.kind, "skillshare");
  assert.equal(rk.unforgeable, false);
  assert.equal(rk.canAccept, false, "accepted 状态不可再接");
  assert.equal(rk.canLight, true, "accepted 状态可点亮");
});

// ---- 全流程 ----------------------------------------------------------------------

test("skillshare：growth 腿全流程 —— 接取 → 市场偏好技能 → 建渠道 → 双事件 → 领奖", async () => {
  const stub = skillShareStub({ acceptStatus: "not_accepted", completeAfterEvents: true });
  const res = await runGrowthTasks(makeAcct(), { ...baseOpts(stub), travel: false });
  assert.equal(res.ok, true, res.logs.join("\n"));
  assert.equal(res.earnedCredit, 100);
  assert.equal(res.claimed, 1);

  // 1) 接取批次包含 skill_share（不再 unforgeable）
  const accept = stub.calls.find((c) => c.path === "/v2/activity/growth/tasks/accept");
  assert.deepEqual(accept.body.task_codes, ["skill_share"]);

  // 2) 市场技能目录：body {page:1,page_size:20}（chat 头）
  const market = stub.calls.find((c) => c.path === "/v2/operation-platform/market/skill/list");
  assert.deepEqual(market.body, { page: 1, page_size: 20 });
  assert.equal(market.host, "www.codebuddy.cn");
  assert.equal(market.method, "POST");
  assert.equal(market.headers["X-User-Id"], "u-12345678");
  assert.equal(market.headers["Authorization"], "Bearer access-token-abc");

  // 3) 创建分享渠道：请求体逐字（asset_ref 紧凑 JSON、ways 三形态、extra 全字段）
  const channel = stub.calls.find((c) => c.host === "open.workbuddy.cn");
  assert.equal(channel.path, "/api/v2/open-platform/asset-shares/c2c/channels");
  assert.equal(channel.method, "POST");
  assert.deepEqual(channel.body, {
    asset_kind: "skill",
    asset_source: "market",
    asset_ref: `{"asset_id":"${SKILL_SHARE_PREFERRED_ID}"}`,
    ways: ["link", "wxacode", "wxapath"],
    extra: {
      name: "偏好技能P",
      description: "",
      shareKey: SKILL_SHARE_PREFERRED_ID,
      marketplaceSource: "builtin-market",
    },
  });
  // 头：chat 头族 + 桌面 UA / X-Domain: copilot.tencent.com（hub 逐字）
  assert.equal(channel.headers["User-Agent"], DESKTOP_UA_CN);
  assert.equal(channel.headers["X-Domain"], "copilot.tencent.com");
  assert.equal(channel.headers["X-User-Id"], "u-12345678");
  assert.equal(channel.headers["Accept"], "application/json, text/plain, */*");
  assert.equal(channel.headers["Authorization"], "Bearer access-token-abc");

  // 4) 两条 skill_share_channel_action：一次 report、click → success、字段逐字
  assert.equal(stub.reports.length, 1, "两条事件一次上报");
  const [ev1, ev2] = stub.reports[0].events;
  assert.equal(ev1.eventCode, "skill_share_channel_action");
  assert.equal(ev1.action, "link");
  assert.equal(ev1.panelAction, "click");
  assert.equal(ev1.panelType, "clipboard");
  assert.equal(ev1.isSuccessful, true);
  assert.equal(ev1.cost, 0);
  assert.equal(ev1.id, "sc-20261113");
  assert.equal(ev1.skillId, SKILL_SHARE_PREFERRED_ID);
  assert.equal(ev1.skillName, "偏好技能P");
  assert.equal(ev1.skillType, "market");
  assert.equal(ev2.eventCode, "skill_share_channel_action");
  assert.equal(ev2.panelAction, "success");
  assert.equal(ev2.id, "sc-20261113");
  assert.equal(ev2.actionAt, ev1.actionAt, "两条共享同一 actionAt");
  assert.equal(ev2.skillId, ev1.skillId);
  // 桌面指纹包络（userId/machineId/sessionId/ideVersion 5.8.3）
  assert.equal(ev1.userId, "u-12345678");
  assert.equal(ev1.ideVersion, DESKTOP_VERSION_CN);
  assert.equal(ev1.extVersion, DESKTOP_VERSION_CN);
  assert.equal(ev1.machineId, deriveId("u-12345678", "machine"));
  assert.equal(ev1.sessionId, deriveId("u-12345678", "session"));
  // 上报走 chat 域 + 桌面头族（hub `_report_desktop_events`）
  assert.equal(stub.reports[0].host, "copilot.tencent.com");
  assert.equal(stub.reports[0].headers["User-Agent"], DESKTOP_UA_CN);
  assert.equal(stub.reports[0].headers["X-Domain"], "copilot.tencent.com");
  assert.equal(stub.reports[0].headers["X-Product"], "SaaS");
  assert.equal(stub.reports[0].headers["X-User-Id"], "u-12345678");

  // 5) 领奖在进度确认之后
  assert.deepEqual(stub.state.claims, ["skill_share"]);
  assert.ok(res.logs.some((l) => l.includes("领奖成功: +100 积分")));
});

test("skillshare：市场无偏好技能 → 取第一个可用；市场拒绝/为空 → 如实跳过不伪造", async () => {
  // ① 偏好 id 不在列表 → 第一个候选
  const a = skillShareStub({
    completeAfterEvents: true,
    marketResponse: { code: 0, data: { skills: [{ skill_id: "skill_222", display_name_en: "Skill B" }] } },
  });
  const ra = await progressTask(makeAcct(), taskFrom(a), [], baseOpts(a));
  assert.equal(ra.claimed, 1);
  const evA = a.reports[0].events[0];
  assert.equal(evA.skillId, "skill_222");
  assert.equal(evA.skillName, "Skill B", "display_name_en 兜底");

  // ② 市场拒绝（code 500 信封）→ 跳过、无渠道、无事件、无领奖
  const b = skillShareStub({ marketStatus: 200 });
  const rb = await progressTask(makeAcct(), taskFrom(b), [], baseOpts(b));
  assert.equal(rb.claimed, 0);
  assert.equal(b.calls.filter((c) => c.host === "open.workbuddy.cn").length, 0);
  assert.equal(b.reports.length, 0);
  assert.equal(b.calls.filter((c) => c.path.endsWith("/claim")).length, 0);

  // ③ 市场目录为空 → 同款跳过
  const c = skillShareStub({
    marketResponse: { code: 0, data: { skills: [{ display_name_zh: "无 id" }] } },
  });
  const rc = await progressTask(makeAcct(), taskFrom(c), [], baseOpts(c));
  assert.equal(rc.claimed, 0);
  assert.equal(c.calls.filter((x) => x.host === "open.workbuddy.cn").length, 0);
});

test("skillshare：渠道缺 share_code / 缺 link / HTTP 失败 → 跳过且不领奖（不伪造）", async () => {
  for (const [label, opts] of [
    ["缺 share_code", { channelResponse: { code: 0, data: { ways: [{ share_way: "link", resource_ref: "https://x" }] } } }],
    ["缺 link", { channelResponse: { code: 0, data: { share_code: "sc-1", ways: [{ share_way: "wxacode", resource_ref: "img" }] } } }],
    ["HTTP 500", { channelStatus: 500 }],
  ]) {
    const stub = skillShareStub(opts);
    const logs = [];
    const res = await progressTask(makeAcct(), taskFrom(stub), logs, baseOpts(stub));
    assert.equal(res.claimed, 0, label);
    assert.equal(res.credit, 0, label);
    assert.equal(stub.reports.length, 0, `${label}：渠道没建成绝不上报事件`);
    assert.equal(stub.state.claims.length, 0, `${label}：不领奖`);
    assert.ok(logs.some((l) => l.includes("创建分享渠道失败")), `${label}：${logs.join("|")}`);
  }
});

test("skillshare：渠道建好但事件上报失败 → 不领奖；桌面端点 2xx 空 body = 成功", async () => {
  // ① 上报 500 → 不领奖
  const a = skillShareStub({ reportStatus: 500 });
  const logs = [];
  const ra = await progressTask(makeAcct(), taskFrom(a), logs, baseOpts(a));
  assert.equal(ra.claimed, 0);
  assert.ok(logs.some((l) => l.includes("渠道已创建但事件上报失败，不领奖")), logs.join("|"));

  // ② 桌面端点 204 空 body → 传输层成功（hub 口径），照常轮询/领奖
  const b = skillShareStub({ reportStatus: 204, completeAfterEvents: true });
  const ok = await reportDesktopEvents(makeAcct(), [{ eventCode: "skill_share_channel_action" }], baseOpts(b));
  assert.equal(ok, true, "2xx + 空 body 是 desktop 端点的成功契约");
});

test("skillshare：进度未确认不提前领奖；确认后下一轮领", async () => {
  // ① 事件发了但服务端进度没动 → 领奖顺延
  const a = skillShareStub({ completeAfterEvents: false });
  const logs = [];
  const ra = await progressTask(makeAcct(), taskFrom(a), logs, baseOpts(a));
  assert.equal(ra.claimed, 0);
  assert.equal(a.state.claims.length, 0);
  assert.ok(logs.some((l) => l.includes("进度 0/1 未确认，领奖顺延到下次运行")), logs.join("|"));
  assert.ok(logs.some((l) => l.includes("正在等待任务 [分享一个技能给好友] 服务端进度落账...")));

  // ② 轮询中途服务端确认 → 领奖（4 次 × 3s 的预算之内）
  const b = skillShareStub({ completeAfterEvents: true });
  const rb = await progressTask(makeAcct(), taskFrom(b), [], baseOpts(b));
  assert.equal(rb.claimed, 1);
  assert.equal(rb.credit, 100);
});

test("skillshare：restricted（403/11140）透传，渠道/事件/领奖全停", async () => {
  const stub = skillShareStub({ restricted: true });
  const res = await progressTask(makeAcct(), taskFrom(stub), [], baseOpts(stub));
  assert.equal(res.restricted, true);
  assert.equal(res.claimed, 0);
  assert.equal(stub.calls.filter((c) => c.host === "open.workbuddy.cn").length, 0);
  assert.equal(stub.reports.length, 0);
});

test("skillshare：skillShareChannelEvents 纯函数 —— 两条事件字段与顺序", () => {
  const [e1, e2] = skillShareChannelEvents("skill_1", "技能甲", "sc-7", NOW);
  assert.equal(e1.eventCode, "skill_share_channel_action");
  assert.equal(e1.panelAction, "click");
  assert.equal(e1.action, "link");
  assert.equal(e1.panelType, "clipboard");
  assert.equal(e1.isSuccessful, true);
  assert.equal(e1.cost, 0);
  assert.equal(e1.id, "sc-7");
  assert.equal(e1.skillId, "skill_1");
  assert.equal(e1.skillName, "技能甲");
  assert.equal(e1.skillType, "market");
  assert.equal(e1.actionAt, NOW);
  assert.equal(e2.panelAction, "success");
  assert.equal(e2.actionAt, NOW);
  assert.equal(e2.id, "sc-7");
});

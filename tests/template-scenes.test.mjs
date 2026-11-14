// tests/template-scenes.test.mjs —— template_5 四事件 + 真实场景（CONTRACT §11.3，
// hub 8eede085）回归。旧的 buildEvent 单事件（agent_task_created_with_template +
// 硬编码「幻灯片」）已删除，替换为：场景表接口（失败/为空回落内置表）+ 按缺口
// 逐组上报四事件（agent_task_created → agent_task_created_with_template →
// template_used → playbook_prompt_send）+ 每组轮询服务端进度。
//
// 钉死：
//   - 场景表：GET www.workbuddy.cn/console/as/support/scenes?locale=zh-CN；
//     失败/为空才回落 hub 内置表（fallback 标记）；
//   - 四事件组：顺序、组内共享 requestId/conversationId、字段逐字；
//   - 一组必须推进服务端计数才发下一组；计数不动 → 停止补发；
//   - 进度未确认不提前领奖（领奖只在服务端确认 current>=target 之后）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { TEMPLATE_FALLBACK_SCENES, TEMPLATE_SCENES_URL, TASK_SPECS } from "../engine/constants.mjs";
import { fetchTemplateScenes, templateEvents } from "../engine/tasks.mjs";
import { progressTask, runGrowthTasks } from "../engine/tasks.mjs";
import { fakeClock, makeAcct } from "./helpers.mjs";

const GAP = 1000;
const NOW = Date.UTC(2026, 10, 13, 4, 0, 0);
const REAL_SCENES = [
  { id: 11, name: "财报速读" },
  { id: 12, name: "竞品对比" },
  { id: 13, name: "会议纪要" },
];

// ---- 假上游 ----------------------------------------------------------------------
// opts: {scenesResponse|scenesStatus, confirmEachGroup(每组推进 1)|stalled, restricted}
function templateStub(opts = {}, clock = fakeClock(NOW)) {
  const calls = [];
  const reports = [];
  const state = {
    task: {
      task_code: "template_5",
      title: "模板创建任务",
      description: "",
      jump_url: "",
      accept_status: opts.acceptStatus ?? "accepted",
      task_type: "single",
      current: 0,
      target: 5,
      reward_credit: 200,
    },
    claims: [],
  };
  const respond = (status, body) => ({ status, text: async () => JSON.stringify(body) });

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
    calls.push({ host: u.host, path: u.pathname, query: u.search, method, headers, body, at: clock.now() });

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
    if (u.pathname === "/console/as/support/scenes") {
      if (opts.scenesStatus) return respond(opts.scenesStatus, { code: 500, msg: "scenes down" });
      return respond(200, opts.scenesResponse ?? { code: 0, data: { scenes: REAL_SCENES } });
    }
    if (u.pathname === "/v2/report") {
      const events = Array.isArray(body) ? body : [body];
      reports.push({ events, headers, host: u.host });
      if (opts.confirmEachGroup && events.some((e) => e.eventCode === "agent_task_created")) {
        state.task.current += 1;
        if (state.task.current >= state.task.target) state.task.accept_status = "completed";
      }
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

// ---- 场景表 ----------------------------------------------------------------------

test("template-scenes：场景接口成功用真实场景；失败/为空回落内置表", async () => {
  const acct = makeAcct();
  // ① 成功 → 真实场景（fallback 标记缺省）
  const a = templateStub();
  const sa = await fetchTemplateScenes(acct, baseOpts(a));
  assert.equal(sa.ok, true);
  assert.equal(sa.fallback, undefined);
  assert.deepEqual(sa.scenes, [["11", "财报速读"], ["12", "竞品对比"], ["13", "会议纪要"]]);
  const sceneCall = a.calls.find((c) => c.path === "/console/as/support/scenes");
  assert.equal(sceneCall.host, "www.workbuddy.cn");
  assert.equal(sceneCall.query, "?locale=zh-CN");
  assert.equal(sceneCall.method, "GET");

  // ② HTTP 500 → 回落内置表（hub 逐字）
  const b = templateStub({ scenesStatus: 500 });
  const sb = await fetchTemplateScenes(acct, baseOpts(b));
  assert.equal(sb.fallback, true);
  assert.deepEqual(sb.scenes, TEMPLATE_FALLBACK_SCENES);

  // ③ 200 但 scenes 为空 → 回落
  const c = templateStub({ scenesResponse: { code: 0, data: { scenes: [] } } });
  const sc = await fetchTemplateScenes(acct, baseOpts(c));
  assert.equal(sc.fallback, true);
  assert.deepEqual(sc.scenes, TEMPLATE_FALLBACK_SCENES);
});

// ---- 四事件组 --------------------------------------------------------------------

test("template-scenes：templateEvents 四事件顺序与字段（hub `_template_events` 逐字）", () => {
  const [created, withTpl, used, prompt] = templateEvents("11", "财报速读", NOW);
  assert.deepEqual(
    [created, withTpl, used, prompt].map((e) => e.eventCode),
    ["agent_task_created", "agent_task_created_with_template", "template_used", "playbook_prompt_send"],
  );
  // ① agent_task_created
  assert.equal(created.source, "CLOUD");
  assert.equal(created.name, "");
  assert.equal(created.mode, "craft");
  assert.equal(created.requestModelId, "default");
  assert.equal(created.action, "11");
  assert.equal(created.has_template, true);
  assert.equal(created.template_id, "11");
  assert.equal(created.template_name, "财报速读");
  // ② agent_task_created_with_template
  assert.equal(withTpl.templateId, "11");
  assert.equal(withTpl.templateName, "财报速读");
  assert.equal(withTpl.template_id, "11");
  assert.equal(withTpl.mode, "working");
  assert.equal(withTpl.isCustomModel, true);
  assert.equal(withTpl.id, "11");
  assert.equal(withTpl.name, "财报速读");
  // ③ template_used
  assert.equal(used.template_id, "11");
  assert.equal(used.templateId, "11");
  assert.equal(used.templateName, "财报速读");
  assert.equal(used.task_mode, "working");
  assert.equal(used.id, "11");
  assert.equal(used.source, "growth-center");
  // ④ playbook_prompt_send
  assert.ok(typeof prompt.ext1 === "string" && prompt.ext1.length >= 32, "ext1 = uuid");
  assert.equal(prompt.id, "11");
  assert.equal(prompt.name, "财报速读");
  assert.equal(prompt.type, "other");
  assert.equal(prompt.promptLength, 30);
  assert.equal(prompt.isOfficial, 1);
  assert.equal(prompt.source, "growth-center");
  // 组内共享 requestId / conversationId（hub 逐字：template_used 只带
  // conversationId 不带 requestId）
  for (const e of [created, withTpl, used, prompt]) {
    assert.equal(e.conversationId, created.conversationId);
  }
  assert.equal(used.requestId, undefined, "template_used 不带 requestId（hub 逐字）");
  for (const e of [created, withTpl, prompt]) {
    assert.equal(e.requestId, created.requestId);
  }
  // requestId 形态（hub `_new_message_id`：12 位 hex 毫秒 + 20 hex）
  assert.match(created.requestId, /^[0-9a-f]{32}$/);
});

// ---- 主流程 ----------------------------------------------------------------------

test("template-scenes：按缺口逐组上报（真实场景轮转），服务端确认后领奖", async () => {
  const stub = templateStub({ confirmEachGroup: true });
  const logs = [];
  const res = await progressTask(makeAcct(), taskFrom(stub), logs, baseOpts(stub));
  assert.equal(res.claimed, 1, logs.join("|"));
  assert.equal(res.credit, 200);
  assert.equal(res.lit, 1);

  // 恰 5 组（缺口 5），每组 4 条事件、顺序钉死
  assert.equal(stub.reports.length, 5);
  const groupIds = [];
  for (const r of stub.reports) {
    assert.deepEqual(
      r.events.map((e) => e.eventCode),
      ["agent_task_created", "agent_task_created_with_template", "template_used", "playbook_prompt_send"],
    );
    groupIds.push(r.events[0].action);
  }
  assert.deepEqual(groupIds, ["11", "12", "13", "11", "12"], "场景按 current % len 轮转");
  // 上报走桌面头族（chat 域 /v2/report + 桌面 UA）
  const report = stub.reports[0];
  assert.equal(report.host, "copilot.tencent.com");
  assert.equal(report.headers["User-Agent"], "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0");
  assert.equal(report.headers["X-Domain"], "copilot.tencent.com");
  assert.equal(report.headers["X-Product"], "SaaS");
  // 领奖在服务端确认之后（stub 在第 5 组才 completed）
  assert.deepEqual(stub.state.claims, ["template_5"]);
  assert.ok(logs.some((l) => l.includes("当前服务端进度 5/5")));
});

test("template-scenes：场景接口失败回落内置表（事件用内置场景 id）", async () => {
  const stub = templateStub({ scenesStatus: 500, confirmEachGroup: true });
  const logs = [];
  const res = await progressTask(makeAcct(), taskFrom(stub), logs, baseOpts(stub));
  assert.equal(res.claimed, 1, logs.join("|"));
  const groupIds = stub.reports.map((r) => r.events[0].action);
  assert.deepEqual(groupIds, ["0", "4", "8", "16", "20"], "内置表五场景按缺口轮转");
  assert.ok(logs.some((l) => l.includes("当前服务端进度 5/5")));
});

test("template-scenes：一组不推进就停手 —— 不喷重复事件、不提前领奖", async () => {
  const stub = templateStub({ confirmEachGroup: false });
  const logs = [];
  const res = await progressTask(makeAcct(), taskFrom(stub), logs, baseOpts(stub));
  assert.equal(res.claimed, 0);
  assert.equal(res.credit, 0);
  assert.equal(stub.reports.length, 1, "只发一组（计数不动就停），绝不补喷");
  assert.equal(stub.state.claims.length, 0, "进度未确认绝不领奖");
  assert.ok(logs.some((l) => l.includes("服务端进度未增长，停止本轮补发")), logs.join("|"));
  assert.ok(logs.some((l) => l.includes("进度 0/5 未确认，领奖顺延到下次运行")));
});

test("template-scenes：partial 缺口（current 3/5）→ 只补 2 组", async () => {
  const stub = templateStub({ confirmEachGroup: true });
  stub.state.task.current = 3;
  const res = await progressTask(makeAcct(), taskFrom(stub), [], baseOpts(stub));
  assert.equal(res.claimed, 1);
  assert.equal(stub.reports.length, 2, "缺口 2 → 恰 2 组");
  assert.deepEqual(stub.reports.map((r) => r.events[0].action), ["11", "12"], "从 current % len 继续（3%3=0）");
});

test("template-scenes：restricted（403/11140）透传（场景接口即停）", async () => {
  const stub = templateStub({ restricted: true });
  const res = await progressTask(makeAcct(), taskFrom(stub), [], baseOpts(stub));
  assert.equal(res.restricted, true);
  assert.equal(res.claimed, 0);
  assert.equal(stub.reports.length, 0);
});

test("template-scenes：growth 腿集成 —— accepted 的 template_5 经四事件组点亮并领奖", async () => {
  const stub = templateStub({ confirmEachGroup: true });
  const res = await runGrowthTasks(makeAcct(), { ...baseOpts(stub), travel: false });
  assert.equal(res.ok, true, res.logs.join("\n"));
  assert.equal(res.earnedCredit, 200);
  assert.equal(res.claimed, 1);
  assert.equal(res.lit, 1);
  assert.equal(stub.reports.length, 5);
});

test("template-scenes：claimed 状态直接跳过（不重上报）", async () => {
  const stub = templateStub({ acceptStatus: "claimed" });
  const res = await progressTask(makeAcct(), taskFrom(stub), [], baseOpts(stub));
  assert.equal(res.claimed, 0);
  assert.equal(stub.reports.length, 0);
  assert.equal(stub.calls.filter((c) => c.path === "/console/as/support/scenes").length, 0, "已领奖连场景表都不拉");
});

test("template-scenes：spec kind 仍为 template（TASK_SPECS 不改），buildEvent 已无该分支", async () => {
  assert.equal(TASK_SPECS.template_5.kind, "template");
  assert.equal(TASK_SPECS.template_5.target, 5);
  assert.equal(TASK_SPECS.template_5.reward, 200);
});

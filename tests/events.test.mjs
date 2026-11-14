import { test } from "node:test";
import assert from "node:assert/strict";

import { TASK_SPECS, EXPERT_ID_POOL, TEAM_ID_POOL } from "../engine/constants.mjs";
import { buildEvent } from "../engine/tasks.mjs";
import { fakeClock, makeAcct } from "./helpers.mjs";

const NOW = 1_760_000_000_000;
const clock = fakeClock(NOW);
const acct = makeAcct({ uid: "uid-X" });

function ev(kind, opts = {}) {
  return buildEvent(acct, kind, opts.idx ?? 0, opts.expert ?? null, { now: clock.now });
}
// playbook 返回双事件数组；统一成数组便于断言。
function evList(kind, opts = {}) {
  const e = ev(kind, opts);
  return Array.isArray(e) ? e : [e];
}

test("每种 kind 的 eventCode 与必填字段", () => {
  const cases = [
    ["canvas", "wbx_design_canvas_task_create", ["conversationId", "requestId", "source", "isCustomModel", "inputLength", "id", "cost", "isSuccessful"]],
    // template（template_5）不再有单事件构造（CONTRACT §11.3 换成四事件组 +
    // 真实场景表，走 tasks.runTemplateTask）—— buildEvent 没有 template 分支，
    // 误用落 heartbeat（见下方「template 无单事件构造」用例）
    ["expert", "expert_actual_use", ["mode", "id", "name", "expertTitle", "type", "expertType", "source", "version", "cost", "characterCount", "conversationId", "requestId", "messageId", "requestModelId", "requestModelName"]],
    ["team", "expert_actual_use", ["expertType"]],
    ["lighthouse", "expert_actual_use", ["expertType"]],
    ["skill", "skill_info", ["skillId", "name"]],
    ["automation", "automated_task_create_suc", ["name", "type", "source", "modelId", "modelIsThinking", "schedule", "prompt"]],
    ["skin", "appearance_skin_apply", ["action", "source", "id", "vipLevel", "series", "type", "name"]],
    ["chat", "chat_request_send", ["mode", "conversationId", "requestId", "inputLength", "requestModelId", "requestModelName", "isPlan", "agentName", "agentType"]],
    ["glmchat", "chat_request_send", []],
    ["cat", "chat_request_send", []],
    ["unknown-kind", "heartbeat", ["timestamp"]],
  ];
  for (const [kind, eventCode, fields] of cases) {
    const e = ev(kind);
    assert.equal(e.eventCode, eventCode, kind);
    for (const f of fields) assert.ok(Object.hasOwn(e, f), `${kind} 缺字段 ${f}`);
  }
});

test("playbook：双事件链（cta_click + prompt_send，hub 937c179 口径）", () => {
  const [cta, send] = evList("playbook");
  // 除 playbook 外都是单事件：数组只属于事件链构造器
  assert.equal(evList("chat").length, 1);

  assert.equal(cta.eventCode, "playbook_cta_click");
  assert.equal(cta.timestamp, NOW);
  assert.equal(cta.reportDelay, 0);
  assert.equal(cta.id, "worker-ledger-freedom-dashboard");
  assert.equal(cta.name, "打工人小账本");
  assert.equal(cta.type, "document");
  assert.equal(cta.source, "discover");
  assert.equal(cta.position, 0);
  assert.equal(cta.categoryId, "");
  assert.equal(cta.categoryName, "");
  assert.equal(cta.conversationId, `wb-task-${NOW}-0`);
  assert.equal(cta.requestId, `wb-task-${NOW}-0-req`);
  assert.equal(cta.messageId, `wb-task-${NOW}-0-req`);
  assert.equal(cta.userId, "uid-X");

  assert.equal(send.eventCode, "playbook_prompt_send");
  assert.equal(send.timestamp, NOW + 50, "prompt_send 比 cta_click 晚 50ms");
  assert.equal(send.id, "worker-ledger-freedom-dashboard");
  assert.equal(send.name, "打工人小账本");
  assert.equal(send.type, "document");
  assert.equal(send.promptLength, 30);
  assert.equal(send.isOfficial, 1);
  assert.equal(send.source, "discover");
  assert.equal(send.conversationId, cta.conversationId);
  assert.equal(send.requestId, cta.requestId);
  assert.equal(send.messageId, cta.messageId);
  assert.equal(send.skills, "");
  assert.equal(send.skillNames, "");
  assert.equal(send.userId, "uid-X");
});

test("userId 必在（缺了服务端 200 但静默丢弃）", () => {
  for (const kind of ["canvas", "expert", "team", "lighthouse", "skill", "automation", "playbook", "skin", "chat", "glmchat", "cat", "whatever"]) {
    const list = evList(kind);
    assert.ok(list.length >= 1, kind);
    for (const e of list) assert.equal(e.userId, "uid-X", `${kind} 的 ${e.eventCode ?? "?"}`);
  }
});

test("template 无单事件构造（§11.3：四事件组在 runTemplateTask，不在 buildEvent）", () => {
  // buildEvent 的 template 分支已删除：误用只会落 heartbeat（比静默发旧的单事件
  // 更诚实）；四事件组由 tests/template-scenes.test.mjs 钉死。
  const e = ev("template");
  assert.equal(e.eventCode, "heartbeat");
});

test("timestamp 用注入时钟；conversationId 形态 wb-task-<now>-<idx>", () => {
  const e = ev("chat", { idx: 3 });
  assert.equal(e.timestamp, NOW);
  assert.equal(e.conversationId, `wb-task-${NOW}-3`);
  assert.equal(e.requestId, `wb-task-${NOW}-3-req`);
});

test("专家/团队：默认池、钉死 id、模式与模型字段", () => {
  // 默认 expert（无池指定）
  const e = ev("expert");
  assert.equal(e.id, "ContentCreator");
  assert.equal(e.name, "内容创作专家");
  assert.equal(e.expertType, "agent");
  assert.equal(e.mode, "CLOUD");
  assert.equal(e.requestModelId, "deepseek-v4-flash");

  // team
  const t = ev("team");
  assert.equal(t.id, "CloudOpsTeam");
  assert.equal(t.expertType, "team");

  // lighthouse 钉死真实 id
  const l = ev("lighthouse");
  assert.equal(l.id, "ex_2cvvUZQhDyeJ");
  assert.equal(l.name, "腾讯轻量云专家");

  // WorkBuddy_Valorant 钉死真实 id（spec.expert 注入）
  const v = ev("expert", { expert: TASK_SPECS.WorkBuddy_Valorant.expert });
  assert.equal(v.id, "ex_xQHHD1u5Jkua");
  assert.equal(v.name, "无畏契约拼豆专家");

  // 显式 expert 注入
  const x = ev("expert", { expert: ["ex_custom", "自定义专家"] });
  assert.equal(x.id, "ex_custom");
  assert.equal(x.expertTitle, "自定义专家");
});

test("chat / glmchat / cat 的模型与模式", () => {
  assert.equal(ev("chat").requestModelId, "deepseek-v4-flash");
  assert.equal(ev("chat").requestModelName, "DeepSeek V4 Flash");
  assert.equal(ev("chat").mode, "craft");
  assert.equal(ev("glmchat").requestModelId, "glm-5.2");
  assert.equal(ev("glmchat").requestModelName, "GLM-5.2");
  assert.equal(ev("glmchat").mode, "craft");
  assert.equal(ev("cat").requestModelId, "glm-5.2");
  assert.equal(ev("cat").mode, "night");
});

test("id 池容量与首元素（去重轮换的弹药）", () => {
  assert.ok(EXPERT_ID_POOL.length >= 5);
  assert.ok(TEAM_ID_POOL.length >= 3);
  const ids = new Set(EXPERT_ID_POOL.map(([id]) => id));
  assert.equal(ids.size, EXPERT_ID_POOL.length); // 池内本身无重复
  assert.ok(ids.has("ex_2cvvUZQhDyeJ")); // 轻量云专家也在专家池里
});

test("RichMeow：6 条桌面会话事件链（agent_task_created → … → agent_task_completed）", () => {
  const chain = evList("richmeow");
  // 恰好 6 条、顺序钉死（hub build_desktop_chat_events 口径）；整条链一次上报
  const codes = chain.map((e) => e.eventCode);
  assert.deepEqual(codes, [
    "agent_task_created",
    "chat_message_send",
    "chat_request_send",
    "chat_message_response",
    "chat_request_response",
    "agent_task_completed",
  ]);

  // timestamp 依次 +20（0/20/40/60/80/100）
  for (let i = 0; i < chain.length; i++) {
    assert.equal(chain[i].timestamp, NOW + 20 * i, `第 ${i} 条 timestamp = NOW+${20 * i}`);
  }

  // 公共字段：全部带 userId/userNickname（缺了服务端 200 但静默丢弃）
  for (const e of chain) {
    assert.equal(e.userId, "uid-X", e.eventCode);
    assert.equal(e.userNickname, "测试账号", e.eventCode);
  }

  // conversationId / requestId / messageId 同链一致（同一会话的 6 条事件）
  const cid = `wb-task-${NOW}-0`;
  const rid = `${cid}-req`;
  const created = chain[0];
  assert.equal(created.source, "LOCAL");
  assert.equal(created.conversationId, cid);
  assert.equal(created.messageId, `msg-${NOW}-0`);
  assert.equal(created.requestModelId, "fast-model");
  const send = chain[1];
  assert.equal(send.messageId, `msg-${NOW}-0-ast`);
  assert.equal(send.traceId, rid);
  assert.equal(send.rootRequestId, rid);
  assert.equal(send.parentConversationId, cid);
  const reqSend = chain[2];
  assert.equal(reqSend.inputLength, 24);
  assert.equal(reqSend.conversationId, cid);
  assert.equal(reqSend.messageId, `msg-${NOW}-0`);
  const resp = chain[3];
  assert.equal(resp.messageId, `msg-${NOW}-0-resp`);
  assert.equal(resp.conversationId, cid);
  const reqResp = chain[4];
  assert.equal(reqResp.requestModelId, "fast-model");
  assert.equal(reqResp.inputToken, 6);
  assert.equal(reqResp.outputToken, 12);
  // 最后一条推进任务：status=success，conversationId/messageId 与首条一致
  const done = chain[5];
  assert.equal(done.status, "success");
  assert.equal(done.conversationId, cid);
  assert.equal(done.messageId, `msg-${NOW}-0`);
});

test("新活动任务 spec（hub 937c179）：workstation_expert 钉死 WorkspaceBuilder、Sequential_Tasks_7 走 playbook", () => {
  const ws = TASK_SPECS.workstation_expert;
  assert.deepEqual(ws.expert, ["WorkspaceBuilder", "工作台搭建师"]);
  assert.equal(ws.kind, "expert");
  assert.equal(ws.target, 1);
  assert.equal(ws.reward, 100);
  // 钉死的专家 id 注入 buildEvent 后原样出现在事件里
  const e = ev("expert", { expert: ws.expert });
  assert.equal(e.id, "WorkspaceBuilder");
  assert.equal(e.expertTitle, "工作台搭建师");

  const s7 = TASK_SPECS.Sequential_Tasks_7;
  assert.equal(s7.kind, "playbook");
  assert.equal(s7.target, 1);
  assert.equal(s7.reward, 100);
  assert.equal(s7.name, "PC灵感功能");
});

test("Buddy_App 5 连：5 条 buddyapp_* 事件 + 桌面指纹（2026-11-06 实测口径）", () => {
  const chain = evList("buddy5");
  assert.deepEqual(chain.map((e) => e.eventCode), [
    "buddyapp_discover_click",
    "buddyapp_show",
    "buddyapp_enter_click",
    "buddyapp_auth_confirm_click",
    "buddyapp_bindaccount_skip_click",
  ]);
  for (const e of chain) {
    assert.equal(e.userId, "uid-X");
    assert.equal(e.ideType, "WorkBuddy");
    assert.equal(e.ideVersion, "5.5.6");
    assert.equal(e.extName, "workbuddy-desktop");
    assert.equal(e.timezone, "Asia/Shanghai");
    assert.ok(e.machineId && e.sessionId, "桌面指纹必须带 machineId/sessionId");
    if (["buddyapp_discover_click", "buddyapp_auth_confirm_click", "buddyapp_bindaccount_skip_click"].includes(e.eventCode)) {
      assert.equal(e.buddyId, "cb_y5Dy46tPQGGWtueMxXbe");
      assert.equal(e.buddyName, "企鹅教师助手");
    }
  }
  assert.equal(chain[2].elementId, "growth_buddy");
  assert.equal(chain[2].position, 2);
  assert.equal(chain[2].isFirstPage, "1");
});

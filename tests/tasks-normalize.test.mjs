// tests/tasks-normalize.test.mjs —— 缺陷 1 回归（node --test）。
//
// 上游（wbBackend 照抄真实响应形状）返回的是 snake_case：task_code / reward_credit /
// reward_energy / jump_url / accept_status / task_type + 顶层 progress。fetchTasks
// 必须在引擎边界一次性归一成规范 camelCase Task（CONTRACT §2）——此前 daemon 的
// snapTask 按规范拼写取不到值，/api/state 里 code/rewardCredit/jumpUrl 永远是空串/0，
// 看板的「批量接任务」「领奖」只能发空 code。这里逐字段钉死规范拼写。

import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchTasks } from "../engine/tasks.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

const STATUS_WORDS = ["not_accepted", "accepted", "completed", "claimed"];

test("fetchTasks：snake_case 上游 → 规范 camelCase Task（raw 非枚举保留原文）", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [
      task("create_canvas", { title: "创建设计任务", reward: 300, reward_energy: 5 }),
      task("Library_read", { title: "浏览资料库", reward: 100, jump_url: "workbuddy://library" }),
    ],
    litRules: {},
  });
  const tasks = await fetchTasks(makeAcct(), {
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });

  assert.equal(tasks.length, 2);
  for (const t of tasks) {
    // 规范拼写的键集合逐字钉死（多一个上游拼写、少一个规范拼写都算回归；
    // locked/unlockAt 是 2026-11-11 起的次日锁字段——web 清单也带，与
    // fetchMPTasks 同口径归一）
    assert.deepEqual(
      Object.keys(t).sort(),
      [
        "acceptStatus",
        "code",
        "description",
        "jumpUrl",
        "locked",
        "progress",
        "reason",
        "rewardCredit",
        "rewardEnergy",
        "taskType",
        "title",
        "unforgeable",
        "unlockAt",
      ],
    );
    assert.ok(typeof t.code === "string" && t.code.length > 0, "code 必须非空（缺陷 1 的直接病灶）");
    assert.ok(t.title.length > 0, "title 必须非空");
    assert.ok(STATUS_WORDS.includes(t.acceptStatus), `acceptStatus 应为上游字符串状态，得到 ${t.acceptStatus}`);
    assert.equal(t.task_code, undefined, "不许再带上游拼写 task_code");
    assert.equal(t.reward_credit, undefined, "不许再带上游拼写 reward_credit");
    assert.ok(!Object.keys(t).includes("raw"), "raw 是非枚举字段，不进 Object.keys");
    assert.equal(t.raw.task_code, t.code, "raw 保留上游原始对象（调试用）");
    assert.ok(typeof t.rewardCredit === "number" && t.rewardCredit > 0);
    assert.deepEqual(t.progress, { current: 0, target: 1 });
  }

  const canvas = tasks.find((t) => t.code === "create_canvas");
  assert.equal(canvas.title, "创建设计任务");
  assert.equal(canvas.rewardCredit, 300);
  assert.equal(canvas.rewardEnergy, 5);
  assert.equal(canvas.acceptStatus, "not_accepted");
  assert.equal(canvas.taskType, "single");
  assert.equal(canvas.jumpUrl, "");

  const lib = tasks.find((t) => t.code === "Library_read");
  assert.equal(lib.jumpUrl, "workbuddy://library", "深链必须透出（看板展示用）");
  assert.equal(lib.unforgeable, false);
});

test("fetchTasks：JSON 序列化后没有任何 snake_case 键（daemon 投影只认规范拼写）", async () => {
  const clock = fakeClock(localTime(2026, 9, 15, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [
      task("first_buddy", { task_type: "auto", reward: 300 }),
      task("chat_5", { reward: 100, status: "accepted", current: 3, target: 5 }),
    ],
    litRules: {},
  });
  const tasks = await fetchTasks(makeAcct(), {
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const text = JSON.stringify(tasks); // raw 非枚举：不会出现在序列化结果里
  for (const bad of ["task_code", "reward_credit", "reward_energy", "jump_url", "accept_status", "task_type"]) {
    assert.ok(!text.includes(`"${bad}"`), `序列化结果不该出现上游拼写 ${bad}`);
  }
  const auto = tasks.find((t) => t.code === "first_buddy");
  assert.equal(auto.taskType, "auto");
  assert.equal(auto.progress.current, 0);
  const chat = tasks.find((t) => t.code === "chat_5");
  assert.equal(chat.acceptStatus, "accepted");
  assert.deepEqual(chat.progress, { current: 3, target: 5 });
});

test("fetchTasks：上游 locked/unlock_at 透传；缺失时归一 false/\"\"（与 fetchMPTasks 同口径）", async () => {
  const clock = fakeClock(localTime(2026, 11, 11, 10, 0));
  // 2026-11-11 生产实测形态：ST7（PC 灵感功能）在 web 清单带 locked:true +
  // unlock_at（+08:00 ISO）；无锁任务上游不下发这两个字段
  const backend = wbBackend({
    clock,
    tasks: [
      task("Sequential_Tasks_7", {
        title: "体验灵感功能", jump_url: "workbuddy://playbook",
        locked: true, unlock_at: "2026-11-12T00:00:00+08:00",
      }),
      task("create_canvas", { title: "创建设计任务", reward: 300 }), // 上游没给锁字段
    ],
    litRules: {},
  });
  const tasks = await fetchTasks(makeAcct(), {
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  const st7 = tasks.find((t) => t.code === "Sequential_Tasks_7");
  assert.equal(st7.locked, true, "上游 locked:true 透传");
  assert.equal(st7.unlockAt, "2026-11-12T00:00:00+08:00", "unlock_at 原样透传（解析留给投影）");
  assert.equal(st7.unforgeable, false, "锁字段不影响 unforgeable 语义（TASK_SPECS 命中照旧可自动化）");
  const canvas = tasks.find((t) => t.code === "create_canvas");
  assert.equal(canvas.locked, false, "上游没给 locked → 归一 false");
  assert.equal(canvas.unlockAt, "", "上游没给 unlock_at → 归一空串");
});

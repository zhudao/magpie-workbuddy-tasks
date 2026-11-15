// tests/dashboard-pick.test.mjs —— 看板「可勾选任务码」口径的行为验证（零依赖、零网络）。
//
// 背景（缺陷 F1）：selectableCodes 是「全选 / 已选 N 项 / 批量 codes 范围」的唯一可选码来源。
// 旧实现只排除 locked，**没有排除已领奖（claimed）** 的快照任务；而界面上已领奖的行
// 被 stripPickCell 清空了勾选框、并沉进「已完成」折叠块 —— 于是「全选」会选中一批看不见、
// 也点不动的任务，pickedUnion() 非空 → 批量操作带上一轮实际无可做项的范围。
// 同一份代码里活动腿（campaignPickCodes）却正确地排除了已领奖，两腿口径自相矛盾。
//
// 本用例是【行为断言】：直接 import dashboard/app.js 导出的纯函数 selectableCodes 并调用它，
// 用普通对象构造快照 / 活动状态，断言返回的可选码集合。不引入 jsdom 等依赖，
// 也不需要 DOM —— selectableCodes 及其依赖（taskFlags / campaignPickCodes / campaignTaskClaimed）
// 全是纯函数，不触碰 document（app.js 顶部有 `typeof document !== "undefined"` 启动守卫，
// Node 下 import 只加载定义、不启动页面）。
//
// 判定方式：行为断言（非源码结构断言）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { selectableCodes } from "../dashboard/app.js";

// 便捷：把可选码结果排序后比较，避免依赖内部拼接顺序（快照腿在前、活动腿在后）。
const codesOf = (a) => selectableCodes(a).slice().sort();

test("F1 回归：已领奖（claimed）的快照任务不可勾选（不再被算进可选码）", () => {
  const a = {
    uid: "u1",
    snapshot: {
      tasks: [
        { code: "T_claimed", acceptStatus: "claimed", progress: { current: 1, target: 1 } },
        { code: "T_open", acceptStatus: "not_accepted" },
      ],
    },
  };
  // 修复前这里会得到 ["T_claimed","T_open"]；修复后 claimed 必须被排除。
  assert.deepEqual(codesOf(a), ["T_open"], "已领奖的快照任务不得出现在可选码里");
  assert.ok(!selectableCodes(a).includes("T_claimed"));
});

test("锁定的任务仍不可勾选（旧口径不回归）", () => {
  const a = {
    uid: "u1",
    snapshot: {
      tasks: [
        { code: "T_locked", acceptStatus: "not_accepted", locked: true },
        { code: "T_open", acceptStatus: "not_accepted" },
      ],
    },
  };
  assert.deepEqual(codesOf(a), ["T_open"]);
});

test("无 code 的行不可勾选", () => {
  const a = { uid: "u1", snapshot: { tasks: [{ acceptStatus: "not_accepted" }, { code: "T_open", acceptStatus: "not_accepted" }] } };
  assert.deepEqual(codesOf(a), ["T_open"]);
});

test("已接取 / 已完成待领奖 / 老后端缺 acceptStatus 的行为：仍可勾选（不过度排除）", () => {
  const a = {
    uid: "u1",
    snapshot: {
      tasks: [
        { code: "T_accepted", acceptStatus: "accepted" },
        { code: "T_completed", acceptStatus: "completed", progress: { current: 1, target: 1 } },
        { code: "T_legacy" }, // 老后端：无 acceptStatus → 不当作已领奖
      ],
    },
  };
  assert.deepEqual(codesOf(a), ["T_accepted", "T_completed", "T_legacy"]);
});

test("两腿口径一致：活动腿已领奖（claimedAt 非空）同样排除，未领奖保留", () => {
  const a = {
    uid: "u1",
    snapshot: { tasks: [] },
    campaign: {
      activities: [
        {
          code: "ACT1",
          tasks: [
            { taskCode: "x", claimedAt: "2026-01-01T00:00:00Z" }, // 已领 → 排除
            { taskCode: "y", claimedAt: "" }, // 未领 → 保留
            { taskCode: "z" }, // 缺 claimedAt → 未领，保留
          ],
        },
      ],
    },
  };
  assert.deepEqual(codesOf(a), ["ACT1:y", "ACT1:z"]);
});

test("快照腿与活动腿对「已领奖」的排除口径对齐（同一账号内混合场景）", () => {
  const a = {
    uid: "u1",
    snapshot: {
      tasks: [
        { code: "G_done", acceptStatus: "claimed" },
        { code: "G_todo", acceptStatus: "not_accepted" },
      ],
    },
    campaign: {
      activities: [
        {
          code: "ACT",
          tasks: [
            { taskCode: "done", claimedAt: "2026-02-02T00:00:00Z" },
            { taskCode: "todo", claimedAt: "" },
          ],
        },
      ],
    },
  };
  assert.deepEqual(codesOf(a), ["ACT:todo", "G_todo"]);
});

test("锁定 + 已领奖叠加：任一条件命中即不可勾选", () => {
  const a = {
    uid: "u1",
    snapshot: {
      tasks: [
        { code: "T_claimed", acceptStatus: "claimed", locked: true },
        { code: "T_locked", acceptStatus: "accepted", locked: true },
        { code: "T_open", acceptStatus: "accepted" },
      ],
    },
  };
  assert.deepEqual(codesOf(a), ["T_open"]);
});

test("缺快照 / 缺活动状态时不抛错，返回空数组", () => {
  assert.deepEqual(selectableCodes({ uid: "u1" }), []);
  assert.deepEqual(selectableCodes({ uid: "u1", snapshot: null, campaign: null }), []);
  assert.deepEqual(selectableCodes(undefined), []);
});

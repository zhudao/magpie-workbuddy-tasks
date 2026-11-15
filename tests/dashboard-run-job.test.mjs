// tests/dashboard-run-job.test.mjs —— magpie 看板 P3-d 重构的行为验证（零依赖、零网络、零 DOM）。
//
// 覆盖三处被抽出的助手与收敛后的腿名常量：
//   1. runRequestBody —— 纯函数，POST /api/run 的请求体组装口径（老口径：不带 = 全部可参与）；
//   2. startRunJob   —— 触发一轮 job 的共同流程（POST → onStarted → 清 state.lastFinished
//      → loadState → connectSSE）。用 deps 注入缝（生产不传）做行为断言；
//   3. refreshForReselect —— 「有勾选但按当前快照筛不出 → 强制刷新快照重判」的共同处理，
//      三态返回（conflict / skipped / account）。用 opts.refresh / opts.setStatus 注入缝断言；
//   4. LEG_CAMPAIGN / LEG_STREAK 与既有 LEG_NAMES / POINTS_LEGS / DEFAULT_LEGS 是同一套腿名。
//
// 判定方式：**行为断言**（像 tests/dashboard-pick.test.mjs 那样 import 真函数、传普通对象），
// 不是源码结构断言。app.js 顶部有 `typeof document !== "undefined"` 启动守卫，
// Node 下 import 只加载定义、不启动页面。
//
// 注入缝说明（如实）：startRunJob / refreshForReselect 若直接跑会触达 fetch / document，
// 故二者带一个「生产不传、默认真实实现」的注入参数（deps / opts.*），与 daemon 侧
// saveAccountRefresh 的 interpose 注入缝同思路；这里的断言全部落在「被注入函数收到的实参、
// 调用顺序、返回值、notes 台账、state.lastFinished」上，是真行为断言。

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  runRequestBody,
  startRunJob,
  refreshForReselect,
  LEG_CAMPAIGN,
  LEG_STREAK,
  LEG_NAMES,
  POINTS_LEGS,
  DEFAULT_LEGS,
  ApiError,
  state,
} from "../dashboard/app.js";

// ---- 1. runRequestBody：请求体组装 --------------------------------------------------

test("runRequestBody：仅给 legs → 只带 legs（uids/codes/claim 都不带 = 全部口径）", () => {
  assert.deepEqual(runRequestBody({ legs: ["growth"] }), { legs: ["growth"] });
});

test("runRequestBody：空/缺省 uids 不带（塞空数组会被后端当成「无目标账号」）", () => {
  assert.deepEqual(runRequestBody({ legs: [LEG_STREAK], uids: [] }), { legs: [LEG_STREAK] });
  assert.deepEqual(runRequestBody({ legs: [LEG_STREAK], uids: undefined }), { legs: [LEG_STREAK] });
});

test("runRequestBody：非空 uids 原样带上，且是副本（不共享调用方数组引用）", () => {
  const uids = ["u1", "u2"];
  const body = runRequestBody({ legs: ["growth"], uids });
  assert.deepEqual(body.uids, ["u1", "u2"]);
  assert.notEqual(body.uids, uids, "应拷贝，避免调用方后续改数组影响已发出的请求体");
});

test("runRequestBody：codes 仅在提供时带上（无勾选 = 不带 = 全部任务）", () => {
  assert.ok(!("codes" in runRequestBody({ legs: ["growth"] })), "缺省 codes 不应出现");
  const codes = { u1: ["A", "B"] };
  assert.deepEqual(runRequestBody({ legs: ["growth"], codes }), { legs: ["growth"], codes });
});

test("runRequestBody：claim 区分「未表达」（缺省/undefined）与「显式」—— false 也要带（不误当全部）", () => {
  assert.ok(!("claim" in runRequestBody({ legs: ["growth"] })), "缺省 claim 不应出现");
  assert.ok(!("claim" in runRequestBody({ legs: ["growth"], claim: undefined })), "undefined 视为未表达");
  assert.deepEqual(runRequestBody({ legs: ["growth"], claim: false }), { legs: ["growth"], claim: false });
  assert.deepEqual(runRequestBody({ legs: ["growth"], claim: true }), { legs: ["growth"], claim: true });
});

test("runRequestBody：三个调用点的真实形态（runFull / runStreakSelected / runCampaignOne）", () => {
  // runFull：legs + claim + 可选 uids + 可选 codes
  assert.deepEqual(
    runRequestBody({ legs: ["growth", LEG_STREAK], claim: true, uids: ["u1"], codes: { u1: ["T1"] } }),
    { legs: ["growth", LEG_STREAK], claim: true, uids: ["u1"], codes: { u1: ["T1"] } },
  );
  // runStreakSelected：只有 legs + 可选 uids，无 claim/codes
  assert.deepEqual(runRequestBody({ legs: [LEG_STREAK], uids: ["u1"] }), { legs: [LEG_STREAK], uids: ["u1"] });
  // runCampaignOne：单账号 + 单腿
  assert.deepEqual(runRequestBody({ uids: ["u9"], legs: [LEG_CAMPAIGN] }), { uids: ["u9"], legs: [LEG_CAMPAIGN] });
});

// ---- 2. startRunJob：启动一轮 job 的共同流程 -----------------------------------------

test("startRunJob：POST /api/run，method=POST，body 为 runRequestBody 组装的请求体；返回 api 响应", async () => {
  const calls = [];
  const deps = {
    api: async (path, opts) => {
      calls.push(["api", path, opts]);
      return { job: { id: "job-1" } };
    },
    loadState: async () => {
      calls.push(["loadState"]);
    },
    connectSSE: () => {
      calls.push(["connectSSE"]);
    },
  };
  const r = await startRunJob({ legs: [LEG_STREAK], uids: ["u1"] }, (res) => calls.push(["onStarted", res.job.id]), deps);
  assert.equal(r.job.id, "job-1", "应把 api 响应原样返回给调用方");
  assert.deepEqual(calls[0], ["api", "api/run", { method: "POST", body: { legs: [LEG_STREAK], uids: ["u1"] } }]);
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["api", "onStarted", "loadState", "connectSSE"],
    "顺序必须是 POST → onStarted → loadState → connectSSE",
  );
});

test("startRunJob：onStarted 在 loadState 之前、且拿到 api 响应（调用方在此记 jobId / 写状态文案）", async () => {
  const order = [];
  await startRunJob({ legs: [LEG_CAMPAIGN], uids: ["u1"] }, (res) => order.push(["onStarted", res.job.id]), {
    api: async () => ({ job: { id: "job-2" } }),
    loadState: async () => order.push(["loadState"]),
    connectSSE: () => order.push(["connectSSE"]),
  });
  assert.deepEqual(order, [["onStarted", "job-2"], ["loadState"], ["connectSSE"]]);
});

test("startRunJob：清掉上一轮收尾标记 state.lastFinished，避免新 job 被当成已结束的旧 job", async () => {
  state.lastFinished = { id: "old-job" };
  try {
    await startRunJob({ legs: [LEG_STREAK] }, null, {
      api: async () => ({ job: { id: "new" } }),
      loadState: async () => {},
      connectSSE: () => {},
    });
    assert.equal(state.lastFinished, null);
  } finally {
    state.lastFinished = null;
  }
});

test("startRunJob：api 抛错时不继续（不 onStarted / 不 loadState / 不 connectSSE，异常原样上抛）", async () => {
  const seen = [];
  await assert.rejects(
    startRunJob({ legs: [LEG_STREAK] }, () => seen.push("onStarted"), {
      api: async () => {
        throw new Error("boom");
      },
      loadState: async () => seen.push("loadState"),
      connectSSE: () => seen.push("connectSSE"),
    }),
    /boom/,
  );
  assert.deepEqual(seen, [], "api 失败后不应触发 onStarted / loadState / connectSSE");
});

// ---- 3. refreshForReselect：有勾选但筛不出 → 强制刷新快照重判 --------------------------

test("refreshForReselect：刷新成功 → { account: 刷新后的账号 }，不落任何说明、不 setStatus", async () => {
  const notes = [];
  const fresh = { uid: "u1", nickname: "甲", snapshot: { tasks: [] } };
  const rr = await refreshForReselect({ uid: "u1", nickname: "甲" }, notes, {
    refresh: async (uid) => {
      assert.equal(uid, "u1", "应按账号 uid 刷新");
      return fresh;
    },
    setStatus: () => {
      throw new Error("成功路径不应 setStatus");
    },
  });
  assert.equal(rr.account, fresh);
  assert.deepEqual(notes, []);
  assert.ok(!rr.conflict && !rr.skipped);
});

test("refreshForReselect：409（已有批量任务在跑）→ { conflict:true } 且写 conflictMsg，不落 notes", async () => {
  const notes = [];
  let status = null;
  const rr = await refreshForReselect({ uid: "u1" }, notes, {
    conflictMsg: "已有批量任务在跑，领奖中止。",
    refresh: async () => {
      throw new ApiError(409, { error: "busy" });
    },
    setStatus: (t) => {
      status = t;
    },
  });
  assert.deepEqual(rr, { conflict: true });
  assert.equal(status, "已有批量任务在跑，领奖中止。");
  assert.deepEqual(notes, [], "409 走 conflict 分支，不往 notes 落");
});

test("refreshForReselect：非 409 抛错 → { skipped:true } 且往 notes 落默认失败说明（claim 侧口径）", async () => {
  const notes = [];
  const rr = await refreshForReselect({ uid: "u1", nickname: "甲" }, notes, {
    conflictMsg: "x",
    refresh: async () => {
      throw new Error("network");
    },
  });
  assert.deepEqual(rr, { skipped: true });
  assert.deepEqual(notes, ["甲：快照刷新失败"]);
});

test("refreshForReselect：errNote 定制失败说明（accept 侧拼 humanizeApiErr 提示）", async () => {
  const notes = [];
  await refreshForReselect({ uid: "u1", nickname: "甲" }, notes, {
    conflictMsg: "x",
    errNote: (e) => `快照刷新失败（${e.message}）`,
    refresh: async () => {
      throw new Error("HTTP 500");
    },
  });
  assert.deepEqual(notes, ["甲：快照刷新失败（HTTP 500）"]);
});

test("refreshForReselect：账号消失（刷新返回 null）→ { skipped:true } 且落说明", async () => {
  const notes = [];
  const rr = await refreshForReselect({ uid: "u1", nickname: "甲" }, notes, {
    conflictMsg: "x",
    refresh: async () => null,
  });
  assert.deepEqual(rr, { skipped: true });
  assert.deepEqual(notes, ["甲：快照刷新失败"]);
});

test("refreshForReselect：说明里的 who 用 nickname，缺 nickname 回退 uid", async () => {
  const notes = [];
  await refreshForReselect({ uid: "uid-9" }, notes, { conflictMsg: "x", refresh: async () => null });
  assert.deepEqual(notes, ["uid-9：快照刷新失败"]);
});

// ---- 4. 腿名常量与既有常量同一套腿名 ------------------------------------------------

test("LEG_CAMPAIGN / LEG_STREAK 取值正确（收敛后就是线协议里的腿名字符串）", () => {
  assert.equal(LEG_CAMPAIGN, "campaign");
  assert.equal(LEG_STREAK, "streak");
});

test("腿名收敛一致：常量就是 LEG_NAMES 的键，且被 POINTS_LEGS / DEFAULT_LEGS 采用", () => {
  assert.ok(LEG_CAMPAIGN in LEG_NAMES, "LEG_CAMPAIGN 必须是 LEG_NAMES 里的真实腿名");
  assert.ok(LEG_STREAK in LEG_NAMES, "LEG_STREAK 必须是 LEG_NAMES 里的真实腿名");
  assert.equal(LEG_NAMES[LEG_CAMPAIGN], "活动任务");
  assert.equal(LEG_NAMES[LEG_STREAK], "连登管家");
  assert.ok(POINTS_LEGS.includes(LEG_CAMPAIGN), "POINTS_LEGS 应含活动腿常量");
  assert.ok(DEFAULT_LEGS.includes(LEG_STREAK), "DEFAULT_LEGS 应含连登腿常量");
});

test("runRequestBody 用腿名常量发出的 legs 与线协议字面值一致", () => {
  assert.deepEqual(runRequestBody({ legs: [LEG_STREAK] }).legs, ["streak"]);
  assert.deepEqual(runRequestBody({ legs: [LEG_CAMPAIGN] }).legs, ["campaign"]);
});

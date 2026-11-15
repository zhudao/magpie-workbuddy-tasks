// tests/dashboard-render-incremental.test.mjs —— 看板「增量渲染 / 健壮性」的四条修复验证
// （零依赖、零网络、不引入 jsdom）。
//
// 覆盖：
//   F3   每轮 loadState 全量重建「账号 × 任务树」 → 按 uid 的 keyed 增量 + 内容指纹门控；
//   F2   日志/步骤表 O(n²) 重建、日志无上限 → 增量 append + 环形裁剪 + rAF 合并；
//   P3-a 用上游 uid 直接拼属性选择器 → CSS.escape（Node 下有守卫兜底）；
//   P3-b renderJob 重建日志容器导致「总是滚到底」 → 滚动位置落 state 后恢复。
//
// 断言形式（明确区分，别混为一谈）：
//   · 【行为断言】：import dashboard/app.js 导出的纯函数，用普通对象/数字直接调用并断言结果
//     —— acctFingerprint / taskBodyFingerprint / stableSig（F3 内容门控）、logWindowPlan
//     （F2 日志增量计划）、cssEscape（P3-a 转义）。这些是驱动行为的真实逻辑，不是抄结构。
//   · 【源码结构断言】：DOM 重绘路径（renderAccounts/renderJob/renderJobLogs/handleSSE）无法在
//     零依赖下真跑（没有 DOM、且 state 为模块私有不可注入），退回读源码断言「关键调用/门控/
//     增量路径存在、旧的整树重建路径已消失」。结构断言只证明「接线方式」，不等价于运行时验证。
//
// 说明：app.js 顶部有 `typeof document !== "undefined"` 启动守卫，Node 下 import 只加载定义、
// 不启动页面、不触碰 document（上面被断言的纯函数也不碰 DOM）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  acctFingerprint,
  taskBodyFingerprint,
  logWindowPlan,
  cssEscape,
  stableSig,
} from "../dashboard/app.js";

const SRC = readFileSync(new URL("../dashboard/app.js", import.meta.url), "utf8");

// 一个 /api/state accounts[] 元素的等价形状（含大部分被渲染字段）。
function acct(over = {}) {
  return {
    uid: "u1",
    nickname: "账号甲",
    masked: "已登录",
    domain: "workbuddy.cn",
    eligible: true,
    tasksEnabled: true,
    imported: false,
    expiresInDays: 30,
    expiresInMs: 30 * 86400000 - 12345, // 后端 = expires - now()，每轮都在变
    frozen: null,
    snapshot: {
      updatedISO: "2026-11-14T00:00:00Z",
      tasks: [
        { code: "T1", acceptStatus: "not_accepted" },
        { code: "T2", acceptStatus: "completed", progress: { current: 1, target: 1 } },
      ],
    },
    credits: { remain: 100, size: 500, updatedIso: "2026-11-14T00:00:00Z" },
    streak: null,
    campaign: null,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// F3 —— 内容指纹门控（行为断言）
// ─────────────────────────────────────────────────────────────────────────────

test("F3 行为：同一份账号内容 → 同一指纹（键顺序无关），供「内容未变不重建」门控", () => {
  const a = acct();
  // 另建一份：字段值相同、对象/键顺序不同 —— 指纹必须相等（否则每轮都会误判为「变了」而重建）。
  const b = acct();
  const reordered = {};
  for (const k of Object.keys(a).reverse()) reordered[k] = acct()[k];
  assert.equal(acctFingerprint(a), acctFingerprint(b), "相同内容必须同指纹");
  assert.equal(stableSig({ x: 1, y: 2 }), stableSig({ y: 2, x: 1 }), "stableSig 键序无关");
});

test("F3 行为：仅 volatile 的 expiresInMs 变化 → 指纹不变（轮询不会误触发重建）", () => {
  const a = acct({ expiresInMs: 30 * 86400000 - 1000 });
  const b = acct({ expiresInMs: 30 * 86400000 - 999999 }); // 后端每轮都重算
  assert.equal(acctFingerprint(a), acctFingerprint(b), "原始毫秒每轮都变，必须被排除在指纹外");
});

test("F3 行为：可见内容变化 → 指纹变化（该行才需要重建）", () => {
  const base = acct();
  const cases = {
    nickname: acct({ nickname: "账号乙" }),
    tasksEnabled: acct({ tasksEnabled: false }),
    eligible: acct({ eligible: false }),
    dailyBucket: acct({ expiresInMs: 2 * 3600000 }), // 跨过期桶（30 天 → 剩 2 小时）
    frozen: acct({ frozen: { at: "2026-11-14T00:00:00Z", code: 403, message: "风控" } }),
    credits: acct({ credits: { remain: 42, size: 500, updatedIso: "2026-11-14T01:00:00Z" } }),
    snapshot: acct({ snapshot: { updatedISO: "2026-11-14T00:00:00Z", tasks: [{ code: "T9" }] } }),
  };
  for (const [name, changed] of Object.entries(cases)) {
    assert.notEqual(acctFingerprint(base), acctFingerprint(changed), `字段 ${name} 变化必须改变指纹`);
  }
});

test("F3 行为：详情体指纹只随快照/活动/连登等详情输入变化（供详情体子树复用）", () => {
  const a = acct();
  // 与详情体无关的字段变了（credits）→ 详情体指纹不变，可整棵复用旧 DOM。
  assert.equal(taskBodyFingerprint(a), taskBodyFingerprint(acct({ credits: { remain: 1, size: 2 } })));
  // 详情体数据变了 → 指纹变。
  assert.notEqual(taskBodyFingerprint(a), taskBodyFingerprint(acct({ snapshot: { updatedISO: "x", tasks: [{ code: "Z" }] } })));
  assert.notEqual(taskBodyFingerprint(a), taskBodyFingerprint(acct({ streak: { days: 3 } })));
});

test("F3 结构：renderAccounts 改为按 uid keyed 增量（指纹门控 + insertBefore），不再整树 append", () => {
  assert.ok(SRC.includes("function reconcileAccountRows("), "存在 keyed 重绘函数");
  assert.ok(SRC.includes("__acctFp !== fp"), "按内容指纹决定是否重建该行");
  assert.ok(SRC.includes("box.insertBefore(row, ref)"), "仅按位置移动既有节点（复用 DOM）");
  assert.ok(!SRC.includes("for (const a of accounts) box.append(accountRow(a));"), "旧的整树重建已移除");
  // 详情体惰性构建 + 子树复用
  assert.ok(SRC.includes("dataset: { fp: bodyFp }"), "详情体带内容指纹");
  assert.ok(SRC.includes('if (body.dataset.built === "1") return;'), "详情体惰性构建（未建过才建）");
  assert.ok(SRC.includes("opts.body.dataset.fp === bodyFp"), "详情体指纹未变则整棵复用");
  // 焦点 / 滚动保留
  assert.ok(SRC.includes("function captureFocus(") && SRC.includes("function restoreFocus("), "重建前后恢复焦点");
  assert.ok(SRC.includes("function captureRowScroll(") && SRC.includes("function restoreRowScroll("), "重建前后恢复行内滚动");
});

// ─────────────────────────────────────────────────────────────────────────────
// F2 —— 日志增量计划（行为断言）+ 接线（结构断言）
// ─────────────────────────────────────────────────────────────────────────────

test("F2 行为：日志只增量 append 新行，绝不整段重建（日志增长场景）", () => {
  const CAP = 2000;
  // 从空开始追加 3 行：一次 append 3、不 reset。
  const p1 = logWindowPlan(0, 3, CAP);
  assert.equal(p1.reset, false);
  assert.equal(p1.appendFrom, 0);
  assert.equal(p1.appendCount, 3);
  assert.equal(p1.dropOldest, 0);
  // 再各来一条：每次只 append 1 行（增量），dropOldest 为 0。
  for (let total = 4; total <= 8; total++) {
    const p = logWindowPlan(total - 1, total, CAP);
    assert.equal(p.reset, false, "增长中不得整段重建");
    assert.equal(p.appendCount, 1, "只 append 新来的那一行");
    assert.equal(p.appendFrom, total - 1);
    assert.equal(p.dropOldest, 0);
  }
});

test("F2 行为：超过上限时环形裁剪（从头部裁最旧行），保留数=上限", () => {
  const CAP = 100;
  const p = logWindowPlan(100, 101, CAP); // 已满 100，又来 1 条
  assert.equal(p.appendCount, 1);
  assert.equal(p.dropOldest, 1, "超限即从头部裁 1 行");
  assert.equal(p.keep, CAP);
  // 一次突发补 5 条
  const burst = logWindowPlan(100, 105, CAP);
  assert.equal(burst.appendCount, 5);
  assert.equal(burst.dropOldest, 5);
  assert.equal(burst.keep, CAP);
});

test("F2 行为：来源收缩（后端给 job.log 加上限 / 换 job）→ reset 整段重建", () => {
  const p = logWindowPlan(50, 40, 2000);
  assert.equal(p.reset, true);
  assert.equal(p.appendCount, 0);
  assert.equal(p.keep, 40);
});

test("F2 行为：空日志 / 无新行 → 什么都不做（幂等）", () => {
  assert.deepEqual(logWindowPlan(0, 0, 100), { reset: false, appendFrom: 0, appendCount: 0, dropOldest: 0, keep: 0 });
  const same = logWindowPlan(7, 7, 100);
  assert.equal(same.reset, false);
  assert.equal(same.appendCount, 0);
});

test("F2 结构：renderJobLogs 走增量 append + 环形裁剪，旧的整段 replaceChildren 已移除", () => {
  assert.ok(SRC.includes("export function logWindowPlan("), "导出增量计划（纯函数）");
  assert.ok(SRC.includes("plan.appendCount > 0"), "仅在确有新行时 append");
  assert.ok(SRC.includes("pane.append(frag)"), "append 新行文本节点");
  assert.ok(SRC.includes("pane.removeChild(pane.firstChild)"), "环形裁剪最旧行");
  assert.ok(!SRC.includes("pane.replaceChildren(...lines.map("), "旧的「每次都重建全部日志行」已移除");
  assert.ok(SRC.includes("const LOG_MAX_LINES ="), "客户端保留行数有上限");
});

test("F2 结构：step 事件只 append 对应行；突发事件用 rAF 合并重渲染", () => {
  assert.ok(SRC.includes("function appendStepRow("), "步骤表增量 append");
  assert.ok(SRC.includes("table.tbl-steps tbody"), "定位到既有步骤表 tbody");
  assert.ok(SRC.includes("appendStepRow(evt.step)"), "SSE step 走增量 append");
  assert.ok(SRC.includes('scheduleRender("log")'), "SSE log 走合并调度（增量）");
  assert.ok(SRC.includes("function scheduleRender("), "存在 rAF 合并调度器");
  assert.ok(SRC.includes("state.renderRaf = raf("), "用（带守卫的）requestAnimationFrame 合并同帧重渲染");
});

// ─────────────────────────────────────────────────────────────────────────────
// P3-a —— uid → CSS 选择器转义（行为断言 + 结构断言）
// ─────────────────────────────────────────────────────────────────────────────

test("P3-a 行为：cssEscape 转义引号 / 方括号 / 反斜杠（Node 下走守卫兜底不抛错）", () => {
  assert.equal(typeof cssEscape, "function");
  const evil = 'a"b]c\\d';
  const out = cssEscape(evil);
  assert.equal(typeof out, "string");
  // 关键的引号与反斜杠必须被转义（否则 `[attr="..."]` 会被提前闭合 → querySelector 抛 SyntaxError）
  assert.ok(!/(?<!\\)"/.test(out), '未转义的 " 不得残留在选择器值里');
  assert.ok(out.includes('\\"'), '双引号被转义');
  assert.ok(out.includes("\\\\"), "反斜杠被转义");
  // 字母数字 / 下划线 / 连字符保持原样；点号按 CSSOM 规范（CSS.escape 同样会转义）转义。
  assert.equal(cssEscape("uid_1-2.3"), "uid_1-2\\.3");
  assert.equal(cssEscape(undefined), "");
  assert.equal(cssEscape(null), "");
});

test("P3-a 结构：五处按 uid 拼的属性选择器一律经 cssEscape，裸拼已消失", () => {
  for (const sel of ["data-acct", "data-credits-cell", "data-streak-cell", "data-heat-cell", "data-snap-refresh"]) {
    assert.ok(SRC.includes(`[${sel}="\${cssEscape(uid)}"]`), `${sel} 选择器经 cssEscape`);
    assert.ok(!SRC.includes(`[${sel}="\${uid}"]`), `${sel} 裸拼 uid 已移除`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// P3-b —— 日志滚动位置落 state 后恢复（结构断言；DOM 滚动无零依赖行为跑法）
// ─────────────────────────────────────────────────────────────────────────────

test("P3-b 结构：滚动位置记进 state，重建后按存值恢复；不再从「新建的空容器」读贴底", () => {
  assert.ok(SRC.includes("log: { jobId:") && SRC.includes("atBottom:"), "日志状态含贴底标志");
  assert.ok(SRC.includes("scrollTop: 0"), "日志状态含 scrollTop");
  assert.ok(SRC.includes("function captureLogScroll("), "重建前把滚动位置存进 state");
  assert.ok(SRC.includes("captureLogScroll();"), "renderJob 重建前调用");
  assert.ok(SRC.includes('let logPane = $("#jobLogPane")'), "复用既有日志面板节点（不每次换新空节点）");
  assert.ok(SRC.includes("function wireLogScroll("), "监听用户滚动即时回写 state");
  assert.ok(SRC.includes("if (st.atBottom) pane.scrollTop = pane.scrollHeight;"), "仅贴底时自动滚底");
  assert.ok(!SRC.includes("const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 30;"),
    "旧的「读新建空容器 scrollHeight」判定已移除");
  assert.ok(!SRC.includes('const logPane = el("div", { class: "logpane", id: "jobLogPane"'),
    "不再每次重建日志容器节点");
});

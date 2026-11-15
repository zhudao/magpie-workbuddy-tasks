// tests/dashboard-gap-floor.test.mjs —— 看板「上游调用间隔」下限与后端红线对齐的结构断言
//（零依赖、零网络、纯源码结构校验）。
//
// 背景：`settings.gapMs` 管的是「任意两次上游调用之间的最小间隔」这条风控红线。后端已把读侧
// 一律收敛为 `upstreamGapMs() = max(MIN_UPSTREAM_GAP_MS, 值 || 默认)`，且 MIN_UPSTREAM_GAP_MS
// 从 500 提到 1000（daemon 的 `/api/settings` 写入下限同值）。但看板输入框当时还是
// `min="500"`、标签还叫「账号间隔」（历史口径），用户能填 500 并被后端静默抬到 1000 ——
// 面板显示的值和真正生效的值对不上。
//
// 本用例把「面板不许落后于后端」钉进测试，专抓这类前后端口径漂移：
//   1. `#gapMs` 输入框的 `min` 必须等于后端导出的 MIN_UPSTREAM_GAP_MS（当前 1000）——
//      后端把红线再往上抬时，这里会先红，而不是等用户填了被静默改写才发现；
//   2. 该输入框不得是旧下限 `min="500"`；
//   3. 同页不得再把这个字段称作「账号间隔」（历史口径；它现在管的是上游调用间距，
//      账号与账号之间的节奏是另一套参数 accountGapMs，与此字段无关）；
//   4. 标签 / aria-label 用准确表述，提示文字不再残留「500–10000」，且仍保留
//      「风控红线 / 不可低于 1 秒」的语义。
//
// 判定方式：源码结构断言（参考 tests/dashboard-css.test.mjs / release-consistency.test.mjs）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { MIN_UPSTREAM_GAP_MS } from "../engine/constants.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

const HTML = read("dashboard/index.html");
const APP = read("dashboard/app.js");

// 取出 #gapMs 那个 <input> 标签（跨行，故用 [^>]* 吞掉换行；标签内无内部 ">"）。
function gapInputTag(src) {
  const m = src.match(/<input\b[^>]*\bid="gapMs"[^>]*>/);
  return m ? m[0] : "";
}

// 先钉死「后端红线下限」这个前提本身，免得后端哪天真被改动了却没人知道。
test("前提：后端红线下限 MIN_UPSTREAM_GAP_MS = 1000（本条掉了说明后端语义变了，看板需重新对齐）", () => {
  assert.equal(MIN_UPSTREAM_GAP_MS, 1000, "后端 MIN_UPSTREAM_GAP_MS 不再是 1000，看板与之的口径需要重新核对");
});

test("#gapMs 输入框存在", () => {
  assert.ok(gapInputTag(HTML), "dashboard/index.html 里找不到 #gapMs 输入框");
});

test("#gapMs 的 min 等于后端红线下限（1000），不是旧值 500 —— 后端抬高下限时这里先红", () => {
  const tag = gapInputTag(HTML);
  const min = (tag.match(/\bmin="([^"]*)"/) || [])[1];
  assert.equal(min, "1000", `#gapMs 的 min 应为 1000，实际 ${JSON.stringify(min)}`);
  // 与后端导出的常量对齐：后端挪红线，这条立刻爆，无需手动同步字符串。
  assert.equal(
    min,
    String(MIN_UPSTREAM_GAP_MS),
    `面板 #gapMs 的 min=${min} 与后端 MIN_UPSTREAM_GAP_MS=${MIN_UPSTREAM_GAP_MS} 漂移了`,
  );
  assert.ok(!/\bmin="500"/.test(tag), "#gapMs 不得再是旧下限 min=500（会被后端静默抬到 1000）");
});

test("同页不再把这个字段称作「账号间隔」（历史口径已废弃）", () => {
  assert.ok(
    !HTML.includes("账号间隔"),
    "dashboard/index.html 仍在用「账号间隔」称呼这个字段；它管的是上游调用间距，注意别和 accountGapMs 的账号节奏混淆",
  );
});

test("app.js 的 #gapMs 回填与后端 upstreamGapMs() 逐字同口径：兜底也是下限 1000，不是 1500", () => {
  // app.js 是浏览器 ESM（零依赖、不 import 后端），只能按值镜像红线下限常量。
  const mirror = (APP.match(/const\s+MIN_UPSTREAM_GAP_MS\s*=\s*(\d+)/) || [])[1];
  assert.equal(mirror, "1000", "app.js 应定义 MIN_UPSTREAM_GAP_MS 常量以镜像后端红线下限");
  assert.equal(
    mirror,
    String(MIN_UPSTREAM_GAP_MS),
    `app.js 镜像的红线下限 ${mirror} 与后端 MIN_UPSTREAM_GAP_MS=${MIN_UPSTREAM_GAP_MS} 漂移`,
  );
  // 回填语句必须逐字对应 daemon 的 max(MIN, Number(gapMs) || DEFAULT_GAP_MS)，
  // 而 DEFAULT_GAP_MS 也是 1000 —— 两侧兜底都必须是下限本身。
  const line = (APP.match(/setVal\(\s*\$\("#gapMs"\)\s*,[^\n]*\)/) || [])[0] || "";
  assert.ok(line, "找不到 #gapMs 的回填语句");
  assert.match(
    line,
    /Math\.max\(\s*MIN_UPSTREAM_GAP_MS\s*,\s*Number\(settings\.gapMs\)\s*\|\|\s*MIN_UPSTREAM_GAP_MS\s*\)/,
    "#gapMs 回填应为 max(MIN_UPSTREAM_GAP_MS, Number(settings.gapMs) || MIN_UPSTREAM_GAP_MS)",
  );
  // 曾一度误把 1500（DEFAULT_SETTINGS.gapMs / accountGapMs 的账号节奏）当兜底；
  // 这里钉死：app.js 任何地方都不得用 `|| 1500` 作 gapMs 兜底。
  assert.ok(
    !/\|\|\s*1500/.test(APP),
    "app.js 不得用 `|| 1500` 作 gapMs 兜底（1500 是 DEFAULT_SETTINGS.gapMs / 账号节奏，与红线下限无关）",
  );
});

test("标签 / aria-label 用准确表述，提示文字下限已改为 1000 且保留红线语义", () => {
  const tag = gapInputTag(HTML);
  // 字段标签（分组小标题同源表述，避免两处不一致）
  assert.ok(HTML.includes('class="field-label">上游调用间隔'), "字段标签应为「上游调用间隔」");
  assert.ok(HTML.includes(">领奖模式 · 上游调用间隔 · 上游主机<"), "分组小标题应同步改为「上游调用间隔」");
  // aria-label 不能漏改
  assert.ok(tag.includes('aria-label="上游调用间隔毫秒"'), "#gapMs 的 aria-label 应为「上游调用间隔毫秒」");
  // 提示文字：不再残留旧区间，且仍写明红线
  assert.ok(!HTML.includes("500–10000"), "提示文字仍残留旧下限「500–10000」");
  assert.ok(HTML.includes("1000–10000"), "提示文字应写明新区间「1000–10000」");
  assert.ok(/风控红线/.test(HTML), "提示文字应保留「风控红线」语义");
  assert.ok(/不可低于 1 秒|至少间隔 1 秒/.test(HTML), "提示文字应保留「不可低于 1 秒」的约束语义");
});

// tests/dashboard-css.test.mjs —— 看板样式表的结构校验（零网络、零依赖）。
//
// 为什么要它：2026-11-11 一次改动在 `.row-note` 前多写了一个引号（`".row-note {`），
// 浏览器 CSS 解析器从那里开始把后续若干规则一起吞掉 —— 页面不报错、控制台干净，
// 只有「某些样式莫名不生效」（`.row-desc` 的 max-width/-webkit-line-clamp 全没上）。
// 这类故障靠肉眼看截图极难定位，所以在测试里钉住最便宜的三条结构性事实：
//   1. 花括号与注释必须配平（不配平 = 整段被吞）；
//   2. 顶层选择器不得以引号/BOM 等非法字符开头（就是这次那个多余引号）；
//   3. 关键选择器确实存在（.row-note / .row-desc / .heat-grid / .streak-run…），
//      免得「规则被吞」时只剩没人发现的静默失效。
//
// 扫描器是手写的极简版：只认注释与引号，足够抓结构性破坏；不做完整 CSS 解析
//（那需要第三方依赖，本项目零依赖是硬约束）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, "..", rel), "utf8");

const CSS_FILES = ["dashboard/style.css", "page/style.css"];

// 剥注释（保留换行，便于报行号）
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

// 顶层选择器：深度 0 处紧跟 `}` 或文件开头到 `{` 之间的文本。
// 只做「哪些字符能当选择器开头」的粗判，不做语法分析。
function topLevelSelectors(src) {
  const s = stripComments(src);
  const out = [];
  let depth = 0;
  let buf = "";
  let line = 1;
  let bufLine = 1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\n") line++;
    if (ch === "{") {
      if (depth === 0) out.push({ text: buf.trim(), line: bufLine });
      depth++;
      buf = "";
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      buf = "";
      continue;
    }
    if (depth === 0) {
      if (!buf) bufLine = line;
      buf += ch;
    }
  }
  return out.filter((x) => x.text);
}

test("看板 CSS：花括号与注释配平（不配平 = 后面整段被浏览器吞掉）", () => {
  for (const f of CSS_FILES) {
    const src = read(f);
    assert.equal(
      (src.match(/\{/g) || []).length,
      (src.match(/\}/g) || []).length,
      `${f} 花括号不配平`,
    );
    assert.equal(
      (src.match(/\/\*/g) || []).length,
      (src.match(/\*\//g) || []).length,
      `${f} 注释不配平（未闭合的 /* 会吃掉后面所有规则）`,
    );
  }
});

test("看板 CSS：顶层选择器不得以引号 / BOM / 分号开头（多余引号会把后续规则一起吞掉）", () => {
  for (const f of CSS_FILES) {
    for (const sel of topLevelSelectors(read(f))) {
      assert.ok(
        !/^["'`\uFEFF;,]/.test(sel.text),
        `${f}:${sel.line} 顶层选择器以非法字符开头：${JSON.stringify(sel.text.slice(0, 40))}`,
      );
      // `".row-note {` 这种「引号 + 选择器」也要挡：引号出现在选择器里本身就非法
      assert.ok(
        !/^[.#a-zA-Z*\[:>\s]*"/.test(sel.text),
        `${f}:${sel.line} 选择器里混进了引号：${JSON.stringify(sel.text.slice(0, 60))}`,
      );
    }
  }
});

test("看板 CSS：关键选择器都在（规则被吞时这里会红）", () => {
  const css = stripComments(read("dashboard/style.css"));
  const needed = [
    ".row-note", // 任务行说明（锁定 / 不可自动化原因）
    ".row-desc", // 上游原文说明（0.3.3）
    ".cell-badges",
    ".pin-id",
    ".acct-streak", // 连登条（0.3.3）
    ".heat-grid", // 连登日历网格（0.3.3）
    ".frozen-note", // 冻结总览（0.3.3）
    ".streak-run",
  ];
  for (const sel of needed) {
    assert.ok(css.includes(sel), `dashboard/style.css 缺少 ${sel} 规则（可能被语法错误吞了）`);
  }
});

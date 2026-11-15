// tests/store-refresh-race.test.mjs —— B3 回归：saveAccountRefresh 写前竞态复查。
//
// 缺陷：refresh 回写是裸 read-modify-write（无 hash/mtime 复查），写者至少三类
//（daemon 的 runner 刷新、magpie 宿主自身覆写、daemon 导入确认）。交错时序
//「A 读 → B 写（含轮换后的新 refresh）→ A 整文档写回」会丢 B 的新 refresh
// token → refresh 轮换型上游直接导致该账号掉登录。
//
// 修法：写前重读比对（与 daemon.mjs handleAccountsImport 导入确认路径的写前
// 竞态复查同口径：对文件原文取 SHA-256；不符 → 重读重试一轮；仍不符 → 放弃
// 写入并抛 WB_AUTH_WRITE_CONFLICT，冲突经 onConflict 显式上报）。
//
// 测法说明（如实）：**行为断言**，落在真实临时目录文件上 —— 通过 store 提供的
// 测试注入缝 opts.interpose 在「读完快照」与「写前复查」的间隙模拟第三方改写
// 文件（生产代码不传该参数，行为与无缝一致）。进程内同步函数无法从外部真正
// 并发插写，这个注入缝是能做到的最强确定性形式；文件本身是沙箱里的真实文件，
// 断言全部落在落盘内容与回调台账上。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";

import { authFile, saveAccountRefresh } from "../engine/store.mjs";
import { cleanupAllSandboxes, makeSandbox } from "./helpers.mjs";

after(() => {
  cleanupAllSandboxes();
});

function seed(cfg, doc) {
  writeFileSync(authFile(cfg), JSON.stringify(doc, null, 2) + "\n");
}

function readDoc(cfg) {
  return JSON.parse(readFileSync(authFile(cfg), "utf8"));
}

// 基线文档：两个 workbuddy 账号（A 是刷新目标，B 是被 magpie 宿主轮换的兄弟）
function seedDoc() {
  return {
    workbuddy: { type: "oauth", access: "at-1", refresh: "rt-1", uid: "uid-1", accountId: "A" },
    "workbuddy#2": { type: "oauth", access: "at-2", refresh: "rt-2-OLD", uid: "uid-2", accountId: "B" },
  };
}

test("B3：读之后、写之前第三方改写文件 → 重读重试后合并写回，第三方的轮换 refresh 与未知字段不丢，冲突显式上报", () => {
  const box = makeSandbox("wb-refresh-race-");
  const cfg = box.dir;
  try {
    seed(cfg, seedDoc());
    const conflicts = [];
    let interposed = 0;
    saveAccountRefresh(cfg, "workbuddy", { access: "at-1-NEW", refresh: "rt-1-NEW" }, {
      onConflict: (info) => conflicts.push(info),
      // 注入缝：只在第一轮「读-复查」间隙插一脚（模拟 magpie 宿主整体覆写：
      // 轮换兄弟账号的 refresh + 带来未知字段）。第二轮不再插 → 复查应通过，
      // 且合并底稿必须是重读后的新文档。
      interpose: (attempt) => {
        if (attempt !== 1) return;
        interposed++;
        const cur = readDoc(cfg);
        cur["workbuddy#2"].refresh = "rt-2-ROTATED";
        cur.workbuddy.unknownThirdPartyField = "magpie 写的";
        writeFileSync(authFile(cfg), JSON.stringify(cur, null, 2) + "\n");
      },
    });

    // 注入与上报都恰好发生一次（一轮冲突 → 重读重试成功）
    assert.equal(interposed, 1);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].attempt, 1);
    assert.equal(conflicts[0].stage, "retry");
    assert.equal(conflicts[0].acctKey, "workbuddy");

    const raw = readDoc(cfg);
    // (a) 我们的 patch 落地……
    assert.equal(raw.workbuddy.access, "at-1-NEW");
    assert.equal(raw.workbuddy.refresh, "rt-1-NEW");
    // ……且基于重读后的新文档合并：第三方刚轮换的 refresh token 原样保留
    assert.equal(raw["workbuddy#2"].refresh, "rt-2-ROTATED", "第三方的轮换 refresh 绝不能被旧快照覆盖");
    assert.equal(raw["workbuddy#2"].access, "at-2");
    // 第三方整体覆写带来的未知字段也保留（旧快照里没有它 —— 写回必须以新文档为准）
    assert.equal(raw.workbuddy.unknownThirdPartyField, "magpie 写的");
    // 非 token 字段纪律不变
    assert.equal(raw.workbuddy.accountId, "A");
    assert.equal(raw.workbuddy.uid, "uid-1");
  } finally {
    box.cleanup();
  }
});

test("B3：连续两轮都撞上并发写 → 放弃写入（抛 WB_AUTH_WRITE_CONFLICT），文件保持第三方最后一次的版本，冲突逐轮上报", () => {
  const box = makeSandbox("wb-refresh-race-giveup-");
  const cfg = box.dir;
  try {
    seed(cfg, seedDoc());
    const conflicts = [];
    let n = 0;
    assert.throws(
      () =>
        saveAccountRefresh(cfg, "workbuddy", { access: "at-1-NEW", refresh: "rt-1-NEW" }, {
          onConflict: (info) => conflicts.push(info),
          // 每一轮的读-复查间隙都有第三方在写（模拟持续交错的写者）→ 两轮复查都不符
          interpose: () => {
            n++;
            const cur = readDoc(cfg);
            cur["workbuddy#2"].refresh = `rt-2-ROTATED-${n}`;
            writeFileSync(authFile(cfg), JSON.stringify(cur, null, 2) + "\n");
          },
        }),
      (e) => e.code === "WB_AUTH_WRITE_CONFLICT" && /放弃本次回写/.test(e.message),
    );

    // 恰好两轮（一轮重试机会），每轮冲突都上报：retry → giveup
    assert.equal(n, 2);
    assert.deepEqual(conflicts.map((c) => c.stage), ["retry", "giveup"]);
    assert.deepEqual(conflicts.map((c) => c.attempt), [1, 2]);

    // (a) 第三方的最后一次写完好无损，我们的 patch 没有落盘（宁可少一次回写，
    //     也不能用旧快照整文档覆盖别人的新凭据）
    const raw = readDoc(cfg);
    assert.equal(raw["workbuddy#2"].refresh, "rt-2-ROTATED-2");
    assert.equal(raw.workbuddy.refresh, "rt-1");
    assert.equal(raw.workbuddy.access, "at-1");
  } finally {
    box.cleanup();
  }
});

test("B3：无并发时行为与旧版完全一致（正常合并写回；兄弟条目与非 token 字段原样保留）", () => {
  const box = makeSandbox("wb-refresh-race-plain-");
  const cfg = box.dir;
  try {
    seed(cfg, seedDoc());
    saveAccountRefresh(cfg, "workbuddy", { access: "at-1-NEW", expires: 999999 });
    const raw = readDoc(cfg);
    assert.equal(raw.workbuddy.access, "at-1-NEW");
    assert.equal(raw.workbuddy.expires, 999999);
    assert.equal(raw.workbuddy.refresh, "rt-1", "patch 里没给的字段不碰");
    assert.equal(raw["workbuddy#2"].refresh, "rt-2-OLD", "兄弟条目原样保留");
  } finally {
    box.cleanup();
  }
});

test("B3：写前发现文件已变成坏 JSON → 照旧拒绝回写（复查读与首读同一口径，绝不覆盖坏文件）", () => {
  const box = makeSandbox("wb-refresh-race-badjson-");
  const cfg = box.dir;
  try {
    seed(cfg, seedDoc());
    saveAccountRefresh(cfg, "workbuddy", { access: "at-x" }); // 先正常写一次，确认管线通
    writeFileSync(authFile(cfg), "{broken-by-third-party");
    assert.throws(() => saveAccountRefresh(cfg, "workbuddy", { access: "at-y" }), /拒绝回写/);
    assert.equal(readFileSync(authFile(cfg), "utf8"), "{broken-by-third-party", "坏文件绝不被覆写");
  } finally {
    box.cleanup();
  }
});

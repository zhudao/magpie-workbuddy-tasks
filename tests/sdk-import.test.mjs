// tests/sdk-import.test.mjs —— 插件宿主 SDK（@opencode-ai/plugin）加载守卫的回归。
//
// 为什么要有它：2026-11-12 线上出现过 magpie 报「the plugin's load didn't finish in 20s」——
// 本地文件夹安装时宿主没在磁盘上提供这个包，Bun 对缺失裸导入会尝试联网自动安装，走代理
// 时卡满 20s 预算，整张插件卡报错。修法是把 import 包进硬超时（index.mjs 的
// importPluginSdk）。这里用注入的 importer 零网络地钉住四条不变量：
//   ① 一直不 resolve 的导入 → 在超时附近返回 {ok:false}（绝不挂住加载）；
//   ② 抛错的导入 → {ok:false} 且带上原因（不向外抛）；
//   ③ 正常拿到 → {ok:true, mod} 原样带回；
//   ④ 超时后那条 import 若再失败，必须被它自己 catch 掉 —— 不能变成 unhandledRejection
//      （否则 Node 会炸进程，等于换一种方式把插件搞挂）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { importPluginSdk, SDK_IMPORT_TIMEOUT_MS } from "../index.mjs";

test("SDK 守卫：超时上限是 6s，且默认值对外可见（给容器里 20s 预算留足余量）", () => {
  assert.equal(SDK_IMPORT_TIMEOUT_MS, 6000);
  assert.ok(SDK_IMPORT_TIMEOUT_MS <= 8000, "必须明显小于 magpie 的 20s 加载预算");
});

test("SDK 守卫：导入一直不返回 → 到时就返回 ok:false（不阻塞插件加载）", async () => {
  const t0 = Date.now();
  const r = await importPluginSdk({ timeoutMs: 60, importer: () => new Promise(() => {}) });
  const dt = Date.now() - t0;
  assert.equal(r.ok, false, "超时必须是 ok:false");
  assert.match(r.why, /超过 60ms/);
  assert.match(r.why, /跳过工具注册/);
  assert.ok(dt >= 50 && dt < 1500, `应在超时附近返回，实测 ${dt}ms`);
});

test("SDK 守卫：导入抛错（如 Cannot find package）→ ok:false 且带原因，不向外抛", async () => {
  const r = await importPluginSdk({
    timeoutMs: 500,
    importer: async () => {
      throw new Error("Cannot find package '@opencode-ai/plugin'");
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.why, /加载 @opencode-ai\/plugin 失败/);
  assert.match(r.why, /Cannot find package/);
});

test("SDK 守卫：正常拿到模块 → ok:true 且 mod 原样带回", async () => {
  const fake = { tool: () => ({}) };
  const r = await importPluginSdk({ timeoutMs: 500, importer: async () => fake });
  assert.equal(r.ok, true);
  assert.equal(r.mod, fake);
});

test("SDK 守卫：超时后那条导入再失败 → 不产生 unhandledRejection", async () => {
  const seen = [];
  const onUnhandled = (e) => seen.push(String(e?.message ?? e));
  process.on("unhandledRejection", onUnhandled);
  let rejectLater = () => {};
  const importer = () => new Promise((_res, rej) => { rejectLater = rej; });
  try {
    const r = await importPluginSdk({ timeoutMs: 30, importer });
    assert.equal(r.ok, false);
    rejectLater(new Error("后台那条 import 迟到的失败"));
    await new Promise((res) => setTimeout(res, 60));
    assert.deepEqual(seen, [], "后台失败必须被自己 catch 掉，不能冒泡成 unhandledRejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  billBase,
  callJSON,
  growthBase,
  makeCtx,
  refreshAccount,
  webBase,
} from "../engine/upstream.mjs";
import { fakeClock, makeAcct } from "./helpers.mjs";
import { REFRESH_PATH } from "../engine/constants.mjs";

const RESP = (status, body) => ({ status, text: async () => JSON.stringify(body) });

test("信封：code===0 成功，data 原样带回", async () => {
  const calls = [];
  const res = await callJSON(makeAcct(), "chat", "https://copilot.tencent.com/x", {}, {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return RESP(200, { code: 0, msg: "ok", data: { value: 7 } });
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.code, 0);
  assert.deepEqual(res.data, { value: 7 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers["X-Domain"], "copilot.tencent.com");
});

test("信封：HTTP 200 但 code!==0 → 失败，不重试", async () => {
  let n = 0;
  const res = await callJSON(makeAcct(), "chat", "https://copilot.tencent.com/x", {}, {
    fetch: async () => {
      n += 1;
      return RESP(200, { code: 1234, msg: "task not completed" });
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 1234);
  assert.equal(res.msg, "task not completed");
  assert.equal(n, 1);
});

test("HTTP 403（body code 11140）→ restricted，绝不重试", async () => {
  let n = 0;
  const res = await callJSON(makeAcct(), "chat", "https://copilot.tencent.com/x", {}, {
    fetch: async () => {
      n += 1;
      return RESP(403, { code: 11140, msg: "request illegal" });
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.restricted, true);
  assert.equal(res.code, 11140);
  assert.equal(n, 1);
});

test("信封 code 11140（哪怕 200）→ restricted", async () => {
  const res = await callJSON(makeAcct(), "chat", "https://copilot.tencent.com/x", {}, {
    fetch: async () => RESP(200, { code: 11140, msg: "request illegal", data: null }),
  });
  assert.equal(res.restricted, true);
});

test("网络错误：线性退避重试 3 次（1s、2s），全部失败后报网络错误", async () => {
  const clock = fakeClock(1_700_000_000_000);
  const sleeps = [];
  let n = 0;
  const res = await callJSON(makeAcct(), "billing", "https://www.codebuddy.cn/billing/meter/x", { method: "POST" }, {
    now: clock.now,
    sleep: async (ms) => {
      sleeps.push(ms);
      await clock.sleep(ms);
    },
    fetch: async () => {
      n += 1;
      throw new Error("ECONNRESET: socket hang up");
    },
  });
  assert.equal(res.ok, false);
  assert.match(res.msg, /网络错误/);
  assert.equal(n, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test("5xx：重试后成功", async () => {
  const clock = fakeClock(1_700_000_000_000);
  let n = 0;
  const res = await callJSON(makeAcct(), "chat", "https://copilot.tencent.com/x", {}, {
    now: clock.now,
    sleep: clock.sleep,
    fetch: async () => {
      n += 1;
      return n < 3 ? RESP(502, { code: -1, msg: "bad gateway" }) : RESP(200, { code: 0, data: { done: 1 } });
    },
  });
  assert.equal(res.ok, true);
  assert.equal(n, 3);
});

test("chat 主机失联 → 回退 www.workbuddy.cn，X-Domain 不变", async () => {
  const clock = fakeClock(1_700_000_000_000);
  const calls = [];
  const res = await callJSON(makeAcct({ domain: "copilot.tencent.com" }), "chat", "https://copilot.tencent.com/v2/activity/growth/tasks", { method: "GET" }, {
    now: clock.now,
    sleep: clock.sleep,
    fetch: async (url) => {
      calls.push(new URL(url).host);
      if (new URL(url).host === "copilot.tencent.com") throw new Error("TLS reset");
      return RESP(200, { code: 0, data: { tasks: [] } });
    },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [
    "copilot.tencent.com", "copilot.tencent.com", "copilot.tencent.com",
    "www.workbuddy.cn",
  ]);
  // 走到回退主机时，X-Domain 仍是账号登录时的 domain（只换往哪发）
  assert.equal(res.data.tasks.length, 0);
});

test("非 chat 身份不回退主机", async () => {
  const clock = fakeClock(1_700_000_000_000);
  const hosts = [];
  await callJSON(makeAcct(), "billing", "https://www.codebuddy.cn/x", {}, {
    now: clock.now,
    sleep: clock.sleep,
    fetch: async (url) => {
      hosts.push(new URL(url).host);
      throw new Error("boom");
    },
  });
  assert.deepEqual(hosts, ["www.codebuddy.cn", "www.codebuddy.cn", "www.codebuddy.cn"]);
});

test("kind 决定头族：billing 带 X-Machine-ID，web 带 x-client-platform", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ host: new URL(url).host, headers: init.headers });
    return RESP(200, { code: 0, data: {} });
  };
  await callJSON(makeAcct(), "billing", "https://www.codebuddy.cn/x", {}, { fetch: fetchImpl });
  await callJSON(makeAcct(), "web", "https://www.workbuddy.cn/x", {}, { fetch: fetchImpl });
  assert.ok(seen[0].headers["X-Machine-ID"]);
  assert.equal(seen[1].headers["x-client-platform"], "web");
});

test("非 JSON 主体 → ok:false / invalid JSON response", async () => {
  const res = await callJSON(makeAcct(), "chat", "https://copilot.tencent.com/x", {}, {
    fetch: async () => ({ status: 200, text: async () => "<html>gateway</html>" }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.msg, "invalid JSON response");
});

test("base 覆盖：opts.base / opts.bases / 环境变量", () => {
  assert.equal(growthBase(), "https://copilot.tencent.com");
  assert.equal(growthBase({ WB_GROWTH_BASE: "https://alt.example" }), "https://alt.example");
  assert.equal(growthBase({ WB_CN_CHAT_UPSTREAM: "https://alt2.example/" }), "https://alt2.example");
  assert.equal(growthBase({ WB_CN_CHAT_UPSTREAM: "not-a-url" }), "https://copilot.tencent.com");
  assert.equal(billBase(), "https://www.codebuddy.cn");
  assert.equal(webBase(), "https://www.workbuddy.cn");
});

test("makeCtx：breathe 保证自上次 breathe 至少间隔 ms（假时钟可断言）", async () => {
  const clock = fakeClock(1_700_000_000_000);
  const ctx = makeCtx({ now: clock.now, sleep: clock.sleep, gap: 1000 });
  await ctx.breathe(); // 首 breathe 不空等
  assert.equal(clock.time, 1_700_000_000_000);
  await ctx.breathe(1000); // 距上次 breathe 0ms → 等满 1000
  assert.equal(clock.time, 1_700_000_000_000 + 1000);
  // 上游调用本身不耗时（假时钟）：再一次 breathe 仍要再等满 1000
  await ctx.breathe(1000);
  assert.equal(clock.time, 1_700_000_000_000 + 2000);
  // 时钟先走了 600ms → 只补差 400ms
  clock.advance(600);
  await ctx.breathe(1000);
  assert.equal(clock.time, 1_700_000_000_000 + 3000);
  await ctx.breathe(2500);
  assert.equal(clock.time, 1_700_000_000_000 + 5500);
});

test("refreshAccount：POST {chat} + REFRESH_PATH（断言用常量，不抄字面值），头族与嵌套 data.data 都对", async () => {
  const calls = [];
  const res = await refreshAccount(makeAcct({ refresh: "rt-old" }), {
    now: () => 1_700_000_000_000,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return RESP(200, {
        code: 0,
        data: { data: { accessToken: "at-new", refreshToken: "rt-new", expiresIn: 3600, refreshExpiresIn: 86400 } },
      });
    },
  });
  assert.equal(res.ok, true);
  assert.equal(res.patch.access, "at-new");
  assert.equal(res.patch.refresh, "rt-new");
  assert.equal(res.patch.expires, 1_700_000_000_000 + 3600 * 1000);
  assert.equal(res.patch.refreshExpiresAt, 1_700_000_000_000 + 86400 * 1000);
  const call = calls[0];
  assert.ok(call.url.endsWith(REFRESH_PATH), call.url);
  assert.equal(new URL(call.url).host, "copilot.tencent.com");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers["X-Refresh-Token"], "rt-old");
  assert.equal(call.init.headers["X-Auth-Refresh-Source"], "workbuddy");
  assert.equal(call.init.headers["X-Domain"], "copilot.tencent.com");
});

test("refreshAccount：无 refreshToken / 无 accessToken 时如实失败", async () => {
  const noRefresh = await refreshAccount(makeAcct({ refresh: "" }), { fetch: async () => { throw new Error("should not be called"); } });
  assert.equal(noRefresh.ok, false);
  const bad = await refreshAccount(makeAcct({ refresh: "rt" }), {
    fetch: async () => RESP(200, { code: 12153, msg: "refresh token failed" }),
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /refresh token failed/);
});

// ---- init.replaceHeaders（CONTRACT §11.1）：头族替换通道的凭据红线 ------------------
// 运营活动的 MP 事件上报要「不带桌面身分」的最小头族，mergeInitHeaders 只能覆盖、
// 删不掉 base 里的桌面 UA/X-Domain 一族，所以引擎开了一条 replaceHeaders 通道。
// 通道本身是**凭据边界**：Authorization 只能由引擎注入 —— 调用方无论怎么写
// （大小写、空串、别的 token）都必须被剥掉换成 acct.access，且绝不能漏发。
test("replaceHeaders：init.headers 原样成为整个头族（不再合并 kind 头族，桌面身分被去掉）", async () => {
  const acct = makeAcct();
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return RESP(200, { code: 0, data: {} });
  };
  await callJSON(
    acct,
    "chat",
    "https://copilot.tencent.com/v2/report",
    { method: "POST", body: "{}", replaceHeaders: true, headers: { "X-Client-Platform": "mp-weixin", "X-Test": "1" } },
    { fetch: f },
  );
  const h = calls[0].init.headers;
  assert.equal(h["X-Client-Platform"], "mp-weixin", "替换集合里的头原样在");
  assert.equal(h["X-Test"], "1");
  assert.equal(h["X-Domain"], undefined, "替换集合里没有的头不得从 chat 头族漏进来");
  assert.equal(h["X-IDE-Version"], undefined, "桌面身分整族都不该出现");
  assert.equal(h.Authorization, "Bearer " + acct.access, "凭据头由引擎注入");
});

test("replaceHeaders：调用方写的 Authorization（任意大小写）一律被剥掉、换成引擎的 access", async () => {
  const acct = makeAcct();
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return RESP(200, { code: 0, data: {} });
  };
  await callJSON(
    acct,
    "chat",
    "https://copilot.tencent.com/v2/report",
    {
      method: "POST",
      body: "{}",
      replaceHeaders: true,
      headers: { authorization: "Bearer EVIL", Authorization: "Bearer EVIL2", AUTHORIZATION: "Bearer EVIL3", "X-Keep": "yes" },
    },
    { fetch: f },
  );
  const h = calls[0].init.headers;
  const authKeys = Object.keys(h).filter((k) => k.toLowerCase() === "authorization");
  assert.deepEqual(authKeys, ["Authorization"], "凭据头只能有一个，且是引擎注入的那个键名");
  assert.equal(h.Authorization, "Bearer " + acct.access);
  assert.ok(!JSON.stringify(h).includes("EVIL"), "任何外部写法的凭据值都不得进入请求头");
  assert.equal(h["X-Keep"], "yes", "非凭据头照常保留");
});

// tests/taskkind.test.mjs —— 任务 → kind 解析层（P0-1）的单元与 fetchTasks 集成回归。
//
// 真实环境事实（2026-10-31 容器内只读实测，两账号一致）：
//   - 上游每账号返回 19 项任务，其中 4 个 expert_use_* 曾不在 TASK_SPECS、靠
//     jump_url 派生专家 id；0.3.3 起这 4 个已逐字收录进 TASK_SPECS（CONTRACT
//     §10.6，expert 钉死真实 id）—— jump_url 派生只剩「未来未收录任务」的兜底；
//     真实形态 reward 50 积分 + 5 能量，jump_url 是 URL 编码的 deeplink，expertId
//     以 %3D 出现；
//   - WorkBuddy_Valorant / Expert_lighthouse 的 jump_url 只有 workbuddy://expert
//     （不含 expertId）→ 钉死常量仍是唯一来源；
//   - not_accepted 任务的 progress 是 null。
// 全程零真实网络（wbBackend 假后端）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveExpertIdFromJumpUrl, expertNameFromTitle, resolveTaskKind } from "../engine/taskkind.mjs";
import { MP_TASK_SPECS } from "../engine/miniprogram.mjs";
import { fetchTasks } from "../engine/tasks.mjs";
import { fakeClock, localTime, makeAcct, task, wbBackend } from "./helpers.mjs";

// 真实 expert_use_* 的 jump_url 形态（URL 编码的 deeplink 查询串）。
const jumpOf = (id) =>
  `https://www.workbuddy.cn/work/launch/?deeplink=workbuddy%3A%2F%2Fexperts%3FexpertId%3D${id}&buddy_type=workbuddy`;

test("deriveExpertIdFromJumpUrl：URL 编码的 deeplink 里解出真实专家 id", () => {
  assert.equal(deriveExpertIdFromJumpUrl(jumpOf("ex_GDl31WahyIH0")), "ex_GDl31WahyIH0");
  assert.equal(deriveExpertIdFromJumpUrl(jumpOf("ex_FbY5nlWTqDod")), "ex_FbY5nlWTqDod");
  assert.equal(deriveExpertIdFromJumpUrl(jumpOf("ex_Weo3x2EZuSDm")), "ex_Weo3x2EZuSDm");
  assert.equal(deriveExpertIdFromJumpUrl(jumpOf("ex_WZY136wV5aMt")), "ex_WZY136wV5aMt");
  // 未编码的裸 deeplink 也认
  assert.equal(deriveExpertIdFromJumpUrl("workbuddy://experts?expertId=ex_ABCdef123"), "ex_ABCdef123");
  // 双重编码：解到不再变化为止
  assert.equal(
    deriveExpertIdFromJumpUrl(encodeURIComponent(jumpOf("ex_DoubleEnc0d"))),
    "ex_DoubleEnc0d",
  );
  // 尾随参数截断正确
  assert.equal(deriveExpertIdFromJumpUrl("workbuddy://experts?expertId=ex_X1&buddy_type=workbuddy"), "ex_X1");
});

test("deriveExpertIdFromJumpUrl：解不出的一律空串（宁可少接不错接）", () => {
  assert.equal(deriveExpertIdFromJumpUrl(""), "");
  assert.equal(deriveExpertIdFromJumpUrl(null), "");
  assert.equal(deriveExpertIdFromJumpUrl("workbuddy://expert"), "", "lighthouse/Valorant 的深链不含 id");
  assert.equal(deriveExpertIdFromJumpUrl("workbuddy://experts"), "");
  assert.equal(deriveExpertIdFromJumpUrl("workbuddy://chat"), "");
  assert.equal(deriveExpertIdFromJumpUrl("workbuddy://home?openBuddySwitcher=true"), "");
  assert.equal(deriveExpertIdFromJumpUrl("https://www.workbuddy.cn/events/follow-guide/"), "");
  // 只认 ex_ 前缀（团队 id / 随便什么值都不算专家 id）
  assert.equal(deriveExpertIdFromJumpUrl("workbuddy://experts?expertId=CloudOpsTeam"), "");
  assert.equal(deriveExpertIdFromJumpUrl("workbuddy://experts?expertId=ex_"), "");
  assert.equal(deriveExpertIdFromJumpUrl("workbuddy://experts?expertid=ex_x"), "", "键名大小写敏感");
  // 畸形编码不抛异常
  assert.equal(deriveExpertIdFromJumpUrl("workbuddy://experts?expertId=ex_OK%ZZ"), "ex_OK");
  assert.equal(deriveExpertIdFromJumpUrl("x".repeat(5000)), "");
});

test("expertNameFromTitle：任务标题里的「专家名」提取（事件 name/expertTitle 用）", () => {
  assert.equal(expertNameFromTitle("体验「中国电商运营专家」"), "中国电商运营专家");
  assert.equal(expertNameFromTitle("体验「直播电商教练」"), "直播电商教练");
  assert.equal(expertNameFromTitle("没有引号的标题"), "没有引号的标题");
  assert.equal(expertNameFromTitle(""), "");
});

test("resolveTaskKind：TASK_SPECS 命中优先 —— Valorant 的钉死 id 绝不被 jump_url 覆盖", () => {
  const rk = resolveTaskKind({
    code: "WorkBuddy_Valorant",
    title: "体验「无畏契约拼豆专家」",
    jumpUrl: jumpOf("ex_IMPOSTER"), // 恶意/脏数据：jump_url 里带别的 id
    acceptStatus: "not_accepted",
    taskType: "single",
  });
  assert.equal(rk.source, "spec");
  assert.equal(rk.kind, "expert");
  assert.equal(rk.pinnedExpertId, "ex_xQHHD1u5Jkua", "钉死常量是唯一来源（CONTRACT §7）");
  assert.equal(rk.expertName, "无畏契约拼豆专家");
  assert.equal(rk.unforgeable, false);
  assert.equal(rk.desktopOnly, false);
  assert.equal(rk.canAccept, true);
  assert.equal(rk.canLight, false, "not_accepted 的 single 还不能点亮");
});

test("resolveTaskKind：lighthouse 的 jump_url 只有 workbuddy://expert —— 钉死常量兜底", () => {
  const rk = resolveTaskKind({
    code: "Expert_lighthouse",
    title: "体验「腾讯轻量云」专家",
    jumpUrl: "workbuddy://expert",
    acceptStatus: "accepted",
    taskType: "single",
  });
  assert.equal(rk.source, "spec");
  assert.equal(rk.pinnedExpertId, "ex_2cvvUZQhDyeJ");
  assert.equal(rk.canLight, true, "accepted 的 lighthouse 可点亮");
});

test("resolveTaskKind：未收录但 jump_url 派生得出 → expert 类、事件 id 钉在解析出的 id 上", () => {
  // expert_use_maidehao 等四条 0.3.3 起已收录（§10.6）；「派生」分支用一条
  // 不在 TASK_SPECS 的未来 code 验证兜底路径仍在。
  const rk = resolveTaskKind({
    code: "expert_use_future99",
    title: "体验「未来电商专家」",
    jumpUrl: jumpOf("ex_FutureExpert9"),
    acceptStatus: "accepted",
    taskType: "single",
  });
  assert.equal(rk.source, "jump_url");
  assert.equal(rk.kind, "expert", "expertType=agent（buildEvent expert 族）");
  assert.equal(rk.spec, null);
  assert.equal(rk.pinnedExpertId, "ex_FutureExpert9");
  assert.equal(rk.expertName, "未来电商专家");
  assert.equal(rk.unforgeable, false);
  assert.equal(rk.reason, "");
  assert.equal(rk.desktopOnly, false);
  assert.equal(rk.acceptible, true);
  assert.equal(rk.lightable, true);
  assert.equal(rk.canAccept, false, "accepted 后不再给接取结论");
  assert.equal(rk.canLight, true);

  // 已收录的 expert_use_* 走 spec 分支：钉死常量与 jump_url 派生出的 id 一致，
  // source 升级为 spec（spec 优先级高于 jump_url，CONTRACT §2/§7.4）
  const specHit = resolveTaskKind({
    code: "expert_use_maidehao",
    title: "体验「中国电商运营专家」",
    jumpUrl: jumpOf("ex_GDl31WahyIH0"),
    acceptStatus: "accepted",
    taskType: "single",
  });
  assert.equal(specHit.source, "spec", "TASK_SPECS 命中优先于 jump_url 派生");
  assert.equal(specHit.kind, "expert");
  assert.equal(specHit.pinnedExpertId, "ex_GDl31WahyIH0");
  assert.equal(specHit.expertName, "中国电商运营专家");
  assert.equal(specHit.canLight, true);
});

test("resolveTaskKind：未收录且派生不出 → unforgeable + 未收录任务，绝不接取/点亮", () => {
  for (const jumpUrl of ["", "workbuddy://something-new", "https://example.com/promo", jumpOf("CloudOpsTeam")]) {
    const rk = resolveTaskKind({
      code: "brand_new_task",
      title: "未来新任务",
      jumpUrl,
      acceptStatus: "not_accepted",
      taskType: "single",
    });
    assert.equal(rk.source, "none", `jumpUrl=${JSON.stringify(jumpUrl)}`);
    assert.equal(rk.kind, null);
    assert.equal(rk.unforgeable, true);
    assert.equal(rk.reason, "未收录任务");
    assert.equal(rk.acceptible, false);
    assert.equal(rk.lightable, false);
    assert.equal(rk.canAccept, false);
    assert.equal(rk.canLight, false);
    assert.equal(rk.pinnedExpertId, "");
  }
});

test("resolveTaskKind：canAccept/canLight 状态矩阵（六类任务 × 四种上游状态）", () => {
  const cases = {
    // code, 构造参数, [not_accepted, accepted, completed, claimed] 的 [canAccept, canLight]
    "普通 single（chat_5）": {
      make: (status) => ({ code: "chat_5", jumpUrl: "workbuddy://chat", acceptStatus: status, taskType: "single" }),
      grid: [[true, false], [false, true], [false, false], [false, false]],
    },
    "auto（first_buddy）": {
      make: (status) => ({ code: "first_buddy", jumpUrl: "workbuddy://chat", acceptStatus: status, taskType: "auto" }),
      grid: [[false, true], [false, true], [false, false], [false, false]],
    },
    "spec 单任务（Library_read，web 点击点亮）": {
      make: (status) => ({ code: "Library_read", jumpUrl: "workbuddy://library", acceptStatus: status, taskType: "single" }),
      grid: [[true, false], [false, true], [false, false], [false, false]],
    },
    "unforgeable（wb_wechat）": {
      make: (status) => ({
        code: "wb_wechat_oa_subscribe_task",
        jumpUrl: "https://www.workbuddy.cn/events/follow-guide/",
        acceptStatus: status,
        taskType: "single",
      }),
      grid: [[false, false], [false, false], [false, false], [false, false]],
    },
    "已收录 expert_use_*（spec，0.3.3 §10.6）": {
      make: (status) => ({
        code: "expert_use_douyinyin",
        title: "体验「抖音策略师」",
        jumpUrl: jumpOf("ex_FbY5nlWTqDod"),
        acceptStatus: status,
        taskType: "single",
      }),
      grid: [[true, false], [false, true], [false, false], [false, false]],
    },
    "未收录但派生得出（expert_use_future99）": {
      make: (status) => ({
        code: "expert_use_future99",
        title: "体验「未来电商专家」",
        jumpUrl: jumpOf("ex_FutureExpert9"),
        acceptStatus: status,
        taskType: "single",
      }),
      grid: [[true, false], [false, true], [false, false], [false, false]],
    },
    "未收录（brand_new_task）": {
      make: (status) => ({ code: "brand_new_task", jumpUrl: "workbuddy://future", acceptStatus: status, taskType: "single" }),
      grid: [[false, false], [false, false], [false, false], [false, false]],
    },
  };
  const statuses = ["not_accepted", "accepted", "completed", "claimed"];
  for (const [label, { make, grid }] of Object.entries(cases)) {
    statuses.forEach((status, i) => {
      const rk = resolveTaskKind(make(status));
      assert.equal(rk.canAccept, grid[i][0], `${label} @ ${status} canAccept`);
      assert.equal(rk.canLight, grid[i][1], `${label} @ ${status} canLight`);
    });
  }
  // desktopOnly 标记本身与状态无关：只剩 Buddy_App_QQ 一家
  //（Buddy_App 已用 5 连桌面埋点实测打通；Library_read/RichMeow 也已移出）
  assert.equal(resolveTaskKind({ code: "Buddy_App", jumpUrl: "workbuddy://home" }).desktopOnly, false);
  assert.equal(resolveTaskKind({ code: "Buddy_App_QQ", jumpUrl: "workbuddy://home" }).desktopOnly, true);
  const buddy = resolveTaskKind({ code: "Buddy_App", jumpUrl: "", acceptStatus: "accepted", taskType: "single" });
  assert.equal(buddy.kind, "buddy5");
  assert.equal(buddy.canLight, true, "Buddy_App 5 连已可点亮");
  assert.equal(resolveTaskKind({ code: "RichMeow_Chat", jumpUrl: "" }).desktopOnly, false);
  const rich = resolveTaskKind({ code: "RichMeow_Chat", jumpUrl: "", acceptStatus: "accepted", taskType: "single" });
  assert.equal(rich.kind, "richmeow");
  assert.equal(rich.canLight, true, "RichMeow 6 连已可点亮");
  // Library_read：spec 命中即点亮路径 —— desktopOnly=false、accepted 可点亮
  const lib = resolveTaskKind({ code: "Library_read", jumpUrl: "workbuddy://library", acceptStatus: "accepted", taskType: "single" });
  assert.equal(lib.desktopOnly, false, "Library_read 不再是 desktop-only");
  assert.equal(lib.source, "spec");
  assert.equal(lib.kind, "library");
  assert.equal(lib.lightable, true, "Library_read 的 kind 可自动化");
  assert.equal(lib.canLight, true, "accepted 的 Library_read 可点亮");
  assert.equal(lib.unforgeable, false);
  assert.equal(resolveTaskKind({ code: "Expert_Philanthropy" }).unforgeable, true, "公益捐赠沿用 unforgeable");
  assert.equal(resolveTaskKind({ code: "Expert_team_use_3", acceptStatus: "accepted" }).pinnedExpertId, "", "team 类走池子轮换，不钉 id");
  assert.equal(resolveTaskKind({ code: "expert_5", acceptStatus: "accepted" }).pinnedExpertId, "", "expert_5 走池子轮换，不钉 id");
});

test("fetchTasks：未收录/派生任务的 unforgeable+reason 落到规范 Task（needsAccept 的依据）", async () => {
  const clock = fakeClock(localTime(2026, 10, 31, 10, 0));
  const backend = wbBackend({
    clock,
    tasks: [
      task("brand_new_task", { title: "未来新任务", jump_url: "workbuddy://future" }),
      {
        task_code: "expert_use_maidehao",
        title: "体验「中国电商运营专家」",
        jump_url: jumpOf("ex_GDl31WahyIH0"),
        accept_status: "not_accepted",
        task_type: "single",
        reward_credit: 50,
        reward_energy: 5,
        progress: null, // 真实形态：not_accepted 的任务 progress 是 null
      },
      task("wb_wechat_oa_subscribe_task", { title: "关注官方公众号", jump_url: "https://www.workbuddy.cn/events/follow-guide/" }),
    ],
    litRules: {},
  });
  const tasks = await fetchTasks(makeAcct(), {
    now: clock.now,
    sleep: clock.sleep,
    fetch: backend.fetchImpl,
  });
  assert.equal(tasks.length, 3);

  const unknown = tasks.find((t) => t.code === "brand_new_task");
  assert.equal(unknown.unforgeable, true, "未收录 → 引擎不接取（needsAccept 挡下）");
  assert.equal(unknown.reason, "未收录任务");

  const derived = tasks.find((t) => t.code === "expert_use_maidehao");
  assert.equal(derived.unforgeable, false, "派生得出专家 id → 可接可点亮");
  assert.equal(derived.reason, "");
  assert.deepEqual(derived.progress, { current: 0, target: 1 }, "progress null → 归一为 0/1");
  assert.equal(derived.rewardCredit, 50);
  assert.equal(derived.rewardEnergy, 5);

  const wechat = tasks.find((t) => t.code === "wb_wechat_oa_subscribe_task");
  assert.equal(wechat.unforgeable, true, "spec.unforgeable 语义沿用");
  assert.match(wechat.reason, /微信/);

  // 规范 Task 的键集合不变（taskkind 只改 unforgeable/reason 的取值来源；
  // locked/unlockAt 是 2026-11-11 起的锁字段——web 清单也带，与 fetchMPTasks
  // 同口径归一）
  assert.deepEqual(Object.keys(unknown).sort(), [
    "acceptStatus", "code", "description", "jumpUrl", "locked", "progress",
    "reason", "rewardCredit", "rewardEnergy", "taskType", "title", "unforgeable", "unlockAt",
  ]);
});

test("resolveTaskKind：小程序任务（MP_TASK_SPECS / Sequential_Tasks_ 前缀）→ source:mp、kind:mp", () => {
  // MP_TASK_SPECS 命中：spec 用 MP 条目（name/target/reward），判断字段收敛
  const mp = resolveTaskKind({
    code: "Sequential_Tasks_1",
    title: "完成 1 次对话",
    acceptStatus: "not_accepted",
    taskType: "single",
  });
  assert.equal(mp.source, "mp");
  assert.equal(mp.kind, "mp");
  assert.equal(mp.spec, MP_TASK_SPECS.Sequential_Tasks_1);
  assert.equal(mp.desktopOnly, false);
  assert.equal(mp.unforgeable, false);
  assert.equal(mp.reason, "");
  assert.equal(mp.acceptible, true);
  assert.equal(mp.lightable, true);
  assert.equal(mp.pinnedExpertId, "");
  assert.equal(mp.canAccept, true, "not_accepted → 可接取");
  assert.equal(mp.canLight, false, "not_accepted → 不可点亮");

  const accepted = resolveTaskKind({ code: "Sequential_Tasks_1", acceptStatus: "accepted", taskType: "single" });
  assert.equal(accepted.canAccept, false);
  assert.equal(accepted.canLight, true, "accepted → 小程序链路可点亮");

  for (const status of ["completed", "claimed"]) {
    const s = resolveTaskKind({ code: "school_season", acceptStatus: status, taskType: "single" });
    assert.equal(s.canAccept, false, `${status} → 不可接取`);
    assert.equal(s.canLight, false, `${status} → 不可点亮`);
    assert.equal(s.source, "mp");
  }

  // Sequential_Tasks_ 前缀兼容缝（不在 MP_TASK_SPECS）：spec 为 null，其余照常
  const future = resolveTaskKind({ code: "Sequential_Tasks_9", acceptStatus: "not_accepted", taskType: "single" });
  assert.equal(future.source, "mp");
  assert.equal(future.kind, "mp");
  assert.equal(future.spec, null);
  assert.equal(future.canAccept, true);

  // MP code 即使带专家 jump_url 也走 MP 分支（MP 优先于 jump_url 派生）
  const withJump = resolveTaskKind({
    code: "Sequential_Tasks_2",
    jumpUrl: jumpOf("ex_GDl31WahyIH0"),
    acceptStatus: "not_accepted",
    taskType: "single",
  });
  assert.equal(withJump.source, "mp");
  assert.equal(withJump.pinnedExpertId, "");

  // 优先级不破坏：Sequential_Tasks_7 在 TASK_SPECS（web playbook）→ 绝不被 MP 前缀抢走
  const s7 = resolveTaskKind({ code: "Sequential_Tasks_7", acceptStatus: "not_accepted", taskType: "single" });
  assert.equal(s7.source, "spec");
  assert.equal(s7.kind, "playbook");
  // 未收录 code 的 jump_url 派生也不受影响
  const derived = resolveTaskKind({ code: "expert_use_new", jumpUrl: jumpOf("ex_NewDer1ved0"), acceptStatus: "not_accepted", taskType: "single" });
  assert.equal(derived.source, "jump_url");
  assert.equal(derived.pinnedExpertId, "ex_NewDer1ved0");
});

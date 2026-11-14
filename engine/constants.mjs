// constants.mjs —— 成长任务引擎的唯一事实来源（CONTRACT §1 / §7）。
//
// 一切字面量都与 workbuddy2api-hub 的 wb_tasks.py / wb_identity.py /
// wb_accounts.py 逐字对齐；改动任何一个值都要先对过 Python 源。

// ---- 上游地址 -------------------------------------------------------------
// 国内版对话侧默认 base；可用环境变量 WB_GROWTH_BASE / WB_CN_CHAT_UPSTREAM
// 覆盖（与 hub 的 wb_identity.CN_CHAT_BASE 同一口径），见 upstream.growthBase()。
export const CHAT_BASE = "https://copilot.tencent.com";
// 计费侧 base（wb_tasks.BILL_BASE）。
export const BILL_BASE = "https://www.codebuddy.cn";
// 领奖 web 回退 base（wb_tasks.WEB_BASE）。
export const WEB_BASE = "https://www.workbuddy.cn";
// CN 桌面端请求的 Origin/Referer（wb_accounts.REALM_CONFIGS["cn"].origin）——
// 注意即便请求打向 copilot.tencent.com，Origin 也是 codebuddy.cn。
export const CN_ORIGIN = "https://www.codebuddy.cn";
// X-Domain 的兜底值（账号自带 domain 时优先用账号的）。
export const CN_CHAT_DOMAIN = "copilot.tencent.com";
// chat 主机失联（TLS reset 等）时的回退主机（CONTRACT §2 upstream.callJSON）。
export const CHAT_FALLBACK_BASE = "https://www.workbuddy.cn";

// ---- 出站身分（wb_identity.DESKTOP_UA_CN 等）-------------------------------
// 国内版桌面端：2026-10-18 两区桌面端实跑（Go 版抓包记录）为 5.8.3、内置 CLI
// 2.161.0；第二段按国内版是 WorkBuddy（国际版是 workbuddy-ai）。
export const DESKTOP_VERSION_CN = "5.8.3";
export const DESKTOP_UA_CN = "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0";
// billing 头的 UA（REALM_CONFIGS["cn"].billing_ua）。
export const BILLING_UA_CN = `WorkBuddy/${DESKTOP_VERSION_CN}`;
// 领奖 web 回退的浏览器 UA（wb_tasks.WEB_UA）。
export const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

// ---- 刷新 ------------------------------------------------------------------
// 刷新端点路径。占位符 /v2/plugin/auth/token 是 hub / magpie 双方都在用的字面
// 形态（网关侧替换），这里照抄，不要"修复"它。
export const REFRESH_PATH = "/v2/plugin/auth/token/refresh";
// 国内版刷新头（wb_accounts._refresh_locked：X-Auth-Refresh-Source 按 realm
// 取值，cn 是 "workbuddy"，intl 才是 "plugin"）。
export const REFRESH_SOURCE_CN = "workbuddy";

// ---- 防风控节奏（铁律 4）----------------------------------------------------
// 任何两次上游调用之间的最小间隔（毫秒）；wb_tasks 的 gap=1.0（秒）。
export const DEFAULT_GAP_MS = 1000;
// 上报后等上游落账的固定间隔（wb_tasks._progress_one 的 time.sleep(1.5)）。
export const REPORT_SETTLE_MS = 1500;
// 进度在涨时的再等间隔（time.sleep(2.5)）。
export const PROGRESS_RISING_MS = 2500;
// 夜猫子任务的轮询间隔（run_night_growth 的 time.sleep(4)）。
export const NIGHT_POLL_MS = 4000;
// 账号与账号之间的手动间隔（铁律 4：1.5 s 手动 / 2–5 s 抖动排程）。
export const ACCOUNT_GAP_MANUAL_MS = 1500;
// 排程抖动下限/上限（毫秒）。
export const ACCOUNT_JITTER_MIN_MS = 2000;
export const ACCOUNT_JITTER_MAX_MS = 5000;
// accept 批量上限（wb_tasks.accept_tasks chunk=20）。
export const ACCEPT_CHUNK = 20;
// 领奖竞态轮询次数上限（_progress_one 的 range(6)）。
export const CLAIM_POLL_ATTEMPTS = 6;
// 夜猫子上报后的轮询次数（run_night_growth 的 range(4)）。
export const NIGHT_POLL_ATTEMPTS = 4;
// 403 / code 11140 账号级风控限制的冷却毫秒（wb_accounts.
// RESTRICTED_ACCOUNT_COOLDOWN = 7200.0 秒）。
// **@deprecated（0.3.3，CONTRACT §10.5）**：403/11140 不再走「2 小时自动冷却」
// —— hub v2.1.0 口径：它不是可自动恢复的风控冷却，继续重试只会让同设备账号
// 连坐。现在任何腿收到 restricted 都**立即冻结**该账号（engine/runner.freeze +
// state/frozen.json 持久化），只有 /api/account/unfreeze 能解冻，绝不自动恢复。
// 常量保留只为兼容既有 import（避免引用悬空），不再有任何运行时语义。
export const RESTRICTED_COOLDOWN_MS = 7200_000;
// access token 距到期还剩多久就先刷新（对齐 magpie 插件 LEAD_MS）。
export const REFRESH_LEAD_MS = 5 * 60 * 1000;

// ---- 任务规格（wb_tasks.TASK_SPECS 逐字拷贝）--------------------------------
// kind 决定 buildEvent 的事件族；expert 字段钉死该活动任务必须使用的真实
// 专家 id（上游按 (eventCode, id) 去重，id 不对则进度永远不动）。
export const TASK_SPECS = {
  create_canvas: { kind: "canvas", target: 1, reward: 300, name: "创建设计任务" },
  template_5: { kind: "template", target: 5, reward: 200, name: "模板创建任务" },
  expert_5: { kind: "expert", target: 5, reward: 200, name: "使用专家助手" },
  Expert_team_use_3: { kind: "team", target: 3, reward: 150, name: "使用专家团队" },
  skill_1: { kind: "skill", target: 1, reward: 100, name: "体验技能" },
  automation_1: { kind: "automation", target: 1, reward: 100, name: "创建自动化任务" },
  playbook_prompt: { kind: "playbook", target: 1, reward: 100, name: "灵感案例使用" },
  Expert_lighthouse: { kind: "lighthouse", target: 1, reward: 100, name: "轻量云专家使用" },
  Buddy_App: { kind: "buddy5", target: 1, reward: 100, name: "进入 Buddy 应用" },
  Buddy_App_QQ: { kind: "buddy5", target: 1, reward: 100, name: "企鹅教师助手" },
  Hp_Appearance: { kind: "skin", target: 1, reward: 100, name: "应用主题外观" },
  chat_5: { kind: "chat", target: 5, reward: 100, name: "发起 5 次对话" },
  "Model_chat_GLM5.2": { kind: "glmchat", target: 1, reward: 100, name: "体验 GLM-5.2" },
  black_cat: { kind: "cat", target: 3, reward: 100, name: "夜猫子任务 (23:00-08:00)" },
  RichMeow_Chat: { kind: "richmeow", target: 1, reward: 100, name: "桌面对话事件链" },
  Library_read: { kind: "library", target: 1, reward: 100, name: "浏览资料库" },
  // first_buddy 是 auto 类（上游不接受接取），完成后领奖才发放 Buddy 实例；
  // 它是所有 single 任务与猫猫旅行的前置（"prerequisite not met: first_buddy"）。
  first_buddy: { kind: "chat", target: 1, reward: 300, name: "领取一只 Buddy" },
  // 活动任务：在专家页召唤「无畏契约拼豆专家」并完成一次对话。事件里的 id
  // 必须是这个专家的真实 id，否则上游只接受事件但不推进进度。
  WorkBuddy_Valorant: {
    kind: "expert", target: 1, reward: 100,
    expert: ["ex_xQHHD1u5Jkua", "无畏契约拼豆专家"],
    name: "体验「无畏契约拼豆专家」",
  },
  // 活动任务（hub 937c179）：工作台搭建师。事件 id 是这个专家的真实 id
  //（上游按 (eventCode, id) 去重，id 不对则进度永远不动）；注意 id 不是 ex_ 形态。
  workstation_expert: {
    kind: "expert", target: 1, reward: 100,
    expert: ["WorkspaceBuilder", "工作台搭建师"],
    name: "工作台搭建师",
  },
  // PC 灵感功能（web 侧的 Sequential_Tasks 系列成员）：playbook 双事件链
  //（cta_click + prompt_send，见 tasks.buildEvent 的 "playbook" 分支）。
  Sequential_Tasks_7: { kind: "playbook", target: 1, reward: 100, name: "PC灵感功能" },
  // 专家活动任务 ×4（CONTRACT §10.6，hub TASK_SPECS 新增项）：expert 钉死**上游
  // 真实 id** —— 上游按 (eventCode, id) 去重，id 不对进度永远不动。上游没下发
  // 这些 code 时零副作用（只多四条 spec 表项）。
  expert_use_maidehao: {
    kind: "expert", target: 1, reward: 100,
    expert: ["ex_GDl31WahyIH0", "中国电商运营专家"],
    name: "中国电商运营专家",
  },
  expert_use_douyinyin: {
    kind: "expert", target: 1, reward: 100,
    expert: ["ex_FbY5nlWTqDod", "抖音策略师"],
    name: "抖音策略师",
  },
  expert_use_shangjia_xuanchuan: {
    kind: "expert", target: 1, reward: 100,
    expert: ["ex_Weo3x2EZuSDm", "商家宣传页与海报设计师"],
    name: "商家宣传页与海报设计师",
  },
  expert_use_bowangwang: {
    kind: "expert", target: 1, reward: 100,
    expert: ["ex_WZY136wV5aMt", "直播电商教练"],
    name: "直播电商教练",
  },
  wb_wechat_oa_subscribe_task: {
    unforgeable: true, reward: 100,
    reason: "需在微信关注「腾讯 WorkBuddy」公众号满 24 小时",
    name: "关注官方公众号",
  },
  Expert_Philanthropy: { unforgeable: true, reason: "真实捐款动作", reward: 0, name: "公益爱心捐赠" },
  // 分享一个技能给好友（CONTRACT §11.2，hub 8eede085 把原「不可自动化」结论作废）：
  // 官方 Open Platform 路径 —— 先在市场技能目录里选一个技能，再经
  // open.workbuddy.cn 的 asset-shares 接口**创建真实分享渠道**（上游会真实生成
  // 分享链接，这是真实动作不是伪造事件），随后上报两条 skill_share_channel_action
  // 桌面事件并轮询进度。执行在 tasks.mjs 的 kind:"skillshare" 流程（growth 腿）。
  skill_share: { kind: "skillshare", target: 1, reward: 100, name: "分享一个技能给好友" },
};

// ---- skill_share 官方分享路径（CONTRACT §11.2，hub 8eede085 逐字）-------------
// 市场技能目录：POST {bill}/v2/operation-platform/market/skill/list（chat 头）。
export const SKILL_MARKET_URL = "https://www.codebuddy.cn/v2/operation-platform/market/skill/list";
// 创建分享渠道：POST open.workbuddy.cn 的 asset-shares c2c channels（真实上游动作）。
export const SKILL_SHARE_CHANNEL_URL =
  "https://open.workbuddy.cn/api/v2/open-platform/asset-shares/c2c/channels";
// 偏好分享的技能 id（hub 实测可用；市场里没有它时取第一个可用技能）。
export const SKILL_SHARE_PREFERRED_ID = "skill_2097350077599879168";
// 渠道事件上报后等服务端进度落账：4 次 × 3s（hub SKILL_SHARE_POLL_TRIES/GAP）。
export const SKILL_SHARE_POLL_TRIES = 4;
export const SKILL_SHARE_POLL_GAP_MS = 3000;

// ---- template_5 真实场景（CONTRACT §11.3，hub 8eede085 逐字）-------------------
// 场景表：GET www.workbuddy.cn/console/as/support/scenes?locale=zh-CN（chat 头）；
// 请求失败/为空才回落 hub 的内置表。
export const TEMPLATE_SCENES_URL = "https://www.workbuddy.cn/console/as/support/scenes?locale=zh-CN";
export const TEMPLATE_FALLBACK_SCENES = [
  ["0", "幻灯片"],
  ["4", "深度研究"],
  ["8", "数据分析"],
  ["16", "设计"],
  ["20", "日常开发"],
];
// 每组四事件上报后的进度确认轮询：4 次 × 2s（hub TEMPLATE_POLL_TRIES/GAP）。
export const TEMPLATE_POLL_TRIES = 4;
export const TEMPLATE_POLL_GAP_MS = 2000;

// ---- 逆向修复常量（2026-09 实测校准）----------------------------------------
// 这些任务上游只认桌面客户端的真实行为信号（jump_url 均为 workbuddy:// 深链，
// 需要真实点击进入对应页面）。伪造 chat 域 /v2/report 事件会被忽略或落到
// heartbeat，进度永远是 0/1，claim 必然返回 400 "task not completed"。诚实地
// 跳过并给出深链。
// 注：Library_read 曾在此列（生产两账号长期「已接取 0/1」）——后经参考实现
// 证实它可以由 web 端的一次元素点击事件点亮（web_element_click，见
// tasks.reportLibraryEvent），已移出本表（TASK_SPECS 的 kind:"library" 接管）。
// RichMeow_Chat（RichMeow）也已移出：hub 937c179 证实用 6 条桌面会话事件链
//（agent_task_created → … → agent_task_completed）可以点亮，见 tasks.buildEvent
// 的 kind:"richmeow" 分支。
// Buddy_App 也已移出：connoryang 的 5 连（buddyapp_*）+ 桌面指纹在 2026-11-06
// 本机实测可推进 0→1 并领奖；Buddy_App_QQ 先保留 desktop-only（同一链但未单独实测）。
export const DESKTOP_ONLY_TASKS = {
  Buddy_App_QQ: "在桌面端「发现应用」进入「企鹅教师助手」",
};

// Library_read（浏览资料库）的点亮事件（wb_tasks.report_web_library 同源）：
// 打开资料库介绍文档后，web 端向 web 域 /v2/report 发一条 web_element_click。
export const LIBRARY_DOC_URL = "https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm";
export const LIBRARY_ELEMENT_ID = "library_doc_intro_click";
export const LIBRARY_ELEMENT_NAME = "WorkBuddy资料库介绍";

// 夜猫子任务只在 23:00-08:00 上报才计数，且每天 1 次、累计 3 天。
export const NIGHT_TASK_CODES = new Set(["black_cat"]);

// 专家/团队事件必须彼此不同：桌面端 appendGrowthEvent 按 (eventCode, id) 去重，
// 上游同样只按不同 id 累加进度 —— 重复发同一个 id 进度永远不动。
// 下列 id 已在 2026-09 实测中验证可推进任务进度。
export const EXPERT_ID_POOL = [
  ["ex_PZw8Gu81HfN4", "运维工程师"], ["ex_ROsDtJbzADFV", "产品经理"],
  ["ex_SMUnl0nJbPix", "UI设计师"], ["ex_ZTR062oVBOCW", "数据分析师"],
  ["ex_a3sSSFBy8qaC", "后端架构师"], ["ex_aG1kvKbq8lPx", "文案策划"],
  ["ex_al1vxtUOYQ10", "测试专家"], ["ex_cZfiyuET9UQP", "安全顾问"],
  ["ex_eggOvQuVP0hq", "算法工程师"], ["ex_hSwsQjkSKnkX", "前端工程师"],
  ["ex_mMbwwmFA9n9P", "项目管理专家"], ["ex_uAQE5POfk7Zh", "增长运营专家"],
  ["ex_uZzSAScSy7FZ", "行业研究员"], ["ex_LHywGrZOtG7G", "数据分析师"],
  ["ex_NX5C8GBciVed", "测试架构师"], ["ex_DdCsaoq4AtcO", "云端运维专家"],
  ["ex_KzqKQguubrNQ", "内容创作专家"], ["ex_2cvvUZQhDyeJ", "腾讯轻量云专家"],
];

// 团队 id 来自官方专家清单 expert_center.json（expertType=team，共 53 个），
// 前 3 个已在 2026-09 实测验证可推进 Expert_team_use_3。
export const TEAM_ID_POOL = [
  ["CloudOpsTeam", "运维专家团队"], ["CloudContentTeam", "内容专家团队"],
  ["CloudDevTeam", "研发专家团队"], ["ProductStrategyTeam", "产品战略团队"],
  ["MarketingCampaignTeam", "营销活动团队"], ["SalesBattleTeam", "销售作战团队"],
  ["DesignEngineTeam", "设计引擎团队"], ["HrOperationsTeam", "人力运营团队"],
];

// ---- 北京时间（UTC+8）口径 ---------------------------------------------------
// 生产 magpie 容器时区是 UTC（date 显示 UTC、TZ 为空）：new Date().getHours()
// 读的是宿主时区，在 UTC 容器里会把北京 09:00 读成 1 点，从而误触夜猫子窗口、
// 错过旅行窗口。因此排程小时、夜猫子 23:00–08:00 窗口、同日去重的日界一律按
// **北京时间（UTC+8）** 解释，与宿主/容器时区无关 —— 与 engine/daily 的
// beijingDayKey、engine/credits 的「naive 时间按 +08:00 解析」同一口径。
// 实现：UTC 毫秒 + 8h 后取 **UTC** 分量，绝不碰 getHours()/getDate() 这类
// 宿主本地分量。

// beijingHour(nowMs) -> 北京小时（0–23）。UTC 01:00 = 北京 09:00；
// UTC 17:00 = 北京次日 01:00。nowMs 可注入（测试/假时钟）。
export function beijingHour(nowMs) {
  return new Date((nowMs ?? Date.now()) + 8 * 3600 * 1000).getUTCHours();
}

// beijingDateKey(nowMs) -> 北京日期 "YYYY-MM-DD"（UTC+8）。UTC 16:00 整翻到
// 北京次日（与 engine/daily.beijingDayKey 同一日界）。排程「同日同窗口只触发
// 一次」的去重键用它，绝不使用 toDateString()（宿主时区）。
export function beijingDateKey(nowMs) {
  const d = new Date((nowMs ?? Date.now()) + 8 * 3600 * 1000);
  return (
    `${d.getUTCFullYear()}-` +
    `${String(d.getUTCMonth() + 1).padStart(2, "0")}-` +
    `${String(d.getUTCDate()).padStart(2, "0")}`
  );
}

// ---- 夜间窗口 ---------------------------------------------------------------
// 夜猫子任务只在 23:00-08:00 上报才计数，且每天 1 次、累计 3 天。小时按北京
// 时间（UTC+8）取 —— UTC 容器里 getHours() 会把北京 23:30 读成 15 点而漏判。
export function inNightWindow(nowMs) {
  const h = beijingHour(nowMs);
  return h >= 23 || h < 8;
}

# magpie-workbuddy-tasks — 内部契约（所有实现必须遵守）

把 workbuddy2api-hub 的「国内版成长/积分任务批量自动化」移植成 magpie 插件。
账号凭据**复用 magpie 已登录的 WorkBuddy 账号**（共享读 `plugin-auth.json`，必要时回写刷新结果）。

## 0. 铁律

1. **不碰对话链路**：本插件不声明 `workbuddy` / `workbuddy-ai` 这两个 provider id，不接管模型、不接管 loader/fetch。对话继续由 `@magpie-community/opencode-workbuddy-auth` 服务。
2. **凭据不外泄**：access/refresh token 永不出现在任何 HTTP 响应、页面、日志里（只显示 `uid`、昵称、掩码）。
3. **单一凭据血统**：刷新 token 后必须原子回写 `plugin-auth.json`，保证社区插件与我们用的是同一对 token，避免 refresh 轮换把对方踢下线。
4. **限速不可省**：任何两次上游调用之间最少 1.0 s；账号之间 1.5 s（手动）/ 2–5 s 抖动（排程）。这是风控红线，不并行跑成长任务。**全局节流器的唯一归属与并发策略**：daemon 进程创建唯一的 `engine/upstream.makeSpacer` 实例（gap 动态取 `settings.gapMs`），经 `engineOpts()` 与 runner ctx 注入**所有**打上游的路径——job 腿、token 临期刷新（`refreshAccount`）、快照刷新（`finalizeJob → refreshSnapshots` 与 `GET /api/state?refresh=`）、手动操作（claim/accept/checkin）；任何路径都不得新建 ctx 后绕开它直接打上游。spacer 记录「上次上游调用真正发出的时刻」，调用前先补足到 ≥gap（跨路径对齐，start-to-start 口径），并把并发入口**排队串行**（前一个调用完整结束后才放行下一个，绝不允许两个调用同时在途）。固定 sleep（腿间 gap、账号间隔、manualOp 的 1 s）保留作为节奏设计，但跨路径的正确性由 spacer 保证——各路径的等待窗重叠时后者等待，而不是贴着发。同一逻辑调用内的重试退避与主机回退同样算「两次上游调用」，间隔同样 ≥1.0 s。
5. **纯 ESM、零运行时依赖**：只用 Bun/Node 内置（`node:fs`、`node:crypto`、`node:http`、`zlib`）。插件宿主里没有构建步骤。
6. `index.mjs` **只导出一个函数**（magpie 会把入口文件里每个导出函数当插件跑）。辅助导出必须挂在 `export const _internal = {...}` 上。

## 1. 目录结构

```
magpie-workbuddy-tasks/
  package.json
  index.mjs              # 插件入口：tool 钩子 + 守护进程生命周期（不声明 provider，§5）
  daemon.mjs             # 常驻 Bun 进程：HTTP 看板 + /api + 排程 + 任务执行
  engine/
    fingerprint.mjs      # derive_id 等设备指纹派生
    identity.mjs         # 三套请求头构造：chat / billing / web
    upstream.mjs         # call()：信封、重试、退避、403/11140、host 回退
    store.mjs            # plugin-auth.json 读写 + 本插件状态文件
    tasks.mjs            # 成长任务：列表/接取/上报/领奖 + run_growth_tasks 流水线
    taskkind.mjs         # 任务 → kind 解析（P0-1）：jump_url 派生专家 id、未收录标注、
                         # canAccept/canLight/pinnedExpertId 收敛结论（唯一判断源）
    miniprogram.mjs      # 微信小程序链式任务（Sequential_Tasks_1–6 + school_season）：
                         # MP_HEADERS / mpBase / MP_REPORT_HEADERS 专属埋点链路
    travel.mjs           # 猫猫旅行闭环 + 夜猫子任务
    buddy.mjs            # Buddy 盲盒腿（quota → 批量 open；不领积分不加 credit）
    daily.mjs            # 每日活跃上报（点亮成长中心连登；uid→北京日幂等）
    credits.mjs          # 积分余额 + 套餐权益包明细（只读；fetchCredits）
    runner.mjs           # 跨账号批量编排、job 状态与日志、并发闸门
    schedule.mjs         # 小时窗口排程
    constants.mjs        # TASK_SPECS / 事件池 / 上游常量（唯一事实来源）
  dashboard/             # 独立看板前端（qwenwork 负责，风格对齐 magpie）
    index.html  app.js  style.css  vendor/
  page/                  # magpie 沙箱页（入口卡：状态 + 看板地址 + 跳转）
    index.html  app.js  style.css  logo-mark.png
  tests/                 # bun test，fetch 全部 mock，不碰真实账号
  README.md  LICENSE  install.md
```

## 2. engine 对外 API（`daemon.mjs`、`index.mjs` 只依赖这些）

```js
// store.mjs
readMagpieConfigDir(env) -> string|null        // directory / $MAGPIE_CONFIG_DIR / ~/.config/magpie
loadAccounts(cfg) -> Account[]                 // 读 plugin-auth.json 的 workbuddy* 条目
                                               // **层级边界（纯国内版口径）**：这里原样返回全部
                                               // workbuddy* 条目（含国际版 workbuddy-ai）——accountio
                                               // 导入合并与导出 realm=intl 逃生口要全量数据；
                                               // daemon 在使用侧统一经自己的 loadAccountsCn()
                                               // （只留 provider==="workbuddy"）做列表/统计/排程/
                                               // 运行取数，别把「只出国内版」的过滤下沉到本层
saveAccountRefresh(cfg, acctKey, patch) -> void // 原子回写（tmp + rename，保留未知字段，mode 600）
acctKey = "workbuddy" | "workbuddy#xxxxxxxx"   // magpie/OpenCode 的多账号键格式

// Account（我们的内部形状，由 plugin-auth.json 映射而来）
{ key, provider /*workbuddy|workbuddy-ai*/, uid, nickname /*=accountId*/, access, refresh,
  expires /*ms*/, refreshExpiresAt /*ms*/, domain, enterpriseId, tokenType, source,
  isApiKey /*false：我们只吃 oauth 账号*/, tasksEnabled /*来自本插件 state，不是 auth 字段*/ }

// 过滤规则（对齐 hub 的 task_accounts("cn")）
eligibleAccounts(accounts, opts) -> Account[]
  // provider==='workbuddy' && !isApiKey && !enterpriseId && tasksEnabled!==false

// fingerprint.mjs
deriveId(uid, salt) -> "xxxxxxxx-xxxx-4xxx-axxx-xxxxxxxxxxxx"
  // md5(`${salt}:${uid||'anonymous'}`) 后强制 UUIDv4 版本位/变体位：h[12]='4', h[16]='a'
uuidHex() -> 32 hex

// identity.mjs —— 返回 plain object，键名大小写必须逐字一致
chatHeaders(acct, {conversationId,requestId,messageId,rootRequestId}) -> Record<string,string>
billingHeaders(acct) -> Record<string,string>     // 含 X-Machine-ID/X-Session-ID = deriveId
webHeaders(acct) -> Record<string,string>          // 领奖回退用，Origin/Referer=www.workbuddy.cn

// upstream.mjs
callJSON(acct, kind, url, init, opts) -> {ok, status, code, data, msg, raw}
  // kind: 'chat'|'billing'|'web'；统一 {code,msg,data} 信封；code===0 为成功
  // 3 次线性退避重试；403/11140 → {restricted:true}（由 runner 冻结账号，§10.5）
  // chat 主机失败（TLS reset）→ 回退到 https://www.workbuddy.cn，X-Domain 不变
  // 重试/回退也是「两次上游调用」：任意相邻两次 HTTP 尝试间隔 ≥ gap（铁律 4）
makeSpacer({now, sleep, gap}) -> {run(fn), peekLast()}
  // 跨路径全局节流器（铁律 4 的归属）：记录「上次调用放行时刻」，调用先补足
  // ≥gap 并排队串行（前一个完整结束才放行下一个，绝不在途并行）。归属与注入
  // 点见 §0.4 —— engine 不建进程级单例（各测试假时钟互不污染），不带 spacer
  // 的调用行为与旧版完全一致
growthBase() -> string      // 默认 https://copilot.tencent.com，可被 cfg/env 覆盖
billBase()  -> "https://www.codebuddy.cn"
webBase()   -> "https://www.workbuddy.cn"

// tasks.mjs
fetchTasks(acct) -> Task[]
  // Task 是**规范形状**（camelCase）：上游 snake_case（task_code/reward_credit/jump_url、
  // 顶层 current/target/status/name）只在这一处归一，全引擎与 daemon 只认这一种拼写，
  // 绝不做双拼写回退链。raw 为非枚举字段（不进 JSON），保留上游原始对象调试用。
  // Task = { code, title, description, jumpUrl,
  //          acceptStatus /*"not_accepted"|"accepted"|"completed"|"claimed"*/,
  //          locked /*上游清单自带，缺失归一 false；2026-11-11 实测 web 清单也带
  //                  （Sequential_Tasks_7 locked:true + unlock_at）*/,
  //          unlockAt /*上游 unlock_at 原样透传，缺失归一 ""*/,
  //          taskType /*""|"single"|"auto"|…*/, progress:{current,target},
  //          rewardCredit, rewardEnergy, unforgeable, reason, raw?(非枚举) }
acceptTasks(acct, codes) -> {accepted[], already[], failed[]}   // 20 个一批
reportEvents(acct, events) -> boolean
reportLibraryEvent(acct) -> boolean
  // 「浏览资料库」（Library_read，kind:"library"）的点亮事件：web_element_click
  // 打 **web 域** /v2/report（webHeaders + 覆盖 Referer=资料库文档 URL、
  // User-Agent=WEB_UA、X-User-Id=空串；Authorization 保留）。字段与头逐字见
  // engine/tasks.mjs；callJSON 的 init.headers 支持**大小写敏感**合并自定义头，
  // 唯 Authorization 不可被覆盖（凭据头，无论大小写怎么写都保留引擎的值）。
claimTask(acct, code) -> {ok, credit, energy, via /*'chat'|'web'*/, reason}
buildEvent(acct, kind, idx) -> object | object[]
  // 多数 kind 返回单事件对象；**playbook 返回双事件数组**（playbook_cta_click +
  // playbook_prompt_send，hub 937c179 口径）、**richmeow 返回 6 条桌面会话事件
  // 数组**（RichMeow_Chat：agent_task_created → chat_message_send →
  // chat_request_send → chat_message_response → chat_request_response →
  // agent_task_completed，timestamp 依次 +20，agentName:"cli"）——progressTask
  // 对数组与单事件都收（`Array.isArray(ev) ? ev : [ev]`，一次 report 发整条链）。
runGrowthTasks(acct, opts) -> GrowsResult
  // opts.codes?: string[] —— 任务级勾选（§3/§6/§7）：非空数组 = 只对选中任务
  // 接取/点亮/领奖；每次 fetchTasks 后都按选中集合过滤；缺失 code 警告跳过
  //（MP 专属任务除外——它们由小程序链路处理，不误报）；未传/空数组 = 全部任务
  // opts.mpTasks?: boolean —— 显式 false 关闭 2b 的小程序链式任务（缺省开启）
  // opts.travel?: boolean —— 显式 false 关闭第 3 步的猫猫旅行检查（缺省开启；
  // runner 批量编排里旅行只由 travel 腿负责，growth 腿显式传 false —— 只勾
  // growth 绝不跑旅行、growth+travel 也只跑一次）
  // 次日锁（0.3.2/2026-11-11 实测）：web 清单也带 locked/unlock_at —— locked:true
  // 的任务整条跳过（不进接取批次、不上报、不领奖，日志「⏳ 任务 [title] 到第二天
  // 才能接取任务，跳过」；claimed 优先不被陈旧锁挡住）；needsAccept 排除锁定项，
  // 复查/重试/「仍有 N 个未接取」不再被锁定任务误报；解锁（locked:false）后照常

// miniprogram.mjs —— 微信小程序链式任务（runGrowthTasks 2b 自动调用，普通任务
// 处理完、猫猫旅行之前；0.3.0 起 MP 专属任务还经 refreshSnapshots 并入快照/看板、
// 经 /api/task/accept|claim 的 isMPCode 分流被单账号操作；0.3.2 起也是独立 mp 腿）
MP_HEADERS / MP_REPORT_HEADERS / MP_TASK_SPECS / MP_TASK_CODES  // 常量（§7）
isMPCode(code) -> boolean            // MP_TASK_SPECS 命中，或 Sequential_Tasks_ 前缀
                                     // 且不在 TASK_SPECS —— Sequential_Tasks_7 在
                                     // TASK_SPECS（web playbook/PC 灵感功能）绝不算
                                     // MP（否则 MP 链路吃掉它、web 流水线接取必败）；
                                     // Sequential_Tasks_99 等未收录前缀仍算 MP
mpBase(uid, nick, nowMs) -> object   // WorkBuddy_MP 埋点指纹（每条 MP 事件都要合并）
fetchMPTasks(acct, opts) -> MP Task[]        // GET growth/tasks，MP_HEADERS，规范 camelCase
                                     // 0.3.2 起含上游锁字段：locked（布尔，缺失归一 false）、
                                     // unlockAt（上游 unlock_at 原样透传，缺失归一 ""）——
                                     // 快照投影（snapTask）以上游字段为锁的唯一主依据
parseMPLock(message) -> {until:"YYYY-MM-DD"} | null
                                     // 从上游锁原因（"task locked until 2026-11-07"，
                                     // 容忍中文/多余空白）解析锁到哪天；无锁语义/非法日期 → null
acceptMPTasks(acct, codes, opts) -> {ok, accepted[], failed[], failures:[{code,message}], msg, restricted?}
                                     // failures 与 failed 一一对应，记每个失败项的上游
                                     // 原因；原因解析出锁时回调 opts.onLock?.(code,until,msg)
                                     //（防御异常，不影响主流程）
claimMPTask(acct, code, opts) -> {ok, credit, energy, reason, restricted?}  // 400 → web 回退
reportMPEvents(acct, events, opts) -> boolean  // mpBase 合并 + MP_REPORT_HEADERS，chat 域 /v2/report
runMiniProgramTasks(acct, opts) -> {ok, logs, earnedCredit, lit, claimed, restricted?}
  // opts.codes 非空 = 只处理选中的 MP 交集；交集为空连清单都不拉（零上游）
  // 次日锁双来源整条跳过（不进接取批次、不点亮、不领奖，记同一行「⏳ …到第二天
  // 才能接取任务，跳过」）：清单自带 t.locked===true（上游权威）+ opts.lockedCodes
  //（mp-locks 台账回退）；claimed 优先判断，已领奖不被锁挡「已领奖，跳过」日志
  // opts.onClaimed?(code) —— 每次领奖成功后回调（daemon 记领奖日期；防御异常）

// buddy.mjs —— Buddy 盲盒腿（独立腿，LEG_ORDER 在 travel 之前）
runBuddyOpen(acct, opts) -> {ok, opened, name?, logs, restricted?}
  // GET /v2/activity/growth/buddy/quota 读 affordable/max_open_count；
  // affordable<=0 → ok:true +「成长能量不足以开启 Buddy 盲盒」（不发 open）；
  // count = min(affordable, max(1, max_open_count))，POST open body
  // {count, client_token: randomUUID()}；解析 data.buddy|name|buddies（数组 join）。
  // **不领积分、不加 credit**（结果无 credit 字段）；403/11140 → restricted 透传。

// daily.mjs
beijingDayKey(nowMs) -> "YYYY-MM-DD"      // 北京日键（UTC+8；UTC 16:00 翻日）
reportDailyActivity(acct, opts) -> {sent:true,key} | {sent:false,skipped:true,key}
                                         // | {sent:false,error}   // 不抛
  // 每个账号每个**北京日**一条 chat 事件（buildEvent "chat"），打**计费域**
  // billBase()/v2/report（不是 chat 域！）—— 点亮成长中心连登。
  // opts.sentMap: {uid:"YYYY-MM-DD"} 幂等账本（命中今天 → {sent:false,skipped:true}，
  // 零上游调用）；成功才写 sentMap[uid]=key 并回调 opts.onSent?.(uid,key)；
  // 失败/异常返回 {sent:false,error} 不抛（调用方记日志继续）。经 reportEvents
  // → ctx.breathe/spacer，铁律 4 照常生效，绝不绕开。

// credits.mjs —— 国内版「积分余额 + 套餐权益包明细」（只读，绝不发布 token）
fetchCredits(acct, opts) -> {ok:true, credits} | {ok:false, error, needRelogin?}
  // 三个 billing 上游（POST，billing 头族 + X-Client-Platform: web）：
  //   {bill}/billing/meter/get-user-resource-summary        body "{}"
  //   {bill}/billing/meter/get-user-resource-free-packages  body {PackageCodes,PageNumber:1,PageSize:200,Status:[0]}
  //   {bill}/billing/meter/get-user-resource-paid-packages  body {同上, Status:[0,3], NeedRenewInfo:true}
  // PackageCodes = summary data.Packages[].PackageCode 去重；free/paid 单个失败
  // 忽略该来源（不整体失败）；summary 失败 → {ok:false,error}，401/403 或错误
  // 文本含「登录/过期/token/Authorization」→ needRelogin:true。每次调用前
  // ctx.breathe + callJSON 经全局 spacer（铁律 4），三次调用彼此 ≥1s。
  // credits 形状（camelCase，数值 round 2 位）：
  //   {remain, used, size, usedPercent/remainPercent（"x.x%"；size=0 → 0.0%/100.0%）,
  //    isPaidUser（null=summary 没答，不要瞎判免费）,
  //    tier {paid,package,packageCode,protectedPrice,trial}|null,
  //    earliestExpiring {name,packageCode,remain,cycleEndTime,daysLeft}|null
  //      （packages 里 remain>0 && !isExpired && daysLeft!=null，按 daysLeft 升序第一个）,
  //    packages[{name,packageCode,productName,subProductName,grantReason,resourceId,
  //              dealName,createTime,remain,used,size,unit,inUsage,autoRenew,
  //              cycleStartTime,cycleEndTime,expireTime,noExpiry,daysLeft,isExpired,status}],
  //    updatedAt（epoch ms）, updatedIso（北京 "YYYY-MM-DD HH:mm:ss"）}
  // 解析规则（wb_accounts._parse_package_account 口径，字段名保持上游原样）：
  //   free+paid 的 Account 按 AccountId 去重；size/remain/used 按
  //   Precise→普通四级键名取值，缺的量用另两个补（size>0 且 used<=0 →
  //   used=size-remain；size>0 且 remain<=0 → remain=size-used，下限 0）；
  //   grantReason 取 AccountAttributes 里 Key==="grantReason" 的 Value；
  //   包明细为空且 summary.Packages 有值时用 CycleTotal/Remain/UsedCapacity 汇总。
  // 时区红线（与 daily.beijingDayKey 同源）：容器时区可能是 UTC —— naive 字符串
  // 时间（CycleEndTime/ExpiredTime 一族）一律按北京时间（+08:00）解析成 epoch ms
  // 再算 daysLeft（1 位小数；diff<0 → isExpired）；到期优先认 DeductionEndTime
  //（epoch ms → 北京文本，免费包/体验版的 CycleEndTime 只是月度计费边界，能差
  //  8 年）；diff > 730 天 → noExpiry=true（不参与倒计时）。epoch → 文本同样固定
  // 北京时区，绝不用宿主本地时区。
epochToBeijingText(ms) -> "YYYY-MM-DD HH:mm:ss"  // 北京时区文本
beijingTextToMs(text) -> ms|null                 // naive 字符串按 +08:00 解析；解不出 null
tierFromSummary(data) -> {paid,package,packageCode,protectedPrice,trial}|null
                                                 // 无 IsPaidUser 字段 → null（「没答上来」绝不记成「免费」）

// taskkind.mjs —— 任务 → kind 解析（fetchTasks 的 unforgeable/reason、流水线的
// 接取/点亮决策、daemon.snapTask 的 6 个下发字段，全部出自这里的唯一判断源）
resolveTaskKind(t) -> { source: "spec"|"mp"|"jump_url"|"none", kind, spec,
                        desktopOnly, desktopReason, unforgeable, reason,
                        acceptible, lightable /*kind 级（不含状态）*/,
                        canAccept, canLight /*收敛结论（含状态）*/,
                        pinnedExpertId, expertName }
  // 输入是规范 Task（容忍 raw 拼写）；只读 code/jumpUrl/acceptStatus/taskType/title
  // 优先级：① TASK_SPECS 命中（钉死 id 不被 jump_url 覆盖；Sequential_Tasks_7
  //          在此表 → 永远轮不到 MP 前缀分支）
  //        ② MP_TASK_SPECS 命中或 Sequential_Tasks_ 前缀 → source:"mp"、kind:"mp"、
  //          spec 用 MP 条目（name/target/reward），desktopOnly/unforgeable=false，
  //          canAccept=not_accepted、canLight=accepted（执行在 miniprogram 模块的
  //          小程序头族链路；0.3.0 起进快照/看板与单账号 accept/claim 分流）
  //        ③ 未命中但 jump_url 能解出 expertId=ex_… → expert 类可点亮，
  //          事件 id 钉在解析出的 id 上（expertType=agent，沿用 expert_actual_use）
  //        ④ 未命中且派生不出 → unforgeable:true + reason:"未收录任务"，
  //          绝不进接取批次（防「接了一大堆却一项不亮、领奖报 task not completed」）
deriveExpertIdFromJumpUrl(jumpUrl) -> string  // URL 解码后取 expertId=ex_…；解不出 ""
expertNameFromTitle(title) -> string           // 任务标题「」内的专家名（事件展示字段）
  // opts: {gap=1000, claim=true, log(fn), sleep(fn), signal}
  // 阶段：auto 任务先做 → 批量接取+复查+二次补接 → 逐任务点亮(轮询进度) → 领奖

// travel.mjs
runCatTravel(acct, opts) -> TravelResult
runNightTask(acct, opts) -> NightResult       // black_cat，23:00–08:00（北京时间）
                                              // 01:00 清单暂缺 black_cat 时按 5/15/30s
                                              // 重试（共 4 次、约 50s）；仍没有 → ok:true +
                                              // 日志「未下发，跳过」，不记失败、不领奖

// runner.mjs
class JobRunner {
  start(spec) -> job        // spec: {uids[], legs:['growth','mp','buddy','travel','night'], claim,
                            //       trigger:'manual'|'schedule',
                            //       taskCodes:{uid:string[]}|null}  // 任务级勾选（§3）：
                            //       growth/mp 腿把 taskCodes[uid] 作为 opts.codes 传给
                            //       runGrowthTasks / runMiniProgramTasks；null/缺 uid/
                            //       空清单 = 全部任务。腿顺序固定 growth→mp→buddy→
                            //       travel→night（buddy 在 travel 前，开出的 Buddy 可
                            //       被旅行使用），spec.legs 是这个顺序的子集；
                            //       buddy/travel/night 腿没有任务码。旅行只由 travel
                            //       腿触发（growth 腿显式 travel:false）；growth+mp
                            //       同跑时 growth 腿传 mpTasks:false（小程序任务只由
                            //       mp 腿跑一遍）。
                            //       归一化在两处设防：daemon.startJob（API 边界，§3）
                            //       与 runner.normalizeSpec（直接构造 runner 的调用方）
  get(id) -> Job            // Job: {id, state:'queued|running|done|error', startedAt, endedAt,
                            //       trigger:'manual'|'schedule',   // = spec.trigger 的顶层冗余
                            //       （start() 归一后写两处，永远一致；消费方直接读顶层即可）
                            //       totals:{credit,energy,tasksLit,tasksClaimed}, steps:Step[], log:string[]}
  current() -> Job|null     // 同一时刻只允许 1 个 job（全局闸门）
  // 0.3.3 起 holds() 已被冻结表取代（§10.5）：
  freeze(uid, {code, message}) -> boolean // 首次冻结生效 + onFrozen 落盘；重复不覆盖
  unfreeze(uid) -> boolean                // 解冻（只有它能解除，绝不自动恢复）
  frozen() -> [{uid, at, code, message}]  // /api/state 顶层 frozen 的数据源（at 为 ISO 串）
  isFrozen(uid) -> boolean
                                 //（/api/state 的 scheduler.holds 数据源，daemon 负责拼昵称）
  // 构造 opts 另认：dailySentMap（uid→北京日键的幂等账本，daemon 从
  // state/daily-activity.json 读入同一份对象）与 onDailySent(uid,key)（成功落盘
  // 回调）。每个账号开跑（任何腿）之前 runner 固定调一次 engine/daily.
  // reportDailyActivity：跳过/失败只写一行 job.log（「每日活跃：已上报 /
  // 今日已报过 / 上报失败：…」），绝不阻断腿、绝不 fail job。
  // 小程序次日锁（0.3.2）另认：mpLockedCodes(uid)->string[]（仍锁定的 code，
  // 引擎整条跳过）、onMPLock(uid,code,until,reason)（接取被上游锁拒时落盘）、
  // onMPClaimed(uid,code)（领奖成功时落盘）—— runner 在 growth 腿（2b）与 mp 腿
  // 把它们按账号透传给引擎（lockedCodes/onLock/onClaimed）。
}
```

`Step = {uid, nickname, leg, state:'pending|running|ok|skip|fail', detail, credit, energy, at}`

**时间必须可注入**：所有 sleep/now 走 `opts.sleep/opts.now`，测试里换成假时钟，保证「≥1 s 间隔」可断言、测试秒级完成。
**fetch 同样可注入**：runner/daemon 全程把 `opts.fetch` 透传给 upstream（daemon 亦接受 `startDaemon({fetch})`，并注入到快照刷新、手动领奖/接取/签到等每一路引擎调用），测试以假 fetch 替换全部上游调用，零真实网络。「任意两次上游调用 ≥1 s」在整条链路上成立由两道机制共同保证：腿内由 `makeCtx.breathe`、跨腿由 runner 每腿前补一拍 `gap`；跨路径（job 腿 × 快照刷新 × 手动操作 × token 刷新）由 §0.4 的全局节流器 `makeSpacer` 排队对齐——e2e 曾抓到后者缺失时 0ms 间隔的偶发失败，回归钉死在 `tests/upstream-spacer.test.mjs` 与 `tests-e2e/boundary-throttle.test.mjs`。

## 3. daemon HTTP API（前端唯一依赖；全部 JSON；**免密钥**）

鉴权（**用户明确要求「全部改成免密钥」**，局域网自建工具口径）：**所有路由一律不需要密钥**——包括
`POST /api/run`、`/api/stop`、`/api/task/claim`、`/api/task/accept`、`/api/checkin`、`/api/settings`、
`/api/account/toggle`、`/api/shutdown`、导入确认写盘（`confirm:true`）、含 token 的导出（`secrets=1`）、
SSE 与静态资源。鉴权由**网络边界**负责：默认只绑 `127.0.0.1`；绑定 `0.0.0.0`/`::` 即暴露到容器网桥/
局域网——同一局域网内任何主机都能触发批量任务、写入 `plugin-auth.json`（导入确认）、下载含
accessToken/refreshToken 的导出并关停守护进程（README 安全段如实写明，不粉饰）。

- **单一真相**在 `daemon.mjs` 的 `routeNeedsKey()`（导出供测试）：**恒返回 `false`**，函数注释写明
  「用户明确要求免密钥、局域网自建工具、鉴权由网络边界负责」。若将来要重新引入鉴权，只改这一处。
- `API_ROUTE_AUTH` 保留为**路由登记表**（每条 `{method, re, path, note}`）：任何新路由都必须登记进表；
  「全路由免密钥清单测试」（tests-shell/account-routes.test.mjs）遍历全表证明不存在需要密钥的路径。
- **向后兼容**：旧调用带 `Authorization: Bearer <…>` 或 `?k=<…>` 照常接受（不做任何校验、不报
  400/401），升级期平滑过渡；新集成不需要带。
- `state/daemon.json` 仍写 `key` 字段（0600；`index.mjs`/`lifecycle.mjs` 的探测逻辑与老看板依赖该
  字段存在），**但不再作为访问凭据，任何接口都不校验它**；`KEY_REQUIRED_MSG` 与一切「需要密钥」
  文案已删除，日志与静态兜底页如实描述「无鉴权，靠网络边界（默认只绑 127.0.0.1）」。

**纯国内版口径（用户明确要求「国际版账号彻底不出现」）**：daemon 的**列表/统计/快照/排程/运行/
单账号操作**统一经 daemon 侧唯一的取数过滤 `loadAccountsCn()`（只留 `provider === "workbuddy"`）；
`workbuddy-ai`（国际版）不进 `/api/state` 的 `accounts[]`、不进快照/汇总/统计、不进任何 job。
**过滤只发生在 daemon 使用侧**——`engine/store.loadAccounts` 行为不变（仍返回全部 workbuddy\*
条目：accountio 的导入合并与导出 `realm=intl` 逃生口要全量数据），**别把「只出国内版」的过滤
下沉进 store 层**。诊断计数：`/api/state` 顶层 `intlSkipped:{count,note}` 只给数量与说明，
绝不列出国际版账号内容（uid/昵称/域名都不给）。

**企业版同口径（issue #3）**：`acct.enterpriseId` 非空的企业版账号（provider 仍是 `workbuddy`）
没有成长任务与签到，与国际版完全同口径处理 —— 不进 `/api/state` 的 `accounts[]`（statePayload
的 accounts 过滤点追加企业版排除）、不进 `eligibleNow()`（`eligibleAccounts` 本就排除
`enterpriseId`）/ `/api/run` 缺省 uids / 排程选号 / 快照刷新 / 任何 job；单账号操作
（claim/accept/checkin/streak/run/toggle/快照点名 uid）经 `accountByUid()` 一律「找不到」，
显式点名如实失败（/api/run 混选时企业版被剔除、只点企业版回 400；单账号操作回
「找不到账号」）、绝不静默、零上游。诊断计数：`/api/state` 顶层 `enterpriseSkipped:{count,note}`
（与 `intlSkipped` 同形状，count=0 时字段保留；账号「不存在」/引擎未就绪时同为
`{count:0,note}`），note 只给数量与去向说明（「已忽略 N 个企业版账号：企业版没有成长任务与
签到，本插件只服务个人版」，N 为实际数量），绝不列出企业版账号内容（uid/昵称/域名/
enterpriseId 都不给）。两个计数按 provider 分域、各自独立：国际版只进 `intlSkipped`，
企业版只统计 `provider==="workbuddy"` 的条目，绝不互相重复计数。过滤同样只发生在 daemon
使用侧：导入/导出（§9，导出行本就带 `enterpriseId` 字段）与 `engine/store.loadAccounts`
仍可见企业版条目——**数据面不拦，使用面全拦**。

绑定：`127.0.0.1` 默认；链路 `options.listenAddress → WB_DAEMON_ADDR → --addr`，设 `0.0.0.0`/`::` 才对外
（**免密钥口径下这就是唯一的安全边界**：对外绑定 = 同一局域网内任何主机都能执行上文全部路由，
包括写入凭据与下载 token；README 安全段如实写明风险与建议；真实绑定 host 由 daemon 心跳写进
`daemon.json` 的 `host`，三处日志/提示同口径）。

```
GET  /api/hello                 -> {name, version, ready}
GET  /api/state                 -> {serveUrl, bindHost, port, reachableHint,
                                    intlSkipped:{count,note},   // 只读诊断计数：国际版账号
                                    // 的数量与去向说明（note="本插件只服务国内版 workbuddy，
                                    // 国际版账号不列出、不参与任务、不默认导出"）；绝不列出
                                    // 国际版账号内容（uid/昵称/域名都不给）
                                    enterpriseSkipped:{count,note},
                                    // 只读诊断计数（issue #3）：企业版账号（provider===
                                    // "workbuddy" 且 enterpriseId 非空）的数量与去向说明
                                    //（note="已忽略 N 个企业版账号：企业版没有成长任务与
                                    // 签到，本插件只服务个人版"，N=实际数量；count=0 时
                                    // 字段保留）。与 intlSkipped 同形状同口径、各自独立
                                    // 计数；绝不列出企业版账号内容（uid/昵称/域名/
                                    // enterpriseId 都不给）
                                    accounts:[{uid,nickname,masked,domain,expiresInMs,expiresInDays,tasksEnabled,
                                             imported,eligible,
                                             credits,   // 该账号的积分缓存（state/credits.json 投影，
                                                        // engine/credits.fetchCredits 的 credits 形状，
                                                        // §2）；没拉过/缓存损坏 → null。只读投影：
                                                        // /api/state 绝不为此打上游
                                             snapshot:{tasks:[{code,title,description,acceptStatus,progress:{current,target},
                                             rewardCredit,rewardEnergy,jumpUrl,taskType,
                                             desktopOnly,unforgeable,reason,canAccept,canLight,pinnedExpertId,
                                             locked,lockedUntil,lockHint}],
                                             // locked/lockedUntil/lockHint —— 小程序链式任务次日锁
                                             //（0.3.2，三字段**始终存在**）：locked=true =
                                             // 现在不可接取；lockedUntil="YYYY-MM-DD"（北京
                                             // 日期，无锁 = ""）；lockHint 固定文案
                                             // "到第二天才能接取任务（<until> 起可接）"（无日期
                                             // = "到第二天才能接取任务"，无锁 = ""）。锁定项
                                             // canAccept 一律 false（其余字段不变）。
                                             // **主依据是上游清单自带的 locked/unlock_at**
                                             //（2026-11-07 实测上游直接下发；unlock_at 为带时区
                                             // ISO，Date.parse 后按北京日取，绝不 slice）；locked
                                             // 仅在 not_accepted 时为 true（accepted/claimed 不
                                             // 标锁）；上游 locked:false 覆盖 mp-locks 陈旧锁。
                                             // 仅旧缓存（无自身锁字段）回退 state/mp-locks.json
                                             //（§7；锁过期即解锁，until 当天即可用）
                                             energy,streak,days,updatedISO}}],
                                    // accounts[] 只含 provider==="workbuddy" 的国内个人版
                                    // 条目；国际版 workbuddy-ai 一律不出现（见上方纯国内版
                                    // 口径），企业版（enterpriseId 非空）同样不出现
                                    //（见上方企业版同口径）
                                    scheduler:{enabled,nextRuns[[leg,hour]],lastCycle,
                                               holds:[{uid,nickname,releasedAt}]},
                                    job:Job|null, stats:{creditsToday,energyToday,runs},
                                    settings:{claim,legs,gapMs,hours:{mp,buddy,travel,night},host:{chat,bill,web}}}
                                    // hours 只有 mp|buddy|travel|night 四个键（排程不再触发
                                    // growth，§7/§8）；旧 settings.json 里的 hours.growth
                                    // 在读取时丢弃。**默认全部 [] = 默认不排任何腿，留空
                                    // 即不排**（0.3.2：某条腿显式配了小时才自动跑；用户
                                    // settings.json 里写空的腿保持空，不会被默认值复活）。
                                    // legs（手动默认腿）仍可含 growth。
                                    // bindHost/port/reachableHint：守护进程真实绑定的 host 与端口
                                    // （host 来自 daemon.json，由 daemon 心跳写入；port 为实际绑定端口，
                                    // 被占用顺延后可能与配置值不同）。bindHost 为 0.0.0.0/:: 时
                                    // reachableHint = 「仅容器网桥/局域网可达，请用 SSH 隧道或局域网地址访问，
                                    // 切勿发布到公网」（lifecycle.bindHint 的同一句口径），否则为 ""。
                                    // 两个字段保留原语义（向后兼容），但不再是前端显示地址的来源。
                                    //
                                    // serveUrl：接口保留的访问地址，形如
                                    // http://192.0.2.10:4390/。0.0.0.0/:: 是监听值不是访问值，
                                    // serveUrl 绝不返回它们。看板 UI 已整块移除地址块，
                                    // 不再展示/复制 serveUrl；字段留给宿主、CLI 与其他集成使用。
                                    // 取值链按序取第一个可用项：
                                    //   ① 当前请求的 Host 头——用户实际用来访问的地址，最准确
                                    //     （显式端口进 URL；无显式端口 = 走 80/默认映射，URL 不带端口）
                                    //   ② 环境变量 MAGPIE_PUBLIC_URL（magpie 对外共享地址，运维显式声明）
                                    //     的 hostname + 守护进程自己的端口（不用该 URL 里的端口）
                                    //   ③ bindHost（仅当是具体地址，0.0.0.0/:: 通配不用）
                                    //   ④ 兜底 http://127.0.0.1:<port>/
                                    // Host 头是外部输入，必须过白名单（daemon.sanitizeServeHost）：
                                    // 字符集只允许 字母数字 . - _ [ ] :，总长 ≤255、host ≤253，
                                    // 端口 1-65535 无前导零；host 部分必须是 IPv4 字面量 | localhost |
                                    // 单标签 LAN 主机名 | [IPv6] 字面量，带点的非 IPv4（evil.com 这类
                                    // 公网/伪域名）与含 0.0.0.0/::/* 的值一律拒绝、落到下一级。
                                    // MAGPIE_PUBLIC_URL 是配置输入，放行公网域名，但同样拒绝通配/
                                    // 监听值（IPv6 字面量经 URL 规范化必含 ::，同样拒绝落级）。
                                    // serveUrl 只含 scheme://host[:port]/——**绝不拼入 key
                                    // 或任何查询串**，也绝不返回含 0.0.0.0/::/* 的地址（daemon 的 key
                                    // 字段绝不出现在任何响应、页面或日志里，它只在 state/daemon.json，
                                    // 0600，向后兼容保留、不是访问凭据——API 全部免密钥）。
                                    // description = 上游原文说明（`description || task_desc`，截断 300 字，
                                    // 0.3.3 起投影）：不可自动化 / 需桌面端的行靠它说清「到底要做什么」
                                    //（例：skill_share「升级到电脑端 5.9.0+…」），此前被投影丢掉、看板只剩
                                    // 「未收录任务」一句。普通可自动化任务不展示它。
                                    // snapshot.tasks 的字段名 = §2 的规范 Task（daemon 只做投影，不猜第二种拼写）；
                                    // acceptStatus 是上游字符串状态（"not_accepted"|"accepted"|"completed"|"claimed"）
                                    // P0-2 判断字段（六个都出自 engine/taskkind.resolveTaskKind，
                                    // 与 fetchTasks 的 unforgeable/reason、流水线决策同一判断源；
                                    // 前端据此渲染，不要再用 jumpUrl 非空猜「需桌面端完成」——
                                    // 真实数据 19 项全部有非空 jumpUrl）：
                                    //   desktopOnly —— DESKTOP_ONLY_TASKS 命中
                                    //     （目前只剩 Buddy_App_QQ 这类伪造事件不推进、
                                    //     领奖必 400 的；Library_read 已改走 web 点击
                                    //     事件、RichMeow 已改走 6 条桌面会话事件链、
                                    //     Buddy_App 已改走 5 条 buddyapp_* 桌面事件链，
                                    //     均**不在**此列），
                                    //     与 jumpUrl 形状无关
                                    //   unforgeable / reason —— 已有语义沿用（spec.unforgeable；
                                    //     未收录任务也是 unforgeable:true + reason:"未收录任务"）
                                    //   canAccept —— 现在就能进「接取」= not_accepted && 非 auto
                                    //     && !unforgeable（与引擎 needsAccept 同口径；desktopOnly
                                    //     不挡接取，引擎会接但不点亮）
                                    //   canLight —— 引擎能/会用事件点亮 = kind 可自动化 && 状态可
                                    //     推进（accepted，或 auto 的 not_accepted/accepted）；
                                    //     desktopOnly / 未收录一律 false；black_cat 的 23:00–08:00
                                    //     夜间窗口是运行时判断，不含在内
                                    //   pinnedExpertId —— 非空 = 事件 id 钉死该专家（TASK_SPECS 钉死
                                    //     或 jump_url 派生）；空串 = 不钉 id（expert/team 类走池子
                                    //     轮换，其它 kind 无专家 id）
                                    // 快照缓存（state/snapshots.json）落盘「投影前」的规范 Task +
                                    // snapVersion 版本戳；/api/state 读取时一律用 snapTask 现场重投影
                                    //（读取路径是投影的唯一出口）：旧版 8 键缓存靠重算无损升级（缺的
                                    // 6 个判断字段绝不以 undefined 下发），版本不符且条目缺投影所需
                                    // 字段、无法无损重建时整份 snapshot 返回 null（前端显示「快照已
                                    // 过期，请刷新」；宁可空，不可错）。判断永远来自引擎投影，前端
                                    // 不得按 jumpUrl 形状自行猜桌面端/专家 id（真实数据 19/19 都有
                                    // 非空 jumpUrl，猜了必错）。
                                    // snapshot.energy / streak / days 的读径与 engine 同一口径
                                    // （P1 实测 2026-10-31，两真实账号验证）：energy = data.balance
                                    //（GET /v2/activity/growth/energy），streak/days = data.streak.days
                                    //（GET /activity/growth/streak）；daemon 只认这一种拼写，
                                    // 不做多拼写回退链。
                                    // 0.3.3 起 scheduler.holds 已移除：403/11140 账号改为顶层
                                    // frozen:[{uid,nickname,at,code,message}]（§10.3/§10.5），
                                    // 不再有 releasedAt —— 冻结不会自动恢复
                                    // tasksEnabled 为生效值：accounts.json 显式条目 > engine/store 的
                                    // tasks-accounts.json > 缺省 true
                                    // imported = 该账号行来自 JSON 导入（§9）：importedFrom 标记 ||
                                    // 本插件导入台账 state/hub-imports.json。尽力而为的展示标记
                                    // （magpie 覆写会抹标记、删 state 会丢台账），不作判断依据
                                    // expiresInMs = token 原始剩余毫秒（exp - now，可为负 = 已过期）；
                                    // expiresInDays = ceil 口径的天数（Math.max(0,…)），token 还剩
                                    // 2 小时时会显示 1 —— 区分「不足一天」必须用 expiresInMs。
                                    // 两者在 expires 未知（=0）时均为 null。
POST /api/run                   body {uids?:string[], legs?:string[], claim?:bool,
                                      codes?: string[] | {[uid]: string[]}} -> {job:Job} | 409 {error:"busy"}
                                    // codes —— 任务级勾选（只在 growth 腿生效，CONTRACT §6/§7）：
                                    //   不传 → 全部任务（兼容现状）
                                    //   数组 → 对 job 内每个选中账号都只做这些 code
                                    //   对象 → 按 uid；未出现的 uid 或空数组 = 该账号全部任务
                                    // 归一化在 daemon.startJob 完成（runner spec.taskCodes:
                                    //   {uid:string[]}|null）：每个 uid 的清单去重、只留非空
                                    //   字符串、上限 500；空清单/非法类型一律忽略（落 null），
                                    //   绝不 500。job.spec 透出归一后的 taskCodes。
POST /api/stop                  -> {job:Job}                                  // 取消当前 job
POST /api/task/claim            body {uid, code} -> {ok, credit, energy, reason}
POST /api/task/accept           body {uid, codes[]} -> AcceptResult
POST /api/checkin               body {uids?:string[]} -> CheckinResult[]     // 仅手动，社区插件负责自动签到
POST /api/settings              body 部分 settings -> 新的 settings（写 state/settings.json）
POST /api/accounts              -> 重新读 plugin-auth.json -> {count, eligible, added[], removed[]}
                                    // 纯国内版口径：count = provider==="workbuddy" 的条目
                                    // （含 API key，不参与任务；国际版不计入、不出现）；
                                    // eligible = 可参与任务的 OAuth 账号数（engine.store.eligibleAccounts 口径）
GET  /api/accounts/export?realm=cn|intl&secrets=0|1&uid=a,b&download=1
                                    -> {format:"workbuddy-accounts",version:1,
                                        exportedAt:"YYYY-MM-DD HH:MM:SS",count,accounts:[hub 形状行]}
                                    // hub /accounts/export（wb_proxy.py:19314）移植；语义/文件名/404
                                    // 规则与脱敏行为见 §9；纯国内版口径：不带 realm 只出 cn，
                                    // 显式 realm=intl 才出国际版（逃生口，UI 不提供）；
                                    // secrets 缺省/secrets=1 含 token 真值，secrets=0 脱敏
POST /api/accounts/import       -> 预览/确认两段式（body 形状、响应形状、错误码见 §9）；
                                    // 预览与确认都不需要密钥（免密钥口径）
POST /api/account/toggle        body {uid, tasksEnabled:bool} -> account 行（同 /api/state 的 accounts[] 元素）
                                    // 「参与任务」开关（hub 的 task_active）：写 state/accounts.json 并回读；
                                    // 400 缺 uid / tasksEnabled 非布尔，404 账号不存在；
                                    // 不挡运行中的 job（runner 启动时已定名单，只影响下一轮筛选）
GET  /api/jobs/:id              -> Job
GET  /api/credits?uid=<uid>&refresh=0|1
                                    -> 200 {ok:true, uid, nickname, credits}
                                    | 200 {ok:false, uid, nickname, error, needRelogin?, credits?旧缓存}
                                    | 404 {error}   // uid 找不到 / API key / 已停用 →
                                                    //   "找不到可参与任务的国内版账号：<uid>"
                                                    //   （可参与口径与 eligibleAccounts 一致；
                                                    //   intl 与企业版账号在 accountByUid 里就已经
                                                    //   是「找不到」）；
                                                    //   企业版（enterpriseId 非空，issue #3）→ 专属
                                                    //   文案 "企业版账号没有成长体系（无任务与积分
                                                    //   查询），已从看板隐藏；如需查看请在 magpie 里
                                                    //   切换个人版账号"（说清「为什么看不到」与
                                                    //   「去哪里看」，绝不泄露昵称/域名等额外信息）
                                    | 409 {error:"busy"}  // 要拉取时 job 在跑（或已在拉取中）
                                    | 503 {error}   // 引擎不可用
                                    // 国内版「积分余额 + 套餐权益包明细」（看板 剩余/总额 与明细
                                    // 弹窗的数据源；engine/credits.fetchCredits，§2）。只读，
                                    // 绝不发布 token。缓存：
                                    //   · state/credits.json（{uid: credits}），启动读入，损坏/
                                    //     非对象按 {}；成功拉取后原子写回（writeJson tmp+rename）；
                                    //   · 缓存 < CREDITS_TTL_MS（10 分钟）且未要求 refresh → 直接
                                    //     回缓存，一次上游都不发；
                                    //   · 需要拉取时若 runner.current() 存在（job 在跑）→ 409 busy，
                                    //     避免和 job 抢节流窗口；但「有缓存且未 refresh」时仍直接
                                    //     回缓存（哪怕已过期）——展示优先，绝不硬闯；
                                    //   · refresh=1/true/yes → 无视 TTL 强制拉取（busy 时仍 409）；
                                    //   · 上游失败 → 200 {ok:false,...,needRelogin?}，旧缓存保留
                                    //     （不清掉）并随响应一并带回（credits 字段，若有）；
                                    //   · 拉取成功后广播 SSE {kind:"credits", uid}（可选，前端不依赖）。
GET  /api/history?limit=200     -> 每次尝试一行（对齐 hub 的 /activity/history）
                                    // 行的 trigger 口径：来自 job.spec.trigger（"schedule" |
                                    // "manual"），看板「触发」列据此显示 排程/手动 —— 触发方式
                                    // 住在 spec 上（旧版误读 job 顶层 trigger，真实引擎没有该
                                    // 字段，曾把排程行全写成 manual）；兼容旧式外壳挂在 job 顶层
                                    // 的 trigger，非法值/缺失一律按 "manual"，绝不透出第三种拼写。
                                    // 已写入的旧行不迁移（无法可靠回溯）。
GET  /api/events                -> SSE：{kind:'job'|'step'|'log'|'scheduler', ...}
其余未知 /api/* 路由            -> 404 {error:"未知 API：<METHOD> <path>", hint}
                                    // error 原文逐字不变（既有测试与前端按原文断言/匹配），
                                    // 只追加 hint 指路重启（issue #3 的真实症状：看板比
                                    // 守护进程新时，旧进程没有新路由如 GET /api/streak，
                                    // 用户看到「未知 API」一头雾水）—— hint =
                                    // "守护进程可能还在跑更新前的旧代码：在 magpie 里关掉
                                    // 再开启本插件即可重启（看板顶栏「停止守护进程」后
                                    // 重开也行）"
其余 GET /                      -> dashboard/index.html（静态，同源，无构建）
```

SSE 事件是看板实时进度的唯一来源；断线时看板回退到 `GET /api/state` 轮询 3 s。

缓存口径：静态资源与全部 API 响应一律 `Cache-Control: no-store`（局域网自建看板迭代频繁，
「重载即最新版」是默认行为；刻意不发 `ETag`/`Last-Modified`，no-store 之下条件请求只增加新的
失效模式）——唯一例外 `GET /api/events` 保持 `Cache-Control: no-cache`（no-store 的 SSE 长连接
在部分代理下会断流）。取舍细节以 `daemon.mjs` 的 `json()`/`serveStatic` 注释为单一真相。

## 4. 生命周期（「跟随 magpie」+「插件管理里启停生效」）

- `index.mjs` 被宿主加载时（= 插件已启用且 magpie 用到了它）：
  1. 读 `state/control.json` 的 `desired`（`'on'|'off'`）；
  2. `desired!=='off'` → `ensureDaemon()`：探测端口健康 → 不健康才 spawn `Bun.spawn([bunPath,'daemon.mjs'], {detach:true, stdio:'ignore'})`，env 传 `WB_CONFIG_DIR`、`WB_DAEMON_KEY`、`WB_DAEMON_PORT`；
  3. 注册 `process.on('exit'|'SIGINT'|'SIGTERM')` → 若我们是 owner 则 `POST /api/shutdown` 通知 daemon 退出。
- `daemon.mjs` 自持生命周期，不依赖宿主存活假设：
  1. 每 10 s 读 magpie `plugins.json`：本插件条目 `off:true` → 优雅退出；
  2. 每 15 s TCP 探测 magpie（`MAGPIE_ADDR`/`127.0.0.1:3425`，失败再试 3430）：连续 4 次失败（magpie 停了）→ 退出；
  3. 每 5 s 刷新 `state/daemon.heartbeat`（mtime）+ 写 `state/daemon.json`（pid/port/key/version）；
  4. 收到 `/api/shutdown` 或 `control.json.desired==='off'` → 停排程、停 job、退出。
- 看板的「停止/启动」按钮 = 写 `control.json` + 让 daemon 自杀/由下次宿主加载或 CLI 拉起。
- `control.json` 是唯一意图来源；崩溃重启后按它决定要不要跑，避免僵尸守护进程。

## 5. 不声明 provider（只提供页面与 MCP 工具）

**本插件不声明 provider**：`index.mjs` 的 hooks 只有 `tool`（契约 §6），没有 `auth` / `config`。
历史：早先版本声明过一个无模型 provider「workbuddy-tasks」（`models:{}`）只为给 magpie 一个
加载理由；但它让 magpie 在供应商卡里显示「未登录」+ 登录按钮——用户既不需要也无法为它登录
（任务凭据永远共享读 magpie 已登录的 workbuddy 账号），纯造成困惑，已移除（连带 `auth.usage`、
`PROVIDER_ID` 等死代码）。后果与口径：

- magpie 的「供应商」列表不再出现本插件，没有任何「登录/添加账号」入口——这是预期行为；
- 对话链路照旧全权归 `@magpie-community/opencode-workbuddy-auth`（`workbuddy` / `workbuddy-ai`
  两个 id 我们本来就不碰，铁律 §0.1；provider id 撞车才会变 `-plugin` 后缀的顾虑随之消失）；
- **加载理由**：插件仍有 `package.json` 的 `magpie.page`（入口卡），且不是「只有页面」的插件——
  `tool` 钩子在，magpie 仍会为工具启动插件宿主、调用 `index.mjs` 的入口函数，
  `ensureDaemon` 生命周期（契约 §4）因此照常运转；
- `auth.checkin` 与 `auth.usage` 随 provider 一起不存在（每日签到归社区插件；用量数字看板与
  `workbuddy_tasks_status` 工具都有）。

## 6. `tool` 钩子（MCP `/mcp/magpie/tools`，单次执行上限 55 s）

```
workbuddy_tasks_status()                 -> 账号/排程/当前 job 摘要（纯文本）
workbuddy_tasks_run(uids?, legs?, claim?, codes?) -> 启动 job，立即返回 job id（不等待）
                                            // codes?: string[] —— 任务级勾选，对所有选中
                                            // 账号生效（= §3 的数组形状，daemon 归一化）
workbuddy_tasks_wait(jobId, maxSeconds?)  -> 轮询到完成或超时，返回进度与结算
workbuddy_tasks_list(uid?)                -> 任务表（code/标题/接取状态/进度/奖励）
workbuddy_tasks_claim(uid, code)          -> 单个领奖
```
工具只走 daemon 的 HTTP API（`http://127.0.0.1:<port>`），自己不执行长任务——55 s 装不下一轮批量。

## 7. 上游要点（引擎必须逐字遵守，细节以 `engine/constants.mjs` 落地）

- 聊天侧：`GET {chat}/v2/activity/growth/tasks`、`POST .../tasks/accept`（`{task_codes:[...]}`，20 一批）、
  `POST {chat}/activity/growth/tasks/{code}/claim`（HTTP 400「task not completed」→ 试一次 web 回退）、
  `POST {chat}/v2/report`（**body 是事件数组**）、`GET {chat}/v2/activity/growth/energy`、
  `GET {chat}/activity/growth/streak`、`GET {chat}/activity/growth/heatmap`、
  `POST {chat}/activity/growth/makeup-cards/use`、`GET .../lottery/summary`、`POST .../lottery/draw`、`POST .../redeem`、
  猫猫：`GET .../buddy/travel/status|config`、`POST .../buddy/travel/depart`（body `{location_id}`）、`POST .../buddy/travel/claim`。
- **Buddy 盲盒（engine/buddy.mjs，独立腿，消耗成长能量）**：
  `GET {chat}/v2/activity/growth/buddy/quota` → `data.affordable`（还能开几个）/
  `data.max_open_count`（单次上限）；`affordable<=0` → ok:true +「成长能量不足以开启
  Buddy 盲盒」，**绝不发 open**。`count = min(affordable, max(1, max_open_count))`，
  `POST {chat}/v2/activity/growth/buddy/open` body `{count, client_token:<randomUUID>}`；
  成功解析 `data.buddy || data.name || data.buddies`（数组 join）。**不领积分、不加
  credit**——本腿的产物只有 logs/opened。403/11140 → restricted 透传（runner 冻结账号，§10.5）。
  腿顺序在 travel 之前（开出的 Buddy 可被旅行使用）；排程窗口可配但默认
  `hours.buddy=[]`（不给明确授权绝不自动花能量）。
- **微信小程序链式任务（engine/miniprogram.mjs，Sequential_Tasks_1–6 + school_season）**：
  清单/接取/领奖走同一批 growth 端点但带 **MP_HEADERS**（`X-Client-Platform:
  miniprogram` + MicroMessenger UA）；事件上报打 chat 域 `/v2/report` 但头 = chat
  头族 + **MP_REPORT_HEADERS**（`X-Client-Product: workbuddy-mp`、
  `X-Client-Platform: mp-weixin`、`X-Platform: wechatmp`、`X-Client-Version: 2.4.0`），
  事件体逐条合并 **mpBase**（`ideType:"WorkBuddy_MP"`、`extName:"workbuddy-mp"`、
  `platform:"mini_program"`、`machineId:"mp-<uid 前 16 位|guest>"`、
  `timezone:"Asia/Shanghai"`、`os:"android"/osVersion:"14"/arch:"arm64"`、userId/
  userNickname/timestamp）。per-code 事件（hub 937c179 逐字）：1/3/6/school =
  `chat_request_send`（`agentName:"mp"`、`agentType:"main"`、带
  `codebuddy.session_id`/`codebuddy.conversation_request_id` 点键名）；2 =
  `expert_actual_use`（id/name `WorkspaceBuilder`、`expertTitle:"工作台搭建师"`、
  `type:"send_message"`、`extVersion:"2.2.8"`）；4 = `automated_task_create_suc`
  （`mode:"CLOUD"`、`name:"每日任务提醒"`、`scheduleType:"daily"`）；5 = chat_request_send
  + `requestModelId:"glm-5.2"`/`requestModelName:"GLM-5.2"`。整个 need 的事件一次
  report 发完（不逐条轮询进度），等 1.5s 直接领，领不到顺延下轮。web 侧的
  `Sequential_Tasks_7`（PC灵感功能，playbook 双事件）在 TASK_SPECS，不在 MP_TASK_SPECS。
  **2026-11-11 生产实测：ST7 同时出现在 web 清单与 MP 清单**（两份原始 JSON 均带
  `accept_status`/`locked`/`unlock_at`，MP 侧 jump_url 是 settings 桌面下载页）——
  `isMPCode` 的前缀兼容分支**排除 TASK_SPECS 命中**，ST7 在两条链路里都只按 web
  playbook 任务处理：MP 清单过滤直接无视它（不进「发现 N 个小程序任务」），daemon
  doAccept/doClaim 分流归 web 组，执行走 tasks.buildEvent 的 playbook 双事件链。
  **小程序任务进任务快照/看板（0.3.0 起，生产实测 MP 清单 12 项含
  Sequential_Tasks_1）**：daemon.refreshSnapshots 在 web fetchTasks 之后用
  `fetchMPTasks`（MP_HEADERS）再拉一份 MP 清单，**只合并 web 清单里没有的 code**
  （同一 code 以 web 清单为准，绝不重复/覆盖 web 状态）；MP 拉取失败只记日志，
  不影响 web 快照。判定走 taskkind 的 `source:"mp"` 分支（MP_TASK_SPECS 命中或
  `Sequential_Tasks_` 前缀 → kind:"mp"、desktopOnly/unforgeable=false、
  canAccept=not_accepted、canLight=accepted，TASK_SPECS/jump_url 优先级不变——
  Sequential_Tasks_7 永远是 playbook）。单账号操作同样分流：`/api/task/accept`
  按 `isMPCode` 把 codes 分成 web/MP 两组分别用 `acceptTasks`/`acceptMPTasks`
  （结果合并，形状不变）；`/api/task/claim` 对 MP code 用 `claimMPTask`，否则
  `claimTask`。引擎侧防御：tasks.progressTask 对 kind:"mp" 一律跳过 web 事件构造
  （「小程序任务由小程序链路处理」）。runGrowthTasks 2b 在普通任务之后、猫猫旅行
  之前调用，`opts.mpTasks===false` 可关，`opts.codes` 勾选只
  处理 MP 交集（交集为空连清单都不拉），缺失警告用 `MP_TASK_CODES` 过滤防误报。
  **mp 独立腿（0.3.2）**：JobRunner 的 LEG_ORDER 增至 growth→mp→buddy→travel→night，
**0.3.3 再增至 growth→mp→streak→buddy→travel→night（`streak` 见 §10.1）**，
  mp 腿直接调 `runMiniProgramTasks`（codes 勾选、restricted、收益/lit/claimed 计入
  totals 与 growth 腿同口径，step detail 取最后一条日志）；同一次 job 同时含
  growth 与 mp 腿时，growth 腿传 `mpTasks:false`（2b 关闭）—— 小程序任务只由 mp
  腿跑一遍；只有 growth 腿时保持原 2b 行为。
  **次日锁（0.3.2 修订：2026-11-07 只读实测——上游清单本身就带锁字段，实测账号 B 的
  Sequential_Tasks_3 为 `"locked": true, "unlock_at": "2026-11-08T00:00:00+08:00"`、
  实测账号的 Sequential_Tasks_2 为 `"locked": false`（not_accepted，当天已解锁）；
  2026-11-11 再实测：**web 清单任务同样带锁字段**——Sequential_Tasks_7 为
  `"locked": true, "unlock_at": "2026-11-12T00:00:00+08:00"`）**：
  - **主依据 = 任务自身字段**：fetchMPTasks 与 fetchTasks 都把 locked/unlock_at
    原样归一进规范 Task（缺失归一 false/""）并随 cacheTask 落盘；snapTask 投影时任务带自身锁
    信息（locked 是布尔或 unlockAt 非空）→ **以上游为准**，locked 仅在
    not_accepted 时为 true（accepted/claimed 绝不标锁），lockedUntil 由 unlock_at
    解析为北京日（Date.parse + 北京日，绝不 slice），解析失败回退 mp-locks 的
    until；上游 `locked:false` 必须能覆盖 mp-locks 里的陈旧锁；仅旧缓存（无自身
    锁字段）回退 mp-locks 锁表。**没有任何「按领奖日期推断链式锁」的逻辑**
    （inferMPLockChain 已删——它会把手动/旧版本已领奖的历史任务多锁一天）；
  - mp-locks.json 只剩两个防御/过渡用途（`{locks:{uid:{code:{until,reason,at}}},
    claims:{uid:{code:"YYYY-MM-DD"}}}`，原子写、启动归一、损坏条目逐条丢弃）：
    ① accept 被上游锁拒时从失败消息（`parseMPLock`，容忍中文/空白）解析落盘的
    显式锁（onLock 回调 + doAccept 防御性二次解析，兼容假引擎/旧引擎）；
    ② doClaim/onClaimed 领奖成功给下一环（Sequential_Tasks_N 的 N+1，N<6）记
    「明天」的即时锁 —— 只在旧缓存回退路径可见，下一次快照刷新后必被上游字段
    覆盖。`until > 北京今天` 才算生效（**until 当天即解锁**），同一 code 取更晚；
  - runner 经 mpLockedCodes/onMPLock/onMPClaimed 透传给 growth 2b 与 mp 腿：
    执行时双来源锁定任务整条跳过（不进接取批次、不点亮、不领奖，日志「⏳ …到
    第二天才能接取任务，跳过」）—— 清单自带 t.locked===true（上游权威）与
    lockedCodes 台账任一命中即跳，claimed 优先判断不被锁挡「已领奖」日志；
  - 投影：snapTask(t, lock) → `locked/lockedUntil/lockHint` 三字段始终下发（§3），
    锁定项 canAccept=false。
- 计费侧：`POST {bill}/billing/meter/claim-gift|claim-compensation`、`POST {bill}/v2/billing/meter/daily-checkin`、
  `POST {chat}/v2/billing/meter/checkin-activity-status`。
- **积分余额（只读，engine/credits.mjs，wb_accounts._fetch_credits_cn_detailed 口径）**：
  `POST {bill}/billing/meter/get-user-resource-summary`（body `"{}"`）、
  `POST {bill}/billing/meter/get-user-resource-free-packages`（`{PackageCodes,PageNumber:1,PageSize:200,Status:[0]}`）、
  `POST {bill}/billing/meter/get-user-resource-paid-packages`（`{同上, Status:[0,3], NeedRenewInfo:true}`）；
  头族 = billing 头 + `X-Client-Platform: web`；PackageCodes 取 summary `data.Packages[].PackageCode`
  去重，free/paid 单个失败忽略该来源。到期语义：优先认 `DeductionEndTime`（epoch ms，积分到这个点
  不能再抵扣即作废；免费包/体验版的 `CycleEndTime` 只是每月计费边界，两者能差 8 年），>730 天按
  「不过期」处理（上游拿远超真实周期的哨兵值表示永不过期）；**naive 字符串时间一律按北京时区
  (+08:00) 解析**（容器时区可能是 UTC，绝不能当本地时间）。summary 无 `IsPaidUser` 字段时 tier=null，
  绝不瞎判免费。
- 刷新：`POST {chat} + engine/constants.REFRESH_PATH`，头 `X-Refresh-Token`、`X-Auth-Refresh-Source: workbuddy`、`X-Domain`；响应 `data.accessToken`(+轮换的 `data.refreshToken`)，可能嵌套 `data.data`。
- 事件必须有 `userId`（缺了服务端 200 但静默丢弃）。
- 进度只在**已接取**任务上累计；专家/团队事件按 `(eventCode,id)` 去重 → 必须轮换 id 池；
  `WorkBuddy_Valorant` 钉死真实 id `ex_xQHHD1u5Jkua`，`Expert_lighthouse` 钉 `ex_2cvvUZQhDyeJ`，
  `workstation_expert` 钉 `WorkspaceBuilder`（工作台搭建师；hub 937c179，id 不是 ex_ 形态）。
- **未收录任务（P0-1）**：上游会返回 TASK_SPECS 之外的任务（2026-10-31 实测每账号
  19 项里有 5 项不在 specs，其中 4 个 `expert_use_*` + 若干随版本漂移的 活动 任务）。
  处理规则（engine/taskkind.resolveTaskKind，优先级从高到低）：
  1. TASK_SPECS 命中 → 沿用 spec（`Expert_lighthouse`/`WorkBuddy_Valorant` 的 jump_url
     只有 `workbuddy://expert`，不含 expertId —— 钉死常量仍是唯一来源，绝不被 jump_url 覆盖）；
  2. MP_TASK_SPECS 命中或 `Sequential_Tasks_` 前缀（**不在 TASK_SPECS**——
     Sequential_Tasks_7 在 TASK_SPECS，是 web playbook 任务，绝不被本条吃掉，
     2026-11-11 实测它同时出现在两份清单）→ 小程序链式任务（0.3.0 起进快照/
     看板）：`source:"mp"`、`kind:"mp"`，desktopOnly/unforgeable=false，接取/点亮结论
     按状态收敛；执行与领奖在 miniprogram 模块的小程序头族链路（见下）；
  3. 未命中但 `jump_url` 解出 `expertId=ex_…`（`expert_use_*` 一族：URL 编码的 deeplink
     查询串里，如 `…launch/?deeplink=workbuddy%3A%2F%2Fexperts%3FexpertId%3Dex_GDl31WahyIH0
     &buddy_type=workbuddy`）→ 视为 expert 类可点亮任务，**事件 id 必须钉在解析出的 id 上**
     （上游按 `(eventCode,id)` 去重，池子里的通用 id 对它不推进进度 —— Valorant 同款坑），
     `expertType` 用 `agent`，事件其余字段沿用 `expert_actual_use` 形状；专家名从任务
     标题「」内提取（仅展示字段，进度只看 id）；
  4. 未命中且派生不出 → `unforgeable:true` + `reason:"未收录任务"`：不接取、不上报、
     不领奖，**绝不放进批量接取批次**（否则「接了一大堆却一项不亮、领奖报
     task not completed」）；`desktopOnly`/`canAccept`/`canLight`/`pinnedExpertId`
     随 daemon 投影下发给前端（§3）。
- **连登/能量字段口径（P1，2026-10-31 两真实账号只读实测）**：
  `GET /v2/activity/growth/energy` → `data.balance`（data 里另有 total_consumed/
  total_earned，没有 energy/value 键）；
  `GET /activity/growth/streak` → `data.streak.days`（`makeup_cards.balance`、
  `redemption_status` 同层；data 顶层没有 days/streakDays 键）。连登为 0 是真实值
  （`streak.days` 与 `month_total_days` 是两个字段，前者才是连登天数）。
  daemon 快照读同一路径，不做多拼写回退链。
- DESKTOP_ONLY 任务（目前只剩 `Buddy_App_QQ`）与 `unforgeable`
  （`wb_wechat_oa_subscribe_task`/`Expert_Philanthropy`）不上报、接不上，只展示 `jump_url`。
  **`Buddy_App` 不在此列**（2026-11-06 实测）：5 条 `buddyapp_*` 事件 + 桌面指纹一次上报，
  进度 0→1 并领奖 +100，见 `buildEvent` 的 `kind:"buddy5"` 与 `reportBuddy5Events`。
  **`Library_read` 不在此列**（2026-11 修正）：它由 web 端的一次元素点击事件点亮 ——
  `engine/tasks.reportLibraryEvent` 向 **web 域** `webBase()/v2/report` 发一条
  `web_element_click`（数组包一层），字段逐字为：
  `{eventCode:"web_element_click", timestamp, reportDelay:0,
    pageURL:"https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm",
    elementId:"library_doc_intro_click", elementName:"WorkBuddy资料库介绍",
    os:"Win32", arch:"", osVersion:"10.0", userAgent:<WEB_UA>,
    machineId:deriveId(uid,"webmachine"), userId:uid, userNickname:<昵称>}`；
  头族用 `webHeaders(acct)` 并覆盖三处：`Referer`=该文档 URL、`User-Agent`=同一个
  WEB_UA（与事件 userAgent 同值，冒充同一次浏览器会话）、`X-User-Id`=空串（web 端
  点击事件的真实形态，身分靠 Authorization 与事件体携带）；`Authorization` 保留。
  `callJSON` 的 `init.headers` 支持自定义头**大小写敏感**合并，唯 `Authorization`
  无论大小写写法都不可被覆盖（凭据头红线）。流水线里 `kind==="library"` 走这条路
  （每次 need 循环一条，日志「正在点亮任务 [浏览资料库]（web 点击事件）」），
  进度/领奖与其它任务同一套轮询。
- **每日活跃（点亮成长中心连登，engine/daily.mjs）**：每个账号每个**北京日**一条
  `chat` 事件，打**计费域** `billBase()/v2/report`（不是 chat 域）。触发点是 runner
  的每账号开跑之前（无论 job 跑哪些腿、也无论账号处于哪个 leg）；幂等键 =
  `uid → 北京日键`（`beijingDayKey`，UTC+8，UTC 16:00 翻北京日），账本由 daemon
  持久化在 `state/daily-activity.json`（`{uid:"YYYY-MM-DD"}`，启动读入、`onSent`
  经 writeJson tmp+rename 原子写回；文件损坏/形状不对按空对象起步，不阻断启动，
  顶多重发一条——上游按北京日幂等，无害）。成功才落账 + 回调 `onSent`；失败返回
  `{sent:false,error}` 不抛，runner 记一行日志（「每日活跃：已上报 / 今日已报过 /
  上报失败：…」）继续跑腿，绝不 fail job。上游调用经 `reportEvents` → 全局节流器，
  铁律 4 照常生效。`/api/state` 不新增字段。
- **时间口径（排程/夜猫窗口，与容器时区无关）**：生产 magpie 容器时区是 **UTC**
  （`date` 显示 UTC、`TZ` 为空），`new Date().getHours()`/`toDateString()` 读的是宿主
  时区，会把北京 09:00 读成 1 点。因此**小时窗口（settings.hours）、夜猫子
  23:00–08:00 窗口、排程「同日同窗口只触发一次」的去重日界一律按北京时间
  （UTC+8）解释，与容器/宿主时区无关**——实现为 `engine/constants.beijingHour` /
  `beijingDateKey`（UTC 毫秒 +8h 后取 UTC 分量），与 `engine/daily.beijingDayKey`、
  credits 的「naive 时间按 +08:00 解析」同一口径。`settings.hours` 的数字含义不变，
  仍是北京小时；`lastFired.json` 旧键（宿主时区口径）不做迁移，键形不同互不命中，
  最坏只多触发一个窗口，绝不清空用户文件。
- `first_buddy` 是 `task_type==='auto'`：不许进接取批次，必须先点亮+领奖，否则单任务接取报 `prerequisite not met`。
- 领奖竞态：上报后等 1.5 s，轮询进度最多 6 次（在涨就再等 2.5 s），没到位就把领奖顺延到下一轮，绝不硬闯。
- **任务级勾选（`runGrowthTasks` 的 `opts.codes`，§2/§3/§6）**：非空数组 = 只对选中的任务
  接取/点亮/领奖；**每次 `fetchTasks` 之后都按选中集合过滤**（含接取后的复查重取）——未选中的
  任务不进 auto 前置、不进批量接取批次、不轮询进度、不领奖，上游状态原封不动。选中但任务表里
  不存在的 code 记**一次**警告并跳过，绝不硬闯。未传/空数组/非法类型 = 全部任务（旧行为）。
  「清单拉空」的失败判断按**过滤前**的整表算——勾选过滤后为空是正常现象（选中任务都不在表里），
  不是拉取失败；此时跳过任务阶段、照常做猫猫旅行与能量结算。

### 7.1 hub 移植的时间单位：expiresAt = epoch 秒，magpie expires = epoch 毫秒（双向换算）

**结论**：hub 导出文档/凭据档里的 `expiresAt` 单位是 **epoch 秒**；magpie `plugin-auth.json` 里的
`expires` 单位是 **epoch 毫秒**。换算：hub→magpie `×1000`；magpie→hub `floor(÷1000)`（<1s 精度
丢弃，对过期判断无影响）。`0` 在两边都表示「未知」，绝不当作 1970。

**Python 源码证据**（本仓库 `/tmp/wbsrc/repo` 快照，逐行核对）：

| 证据 | 行号 | 内容 |
| --- | --- | --- |
| 写入处 | `wb_accounts.py:919-920` | `self.expires_at = (0 if self.is_api_key else normalize_epoch(data.get("expiresAt")) or jwt_exp(token))` —— `jwt_exp()` 返回 JWT `exp` 声明（RFC 7519 恒为秒），:514-518 |
| 归一处 | `wb_accounts.py:526-533` | `normalize_epoch()`：`if number > 1e11: number /= 1000.0` —— >1e11 一律当毫秒除成秒，内部表示是秒 |
| 比较处 1 | `wb_accounts.py:1230-1232` | `public()`：`exp = self.expires_at or jwt_exp(...)`；`now = time.time()`；`is_token_expired = … (exp and exp <= now)` —— 与 **`time.time()`（秒）** 比较 |
| 比较处 2 | `wb_accounts.py:1829-1831` | `exp - now <= 120` → 「凭证已过期」，`now` 由调用方传 `time.time()`（秒）；`ready()` 同款 `remaining = exp - time.time()`（:1817 起） |
| 反证（毫秒口径的存在） | `wb_accounts.py:5413-5414` | cockpit snake_case 行注释：**「expires_at is milliseconds, which normalize_epoch() below converts to seconds」** —— 外来毫秒值只在入口处被换算成秒，内部从不是毫秒 |
| magpie 侧 | 真实 `plugin-auth.json` | `expires` 全部为 13 位毫秒值（如 1.79e12），9 个条目无一例外 |

**为什么必须写死**：单位搞错会让导入账号「立刻已过期」（秒值当毫秒读 = 1970 年）或
「永不过期」（毫秒值当秒读 = 5 万年后），且智能合并的分支会**静默走错**（未过期判成已过期 →
把在用的新 token 换成 JSON 里的旧 token）。tests 里有专门防秒/毫秒混淆的用例
（`tests/accountio-import.test.mjs`：双向换算 + 智能合并分支在秒/毫秒两套输入下结论一致）。

## 8. 测试门槛（没有这些不算完成）

`bun test` 全绿，且**零真实网络**（`fetch` 注入 mock）：
- `deriveId` 对固定 uid 输出稳定、UUIDv4 形状、machine≠session；
- 信封：`code!==0` → 失败；`403/11140` → restricted；TLS reset → 走 web 回退且 `X-Domain` 不变；
- 事件：每种 kind 的 `eventCode` 与必填字段逐个断言；`userId` 必在；
- 流水线：假账号跑完整轮 → 断言「接取在未接之前」「领奖在进度到位之后」「两次上游调用间隔 ≥1000 ms」「DESKTOP_ONLY 被跳过」「auto 任务不进接取批次」；
- 任务级勾选（§3/§7）：`opts.codes` 非空 → 只对选中任务接取/点亮/领奖、未选中任务上游状态
  原封不动、缺失 code 警告一次；runner 把 `spec.taskCodes[uid]` 原样传到 growth 腿、travel/night
  不受影响、脏输入归一成 null；daemon 把 `/api/run` 的数组/按 uid 对象两种形状归一到
  `taskCodes`（去重/剔非字符串/上限 500/非法忽略）；
- schedule：窗口判定（09:00/21:00 猫猫旅行，01:00 夜猫，夜猫只认 23:00–08:00；
  **一律按北京时间（UTC+8）解释，与容器时区无关**——测试必须用显式 UTC 时间戳证明
  `beijingHour(Date.UTC(...,1,0))===9`、UTC 01:00 命中 travel 而绝不能是 night、
  UTC 17:00（北京次日 01:00）命中 night、`beijingDateKey` 在 UTC 16:00 翻北京日、
  `dueWindows` 跨北京日边界不重不漏；**growth 不在任何排程窗口**——排程只触发
  mp/buddy/travel/night，growth 只能手动跑；**默认 hours 全空 = 默认不排任何腿**
  （0.3.2：`DEFAULT_SETTINGS.hours={mp:[],buddy:[],travel:[],night:[]}`，留空即
  不排；用户显式写空的腿保持空、不会被默认值复活，升级用户已配置的 travel/
  night 窗口照常生效）；daemon 回归用假时钟驱动 `checkScheduler`：
  hours 全空 + scheduler=true 时任何北京整点都不触发、settings.json 只写
  `hours:{travel:[]}` 时北京 09:00 不触发、显式配 `travel:[9]` 后北京 09:00
  （UTC 01:00）启动 `legs:["travel"]`、
  显式配 night 后北京 01:00（UTC 17:00）启动 night、同一北京日同窗口只触发一次、
  跨北京日（UTC 16:00 边界）重新允许；daemon 读旧 settings.json 时
  丢弃 `hours.growth`、`/api/state` 的 hours/nextRuns 无 growth、tick 不触发 growth job、
  手动 `legs:["growth"]` 照常启动；buddy/mp 显式配小时后 nextRuns 含对应腿、tick 触发
  对应 job；
- 去重：`expert_5` 五个事件用 5 个不同 id；
- 资料库（Library_read）：reportLibraryEvent 的事件字段/头逐字断言（web 域、
  Referer/UA/X-User-Id 覆盖、Authorization 保留）；callJSON 的 init.headers 合并
  —— 大小写敏感覆盖、Authorization 不可被覆盖（精确大小写与小写两种写法都剥掉）；
  流水线 0/1 → web 点击 → 进度 0→1 → 领奖；desktopOnly 投影只剩 Buddy_App_QQ
  一条，Library_read desktopOnly=false、accepted 可点亮，RichMeow desktopOnly=false、
  接取后可点亮（6 连），Buddy_App desktopOnly=false、accepted 可点亮（5 连、
  专用桌面头上报）；
- RichMeow（RichMeow_Chat，kind:"richmeow"）：buildEvent 恰好 6 条链事件、
  顺序与 timestamp（+20 步进）钉死；整条链**一次 report** 发完；流水线里
  agent_task_completed 推进进度 → 领奖成功；snapTask 投影接取后 canLight=true；
- 每日活跃：北京日键 UTC+8 翻日；同一北京日第二次不重发（skipped）、跨日（注入
  now）再发；失败不落账不回调不抛；请求打计费域 /v2/report 且事件含 userId；经
  spacer；runner 每账号开跑前一次、失败不阻断腿；daemon 持久化
  state/daily-activity.json 读写、损坏回空不阻断启动；
- kind 解析（taskkind）：jump_url 派生专家 id（编码/裸/双重编码/解不出）、TASK_SPECS
  优先（Valorant 钉死 id 不被 jump_url 覆盖）、六类任务 × 四状态 canAccept/canLight
  矩阵、真实形态 19 项投影全表 + 批量接取 codes 与 canAccept 逐项一致（未收录绝不进
  批次）、快照 energy/streak 只认 data.balance / data.streak.days（毒键不误读）；
- store：回写只改 access/refresh/expires，保留未知字段，产出合法 JSON 且权限 600；
- runner：两个 `start()` → 第二个 409；`stop()` 能在步骤边界中止；
- Buddy 盲盒（engine/buddy.mjs）：quota/open 两跳的批量口径（count=min）、能量
  不足零开盒请求、restricted 透传、不领积分；runner 腿顺序 growth→mp→streak→buddy→travel→night（0.3.3 起含 streak）
  （乱序入参归一、未知腿剔除）、buddy 步骤 detail=最后一条日志且 credit=0；
- 小程序链式任务（engine/miniprogram.mjs）：MP 头族与 mpBase 逐字断言、per-code
  事件族（1/3/6/school/2/4/5；Sequential_Tasks_7 无事件）、claimed/completed/
  not_accepted 三态、codes 交集过滤（交集为空零上游）、≥1s 节流、runGrowthTasks
  集成（2b 顺序、收益并入 totals、mpTasks=false 关闭、MP code 不误报缺失）、
  次日锁（fetchMPTasks 透传 locked/unlock_at、parseMPLock 正/异常输入、
  failures+onLock、lockedCodes 整条跳过、上游字段优先——locked:false 覆盖
  mp-locks 陈旧锁、Z 时区 unlock_at 按北京日取、accepted/claimed 不标锁、
  accept 失败落盘 + doClaim 即时锁下一环→刷新后被上游覆盖、snapTask 17 键含
  locked/lockedUntil/lockHint）、
  isMPCode 的 TASK_SPECS 排除（Sequential_Tasks_7=false、Sequential_Tasks_99=true、
  MP_TASK_SPECS 全 true；taskkind 对 ST7 仍 source:"spec"/kind:"playbook"）、
  web 清单锁字段（fetchTasks 透传 locked/unlock_at，缺失归一 false/""）、
  web 流水线锁定跳过（locked:true 不进 accept 批次、不 report、不 claim，
  日志「⏳ …到第二天才能接取任务，跳过」，needsAccept 复查不再误报「仍有 N 个
  未接取」；locked:false 解锁后照常接取/点亮/领奖）、
  旅行只由 travel 腿触发（legs=[growth] 零 travel/status、legs=[growth,travel]
  恰好一次）、mp 腿（单独 legs=[mp] 不发 web 接取；growth+mp 只执行一遍 MP）；
- 沙箱卫生：测试 temp 沙箱一律走 `tests/helpers.mjs` 的 `makeSandbox()`（用完即删 + after/exit 兜底），跑完套件 temp 不残留 `wb-*` 沙箱（`tests/sandbox-hygiene.test.mjs` 钉死）。

## 9. 账号 JSON 导入 / 导出（hub 移植口径；engine/accountio.mjs）

WorkBuddy 账号在机器之间以一份自描述 JSON 迁移（hub `wb_accounts.py` 的 export/import 移植）。
**产品口径（已定，不得扩张）**：只同步国内版（`realm==="cn"` → provider `workbuddy`）；国际版
一律不导入（rejects，reason「只同步国内版 workbuddy，国际版账号不导入」）；**导入直接写 magpie 的
`plugin-auth.json`，绝不建第二份私有账号库**（同账号两条 token 血统会在 refresh 轮换时互相踢下线）。

### 9.1 导出（`GET /api/accounts/export`）

```
GET /api/accounts/export?realm=cn|intl&secrets=0|1&uid=a,b&download=1
  -> {format:"workbuddy-accounts", version:1, exportedAt:"YYYY-MM-DD HH:MM:SS",
      count:N, accounts:[hub 形状行]}
```

- 语义照 hub `_get_accounts_export`（wb_proxy.py:19314），但 **realm 默认值按纯国内版口径收窄**：
  不带 `realm`（或任何非 `intl` 值）**只导出国内版**；显式 `realm=intl` 才导出国际版——这是给 hub
  备份场景留的**逃生口**（UI 不提供此入口，只存在于 API 层，导出的文档可再回灌本插件的导入）。
  `uid` 逗号分隔可重复（不在所选 realm 范围内的 uid → `404 {error:"no such account: …"}`，默认
  范围里的国际版 uid 同样 404）、`download=1` 走 `Content-Disposition: attachment`（文件名规则同 hub，
  见下）、`secrets=0|false|no` 按 hub 行为**删除 accessToken/refreshToken 两键**（其余字段保留）。
- **secrets 缺省 = 1（含 token）**；`secrets=0` 脱敏。免密钥口径下两种取值都不需要密钥（§3）。
- 文件名（hub :19347-19353 + `_download` :18706 净化）：单 uid →
  `workbuddy-accounts-<uid 前 8 位><YYYYMMDD-HHMMSS>.json`；多 uid/无 uid →
  `workbuddy-accounts-[<realm>-]<YYYYMMDD-HHMMSS>.json`；`[^A-Za-z0-9._-]`→`_`，截 120。
- `exportedAt` 为本地时间 `YYYY-MM-DD HH:MM:SS`（hub `time.strftime` 口径）。
- **导出行是 hub 字段名**（`Account.to_dict()`，wb_accounts.py:1136，为准的字段表）：

| hub 行字段 | 类型 | 来源（magpie 官方条目/我们的 Account） |
| --- | --- | --- |
| `uid` | string | entry.uid（缺则由 JWT sub 派生，store 载入时已定） |
| `nickname` | string | entry.accountId（magpie 的显示名） |
| `domain` | string | entry.domain |
| `realm` | "cn"\|"intl" | provider：workbuddy→cn、workbuddy-ai→intl |
| `platform` | string | 常量 "CLI"（hub 缺省） |
| `product` | string | 常量 "workbuddy"（hub `normalize_product` 缺省） |
| `enterpriseId` | string | entry.enterpriseId |
| `accessToken` | string | entry.access（**secrets=0 时删除**） |
| `refreshToken` | string | entry.refresh（**secrets=0 时删除**） |
| `expiresAt` | number | **epoch 秒** = floor(entry.expires/1000)（§7.1） |
| `source` | string | 常量 "magpie" |
| `apiKey` | bool | 是否 API Key 条目（此类条目整行不导出——没有 OAuth 凭据可导） |
| `enabled` | bool | 恒 true |
| `tasksEnabled` | bool | 本插件 state 的生效值 |

  `to_dict()` 的其余字段（addedAt/proxySlot/proxy/weight/note/disabledModels/lastError/
  cooldownUntil/restrictedUntil/credits/tier/lastCheckin/lastDailyChat/lastActivityReport/
  modelCaps）是 hub 本地运行时状态或 magpie 侧不存在的信息，**不携带**；导入侧本就按
  `VOLATILE_FIELDS`（wb_accounts.py:5317）丢弃，回灌无损。
- **导出文件本身必须真值**（含昵称与 token，不打码）——否则回灌无效；打码只属于界面展示层。
- 导入侧绝不信任行上的易失字段（cooldownUntil/lastError 等），与 hub 同款。

### 9.2 导入（`POST /api/accounts/import`，两段式）

body = 账号数据本体（**四种形态**，hub `_coerce_account_rows` wb_accounts.py:5366 逐字移植：
导出信封 `{format,accounts}`、裸数组、单账号对象、桌面端凭据 `{"auth":{…},"account":{…}}`；
cockpit snake_case 行 `access_token/expires_at(毫秒)` 也认）或 `{"blob":<同上>,"confirm":bool}`。

- **预览（默认，绝不写盘）**：
  `{wrote:false, note:"预览未写入任何文件", preview:{adds:[{uid,nickname,key}],
  updates:[{uid,nickname,key,fromExpires,toExpires,reason}], skips:[{uid,nickname,reason}],
  rejects:[{index,reason,inputHint}], totals:{adds,updates,skips,rejects}}}`
  （index 从 1 起，hub 口径；`inputHint` 只含身份字段/字段名清单，**绝不含 token**）
- **确认（`confirm:true`，免密钥口径下无需任何密钥）**：
  `{wrote:true, added:[…], updated:[…], skipped:[…], backedUpTo:"plugin-auth.json.bak-hubimport-<stamp>",
  needReload:true, reloadHint:"在 magpie「插件管理」里把 WorkBuddy 关掉再打开，新账号才会被 magpie 认到"}`
- **错误**：文档读不出可导入账号 → `400`；`plugin-auth.json` 解析失败 → `409` 拒写（连预览也拒：
  智能合并没有可靠的「现有」可用）；**预览后文件已变（竞态）→ `409 {needRepreview:true}`**；
  落盘本身失败 → `500`。确认时若本进程里没有预览缓存，按当前文件现场计划后直接执行
  （纯函数同规则 ⇒ 同输入同结论；竞态守卫针对「预览过但文件已变」）。

**智能合并**（uid 已存在时，provider `workbuddy` 条目；顺序即优先级）：
1. 导入项无 `refresh` 而现有有 → `skip`（「写进去会削弱续期能力」）；
2. 现有 `expires > now`（未过期）→ `skip`（「绝不把在用的新 token 换成 JSON 里的旧 token」）；
3. 现有已过期且 `导入.expires > 现有.expires` → `update`（覆盖 access/refresh/expires）；
4. 其余 → `skip`（「导入的 token 并不比现有的新」）。
每个分支都给人话 reason。**更新只动 token 三件套**（access/refresh/expires）+ 补 `importedFrom`
标记：domain/tokenType/accountId 是 magpie 官方登录流程写下的现场信息，JSON 不比它权威；
未知字段靠条目展开原样保留。

**写入纪律**（`applyImport` 才写；`planImport(rows, existingAuth, {now})` 是纯函数，预览与确认
共用——同输入必同结论）：写前自动备份（逐字节 copy）；tmp+rename 原子落盘、mode 0600
（复用 `engine/store.mjs` 的原语，不另起一套）；解析失败拒写；其它 provider 与未知字段逐值
原样保留（测试用含 9 条目的 fixture 逐条比对）；key 分配沿用官方规则——**首个裸 id
`workbuddy`，其余 `#`+6 位小写数字字母，不得与文件里任何已有 key 撞**。

**写进 `plugin-auth.json` 的行用官方字段名**（非 hub 名）：
`{type:"oauth", access, refresh, expires(毫秒), refreshExpiresAt?, domain, tokenType, uid,
enterpriseId?, accountId(=可读昵称，magpie 用它显示账号名), importedFrom:"hub-json"}`。
`importedFrom` 是**易失标记**：magpie 下次整体覆写可能抹掉——因此 `/api/state` 的
`imported` 布尔 = `importedFrom==="hub-json"` || 本插件台账 `state/hub-imports.json` 有该 key，
两者都只是**尽力而为的展示标记，不作为任何逻辑判断依据**。

## 10. 0.3.3 新增：连登管家 / 新专家任务 / 签到回执 / 11140 冻结

来源：hub `wb_tasks.run_streak_bonus`（2026-10-10）、`wb_accounts.checkin_state`（#596）、
hub `v2.1.0`「11140 命中后直接封禁账号」、hub `TASK_SPECS` 新增 4 条专家活动任务。
本次**不**移植 hub 的 i18n / 面板布局 / Rust 版 / TLS 桥 / 号池分区等与本项目无关的部分。

### 10.1 连登管家（leg `streak`，新模块 `engine/streak.mjs`）

端点（**一律经 `engine/upstream.callJSON`**，`chat = chatUrl(opts)`、`bill = billBase()`；
调用前 `breathe`、经全局 spacer 排队，铁律 4 对它们同样生效）：

| 用途 | 方法 | 路径 | body |
| --- | --- | --- | --- |
| 连登日历 | GET | `{chat}/activity/growth/heatmap` | — （**真实外壳 `data.cells:[{date,score}]`**，2026-11-11 实测） |
| 连登状态 | GET | `{chat}/activity/growth/streak` | — （**`data.streak.days` / `data.makeup_cards.balance` / `data.redemption_status`**，实测） |
| 补签昨日 | POST | `{chat}/activity/growth/makeup-cards/use` | `{target_date:"YYYY-MM-DD"}` |
| 档位兑换 | POST | `{chat}/activity/growth/redeem` | `{tier:"7d"\|"14d"\|"28d", client_token:<uuid>}` |
| 抽奖次数 | GET | `{chat}/activity/growth/lottery/summary` | — |
| 抽奖 | POST | `{chat}/activity/growth/lottery/draw` | `{client_token:<uuid>}` |
| 新手礼包 | POST | `{bill}/billing/meter/claim-gift` | `{}` |
| 活动补偿 | POST | `{bill}/billing/meter/claim-compensation` | `{}` |

`client_token` 用 `node:crypto` 的 `randomUUID()`（与 `engine/buddy.mjs` 同款）。
`target_date` = **北京昨日** = `beijingDayKey(now - 86400000)`（复用 `engine/daily.mjs`）。

执行顺序（每次调用之间自然受 ≥1s 全局节流约束）：**补签 → 礼包/补偿 → 档位兑换 → 抽奖**。

```js
// 只读：连登天数 / 补签卡 / 抽奖次数 / 连登日历（上游给一整年）/ 档位状态
export async function fetchStreakState(acct, opts = {})
// -> {ok:true, days:number, makeupCards:number, lotteryChances:number,
//     heatmap:[{date:"YYYY-MM-DD", score:number}],   // 上游一次回一整年（365 格，实测）
//     tiers:[{tier:"7d"|"14d"|"28d", status:string}],
//     updatedISO:string}
//    任一子请求失败不影响其余字段（缺省 0 / []），全部失败 -> {ok:false, error}
export async function runStreakSteward(acct, opts = {})
// -> {ok:boolean, earned:number, restricted?:true, streak:<fetchStreakState 结果>,
//     logs:string[],
//     actions:{makeup:{used:boolean, date:string},
//              gifts:[{key:"claim-gift"|"claim-compensation", name:string, credit:number}],
//              redeemed:["7d"|"14d"|"28d"], drawn:number}}
```

幂等与静默跳过（hub 逐字口径，**全部不报错、只写一行说明**）：
- 昨日 `heatmap` 格 `score === 0` 且 `makeup_cards.balance > 0` 才补签；否则不碰。
- 档位 `status` 为 `locked` / `claimed` 跳过；其余（如 `available`）才兑换。
- `lottery/summary` 的 `chances` 为 0 不抽；每次抽奖之间仍走全局节流，不额外 sleep。
- 礼包/补偿业务拒绝（「已领取过」等）静默，只有 `code === 0` 且 `credit > 0` 才计入 `actions.gifts`。
- 企业版账号（`acct.enterpriseId` 非空）/ API key 账号：直接 `{ok:true, logs:["企业版账号无成长体系，跳过"]}`，一个上游请求都不发。
- **绝不抛**；`restricted`（HTTP 403 / code 11140）透传，由调用方走 §10.5 冻结。

### 10.2 HTTP API 新增（`daemon.mjs`）

```
GET  /api/streak?uid=<uid>[&refresh=1]
     -> {uid, cached:bool, streak:<10.1 state 形状>|null, error?}
        · 缓存 state/streak.json（uid -> streak），新鲜期 10 分钟（与 /api/credits 同口径）；
        · 未 refresh 且缓存新鲜 -> 直接回缓存，不打上游；refresh=1 强制拉；
        · job 在跑时 refresh=1 -> 409 busy（与 credits 同款）；非 refresh 回缓存。
        · **/api/state 绝不为此打上游**（只读投影缓存）。

POST /api/streak/run   {"uids":["…"]}
     -> {results:[{uid, outcome:"ok"|"skipped"|"failed", earned, message,
                   detail:{days,makeupCards,lotteryChances,
                           makeupUsed:bool, makeupDate:"YYYY-MM-DD",
                           gifts:[{name,credit}], redeemed:["7d"], drawn:number}}]}
        · 缺省/空 uids = 全部「未冻结 + tasksEnabled」账号（同 /api/checkin 的 eligibleNow）；
        · 账号之间间隔 1500 ms（手动手感，同 /api/checkin）；
        · 冻结账号 -> outcome "failed" + message "账号已冻结（11140）：…；确认无风险后在账号行点「恢复」"。

POST /api/account/unfreeze  {"uid":"…"} 或 {"uids":["…"]}
     -> {ok:true, unfrozen:[uid…], missing:[uid…]}   // missing = 本来就没冻结
```

三条路由**必须登记进 `API_ROUTE_AUTH`**（`tests-shell/account-routes.test.mjs` 遍历全表）。

### 10.3 `/api/state` 新增字段（前端唯一依赖）

- `accounts[i].streak`：`10.1 的 state 形状` | `null`（只读投影 `state/streak.json`）。
- `accounts[i].frozen`：`{at:ISO, code:number|string, message:string}` | `null`。
- 顶层 `frozen`：`[{uid, nickname, at, code, message}]`（冻结总览，替代原 `scheduler.holds`）。
- `settings.hours.streak`：`number[]`，**默认 `[]`（留空 = 不排程）**，与 mp/buddy/travel/night 同规则；
  `normalizeScheduleHours` 的键集合随之扩为 `mp|buddy|streak|travel|night`。
- `settings.legs` / `scheduler.nextRuns` / `job.legs` 均可含 `streak`。
- `LEGS = ["growth","mp","streak","buddy","travel","night"]`，`LEG_NAMES.streak = "连登管家"`
  （runner 的 `LEG_ORDER` 同序）。**手动默认腿新增 `streak`**：`DEFAULT_SETTINGS.legs = ["growth","streak","travel"]`
  （连登管家是纯收益且幂等，默认做；已在 settings.json 里存过 legs 的实例不受影响）。

### 10.4 `/api/checkin` 回执细分（hub #596）

`outcome` 取值扩为 `"claimed" | "done" | "pending" | "failed"`（旧两值语义不变）：

- `msg` 含 `处理中` / `请勿重复操作` / `系统繁忙` / `稍后再试` → **`pending`**：
  **不算成功、不落账、当天可重试**（原实现把 `code=0` 一律当成功，会把「请求处理中，请勿重复操作」
  记成已领 → 当天再也不重试）。
- `code === 0`：`msg` 含 `失败` → `failed`；否则 `claimed`。
- `code === 10001`：`msg` 含 `已签到` → `done`；否则 `failed`。
- 其他 code → `failed`。
- 「失败」是唯一硬词，`不足`（如「距离 7 天奖励还不足」）**不得**判失败。

### 10.5 403 / 11140：冻结账号（替换原 2 小时自动冷却）

hub `v2.1.0` 口径：HTTP 403 / code 11140 不是可自动恢复的风控冷却，继续重试会让同设备账号连坐。

- 任何腿收到 `restricted` → **立即冻结**该账号，持久化 `state/frozen.json`
  （`{uid:{at:ISO, code, message}}`，tmp+rename 原子写，与 `state/daily-activity.json` 同目录）。
- 冻结账号**不进** `eligibleNow()`、不进排程选号、不进 `/api/run` 缺省 uids、
  不进 `/api/checkin` 与 `/api/streak/run` 的缺省目标。
- **不再自动恢复**：只有 `POST /api/account/unfreeze`（或看板「恢复」按钮）能解冻。
  冻结不影响其他账号（不做全池熔断）。
- 显式指定冻结账号的单账号操作（`/api/task/accept`、`/api/task/claim`、`/api/checkin`、
  `/api/streak/run`）如实失败并给出上句提示，不静默跳过。
- `engine/runner.mjs`：`hold(uid)` → `freeze(uid, {code, message})`；
  新增 `unfreeze(uid)` / `frozen()`；`RESTRICTED_COOLDOWN_MS` 不再用于 403/11140
  （常量保留但标注废弃，避免其它引用悬空）。daemon 从 runner 读冻结表并原子落盘。

### 10.6 新增专家活动任务 spec（`engine/constants.mjs`）

`kind:"expert"`，`expert` 钉死**上游真实 id**（上游按 `(eventCode, id)` 去重，id 不对进度永远不动）：

| code | expert id | 名称 | 奖励 |
| --- | --- | --- | --- |
| `expert_use_maidehao` | `ex_GDl31WahyIH0` | 中国电商运营专家 | 100 |
| `expert_use_douyinyin` | `ex_FbY5nlWTqDod` | 抖音策略师 | 100 |
| `expert_use_shangjia_xuanchuan` | `ex_Weo3x2EZuSDm` | 商家宣传页与海报设计师 | 100 |
| `expert_use_bowangwang` | `ex_WZY136wV5aMt` | 直播电商教练 | 100 |

上游没下发这些 code 时零副作用（只多四条 spec 表项）。

### 10.7 MCP 工具新增（`index.mjs`，契约 §6）

- `workbuddy_tasks_streak`：参数 `{uids?}` → `POST /api/streak/run`，回一句人话摘要
  （每个账号「连登 N 天 / 补签 / 兑换 / 抽奖 +N 积分」）。
- `workbuddy_tasks_unfreeze`：参数 `{uid?, uids?}` → `POST /api/account/unfreeze`。
- `workbuddy_tasks_status` 输出补一段「已冻结账号」（uid/昵称/时间/原因），没有则省略。
- `workbuddy_tasks_run` 的 legs 说明补 `streak（连登管家：补签/档位兑换/抽奖/礼包）`。

### 10.8 实现口径收尾（实现时钉死的细节，后续修订以本节为准）

- **`fetchStreakState` 的跳过口径**：国际版（`provider !== "workbuddy"`）/ API key / 企业版账号
  返回 `{ok:true, skipped:true, ...零值}`（`days/makeupCards/lotteryChances=0`、`heatmap=[]`、
  `tiers` 三档 `status:""`），**一个上游请求都不发**；`runStreakSteward` 对同一批账号返回
  `{ok:true}` + 一行「企业版账号无成长体系，跳过」，同样零上游。
- **`updatedISO` 固定 ISO 8601**（`new Date(now).toISOString()`）：`GET /api/streak` 的 10 分钟
  新鲜期由它算出，别改成别的格式（改了就没有 TTL）。
- **`redemption_status` 真实形状（2026-11-11 生产实测钉死）**：`{tiers:[…], tier_7d_status, tier_14d_status,
  tier_28d_status}` —— 状态在**平铺的 `tier_<档>_status`** 键上，不在 `tiers` 数组项里；另兼容
  `tiers:[{tier,status}]` 与 `{7d:"…"}`（后两种是早先的猜测形状，仅为容错保留）。第一版按猜测形状
  解析，结果是「days/makeupCards 正常、三档状态全空、日历 0 格」——档位兑换永远不会发生，只有拿真实
  响应回来看才露馅。`heatmap` 的真实外壳同理：**`data.cells`**（不是 `data.days`）。
  两条已由 `tests/streak.test.mjs` 的「真实报文形状」用例与 `tests/helpers.mjs` 的假后端钉住。
- **`tiers[].status` 未知值语义**：只认 `locked`（未达成）/ `claimed`（已兑换）为「不动」；
  `available` 之类的**已知非锁定值**才兑换；**空串 = 上游没给这一档 = 状态未知 → 不兑换**。
  看板对未知值原样展示，**不得**当成功或以它触发动作。
- **奖励字段名**：礼包/补偿认 `data.credit ?? data.points ?? data.point`；兑换/抽奖认
  `data.credit ?? data.points`（容错解析，尚未拿到真实到账报文 —— 2026-11-11 该账号
  `tier_*_status` 全为未达成、`chances=0`，所以还没验证过兑换/抽奖的到账字段）。
- **`GET /api/streak` 的错误口径**（镜像 `/api/credits`）：缺 `uid` → 400；uid 找不到 /
  API key / `tasksEnabled:false` → 404（「找不到可参与任务的国内版账号：<uid>」）；
  企业版（`enterpriseId` 非空，issue #3）→ 404 且给与 `/api/credits` 同一段的专属文案
  （「企业版账号没有成长体系……切换个人版账号」，§3 企业版同口径）；引擎缺文件 → 503。
  上游查询失败 → **200 +
  `error`**（有旧缓存时一并带回 `streak`），HTTP 状态不表示上游结果。
- **`GET /api/state` 不打上游**：`accounts[].streak` 只是 `state/streak.json` 的只读投影
  （没有缓存 = `null`，看板显示「未查询」）。
- **`/api/checkin` 的 `pending`**：`outcome:"pending"` 时**不带** `credit`/`streak`
  （daemon 明确置 `0`/`undefined`），看板必须渲染成「处理中，可重试」而不是成功/已领。
- **`/api/streak/run` 撞 restricted**：由 daemon 路由当场 `freezeAccount(uid)` 并落盘
  （不经过 runner），结果里 `outcome:"failed"` + 「已冻结…恢复」提示。
- **`results[]` 不含昵称**：只有 `uid`（与 `/api/checkin` 一致）；看板自己拿 `accounts[]`
  的昵称兜底（账号在跑的过程中被移除时退化成显示 uid）。
- **`settings.legs = []` 的语义**：= 「没设置」→ 用默认腿（`["growth","streak","travel"]`）；
  前端与 daemon 同口径，不做「空 = 一条腿都不跑」（要「都不跑」就别触发批量任务）。
- **`heatmap` 覆盖范围**：上游一次回**一整年**（实测 365 格，含上线前的 0 分格）。**看板只画最近 28 天**
  （`dashboard/app.js` 的 `HEAT_WINDOW_DAYS`）：整年全铺是 53 行、807px 高的细长条，而且只有近期那几天有分，
  打开看像布局坏了（2026-11-11 实测确认网格与配色本身没问题，纯粹是窗口太大）。全年有记录天数只放在汇总
  文案里（「· 全年 N 天」）。
- **`heatmap[].score` 量纲**：当天连登分（0 = 当天没连登；实测活跃日是个位到两位数，不是 0/1 布尔）。**只用于展示与「昨日是否为 0」的
  补签判断**，看板的分档着色是纯视觉（0 / 1–2 / 3–5 / 6+），不得参与任何逻辑判断。

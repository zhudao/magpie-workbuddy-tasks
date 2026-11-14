// magpie-workbuddy-tasks —— 插件入口
//
// 这个模块只导出一个插件函数（magpie 会把入口文件里每个导出函数都当插件跑），
// 可测试的辅助全部挂在 export const _internal 上（契约 §0.6）。
//
// 它做两件事：
//   1. tool 钩子：五个工具（契约 §6），全部只走守护进程的 HTTP API，
//      单次执行 ≤55 s，长活一律 fire-and-poll。
//   2. 生命周期（契约 §4）：被宿主加载时读 state/control.json 的 desired，
//      非 off 则 ensureDaemon()（健康则复用，不健康才 spawn detached 守护进程），
//      并注册退出钩子——若守护进程是本会话拉起的，退场时通知它退出。
//
// 本插件**不声明 provider**（没有 auth / config 钩子，契约 §5）：早先版本声明过
// 一个无模型的 provider「workbuddy-tasks」，只为给 magpie 一个加载理由；但它让
// magpie 在供应商卡里显示「未登录」+ 登录按钮——用户既不需要也无法为它登录
// （任务凭据永远共享读 magpie 已登录的 workbuddy 账号），纯造成困惑。去掉之后
// 供应商列表不再出现本插件，对话链路照旧全权归社区插件（契约 §0.1 的两个 id
// 我们本来就不碰）。
// 加载取舍：插件仍有 package.json 的 magpie.page，且不是「只有页面」的插件——
// tool 钩子在，magpie 照样会为工具启动插件宿主并调用本入口，ensureDaemon 因此
// 照常运行；页面入口卡也照常出现。

import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import {
  DEFAULT_PORT,
  bindHint,
  daemonKey,
  ensureDaemon,
  interpreter,
  pidAlive,
  probeDaemon,
  readControl,
  readDaemonInfo,
  registerExitHooks,
  resolveCfgDir,
  shutdownDaemon,
  stateDirFor,
  writeControl,
} from "./lifecycle.mjs"

const VERSION = "0.3.6"
const TOOL_PREFIX = "workbuddy_tasks" // 契约 §6 的工具名前缀（magpie 还会加上插件短名前缀）

// 本文件自己的目录（daemon.mjs 与它同目录）
// 注意：返回的是「目录」，不是 daemon.mjs 的路径——ensureDaemon 会在其下再 join "daemon.mjs"。
// 早先这里把 ./daemon.mjs 的 URL 直接当目录返回，导致真实宿主里拼出 …/daemon.mjs/daemon.mjs。
function hereDir() {
  try {
    return dirname(fileURLToPath(import.meta.url))
  } catch {
    return "."
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const short = (e) => String(e?.message ?? e).slice(0, 180)

// ---- 守护进程 HTTP 客户端（工具共用） --------------------------------------

function makeDaemonClient(getInfo) {
  async function call(method, path, body, timeoutMs = 10000, extraSignal = null) {
    const info = await getInfo()
    if (!info?.port || !info?.key) {
      const e = new Error("任务守护进程未运行，无法执行（打开/重开本插件会自动拉起）")
      e.code = "WB_NO_DAEMON"
      throw e
    }
    const signals = [AbortSignal.timeout(timeoutMs)]
    if (extraSignal) signals.push(extraSignal)
    const signal = typeof AbortSignal.any === "function" ? AbortSignal.any(signals) : signals[0]
    const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
      method,
      // Bearer 头兼容保留：免密钥口径下 daemon 不校验任何密钥（routeNeedsKey 恒
      // false），带上它只为与老版本 daemon（仍设密钥门禁）平滑共存。
      headers: {
        authorization: `Bearer ${info.key}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    })
    let data = null
    try {
      data = await res.json()
    } catch {}
    return { status: res.status, ok: res.ok, data }
  }
  return { call }
}

// ---- 汇总文本（工具的返回都是给人看的纯文本） ------------------------------

function fmtState(s) {
  const lines = []
  const accts = s.accounts ?? []
  const on = accts.filter((a) => a.tasksEnabled)
  lines.push(`账号：${accts.length} 个已登录，${on.length} 个参与任务`)
  for (const a of accts.slice(0, 10)) {
    const days = a.expiresInDays == null ? "有效期未知" : `令牌剩 ${a.expiresInDays} 天`
    lines.push(`  · ${a.nickname || a.uid}（${a.tasksEnabled ? "参与" : "已停用"}，${days}）`)
  }
  if (accts.length > 10) lines.push(`  … 其余 ${accts.length - 10} 个略`)
  if (s.notice) lines.push(`提示：${s.notice}`)
  // 已冻结账号（0.3.3，403/11140）：冻结的账号不参与任务，必须知道它们的存在
  // —— 没有冻结账号时整段省略。
  const frozen = s.frozen ?? []
  if (frozen.length) {
    lines.push(`已冻结账号：${frozen.length} 个（403/11140，不参与任务；确认无风险后可解冻）`)
    for (const f of frozen.slice(0, 10)) {
      const at = f.at ? String(f.at).replace("T", " ").slice(0, 16) : "时间未知"
      lines.push(`  · ${f.nickname || f.uid}（${at}）${f.message ? `：${f.message}` : ""}`)
    }
    if (frozen.length > 10) lines.push(`  … 其余 ${frozen.length - 10} 个略`)
  }
  const sc = s.scheduler ?? {}
  const next = (sc.nextRuns ?? [])
    .map(([leg, h]) => `${leg}@${String(h).padStart(2, "0")}:00`)
    .join("、")
  lines.push(`排程：${sc.enabled ? "开启" : "关闭"}${next ? `，窗口：${next}` : ""}${sc.lastCycle ? `，上次触发 ${sc.lastCycle}` : ""}`)
  const j = s.job
  if (j) {
    const done = (j.steps ?? []).filter((x) => x.state === "ok" || x.state === "skip" || x.state === "fail").length
    lines.push(`当前任务：job ${j.id}（${j.state}，${done}/${(j.steps ?? []).length} 步）`)
  } else {
    lines.push("当前任务：无")
  }
  const st = s.stats ?? {}
  lines.push(`今日：${st.creditsToday ?? 0} 积分 · ${st.energyToday ?? 0} 能量 · ${st.runs ?? 0} 轮`)
  if (s.engineErrors?.length) lines.push(`引擎告警：${s.engineErrors.join("；")}`)
  return lines.join("\n")
}

function fmtJob(j) {
  if (!j) return "任务不存在（或已从内存清除）"
  const steps = j.steps ?? []
  const t = j.totals ?? {}
  const lines = [`job ${j.id}：${j.state}`]
  if (j.startedAt) lines[0] += `（${j.startedAt} 起${j.endedAt ? `，${j.endedAt} 结束` : ""}）`
  lines.push(`结算：+${t.credit ?? 0} 积分 · +${t.energy ?? 0} 能量 · 点亮 ${t.tasksLit ?? 0} · 领取 ${t.tasksClaimed ?? 0}`)
  for (const s of steps.slice(-20)) {
    const name = s.nickname || s.uid
    const leg =
      s.leg === "growth" ? "成长"
      : s.leg === "mp" ? "小程序"
      : s.leg === "campaign" ? "活动"
      : s.leg === "streak" ? "连登"
      : s.leg === "buddy" ? "盲盒"
      : s.leg === "travel" ? "旅行"
      : s.leg === "night" ? "夜猫"
      : s.leg
    lines.push(`  ${s.state === "ok" ? "✓" : s.state === "fail" ? "✗" : s.state === "skip" ? "－" : "…"} ${name} ${leg}：${s.detail || s.state}${s.credit ? `（+${s.credit} 积分${s.energy ? ` +${s.energy} 能量` : ""}）` : ""}`)
  }
  if (steps.length > 20) lines.push(`  … 其余 ${steps.length - 20} 步略`)
  const logs = j.log ?? []
  if (logs.length) lines.push(`最近日志：${logs.slice(-3).join(" | ")}`)
  return lines.join("\n")
}

// 连登管家一轮的回执摘要（workbuddy_tasks_streak 的每个账号一行）
function fmtStreakResult(r) {
  const d = r.detail ?? {}
  const bits = [`连登 ${d.days ?? 0} 天`]
  if (d.makeupUsed) bits.push(`补签 ${d.makeupDate || "昨日"}`)
  if (Array.isArray(d.gifts) && d.gifts.length) bits.push(`礼包 ×${d.gifts.length}`)
  if (Array.isArray(d.redeemed) && d.redeemed.length) bits.push(`兑换 ${d.redeemed.join("/")}`)
  if (d.drawn) bits.push(`抽奖 ${d.drawn} 次`)
  return `  · ${r.uid}：${r.outcome === "ok" ? bits.join(" / ") : r.outcome === "skipped" ? "无可做的连登动作" : `失败（${r.message || "未知原因"}）`}${r.earned ? `，+${r.earned} 积分` : ""}`
}

// 运营活动任务一轮的回执摘要（workbuddy_tasks_campaign 的每个账号一行，
// 契约 §11.1：「活动 N 项 · 已领 M · +X 积分」）
function fmtCampaignResult(r) {
  const d = r.detail ?? {}
  const n = (d.activities ?? []).filter((a) => !a.error).length
  const claimed = Array.isArray(d.claimed) ? d.claimed.length : 0
  const bits = [`活动 ${n} 项`, `已领 ${claimed}`]
  if ((d.unavailable ?? []).length) bits.push(`未下发 ${(d.unavailable ?? []).length}`)
  const head =
    r.outcome === "ok" || r.outcome === "skipped"
      ? bits.join(" · ")
      : r.outcome === "failed" && /冻结/.test(String(r.message ?? ""))
        ? "账号已冻结（403/11140），本轮跳过"
        : `失败（${r.message || "未知原因"}）`
  return `  · ${r.uid}：${head}${r.earned ? `，+${r.earned} 积分` : ""}`
}

function fmtTasks(acct) {
  const snap = acct?.snapshot
  if (!snap || !Array.isArray(snap.tasks) || !snap.tasks.length) {
    return `账号 ${acct?.nickname || acct?.uid}：暂无任务快照。运行一轮任务（或稍后重试）后会自动生成。`
  }
  const lines = [`账号 ${acct.nickname || acct.uid} 的任务表（更新于 ${snap.updatedISO ?? "?"}）：`]
  // acceptStatus 是规范 Task 的字符串状态（CONTRACT §2：上游 accept_status 原词）
  const statusName = { not_accepted: "未接取", accepted: "已接取", completed: "已完成", claimed: "已领奖" }
  for (const t of snap.tasks) {
    const st = statusName[t.acceptStatus] ?? String(t.acceptStatus)
    const prog = t.progress?.target ? `进度 ${t.progress.current}/${t.progress.target}` : "进度未知"
    const reward = [t.rewardCredit ? `+${t.rewardCredit}积分` : "", t.rewardEnergy ? `+${t.rewardEnergy}能量` : ""].filter(Boolean).join(" ")
    lines.push(`  ${t.code}｜${t.title || "未命名"}｜${st}｜${prog}${reward ? `｜${reward}` : ""}${t.jumpUrl ? `｜需手动：${t.jumpUrl}` : ""}`)
  }
  const extra = []
  if (snap.energy != null) extra.push(`能量 ${snap.energy}`)
  if (snap.days != null) extra.push(`连续 ${snap.days} 天`)
  if (extra.length) lines.push(`汇总：${extra.join(" · ")}`)
  return lines.join("\n")
}

// ---- 插件函数 --------------------------------------------------------------

// ---- 插件宿主 SDK（@opencode-ai/plugin）的加载守卫 ------------------------------
//
// SDK 由 magpie 的插件宿主提供；拿不到就跳过工具注册，生命周期照常工作。
// **但这句 import 绝不能拖住插件加载**（2026-11-12 实测的真实故障）：本地文件夹安装
// 时宿主并没有在磁盘上提供这个包（全盘 find 找不到 `@opencode-ai/plugin`），而 Bun
// 对缺失的裸导入会**尝试联网自动安装** —— 走代理时能卡到 20s 以上，magpie 随即判
// 「the plugin's load didn't finish in 20s」，整张插件卡报错。同一环境下也有解析得够快、
// 只打一行「工具未注册」就继续的时候，所以表现为偶发。
// 处理：给 import 套一层硬超时；超时就当「宿主没提供」，日志说清楚，照常往下走。
// 抽成模块级 + 可注入 importer，是为了让 tests/sdk-import.test.mjs 能零网络地钉住
// 「超时/失败都不阻塞、且后台那条 import 的失败不会变成 unhandledRejection」。
export const SDK_IMPORT_TIMEOUT_MS = 6000

export async function importPluginSdk({
  timeoutMs = SDK_IMPORT_TIMEOUT_MS,
  importer = () => import("@opencode-ai/plugin"),
} = {}) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, why: `加载 @opencode-ai/plugin 超过 ${timeoutMs}ms（宿主未提供 SDK），跳过工具注册` }),
      timeoutMs,
    )
  })
  // 超时后这条 import 仍在后台跑：catch 挂在它自己身上，绝不会变成 unhandled rejection
  const load = Promise.resolve()
    .then(importer)
    .then((mod) => ({ ok: true, mod }))
    .catch((e) => ({ ok: false, why: `加载 @opencode-ai/plugin 失败，工具未注册：${short(e)}` }))
  try {
    return await Promise.race([load, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export const WorkBuddyTasksPlugin = async (input, options) => {
  const cfgDir = input?.directory || input?.worktree || resolveCfgDir(process.env) || null
  const dir = hereDir()
  const stateDir = cfgDir ? stateDirFor(cfgDir) : null

  // magpie 日志尽力而为（client.app.log 的签名按 OpenCode 的来，包一层不炸）
  const log = (...a) => {
    try {
      input?.client?.app?.log?.({ level: "info", service: "workbuddy-tasks", message: a.join(" ") })
    } catch {}
  }

  // 用户在 plugins.json options 里可写 dashboardUrl（给 page 入口卡跳转看板用）
  const dashboardUrl = typeof options?.dashboardUrl === "string" ? options.dashboardUrl : ""
  // Docker 里容器内回环外部不可达：options.listenAddress 可写 "0.0.0.0"（只到容器网桥）
  const listenAddress = typeof options?.listenAddress === "string" ? options.listenAddress.trim() : ""

  // 拉起守护进程（不阻塞插件加载太久：ensureDaemon 自带 8s 预算，失败也不炸）
  // A：就绪日志打印真实绑定地址（daemon.json 的 host，由 daemon 心跳写入），
  // 绑定 0.0.0.0/:: 时补一句与 daemon 启动日志 / reachableHint 相同口径的提示。
  const boot = ensureDaemon({ cfgDir, pluginDir: dir, log, addr: listenAddress })
    .then((r) => {
      if (r?.error) log("守护进程：" + r.error)
      else if (r?.info) {
        const bindHost = r.info.host || "127.0.0.1"
        log(`守护进程就绪：${bindHost}:${r.info.port}${r.spawned ? "（本次拉起）" : "（复用已有）"}`)
        const hint = bindHint(bindHost)
        if (hint) log(`监听 ${bindHost}:${r.info.port}：${hint}`)
      }
      return r
    })
    .catch((e) => ({ info: null, spawned: false, error: short(e) }))

  // 宿主退出：只有本会话拉起的守护进程才由我们送行；其余交给它自己的 magpie 探测
  registerExitHooks(async () => {
    const r = await boot.catch(() => null)
    if (r?.spawned && r?.info) await shutdownDaemon(r.info)
  })

  const client = makeDaemonClient(async () => {
    const r = await boot
    if (r?.info) return r.info
    // 第一次没起来，给一次快速重试的机会
    const retry = await ensureDaemon({ cfgDir, pluginDir: dir, log, budgetMs: 3000, addr: listenAddress }).catch(() => null)
    if (retry?.info) return retry.info
    return null
  })

  // ---- tool 钩子（契约 §6） ----
  // SDK 由宿主提供；importPluginSdk 自带硬超时（见模块顶部说明），拿不到就只少工具，
  // 绝不影响插件加载与看板。
  let toolHook = undefined
  try {
    const sdkRes = await importPluginSdk()
    if (!sdkRes.ok) log(sdkRes.why)
    const sdk = sdkRes.mod
    const tool = sdk?.tool
    const schema = tool?.schema
    if (typeof tool === "function" && schema) {
      const optArr = () => schema.array(schema.string()).optional()
      const optBool = () => schema.boolean().optional()
      const optNum = () => schema.number().optional()
      const optStr = () => schema.string().optional()

      const runTool = (def) =>
        tool({
          ...def,
          async execute(args, ctx) {
            try {
              return await def.run(args, ctx)
            } catch (e) {
              return `执行失败：${short(e)}${e?.code === "WB_NO_DAEMON" ? "（打开/重开本插件可重新拉起守护进程）" : ""}`
            }
          },
        })

      toolHook = {
        // 状态：账号 / 排程 / 当前 job / 今日收益
        [`${TOOL_PREFIX}_status`]: runTool({
          description:
            "查看 WorkBuddy 任务插件的状态：参与账号、排程窗口、当前批量任务进度与今日积分/能量收益。",
          args: {},
          run: async (_args, ctx) => {
            const r = await client.call("GET", "/api/state", undefined, 10000, ctx?.abort)
            if (!r.ok) return `读取状态失败（HTTP ${r.status}）：${r.data?.error ?? ""}`
            return fmtState(r.data)
          },
        }),

        // 启动批量任务：立即返回 job id，不等待（55 s 装不下一轮批量）
        [`${TOOL_PREFIX}_run`]: runTool({
          description:
            "启动一轮 WorkBuddy 任务（成长任务/小程序链式任务/Buddy 盲盒/猫猫旅行/夜猫子），立即返回 job id，不等待完成。用 workbuddy_tasks_wait 轮询进度。同一时刻只能跑一个批量任务。可用 codes 只勾选部分成长任务。",
          args: {
            uids: optArr().describe("要跑的账号 uid 列表；不填 = 全部可参与账号"),
            legs: optArr().describe(
              "任务腿：growth（成长）、mp（小程序链式任务 Sequential_Tasks_1–6 + school_season，次日解锁；Sequential_Tasks_7=PC灵感功能是 web playbook 任务，走 growth 腿，不走小程序链路）、campaign（运营活动任务：星巴克协作/记者节福利等，判据与领奖独立于成长体系）、streak（连登管家：补签/档位兑换/抽奖/礼包）、buddy（Buddy 盲盒，消耗成长能量）、travel（猫猫旅行）、night（夜猫子）；不填 = 设置里的默认。growth 与 mp 同时指定时小程序任务只由 mp 腿跑一遍",
            ),
            claim: optBool().describe("完成后自动领奖，默认跟随设置"),
            codes: optArr().describe(
              "任务 code 列表（workbuddy_tasks_list 里可以看到）；growth 腿只对这些任务接取/点亮/领奖，对所有选中账号生效；不填 = 全部任务",
            ),
          },
          run: async (args, ctx) => {
            const body = {}
            if (Array.isArray(args?.uids)) body.uids = args.uids
            if (Array.isArray(args?.legs)) body.legs = args.legs
            if (args?.claim !== undefined) body.claim = !!args.claim
            if (Array.isArray(args?.codes)) body.codes = args.codes // 任务级勾选（CONTRACT §3）；daemon 归一化
            const r = await client.call("POST", "/api/run", body, 15000, ctx?.abort)
            if (r.status === 409) {
              const cur = await client.call("GET", "/api/state", undefined, 8000, ctx?.abort).catch(() => null)
              const job = cur?.data?.job
              return `已有批量任务在运行（job ${job?.id ?? "?"}，${job?.state ?? "?"}）。等它结束再启动，或用等待工具查看进度。`
            }
            if (r.status === 503) return `启动失败：${r.data?.error ?? "任务引擎不可用"}`
            if (!r.ok) return `启动失败（HTTP ${r.status}）：${r.data?.error ?? ""}`
            const j = r.data?.job
            const legs = (j?.legs ?? body.legs ?? []).join(" + ")
            return `已启动 job ${j?.id ?? "?"}${legs ? `（${legs}）` : ""}。用等待工具（workbuddy_tasks_wait）可轮询到完成。`
          },
        }),

        // 等待 job：轮询到完成或超时，返回进度与结算
        [`${TOOL_PREFIX}_wait`]: runTool({
          description: "等待一个 WorkBuddy 任务 job 结束（轮询），返回进度与结算；到时或未找到也如实返回。",
          args: {
            jobId: schema.string().describe("workbuddy_tasks_run 返回的 job id"),
            maxSeconds: optNum().describe("最长等待秒数，默认 45，上限 50"),
          },
          run: async (args, ctx) => {
            const id = String(args?.jobId ?? "").trim()
            if (!id) return "需要 jobId（workbuddy_tasks_run 的返回）"
            const maxS = Math.min(50, Math.max(3, Number(args?.maxSeconds) || 45))
            const deadline = Date.now() + maxS * 1000
            for (;;) {
              const r = await client.call("GET", `/api/jobs/${encodeURIComponent(id)}`, undefined, 8000, ctx?.abort)
              if (r.status === 404) return `job ${id} 不存在（可能已结束并被清理，或 id 写错了）`
              if (!r.ok) return `查询失败（HTTP ${r.status}）`
              const j = r.data
              if (j.state === "done" || j.state === "error") return fmtJob(j)
              if (Date.now() >= deadline) {
                const steps = j.steps ?? []
                const done = steps.filter((x) => x.state !== "pending" && x.state !== "running").length
                return (
                  `job ${id} 还在${j.state === "running" ? "运行" : j.state}，已等 ${maxS}s（${done}/${steps.length} 步，+${j.totals?.credit ?? 0} 积分）。` +
                  `稍后再调一次本工具可继续等待。`
                )
              }
              await sleepUntil(1500, ctx?.abort)
            }
          },
        }),

        // 任务表：code/标题/接取状态/进度/奖励
        [`${TOOL_PREFIX}_list`]: runTool({
          description:
            "列出 WorkBuddy 成长任务表（code、标题、接取状态、进度、奖励）。数据来自账号任务快照，查询时会尽量刷新一次。",
          args: {
            uid: optStr().describe("账号 uid；不填 = 第一个可参与账号"),
          },
          run: async (args, ctx) => {
            const uid = args?.uid ? `?uid=${encodeURIComponent(String(args.uid))}` : "?refresh=1"
            const r = await client.call("GET", `/api/state${uid}`, undefined, 30000, ctx?.abort)
            if (!r.ok) return `读取失败（HTTP ${r.status}）：${r.data?.error ?? ""}`
            const s = r.data
            const accts = s.accounts ?? []
            if (!accts.length) return `没有账号：${s.notice ?? "magpie 里还没有已登录的 workbuddy 账号"}`
            const pick = args?.uid ? accts.find((a) => a.uid === args.uid) : accts.find((a) => a.tasksEnabled) ?? accts[0]
            if (!pick) return `找不到账号 ${args.uid}`
            return fmtTasks(pick)
          },
        }),

        // 单个领奖
        [`${TOOL_PREFIX}_claim`]: runTool({
          description: "领取单个 WorkBuddy 成长任务奖励（按任务 code）。批量任务运行中时会拒绝，避免抢限速。",
          args: {
            uid: schema.string().describe("账号 uid"),
            code: schema.string().describe("任务 code（workbuddy_tasks_list 里可以看到）"),
          },
          run: async (args, ctx) => {
            const uid = String(args?.uid ?? "").trim()
            const code = String(args?.code ?? "").trim()
            if (!uid || !code) return "需要 uid 与 code"
            const r = await client.call("POST", "/api/task/claim", { uid, code }, 30000, ctx?.abort)
            if (r.status === 409) return "批量任务运行中，稍后再领。"
            if (r.status === 404) return `账号 ${uid} 不存在`
            if (!r.ok) return `领取失败：${r.data?.error ?? `HTTP ${r.status}`}`
            const d = r.data
            if (!d.ok) return `没有领到：${d.reason || "任务可能未完成"}`
            const got = [d.credit ? `+${d.credit} 积分` : "", d.energy ? `+${d.energy} 能量` : ""].filter(Boolean).join(" ")
            return `领取成功${got ? `：${got}` : ""}${d.via ? `（经 ${d.via === "web" ? "网页回退" : "聊天接口"}）` : ""}`
          },
        }),

        // 连登管家（0.3.3，CONTRACT §10.7）：补签昨日 / 领礼包补偿 / 档位兑换 / 抽奖
        [`${TOOL_PREFIX}_streak`]: runTool({
          description:
            "跑一轮 WorkBuddy 连登管家：用补签卡补签昨日、领取新手礼包/活动补偿、兑换 7d/14d/28d 档位奖励、用完抽奖次数。纯收益且幂等，已做过的事自动跳过。",
          args: {
            uids: optArr().describe("要跑的账号 uid 列表；不填 = 全部可参与账号（已冻结的除外）"),
          },
          run: async (args, ctx) => {
            const body = {}
            if (Array.isArray(args?.uids)) body.uids = args.uids
            const r = await client.call("POST", "/api/streak/run", body, 55000, ctx?.abort)
            if (r.status === 409) return "批量任务运行中，稍后再跑连登管家。"
            if (r.status === 503) return `执行失败：${r.data?.error ?? "任务引擎不可用"}`
            if (!r.ok) return `执行失败（HTTP ${r.status}）：${r.data?.error ?? ""}`
            const results = r.data ?? []
            if (!results.length) return "没有可参与任务的账号（或全部已冻结）。"
            const lines = results.slice(0, 10).map(fmtStreakResult)
            if (results.length > 10) lines.push(`  … 其余 ${results.length - 10} 个略`)
            const earned = results.reduce((s, x) => s + (Number(x?.earned) || 0), 0)
            lines.unshift(`连登管家完成：${results.length} 个账号，共 +${earned} 积分`)
            return lines.join("\n")
          },
        }),

        // 运营活动任务（0.3.5，CONTRACT §11.1）：星巴克协作/记者节福利等
        // campaign_* 活动的判据发射与领奖（app 类只提示不伪造，领奖回读 claimed_at）
        [`${TOOL_PREFIX}_campaign`]: runTool({
          description:
            "跑一轮 WorkBuddy 运营活动任务（星巴克协作、记者节福利等）：补 viewed、按判据上报事件（对话/专家/技能/灵感案例）、领奖并回读回执。手机端 App 类判据只提示、不伪造。已领过的自动跳过。",
          args: {
            uids: optArr().describe("要跑的账号 uid 列表；不填 = 全部可参与账号（已冻结的除外）"),
          },
          run: async (args, ctx) => {
            const body = {}
            if (Array.isArray(args?.uids)) body.uids = args.uids
            const r = await client.call("POST", "/api/campaign/run", body, 55000, ctx?.abort)
            if (r.status === 409) return "批量任务运行中，稍后再跑活动任务。"
            if (r.status === 503) return `执行失败：${r.data?.error ?? "任务引擎不可用"}`
            if (!r.ok) return `执行失败（HTTP ${r.status}）：${r.data?.error ?? ""}`
            const results = r.data ?? []
            if (!results.length) return "没有可参与任务的账号（或全部已冻结）。"
            const lines = results.slice(0, 10).map(fmtCampaignResult)
            if (results.length > 10) lines.push(`  … 其余 ${results.length - 10} 个略`)
            const earned = results.reduce((s, x) => s + (Number(x?.earned) || 0), 0)
            lines.unshift(`活动任务完成：${results.length} 个账号，共 +${earned} 积分`)
            return lines.join("\n")
          },
        }),

        // 解冻（0.3.3，CONTRACT §10.7）：403/11140 冻结只有这里能解除
        [`${TOOL_PREFIX}_unfreeze`]: runTool({
          description:
            "解冻被 403/11140 风控冻结的 WorkBuddy 账号（冻结的账号不参与任何任务，且不会自动恢复；确认无风险后再解冻）。",
          args: {
            uid: optStr().describe("要解冻的账号 uid（与 uids 二选一）"),
            uids: optArr().describe("要解冻的账号 uid 列表（与 uid 二选一）"),
          },
          run: async (args, ctx) => {
            const body = {}
            if (args?.uid) body.uid = String(args.uid)
            if (Array.isArray(args?.uids)) body.uids = args.uids
            if (!body.uid && !body.uids) return "需要 uid 或 uids"
            const r = await client.call("POST", "/api/account/unfreeze", body, 15000, ctx?.abort)
            if (!r.ok) return `解冻失败（HTTP ${r.status}）：${r.data?.error ?? ""}`
            const d = r.data ?? {}
            const parts = []
            if (d.unfrozen?.length) parts.push(`已解冻 ${d.unfrozen.length} 个：${d.unfrozen.join(", ")}`)
            if (d.missing?.length) parts.push(`以下账号本来就没冻结：${d.missing.join(", ")}`)
            return parts.length ? parts.join("；") : "没有可解冻的账号。"
          },
        }),
      }
    } else {
      log("未找到 @opencode-ai/plugin 的 tool 导出，工具未注册（守护进程生命周期不受影响）")
    }
  } catch (e) {
    // 走到这里 = SDK 拿到了但注册工具时出错（拿不到 SDK 已在 importPluginSdk 里记过日志，
    // 不再重复报同一句）。注册失败不影响生命周期与看板，只少工具。
    log(`注册工具失败（不影响插件加载与看板）：${short(e)}`)
  }

  // 本插件只声明 tool 钩子（契约 §5：不声明 provider，避免 magpie 在供应商卡里
  // 显示「未登录」与无意义的登录按钮；magpie.page + tool 已足够让 magpie 加载
  // 本插件并启动插件宿主——入口函数被执行时 ensureDaemon 生命周期照常运转）。
  const hooks = {}
  if (toolHook) hooks.tool = toolHook

  return hooks
}

async function sleepUntil(ms, signal) {
  if (signal?.aborted) throw new Error("已中止")
  await new Promise((r) => {
    const t = setTimeout(r, ms)
    signal?.addEventListener?.(
      "abort",
      () => {
        clearTimeout(t)
        r()
      },
      { once: true },
    )
  })
}

// ---- 可测试的辅助（magpie 只把导出的“函数”当插件，_internal 是对象，安全） ----

export const _internal = {
  DEFAULT_PORT,
  VERSION,
  TOOL_PREFIX,
  // 生命周期透传（给 bun test / node --test 用）
  ensureDaemon,
  shutdownDaemon,
  registerExitHooks,
  resolveCfgDir,
  stateDirFor,
  readControl,
  writeControl,
  readDaemonInfo,
  daemonKey,
  pidAlive,
  probeDaemon,
  interpreter,
  // 纯函数
  fmtState,
  fmtJob,
  fmtTasks,
  fmtStreakResult,
  fmtCampaignResult,
  makeDaemonClient,
  hereDir,
  bindHint,
  _sleepUntil: sleepUntil,
}

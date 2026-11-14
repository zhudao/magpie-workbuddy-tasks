// magpie-workbuddy-tasks —— 常驻守护进程
//
// 职责（契约 §3/§4）：HTTP 看板 + /api + SSE 实时事件 + 小时窗口排程 + 任务执行
//（经 engine 的 JobRunner）。自持生命周期：跟随 magpie（plugins.json / TCP 探测），
// 心跳写 state/daemon.json（0600）+ daemon.heartbeat，control.json desired=off 即退。
//
// 运行方式：`node daemon.mjs` 或 `bun daemon.mjs`（由 lifecycle.ensureDaemon 拉起，
// 也可手动拉起调试）。全部 node: 内置；Node 与 Bun 通用。
//
// 环境变量：
//   WB_STATE_DIR    状态目录（优先）；否则 <WB_CONFIG_DIR|cfg>/workbuddy-tasks/state
//   WB_CONFIG_DIR   magpie 配置目录（读 plugins.json、账号凭据）
//   WB_DAEMON_KEY   仅作为 daemon.json 的 key 字段写入（向后兼容保留，不是访问凭据，
//                   任何接口都不校验它）；缺省时随机生成
//   WB_DAEMON_PORT  期望端口；缺省 4390，被占用则向后找，再不行用随机端口
//   WB_DAEMON_ADDR  监听地址；缺省 127.0.0.1（Docker 内可设 0.0.0.0，只到容器网桥）
//   WB_MANAGED      =1 表示由 magpie 宿主拉起（plugins.json 条目消失时允许自杀）
//   MAGPIE_ADDR     magpie 网关地址（host:port），如 127.0.0.1:3499
//   MAGPIE_PUBLIC_URL  magpie 对外共享地址（如 http://192.0.2.10:3425）；取其 hostname
//                      作 /api/state serveUrl 的第②优先级（+守护进程自己的端口，§3）
// 命令行：--addr <host:port|host|:port>  --port <n>  --cfg <dir>  --state <dir>
// startDaemon 可注入（测试/嵌入用）：{ cfgDir, stateDir, port, key, args, engine,
//   now, sleep, fetch, log, noTimers, skipExistingCheck, managed, runner }。
//   key —— 只写进 daemon.json（向后兼容保留的字段），不是访问凭据。
//   fetch —— 假 fetch 顶替全部上游网络（引擎全程 opts.fetch），零真实请求（契约 §8）。
//
// 铁律：账号 access/refresh token 永不出现在任何响应、SSE 或日志里
//（只出现 uid / 昵称 / 「已登录」掩码）；对外文本一律过 scrub()。

import http from "node:http"
import net from "node:net"
import crypto from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, extname, join, normalize, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  DEFAULT_PORT,
  PLUGIN_NAME,
  bindHint,
  pidAlive,
  probeDaemon,
  readControl,
  readDaemonInfo,
  resolveCfgDir,
  stateDirFor,
  writeDaemonInfo,
} from "./lifecycle.mjs"
// 任务 → kind 解析（P0-1/P0-2）：snapTask 下发给前端的 6 个判断字段全部出自
// engine 的这个唯一判断源（纯函数、零请求；与 engine/tasks.fetchTasks 同一口径，
// 见 docs/CONTRACT.md §2/§3）。静态导入：taskkind.mjs 与 constants.mjs 一样是
// 插件自带、无网络依赖的模块（它 import 的 miniprogram.mjs 也只是静态表 +
// 纯函数）—— 缺文件与 lifecycle.mjs 缺失同级（整个模块装不上），不属于
// engine/* 的可选降级范畴。
import { resolveTaskKind } from "./engine/taskkind.mjs"
// 小程序任务判定（0.3.0）：/api/task/accept 与 /api/task/claim 按 isMPCode 把
// 请求分流到 web 头族或小程序头族（engine/miniprogram.mjs）——快照里现在既有
// web 清单任务也有 MP 清单任务，同一个端点必须两条链路都能操作。
import { isMPCode } from "./engine/miniprogram.mjs"
// 账号 JSON 导入/导出（契约 §9）：静态导入与 taskkind 同级 —— 纯函数模块、
// 只依赖 node: 内置与 engine/store.mjs，缺文件属于整个模块装不上的范畴。
import {
  applyImport,
  buildExportDocument,
  coerceImportRows,
  exportFileName,
  planImport,
  planView,
} from "./engine/accountio.mjs"
// 导入/导出路由直接读凭据文件（读-计划-复查-写 的竞态守卫需要原文与哈希）
import { readAuthDocument } from "./engine/store.mjs"
// 排程时间口径（CONTRACT §7/§8）：窗口小时与同日去重日界一律北京时间（UTC+8），
// 与容器时区无关 —— 生产容器是 UTC，getHours() 会把北京 09:00 读成 1 点。
import { beijingDateKey, beijingHour } from "./engine/constants.mjs"

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(join(PLUGIN_DIR, "package.json"), "utf8")).version || "0.3.6")
  } catch {
    return "0.3.6"
  }
})()

// 腿顺序（CONTRACT §11.1）：campaign（运营活动任务，独立于成长体系）排在 mp
// 之后、streak 之前；runner 的 LEG_ORDER 同序。
const LEGS = ["growth", "mp", "campaign", "streak", "buddy", "travel", "night"]
const LEG_NAMES = { growth: "成长任务", mp: "小程序链式任务", campaign: "活动任务", streak: "连登管家", buddy: "Buddy 盲盒", travel: "猫猫旅行", night: "夜猫子" }
// 未知路由 404 的 hint（issue #3 的真实症状）：看板比守护进程新时，旧进程没有
// 新路由（如 GET /api/streak），用户只看到「未知 API」一头雾水 —— hint 指路重启。
// 只追加字段，error 原文不变（既有测试与前端按原文断言/匹配）。
const UNKNOWN_API_HINT =
  "守护进程可能还在跑更新前的旧代码：在 magpie 里关掉再开启本插件即可重启（看板顶栏「停止守护进程」后重开也行）"
const HISTORY_CAP = 2000

// 积分缓存的有效期（GET /api/credits，CONTRACT §3）：缓存年龄小于它且未要求
// refresh 时直接返回缓存，绝不发上游。导出供测试对齐。
// GET /api/streak 的连登缓存（CONTRACT §10.2）与它同口径（10 分钟新鲜期）。
export const CREDITS_TTL_MS = 10 * 60 * 1000

// 排程小时窗口只认这六条腿（契约 §7/§8/§10.3/§11.1）：到点自动跑的都是无任务码
// 的腿；growth 刻意不在排程里（engine/schedule.SCHEDULE_WINDOWS 同口径），只能手动
// 发起（看板「立即运行」/ POST /api/run / 工具，可配合 codes 勾选）。
// 手动运行不受此限制——LEGS 仍含 growth，settings.legs 默认也仍含 growth。
const SCHEDULE_HOURS_LEGS = ["mp", "campaign", "buddy", "streak", "travel", "night"]

const DEFAULT_SETTINGS = {
  scheduler: false, // 小时窗口排程总开关：默认停用，须由用户在看板里显式点一次「启用排程」才生效
  claim: true, // 完成后自动领奖
  // 手动运行未指定 legs 时的默认腿（0.3.3 起新增 streak：连登管家是纯收益且
  // 幂等，默认做；已在 settings.json 里存过 legs 的实例不受影响）。
  legs: ["growth", "streak", "travel"],
  gapMs: 1500, // 账号之间的基础间隔（手动）；排程时 runner 另加 2–5s 抖动
  jitterMs: [2000, 5000], // 排程运行的账号间抖动（交给 runner，见契约 §0.4）
  // 北京小时窗口 UTC+8（只有 mp|campaign|buddy|streak|travel|night 可配窗口，
  // growth 无窗口；与容器时区无关）。**默认全部空 = 默认不排任何腿，留空即不
  // 排**：到点自动跑意味着自动消耗成长能量/自动接取任务，不给明确授权（显式配
  // 小时）就绝不自动做；用户在看板/设置里为某条腿配了小时窗口，那条腿才会自动
  // 跑（campaign 的判据与领奖同理，CONTRACT §11.1：默认 []）。
  hours: { mp: [], campaign: [], buddy: [], streak: [], travel: [], night: [] },
  host: { chat: "", bill: "", web: "" }, // 留空 = 用 engine/upstream 的默认
}

// normalizeScheduleHours(raw) -> {mp:number[], campaign:number[], buddy:number[], streak:number[], travel:number[], night:number[]}
//（导出供测试）键限制为 mp|campaign|buddy|streak|travel|night（growth/未知键丢弃），每条
// 腿只留 0–23 的整数并去重升序。输入不是对象时返回空腿表（调用方先与
// DEFAULT_SETTINGS.hours 合并，缺键由此兜底；用户显式写空的腿保持空，不会被
// 默认值复活——默认值本身也全是空）。
export function normalizeScheduleHours(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
  const out = {}
  for (const leg of SCHEDULE_HOURS_LEGS) {
    const hs = Array.isArray(src[leg]) ? src[leg] : []
    out[leg] = [...new Set(hs.map(Number).filter((h) => Number.isFinite(h) && h >= 0 && h <= 23 && Number.isInteger(h)))].sort((a, b) => a - b)
  }
  return out
}

// ---- 小工具 ------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowIso = () => new Date().toISOString()
const dateKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

// ---- 日期键小工具（小程序链式锁专用，全部 UTC 毫秒算术，与宿主时区无关）------
const DAY_MS = 86400000
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

function dayKeyToUtcMs(key) {
  const [y, m, d] = key.split("-").map(Number)
  return Date.UTC(y, m - 1, d)
}

function utcMsToDayKey(ms) {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`
}

// isValidDayKey：日历上真实存在的 YYYY-MM-DD（2026-13-40 一律 false）
function isValidDayKey(key) {
  if (!DAY_KEY_RE.test(key)) return false
  return utcMsToDayKey(dayKeyToUtcMs(key)) === key
}

// beijingDayFromIso("2026-11-08T00:00:00+08:00") -> "2026-11-08"（不可解析 → null）
// 上游 unlock_at 是**带时区**的 ISO（实测 +08:00）：先 Date.parse 成 epoch 再按
// 北京日取 —— 绝不能直接 slice 字符串，Z/UTC 形态会差一天。
function beijingDayFromIso(iso) {
  const s = String(iso ?? "").trim()
  if (!s) return null
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) return null
  return beijingDateKey(ms)
}

// scrub：把可能夹带凭据的文本洗一遍再出门（Bearer 头、JWT 形状的串）
const SECRET_RES = [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, /\beyJ[A-Za-z0-9._-]{16,}/g]
function scrub(s) {
  let out = String(s ?? "")
  for (const re of SECRET_RES) out = out.replace(re, "$1***")
  return out
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

function writeJson(file, data, mode) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8")
    if (mode) {
      try {
        chmodSync(tmp, mode) // Windows 上近似空操作；0600 在 Linux/macOS 生效
      } catch {}
    }
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

function shortErr(e) {
  return scrub(e?.message ?? String(e)).slice(0, 200)
}

// ---- 路由 → 是否需密钥（单一真相；契约 §3）----------------------------------
// 免密钥口径（用户明确要求「全部改成免密钥」，2026-10 定稿）：本守护进程是
// 局域网自建工具，**所有路由一律不需要密钥**——包括 POST /api/run、/api/stop、
// /api/task/claim、/api/task/accept、/api/checkin、/api/settings、
// /api/account/toggle、/api/shutdown、导入确认写入与含 token 的导出、SSE 与静态
// 资源。鉴权由网络边界负责：默认只绑 127.0.0.1（仅本机可达）；绑定 0.0.0.0/::
// 即暴露到容器网桥/局域网，同一局域网内任何主机都能触发批量任务、写入凭据、
// 导出 token 并关停进程（详见 README 安全段，风险如实写明）。
//
// API_ROUTE_AUTH 保留为「路由登记表」：每个路由在此唯一登记（path 是测试用的
// 样例路径，note 是给人看的一句话）；「全路由免密钥清单测试」遍历本表证明
// 不存在需要密钥的路径。若将来要重新引入鉴权，只改 routeNeedsKey 一处即可。
const API_ROUTE_AUTH = [
  { method: "GET", re: /^\/api\/hello$/, path: "/api/hello", note: "服务状态" },
  { method: "GET", re: /^\/api\/state$/, path: "/api/state", note: "看板状态快照" },
  { method: "GET", re: /^\/api\/history$/, path: "/api/history", note: "历史记录" },
  { method: "GET", re: /^\/api\/credits$/, path: "/api/credits", note: "积分余额与套餐权益包明细（?uid=，?refresh=1 强制拉取）" },
  { method: "GET", re: /^\/api\/streak$/, path: "/api/streak", note: "连登状态查询（?uid=，?refresh=1 强制拉取）" },
  { method: "GET", re: /^\/api\/campaign$/, path: "/api/campaign", note: "运营活动任务状态查询（?uid=，?refresh=1 强制拉取，§11.1）" },
  { method: "GET", re: /^\/api\/jobs\/[A-Za-z0-9_-]+$/, path: "/api/jobs/job-1", note: "job 查询" },
  { method: "GET", re: /^\/api\/events$/, path: "/api/events", note: "SSE 实时事件" },
  { method: "POST", re: /^\/api\/accounts$/, path: "/api/accounts", note: "重扫本地账号文件，无副作用" },
  { method: "GET", re: /^\/api\/accounts\/export$/, path: "/api/accounts/export", note: "账号导出（secrets=1 含 token）" },
  { method: "POST", re: /^\/api\/accounts\/import$/, path: "/api/accounts/import", note: "账号导入（confirm=true 写盘）" },
  { method: "POST", re: /^\/api\/run$/, path: "/api/run", note: "启动批量任务" },
  { method: "POST", re: /^\/api\/stop$/, path: "/api/stop", note: "停止当前任务" },
  { method: "POST", re: /^\/api\/task\/claim$/, path: "/api/task/claim", note: "单任务领奖" },
  { method: "POST", re: /^\/api\/task\/accept$/, path: "/api/task/accept", note: "单任务接取" },
  { method: "POST", re: /^\/api\/checkin$/, path: "/api/checkin", note: "手动签到" },
  { method: "POST", re: /^\/api\/streak\/run$/, path: "/api/streak/run", note: "手动跑连登管家（补签/礼包/兑换/抽奖）" },
  { method: "POST", re: /^\/api\/campaign\/run$/, path: "/api/campaign/run", note: "手动跑运营活动任务（viewed/判据/领奖，§11.1）" },
  { method: "POST", re: /^\/api\/campaign\/claim$/, path: "/api/campaign/claim", note: "单条活动任务领奖（必须回读 claimed_at 才算成功，§11.6）" },
  { method: "POST", re: /^\/api\/account\/unfreeze$/, path: "/api/account/unfreeze", note: "解冻 403/11140 冻结的账号" },
  { method: "POST", re: /^\/api\/settings$/, path: "/api/settings", note: "写设置" },
  { method: "POST", re: /^\/api\/account\/toggle$/, path: "/api/account/toggle", note: "参与任务开关" },
  { method: "POST", re: /^\/api\/shutdown$/, path: "/api/shutdown", note: "关停守护进程" },
]

export { API_ROUTE_AUTH }

const TRUTHY = ["1", "true", "yes"]
const isTruthyParam = (v) => TRUTHY.includes(String(v ?? "").trim().toLowerCase())
// secrets=0/false/no = 脱敏导出（删 token 两键）；缺省/1/true/其他值 = 含凭据真值导出。
// 这只是导出的脱敏开关（展示层口径），与鉴权无关 —— 免密钥口径下任何取值都放行。
const isSecretsFree = (v) => ["0", "false", "no"].includes(String(v ?? "").trim().toLowerCase())

// routeNeedsKey(method, pathname, cond) -> boolean（导出供测试）
// 单一真相：恒为 false —— 用户明确要求免密钥（局域网自建工具，鉴权由网络边界
// 负责，默认只绑 127.0.0.1）。签名与旧行为兼容（参数忽略）；带旧密钥的调用
// （Authorization: Bearer / ?k=）不做任何校验、不报 400/401，平滑过渡。
export function routeNeedsKey() {
  return false
}

// ---- 快照投影（导出供测试）-------------------------------------------------
// engine/tasks.fetchTasks 返回的规范 Task（CONTRACT §2）到这里已经是 camelCase
// —— 这里只做「取字段 + 数值化」，绝不再猜第二种键名拼写（否则上游改名时两种
// 拼写会同时静默变空）。
// P0-2：desktopOnly/unforgeable/reason/canAccept/canLight/pinnedExpertId 六个
// 判断字段出自 engine/taskkind.resolveTaskKind（与 fetchTasks 的 unforgeable/
// reason、流水线的接取/点亮决策同一判断源），前端据此渲染，不要再拿 jumpUrl
// 形状自己猜（真实数据 19 项全部有非空 jumpUrl）。
// snapTask(t, lock?) —— 次日锁投影（0.3.2 实测口径：上游清单自带 locked/unlock_at，
// 锁的主依据是**任务自身字段**，mp-locks 只是旧缓存的回退）：
//   1. 任务带自身锁信息（typeof locked === "boolean" 或 unlockAt 非空，新缓存/
//      新鲜清单必然带）→ 以上游为准：locked=false 必须能覆盖 mp-locks 里的陈旧
//      锁（「实测账号 ST2 上游已 locked:false」绝不能被推断/旧锁标成锁定）；
//   2. locked 仅在 acceptStatus==="not_accepted" 时为 true —— accepted/claimed
//      即使带 locked:true 也不标锁（绝不显示锁定徽章/提示）；
//   3. lockedUntil 从 unlockAt 解析为北京日期（带时区 ISO，Date.parse + 北京日，
//      不能直接 slice）；解析失败回退 mp-locks 的 until；
//   4. 任务完全没有自身锁字段（旧缓存/8·14 键老形态）→ 回退传入的 mp-locks 锁表；
//   5. lockHint 固定「到第二天才能接取任务（YYYY-MM-DD 起可接）」，没有日期时
//      「到第二天才能接取任务」。
// 三字段始终存在；锁定项 canAccept 一律 false（与 rk.canAccept 取与），canLight
// 等其余字段不变。
export function snapTask(t, lock = null) {
  const p = t?.progress ?? {}
  const rk = resolveTaskKind(t)
  const status = String(t?.acceptStatus ?? "")
  const hasOwnLockInfo = typeof t?.locked === "boolean" || String(t?.unlockAt ?? "").trim() !== ""
  const lockUntil = String(lock?.until ?? "")
  let locked = false
  let until = ""
  if (hasOwnLockInfo) {
    locked = t.locked === true && status === "not_accepted"
    if (locked) {
      until = beijingDayFromIso(t.unlockAt) ?? (isValidDayKey(lockUntil) ? lockUntil : "")
    }
  } else {
    // 旧缓存回退：mp-locks 锁表（accept 失败落盘的显式锁 / doClaim 的即时锁）
    locked = !!lock && isValidDayKey(lockUntil) && status === "not_accepted"
    if (locked) until = lockUntil
  }
  return {
    code: t?.code ?? "",
    title: t?.title ?? "",
    acceptStatus: t?.acceptStatus ?? "",
    progress: { current: Number(p.current) || 0, target: Number(p.target) || 0 },
    rewardCredit: Number(t?.rewardCredit) || 0,
    rewardEnergy: Number(t?.rewardEnergy) || 0,
    jumpUrl: t?.jumpUrl ?? "",
    taskType: t?.taskType ?? "",
    // 上游原文说明（tasks.normalize 的 description = description || task_desc）。
    // 「不可自动化 / 需桌面端」的任务只有它能说清「到底要做什么」（例如
    // skill_share 的「升级到电脑端 5.9.0+…」）—— 以前这层被投影丢掉，看板只剩
    // 一句「未收录任务」，用户无从判断。截断 300 字，避免异常长的脏数据撑爆。
    description: String(t?.description ?? "").trim().slice(0, 300),
    // 「需桌面端完成」（DESKTOP_ONLY_TASKS：伪造事件不推进、领奖必 400 的一族）
    desktopOnly: rk.desktopOnly === true,
    // 不可自动化 + 原因（spec.unforgeable 语义沿用；未收录任务也是
    // unforgeable:true + reason:"未收录任务"）
    unforgeable: rk.unforgeable === true,
    reason: String(rk.reason ?? ""),
    // 收敛结论：现在就能进「接取」（= not_accepted && 非 auto && !unforgeable，
    // 与引擎 needsAccept 同口径；被次日锁锁定的任务再与 !locked 取与）
    canAccept: rk.canAccept === true && !locked,
    // 收敛结论：引擎能/会用事件上报点亮（accepted，或 auto 的 not_accepted/
    // accepted；desktopOnly / 未收录一律 false；夜间窗口不含在内）
    canLight: rk.canLight === true,
    // 非空 = 事件 id 钉死该专家（TASK_SPECS 钉死或 jump_url 派生）；
    // 空串 = 不钉 id（expert/team 类走池子轮换，其它 kind 无专家 id）
    pinnedExpertId: String(rk.pinnedExpertId ?? ""),
    // 次日锁三字段（始终存在）：提示文案固定口径，前端直接渲染不必自己拼。
    locked,
    lockedUntil: locked ? until : "",
    lockHint: locked ? (until ? `到第二天才能接取任务（${until} 起可接）` : "到第二天才能接取任务") : "",
  }
}

// ---- 快照缓存（读取路径 = 投影的唯一出口）-----------------------------------
// state/snapshots.json 的磁盘格式：
//   v2（SNAP_VERSION，本版起）：{ snapVersion, tasks:规范Task[], energy, streak,
//     days, updatedISO } —— 落盘「投影前」的规范 Task（fetchTasks 的返回形状；
//     raw 非枚举本就不进 JSON），6 个判断字段不落盘，读取时重算。
//   v1 及更老（无版本戳）：{ tasks:投影后形态[], … } —— 8 键（最老）或 14 键。
//
// 升级缺陷（真实环境实测）：旧版 daemon 落盘的就是投影结果，新版读取时原样
// 吐出缓存 —— 8 键旧缓存里 6 个判断字段全是 undefined，前端把按钮可用性判错。
// 修复口径：缓存里的任务只是投影的「输入」，绝不是输出；accountRow()/statePayload()
// 出门前一律 projectSnapshot() 现场重投影。
export const SNAP_VERSION = 2

// 落盘用：规范 Task 的可序列化形状（只挑契约 §2 字段，raw/多余键不落盘）。
// ?? 兜底保证 v2 条目「字段完备」——哪怕引擎违约给了缺字段的 Task，落盘后
// 依然是可完整重投影的规范形状（v2 读取端因此可以信任条目）。
// 次日锁（0.3.2）：locked/unlockAt 是**投影的输入字段**（上游清单自带；MP 任务
// 与 web 任务都可能带 —— 2026-11-11 实测 web 清单的 Sequential_Tasks_7 也带
// locked:true + unlock_at），随规范 Task 落盘 —— v2 重投影直接以上游为
// 准，不依赖 mp-locks 推断。lockedUntil/lockHint 是投影输出，不落盘。
function cacheTask(t) {
  const p = t?.progress ?? {}
  return {
    code: t?.code ?? "",
    title: t?.title ?? "",
    description: t?.description ?? "",
    jumpUrl: t?.jumpUrl ?? "",
    acceptStatus: t?.acceptStatus ?? "",
    locked: t?.locked === true,
    unlockAt: String(t?.unlockAt ?? ""),
    taskType: t?.taskType ?? "",
    progress: { current: Number(p.current) || 0, target: Number(p.target) || 0 },
    rewardCredit: Number(t?.rewardCredit) || 0,
    rewardEnergy: Number(t?.rewardEnergy) || 0,
    unforgeable: t?.unforgeable === true,
    reason: String(t?.reason ?? ""),
  }
}

// v2 条目只需是对象（字段完备性由 cacheTask 的兜底保证）；数组/原始值一律挡下。
function isCacheEntryObject(t) {
  return !!t && typeof t === "object" && !Array.isArray(t)
}

// 旧版缓存条目能否无损重建投影：snapTask/resolveTaskKind 读的每个键都必须在，
// 且类型是旧写入路径（投影后 8/14 键）必然产出的那种。缺任何一个键都不是旧
// 写入路径写出的（它每键必落盘）—— 只能是文件残缺或更老的未知格式，而缺口
// 会让判断静默翻转：code 缺 → 全落「未收录任务」；taskType 缺 → auto 被当
// 非 auto；acceptStatus 缺/空 → 判断全 false（规范化后它永不为空）。
// 允许空串的只有上游真实会缺的字段：code/title/jumpUrl/taskType。
export function canReprojectTask(t) {
  if (!isCacheEntryObject(t)) return false
  if (typeof t.code !== "string") return false
  if (typeof t.title !== "string") return false
  if (typeof t.acceptStatus !== "string" || !t.acceptStatus) return false
  if (typeof t.jumpUrl !== "string") return false
  if (typeof t.taskType !== "string") return false
  const p = t.progress
  if (!p || typeof p !== "object" || Array.isArray(p)) return false
  if (!Number.isFinite(Number(p.current)) || !Number.isFinite(Number(p.target))) return false
  if (!Number.isFinite(Number(t.rewardCredit)) || !Number.isFinite(Number(t.rewardEnergy))) return false
  return true
}

// snapshots[uid] → /api/state 的 snapshot。永远现场 snapTask 重投影（snapTask
// 幂等：对投影后形态再投影，6 个判断字段由 code/title/acceptStatus/taskType/
// jumpUrl 重算，与直接刷新逐字节一致 —— 旧 8 键缓存升级读不必等下一次
// ?refresh=）；无法无损重建 → 整份快照过期返回 null，前端显示「快照已过期，
// 请刷新」。宁可空，不可错。
// locks（可选）是 mp-locks 的锁表 {code: {until, reason}}：映射时按 code 传给
// snapTask 投影出 locked/lockedUntil/lockHint；不传 = 无锁（兼容旧调用/老缓存）。
export function projectSnapshot(snap, locks = null) {
  if (!snap || typeof snap !== "object" || Array.isArray(snap)) return null
  if (!Array.isArray(snap.tasks)) return null
  if (snap.snapVersion === SNAP_VERSION) {
    // v2：本版本写入路径的产物，信任 + 重投影；只挡非对象条目（防手改坏文件）
    if (!snap.tasks.every(isCacheEntryObject)) return null
  } else {
    // 版本不符（含无版本戳的 v1）：先验「能否无损重建」，重建不出可信判断
    // 就整份作废 —— 部分重建会让前端拿着「看起来全对」的表渲染错按钮
    if (!snap.tasks.every(canReprojectTask)) return null
  }
  return {
    tasks: snap.tasks.map((t) => snapTask(t, locks?.[t?.code] ?? null)),
    energy: snap.energy ?? null,
    streak: snap.streak ?? null,
    days: snap.days ?? null,
    updatedISO: snap.updatedISO ?? "",
  }
}

// ---- 启动参数 -----------------------------------------------------------

function parseArgs(argv = process.argv.slice(2)) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--addr" || a === "--port" || a === "--cfg" || a === "--state" || a === "--key") out[a.slice(2)] = argv[++i]
  }
  return out
}

// "0.0.0.0:4390" | "0.0.0.0" | ":4390" | "4390"
// host 优先级：--addr 里的 host > WB_DAEMON_ADDR > 127.0.0.1（导出仅供测试断言链路）
export function parseAddr(s, fallbackPort) {
  // 默认只绑回环；Docker 里容器内回环外部不可达，可用 WB_DAEMON_ADDR 改成 0.0.0.0
  // （仅暴露到容器网桥，配合 SSH 隧道访问，切勿把该端口发布到公网）
  let host = String(process.env.WB_DAEMON_ADDR ?? "").trim() || "127.0.0.1"
  let port = fallbackPort
  if (typeof s === "string" && s.trim()) {
    const t = s.trim()
    if (/^\d+$/.test(t)) port = Number(t)
    else {
      const i = t.lastIndexOf(":")
      if (i >= 0) {
        host = t.slice(0, i) || host
        const p = Number(t.slice(i + 1))
        if (Number.isFinite(p) && p > 0) port = p
      } else host = t
    }
  }
  return { host, port }
}

// ---- serveUrl：看板显示/复制的「访问地址」 ---------------------------------
//
// 0.0.0.0/:: 是监听值不是访问值；看板顶栏要显示的是用户浏览器地址栏里那台机器的
// 地址（如 http://192.0.2.10:4390/）。取值链（docs/CONTRACT.md §3）：
//   ① 当前请求的 Host 头（最准确——用户实际就是用它访问的；外部输入，白名单校验）
//   ② MAGPIE_PUBLIC_URL 的 hostname（magpie 对外共享地址）+ 守护进程自己的端口
//   ③ bindHost（仅当是具体地址，不是 0.0.0.0/:: 通配）
//   兜底：http://127.0.0.1:<port>/
// 硬规则：返回串绝不含 0.0.0.0 / :: / *；只有 scheme://host[:port]/，不拼路径、
// 查询串、凭据或 key。bindHost/port/reachableHint 字段原样保留（向后兼容）。

const SERVE_HOSTNAME_MAX = 253 // RFC 1035 主机名长度上限
const SERVE_HOST_MAX = 255 // host[:port] 总长上限（253 + ":" + 5 位端口）
// 任何候选里出现监听值/通配记号 → 整串丢弃（宁可回退 127.0.0.1，不可上屏 0.0.0.0）
const SERVE_BAD_ADDR_RE = /0\.0\.0\.0|::|\*/

// Host 头白名单校验。通过 → {host, port}（host 为小写、不含端口；port 为显式端口
// 或 null）；不通过 → null（调用方落到取值链下一级）。规则：
//   - 字符集只允许 字母数字 . - _ [ ] :（空格/尖括号/斜杠/@/?/% 等一律拒绝——
//     这同时挡死了路径穿越、userinfo、查询串注入）
//   - 总长 ≤ 255、host 部分 ≤ 253；端口 1-65535 且无前导零
//   - host 部分必须是：IPv4 字面量 | localhost | 单标签 LAN 主机名（不含点）|
//     [IPv6] 方括号字面量；带点的非 IPv4（evil.com 这类公网/伪域名）不可信，拒绝
//   - 0.0.0.0 / 含 0.0.0.0、::、* 的值一律拒绝（监听值不是访问值）
export function sanitizeServeHost(raw) {
  if (typeof raw !== "string") return null
  const s = raw.trim()
  if (!s || s.length > SERVE_HOST_MAX || !/^[\w.\-\[\]:]+$/.test(s)) return null
  let hostPart = s
  let portPart = null
  if (s.startsWith("[")) {
    const close = s.indexOf("]")
    if (close < 0) return null
    hostPart = s.slice(1, close)
    const rest = s.slice(close + 1)
    if (rest && !rest.startsWith(":")) return null
    portPart = rest ? rest.slice(1) : null
  } else if (net.isIPv6(s)) {
    // 整串是 IPv6 全形字面量（bindHost 直接绑 IPv6 时的裸形态；HTTP 头里裸 IPv6
    // 不合法，但当作无端口 host 处理同样安全）——不做 host:port 拆分
  } else {
    const i = s.indexOf(":")
    if (i >= 0) {
      hostPart = s.slice(0, i)
      portPart = s.slice(i + 1)
      if (portPart.includes(":")) return null // 无方括号的多个冒号 = 畸形 IPv6，拒
    }
  }
  if (!hostPart || hostPart.length > SERVE_HOSTNAME_MAX) return null
  let port = null
  if (portPart != null) {
    if (!/^\d{1,5}$/.test(portPart) || /^0\d/.test(portPart)) return null
    const n = Number(portPart)
    if (!(n >= 1 && n <= 65535)) return null
    port = n
  }
  const shaped =
    net.isIPv4(hostPart) ||
    net.isIPv6(hostPart) || // Host 头 [IPv6] / bindHost 裸 IPv6 全形（缩写形含 :: 会被 BAD 拒）
    hostPart.toLowerCase() === "localhost" ||
    /^[A-Za-z0-9]([A-Za-z0-9_-]*[A-Za-z0-9])?$/.test(hostPart) // 单标签 LAN 主机名
  if (!shaped) return null
  if (SERVE_BAD_ADDR_RE.test(hostPart)) return null
  return { host: hostPart.toLowerCase(), port }
}

// MAGPIE_PUBLIC_URL（运维显式声明的 magpie 对外共享地址）→ 展示用 hostname。
// 属配置输入而非请求输入：放行公网域名，但仍查形状并拒绝通配/监听值。
function publicServeHost(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null
  let u
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null
  const h = u.hostname // URL 解析过的 hostname；IPv6 字面量带方括号
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h
  if (!bare || bare.length > SERVE_HOSTNAME_MAX) return null
  if (!/^[\w.\-]+$/.test(bare) && !net.isIPv6(bare)) return null // 放行域名/单标签/IPv4/IPv6 全形
  if (SERVE_BAD_ADDR_RE.test(bare)) return null
  return bare.toLowerCase()
}

// 取值链合成（纯函数，测试可直接驱动）。port 为守护进程实际绑定端口（bind 后必 ≥1，
// 异常输入按默认端口兜底）。任何一级产出含 0.0.0.0/::/* 都整串丢弃、继续下一级。
export function computeServeUrl({ hostHeader, publicUrl, bindHost, port } = {}) {
  const p = Number(port)
  const safePort = Number.isFinite(p) && p > 0 ? p : DEFAULT_PORT
  const bracket = (h) => (h.includes(":") ? `[${h}]` : h) // IPv6 字面量要加方括号
  // ① Host 头（显式端口优先；无显式端口说明走的就是 80/默认映射，URL 不带端口）
  const h = sanitizeServeHost(hostHeader)
  if (h) {
    const url = h.port != null ? `http://${bracket(h.host)}:${h.port}/` : `http://${bracket(h.host)}/`
    if (!SERVE_BAD_ADDR_RE.test(url)) return url
  }
  // ② MAGPIE_PUBLIC_URL 的 hostname + 守护进程自己的端口
  const pub = publicServeHost(publicUrl)
  if (pub) {
    const url = `http://${bracket(pub)}:${safePort}/`
    if (!SERVE_BAD_ADDR_RE.test(url)) return url
  }
  // ③ bindHost 仅当具体地址（0.0.0.0/::/畸形在 sanitize 里已拒）
  const b = sanitizeServeHost(bindHost)
  if (b) {
    const url = `http://${bracket(b.host)}:${safePort}/`
    if (!SERVE_BAD_ADDR_RE.test(url)) return url
  }
  // 兜底
  return `http://127.0.0.1:${safePort}/`
}

// ---- 引擎装载（engine/* 由另一个 agent 编写；缺失时全部优雅降级） ---------

async function loadEngine(log) {
  const eng = { store: null, runner: null, tasks: null, upstream: null, credits: null, miniprogram: null, errors: [] }
  const want = [
    ["store", "./engine/store.mjs"],
    ["runner", "./engine/runner.mjs"],
    ["tasks", "./engine/tasks.mjs"],
    ["upstream", "./engine/upstream.mjs"],
    ["credits", "./engine/credits.mjs"],
    // 连登管家（0.3.3，CONTRACT §10.1）：GET /api/streak 与 POST /api/streak/run
    // 的引擎出口（fetchStreakState / runStreakSteward）。缺文件按可选降级处理
    //（路由报 503 引擎不可用，不影响其余功能）。
    ["streak", "./engine/streak.mjs"],
    // 运营活动任务（0.3.5，CONTRACT §11.1）：GET /api/campaign 与
    // POST /api/campaign/run 的引擎出口（fetchCampaignState / runCampaignTasks）。
    // 可选降级同上（503 引擎不可用，不影响其余功能）。
    ["campaign", "./engine/campaign.mjs"],
    // 小程序链式任务（0.3.0）：tasks.mjs 本就静态 import 它（缺文件时 tasks 也
    // 加载不了），这里单独登记是为了快照合并（fetchMPTasks）与 accept/claim
    // 分流（acceptMPTasks/claimMPTask）能拿到具名模块引用。
    ["miniprogram", "./engine/miniprogram.mjs"],
  ]
  for (const [name, spec] of want) {
    try {
      eng[name] = await import(spec)
    } catch (e) {
      eng.errors.push(`${spec} 加载失败：${shortErr(e)}`)
    }
  }
  if (!eng.errors.length && (!eng.store || !eng.runner)) {
    eng.errors.push("engine/store.mjs 或 engine/runner.mjs 没有导出约定接口（契约 §2）")
  }
  eng.ok = eng.errors.length === 0
  if (!eng.ok) for (const m of eng.errors) log("[engine] " + m)
  return eng
}

function makeRunner(engine, ctx, log) {
  const Ctor = engine?.runner?.JobRunner
  if (typeof Ctor !== "function") return null
  try {
    return new Ctor(ctx)
  } catch (e) {
    log("[engine] JobRunner 构造失败：" + shortErr(e))
    engine.errors.push("JobRunner 构造失败：" + shortErr(e))
    return null
  }
}

// =======================================================================
// startDaemon：可被测试导入（注入 fake engine / 固定 key / 端口 0），也可作脚本运行
// =======================================================================

export async function startDaemon(opts = {}) {
  const log = opts.log ?? ((...a) => console.log(new Date().toISOString(), ...a))
  const now = opts.now ?? (() => Date.now())
  const sleepFn = opts.sleep ?? sleep

  // ---- 目录与参数 ----
  const args = opts.args ?? parseArgs()
  const cfgDir = resolve(args.cfg || opts.cfgDir || process.env.WB_CONFIG_DIR || resolveCfgDir(process.env))
  const stateDir = resolve(args.state || opts.stateDir || process.env.WB_STATE_DIR || stateDirFor(cfgDir))
  mkdirSync(stateDir, { recursive: true })
  const dashDir = join(PLUGIN_DIR, "dashboard")

  // 端口优先级：opts.port（测试注入）> --port > WB_DAEMON_PORT > 默认 4390；
  // 0 = 让操作系统挑一个空闲端口
  const wantPort = Number.isFinite(opts.port)
    ? opts.port
    : args.port !== undefined
      ? Number(args.port)
      : Number(process.env.WB_DAEMON_PORT) || DEFAULT_PORT
  const addr = parseAddr(args.addr, wantPort)
  const host = opts.host || addr.host
  const managed = process.env.WB_MANAGED === "1" || opts.managed === true

  // ---- control.json：唯一意图来源；daemon.json：拒双开 ----
  const controlFile = join(stateDir, "control.json")
  if (!existsSync(controlFile)) writeJson(controlFile, { desired: "on" })

  if (opts.skipExistingCheck !== true) {
    const prev = readDaemonInfo(stateDir)
    if (prev && prev.pid !== process.pid && pidAlive(prev.pid)) {
      const alive = await probeDaemon(prev.port, prev.key).catch(() => null)
      if (alive) {
        const err = new Error(`已有守护进程在运行（pid ${prev.pid}，端口 ${prev.port}），拒绝重复启动，避免双写凭据`)
        err.code = "WB_DAEMON_ALREADY_RUNNING"
        throw err
      }
    }
  }

  // key 只落 daemon.json（0600，向后兼容保留的字段：index.mjs/lifecycle 的探测
  // 逻辑与老看板会读它），不是访问凭据 —— 免密钥口径下任何接口都不校验它。
  const key = opts.key || args.key || process.env.WB_DAEMON_KEY || readDaemonInfo(stateDir)?.key || crypto.randomBytes(24).toString("base64url")

  // ---- 引擎 ----
  const engine = opts.engine ?? (await loadEngine(log))

  // ---- 状态文件 ----
  const settingsFile = join(stateDir, "settings.json")
  const snapshotsFile = join(stateDir, "snapshots.json")
  const historyFile = join(stateDir, "history.json")
  const firedFile = join(stateDir, "lastFired.json")
  const accountsFile = join(stateDir, "accounts.json") // uid -> tasksEnabled 布尔（/api/account/toggle 写入）
  // 本插件经手 JSON 导入的 acctKey 台账（契约 §9）：magpie 整体覆写 plugin-auth.json
  // 会抹掉 importedFrom 标记，这份记录让 /api/state 的 imported 仍可用（尽力而为口径）
  const hubImportsFile = join(stateDir, "hub-imports.json")
  // 每日活跃的幂等账本（CONTRACT §7）：uid -> 北京日键 "YYYY-MM-DD"。job 开始前
  // runner 据此决定「每个账号每个北京日只发一条 chat 事件」，onSent 原子写回。
  const dailyActivityFile = join(stateDir, "daily-activity.json")
  // 积分缓存（CONTRACT §3 credits）：uid -> fetchCredits 的 credits 形状。启动
  // 读入，损坏/非对象按 {}；成功拉取后原子写回（writeJson tmp+rename）。/api/state
  // 与 /api/credits 的缓存命中路径只读这份缓存，绝不顺手打上游。
  const creditsFile = join(stateDir, "credits.json")
  // 连登状态缓存（CONTRACT §10.2 streak）：uid -> fetchStreakState 的 state 形状。
  // 新鲜期 10 分钟（与 credits 同口径）；/api/state 的 accounts[].streak 只读投影
  // 这份缓存，绝不为它打上游。
  const streakFile = join(stateDir, "streak.json")
  // 运营活动任务缓存（CONTRACT §11.1 campaign）：uid -> fetchCampaignState 的
  // state 形状。缓存/节流口径与 streak 完全一致（10 分钟新鲜期，CREDITS_TTL_MS）；
  // /api/state 的 accounts[].campaign 只读投影这份缓存，绝不为它打上游。
  const campaignFile = join(stateDir, "campaign.json")
  // 403/11140 冻结台账（CONTRACT §10.5）：uid -> {at:ISO, code, message}，tmp+
  // rename 原子写（与 daily-activity.json 同目录同原语）。冻结账号不进
  // eligibleNow()/排程选号/缺省目标，只有 POST /api/account/unfreeze 能解冻，
  // 绝不自动恢复；重启后由本文件恢复冻结状态（runner 构造时经 frozenMap 读入）。
  const frozenFile = join(stateDir, "frozen.json")

  let settings = { ...DEFAULT_SETTINGS, ...readJson(settingsFile, {}) }
  // 安全默认（C1）：settings.json 缺失或损坏时 readJson 落 {}，scheduler 按
  // DEFAULT_SETTINGS 回落 false——装好插件不会自动打上游；再把两枚布尔开关
  // 钉成真布尔，手改文件写出的 truthy 垃圾（如 "yes"）也开不了排程/自动领奖，
  // 只有 POST /api/settings（校验 boolean）或看板开关能显式打开。
  settings.scheduler = settings.scheduler === true
  settings.claim = settings.claim === true
  // 排程小时窗口只认 mp|buddy|travel|night（本版起 growth 不再由排程触发）：旧
  // settings.json 里的 hours.growth 在这里丢弃，未知键一律不收，缺的键补默认
  //（默认值全空 = 默认不排；用户 settings.json 里显式写空的腿保持空，不会被
  // 默认值复活）。growth 仍可手动跑：settings.legs / POST /api/run 的 legs 不受影响。
  settings.hours = normalizeScheduleHours({ ...DEFAULT_SETTINGS.hours, ...(settings.hours ?? {}) })
  settings.host = { ...DEFAULT_SETTINGS.host, ...(settings.host ?? {}) }
  let snapshots = readJson(snapshotsFile, {})
  let history = Array.isArray(readJson(historyFile, [])) ? readJson(historyFile, []) : []
  let fired = readJson(firedFile, {})
  let tasksEnabledMap = readJson(accountsFile, {})
  let hubImports = readJson(hubImportsFile, {})
  if (!hubImports || typeof hubImports !== "object" || Array.isArray(hubImports)) hubImports = {}
  // 每日活跃账本：文件损坏/形状不对一律按空对象起步（绝不阻断启动；顶多重发
  // 一条每日活跃事件，上游按北京日幂等，无害）。
  let dailyActivity = readJson(dailyActivityFile, {})
  if (!dailyActivity || typeof dailyActivity !== "object" || Array.isArray(dailyActivity)) dailyActivity = {}
  // 积分缓存：文件损坏/形状不对一律按空对象起步（绝不阻断启动；顶多下一次
  // GET /api/credits 重新拉取）。
  let creditsCache = readJson(creditsFile, {})
  if (!creditsCache || typeof creditsCache !== "object" || Array.isArray(creditsCache)) creditsCache = {}
  // 连登缓存：损坏/形状不对一律按空对象起步（绝不阻断启动；顶多下一次
  // GET /api/streak 重新拉取）。
  let streakCache = readJson(streakFile, {})
  if (!streakCache || typeof streakCache !== "object" || Array.isArray(streakCache)) streakCache = {}
  // 活动任务缓存：同款归一（损坏/非对象按 {} 起步，顶多下一次 GET /api/campaign
  // 重新拉取）。
  let campaignCache = readJson(campaignFile, {})
  if (!campaignCache || typeof campaignCache !== "object" || Array.isArray(campaignCache)) campaignCache = {}
  // 冻结台账（CONTRACT §10.5）：形状不对按空对象起步；条目逐条归一（at 统一成
  // ISO 串、message 截断），坏条目丢弃不阻断启动。台账是 daemon 侧冻结状态
  // 的单一事实：runner 启动时经 frozenMap 读入同一份数据，之后每次 freeze/
  // unfreeze 经回调双向同步（onFrozen/onUnfrozen 原子写回本文件）。
  let frozenState = readJson(frozenFile, {})
  if (!frozenState || typeof frozenState !== "object" || Array.isArray(frozenState)) frozenState = {}
  frozenState = normalizeFrozenState(frozenState)
  // 小程序链式任务锁（0.3.2）：state/mp-locks.json 记录 次日锁 与
  // 领奖日期（uid -> code -> 北京日）。损坏/形状不对 → 空表起步：顶多丢一层
  // 防御/即时锁（主依据是上游清单的 locked/unlock_at），绝不阻断启动。
  const mpLocksFile = join(stateDir, "mp-locks.json")
  const mpLocks = normalizeMPLockState(readJson(mpLocksFile, null))

  function readSettings() {
    return JSON.parse(JSON.stringify(settings))
  }
  const saveSettings = () => writeJson(settingsFile, settings)
  const saveSnapshots = () => writeJson(snapshotsFile, snapshots)
  const saveHistory = () => writeJson(historyFile, history.slice(-HISTORY_CAP))
  const saveFired = () => writeJson(firedFile, fired)
  const saveAccountsState = () => writeJson(accountsFile, tasksEnabledMap)
  const saveHubImports = () => writeJson(hubImportsFile, hubImports)
  const saveDailyActivity = () => writeJson(dailyActivityFile, dailyActivity)
  const saveCredits = () => writeJson(creditsFile, creditsCache)
  const saveStreak = () => writeJson(streakFile, streakCache)
  const saveCampaign = () => writeJson(campaignFile, campaignCache)
  const saveFrozen = () => writeJson(frozenFile, frozenState)
  const saveMPLocks = () => writeJson(mpLocksFile, mpLocks)

  // normalizeFrozenState(raw)：冻结台账逐条归一（CONTRACT §10.5 的
  // {uid:{at:ISO, code, message}}）。at 解析不出就记当前时刻（冻结语义不依赖
  // 精确时刻，宁可补一个也不丢条目）；code 保留原值（number|string 都合法）；
  // message 截断 200。坏条目（非对象/缺 uid）丢弃 —— 保住还能用的部分比整份
  // 拒读更接近真实状态（与 mp-locks 的归一口径一致）。
  function normalizeFrozenState(raw) {
    const out = {}
    const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
    for (const [uid, entry] of Object.entries(src)) {
      if (!uid || !entry || typeof entry !== "object" || Array.isArray(entry)) continue
      const atMs = Date.parse(String(entry.at ?? ""))
      out[uid] = {
        at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : new Date(now()).toISOString(),
        code: entry.code ?? 11140,
        message: scrub(String(entry.message ?? "")).slice(0, 200),
      }
    }
    return out
  }

  // ---- 小程序链式任务锁（0.3.2）：落盘 + 查询 -------------------------------
  //
  // mp-locks.json 形状：{ locks: {uid: {code: {until, reason, at}}}, claims: {uid: {code: "YYYY-MM-DD"}} }
  //   locks  —— 次日锁：until 是北京时间日期，**until 当天即解锁**（「锁到 11-07」
  //             表示 11-07 可用）；同一 code 永远保留更晚的 until。
  //   claims —— 链式任务的领奖日期（北京日，doClaim/onClaimed 记账）。
  //
  // 定位（0.3.2 实测后收窄）：上游清单自带 locked/unlock_at，是快照投影的**唯一
  // 主依据**（snapTask 上游字段优先）。mp-locks 只剩两个防御/过渡用途：
  //   1. accept 被上游锁拒时解析失败消息落盘的显式锁（兼容假引擎/旧引擎）；
  //   2. doClaim/onClaimed 领奖成功时给下一环记「明天」的即时锁 —— 只在旧缓存
  //      （无自身锁字段）的回退路径可见，下一次快照刷新后必被上游字段覆盖
  //      （上游 locked:false 优先于这里的陈旧锁）。

  // 归一（启动时读入）：损坏/形状不对的条目逐条丢弃，绝不整份拒读 —— 保住还
  // 能用的部分比全丢重推更接近真实状态。
  function normalizeMPLockState(raw) {
    const out = { locks: {}, claims: {} }
    const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}
    const locks = src.locks && typeof src.locks === "object" && !Array.isArray(src.locks) ? src.locks : {}
    for (const [uid, codes] of Object.entries(locks)) {
      if (!uid || !codes || typeof codes !== "object" || Array.isArray(codes)) continue
      const per = {}
      for (const [code, entry] of Object.entries(codes)) {
        if (!code || !entry || typeof entry !== "object" || Array.isArray(entry)) continue
        const until = String(entry.until ?? "")
        if (!isValidDayKey(until)) continue
        per[code] = { until, reason: String(entry.reason ?? "").slice(0, 200), at: String(entry.at ?? "") }
      }
      if (Object.keys(per).length) out.locks[uid] = per
    }
    const claims = src.claims && typeof src.claims === "object" && !Array.isArray(src.claims) ? src.claims : {}
    for (const [uid, codes] of Object.entries(claims)) {
      if (!uid || !codes || typeof codes !== "object" || Array.isArray(codes)) continue
      const per = {}
      for (const [code, day] of Object.entries(codes)) {
        if (!code || typeof day !== "string" || !isValidDayKey(day)) continue
        per[code] = day
      }
      if (Object.keys(per).length) out.claims[uid] = per
    }
    return out
  }

  // 北京「今天」/「明天」（beijingDateKey 口径，UTC 16:00 翻北京日；now 可注入）
  const beijingToday = () => beijingDateKey(now())
  const beijingTomorrow = () => beijingDateKey(now() + DAY_MS)

  // recordMPLock(uid, code, until, reason)：记一条次日锁。until 必须是合法的
  // YYYY-MM-DD；同一 code 取更晚的 until（更早的信息不覆盖，显式锁优先于推断）。
  function recordMPLock(uid, code, until, reason = "") {
    if (!uid || !code || !isValidDayKey(String(until ?? ""))) return false
    const key = String(until)
    const per = (mpLocks.locks[uid] ??= {})
    const prev = per[code]
    if (prev && prev.until >= key) return true // 已有更晚（或同日）的锁：不动
    per[code] = { until: key, reason: String(reason ?? "").slice(0, 200), at: new Date(now()).toISOString() }
    return saveMPLocks()
  }

  // recordMPClaim(uid, code)：领奖日期 = 北京时间今天。
  function recordMPClaim(uid, code) {
    if (!uid || !code) return false
    const per = (mpLocks.claims[uid] ??= {})
    per[code] = beijingToday()
    return saveMPLocks()
  }

  // lockedMapFor(uid) -> {code: {until, reason}}：当前仍生效的锁。生效条件
  // until > 北京今天（until 当天即解锁）；顺手清掉已过期条目（有过期才写盘，
  // 平时只读不发 IO）。注意：这是**旧缓存/防御层**的锁源 —— 上游清单自带
  // locked/unlock_at 时投影以上游为准（snapTask），上游 locked:false 会覆盖
  // 这里的陈旧锁；下一次快照刷新后 mp-locks 即被上游字段取代。
  function lockedMapFor(uid) {
    const today = beijingToday()
    const per = mpLocks.locks[uid]
    if (!per || typeof per !== "object") return {}
    const out = {}
    let pruned = false
    for (const [code, entry] of Object.entries(per)) {
      if (!(entry?.until > today)) {
        delete per[code]
        pruned = true
        continue
      }
      out[code] = { until: entry.until, reason: entry.reason ?? "" }
    }
    if (pruned) saveMPLocks()
    return out
  }

  if (!existsSync(settingsFile)) saveSettings()

  // ---- 全局节流器（铁律 4 的唯一归属，本进程仅此一个） -----------------------
  // 所有打上游的路径共用它：job 腿（runner → engine/tasks|travel）、token 临期
  // 刷新（runner._maybeRefresh → refreshAccount）、快照刷新（finalizeJob 之后与
  // GET /api/state?refresh= → refreshSnapshots）、手动操作（/api/task/claim、
  // /api/task/accept、/api/checkin → engineOpts()）。此前各路径各自维护节奏
  // （固定 sleep + 各自的 engine ctx），等待窗一旦重叠就贴着发 —— e2e 抓到的
  // 0ms 间隔正是 finalizeJob→refreshSnapshots 撞上手动 claim。spacer 记录
  // 「上次上游调用放行时刻」并排队串行：并发入口后者等待，绝不在途并行。
  // engine 缺 makeSpacer（老引擎/测试假引擎）时降级为 null，行为与旧版一致。
  const upstreamSpacer =
    typeof engine?.upstream?.makeSpacer === "function"
      ? engine.upstream.makeSpacer({ now, sleep: sleepFn, gap: () => settings.gapMs })
      : null

  // ---- runner（settings 就绪后再构造；ctx 只依赖契约 §2 + runner 的可选 opts） ----
  const runnerCtx = {
    cfgDir,
    stateDir,
    settings: () => readSettings(),
    // runner 可选注入（engine/runner.mjs 的 opts）：账号由我们合并好 tasksEnabled 再给。
    // 与列表同源（纯国内版口径）：只把 provider==="workbuddy" 的账号交给引擎，
    // 国际版绝不进任何 job（runner 内部的 eligibleAccounts 是第二道 cn 过滤）。
    loadAccounts: () => loadAccountsCn(),
    // 铁律 3：token 刷新后原子回写 plugin-auth.json（engine/store.saveAccountRefresh），
    // 保证 magpie 社区插件与我们用的是同一对凭据。
    saveRefresh: (acctKey, patch) => {
      const save = engine?.store?.saveAccountRefresh
      if (typeof save !== "function") {
        throw new Error("引擎未提供 saveAccountRefresh（engine/store.mjs），拒绝回写凭据")
      }
      return save(cfgDir, acctKey, patch)
    },
    // settings 动态读取（getter：spread 进 legOpts 时取当前值，改设置对下一个 job 生效）
    get gap() {
      return settings.gapMs
    },
    // 每日活跃（CONTRACT §7）：幂等账本与落盘回调交给 runner —— runner 在每个
    // 账号开跑前调 engine/daily.reportDailyActivity，成功经 onDailySent 原子写回
    // state/daily-activity.json（writeJson 的 tmp+rename 原语），重启后同一天
    // 不再重发。写盘失败只少一份持久化（顶多下次 job 重发一条，上游幂等）。
    dailySentMap: dailyActivity,
    onDailySent: (uid, key) => {
      dailyActivity[uid] = key
      saveDailyActivity()
    },
    // 403/11140 冻结（CONTRACT §10.5）：初始台账（state/frozen.json 读入的同一份
    // 对象）交给 runner，之后任何腿收到 restricted 经 onFrozen 原子写回、解冻经
    // onUnfrozen 删除 —— runner 的内存冻结表与本文件之间永不分叉。写盘失败只少
    // 一份持久化（重启后该账号顶多再撞一次 403，会再次冻结）。
    frozenMap: frozenState,
    onFrozen: (uid, entry) => {
      frozenState[uid] = entry
      saveFrozen()
      log(`[frozen] ${uid} 触发 403/11140，已冻结（${scrub(String(entry?.message ?? "")).slice(0, 120)}）；确认无风险后可解冻`)
    },
    onUnfrozen: (uid) => {
      delete frozenState[uid]
      saveFrozen()
      log(`[frozen] ${uid} 已解冻`)
    },
    // 小程序链式任务锁（需求 2）：runner 在 growth 腿的 2b 与 mp 腿把这些透传给
    // 引擎（engine/runner._mpLockOpts）—— mpLockedCodes 供引擎整条跳过仍锁定的
    // 任务；onLock 落盘上游锁原因（accept 被拒时）；onClaimed 记领奖日期。
    onMPLock: (uid, code, until, reason) => recordMPLock(uid, code, until, reason),
    onMPClaimed: (uid, code) => recordMPClaim(uid, code),
    mpLockedCodes: (uid) => Object.keys(lockedMapFor(uid)),
    // 铁律 4：全局节流器（上面创建的唯一实例）—— job 腿与 token 刷新的每一次
    // 上游调用都经它排队对齐，与快照刷新/手动操作共用同一份「上次放行时刻」。
    ...(upstreamSpacer ? { spacer: upstreamSpacer } : {}),
    // 看板的 host 覆盖（settings.host）透传给引擎 —— 空串 = 用 engine/upstream 默认
    get bases() {
      return { chat: settings.host.chat || "", bill: settings.host.bill || "", web: settings.host.web || "" }
    },
    env: { WB_CONFIG_DIR: cfgDir, WB_STATE_DIR: stateDir },
    log: (...a) => log(...a.map(scrub)),
    now,
    sleep: sleepFn,
    // 测试/嵌入注入：假 fetch 顶替全部上游网络（engine 全程走 opts.fetch，零真实请求）
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  }
  const runner = opts.runner ?? makeRunner(engine, runnerCtx, log)

  // ---- 账号（经 engine/store 读 plugin-auth.json；缺引擎时空列表） --------
  let accountsError = ""

  // 纯国内版口径（用户明确要求「国际版账号不出现」）：本插件只服务国内版
  // provider === "workbuddy"；workbuddy-ai（国际版）不进列表、不进快照/汇总/统计、
  // 不进排程/运行。**过滤只发生在 daemon 使用侧**（本文件这一个函数是唯一边界，
  // 列表/统计/排程/运行/单账号操作全部经它取数）：engine/store.loadAccounts 行为
  // 不变，仍返回全部 workbuddy* 条目（accountio 的导入合并与导出 realm=intl
  // 逃生口要用全量）——别把过滤挪进 store 层。
  function loadAccountsCn(all = loadAccountsAll()) {
    return all.filter((a) => a.provider === "workbuddy")
  }

  // 国际版账号的只读诊断计数：只给数量与说明，绝不列出 intl 账号内容（契约 §3）
  const INTL_SKIPPED_NOTE = "本插件只服务国内版 workbuddy，国际版账号不列出、不参与任务、不默认导出"
  function intlSkippedCountOf(all) {
    return all.filter((a) => a.provider === "workbuddy-ai").length
  }

  // 企业版账号（社区 issue #3）：acct.enterpriseId 非空 = 企业版，没有成长任务与
  // 签到。与国际版完全同口径：不进 /api/state 的 accounts[]（statePayload 同一处
  // 过滤点追加）、不进任何 job 与单账号操作（accountByUid 一律「找不到」，不从
  // 侧门进引擎）；计数只给数量与去向说明（enterpriseSkipped），绝不列出企业版
  // 账号内容（uid/昵称/域名/enterpriseId 都不给）。过滤同样只发生在 daemon 使用
  // 侧：engine/store.loadAccounts 与 accountio 的导入/导出（导出行本就带
  // enterpriseId 字段，契约 §9）仍可见全量数据 —— 别把过滤下沉进 store 层。
  const isEnterpriseAcct = (a) => !!a?.enterpriseId
  function enterpriseSkippedCountOf(all) {
    // 计数与 intlSkipped 各自独立（provider 分域）：国际版账号只进 intlSkipped，
    // 企业版只统计 provider==="workbuddy" 的条目，绝不互相重复计数。
    return all.filter((a) => a.provider === "workbuddy" && isEnterpriseAcct(a)).length
  }
  const enterpriseSkippedNote = (n) =>
    `已忽略 ${n} 个企业版账号：企业版没有成长任务与签到，本插件只服务个人版`
  // /api/credits 与 /api/streak 对企业版 uid 的 404 专属文案（镜像同一段，§10.8）：
  // 说清「为什么看不到」与「去哪里看」，绝不泄露昵称/域名/enterpriseId 等额外信息。
  const ENTERPRISE_NO_GROWTH_MSG =
    "企业版账号没有成长体系（无任务与积分查询），已从看板隐藏；如需查看请在 magpie 里切换个人版账号"

  function cfgEnvLike() {
    const envLike = { ...process.env, WB_CONFIG_DIR: cfgDir, WB_STATE_DIR: stateDir }
    return envLike
  }

  function loadAccountsAll() {
    accountsError = ""
    const load = engine?.store?.loadAccounts
    if (typeof load !== "function") {
      accountsError = "引擎未就绪：engine/store.mjs 不可用，读不到 magpie 的 WorkBuddy 账号"
      return []
    }
    try {
      const list = load(cfgDir) || []
      // tasksEnabled 生效值：accounts.json 里的显式条目（/api/account/toggle 写入）
      // 优先；没有条目时用 engine/store 的 tasks-accounts.json；两边都没有 = 参与。
      return list.map((a) => {
        const override = tasksEnabledMap[a.uid]
        return { ...a, tasksEnabled: override === undefined ? a.tasksEnabled !== false : override !== false }
      })
    } catch (e) {
      accountsError = `读取账号失败：${shortErr(e)}（plugin-auth.json 在 ${cfgDir}，Docker 里通常是 /config/magpie）`
      return []
    }
  }

  // ---- 冻结（CONTRACT §10.5）：排除与查询 -----------------------------------
  // runtime 的单一事实是 runner 的冻结表（frozenState 读入 + 回调同步）；假引擎/
  // 老 runner 没有 frozen()/isFrozen() 时回退持久化台账（尽力而为口径）。
  function frozenUidSet() {
    const fn = runner?.frozen
    if (typeof fn === "function") {
      try {
        const list = fn.call(runner)
        if (Array.isArray(list)) {
          return new Set(list.map((x) => String(x?.uid ?? "")).filter(Boolean))
        }
      } catch {}
    }
    return new Set(Object.keys(frozenState))
  }

  const isFrozenUid = (uid) => frozenUidSet().has(String(uid ?? ""))

  function frozenMessageOf(uid) {
    const e = frozenEntryOf(uid)
    return scrub(String(e?.message ?? "")).slice(0, 160)
  }

  // 单账号的冻结记录（accounts[].frozen 投影）：优先 runner 的实时冻结表
  //（onFrozen 已同步进台账，但老 runner/假 runner 只有内存表），回退持久化台账。
  function frozenEntryOf(uid) {
    const fn = runner?.frozen
    if (typeof fn === "function") {
      try {
        const hit = fn.call(runner).find((x) => String(x?.uid ?? "") === String(uid))
        if (hit) {
          return {
            at: hit.at ?? null,
            code: hit.code ?? 11140,
            message: scrub(String(hit.message ?? "")),
          }
        }
      } catch {}
    }
    return frozenState[uid] ?? null
  }

  // 冻结总览（/api/state 顶层 frozen）：runner 的冻结表拼上昵称；at/code/message
  // 原样透出（at 为 ISO 串）。老 runner 没有 frozen() 时回退台账。
  function frozenOverview() {
    const fn = runner?.frozen
    let list = null
    if (typeof fn === "function") {
      try {
        list = fn.call(runner)
      } catch {
        list = null
      }
    }
    if (!Array.isArray(list)) {
      list = Object.entries(frozenState).map(([uid, e]) => ({ uid, ...(e ?? {}) }))
    }
    const nick = new Map(loadAccountsCn().map((a) => [a.uid, a.nickname || a.uid]))
    return list
      .filter((f) => f && typeof f === "object" && f.uid)
      .map((f) => ({
        uid: String(f.uid),
        nickname: nick.get(String(f.uid)) ?? String(f.uid),
        at: f.at ?? null,
        code: f.code ?? 11140,
        message: scrub(String(f.message ?? "")),
      }))
  }

  // daemon 侧的显式冻结入口（runner 之外的路由，如 POST /api/streak/run 撞上
  // restricted）：写台账 + 同步 runner 的内存表。已冻结的账号不覆盖记录。
  function freezeAccount(uid, info = {}) {
    const key = String(uid ?? "")
    if (!key || frozenState[key]) return !!frozenState[key]
    frozenState[key] = {
      at: new Date(now()).toISOString(),
      code: info.code ?? 11140,
      message: scrub(String(info.message ?? "")).slice(0, 200),
    }
    saveFrozen()
    try {
      runner?.freeze?.(key, { code: frozenState[key].code, message: frozenState[key].message })
    } catch {}
    log(`[frozen] ${key} 触发 403/11140，已冻结；确认无风险后可解冻`)
    return true
  }

  function eligibleNow() {
    const accts = loadAccountsCn() // 与列表同源：只有国内版账号可能参与任务
    const filter = engine?.store?.eligibleAccounts
    let list = []
    try {
      list = (typeof filter === "function" ? filter(accts) : []) || []
    } catch {
      // 兜底：按契约 §2 的过滤规则本地再筛一遍
      list = accts.filter((a) => a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false)
    }
    // 冻结账号（403/11140，CONTRACT §10.5）不进可参与名单：排程选号、/api/run
    // 与 /api/checkin、/api/streak/run 的缺省目标都从这里取 —— 缺省口径一律
    // 绕开冻结账号（显式指定的失败提示由各操作自己负责）。
    const frozen = frozenUidSet()
    return frozen.size ? list.filter((a) => !frozen.has(String(a.uid))) : list
  }

  // 引擎调用的公共注入（契约 §2 的 opts 形状）：手动操作与快照刷新也必须走同一套
  // fetch/时钟/bases —— 否则会绕开注入的 fetch 替身与防风控节奏。spacer 同理：
  // 这里是 daemon 内所有引擎调用的唯一 opts 工厂，全局节流器经它进入每一条
  // 路径 —— 任何调用点新建 opts 都自动带上同一个 spacer，不存在「新 ctx 忘了对齐」。
  function engineOpts(acct = null) {
    return {
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      now,
      sleep: sleepFn,
      gap: settings.gapMs,
      ...(upstreamSpacer ? { spacer: upstreamSpacer } : {}),
      bases: { chat: settings.host.chat || "", bill: settings.host.bill || "", web: settings.host.web || "" },
      env: { WB_CONFIG_DIR: cfgDir, WB_STATE_DIR: stateDir },
      // 传入账号时附带小程序锁回调（需求 2）：手动 /api/task/accept、
      // /api/task/claim 与快照刷新同样记录锁与领奖，保证 mp-locks.json 与批量
      // job 路径同一份台账。回调异常由引擎侧吞掉，不影响主流程。
      ...(acct
        ? {
            onLock: (code, until, reason) => recordMPLock(acct.uid, code, until, reason),
            onClaimed: (code) => recordMPClaim(acct.uid, code),
          }
        : {}),
    }
  }

  function accountByUid(uid) {
    // 与列表同源：只在国内个人版账号里找（intl 与企业版 uid 一律「找不到」，
    // 不会从侧门进引擎；企业版口径见上方 enterpriseSkippedCountOf 注释）。
    return loadAccountsCn().find((a) => a.uid === uid && !isEnterpriseAcct(a)) || null
  }

  // ---- 快照（/api/state 的 tasks/energy/streak；只在闲时刷新，限流） ------
  let snapBusy = false

  async function refreshSnapshots(uids, budgetMs = 12000) {
    const fetchTasks = engine?.tasks?.fetchTasks
    if (typeof fetchTasks !== "function" || snapBusy) return
    if (runner?.current()) return // 有 job 在跑就让路，别跟它抢限速窗口
    snapBusy = true
    try {
      const deadline = now() + budgetMs
      for (const uid of uids.slice(0, 5)) {
        if (now() > deadline || runner?.current()) break
        const acct = accountByUid(uid)
        if (!acct) continue
        try {
          await sleepFn(1000) // 限速红线：与上一轮上游调用（可能是刚结束的 job）之间 ≥1s
          const tasks = await fetchTasks(acct, engineOpts(acct))
          // 小程序清单合并（0.3.0）：web 清单之后用小程序头族再拉一份 MP 清单，
          // **只补 web 清单里没有的 code**（Sequential_Tasks_1–6 + school_season
          // 这类 MP 专属任务）——同一 code 以 web 清单为准，绝不重复/覆盖 web
          // 状态。MP 拉取失败只记日志，不影响 web 快照（宁可少一项，不拖垮整份）。
          let merged = Array.isArray(tasks) ? tasks : []
          const fetchMPTasks = engine?.miniprogram?.fetchMPTasks
          if (typeof fetchMPTasks === "function") {
            try {
              await sleepFn(1000) // 限速红线：与 fetchTasks 之间 ≥1s
              const mpTasks = await fetchMPTasks(acct, engineOpts(acct))
              if (Array.isArray(mpTasks) && mpTasks.length) {
                const have = new Set(merged.map((t) => t.code))
                const mpOnly = mpTasks.filter((t) => t?.code && !have.has(t.code))
                if (mpOnly.length) merged = [...merged, ...mpOnly]
              }
            } catch (e) {
              log(`[snapshot] ${uid} 小程序清单拉取失败（不影响 web 快照）：${shortErr(e)}`)
            }
          }
          // 次日锁（0.3.2）：上游清单自带 locked/unlock_at，随 cacheTask 落盘；
          // 投影（snapTask）以上游字段为准 —— 这里不再做任何锁推断/落盘。
          let energy
          let days
          const up = engine?.upstream
          if (typeof up?.callJSON === "function" && typeof up?.growthBase === "function" && now() < deadline) {
            await sleepFn(1000) // 限速红线：两次上游调用 ≥1s
            const e = await up.callJSON(acct, "chat", `${up.growthBase()}/v2/activity/growth/energy`, {}, engineOpts(acct))
            // 字段口径与 engine/tasks.fetchEnergy 对齐（P1 实测 2026-10-31：上游
            // 是 data.balance，data 里没有 energy/value 键）——只认这一种拼写，
            // 不做多拼写回退链（契约 §3：daemon 只做投影，不猜第二种键名）。
            if (e?.ok && e?.code === 0) energy = e.data?.balance ?? 0
            await sleepFn(1000)
            const s = await up.callJSON(acct, "chat", `${up.growthBase()}/activity/growth/streak`, {}, engineOpts(acct))
            // 字段口径与 engine/tasks.fetchGrowthSummary 对齐（P1 实测 2026-10-31：
            // data.streak.days；makeup_cards/redemption_status 同层）——data 顶层
            // 没有 days/streakDays 键，绝不回退去猜。
            if (s?.ok && s?.code === 0) days = s.data?.streak?.days ?? 0
          }
          // 落盘「投影前」的规范 Task + 版本戳：投影只在读取路径发生
          //（projectSnapshot → snapTask），引擎侧判断演进后老缓存也能读出新结论
          snapshots[uid] = {
            snapVersion: SNAP_VERSION,
            tasks: merged.map(cacheTask),
            energy: energy ?? snapshots[uid]?.energy ?? null,
            streak: days ?? snapshots[uid]?.streak ?? null,
            days: days ?? snapshots[uid]?.days ?? null,
            updatedISO: nowIso(),
          }
          saveSnapshots()
        } catch (e) {
          log(`[snapshot] ${uid} 刷新失败：${shortErr(e)}`)
        }
        await sleepFn(1500) // 账号间隔
      }
    } finally {
      snapBusy = false
    }
  }

  // ---- 活动缓存收尾刷新（CONTRACT §11.5：job 结束写回 state/campaign.json）--
  // job 真跑过 campaign 腿的账号，收尾时静默 fetchCampaignState 写回
  // state/campaign.json —— 让看板活动明细在 job 完成后自动更新（不再要求用户
  // 手动点「刷新快照」）。调用方（finalizeJob）按 step.leg === "campaign" 过滤，
  // 没跑 campaign 腿的账号不进这里（没跑就查一次上游是浪费）。节奏与
  // refreshSnapshots 同款：每账号前 ≥1s 限速红线 + 账号间隔 1500ms，上游调用
  // 经 engineOpts() 的全局节流器排队（绝不绕过铁律 4）；有 job 在跑就让路。
  // 失败只记日志（restricted 也只是失败文案，绝不在收尾路径冻结账号），绝不抛、
  // 绝不影响 job 结论 —— 调用点 fire-and-forget（.catch(() => {})）。
  async function refreshCampaignAfterJob(uids) {
    const fn = engine?.campaign?.fetchCampaignState
    if (typeof fn !== "function") return
    for (const uid of uids) {
      if (runner?.current()) return // 有 job 在跑就让路，别跟它抢限速窗口（同 refreshSnapshots）
      const acct = accountByUid(uid)
      if (!acct) continue
      try {
        await sleepFn(1000) // 限速红线：与上一轮上游调用（可能是刚结束的 job）之间 ≥1s
        const state = await fn(acct, engineOpts(acct))
        if (state?.ok) {
          // 只写缓存投影（与 fetchCampaignForUid 成功路径同一落点）：/api/state
          // 的 accounts[].campaign 与 GET /api/campaign 的 TTL（state.updatedISO）
          // 从下一次读取起自动看到新值。
          campaignCache[uid] = state
          saveCampaign()
        } else {
          log(`[campaign] ${uid} 刷新失败：${scrub(String(state?.error || state?.msg || "活动任务读取失败"))}`)
        }
      } catch (e) {
        log(`[campaign] ${uid} 刷新失败：${shortErr(e)}`)
      }
      await sleepFn(1500) // 账号间隔
    }
  }

  // ---- 连登缓存收尾刷新（§11.5 对称缺口：job 结束写回 state/streak.json）----
  // 前端「跑一轮」改走 job 后，连登天数/补签卡/抽奖数不再有 POST /api/streak/run
  // 的返回值可即时回填 —— job 真跑过 streak 腿的账号，收尾时静默
  // fetchStreakState 写回 state/streak.json（与 GET /api/streak 成功路径同一
  // 落点；/api/state 投影与 TTL 依据 updatedISO 自动看到新值）。触发条件、节奏、
  // 失败口径与 refreshCampaignAfterJob 完全同款：调用方（finalizeJob）按
  // step.leg === "streak" 且非 skip 过滤（腿没跑/冻结跳过都不刷），两条刷新在
  // finalizeJob 里串行执行（绝不并发打上游），每账号前 ≥1s 限速红线 + 账号
  // 间隔 1500ms，上游调用经 engineOpts() 的全局节流器排队；有 job 在跑就让路；
  // 失败只记日志，绝不抛、绝不影响 job 结论。
  async function refreshStreakAfterJob(uids) {
    const fn = engine?.streak?.fetchStreakState
    if (typeof fn !== "function") return
    for (const uid of uids) {
      if (runner?.current()) return // 有 job 在跑就让路，别跟它抢限速窗口（同 refreshSnapshots）
      const acct = accountByUid(uid)
      if (!acct) continue
      try {
        await sleepFn(1000) // 限速红线：与上一轮上游调用（可能是刚结束的 job）之间 ≥1s
        const state = await fn(acct, engineOpts(acct))
        if (state?.ok) {
          // 只写缓存投影（与 fetchStreakForUid 成功路径同一落点）
          streakCache[uid] = state
          saveStreak()
        } else {
          log(`[streak] ${uid} 刷新失败：${scrub(String(state?.error || state?.msg || "连登状态查询失败"))}`)
        }
      } catch (e) {
        log(`[streak] ${uid} 刷新失败：${shortErr(e)}`)
      }
      await sleepFn(1500) // 账号间隔
    }
  }

  // ---- 历史（每次尝试一行） ----------------------------------------------

  // 历史 trigger 口径（看板「触发」列）：触发方式住在 job.spec.trigger
  //（runner.normalizeSpec 已归一为 "schedule" | "manual"）——真实引擎的 job 顶层
  // 没有 trigger 字段，以前直接读 job.trigger 会把排程行永远写成 manual。兼容
  // 旧式外壳/假引擎直接挂在顶层的 job.trigger；最终只输出 "schedule" | "manual"
  // 两种拼写（其余一律按 manual，绝不透出第三种值）。
  function historyTrigger(job) {
    const t = job?.spec?.trigger ?? job?.trigger
    return t === "schedule" ? "schedule" : "manual"
  }

  function appendHistory(job) {
    const steps = Array.isArray(job?.steps) ? job.steps : []
    for (const s of steps) {
      history.push({
        // 契约 §2 的 Step.at 是毫秒数（engine），老式引擎/外壳给 ISO 串 —— 统一成 ISO
        at: typeof s.at === "number" ? new Date(s.at).toISOString() : s.at ?? nowIso(),
        uid: s.uid ?? "",
        nickname: s.nickname ?? "",
        leg: s.leg ?? "",
        state: s.state ?? "",
        detail: scrub(s.detail ?? ""),
        credit: s.credit ?? 0,
        energy: s.energy ?? 0,
        jobId: job.id,
        trigger: historyTrigger(job),
      })
    }
    if (history.length > HISTORY_CAP) history = history.slice(-HISTORY_CAP)
    saveHistory()
  }

  function computeStats() {
    const today = dateKey()
    let credit = 0
    let energy = 0
    const jobIds = new Set()
    for (const r of history) {
      if (String(r.at ?? "").slice(0, 10) !== today) continue
      if (r.state === "ok" || r.state === "skip") {
        credit += Number(r.credit) || 0
        energy += Number(r.energy) || 0
      }
      if (r.jobId) jobIds.add(r.jobId)
    }
    const cur = runner?.current?.() ?? null
    if (cur) jobIds.add(cur.id)
    return { creditsToday: credit, energyToday: energy, runs: jobIds.size }
  }

  // ---- SSE ---------------------------------------------------------------

  const sseClients = new Set()
  function broadcast(obj) {
    const line = `data: ${JSON.stringify(obj)}\n\n`
    for (const res of sseClients) {
      try {
        res.write(line)
      } catch {
        sseClients.delete(res)
      }
    }
  }

  // job 观察者：轮询 runner 的 Job，把新增 step / log 行 / 状态变化推给 SSE，
  // job 结束时落历史、刷新快照。只依赖契约 §2 的 get()/current()。
  let watchedJobId = null
  let watchedSteps = 0
  let watchedLog = 0
  let watchedState = ""
  let pendingJobId = null // 刚启动还没被 tick 看到的 job；结束时兜底落历史

  function resetWatch() {
    watchedJobId = null
    watchedSteps = 0
    watchedLog = 0
    watchedState = ""
  }

  function safeJob(job) {
    if (!job) return null
    const j = { ...job }
    if (Array.isArray(j.log)) j.log = j.log.map(scrub)
    if (Array.isArray(j.steps)) j.steps = j.steps.map((s) => ({ ...s, detail: scrub(s.detail ?? "") }))
    return j
  }

  function finalizeJob(job) {
    if (!job) return
    pendingJobId = null
    appendHistory(job)
    // 与 /api/run、/api/stop 一致：出门前过 safeJob（洗日志 + 不带内部字段）
    broadcast({ kind: "job", job: safeJob(job) })
    const steps = Array.isArray(job.steps) ? job.steps : []
    const uids = [...new Set(steps.map((s) => s.uid).filter(Boolean))]
    if (uids.length) refreshSnapshots(uids, 12000).catch(() => {})
    // 活动缓存收尾刷新（CONTRACT §11.5）：只刷真跑过 campaign 腿的账号 ——
    // 腿没跑（无 campaign step）或整账号冻结跳过的（step.state === "skip"，
    // 上游一个活动请求都没发过）都不刷，没跑就查一次上游是浪费。收尾是
    // fire-and-forget：失败只记日志，绝不影响 job 结论。
    const campaignUids = [
      ...new Set(
        steps
          .filter((s) => s.leg === "campaign" && s.state !== "skip")
          .map((s) => s.uid)
          .filter(Boolean),
      ),
    ]
    // 连登缓存收尾刷新（§11.5 对称缺口）：同款条件 —— 前端「跑一轮」改走 job
    // 后，连登天数/补签卡/抽奖数不再有同步路由的返回值可回填，靠这里写回
    // state/streak.json 让看板自动更新。
    const streakUids = [
      ...new Set(
        steps
          .filter((s) => s.leg === "streak" && s.state !== "skip")
          .map((s) => s.uid)
          .filter(Boolean),
      ),
    ]
    // 两条收尾刷新串行执行（campaign → streak）：全局节流器本就把上游调用排成
    // 队，这里再把两个刷新巡回也串起来 —— 绝不并发打上游；中途有新 job 启动时
    // 各自让路。fire-and-forget：失败只记日志，绝不影响 job 结论。
    const refreshCachesAfterJob = async () => {
      if (campaignUids.length) await refreshCampaignAfterJob(campaignUids)
      if (streakUids.length) await refreshStreakAfterJob(streakUids)
    }
    if (campaignUids.length || streakUids.length) refreshCachesAfterJob().catch(() => {})
  }

  function watchJobTick() {
    try {
      const cur = runner?.current?.() ?? null
      if (!cur) {
        // job 结束（或两次 tick 之间开始又结束）：runner.current() 对 done/error
        // 一律返回 null，所以这里要同时认领「刚启动还没被看过」（pendingJobId）
        // 和「曾被看过运行中、现已结束」（watchedJobId）两种落历史时机 —— 否则
        // 跑得比 tick 久的 job 永远不会落历史/刷新快照/发收尾 SSE。
        const finishedId = pendingJobId ?? watchedJobId
        if (finishedId) {
          const job = safeJob(runner?.get?.(finishedId) ?? null)
          if (!job || job.state === "done" || job.state === "error") {
            if (job) finalizeJob(job)
            else pendingJobId = null
          }
        }
        if (watchedJobId) resetWatch()
        return
      }
      if (cur.id !== watchedJobId) {
        watchedJobId = cur.id
        pendingJobId = null
        watchedSteps = 0
        watchedLog = 0
        watchedState = ""
        broadcast({ kind: "job", job: safeJob(cur) })
      }
      const steps = Array.isArray(cur.steps) ? cur.steps : []
      for (; watchedSteps < steps.length; watchedSteps++) {
        const s = steps[watchedSteps]
        broadcast({ kind: "step", jobId: cur.id, step: { ...s, detail: scrub(s.detail ?? "") } })
      }
      const logLines = Array.isArray(cur.log) ? cur.log : []
      for (; watchedLog < logLines.length; watchedLog++) {
        broadcast({ kind: "log", jobId: cur.id, line: scrub(logLines[watchedLog]) })
      }
      if (cur.state !== watchedState) {
        watchedState = cur.state
        if (cur.state === "done" || cur.state === "error") finalizeJob(cur)
        else broadcast({ kind: "job", job: safeJob(cur) })
      }
    } catch (e) {
      log("[watch] " + shortErr(e))
    }
  }

  // ---- 排程（小时窗口；同一天同一窗口只发一次；有 job 在跑就让路） --------
  let lastCycle = fired.lastCycle ?? null

  function schedulerNextRuns() {
    const out = []
    for (const [leg, hours] of Object.entries(settings.hours)) {
      for (const h of Array.isArray(hours) ? hours : []) out.push([leg, h])
    }
    out.sort((a, b) => a[1] - b[1])
    return out
  }

  function checkScheduler(nowMs = Date.now()) {
    try {
      if (!settings.scheduler) return null
      const cur = runner?.current?.() ?? null
      if (cur) return null
      // 时区口径（CONTRACT §7/§8）：小时窗口按**北京时间（UTC+8）**解释，与容器
      // 时区无关。生产 magpie 容器是 UTC（date 显示 UTC、TZ 为空），以前用
      // new Date(nowMs).getHours() 会把北京 09:00 读成 1 点 —— 命中 night 而不是
      // travel。settings.hours 的数字含义不变，就是北京小时。
      const h = beijingHour(nowMs)
      const legs = Object.entries(settings.hours)
        .filter(([, hs]) => (Array.isArray(hs) ? hs : []).includes(h))
        .map(([leg]) => leg)
        .filter((leg) => LEGS.includes(leg))
      if (!legs.length) return null
      // 同日去重键的日期段 = 北京日期（UTC 16:00 整翻北京日）。旧 lastFired.json
      // 里的键是宿主时区口径（UTC 容器 = UTC 日期），不做迁移：键形不同互不命中，
      // 最坏只多触发一个窗口，绝不为此清空用户的 fired 文件。
      const fireKey = `${legs.join("+")}@${h}@${beijingDateKey(nowMs)}`
      if (fired[fireKey]) return null
      const eligible = eligibleNow()
      if (!eligible.length) {
        // 没账号就不算「触发过」，但也不必 30s 一试：标记掉，明天的窗口再说
        fired[fireKey] = nowIso()
        saveFired()
        log(`[scheduler] 窗口 ${fireKey} 到点但没有可参与任务的账号，跳过`)
        broadcast({ kind: "scheduler", event: "skip", legs, hour: h, reason: "无可参与账号" })
        return null
      }
      // 先启动，成功才标记「已触发」；引擎瞬时不可用时窗口内还会重试
      const job = startJob({
        uids: eligible.map((a) => a.uid),
        legs,
        claim: settings.claim,
        trigger: "schedule",
        jitterMs: settings.jitterMs,
      })
      fired[fireKey] = nowIso()
      fired.lastCycle = fired[fireKey]
      lastCycle = fired[fireKey]
      saveFired()
      broadcast({ kind: "scheduler", event: "fire", legs, hour: h, jobId: job?.id ?? null })
      log(`[scheduler] 窗口触发：${legs.map((l) => LEG_NAMES[l] ?? l).join(" + ")}，job ${job?.id ?? "?"}`)
      return job
    } catch (e) {
      log("[scheduler] " + shortErr(e))
      return null
    }
  }

  // ---- job 控制 -----------------------------------------------------------

  // 任务级勾选（CONTRACT §3）：/api/run body.codes 的两种形状 → runner 的
  // taskCodes（{uid: string[]} | null）。
  //   - 不传 / 空 / 非法类型 → null（全部任务，兼容现状；非法输入绝不 500）
  //   - 数组 → 对 job 内每个选中账号都只做这些 code
  //   - 对象 → 按 uid 归一；未出现的 uid 或空数组 = 该账号全部任务；
  //     不在选中名单里的 uid 丢弃（runner 不会跑它们）
  // 每个 uid 的清单：去重、只留非空字符串、上限 TASK_CODES_CAP。
  const TASK_CODES_CAP = 500

  function cleanCodeList(value) {
    const out = []
    if (!Array.isArray(value)) return out
    for (const c of value) {
      if (typeof c !== "string") continue
      const t = c.trim()
      if (t && !out.includes(t)) out.push(t)
      if (out.length >= TASK_CODES_CAP) break
    }
    return out
  }

  function normalizeRunCodes(codes, uids) {
    if (Array.isArray(codes)) {
      const list = cleanCodeList(codes)
      if (!list.length) return null
      const map = {}
      for (const uid of uids) map[uid] = [...list]
      return map
    }
    if (codes && typeof codes === "object") {
      const map = {}
      for (const uid of uids) {
        const list = cleanCodeList(codes[uid])
        if (list.length) map[uid] = list
      }
      return Object.keys(map).length ? map : null
    }
    return null
  }

  function startJob(spec = {}) {
    if (!runner) {
      const err = new Error(engineErrorsText())
      err.code = "WB_ENGINE_UNAVAILABLE"
      throw err
    }
    const legs = (Array.isArray(spec.legs) && spec.legs.length ? spec.legs : settings.legs).filter((l) => LEGS.includes(l))
    if (!legs.length) legs.push("growth")
    const eligible = eligibleNow()
    const known = new Set(eligible.map((a) => a.uid))
    let uids = Array.isArray(spec.uids) && spec.uids.length ? spec.uids.filter((u) => known.has(u)) : eligible.map((a) => a.uid)
    if (!uids.length) {
      const err = new Error(
        accountsError ||
          "没有可参与任务的账号：需要 magpie 里已登录的 workbuddy（国内版）oauth 账号，且未关闭任务参与",
      )
      err.code = "WB_NO_ACCOUNTS"
      throw err
    }
    const job = runner.start({
      uids,
      legs,
      claim: spec.claim !== undefined ? !!spec.claim : settings.claim,
      trigger: spec.trigger === "schedule" ? "schedule" : "manual",
      gapMs: settings.gapMs,
      jitterMs: Array.isArray(spec.jitterMs) ? spec.jitterMs : settings.jitterMs,
      // 任务级勾选（CONTRACT §3）：body.codes 的两种形状在这里归一成
      // {uid: string[]} | null；growth 腿在 runner 里据此只处理选中任务。
      taskCodes: normalizeRunCodes(spec.codes, uids),
    })
    if (job?.id) pendingJobId = job.id
    return job
  }

  function engineErrorsText() {
    const errs = engine?.errors?.length ? engine.errors.join("；") : "engine/*.mjs 缺失或不可用"
    return `任务引擎不可用：${errs}（引擎文件由 engine/ 提供，装好完整插件后重试）`
  }

  async function stopCurrentJob() {
    const cur = runner?.current?.() ?? null
    if (!cur) return null
    let job = cur
    try {
      if (typeof runner.stop === "function") {
        const r = await Promise.race([runner.stop(cur.id), sleepFn(2000).then(() => null)])
        if (r) job = r
      } else if (typeof cur.stop === "function") {
        await Promise.race([cur.stop(), sleepFn(2000).then(() => null)])
      } else {
        log("[job] runner 未实现 stop()，只能等当前 job 自然结束（契约 §8 要求 runner 支持步骤边界中止）")
      }
    } catch (e) {
      log("[job] 停止失败：" + shortErr(e))
    }
    return safeJob(job)
  }

  // ---- 手动单账号操作（领奖 / 接取 / 签到） -------------------------------
  // 这些也走上游，跑 job 期间一律 409，避免跟批量任务抢限速与凭据。

  async function manualOp(handler) {
    if (runner?.current()) {
      return { status: 409, body: { error: "busy" } }
    }
    // 限速红线：手动操作与上一次上游调用（可能是刚结束的 job）之间也 ≥1s
    await sleepFn(Math.max(1000, Number(settings.gapMs) || 0))
    try {
      return { status: 200, body: await handler() }
    } catch (e) {
      return { status: 500, body: { error: shortErr(e) } }
    }
  }

  async function doClaim(uid, code) {
    const c = String(code || "")
    // 引擎能力检查在最前（与旧口径一致：「任务引擎不可用」先于账号/参数校验）；
    // MP code 要求 miniprogram.claimMPTask，web code 要求 tasks.claimTask。
    const fn = isMPCode(c) ? engine?.miniprogram?.claimMPTask : engine?.tasks?.claimTask
    if (typeof fn !== "function") throw new Error(engineErrorsText())
    const acct = accountByUid(uid)
    if (!acct) throw new Error(`找不到账号 ${uid}（重新扫描账号或检查 plugin-auth.json）`)
    // 显式指定的冻结账号如实失败（CONTRACT §10.5）：不静默跳过、不碰上游
    if (isFrozenUid(uid)) {
      return {
        ok: false,
        credit: 0,
        energy: 0,
        via: "",
        reason: `账号已冻结（11140）：${frozenMessageOf(uid)}；确认无风险后在账号行点「恢复」`,
      }
    }
    // 小程序任务（0.3.0 起进快照）领奖走小程序头族（MP_HEADERS），web 回退语义
    // 由 claimMPTask 自带；返回形状与 web 领奖一致（MP 模块无 via 字段 → 空串）。
    const r = await fn(acct, c, engineOpts(acct))
    // 0.3.2：MP 领奖成功 → 记领奖日期；Sequential_Tasks_N（N<6）同时给 N+1 记
    // 一条「明天」的即时锁 —— 让旧缓存（无上游锁字段）的看板在下一次快照刷新前
    // 也能显示锁定；刷新后以上游 locked/unlock_at 为准（上游 locked:false 会覆盖
    // 这里的陈旧锁）。recordMPLock 同 code 取更晚，不会覆盖更晚的显式锁。
    if (isMPCode(c) && r?.ok) {
      recordMPClaim(uid, c)
      const m = /^Sequential_Tasks_(\d+)$/.exec(c)
      const n = m ? Number(m[1]) : 0
      if (n >= 1 && n < 6) {
        recordMPLock(uid, `Sequential_Tasks_${n + 1}`, beijingTomorrow(), "完成任务后次日才能接取")
      }
    }
    return {
      ok: !!r?.ok,
      credit: r?.credit ?? 0,
      energy: r?.energy ?? 0,
      via: r?.via ?? "",
      reason: scrub(r?.reason ?? ""),
    }
  }

  async function doAccept(uid, codes) {
    const list = (Array.isArray(codes) ? codes : []).map(String).filter(Boolean)
    // 引擎能力检查在最前（与旧口径一致）：按 isMPCode 分流（0.3.0）后，MP 组要求
    // miniprogram.acceptMPTasks，其余（含空列表的旧口径）要求 tasks.acceptTasks。
    const web = list.filter((c) => !isMPCode(c))
    const mp = list.filter((c) => isMPCode(c))
    const needWeb = mp.length ? web.length > 0 : true
    if (
      (needWeb && typeof engine?.tasks?.acceptTasks !== "function") ||
      (mp.length && typeof engine?.miniprogram?.acceptMPTasks !== "function")
    ) {
      throw new Error(engineErrorsText())
    }
    const acct = accountByUid(uid)
    if (!acct) throw new Error(`找不到账号 ${uid}`)
    if (!list.length) throw new Error("codes 不能为空")
    // 显式指定的冻结账号如实失败（CONTRACT §10.5）：所有请求的 code 都进 failed，
    // reason 统一带「恢复」提示 —— 不静默跳过、不碰上游。
    if (isFrozenUid(uid)) {
      const reason = `账号已冻结（11140）：${frozenMessageOf(uid)}；确认无风险后在账号行点「恢复」`
      return { accepted: [], already: [], failed: list.map((c) => ({ code: c, reason })) }
    }
    // web 清单任务走 tasks.acceptTasks（chat 头族），小程序任务走
    // miniprogram.acceptMPTasks（MP_HEADERS）；两边结果合并，返回形状不变
    //（accepted/already/failed）。注意 MP 模块把 already_accepted 并进 accepted
    //（无独立 already 数组），合并后 MP 侧不贡献 already。
    const out = { accepted: [], already: [], failed: [] }
    if (web.length) {
      const r = await engine.tasks.acceptTasks(acct, web, engineOpts(acct))
      out.accepted.push(...(r?.accepted ?? []))
      out.already.push(...(r?.already ?? []))
      out.failed.push(...(r?.failed ?? []))
    }
    if (mp.length) {
      const r = await engine.miniprogram.acceptMPTasks(acct, mp, engineOpts(acct))
      out.accepted.push(...(r?.accepted ?? []))
      out.failed.push(...(r?.failed ?? []))
      // 需求 2 的防御层：onLock 回调（真引擎经 engineOpts 已带上）之外，再从
      // 返回的 failed/failures 里解析一遍锁原因并落盘 —— 兼容未实现回调的假
      // 引擎/旧引擎。recordMPLock 同 code 取更晚，与回调重复登记无害。
      const parse = typeof engine.miniprogram.parseMPLock === "function" ? engine.miniprogram.parseMPLock : null
      if (parse) {
        const items = [
          ...(Array.isArray(r?.failures) ? r.failures : []),
          ...(Array.isArray(r?.failed) ? r.failed : []),
        ]
        for (const item of items) {
          const fcode = typeof item === "string" ? item : String(item?.code ?? "")
          const msg = typeof item === "string" ? "" : String(item?.message ?? "")
          const lock = fcode ? parse(msg) : null
          if (lock) recordMPLock(uid, fcode, lock.until, msg.slice(0, 200))
        }
      }
    }
    out.failed = out.failed.map((f) => (typeof f === "string" ? f : { ...f, reason: scrub(f?.reason ?? "") }))
    return out
  }

  // 签到回执细分（CONTRACT §10.4，hub #596）：outcome ∈ claimed|done|pending|failed。
  // 「失败」是唯一硬词 —— msg 含「不足」（如「距离 7 天奖励还不足」）不得判失败；
  // pending 词（处理中/请勿重复操作/系统繁忙/稍后再试）优先于一切 —— 原实现把
  // code=0 一律当成功，会把「请求处理中，请勿重复操作」记成已领，当天再也不重试。
  const CHECKIN_PENDING_RE = /处理中|请勿重复操作|系统繁忙|稍后再试/
  function classifyCheckin(code, msg, alreadyFlag) {
    const m = String(msg ?? "")
    if (CHECKIN_PENDING_RE.test(m)) return "pending"
    if (code === 0) return /失败/.test(m) ? "failed" : alreadyFlag ? "done" : "claimed"
    if (code === 10001) return /已签到|已签/.test(m) ? "done" : "failed"
    return "failed"
  }

  async function doCheckin(uids) {
    const up = engine?.upstream
    if (typeof up?.callJSON !== "function" || typeof up?.billBase !== "function") {
      throw new Error(engineErrorsText())
    }
    const targets = (Array.isArray(uids) && uids.length ? uids : eligibleNow().map((a) => a.uid)).slice(0, 20)
    const out = []
    for (const uid of targets) {
      const acct = accountByUid(uid)
      if (!acct) {
        out.push({ uid, outcome: "failed", message: "找不到账号" })
        continue
      }
      // 显式指定的冻结账号如实失败（CONTRACT §10.5），不静默跳过
      if (isFrozenUid(uid)) {
        out.push({
          uid,
          outcome: "failed",
          message: `账号已冻结（11140）：${frozenMessageOf(uid)}；确认无风险后在账号行点「恢复」`,
        })
        continue
      }
      try {
        const r = await up.callJSON(acct, "billing", `${up.billBase()}/billing/meter/daily-checkin`, { method: "POST" }, engineOpts())
        if (r?.ok && r?.code === 0) {
          const d = r.data ?? {}
          const already = d.already === true || d.signed === true || /已签/.test(String(r.msg ?? ""))
          const outcome = classifyCheckin(r.code, r.msg, already)
          out.push({
            uid,
            outcome,
            // pending 不算成功：积分/连登不可信，一律不记（当天可重试）
            credit: outcome === "pending" ? 0 : Number(d.credit ?? d.points ?? d.point ?? 0) || 0,
            streak: outcome === "pending" ? undefined : d.streak ?? d.days,
            message: scrub(r.msg ?? ""),
          })
        } else {
          const outcome = classifyCheckin(r?.code, r?.msg, false)
          out.push({
            uid,
            outcome,
            // 10001 +「已签到」在上游可能不带 ok/code===0 信封（r.ok=false 但语义
            // 是 done）—— 回执细分按 code/msg 判定，不迷信 HTTP 层
            credit: outcome === "done" ? Number(r?.data?.credit ?? 0) || 0 : 0,
            streak: outcome === "done" ? r?.data?.streak ?? r?.data?.days : undefined,
            message: scrub(r?.msg || `HTTP ${r?.status ?? "?"} code ${r?.code ?? "?"}`),
          })
        }
      } catch (e) {
        out.push({ uid, outcome: "failed", message: shortErr(e) })
      }
      await sleepFn(1500) // 账号间隔（手动节奏）
    }
    return out
  }

  // ---- 积分余额（GET /api/credits，CONTRACT §3）---------------------------
  // engine/credits.fetchCredits 的只读封装 + state/credits.json 缓存。
  // 节流：不用 manualOp 包裹（manualOp 的 409 口径太粗）——
  //   · 缓存新鲜且未强制 refresh → 直接回缓存，一次上游都不发；
  //   · 要拉取时 job 在跑（或已在拉取中）→ 409 busy，避免跟 job 抢节流窗口；
  //     但「有缓存且未 refresh」时仍直接回缓存（哪怕已过期）——展示优先；
  //   · 真拉取走 engineOpts()（唯一 spacer/fetch/gap），engine 内部每次调用前
  //     breathe + 经全局节流器排队，≥1s 的铁律 4 照常成立。
  let creditsBusy = false

  async function fetchCreditsForUid(uid, force = false) {
    // 可参与口径与 eligibleAccounts 一致：找不到 / API key / 企业号 / 已停用
    // 一律 404（intl 与企业版账号在 accountByUid 里就已经是「找不到」）。
    // 企业版给专属文案（issue #3）：账号在 magpie 里确实存在，只是企业版没有
    // 成长体系 —— 404 说清「为什么看不到」与「去哪里看」（ENTERPRISE_NO_GROWTH_MSG），
    // 绝不泄露昵称/域名/enterpriseId 等额外信息。
    const raw = loadAccountsAll().find((a) => a.uid === uid && isEnterpriseAcct(a))
    if (raw) {
      return { status: 404, body: { error: ENTERPRISE_NO_GROWTH_MSG } }
    }
    const acct = accountByUid(uid)
    if (!acct || acct.isApiKey || acct.tasksEnabled === false) {
      return { status: 404, body: { error: `找不到可参与任务的国内版账号：${uid}` } }
    }
    const nickname = acct.nickname || acct.accountId || uid
    const cached = cachedCreditsOf(uid)
    const fresh =
      !!cached && Number(cached.updatedAt) > 0 && now() - Number(cached.updatedAt) < CREDITS_TTL_MS
    if (cached && !force && fresh) {
      return { status: 200, body: { ok: true, uid, nickname, credits: cached } }
    }
    if (runner?.current() || creditsBusy) {
      if (cached && !force) return { status: 200, body: { ok: true, uid, nickname, credits: cached } }
      return { status: 409, body: { error: "busy" } }
    }
    const fn = engine?.credits?.fetchCredits
    if (typeof fn !== "function") {
      return { status: 503, body: { error: engineErrorsText() } }
    }
    creditsBusy = true
    try {
      const r = await fn(acct, engineOpts())
      if (r?.ok && r?.credits && typeof r.credits === "object") {
        creditsCache[uid] = r.credits
        saveCredits()
        // 可选实时事件（前端不依赖；SSE 订阅方可以借此刷新积分卡片）
        broadcast({ kind: "credits", uid })
        return { status: 200, body: { ok: true, uid, nickname, credits: r.credits } }
      }
      // 上游失败：200 + ok:false，错误文本过 scrub；旧缓存原样保留并一并带回。
      const body = { ok: false, uid, nickname, error: scrub(String(r?.error || r?.msg || "积分拉取失败")) }
      if (r?.needRelogin) body.needRelogin = true
      if (cached) body.credits = cached
      return { status: 200, body }
    } catch (e) {
      const body = { ok: false, uid, nickname, error: shortErr(e) }
      if (cached) body.credits = cached
      return { status: 200, body }
    } finally {
      creditsBusy = false
    }
  }

  // ---- 连登管家（CONTRACT §10.2）-----------------------------------------------------------
  // GET /api/streak：engine/streak.fetchStreakState 的只读封装 + state/streak.json
  // 缓存（uid -> streak state），新鲜期 10 分钟（CREDITS_TTL_MS，与 /api/credits
  // 同口径）。节流口径与 credits 相同：
  //   · 缓存新鲜且未强制 refresh → 直接回缓存，一次上游都不发；
  //   · 要拉取时 job 在跑（或已在拉取中）→ 409 busy；但「有缓存且未 refresh」
  //     时仍直接回缓存（哪怕已过期）—— 展示优先，绝不硬闯；
  //   · refresh=1 → 无视 TTL 强制拉取（busy 时仍 409）。
  // /api/state 的 accounts[].streak 只读投影缓存（cachedStreakOf），绝不为它打上游。
  let streakBusy = false

  // 连登缓存的单条读取：形状不对（手改坏文件）视作没有，绝不下发垃圾。
  function cachedStreakOf(uid) {
    const c = streakCache[uid]
    return c && typeof c === "object" && !Array.isArray(c) ? c : null
  }

  async function fetchStreakForUid(uid, force = false) {
    // 可参与口径与 eligibleAccounts 一致：找不到 / API key / 企业号 / 已停用
    // 一律 404（intl 与企业版账号在 accountByUid 里就已经是「找不到」）；
    // 企业版专属文案与 /api/credits 同一段（§10.8 镜像口径）。
    const raw = loadAccountsAll().find((a) => a.uid === uid && isEnterpriseAcct(a))
    if (raw) {
      return { status: 404, body: { error: ENTERPRISE_NO_GROWTH_MSG } }
    }
    const acct = accountByUid(uid)
    if (!acct || acct.isApiKey || acct.tasksEnabled === false) {
      return { status: 404, body: { error: `找不到可参与任务的国内版账号：${uid}` } }
    }
    const cached = cachedStreakOf(uid)
    // 新鲜期依据 state.updatedISO（ISO 8601，fetchStreakState 落的查询时刻）
    const atMs = Date.parse(String(cached?.updatedISO ?? ""))
    const fresh = !!cached && Number.isFinite(atMs) && now() - atMs < CREDITS_TTL_MS
    if (cached && !force && fresh) {
      return { status: 200, body: { uid, cached: true, streak: cached } }
    }
    if (runner?.current() || streakBusy) {
      if (cached && !force) return { status: 200, body: { uid, cached: true, streak: cached } }
      return { status: 409, body: { error: "busy" } }
    }
    const fn = engine?.streak?.fetchStreakState
    if (typeof fn !== "function") {
      return { status: 503, body: { error: engineErrorsText() } }
    }
    streakBusy = true
    try {
      const state = await fn(acct, engineOpts(acct))
      if (state?.ok) {
        streakCache[uid] = state
        saveStreak()
        return { status: 200, body: { uid, cached: false, streak: state } }
      }
      // 上游失败：200 + error，旧缓存原样保留并一并带回（streak 字段，若有）
      const body = { uid, cached: false, error: scrub(String(state?.error || state?.msg || "连登状态查询失败")) }
      if (cached) body.streak = cached
      return { status: 200, body }
    } catch (e) {
      const body = { uid, cached: false, error: shortErr(e) }
      if (cached) body.streak = cached
      return { status: 200, body }
    } finally {
      streakBusy = false
    }
  }

  // POST /api/streak/run：手动跑一轮连登管家（补签 → 礼包/补偿 → 兑换 → 抽奖）。
  // 缺省/空 uids = 全部「未冻结 + tasksEnabled」账号（eligibleNow 已排除冻结）；
  // 账号之间 1500 ms（手动手感，同 /api/checkin）；restricted 当场冻结该账号。
  async function doStreakRun(uids) {
    const fn = engine?.streak?.runStreakSteward
    if (typeof fn !== "function") throw new Error(engineErrorsText())
    const explicit = Array.isArray(uids) && uids.length
    const targets = (explicit ? uids.map(String) : eligibleNow().map((a) => a.uid)).slice(0, 20)
    const out = []
    for (const uid of targets) {
      const acct = accountByUid(uid)
      if (!acct) {
        out.push({ uid, outcome: "failed", earned: 0, message: "找不到账号" })
        continue
      }
      // 显式指定的冻结账号如实失败（CONTRACT §10.5），不静默跳过
      if (isFrozenUid(uid)) {
        out.push({
          uid,
          outcome: "failed",
          earned: 0,
          message: `账号已冻结（11140）：${frozenMessageOf(uid)}；确认无风险后在账号行点「恢复」`,
        })
        continue
      }
      try {
        const r = await fn(acct, engineOpts(acct))
        if (r?.restricted) {
          freezeAccount(uid, { code: 11140, message: "连登管家触发风控限制 (403/11140)" })
          out.push({
            uid,
            outcome: "failed",
            earned: Number(r.earned) || 0,
            message: "触发风控限制（403/11140），账号已冻结；确认无风险后在账号行点「恢复」",
          })
          continue
        }
        const d = r?.actions ?? {}
        const detail = {
          days: Number(r?.streak?.days ?? 0) || 0,
          makeupCards: Number(r?.streak?.makeupCards ?? 0) || 0,
          lotteryChances: Number(r?.streak?.lotteryChances ?? 0) || 0,
          makeupUsed: d.makeup?.used === true,
          makeupDate: d.makeup?.date ?? "",
          gifts: (Array.isArray(d.gifts) ? d.gifts : []).map((g) => ({ name: g?.name ?? "", credit: Number(g?.credit) || 0 })),
          redeemed: Array.isArray(d.redeemed) ? d.redeemed : [],
          drawn: Number(d.drawn) || 0,
        }
        if (r?.ok !== true) {
          const why = scrub(String(r?.logs?.slice(-1)[0] ?? "连登管家执行失败"))
          out.push({ uid, outcome: "failed", earned: Number(r?.earned) || 0, message: why, detail })
          continue
        }
        const parts = [`连登 ${detail.days} 天`]
        if (detail.makeupUsed) parts.push(`已补签 ${detail.makeupDate}`)
        if (detail.gifts.length) parts.push(`礼包 ×${detail.gifts.length}`)
        if (detail.redeemed.length) parts.push(`兑换 ${detail.redeemed.join("/")}`)
        if (detail.drawn) parts.push(`抽奖 ${detail.drawn} 次`)
        out.push({
          uid,
          outcome: r?.logs?.some((l) => l.includes("跳过")) && !detail.makeupUsed && !detail.gifts.length && !detail.redeemed.length && !detail.drawn
            ? "skipped"
            : "ok",
          earned: Number(r.earned) || 0,
          message: parts.join(" / ") + `，+${Number(r.earned) || 0} 积分`,
          detail,
        })
      } catch (e) {
        out.push({ uid, outcome: "failed", earned: 0, message: shortErr(e) })
      }
      await sleepFn(1500) // 账号间隔（手动节奏，同 /api/checkin）
    }
    return out
  }

  // ---- 运营活动任务（CONTRACT §11.1）---------------------------------------
  // GET /api/campaign：engine/campaign.fetchCampaignState 的只读封装 +
  // state/campaign.json 缓存（uid -> campaign state），新鲜期 10 分钟
  //（CREDITS_TTL_MS）。节流口径与 GET /api/streak **完全一致**（镜像，§11.1）：
  //   · 缓存新鲜且未强制 refresh → 直接回缓存，一次上游都不发；
  //   · 要拉取时 job 在跑（或已在拉取中）→ 409 busy；但「有缓存且未 refresh」
  //     时仍直接回缓存（哪怕已过期）—— 展示优先，绝不硬闯；
  //   · refresh=1 → 无视 TTL 强制拉取（busy 时仍 409）。
  // /api/state 的 accounts[].campaign 只读投影缓存（cachedCampaignOf），
  // 绝不为它打上游。
  let campaignBusy = false

  // 活动缓存的单条读取：形状不对（手改坏文件）视作没有，绝不下发垃圾。
  function cachedCampaignOf(uid) {
    const c = campaignCache[uid]
    return c && typeof c === "object" && !Array.isArray(c) ? c : null
  }

  async function fetchCampaignForUid(uid, force = false) {
    // 可参与口径与 /api/streak 一致：找不到 / API key / 企业号 / 已停用一律 404，
    // 企业版专属文案同段镜像（§10.8 口径）。
    const raw = loadAccountsAll().find((a) => a.uid === uid && isEnterpriseAcct(a))
    if (raw) {
      return { status: 404, body: { error: ENTERPRISE_NO_GROWTH_MSG } }
    }
    const acct = accountByUid(uid)
    if (!acct || acct.isApiKey || acct.tasksEnabled === false) {
      return { status: 404, body: { error: `找不到可参与任务的国内版账号：${uid}` } }
    }
    const cached = cachedCampaignOf(uid)
    // 新鲜期依据 state.updatedISO（ISO 8601，fetchCampaignState 落的查询时刻）
    const atMs = Date.parse(String(cached?.updatedISO ?? ""))
    const fresh = !!cached && Number.isFinite(atMs) && now() - atMs < CREDITS_TTL_MS
    if (cached && !force && fresh) {
      return { status: 200, body: { uid, cached: true, campaign: cached } }
    }
    if (runner?.current() || campaignBusy) {
      if (cached && !force) return { status: 200, body: { uid, cached: true, campaign: cached } }
      return { status: 409, body: { error: "busy" } }
    }
    const fn = engine?.campaign?.fetchCampaignState
    if (typeof fn !== "function") {
      return { status: 503, body: { error: engineErrorsText() } }
    }
    campaignBusy = true
    try {
      const state = await fn(acct, engineOpts(acct))
      if (state?.ok) {
        campaignCache[uid] = state
        saveCampaign()
        return { status: 200, body: { uid, cached: false, campaign: state } }
      }
      // 上游失败：200 + error，旧缓存原样保留并一并带回（campaign 字段，若有）
      const body = { uid, cached: false, error: scrub(String(state?.error || state?.msg || "活动任务读取失败")) }
      if (state?.restricted) body.restricted = true
      if (cached) body.campaign = cached
      return { status: 200, body }
    } catch (e) {
      const body = { uid, cached: false, error: shortErr(e) }
      if (cached) body.campaign = cached
      return { status: 200, body }
    } finally {
      campaignBusy = false
    }
  }

  // POST /api/campaign/run：手动跑一轮运营活动任务（viewed → 判据发射 → 领奖，
  // 全部由 engine/campaign.runCampaignTasks 按 §11.1 口径执行）。
  // 缺省/空 uids = 全部「未冻结 + tasksEnabled」账号（eligibleNow 已排除冻结）；
  // 账号之间 1500 ms（手动手感，同 /api/streak/run）；restricted 当场冻结该账号。
  async function doCampaignRun(uids) {
    const fn = engine?.campaign?.runCampaignTasks
    if (typeof fn !== "function") throw new Error(engineErrorsText())
    const explicit = Array.isArray(uids) && uids.length
    const targets = (explicit ? uids.map(String) : eligibleNow().map((a) => a.uid)).slice(0, 20)
    const out = []
    for (const uid of targets) {
      const acct = accountByUid(uid)
      if (!acct) {
        out.push({ uid, outcome: "failed", earned: 0, message: "找不到账号" })
        continue
      }
      // 显式指定的冻结账号如实失败（CONTRACT §10.5），不静默跳过
      if (isFrozenUid(uid)) {
        out.push({
          uid,
          outcome: "failed",
          earned: 0,
          message: `账号已冻结（11140）：${frozenMessageOf(uid)}；确认无风险后在账号行点「恢复」`,
        })
        continue
      }
      try {
        const r = await fn(acct, engineOpts(acct))
        if (r?.restricted) {
          freezeAccount(uid, { code: 11140, message: "活动任务触发风控限制 (403/11140)" })
          out.push({
            uid,
            outcome: "failed",
            earned: Number(r.earned) || 0,
            message: "触发风控限制（403/11140），账号已冻结；确认无风险后在账号行点「恢复」",
            detail: campaignRunDetail(r),
          })
          continue
        }
        const detail = campaignRunDetail(r)
        const acted = Number(r?.claimed?.length ?? detail.claimed.length)
        const touched =
          detail.claimed.length + detail.unavailable.length ||
          (detail.activities ?? []).reduce((s, a) => s + (a.viewed || 0) + (a.fired || 0), 0)
        if (r?.ok !== true) {
          const why = scrub(String(r?.logs?.slice(-1)[0] ?? "活动任务执行失败"))
          out.push({ uid, outcome: "failed", earned: Number(r?.earned) || 0, message: why, detail })
          continue
        }
        const nActivities = (detail.activities ?? []).filter((a) => !a.error).length
        const parts = [`活动 ${nActivities} 项`, `已领 ${detail.claimed.length}`]
        out.push({
          uid,
          outcome: acted > 0 || touched > 0 || (Number(r?.earned) || 0) > 0 ? "ok" : "skipped",
          earned: Number(r.earned) || 0,
          message: parts.join(" · ") + `，+${Number(r.earned) || 0} 积分`,
          detail,
        })
      } catch (e) {
        out.push({ uid, outcome: "failed", earned: 0, message: shortErr(e) })
      }
      await sleepFn(1500) // 账号间隔（手动节奏，同 /api/streak/run）
    }
    return out
  }

  // campaignRunDetail(r)：把引擎 runCampaignTasks 的结果收敛成 §11.1 的 detail
  // 形状 {activities:[{code,label,viewed,fired,claimed}], claimed:[taskCode…],
  // unavailable:[…]}。viewed/fired/claimed 按活动统计次数；claimed/unavailable
  // 是任务 code 清单（unavailable = 活动未下发/已下线的判据）。
  function campaignRunDetail(r) {
    const viewed = Array.isArray(r?.actions?.viewed) ? r.actions.viewed : []
    const fired = Array.isArray(r?.actions?.fired) ? r.actions.fired : []
    const claimed = Array.isArray(r?.actions?.claimed) ? r.actions.claimed : []
    const activities = (Array.isArray(r?.state?.activities) ? r.state.activities : []).map((a) => ({
      code: String(a?.code ?? ""),
      label: String(a?.label ?? ""),
      error: String(a?.error ?? ""),
      viewed: viewed.filter((c) => (a?.tasks ?? []).some((t) => t?.taskCode === c)).length,
      fired: fired.filter((c) => (a?.tasks ?? []).some((t) => t?.taskCode === c)).length,
      claimed: claimed.filter((c) => (a?.tasks ?? []).some((t) => t?.taskCode === c)).length,
    }))
    return {
      activities,
      claimed: claimed.map(String),
      unavailable: (Array.isArray(r?.unavailable) ? r.unavailable : []).map(String),
    }
  }

  // POST /api/campaign/claim：单条活动任务领奖（CONTRACT §11.6 第 3 条，看板
  // 任务明细的「领取」按钮数据源）。body {uid, activityCode, taskCode}。
  // 口径与 /api/task/claim（doClaim）逐字同款：引擎能力检查在最前；账号找不到
  // 抛「找不到账号 …」（manualOp 转 500，与 /api/task/claim 同口径）；显式指定
  // 的冻结账号如实失败（§10.5 冻结文案，零上游）。成功/失败形状与
  // /api/task/claim 对齐：{ok, credit, energy, via, reason}（活动领奖没有
  // chat/web 双路，via 恒空串）。引擎必须回读 claimed_at 才算成功（§11.1），
  // credit 用活动清单的 reward_credit 记账。撞 restricted（403/11140）当场
  // 冻结账号（同 doCampaignRun / doStreakRun 的 §10.5 口径）并回冻结提示。
  async function doCampaignClaim(uid, activityCode, taskCode) {
    const fn = engine?.campaign?.claimCampaignTask
    if (typeof fn !== "function") throw new Error(engineErrorsText())
    const acct = accountByUid(uid)
    if (!acct) throw new Error(`找不到账号 ${uid}（重新扫描账号或检查 plugin-auth.json）`)
    // 显式指定的冻结账号如实失败（CONTRACT §10.5）：不静默跳过、不碰上游
    if (isFrozenUid(uid)) {
      return {
        ok: false,
        credit: 0,
        energy: 0,
        via: "",
        reason: `账号已冻结（11140）：${frozenMessageOf(uid)}；确认无风险后在账号行点「恢复」`,
      }
    }
    const r = await fn(acct, { activity: activityCode, task: taskCode }, engineOpts(acct))
    if (r?.restricted) {
      freezeAccount(uid, { code: 11140, message: "活动任务领奖触发风控限制 (403/11140)" })
      return {
        ok: false,
        credit: 0,
        energy: 0,
        via: "",
        reason: "触发风控限制（403/11140），账号已冻结；确认无风险后在账号行点「恢复」",
      }
    }
    return {
      ok: !!r?.ok,
      credit: r?.credit ?? 0,
      energy: r?.energy ?? 0,
      via: "",
      reason: scrub(r?.reason ?? ""),
    }
  }

  // POST /api/account/unfreeze：解冻（CONTRACT §10.2/§10.5）。{uid} 或 {uids}；
  // missing = 本来就没冻结的 uid。
  function doUnfreeze(body) {
    const wanted = Array.isArray(body?.uids)
      ? body.uids.map(String).filter(Boolean)
      : body?.uid
        ? [String(body.uid)]
        : []
    if (!wanted.length) return { status: 400, body: { error: "需要 uid 或 uids" } }
    const unfrozen = []
    const missing = []
    for (const uid of wanted) {
      // runner 的内存冻结表与台账双向同步（frozenMap/onFrozen），台账判缺失即缺；
      // runner.unfreeze 仍要调（老 runner 没有该方法时静默略过）。
      const inRunner =
        typeof runner?.isFrozen === "function"
          ? !!runner.isFrozen(uid)
          : typeof runner?.frozen === "function"
            ? (() => {
                try {
                  return runner.frozen().some((f) => String(f?.uid ?? "") === uid)
                } catch {
                  return false
                }
              })()
            : false
      if (frozenState[uid] || inRunner) {
        delete frozenState[uid]
        try {
          runner?.unfreeze?.(uid)
        } catch {}
        unfrozen.push(uid)
        log(`[frozen] ${uid} 已解冻`)
      } else {
        missing.push(uid)
      }
    }
    if (unfrozen.length) saveFrozen()
    return { status: 200, body: { ok: true, unfrozen, missing } }
  }

  // ---- /api/state ----------------------------------------------------------

  // 积分缓存的单条读取：形状不对（手改坏文件）视作没有，绝不下发垃圾。
  function cachedCreditsOf(uid) {
    const c = creditsCache[uid]
    return c && typeof c === "object" && !Array.isArray(c) ? c : null
  }

  function accountRow(a) {
    const exp = Number(a.expires) || 0
    // 读取路径 = 投影的唯一出口：缓存（无论 v2 规范还是旧版投影形态）出门前
    // 一律 projectSnapshot 现场重投影；无法无损重建 → null（快照已过期）。
    // 锁表（mp-locks，需求 2）按 uid 现取：锁定任务的行立刻带 locked/lockHint。
    const snap = projectSnapshot(snapshots[a.uid] ?? null, lockedMapFor(a.uid))
    return {
      uid: a.uid ?? "",
      nickname: a.nickname ?? a.accountId ?? a.uid ?? "",
      masked: a.isApiKey ? "API key（不参与任务）" : "已登录",
      domain: a.domain ?? "",
      // expiresInMs 是原始剩余毫秒（可为负 = 已过期），expiresInDays 是天花板
      // 取整（ceil，最小 0）——「还剩 2 小时」在 days 里显示 1 天，用 ms 才能区分。
      expiresInMs: exp ? exp - now() : null,
      expiresInDays: exp ? Math.max(0, Math.ceil((exp - now()) / 86400000)) : null,
      tasksEnabled: a.tasksEnabled !== false,
      // 该账号行来自 JSON 导入（契约 §9）：importedFrom 标记 || 本插件导入台账。
      // 两者都是尽力而为（magpie 覆写会抹标记、删 state 会丢台账），只作展示，
      // 绝不作为任何逻辑判断依据。
      imported: a.importedFrom === "hub-json" || !!hubImports[a.key],
      eligible:
        a.provider === "workbuddy" && !a.isApiKey && !a.enterpriseId && a.tasksEnabled !== false,
      snapshot: snap,
      // 积分缓存只读投影（CONTRACT §3）：绝不在这里打上游 —— 看板渲染 剩余/总额
      // 与明细弹窗的数据源；没拉过就是 null。
      credits: cachedCreditsOf(a.uid),
      // 连登状态只读投影（CONTRACT §10.3）：state/streak.json 的缓存原样透出，
      // 绝不为它打上游；没拉过/缓存损坏 → null。
      streak: cachedStreakOf(a.uid),
      // 运营活动任务只读投影（CONTRACT §11.1）：state/campaign.json 的缓存原样
      // 透出，绝不为它打上游；没拉过/缓存损坏 → null。
      campaign: cachedCampaignOf(a.uid),
      // 冻结记录（CONTRACT §10.5）：{at:ISO, code, message} | null。冻结账号由
      // eligibleNow() 排除出缺省目标；显式指定的操作如实失败并提示。
      frozen: frozenEntryOf(a.uid),
    }
  }

  function statePayload(hostHeader) {
    const all = loadAccountsAll()
    // accounts[] 过滤点（与国际版同一处）：loadAccountsCn 只留国内版，再追加
    // 企业版排除（issue #3）——企业版没有成长任务与签到，不进看板列表。
    const accts = loadAccountsCn(all).filter((a) => !isEnterpriseAcct(a))
    const entSkipped = enterpriseSkippedCountOf(all)
    const cur = runner?.current?.() ?? null
    const payload = {
      // 绑定信息（B）：bindHost 是真实监听 host，绑定 0.0.0.0/:: 时 reachableHint
      // 提示 SSH 隧道/局域网地址（否则空串）。口径与 lifecycle.bindHint 一致；
      // 两个字段原样保留（向后兼容），但不再是前端显示地址的来源。
      bindHost: host,
      port,
      reachableHint: bindHint(host),
      // 访问地址（前端顶栏显示/复制的唯一来源）：取值链 Host 头 →
      // MAGPIE_PUBLIC_URL hostname + 本端口 → bindHost → 127.0.0.1 兜底，
      // Host 头过白名单校验、绝不返回 0.0.0.0/::/*；只有 host[:port]，不拼
      // key 或任何查询串（详见 docs/CONTRACT.md §3）。
      serveUrl: computeServeUrl({
        hostHeader,
        publicUrl: process.env.MAGPIE_PUBLIC_URL,
        bindHost: host,
        port,
      }),
      accounts: accts.map(accountRow),
      // 纯国内版诊断计数（只读）：国际版账号的数量与去向说明。绝不列出 intl
      // 账号内容（uid/昵称都不给）—— 用户明确要求国际版账号「彻底不出现」。
      intlSkipped: { count: intlSkippedCountOf(all), note: INTL_SKIPPED_NOTE },
      // 企业版诊断计数（issue #3，与 intlSkipped 同口径同形状）：count=0 时字段
      // 保留（{count:0,note:…}）；note 只给数量与去向说明，绝不列出企业版账号
      // 内容（uid/昵称/域名/enterpriseId 都不给）。账号「不存在」（引擎未就绪/
      // 读取失败 → all 为空）时取值口径与 intlSkipped 相同 = {count:0,note}。
      enterpriseSkipped: { count: entSkipped, note: enterpriseSkippedNote(entSkipped) },
      // 冻结总览（CONTRACT §10.3，替代原 scheduler.holds）：403/11140 冻结名单，
      // 数据源 = runner.frozen()（初始数据来自 state/frozen.json，经 onFrozen/
      // onUnfrozen 双向同步）。冻结账号不进缺省目标、绝不自动恢复 —— 「恢复」
      // 按钮走 POST /api/account/unfreeze。
      frozen: frozenOverview(),
      scheduler: {
        enabled: !!settings.scheduler,
        nextRuns: schedulerNextRuns(),
        lastCycle,
      },
      job: safeJob(cur),
      stats: computeStats(),
      settings: {
        claim: settings.claim,
        legs: settings.legs,
        gapMs: settings.gapMs,
        hours: settings.hours,
        host: effectiveHosts(),
      },
    }
    if (accountsError) payload.notice = accountsError
    if (engine?.errors?.length) payload.engineErrors = engine.errors.map(scrub)
    return payload
  }

  function effectiveHosts() {
    const up = engine?.upstream
    const safe = (fn, fb) => {
      try {
        return (typeof fn === "function" && fn()) || fb
      } catch {
        return fb
      }
    }
    return {
      chat: settings.host.chat || safe(up?.growthBase, "https://copilot.tencent.com"),
      bill: settings.host.bill || safe(up?.billBase, "https://www.codebuddy.cn"),
      web: settings.host.web || safe(up?.webBase, "https://www.workbuddy.cn"),
    }
  }

  // ---- HTTP ---------------------------------------------------------------

  const serverOf = (handler) => http.createServer(handler)
  let server = null
  let port = 0
  let stopped = false
  let whenStoppedResolve = null
  const whenStopped = new Promise((r) => (whenStoppedResolve = r))

  // 统一 JSON 响应出口：全部 /api/* 路由（以及 serveStatic 里的 JSON 错误响应）都走这里。
  // 缓存口径（单一真相）：一律 Cache-Control: no-store —— 这是局域网自建看板，文件小、
  // 迭代频繁，最贵的错误是「浏览器拿着缓存里的旧 app.js，界面显示早已废弃的地址，
  // 用户以为改了没生效」；no-store（而非 no-cache）保证重载即最新版，连磁盘缓存都不留。
  // 刻意不加 ETag / Last-Modified / Expires：no-store 之下浏览器根本不存副本，
  // 再引入条件请求只会增加 304 协商、缓存再验证等新的失效模式，纯属复杂度而没有收益。
  // 唯一例外是 SSE（/api/events），它必须保持 no-cache 才能在各代理下不断流，见 handleApi。
  function json(res, status, body) {
    const text = JSON.stringify(body)
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(text),
      "Cache-Control": "no-store",
    })
    res.end(text)
  }

  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
  }

  function fallbackPage() {
    return `<!doctype html><html lang="zh"><meta charset="utf-8"><title>WorkBuddy 任务</title>
<body style="font-family:system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1rem;color:#333">
<h2>看板尚未构建</h2>
<p>本插件的 <code>dashboard/</code> 目录还没有前端文件。任务 API、排程与守护进程已在运行。</p>
<p>把看板文件放进 <code>dashboard/</code> 后刷新本页即可。<code>/api/hello</code> 可确认服务状态。</p>
<p>本看板与全部 API <strong>无需任何密钥</strong>（用户明确要求的免密钥口径）：鉴权由网络边界负责 ——
守护进程默认只绑定 <code>127.0.0.1</code>，只有本机能访问；若改绑 <code>0.0.0.0</code>/容器网桥，同一局域网内
任何主机都能用你的账号跑任务、写入凭据、导出 token 并关停本进程，请勿把端口发布到公网或开放局域网。</p>
</body></html>`
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      json(res, 405, { error: "只支持 GET" })
      return
    }
    const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "")
    const full = normalize(join(dashDir, decodeURIComponent(rel)))
    if (full !== dashDir && !full.startsWith(dashDir + sep)) {
      json(res, 403, { error: "路径不合法" })
      return
    }
    if (existsSync(full) && statSync(full).isFile()) {
      const body = readFileSync(full)
      // no-store 与 json() 同一口径：看板静态文件（app.js/style.css）改一版就要让
      // 「普通重载」拿到新版，绝不允许浏览器拿旧 JS 冒充新版（取舍见 json() 上方注释；
      // 同理刻意不发 ETag/Last-Modified，不与 no-store 混用条件请求）。
      res.writeHead(200, {
        "Content-Type": MIME[extname(full).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": body.length,
        "Cache-Control": "no-store",
      })
      res.end(req.method === "HEAD" ? undefined : body)
      return
    }
    if (pathname === "/" || pathname === "/index.html") {
      const body = Buffer.from(fallbackPage())
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" })
      res.end(body)
      return
    }
    json(res, 404, { error: "文件不存在" })
  }

  async function readBody(req, cap = 1024 * 1024) {
    const chunks = []
    let n = 0
    for await (const c of req) {
      n += c.length
      if (n > cap) throw new Error("请求体过大")
      chunks.push(c)
    }
    const text = Buffer.concat(chunks).toString("utf8").trim()
    if (!text) return {}
    return JSON.parse(text)
  }

  // ---- POST /api/accounts/import（契约 §9：两段式，预览默认不写盘）----------
  // body = 账号数据本体（信封/裸数组/单对象/桌面端凭据）或 {"blob":<同上>,"confirm":bool}
  // 预览: {wrote:false, note:"预览未写入任何文件", preview:{adds,updates,skips,rejects,totals}}
  // 确认: {wrote:true, added,updated,skipped,backedUpTo,needReload:true,reloadHint}
  // 错误: 无可导入账号→400；auth 解析失败→409 拒写；预览后文件已变→409 重新预览。
  // 零凭据外泄：响应与日志只有 uid/昵称/key 与计数，绝不出现 token。
  let lastImportPreview = null // {hash, at} —— 竞态守卫的依据（内存态，重启即失效）

  function sha256Hex(text) {
    return crypto.createHash("sha256").update(text).digest("hex")
  }

  async function handleAccountsImport(req, res, u) {
    let body
    try {
      body = await readBody(req)
    } catch (e) {
      json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
      return
    }
    const confirm =
      (body && typeof body === "object" && body.confirm === true) || isTruthyParam(u.searchParams.get("confirm"))
    // 免密钥口径：confirm=true（写盘）不再设密钥门禁，与所有路由同一政策
    //（routeNeedsKey 恒 false，见文件头「路由 → 是否需密钥」单一真相）。

    const blob =
      body && typeof body === "object" && !Array.isArray(body) && "blob" in body ? body.blob : body
    const coerced = coerceImportRows(blob)
    if (coerced.error) {
      json(res, 400, { error: `无法读取账号文档：${scrub(coerced.error)}` })
      return
    }

    const auth = readAuthDocument(cfgDir)
    if (!auth.ok && !auth.missing) {
      // 坏 JSON 拒写：连「读现有账号做智能合并」都做不到，更不能覆盖别人的凭据文件
      json(res, 409, {
        error: "plugin-auth.json 解析失败，拒绝写入以免丢数据；请先手工备份并修复该文件",
        detail: scrub(auth.error),
      })
      return
    }
    const existingData = auth.ok ? auth.data : {}
    const hash = sha256Hex(auth.ok ? auth.text : "")
    const plan = planImport(coerced.rows, existingData, { now })

    if (!confirm) {
      lastImportPreview = { hash, at: now() }
      json(res, 200, { wrote: false, note: "预览未写入任何文件", preview: planView(plan) })
      return
    }

    // ---- 确认分支（已过密钥门禁）----
    if (lastImportPreview && lastImportPreview.hash !== hash) {
      // 用户确认的是「预览时看到的那份文件」；文件已变（magpie 可能刚刷新过 token）
      // 就绝不能按旧印象写，要求重新预览
      json(res, 409, {
        error: "plugin-auth.json 在预览后发生了变化（magpie 可能刷新过 token），为防覆盖请重新预览后再确认",
        needRepreview: true,
      })
      return
    }
    if (!plan.totals.adds && !plan.totals.updates) {
      json(res, 200, {
        wrote: false,
        note: "没有需要写入的变更（新增/更新均为 0，全部跳过或拒绝）",
        added: [],
        updated: [],
        skipped: plan.skips,
        backedUpTo: null,
        needReload: false,
        preview: planView(plan),
      })
      return
    }
    // 写前竞态复查：文件必须仍是刚才计划所依据的那一份
    const re = readAuthDocument(cfgDir)
    if (!re.ok && !re.missing) {
      json(res, 409, { error: "plugin-auth.json 读取失败，拒绝写入以免丢数据", detail: scrub(re.error) })
      return
    }
    if (sha256Hex(re.ok ? re.text : "") !== hash) {
      json(res, 409, { error: "plugin-auth.json 在计划过程中发生了变化，请重新预览后再确认", needRepreview: true })
      return
    }
    let r
    try {
      r = applyImport(cfgDir, plan, { existingData: re.ok ? re.data : {}, now })
    } catch (e) {
      json(res, 500, { error: `写入 plugin-auth.json 失败：${shortErr(e)}` })
      return
    }
    // 导入台账：记录本插件经手的 acctKey（magpie 覆写会抹 importedFrom，这份
    // 记录让 /api/state 的 imported 仍可靠；尽力而为口径，只作展示）
    for (const op of plan.ops) {
      hubImports[op.key] = {
        uid: op.entry?.uid ?? "",
        importedAt: new Date(now()).toISOString(),
      }
    }
    saveHubImports()
    broadcast({ kind: "accounts", event: "import", added: plan.totals.adds, updated: plan.totals.updates })
    log(`[import] 确认写入：新增 ${plan.totals.adds}、更新 ${plan.totals.updates}、跳过 ${plan.totals.skips}、拒绝 ${plan.totals.rejects}（备份 ${r.backedUpTo ?? "无"}）`)
    json(res, 200, {
      wrote: true,
      added: plan.adds, // [{uid,nickname,key}]
      updated: plan.updates, // [{uid,nickname,key,fromExpires,toExpires,reason}]
      skipped: plan.skips,
      backedUpTo: r.backedUpTo,
      needReload: true,
      reloadHint: "在 magpie「插件管理」里把 WorkBuddy 关掉再打开，新账号才会被 magpie 认到",
    })
  }

  async function handleApi(req, res, u) {
    const p = u.pathname

    if (p === "/api/hello") {
      json(res, 200, { name: PLUGIN_NAME, version: VERSION, ready: !!engine?.ok })
      return
    }

    // 导入路由单独前置：confirm 可以在 body 里，必须先读完 body 才能定预览/确认
    //（读 body 本身无副作用）。其余路由按 API_ROUTE_AUTH 登记表口径（免密钥）。
    if (p === "/api/accounts/import" && req.method === "POST") {
      await handleAccountsImport(req, res, u)
      return
    }

    if (p === "/api/events") {
      // SSE 是全站 no-store 口径的唯一例外：流式响应必须用 no-cache（允许经手但不落副本），
      // 部分代理/中间层会把 no-store 的长连接直接断流；这里不走 json()，头自行写全。
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      })
      res.write("retry: 3000\n\n")
      sseClients.add(res)
      req.on("close", () => sseClients.delete(res))
      return
    }

    if (p === "/api/state" && req.method === "GET") {
      const refresh = u.searchParams.get("refresh")
      if (refresh && !runner?.current()) {
        const uids = refresh === "1" || refresh === "true" ? eligibleNow().map((a) => a.uid) : [refresh]
        await refreshSnapshots(uids, 12000)
      }
      json(res, 200, statePayload(req.headers?.host))
      return
    }

    if (p === "/api/credits" && req.method === "GET") {
      const uid = String(u.searchParams.get("uid") ?? "").trim()
      if (!uid) {
        json(res, 400, { error: "需要 uid" })
        return
      }
      // refresh=1/true/yes：无视 TTL 强制拉取（job 在跑时仍 409，见 fetchCreditsForUid）
      const r = await fetchCreditsForUid(uid, isTruthyParam(u.searchParams.get("refresh")))
      json(res, r.status, r.body)
      return
    }

    if (p === "/api/run" && req.method === "POST") {
      if (runner?.current()) {
        json(res, 409, { error: "busy" })
        return
      }
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
        return
      }
      try {
        const job = safeJob(startJob(body))
        json(res, 200, { job })
        broadcast({ kind: "job", job })
      } catch (e) {
        // runner 自身的并发闸门抛 {status:409}（检查与 start 之间的竞态），如实映射
        const code =
          e?.code === "WB_ENGINE_UNAVAILABLE"
            ? 503
            : e?.code === "WB_NO_ACCOUNTS"
              ? 400
              : e?.status === 409
                ? 409
                : 500
        json(res, code, { error: shortErr(e) })
      }
      return
    }

    if (p === "/api/stop" && req.method === "POST") {
      const job = await stopCurrentJob()
      if (!job) {
        json(res, 404, { error: "当前没有正在运行的任务" })
        return
      }
      json(res, 200, { job })
      broadcast({ kind: "job", job })
      return
    }

    if (p === "/api/task/claim" && req.method === "POST") {
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
        return
      }
      if (!body.uid || !body.code) {
        json(res, 400, { error: "需要 uid 与 code" })
        return
      }
      const r = await manualOp(() => doClaim(body.uid, body.code))
      json(res, r.status, r.body)
      return
    }

    if (p === "/api/task/accept" && req.method === "POST") {
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
        return
      }
      if (!body.uid) {
        json(res, 400, { error: "需要 uid" })
        return
      }
      const r = await manualOp(() => doAccept(body.uid, body.codes))
      json(res, r.status, r.body)
      return
    }

    if (p === "/api/checkin" && req.method === "POST") {
      let body = {}
      try {
        body = await readBody(req)
      } catch (e) {
        json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
        return
      }
      const r = await manualOp(() => doCheckin(body.uids))
      json(res, r.status, r.body)
      return
    }

    // 连登管家（CONTRACT §10.2）：GET 状态（缓存/refresh/409 同 /api/credits）、
    // POST 手动跑一轮、POST 解冻。三条路由都在 API_ROUTE_AUTH 登记表里。
    if (p === "/api/streak" && req.method === "GET") {
      const uid = String(u.searchParams.get("uid") ?? "").trim()
      if (!uid) {
        json(res, 400, { error: "需要 uid" })
        return
      }
      // refresh=1/true/yes：无视 TTL 强制拉取（job 在跑时仍 409，见 fetchStreakForUid）
      const r = await fetchStreakForUid(uid, isTruthyParam(u.searchParams.get("refresh")))
      json(res, r.status, r.body)
      return
    }

    if (p === "/api/streak/run" && req.method === "POST") {
      let body = {}
      try {
        body = await readBody(req)
      } catch (e) {
        json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
        return
      }
      const r = await manualOp(() => doStreakRun(body.uids))
      json(res, r.status, r.body)
      return
    }

    // 运营活动任务（CONTRACT §11.1）：GET 状态（缓存/refresh/409 与 /api/streak
    // 完全同口径）、POST 手动跑一轮；§11.6 另加 POST /api/campaign/claim（单条
    // 活动任务领奖）。三条路由都在 API_ROUTE_AUTH 登记表里。
    if (p === "/api/campaign" && req.method === "GET") {
      const uid = String(u.searchParams.get("uid") ?? "").trim()
      if (!uid) {
        json(res, 400, { error: "需要 uid" })
        return
      }
      // refresh=1/true/yes：无视 TTL 强制拉取（job 在跑时仍 409，见 fetchCampaignForUid）
      const r = await fetchCampaignForUid(uid, isTruthyParam(u.searchParams.get("refresh")))
      json(res, r.status, r.body)
      return
    }

    if (p === "/api/campaign/run" && req.method === "POST") {
      let body = {}
      try {
        body = await readBody(req)
      } catch (e) {
        json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
        return
      }
      const r = await manualOp(() => doCampaignRun(body.uids))
      json(res, r.status, r.body)
      return
    }

    // 单条活动任务领奖（CONTRACT §11.6 第 3 条）：{uid, activityCode, taskCode}
    // 三条缺一 → 400；形状与 /api/task/claim 对齐（{ok, credit, energy, via, reason}）。
    if (p === "/api/campaign/claim" && req.method === "POST") {
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
        return
      }
      if (!body.uid || !body.activityCode || !body.taskCode) {
        json(res, 400, { error: "需要 uid、activityCode 与 taskCode" })
        return
      }
      const r = await manualOp(() => doCampaignClaim(body.uid, body.activityCode, body.taskCode))
      json(res, r.status, r.body)
      return
    }

    if (p === "/api/account/unfreeze" && req.method === "POST") {
      let body = {}
      try {
        body = await readBody(req)
      } catch (e) {
        json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
        return
      }
      const r = doUnfreeze(body)
      json(res, r.status, r.body)
      return
    }

    if (p === "/api/settings" && req.method === "POST") {
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
        return
      }
      if (typeof body.scheduler === "boolean") settings.scheduler = body.scheduler
      if (typeof body.claim === "boolean") settings.claim = body.claim
      if (Array.isArray(body.legs)) settings.legs = body.legs.filter((l) => LEGS.includes(l))
      if (Number.isFinite(Number(body.gapMs))) settings.gapMs = Math.min(10000, Math.max(500, Number(body.gapMs)))
      if (Array.isArray(body.jitterMs)) {
        const [a, b] = body.jitterMs.map(Number)
        if (Number.isFinite(a) && Number.isFinite(b)) settings.jitterMs = [Math.max(0, a), Math.max(a, b)]
      }
      // 排程小时窗口只收 SCHEDULE_HOURS_LEGS（mp|campaign|buddy|streak|travel|
      // night；growth 不再由排程触发，写进来也丢弃）。非数组值沿用旧行为「忽略
      // 该键」；数组值统一走 normalizeScheduleHours 的同款校验：0–23 整数、去重
      // 升序；显式写空的腿保持空（默认值也全空，留空即不排）。
      if (body.hours && typeof body.hours === "object" && !Array.isArray(body.hours)) {
        const merged = { ...settings.hours }
        for (const leg of SCHEDULE_HOURS_LEGS) {
          if (Array.isArray(body.hours[leg])) merged[leg] = body.hours[leg]
        }
        settings.hours = normalizeScheduleHours(merged)
      }
      if (body.host && typeof body.host === "object") {
        for (const k of ["chat", "bill", "web"]) {
          if (typeof body.host[k] === "string") settings.host[k] = body.host[k].trim()
        }
      }
      saveSettings()
      json(res, 200, {
        scheduler: settings.scheduler,
        claim: settings.claim,
        legs: settings.legs,
        gapMs: settings.gapMs,
        hours: settings.hours,
        host: effectiveHosts(),
      })
      return
    }

    if (p === "/api/accounts" && req.method === "POST") {
      // 重新读 plugin-auth.json，按 uid 报告增删（纯国内版口径：count/eligible/
      // added/removed 全部只算 provider==="workbuddy" 的国内版条目，国际版不出现）
      const before = new Set(loadAccountsCn().map((a) => a.uid))
      const after = loadAccountsCn()
      const afterIds = new Set(after.map((a) => a.uid))
      let eligible = 0
      try {
        const filter = engine?.store?.eligibleAccounts
        if (typeof filter === "function") eligible = (filter(after) ?? []).length
      } catch {}
      json(res, 200, {
        count: after.length,
        eligible,
        added: [...afterIds].filter((x) => !before.has(x)),
        removed: [...before].filter((x) => !afterIds.has(x)),
      })
      return
    }

    if (p === "/api/accounts/export" && req.method === "GET") {
      // hub /accounts/export（wb_proxy.py:19314）的移植：realm/secrets/uid/download。
      // 纯国内版口径：不带 realm（或任何非 intl 值）只导出国内版；显式 realm=intl
      // 才导出国际版 —— 这是给 hub 备份场景留的逃生口（UI 不提供，契约 §9）。
      // secrets=0/false/no = 脱敏（删 token 两键）；缺省/secrets=1 = 含 access/refresh
      // 的真值导出。导出文件本身必须真值，否则回灌无效；打码只属于界面展示层。
      const realmParam = u.searchParams.get("realm")
      const realm = realmParam === "intl" ? "intl" : "cn"
      const includeSecrets = !isSecretsFree(u.searchParams.get("secrets"))
      const uids = u.searchParams
        .getAll("uid")
        .flatMap((s) => String(s).split(","))
        .map((s) => s.trim())
        .filter(Boolean)
      const accts = realm === "intl" ? loadAccountsAll() : loadAccountsCn()
      if (uids.length) {
        const known = new Set(accts.map((a) => a.uid))
        const missing = uids.filter((x) => !known.has(x))
        if (missing.length) {
          json(res, 404, { error: `no such account: ${missing.slice(0, 5).join(", ")}` })
          return
        }
      }
      const doc = buildExportDocument(accts, { realm, includeSecrets, uids: uids.length ? uids : null, now: now() })
      log(`[export] realm=${realm} secrets=${includeSecrets ? 1 : 0} uids=${uids.length} count=${doc.count}`)
      if (isTruthyParam(u.searchParams.get("download"))) {
        // hub _download()：attachment + 净化文件名 + no-store
        const name = exportFileName({ uids, realm, now: now() })
        const text = JSON.stringify(doc, null, 2)
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(text),
          "Content-Disposition": `attachment; filename="${name}"`,
          "Cache-Control": "no-store",
        })
        res.end(text)
        return
      }
      json(res, 200, doc)
      return
    }

    if (p === "/api/account/toggle" && req.method === "POST") {
      // 参与任务开关（hub 的 task_active）：写 state/accounts.json 并回读生效行。
      // 不挡运行中的 job——runner 在 job 启动时就定好了账号名单，开关只影响
      // 下一轮 startJob/eligibleAccounts 的筛选，绝不会动正在跑的 job。
      let body
      try {
        body = await readBody(req)
      } catch (e) {
        json(res, 400, { error: `请求体不是合法 JSON：${shortErr(e)}` })
        return
      }
      const uid = String(body?.uid ?? "").trim()
      if (!uid) {
        json(res, 400, { error: "需要 uid" })
        return
      }
      if (typeof body?.tasksEnabled !== "boolean") {
        json(res, 400, { error: "需要布尔型 tasksEnabled（true=参与任务，false=停用）" })
        return
      }
      const acct = accountByUid(uid)
      if (!acct) {
        json(res, 404, { error: `找不到账号 ${uid}（重新扫描账号或检查 plugin-auth.json）` })
        return
      }
      tasksEnabledMap[uid] = body.tasksEnabled
      if (!saveAccountsState()) {
        json(res, 500, { error: "写入账号状态文件失败（state/accounts.json）" })
        return
      }
      log(`[account] ${uid} 参与任务开关 → ${body.tasksEnabled ? "参与" : "停用"}`)
      json(res, 200, accountRow(accountByUid(uid) ?? acct))
      return
    }

    const m = p.match(/^\/api\/jobs\/([A-Za-z0-9_-]+)$/)
    if (m && req.method === "GET") {
      const get = runner?.get?.bind(runner)
      const job = typeof get === "function" ? get(m[1]) : null
      if (!job) {
        json(res, 404, { error: `找不到 job ${m[1]}` })
        return
      }
      json(res, 200, safeJob(job))
      return
    }

    if (p === "/api/history" && req.method === "GET") {
      const limit = Math.min(2000, Math.max(1, Number(u.searchParams.get("limit")) || 200))
      json(res, 200, { rows: history.slice(-limit).reverse() })
      return
    }

    if (p === "/api/shutdown" && req.method === "POST") {
      json(res, 200, { ok: true })
      shutdown("收到 /api/shutdown")
      return
    }

    // 未知路由（issue #3）：error 原文保持逐字不变（既有测试与前端按原文断言/
    // 匹配），只追加 hint 指路重启 —— 看板比守护进程新时的真实症状见
    // UNKNOWN_API_HINT 注释。
    json(res, 404, { error: `未知 API：${req.method} ${p}`, hint: UNKNOWN_API_HINT })
  }

  const handler = async (req, res) => {
    let u
    try {
      u = new URL(req.url ?? "/", "http://localhost")
    } catch {
      json(res, 400, { error: "URL 不合法" })
      return
    }
    try {
      if (u.pathname.startsWith("/api/")) await handleApi(req, res, u)
      else serveStatic(req, res, u.pathname)
    } catch (e) {
      // 永不给浏览器看堆栈；详情只进本地日志
      log("[http] " + shortErr(e))
      try {
        json(res, 500, { error: "守护进程内部错误：" + shortErr(e) })
      } catch {}
    }
  }

  // ---- 绑定端口（被占用则向后找，最后随机） --------------------------------

  async function bind(hostName, startPort) {
    const candidates = startPort > 0 ? [startPort, ...Array.from({ length: 9 }, (_, i) => startPort + 1 + i), 0] : [0]
    for (const p of candidates) {
      const s = serverOf(handler)
      try {
        await new Promise((ok, bad) => {
          s.once("error", bad)
          s.listen(p, hostName, () => ok())
        })
        return { server: s, port: s.address().port }
      } catch (e) {
        try {
          s.close()
        } catch {}
        if (p === 0) throw e
        log(`端口 ${p} 被占用，换下一个…`)
      }
    }
    throw new Error("找不到可用端口")
  }
  ;({ server, port } = await bind(host, addr.port))

  // ---- 生命周期杂务 ---------------------------------------------------------

  const timers = []
  function every(ms, fn) {
    const t = setInterval(() => {
      try {
        fn()
      } catch (e) {
        log("[tick] " + shortErr(e))
      }
    }, ms)
    t.unref?.()
    timers.push(t)
  }

  function heartbeat() {
    // host 一并落盘：index.mjs 的宿主日志与 /api/state 由此读出真实绑定地址（A）
    writeDaemonInfo(stateDir, { pid: process.pid, port, key, version: VERSION, startedAt, host })
    try {
      writeFileSync(join(stateDir, "daemon.heartbeat"), String(now()), "utf8")
    } catch {}
  }

  // plugins.json：条目 off:true → 优雅退出；托管模式下条目消失（插件被移除）也退
  function checkPluginsFile() {
    try {
      const file = join(cfgDir, "plugins.json")
      if (!existsSync(file)) return
      const raw = readJson(file, null)
      if (!raw || !Array.isArray(raw.plugins)) return
      const mine = raw.plugins.filter((x) => String(x?.spec ?? "").includes(PLUGIN_NAME))
      if (mine.some((x) => x.off === true)) {
        shutdown("插件在 magpie 里已关闭（plugins.json off:true）")
        return
      }
      if (managed && !mine.length) shutdown("插件已从 magpie 移除（plugins.json 无本插件条目）")
    } catch (e) {
      log("[plugins.json] " + shortErr(e))
    }
  }

  // magpie TCP 探测：MAGPIE_ADDR（host:port），否则 127.0.0.1:3425 再试 :3430；
  // 连续 4 次失败 → magpie 停了 → 退出
  let magpieFails = 0
  function magpieCandidates() {
    const addrEnv = String(process.env.MAGPIE_ADDR ?? "").trim()
    if (addrEnv) {
      const i = addrEnv.lastIndexOf(":")
      if (i > 0) return [{ host: addrEnv.slice(0, i), port: Number(addrEnv.slice(i + 1)) || 3425 }]
      if (/^\d+$/.test(addrEnv)) return [{ host: "127.0.0.1", port: Number(addrEnv) }]
    }
    return [
      { host: "127.0.0.1", port: 3425 },
      { host: "127.0.0.1", port: 3430 },
    ]
  }

  function tcpProbe(hostName, portNo, timeoutMs = 2000) {
    return new Promise((ok) => {
      const s = net.connect({ host: hostName, port: portNo })
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        s.destroy()
        ok(v)
      }
      s.setTimeout(timeoutMs, () => finish(false))
      s.on("connect", () => finish(true))
      s.on("error", () => finish(false))
    })
  }

  async function checkMagpie() {
    try {
      const cands = magpieCandidates()
      for (const c of cands) {
        if (await tcpProbe(c.host, c.port)) {
          magpieFails = 0
          return
        }
      }
      magpieFails++
      if (magpieFails >= 4) shutdown(`连续 ${magpieFails} 次探测不到 magpie（${cands.map((c) => `${c.host}:${c.port}`).join(" / ")}），退出`)
    } catch (e) {
      log("[magpie probe] " + shortErr(e))
    }
  }

  function checkControl() {
    try {
      const c = readControl(stateDir)
      if (c.desired === "off") {
        shutdown("control.json desired=off")
        return true
      }
    } catch (e) {
      log("[control] " + shortErr(e))
    }
    return false
  }

  function shutdown(reason) {
    if (stopped) return whenStopped
    stopped = true
    log("[shutdown] " + reason)
    for (const t of timers) clearInterval(t)
    broadcast({ kind: "scheduler", event: "shutdown", reason: scrub(reason) })
    for (const res of [...sseClients]) {
      try {
        res.end()
      } catch {}
    }
    sseClients.clear()
    Promise.race([stopCurrentJob(), sleepFn(1500)])
      .catch(() => {})
      .finally(() => {
        try {
          server.close(() => whenStoppedResolve())
        } catch {
          whenStoppedResolve()
        }
        // 保险：close 回调万一不触发
        setTimeout(whenStoppedResolve, 1000).unref?.()
      })
    return whenStopped
  }

  // ---- 启动落盘 + 定时器 -----------------------------------------------------

  const startedAt = nowIso()
  heartbeat()
  if (opts.noTimers !== true) {
    every(5000, heartbeat)
    every(5000, checkControl)
    every(10000, checkPluginsFile)
    every(15000, checkMagpie)
    every(30000, checkScheduler)
    every(1000, watchJobTick)
  }

  log(`守护进程就绪：http://${host}:${port}（state: ${stateDir}）`)
  // A：绑定为通配地址时必须给出明确提示（与 index.mjs / reachableHint 同一句口径）
  const bindWarn = bindHint(host)
  if (bindWarn) log(`监听 ${host}:${port}：${bindWarn}`)
  if (!engine?.ok) log("[warn] " + engineErrorsText())

  return {
    port,
    host,
    key,
    stateDir,
    cfgDir,
    version: VERSION,
    engine,
    runner, // 便于测试观察 job 状态
    whenStopped,
    get stopped() {
      return stopped
    },
    stop: () => shutdown("stop() 被调用"),
    // 测试钩子：手动驱动各路检查（noTimers 模式下用）
    ticks: {
      heartbeat,
      checkControl,
      checkPluginsFile,
      checkMagpie,
      checkScheduler,
      watchJob: watchJobTick,
    },
  }
}

// ---- 作为脚本运行 -----------------------------------------------------------

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href
  } catch {
    return false
  }
})()

if (isMain) {
  const log = (...a) => console.log(new Date().toISOString(), ...a)
  startDaemon({ log })
    .then((h) => {
      // 免密钥口径的如实提示：无鉴权，安全靠网络边界（默认只绑 127.0.0.1）
      log(`看板地址：http://${h.host}:${h.port}/  （无鉴权：全部 API 免密钥，默认只绑 127.0.0.1，安全靠网络边界，勿暴露公网）`)
      // 通配绑定的提示由 startDaemon 的启动日志统一给出，这里不再重复
      const bye = (sig) => () => {
        log(`收到 ${sig}，退出`)
        h.stop()
        setTimeout(() => process.exit(0), 1500)
      }
      process.on("SIGINT", bye("SIGINT"))
      process.on("SIGTERM", bye("SIGTERM"))
      process.on("exit", () => log("daemon 退出"))
      process.on("uncaughtException", (e) => log("[uncaught] " + shortErr(e)))
      process.on("unhandledRejection", (e) => log("[unhandled] " + shortErr(e)))
    })
    .catch((e) => {
      log("启动失败：" + shortErr(e))
      process.exit(1)
    })
}

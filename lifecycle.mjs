// magpie-workbuddy-tasks —— 守护进程生命周期辅助
// 只被 index.mjs（插件宿主内）与 daemon.mjs 使用；只用 node: 内置，Node / Bun 通用。
//
// 职责（契约 §4）：
//   - 定位 magpie 配置目录与插件自己的 state 目录
//   - control.json（唯一意图来源：desired = 'on' | 'off'）的读写
//   - daemon.json（pid/port/key/version/startedAt，权限 0600）的读写
//     （key 字段向后兼容保留：老版本看板/探测逻辑会读；免密钥口径下它不是
//      访问凭据，daemon 的任何接口都不校验它。port 是**观察值**——daemon
//      实际绑定的端口，给复用探测当线索，绝不回灌成下次启动的偏好，issue #5）
//   - 探测守护进程健康（GET /api/hello）
//   - ensureDaemon()：健康则复用，不健康才 spawn（detached + stdio ignore + unref）；
//     期望端口只来自调用方显式传入的 port（normalizePort 归一），绝不取自 daemon.json
//   - shutdownDaemon()：POST /api/shutdown 通知退出
//   - registerExitHooks()：宿主退出/信号时收尾

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const PLUGIN_NAME = "workbuddy-tasks"
export const DEFAULT_PORT = 4390
const SPAWN_BUDGET_MS = 8000

// normalizePort(v) -> 1–65535 的整数端口 | null（导出：index.mjs 与本文件共用同一套
// 边界，避免两处各写一份口径漂移）。取舍：
//   - 只认 number 与纯数字 string（trim 后必须 /^\d+$/）——magpie 的插件 options
//     里用户可能填 "4390" 或 4390，两种都收；"4390abc"/"4390.5"/"abc" 一律 null
//     （宁可忽略回默认端口，也不猜用户想填什么）；
//   - 0 / 负数 / >65535 / 非有限数（NaN/Infinity）→ null（0 留给「系统挑端口」的
//     daemon --port 0 语义，插件选项不开放它）；
//   - 布尔/null/undefined/对象 → null；空串与纯空白 → null（= 未配置）。
//   - 前导零的纯数字串（"04390"）按十进制数值收（= 4390）：options 不是 HTTP 头，
//     不需要 sanitizeServeHost 那套防前导零歧义的白名单。
export function normalizePort(v) {
  let s
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null
    s = String(v)
  } else if (typeof v === "string") {
    s = v.trim()
  } else {
    return null
  }
  if (!s || !/^\d+$/.test(s)) return null
  const n = Number(s)
  return n >= 1 && n <= 65535 ? n : null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readTextSync(file) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}

// 原子写（tmp + rename）；mode 只在 Linux/macOS 有意义（0600 保护 daemon.json）
function writeJsonAtomic(file, data, mode) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8")
  if (mode) {
    try {
      chmodSync(tmp, mode)
    } catch {}
  }
  renameSync(tmp, file)
}

function ensureDir(dir) {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {}
}

// ---- 路径 ------------------------------------------------------------

// resolveCfgDir：magpie 配置目录。优先级：WB_CONFIG_DIR > MAGPIE_CONFIG_DIR >
// $XDG_CONFIG_HOME/magpie > ~/.config/magpie（与 engine/store 的规则对齐；
// magpie 在 Docker 里通常是 /config/magpie，请设 MAGPIE_CONFIG_DIR 指过去）。
export function resolveCfgDir(env = process.env) {
  const wb = typeof env.WB_CONFIG_DIR === "string" ? env.WB_CONFIG_DIR.trim() : ""
  if (wb) return wb
  const mg = typeof env.MAGPIE_CONFIG_DIR === "string" ? env.MAGPIE_CONFIG_DIR.trim() : ""
  if (mg) return mg
  const xdg = typeof env.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME.trim() : ""
  if (xdg) return join(xdg, "magpie")
  return join(homedir(), ".config", "magpie")
}

// 本插件在 magpie 配置目录下的状态目录：<cfg>/workbuddy-tasks/state
export function stateDirFor(cfgDir) {
  return join(cfgDir, PLUGIN_NAME, "state")
}

// ---- control.json：唯一意图来源 ---------------------------------------

export function controlPath(stateDir) {
  return join(stateDir, "control.json")
}

export function readControl(stateDir) {
  try {
    const raw = JSON.parse(readTextSync(controlPath(stateDir)) ?? "{}")
    return { ...raw, desired: raw.desired === "off" ? "off" : "on" }
  } catch {
    return { desired: "on" }
  }
}

export function writeControl(stateDir, desired, extra = {}) {
  writeJsonAtomic(controlPath(stateDir), {
    ...extra,
    desired: desired === "off" ? "off" : "on",
    updatedAt: new Date().toISOString(),
  })
}

// ---- daemon.json：pid / port / key / version / startedAt（0600） -------
// key 字段仅为向后兼容保留（老看板/宿主探测逻辑依赖它存在）：免密钥口径下
// 它不是访问凭据、不被任何接口校验；写进去是为了老代码读字段不空转。

export function daemonInfoPath(stateDir) {
  return join(stateDir, "daemon.json")
}

export function readDaemonInfo(stateDir) {
  try {
    const raw = JSON.parse(readTextSync(daemonInfoPath(stateDir)) ?? "null")
    if (!raw || typeof raw !== "object") return null
    const port = Number(raw.port)
    if (!raw.pid || !Number.isFinite(port) || port <= 0) return null
    return {
      pid: Number(raw.pid),
      port,
      key: String(raw.key ?? ""),
      version: raw.version,
      startedAt: raw.startedAt,
      // daemon 实际绑定的 host（daemon.mjs 心跳写入）；旧版 daemon.json 没有该
      // 字段时按默认绑定 127.0.0.1 读，保证宿主日志不会把通配绑定误报成回环。
      host: typeof raw.host === "string" && raw.host ? raw.host : "127.0.0.1",
    }
  } catch {
    return null
  }
}

export function writeDaemonInfo(stateDir, info) {
  writeJsonAtomic(daemonInfoPath(stateDir), { ...info, writtenAt: new Date().toISOString() }, 0o600)
}

export function daemonKey() {
  // 免密钥口径下生成的值只写进 daemon.json 的 key 字段（向后兼容保留，不是
  // 访问凭据）；保留生成逻辑让 daemon.json 的形状与老版本一致。
  return randomBytes(24).toString("base64url")
}

// ---- 绑定地址口径（A/B 共用，三处一致） ---------------------------------
//
// daemon 实际绑定的 host 由 daemon.mjs 写进 daemon.json（readDaemonInfo 读出），
// 以下三处必须用同一句话，避免「日志说 127.0.0.1、实际绑 0.0.0.0」这类误导：
//   1. daemon.mjs 启动日志（「监听 <host>:<port>：<提示>」）
//   2. index.mjs 宿主日志（ensureDaemon 就绪后同格式补一句）
//   3. /api/state 顶层 reachableHint（前端展示用，见 docs/CONTRACT.md §3）
export const WILDCARD_HINT = "仅容器网桥/局域网可达，请用 SSH 隧道或局域网地址访问，切勿发布到公网"

export function isWildcardHost(host) {
  const h = String(host ?? "").trim()
  return h === "0.0.0.0" || h === "::"
}

export function bindHint(host) {
  return isWildcardHost(host) ? WILDCARD_HINT : ""
}

// ---- 进程与健康探测 ----------------------------------------------------

// pidAlive：kill(pid, 0) 成功 ≠ 活着。僵尸进程（已退出、等父进程收尸）和 pid
// 复用后的无关进程都会让 kill(pid,0) 假阳性 —— 而这里它被用来判「daemon.json
// 记的是不是我们的守护进程还活着」（ensureDaemon 的复用门、daemon 拒双开门、
// B6 写前复查都以它为第一道闸）：僵尸永远不会再服务端口，判成「活着」会让
// 陈旧 daemon.json 走进 bind 后的自探死局 —— 新守护进程 bind 同一端口后探测
// 探到自己健康，叠加「记的 pid 看着还活着」就被误判成外来双开、自己把自己
// 劝退，守护进程永远起不来（2026-11 生产缺陷）。所以 Linux 上 kill(0) 成功后
// 再读 /proc/<pid>/stat 的进程状态位：Z（僵尸）/ X（已死）→ 判为不存活；
// ENOENT（读的瞬间该 pid 已消失/被收尸）→ 判为不存活 —— 但仅当 /proc 本身
// 可用（/proc/self/stat 存在）时才这么判，最小容器没挂 procfs 时 kill(0) 的
// 结论仍是唯一依据；其余读不到的情况（Windows/macOS、hidepid 等权限差异）
// 退回 kill(0) 的结论（保守：与旧口径一致）。
export function pidAlive(pid) {
  const p = Number(pid)
  if (!Number.isFinite(p) || p <= 0) return false
  try {
    process.kill(p, 0)
  } catch (e) {
    return e?.code === "EPERM" // 存在但无权发信号，也算活着
  }
  if (process.platform !== "linux") return true
  try {
    const stat = readFileSync(`/proc/${p}/stat`, "utf8")
    // stat 格式：pid (comm) state ppid ...（proc(5)）。comm 可含空格与 ')'，
    // 状态位取最后一个 ')' 之后的第一个字段。
    const state = stat
      .slice(stat.lastIndexOf(")") + 1)
      .trim()
      .split(/\s+/)[0]
    return !(state === "Z" || state === "X" || state === "x")
  } catch (e) {
    if (e?.code === "ENOENT" && existsSync("/proc/self/stat")) return false // 进程已消失
    return true // 读不到（无 procfs/权限等）：退回 kill(0) 的结论
  }
}

// probeDaemon：GET /api/hello，且 name 必须是本插件——端口被别的程序占了不算数。
// key 参数兼容保留：免密钥 daemon 不校验，但探测老版本 daemon（仍要密钥）时
// 带上它才能探活，升级期平滑过渡。
export async function probeDaemon(port, key, timeoutMs = 1500, host = "127.0.0.1") {
  let res
  try {
    res = await fetch(`http://${host}:${port}/api/hello`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: key ? { authorization: `Bearer ${key}` } : undefined,
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  let j = null
  try {
    j = await res.json()
  } catch {
    return null
  }
  return j && j.name === PLUGIN_NAME ? j : null
}

// ---- 解释器解析（不碰 Bun.spawn；spawn+detached+unref 两边通用） -------

// 宿主是 Bun 时 process.execPath 就是 bun 可执行文件，是 Node 时就是 node；
// 万一拿不到，退回 PATH 上的 node（spawn("node") 在 Windows 会自动补 .exe）。
export function interpreter() {
  const p = process.execPath
  if (typeof p === "string" && p.trim()) return p
  return process.platform === "win32" ? "node.exe" : "node"
}

// ---- ensureDaemon：健康则复用，不健康才拉起 -----------------------------
//
// 端口口径（issue #5 回归修复，2026-11）：期望端口**只**来自调用方显式传入的
// port（number|string，index.mjs 里源头是插件选项 options.port）——归一失败或
// 未传 = 默认 4390。daemon.json 里的 port 是**观察值**（上一次实际绑定的端口，
// 端口被占用顺延后可能 ≠ 4390）+ 复用探测的线索，**绝不当作偏好继承**：旧版
// `prev?.port || DEFAULT_PORT` 会把历史上任何一次顺延（+1..+9 或随机端口）永久
// 记住，4390 空出来了也回不去（生产症状：daemon.json 停在 8761，重启后仍是
// 8761，插件入口卡按 4390 推导永远打不开）。prev 只有两个用途：
//   ① key 沿用（复用同一份 daemon.json 的 key 字段，向后兼容形状不变）；
//   ② 若它指向的守护进程健康（pidAlive + probeDaemon）→ 复用并返回，绝不重启。
//
// 返回 { info, spawned, error?, off? }：
//   off      —— control.json.desired === 'off'，宿主不该拉起
//   spawned  —— 本次是否由我们 spawn（exit 钩子据此决定要不要叫它退场）
//   info     —— 就绪守护进程的 {pid,port,key,...}；没就绪时为 null
export function isPluginDisabledInConfig(cfgDir) {
  try {
    const raw = JSON.parse(readTextSync(join(cfgDir, "plugins.json")) ?? "null")
    if (!raw || !Array.isArray(raw.plugins)) return false
    const mine = raw.plugins.filter((x) => String(x?.spec ?? "").includes(PLUGIN_NAME))
    return mine.some((x) => x?.off === true)
  } catch {
    return false
  }
}

export async function ensureDaemon({ cfgDir, pluginDir, log = () => {}, budgetMs = SPAWN_BUDGET_MS, addr = "", port = "", version = "" } = {}) {
  if (!cfgDir) {
    return { info: null, spawned: false, error: "无法定位 magpie 配置目录（可设 MAGPIE_CONFIG_DIR 环境变量）" }
  }
  const stateDir = stateDirFor(cfgDir)
  ensureDir(stateDir)

  const control = readControl(stateDir)
  if (control.desired === "off") {
    log("control.json desired=off，守护进程保持关闭")
    return { info: null, spawned: false, off: true }
  }
  if (isPluginDisabledInConfig(cfgDir)) {
    log("plugins.json 本插件已关闭（off:true），守护进程保持关闭")
    return { info: null, spawned: false, off: true }
  }

  const wantPort = normalizePort(port) ?? DEFAULT_PORT

  // 已有一个健康的？直接复用（拒绝重复拉起是 daemon 自己也会把守的另一道门）。
  // prev.port 只用来探活；它 ≠ wantPort 时说明留的是旧顺延结果 —— 如实说清，
  // 本进程照常复用（绝不重启健康进程），下次它退场后新进程才会绑回 wantPort。
  const prev = readDaemonInfo(stateDir)
  if (prev && pidAlive(prev.pid)) {
    const hello = await probeDaemon(prev.port, prev.key).catch(() => null)
    if (hello) {
      if (version && hello.version && hello.version !== version) {
        log(`检测到守护进程版本变更（${hello.version} → ${version}），平滑升级中…`)
        const targetPid = hello.pid ?? prev.pid
        await shutdownDaemon({ ...prev, pid: targetPid }).catch(() => false)
        const waitDown = Date.now() + 3000
        while (Date.now() < waitDown && pidAlive(targetPid)) await sleep(150)
      } else {
        if (prev.port !== wantPort) {
          log(
            `已有守护进程在 ${prev.port}（期望 ${wantPort}）：本次复用 ${prev.port}，看板地址用 ${prev.port}；重启后会回到 ${wantPort}`,
          )
        }
        return { info: prev, spawned: false }
      }
    }
  }

  const daemonPath = join(pluginDir, "daemon.mjs")
  if (!existsSync(daemonPath)) {
    return { info: null, spawned: false, error: `找不到守护进程脚本：${daemonPath}` }
  }

  const key = prev?.key || daemonKey()
  const env = {
    ...process.env,
    WB_CONFIG_DIR: cfgDir,
    WB_STATE_DIR: stateDir,
    WB_DAEMON_KEY: key,
    WB_DAEMON_PORT: String(wantPort),
    ...(addr ? { WB_DAEMON_ADDR: String(addr) } : {}),
    WB_MANAGED: "1", // 由 magpie 宿主拉起：plugins.json 里条目消失时允许自杀
  }
  let child
  try {
    child = spawn(interpreter(), [daemonPath], {
      detached: true,
      stdio: "ignore",
      env,
      cwd: pluginDir,
      windowsHide: true,
    })
  } catch (e) {
    return { info: null, spawned: false, error: `拉起守护进程失败：${e?.message ?? e}` }
  }
  child.unref?.()
  log(`已拉起守护进程（pid ${child.pid}），等待就绪…`)

  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    await sleep(400)
    const info = readDaemonInfo(stateDir)
    // 必须等新子进程完成写盘认领（info.pid === child.pid），避免子进程刚 bind
    // 端口但未写 daemon.json 时，探活命中子进程却返回陈旧 daemon.json 里的旧 pid。
    if (info && Number(info.pid) === Number(child.pid)) {
      const hello = await probeDaemon(info.port, info.key || key).catch(() => null)
      if (hello && (hello.pid == null || Number(hello.pid) === Number(child.pid))) {
        return { info, spawned: true }
      }
    }
    if (!pidAlive(child.pid)) break // 起来又倒了：可能是竞态输家或端口/状态目录问题
  }
  // 兜底：若子进程在启动竞态中让位给另一新守护进程并已退出，复用那个活着的赢家
  const finalInfo = readDaemonInfo(stateDir)
  if (finalInfo && Number(finalInfo.pid) !== Number(child.pid) && pidAlive(finalInfo.pid)) {
    const hello = await probeDaemon(finalInfo.port, finalInfo.key || key).catch(() => null)
    if (hello && (hello.pid == null || Number(hello.pid) === Number(finalInfo.pid))) {
      return { info: finalInfo, spawned: false }
    }
  }
  return {
    info: finalInfo,
    spawned: true,
    error: "守护进程未能在时限内就绪（详情见 magpie 日志里 plugin: 开头的行）",
  }
}

// ---- shutdownDaemon：请守护进程退场 ------------------------------------

export async function shutdownDaemon(info, timeoutMs = 2500) {
  // Bearer 头兼容保留：免密钥 daemon 不校验，老版本 daemon 需要；info.key 恒有
  // （daemon.json 的 key 字段向后兼容保留）。
  if (!info?.port) return false
  // 身份校验（issue #9）：带 pid 时先确认端口上仍是同一个进程，绝不误杀后来接管的
  // 新守护进程；同时把 ?pid=... 传给服务端双重把关。
  if (info.pid != null) {
    const hello = await probeDaemon(info.port, info.key, Math.min(1000, timeoutMs)).catch(() => null)
    if (!hello) return false
    if (hello.pid != null && Number(hello.pid) !== Number(info.pid)) return false
  }
  try {
    const qs = info.pid != null ? `?pid=${encodeURIComponent(String(info.pid))}` : ""
    const res = await fetch(`http://127.0.0.1:${info.port}/api/shutdown${qs}`, {
      method: "POST",
      headers: info.key ? { authorization: `Bearer ${info.key}` } : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok
  } catch {
    return false
  }
}

// ---- 宿主退出钩子 -------------------------------------------------------

// process.on('exit') 里做不了异步收尾，所以 SIGINT/SIGTERM 走 await 再退出，
// 'exit' 只做尽力而为的 fire-and-forget。多数场景下守护进程自己的
// magpie 探测（连续失败即退）才是真正的兜底。
let hooksInstalled = false
export function registerExitHooks(onShutdown) {
  if (hooksInstalled) return
  hooksInstalled = true
  const run = () => {
    try {
      const r = onShutdown()
      if (r && typeof r.catch === "function") r.catch(() => {})
    } catch {}
  }
  const signaled = () => {
    Promise.resolve()
      .then(onShutdown)
      .catch(() => {})
      .finally(() => process.exit(0))
  }
  process.once("SIGINT", signaled)
  process.once("SIGTERM", signaled)
  process.once("exit", run)
}

// store.mjs —— magpie 凭据（plugin-auth.json）共享读 + 原子回写，以及本插件
// 的状态文件（CONTRACT §2 store 部分、铁律 3）。
//
// 凭据不外泄：这里只读/写文件，绝不把 token 打进日志；调用方拿到的 Account
// 只有在内存里才有完整 token。

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// plugin-auth.json 里与刷新结果相关的字段（与 magpie 官方插件的
// TOKEN_FIELDS 完全一致 —— saveAccountRefresh 只允许改这几个键）。
const TOKEN_FIELDS = ["access", "refresh", "expires", "refreshExpiresAt", "domain", "tokenType"];

// ---- 路径 --------------------------------------------------------------------
// readMagpieConfigDir(env) -> string|null
// 显式 MAGPIE_CONFIG_DIR 优先；否则用默认 ~/.config/magpie（存在才返回）。
export function readMagpieConfigDir(env = globalThis.process?.env ?? {}) {
  const explicit = String(env.MAGPIE_CONFIG_DIR || "").trim();
  if (explicit) return explicit;
  const fallback = join(homedir(), ".config", "magpie");
  try {
    return existsSync(fallback) ? fallback : null;
  } catch {
    return null;
  }
}

export function authFile(cfg) {
  return join(String(cfg || ""), "plugin-auth.json");
}

// 本插件状态目录（daemon 的 control.json / settings.json / daemon.json 也应
// 落在这里 —— CONTRACT §4 的 state/）。
export function stateDir(cfg) {
  return join(String(cfg || ""), "workbuddy-tasks", "state");
}

export function tasksStateFile(cfg) {
  return join(stateDir(cfg), "tasks-accounts.json");
}

// ---- 账号读取 ------------------------------------------------------------------
// acctKey 形如 "workbuddy" | "workbuddy#xxxxxxxx"（magpie/OpenCode 多账号键）。
// 导出供 accountio.mjs 复用（导入合并只认 provider "workbuddy" 的条目）。
export function providerOfKey(key) {
  const base = String(key || "").split("#")[0];
  if (base === "workbuddy") return "workbuddy";
  if (base === "workbuddy-ai") return "workbuddy-ai";
  return null; // workbuddy-tasks（我们自己）与其它 provider 一律不算账号
}

function isApiKeyEntry(entry) {
  return (
    entry.type === "api" ||
    entry.source === "key" ||
    (typeof entry.key === "string" && entry.key.length > 0)
  );
}

// 静态 API Key 没有 uid 声明：按 hub 的 api_key_id 口径从 key 派生
// （ck_<id>.<secret> → apikey-<id>，只留 [A-Za-z0-9_-]）。
function apiKeyUid(key) {
  let text = String(key || "");
  for (const prefix of ["ck_", "pt_"]) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      break;
    }
  }
  const id = String(text).split(".")[0].replace(/[^A-Za-z0-9_-]/g, "");
  return id ? `apikey-${id}` : "";
}

// 读本插件状态里的 tasksEnabled 映射（uid 或 acctKey -> false 才算关）。
function readTasksEnabledMap(cfg) {
  const file = tasksStateFile(cfg);
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
    if (raw && typeof raw === "object" && typeof raw.accounts === "object") return raw.accounts;
  } catch {}
  return {};
}

// loadAccounts(cfg) -> Account[]
// 只读 plugin-auth.json 的 workbuddy* 条目，映射成我们的内部形状。字段缺失
// 都给默认值，坏的条目跳过而不是抛错（一个坏账号不能拖死整个面板）。
//
// 层级边界（纯国内版口径，别改错层）：本函数**原样返回全部 workbuddy\* 条目，
// 包括国际版 provider "workbuddy-ai"**——accountio 的导入合并、daemon 导出的
// realm=intl 逃生口都要全量数据。daemon 在**使用侧**统一经自己的
// loadAccountsCn()（只留 provider === "workbuddy"）做列表/统计/排程/运行取数；
// 不要把「只出国内版」的过滤下沉到这里，否则导入合并与逃生口会拿到残缺数据。
export function loadAccounts(cfg) {
  const file = authFile(cfg);
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const enabledMap = readTasksEnabledMap(cfg);
  const accounts = [];
  for (const [key, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const provider = providerOfKey(key);
    if (!provider) continue;
    const access = typeof entry.access === "string" ? entry.access : "";
    const isApiKey = isApiKeyEntry(entry);
    const uid =
      typeof entry.uid === "string" && entry.uid ? entry.uid : isApiKey ? apiKeyUid(entry.key) : "";
    if (!access && !uid) continue; // 空壳条目（如 authorize 占位）
    accounts.push({
      key,
      provider,
      uid,
      nickname: typeof entry.accountId === "string" && entry.accountId ? entry.accountId : uid,
      access,
      refresh: typeof entry.refresh === "string" ? entry.refresh : "",
      expires: Number(entry.expires) || 0,
      refreshExpiresAt: Number(entry.refreshExpiresAt) || 0,
      domain: typeof entry.domain === "string" ? entry.domain : "",
      enterpriseId: typeof entry.enterpriseId === "string" ? entry.enterpriseId.trim() : "",
      tokenType: typeof entry.tokenType === "string" ? entry.tokenType : "",
      source: typeof entry.source === "string" ? entry.source : isApiKey ? "key" : "oauth",
      // JSON 导入来源标记（accountio 写入；易失：magpie 整体覆写会抹掉，
      // 只作 /api/state 的 imported 展示，绝不参与任何逻辑判断 —— 契约 §9）
      importedFrom: typeof entry.importedFrom === "string" ? entry.importedFrom : "",
      isApiKey,
      // tasksEnabled 来自本插件状态，不是 auth 字段；缺省 = 参与。
      tasksEnabled: enabledMap[key] !== false && enabledMap[uid] !== false,
    });
  }
  return accounts;
}

// eligibleAccounts(accounts, opts) -> Account[]
// 对齐 hub 的 task_accounts("cn")：国内个人 OAuth 且本插件没关掉任务的账号。
export function eligibleAccounts(accounts, opts = {}) {
  void opts;
  return (accounts ?? []).filter(
    (a) =>
      a.provider === "workbuddy" &&
      !a.isApiKey &&
      !a.enterpriseId &&
      a.tasksEnabled !== false,
  );
}

// ---- 原子回写 ------------------------------------------------------------------
function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${Math.floor(Math.random() * 0xffffffff).toString(16)}`;
  const text = JSON.stringify(value, null, 2) + "\n";
  writeFileSync(tmp, text, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows 上 chmod 只影响只读位，失败无碍
  }
  let lastErr = null;
  for (let i = 0; i < 5; i++) {
    try {
      renameSync(tmp, file);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err; // Windows 上目标被占用时 EPERM，稍后立刻重试
    }
  }
  if (lastErr) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw lastErr;
  }
  try {
    // rename 后把最终权限钉在 600（POSIX 上 tmp 的 mode 会跟着过来，这里是保险）
    chmodSync(file, 0o600);
  } catch {}
  return statSync(file);
}

// ---- B3 写前竞态复查原语 -------------------------------------------------------
//
// sha256Hex(text)：对文件**原文**取 SHA-256。与 daemon.mjs handleAccountsImport
// 的「导入确认写前竞态复查」（lastImportPreview.hash / sha256Hex + 写前重读比对）
// 是**同一口径的等价实现**——那份原语闭在 startDaemon 闭包里挪不出来，这里按
// 同一思路落地：比较的都是「读到的字节原文哈希」，文件不存在时按空串哈希
// （daemon 侧同款：sha256Hex(auth.ok ? auth.text : "")）。两边任一方改口径
// （比如换成 mtime）必须同步，否则两类写者的竞态窗口口径不一致。
function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

// 读一份「快照」：{data, hash}。复用 readAuthDocument（daemon 导入路径用的同一
// 读原语）：坏 JSON / 顶层不是对象 → 抛「拒绝回写」（绝不冒覆盖风险，与旧版
// saveAccountRefresh 的行为逐字一致）；文件不存在按空文档（导入空库合法场景）。
function readSnapshotForWrite(cfg) {
  const r = readAuthDocument(cfg);
  if (r.ok) return { data: r.data, hash: sha256Hex(r.text) };
  if (r.missing) return { data: {}, hash: sha256Hex("") };
  throw new Error(`${r.error}，拒绝回写以免丢数据`);
}

// 把 patch 盖进 acctKey 那一条（纯函数）：只碰 TOKEN_FIELDS，其余字段（包括
// 未知字段）与所有兄弟条目原样保留 —— 与旧版逐字段语义一致。
function mergeRefreshPatch(raw, acctKey, patch) {
  const doc = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const entry =
    doc[acctKey] && typeof doc[acctKey] === "object" && !Array.isArray(doc[acctKey])
      ? { ...doc[acctKey] }
      : {};
  for (const field of TOKEN_FIELDS) {
    if (patch && patch[field] !== undefined) entry[field] = patch[field];
  }
  return { ...doc, [acctKey]: entry };
}

// saveAccountRefresh(cfg, acctKey, patch, opts?) -> void
//
// 读-改-写：只把 patch 里出现的 TOKEN_FIELDS 盖进 acctKey 那一条，其余字段
// （包括未知字段）与所有兄弟条目（其它 provider / 其它账号）原样保留；tmp +
// rename 原子落盘，mode 600。patch 里 undefined 的键不碰旧值，绝不把别人的
// 账号冲掉。
//
// B3 写前竞态复查（写者至少三类：daemon 的 runner 刷新、magpie 宿主自身覆写、
// daemon 导入确认；裸 read-modify-write 在「A 读 → B 写（含轮换后的新 refresh）
// → A 整文档写回」的交错下会把 B 刚轮换的 refresh 冲掉 → refresh 轮换型上游
// 直接掉登录）。流程与 daemon 导入确认路径同一口径：
//   快照（读原文 → SHA-256）→ 合并 → **写前重读比对**；
//   不符 → 显式上报冲突（onConflict）→ 重读、以新文档为底重试**一轮**；
//   仍不符 → 放弃写并抛 WB_AUTH_WRITE_CONFLICT（宁可少一次回写并留下显式日志，
//   也不把别人刚写入的新凭据冲掉；调用方 runner 会把该账号这一步记为失败，
//   下次刷新自然重试）。
//
// opts（全部可选；生产调用方 daemon.mjs 的 runnerCtx.saveRefresh 只传 onConflict）：
//   onConflict(info) —— 每次检测到冲突时调用（info: {attempt, stage, file,
//     acctKey}；stage="retry" 表示将重读重试，"giveup" 表示放弃写入）。缺省
//     console.warn（独立使用本模块时的兜底出口；daemon 侧会注入自己的 log）。
//   interpose(attempt) —— **仅供测试注入**：在「读完快照」与「写前复查」的间隙
//     调用一次，模拟第三方写者改写文件；生产代码不传，行为与无缝完全一致。
export function saveAccountRefresh(cfg, acctKey, patch, opts = {}) {
  const file = authFile(cfg);
  const interpose = typeof opts.interpose === "function" ? opts.interpose : null;
  const onConflict =
    typeof opts.onConflict === "function"
      ? opts.onConflict
      : (info) =>
          console.warn(
            `[store] plugin-auth.json 并发写冲突（acctKey=${acctKey}，第 ${info?.attempt} 轮写前复查不符，stage=${info?.stage}）` +
              `：第三方可能刚轮换过 refresh token，本次回写${info?.stage === "giveup" ? "已放弃" : "将重读重试"}，避免覆盖新凭据`,
          );

  for (let attempt = 1; attempt <= 2; attempt++) {
    const snap = readSnapshotForWrite(cfg);
    const merged = mergeRefreshPatch(snap.data, acctKey, patch);
    interpose?.(attempt);
    // 写前复查：文件必须仍是刚才合并所依据的那一份（与导入路径的
    // sha256Hex(re.ok ? re.text : "") !== hash 同款比对）
    const verify = readSnapshotForWrite(cfg);
    if (verify.hash === snap.hash) {
      writeJsonAtomic(file, merged);
      return;
    }
    onConflict({ attempt, stage: attempt < 2 ? "retry" : "giveup", file, acctKey });
  }
  throw Object.assign(
    new Error(
      `plugin-auth.json 写前复查连续两轮不符（其他写入者正在并发改写，可能刚轮换过 refresh token），` +
        `已放弃本次回写以免丢失新凭据；请稍后重试（acctKey=${acctKey}）`,
    ),
    { code: "WB_AUTH_WRITE_CONFLICT" },
  );
}

// ---- 账号 JSON 导入/导出用的文件原语（engine/accountio.mjs 复用，契约 §9）----
// 与 saveAccountRefresh 同一套纪律：坏 JSON 拒写、tmp + rename 原子落盘、mode 600、
// 调用方负责在写之前把其它 provider 的条目原样放回文档里。

// readAuthDocument(cfg) -> {ok:true, data, text} | {ok:false, error, missing?:true}
// 只读不写：解析失败如实报告（daemon 对导入预览/确认都回 409 拒写）；
// 文件不存在标 missing:true（导入空库是合法场景，调用方按 {} 处理）。
export function readAuthDocument(cfg) {
  const file = authFile(cfg);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    return {
      ok: false,
      missing: err?.code === "ENOENT",
      error: `读不到 ${file}：${String(err?.message || err)}`,
    };
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "plugin-auth.json 顶层不是对象" };
    }
    return { ok: true, data, text };
  } catch (err) {
    return { ok: false, error: `plugin-auth.json 解析失败：${String(err?.message || err)}` };
  }
}

// backupAuthFile(cfg, tag) -> 备份文件路径 | null（文件不存在时）
// 逐字节复制当前凭据文件（copyFileSync），文件名 plugin-auth.json.bak-<tag>。
export function backupAuthFile(cfg, tag) {
  const file = authFile(cfg);
  if (!existsSync(file)) return null;
  const safeTag = String(tag || "").replace(/[^A-Za-z0-9_-]/g, "") || "manual";
  const target = `${file}.bak-${safeTag}`;
  copyFileSync(file, target);
  return target;
}

// writeAuthDocument(cfg, data) -> 原子写入（tmp + rename、0600、无 tmp 残留）
export function writeAuthDocument(cfg, data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("plugin-auth.json 顶层必须是对象，拒绝写入");
  }
  return writeJsonAtomic(authFile(cfg), data);
}

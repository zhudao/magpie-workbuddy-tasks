// runner.mjs —— 跨账号批量编排：job 状态与日志、全局并发闸门、403/11140 冻结
//（freeze/frozen/unfreeze）、token 临期刷新 + 原子回写（CONTRACT §2/§10.5、铁律 3/4）。
// 每个账号开跑之前先做一次「每日活跃」上报（engine/daily.mjs，点亮成长中心
// 连登；幂等键 uid→北京日，失败只记日志不阻断腿）。
//
// 同一时刻只允许 1 个 job（current() 全局闸门；第二个 start() 抛 409）。
// 账号与账号之间按 trigger 间隔（manual 1.5 s / schedule 2–5 s 抖动，见
// schedule.accountGapMs）；腿的顺序固定 growth → mp → campaign → streak → buddy
// → travel → night（mp 在 growth 后：小程序链式任务也是成长体系的一部分；
// campaign 在 mp 后 streak 前：运营活动任务独立于成长体系（CONTRACT §11.1）；
// streak 在 buddy 前：连登管家是纯收益且幂等，先收；buddy 在 travel 前：开出
// 的 Buddy 可被随后一轮旅行使用），spec.legs 是这个顺序的子集。
// spec.taskCodes（{uid: string[]} | null，任务级勾选）只在 growth/mp 腿生效。
// 旅行只由 travel 腿触发（growth 腿显式 travel:false）；growth+mp 同跑时 growth
// 腿传 mpTasks:false（2b 关闭），避免小程序任务被两条腿各跑一遍。
// stop() 只在步骤边界生效（abort 信号在腿/账号之间检查）。
//
// 403/11140 冻结（0.3.3，hub v2.1.0 口径）：不是可自动恢复的冷却 —— 任何腿收到
// restricted 都立即 freeze(uid) 并经 onFrozen 回调持久化（daemon 落盘
// state/frozen.json），冻结账号在后续 job 里整账号跳过，只有 unfreeze(uid)
//（POST /api/account/unfreeze）能解除，绝不自动恢复。

import { runBuddyOpen } from "./buddy.mjs";
import { runCampaignTasks } from "./campaign.mjs"; // 运营活动任务腿（CONTRACT §11.1）
import { DEFAULT_GAP_MS, REFRESH_LEAD_MS } from "./constants.mjs";
import { reportDailyActivity } from "./daily.mjs"; // 每日活跃（点亮成长中心连登，CONTRACT §7）
import { uuidHex } from "./fingerprint.mjs";
import { runMiniProgramTasks, isMPCode } from "./miniprogram.mjs"; // 小程序链式任务腿（CONTRACT §7）
import { runStreakSteward } from "./streak.mjs"; // 连登管家腿（CONTRACT §10.1）
import { accountGapMs } from "./schedule.mjs";
import { eligibleAccounts } from "./store.mjs";
import { runGrowthTasks } from "./tasks.mjs";
import { runCatTravel, runNightTask } from "./travel.mjs";
import { clock, refreshAccount } from "./upstream.mjs";

// 腿顺序（CONTRACT §11.1）：campaign 独立于成长体系（独立的 /portal/activity/*
// 契约），排在 mp 之后、streak 之前；runner 与 daemon 的 LEGS 同序。
const LEG_ORDER = ["growth", "mp", "campaign", "streak", "buddy", "travel", "night"];

// 任务级勾选（CONTRACT §2/§3）每个账号清单的上限与 daemon.startJob 同款。
const TASK_CODES_CAP = 500;

// normalizeTaskCodes(spec.taskCodes) -> {uid: string[]} | null
// 只认「uid → 非空字符串数组」的普通对象：值清洗（去重、只留非空字符串、上限
// 500）、空清单/非法值丢弃；清洗后没有任何非空清单 → null（= 全部任务）。
// daemon.startJob 已把 /api/run 的两种 body 形状（数组 / 按 uid 对象）归一成
// 这一种再传进来；这里再防御一遍，直接构造 JobRunner 的调用方（测试/嵌入）
// 传脏数据也不会把勾选语义带歪。
function normalizeTaskCodes(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const [uid, codes] of Object.entries(raw)) {
    if (!uid || !Array.isArray(codes)) continue;
    const list = [];
    for (const c of codes) {
      if (typeof c === "string" && c.trim() && !list.includes(c.trim())) list.push(c.trim());
      if (list.length >= TASK_CODES_CAP) break;
    }
    if (list.length) out[String(uid)] = list;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeSpec(spec = {}) {
  const legs = (Array.isArray(spec.legs) && spec.legs.length ? spec.legs : [...LEG_ORDER])
    .filter((l) => LEG_ORDER.includes(l))
    .sort((a, b) => LEG_ORDER.indexOf(a) - LEG_ORDER.indexOf(b)); // 顺序固定 growth→mp→campaign→streak→buddy→travel→night
  return {
    uids: Array.isArray(spec.uids) && spec.uids.length ? [...spec.uids] : null,
    legs: legs.length ? legs : [...LEG_ORDER],
    claim: spec.claim !== false,
    trigger: spec.trigger === "schedule" ? "schedule" : "manual",
    // 任务级勾选（CONTRACT §3）：{uid: string[]} | null；growth/mp 腿据此只处理
    // 选中任务，buddy/travel/night 腿没有任务码，不受影响。
    taskCodes: normalizeTaskCodes(spec.taskCodes),
  };
}

export class JobRunner {
  // opts: {accounts?, loadAccounts?, saveRefresh?, fetch?, now?, sleep?, rand?,
  //        gap?, base?, bases?, env?, spacer?, dailySentMap?, onDailySent?,
  //        frozenMap?, onFrozen?, onUnfrozen?}
  constructor(opts = {}) {
    this.opts = opts;
    this.jobs = new Map();
    this._currentId = null;
    this._ctrls = new Map();
    // 403/11140 冻结表（CONTRACT §10.5）：uid -> {at:ISO, code, message}。
    // 不再有过期语义 —— 只有 unfreeze() 能解除。初始数据来自 opts.frozenMap
    //（daemon 从 state/frozen.json 读入的同一份对象），新冻结经 onFrozen 回调
    // 原子落盘；未注入时用实例内存表（同一 runner 的多个 job 之间仍然生效），
    // 跨进程重启的持久化由 daemon 负责。
    this._frozen = new Map(
      Object.entries(
        opts.frozenMap && typeof opts.frozenMap === "object" && !Array.isArray(opts.frozenMap)
          ? opts.frozenMap
          : {},
      ),
    );
    this._seq = 0;
    // 每日活跃的幂等账本（uid -> 北京日键）：daemon 从 state/daily-activity.json
    // 读入同一份对象并经 onDailySent 原子写回；未注入时用实例内存账本（同一
    // runner 的多个 job 之间仍然幂等），跨进程重启的幂等由 daemon 负责。
    this.dailySentMap =
      opts.dailySentMap && typeof opts.dailySentMap === "object" && !Array.isArray(opts.dailySentMap)
        ? opts.dailySentMap
        : {};
  }

  _now() {
    return (this.opts.now ?? clock.now)();
  }

  _sleep(ms) {
    return (this.opts.sleep ?? clock.sleep)(ms);
  }

  get(id) {
    return this.jobs.get(id) ?? null;
  }

  // 同一时刻只允许 1 个 job。
  current() {
    if (!this._currentId) return null;
    const job = this.jobs.get(this._currentId);
    if (!job || job.state === "done" || job.state === "error") return null;
    return job;
  }

  // ---- 403/11140 冻结（CONTRACT §10.5，替换原 2 小时自动冷却） --------------
  //
  // hub v2.1.0 口径：HTTP 403 / code 11140 不是可自动恢复的风控冷却，继续重试
  // 会让同设备账号连坐 —— 任何腿收到 restricted 立即冻结，**绝不自动恢复**，
  // 只有 unfreeze(uid)（daemon 的 POST /api/account/unfreeze / 看板「恢复」按钮）
  // 能解除。冻结不影响其他账号（不做全池熔断）。
  //
  // freeze(uid, {code, message})：首次冻结生效并回调 onFrozen（daemon 原子落盘
  // state/frozen.json）；重复 restricted 不覆盖记录（第一次的现场最真实）。
  freeze(uid, info = {}) {
    const key = String(uid ?? "");
    if (!key || this._frozen.has(key)) return false;
    const entry = {
      at: new Date(this._now()).toISOString(),
      code: info?.code ?? 11140,
      message: String(info?.message ?? ""),
    };
    this._frozen.set(key, entry);
    try {
      this.opts.onFrozen?.(key, entry); // daemon 落盘；回调异常不影响冻结本身
    } catch {}
    return true;
  }

  // unfreeze(uid)：解除冻结。返回是否真的解了一个（没冻结过 → false）。
  unfreeze(uid) {
    const key = String(uid ?? "");
    if (!key || !this._frozen.delete(key)) return false;
    try {
      this.opts.onUnfrozen?.(key); // daemon 同步删 state/frozen.json 里的条目
    } catch {}
    return true;
  }

  // frozen() -> [{uid, at, code, message}]（/api/state 顶层 frozen 的数据源，
  // daemon 负责拼昵称）。at 为冻结时刻的 ISO 串（注入时钟口径）。
  frozen() {
    return [...this._frozen].map(([uid, e]) => ({
      uid,
      at: e?.at ?? null,
      code: e?.code ?? 11140,
      message: String(e?.message ?? ""),
    }));
  }

  // isFrozen(uid)：冻结与否的同步查询（daemon 排除缺省目标时用）。
  isFrozen(uid) {
    return this._frozen.has(String(uid ?? ""));
  }

  // start(spec) -> job；已在跑时抛 {status:409}。
  start(spec = {}) {
    if (this.current()) {
      throw Object.assign(new Error("another job is already running"), { status: 409, code: "busy" });
    }
    const norm = normalizeSpec(spec);
    const job = {
      id: `job-${++this._seq}-${uuidHex().slice(0, 8)}`,
      state: "queued",
      startedAt: this._now(),
      endedAt: 0,
      totals: { credit: 0, energy: 0, tasksLit: 0, tasksClaimed: 0 },
      steps: [],
      log: [],
      spec: norm,
      // 顶层 trigger = 归一后的 spec.trigger（"schedule" | "manual"）：/api/jobs、
      // 看板 job 卡不必钻 spec 就能读；daemon 历史的口径仍是 job.spec.trigger
      //（这里只是同一份值的顶层冗余，两处永远一致）。
      trigger: norm.trigger,
      stopped: false,
      error: null,
    };
    this.jobs.set(job.id, job);
    this._currentId = job.id;
    const ctrl = new AbortController();
    this._ctrls.set(job.id, ctrl);
    job.signal = ctrl.signal;
    job._done = this._run(job, ctrl)
      .catch((err) => {
        job.error = String(err?.message || err);
        job.state = "error";
        job.endedAt = this._now();
      })
      .finally(() => {
        if (this._currentId === job.id) this._currentId = null;
        this._ctrls.delete(job.id);
      });
    return job;
  }

  // stop(id?) —— 取消当前（或指定）job；在步骤边界生效。
  stop(id = null) {
    const job = id ? this.jobs.get(id) ?? null : this.current();
    if (!job) return null;
    job.stopped = true;
    this._ctrls.get(job.id)?.abort();
    return job;
  }

  // wait(id) —— 等 job 收尾（测试与 workbuddy_tasks_wait 工具用）。
  async wait(id) {
    const job = this.jobs.get(id);
    if (!job) return null;
    await job._done;
    return job;
  }

  async _resolveAccounts(job) {
    let base = this.opts.accounts ?? null;
    if (!base && typeof this.opts.loadAccounts === "function") {
      base = await this.opts.loadAccounts();
    }
    const eligible = eligibleAccounts(base ?? []);
    if (job.spec.uids) {
      const want = new Set(job.spec.uids);
      return eligible.filter((a) => want.has(a.uid) || want.has(a.key));
    }
    return eligible;
  }

  // 铁律 3：access 临期就刷新，并原子回写 plugin-auth.json，保证社区插件与
  // 我们用的是同一对 token（refresh 轮换不互踢）。
  async _maybeRefresh(acct, job, logFn) {
    if (!acct.refresh || !acct.expires) return;
    if (acct.expires - this._now() > REFRESH_LEAD_MS) return;
    const res = await refreshAccount(acct, {
      fetch: this.opts.fetch,
      now: this.opts.now,
      sleep: this.opts.sleep,
      env: this.opts.env,
      base: this.opts.base,
      bases: this.opts.bases,
      // 铁律 4：刷新请求也是上游调用 —— 带上全局节流器（daemon 注入的唯一
      // 实例），与快照刷新/手动操作/job 腿共用同一份「上次放行时刻」。
      ...(this.opts.spacer ? { spacer: this.opts.spacer } : {}),
      log: logFn,
      leg: "refresh",
    });
    if (res.ok) {
      Object.assign(acct, res.patch);
      if (typeof this.opts.saveRefresh === "function") {
        try {
          await this.opts.saveRefresh(acct.key, res.patch);
          job.log.push(`· [${acct.uid}] access token 临期，已刷新并回写 plugin-auth.json`);
        } catch (err) {
          job.log.push(`! [${acct.uid}] 刷新成功但回写失败: ${String(err?.message || err)}`);
        }
      } else {
        job.log.push(`· [${acct.uid}] access token 临期，已刷新（未配置回写）`);
      }
    } else {
      job.log.push(`! [${acct.uid}] 刷新失败: ${res.reason}（继续用现有 token）`);
    }
  }

  // 小程序次日锁（CONTRACT §7）的引擎注入件：daemon 可选提供 mpLockedCodes/
  // onMPLock/onMPClaimed（测试/嵌入未注入时全部为可选链，行为退化为「无锁」）。
  _mpLockOpts(acct) {
    return {
      lockedCodes: this.opts.mpLockedCodes?.(acct.uid),
      onLock: (code, until, reason) => this.opts.onMPLock?.(acct.uid, code, until, reason),
      onClaimed: (code) => this.opts.onMPClaimed?.(acct.uid, code),
    };
  }

  _step(job, acct, leg, state, detail = "") {
    const step = {
      uid: acct.uid,
      nickname: acct.nickname,
      leg,
      state,
      detail,
      credit: 0,
      energy: 0,
      at: this._now(),
    };
    job.steps.push(step);
    return step;
  }

  _finishStep(job, step, state, detail, credit = 0, energy = 0) {
    step.state = state;
    step.detail = detail;
    step.credit = credit;
    step.energy = energy;
    step.at = this._now();
  }

  async _run(job, ctrl) {
    job.state = "running";
    const accounts = await this._resolveAccounts(job);
    if (!accounts.length) job.log.push("没有可参与任务的账号（workbuddy 个人 OAuth 且未关闭 tasks）");

    for (let ai = 0; ai < accounts.length; ai++) {
      if (ctrl.signal.aborted) break;
      const acct = accounts[ai];

      // 已冻结账号（403/11140，CONTRACT §10.5）：整账号跳过（照实给一行 skip），
      // 绝不重试 —— 冻结只有 unfreeze 能解除。
      if (this._frozen.has(acct.uid)) {
        this._step(job, acct, job.spec.legs[0], "skip", "账号已冻结（403/11140），本轮跳过；确认无风险后可在账号行点「恢复」");
        continue;
      }

      const logFn = (line) => {
        if (typeof line === "string") {
          job.log.push(line);
          return;
        }
        // 上游结构化步进：{uid, leg, state, detail}（token 一律不进日志）
        const { uid, leg, state, detail } = line;
        if (state === "restricted") {
          // 立即冻结（onFrozen → daemon 落盘 state/frozen.json），不再有冷却期
          this.freeze(uid || acct.uid, { code: 11140, message: detail || "restricted (403/11140)" });
          job.log.push(`! [${uid || acct.uid}/${leg}] 触发风控限制 (403/11140)，已冻结账号（不再自动恢复）`);
        } else if (state === "fail" || state === "retry") {
          job.log.push(`· [${uid || acct.uid}/${leg}] ${state}: ${detail}`);
        }
      };

      await this._maybeRefresh(acct, job, logFn);

      // 每日活跃（CONTRACT §7）：每个账号每个北京日一条 chat 事件（计费域），
      // 点亮成长中心连登。无论本 job 跑哪些腿都先打这一条；跳过/失败只记日志，
      // 绝不阻断后面的腿，更不让 job 失败。上游调用经 reportEvents → 全局节流器
      //（spacer 注入见下），与腿内调用同一条红线。
      {
        const daily = await reportDailyActivity(acct, {
          now: this.opts.now,
          sleep: this.opts.sleep,
          fetch: this.opts.fetch,
          env: this.opts.env,
          base: this.opts.base,
          bases: this.opts.bases,
          gap: this.opts.gap,
          signal: ctrl.signal,
          log: logFn,
          leg: "daily",
          // 铁律 4：每日活跃也是上游调用 —— 带上全局节流器（daemon 注入的
          // 唯一实例），与 job 腿/刷新/快照/手动操作共用「上次放行时刻」。
          ...(this.opts.spacer ? { spacer: this.opts.spacer } : {}),
          // 幂等账本与落盘回调（daemon 注入；未注入时用实例内存账本）
          sentMap: this.dailySentMap,
          ...(typeof this.opts.onDailySent === "function" ? { onSent: this.opts.onDailySent } : {}),
        });
        if (daily.sent) {
          job.log.push(`· [${acct.uid}] 每日活跃：已上报（${daily.key}）`);
        } else if (daily.skipped) {
          job.log.push(`· [${acct.uid}] 每日活跃：今日已报过（${daily.key}），跳过`);
        } else {
          job.log.push(`! [${acct.uid}] 每日活跃：上报失败：${daily.error || "未知原因"}（继续跑腿）`);
        }
      }

      for (const leg of job.spec.legs) {
        if (ctrl.signal.aborted) break;
        // 铁律 4：腿内节奏由 upstream.makeCtx 的 breathe 保证，但「上一条腿 /
        // 刷新调用」与这一条腿分属两个节奏器（legOpts 每腿新建）—— 这里补一拍
        // gap，保证跨边界的两次上游调用也 ≥1s（宁可多等，绝不硬闯）。
        await this._sleep(Math.max(0, Number(this.opts.gap ?? DEFAULT_GAP_MS)));
        // 任务级勾选（CONTRACT §3/§11.6）：codes 是**两套命名空间混在一个清单**里的 ——
        // 成长/小程序的裸 code，以及活动任务的 `<activityCode>:<taskCode>`（**含冒号**）。
        // 各腿只认自己那套，别把对面那套当「不存在的任务」去警告。
        // 筛完为空 = 该账号选中的任务都不属于这条腿 → 整腿跳过；**绝不能传空数组**：
        // 引擎把「空/未传」一律当「全部」，传下去会跑光所有任务（用户只勾了活动任务，
        // 却把所有成长任务跑一遍 —— 这是不可接受的反向放大）。
        const legCodes = (() => {
          const all = job.spec.taskCodes?.[acct.uid];
          if (!Array.isArray(all) || !all.length) return null; // 未勾选 = 全部
          const isCampaignCode = (c) => String(c).includes(":");
          // 三套命名空间各归各腿，别把别人的码当自己的（2026-11-14 实测：只勾了一个成长任务，
          // mp 腿也拿到那串码 → 空跑一遍却显示「完成」，用户以为小程序任务被跑了）：
          //   campaign 腿 = 含冒号的 `<活动>:<任务>`
          //   mp 腿       = MP 专属码（Sequential_Tasks_* / school_season，走 isMPCode 同一判定源）
          //   growth 腿   = 其余（**但当本次 job 含 mp 腿时，MP 专属码让给 mp 腿**，
          //                 否则给 growth —— 那时它内部的 2b 分支会处理小程序任务）
          if (leg === "campaign") return all.filter(isCampaignCode);
          if (leg === "mp") return all.filter((c) => !isCampaignCode(c) && isMPCode(c));
          if (leg === "growth") {
            const mpLegInJob = Array.isArray(job.spec.legs) && job.spec.legs.includes("mp");
            return all.filter((c) => !isCampaignCode(c) && !(mpLegInJob && isMPCode(c)));
          }
          return null; // 其它腿（streak/buddy/travel/night）没有任务码
        })();

        const step = this._step(job, acct, leg, "running");
        if (Array.isArray(legCodes) && legCodes.length === 0) {
          this._finishStep(job, step, "skip", "该账号选中的任务都不属于这条腿，跳过");
          continue;
        }
        let res = null;
        try {
          const legOpts = {
            ...this.opts,
            log: logFn,
            claim: job.spec.claim,
            signal: ctrl.signal,
            ...(legCodes ? { codes: legCodes } : {}),
            // 任务级勾选：用上面按腿筛好的 legCodes（null = 全部；已在建 step 前
            // 处理「筛完为空」的整腿跳过）。
            // 猫猫旅行只由 travel 腿触发：growth 腿显式 travel:false（runGrowthTasks
            // 第 3 步据此整段跳过）——只勾 growth 绝不跑旅行、growth+travel 也只跑
            // 一次，步骤 detail/收益由 travel 腿自己记。
            ...(leg === "growth" ? { travel: false } : {}),
            // 小程序链式任务去重：本次 job 同时含 growth 与 mp 腿时，growth 腿的
            // 2b（runGrowthTasks 内嵌的小程序链路）关闭，交给 mp 腿；只有 growth
            // 时保持原 2b 行为（mp 腿不在 spec.legs 里）。
            ...(leg === "growth" && job.spec.legs.includes("mp") ? { mpTasks: false } : {}),
            // 小程序次日锁（CONTRACT §7）：daemon 注入的锁查询与回调透传给引擎，
            // growth 腿的 2b 与 mp 腿都要带 —— 锁定的任务整条跳过（不接取/不点亮），
            // 接取被上游锁拒时落盘锁原因，领奖成功时记领奖日期并锁下一环。
            ...((leg === "growth" || leg === "mp") ? this._mpLockOpts(acct) : {}),
          };
          if (leg === "growth") res = await runGrowthTasks(acct, legOpts);
          else if (leg === "mp") res = await runMiniProgramTasks(acct, legOpts);
          else if (leg === "campaign") res = await runCampaignTasks(acct, legOpts);
          else if (leg === "streak") res = await runStreakSteward(acct, legOpts);
          else if (leg === "buddy") res = await runBuddyOpen(acct, legOpts);
          else if (leg === "travel") res = await runCatTravel(acct, legOpts);
          else res = await runNightTask(acct, legOpts);
        } catch (err) {
          this._finishStep(job, step, "fail", String(err?.message || err));
          continue;
        }

        if (res?.restricted) {
          // 冻结（不再自动恢复）：onFrozen → daemon 落盘 state/frozen.json
          this.freeze(acct.uid, { code: res.code ?? 11140, message: res.msg || "restricted (403/11140)" });
          this._finishStep(job, step, "fail", `触发风控限制 (403/11140)，账号已冻结: ${res.msg || ""}`);
          continue;
        }
        const credit = Number(res?.credit ?? res?.earnedCredit ?? res?.earned ?? 0) || 0;
        const energy = Number(res?.energy ?? 0) || 0;
        const ok = res?.ok !== false;
        let detail = "";
        if (leg === "growth") {
          detail = `${ok ? "完成" : "失败"}；+${credit} 积分, 点亮 ${res?.lit ?? 0}, 领取 ${res?.claimed ?? 0}`;
        } else if (leg === "travel") {
          detail = res?.msg || (ok ? "完成" : "失败");
        } else {
          // mp / streak / buddy / night 腿返回 logs：步骤 detail 取最后一条人读日志
          detail = (res?.logs ?? []).slice(-1)[0] || (ok ? "完成" : "失败");
        }
        this._finishStep(job, step, ok ? "ok" : "fail", detail, credit, energy);
        if (ok) {
          job.totals.credit += credit;
          job.totals.energy += energy;
          job.totals.tasksLit += Number(res?.lit ?? 0) || 0;
          job.totals.tasksClaimed += Number(res?.claimed ?? 0) || 0;
        }
      }

      // 账号间隔：manual 1.5 s / schedule 2–5 s 抖动（铁律 4）。最后一个账号
      // 之后不再空等。
      if (ai < accounts.length - 1 && !ctrl.signal.aborted) {
        await this._sleep(accountGapMs(job.spec.trigger, this._now(), this.opts.rand));
      }
    }

    if (ctrl.signal.aborted) job.log.push("已按要求取消（步骤边界生效）");
    if (job.state !== "error") {
      job.state = "done";
      job.endedAt = this._now();
    }
  }
}

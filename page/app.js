// magpie 沙箱页（入口卡）逻辑。
//
// 硬约束（宿主沙箱）：iframe sandbox="allow-scripts"、CSP connect-src 'none' ——
// 没有 fetch / WebSocket / EventSource，没有内联脚本。本文件零网络请求。
// package.json 的 magpie.permissions 是空数组 → 不调用 magpie.read（连
// 'providers:list' 也不调），账号信息只做静态说明。
// 可用的宿主 API（按防御式写法消费，形状不确定时全部静默降级）：
//   magpie.ready / magpie.theme / magpie.onTheme / magpie.options.get() / magpie.onAction
// 主题：跟随宿主 data-theme；本卡的增量样式（style.css）与看板同一套 token。
(function () {
  "use strict";

  var DEFAULT_PORT = "4390";
  var currentPort = DEFAULT_PORT; // 解析出的端口；随插件选项更新，宿主桥没出现时兜底 4390

  function $(sel) {
    return document.querySelector(sel);
  }

  // ---- 主题 ------------------------------------------------------------------

  function normalizeTheme(t) {
    if (typeof t === "string") return t;
    if (t && typeof t === "object") {
      // magpie 的窗口主题形状是 { dark: bool, lang, tokens }；先认这个官方形状
      if (typeof t.dark === "boolean") return t.dark ? "dark" : "light";
      if (typeof t.theme === "string") return t.theme;
      if (typeof t.value === "string") return t.value;
      if (typeof t.mode === "string") return t.mode;
    }
    return "";
  }

  function applyTheme(t) {
    var mode = normalizeTheme(t);
    var root = document.documentElement;
    if (mode === "dark" || mode === "light") root.setAttribute("data-theme", mode);
    else root.removeAttribute("data-theme"); // 跟随系统（CSS prefers-color-scheme 兜底）
  }

  // ---- 看板地址 ----------------------------------------------------------------

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return "";
    }
  }

  function isLoopbackHost(h) {
    return h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1";
  }

  // 端口只能来自插件选项 magpie.options.get()（见 consumeHost）：本卡跑在
  // sandbox="allow-scripts" + CSP connect-src 'none' 的 iframe 里，零网络请求、
  // 读不到 state/daemon.json，magpie.permissions 也是空数组（没有 magpie.read），
  // 所以卡片无法自己发现守护进程的真实端口，唯一数据通道就是插件选项。
  // 边界与后端 normalizePort 保持一致：number 或纯数字字符串、且是 1–65535 的整数
  // 才采用；其余（空/非法/0/负数/越界/小数/"4390abc"/布尔/null）一律回落 "4390"。
  // 与后端 lifecycle.normalizePort 同口径：trim 后纯数字（所以 " 4390 " 两侧空白合法）。
  // 注意：守护进程端口被占用时会自动顺延（最多 +9，再不行用随机端口），此时这里
  // 解析出的端口可能与 daemon.json 里的真实值不同 —— 以 daemon.json 或 magpie
  // 日志「看板地址：…」那行为准，想固定就把实际端口填进插件选项 port。
  function resolvePort(opts) {
    var v = opts && typeof opts === "object" ? opts.port : undefined;
    var n;
    if (typeof v === "number") n = v;
    else if (typeof v === "string" && /^[0-9]+$/.test(v.trim())) n = Number(v.trim());
    else return DEFAULT_PORT;
    if (!Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_PORT;
    return String(n);
  }

  // 页面被 magpie 以 /_magpie/plugin/<token>/ 的形式服务在 magpie 自己的主机上，
  // 所以 location.hostname 就是用户访问 magpie 用的地址：用 192.0.2.10 打开
  // magpie，看板地址就是 http://192.0.2.10:<port>，不再死写 127.0.0.1。
  // 沙箱虽是无同源（opaque origin），仍可读取自身 location。
  function derivedDashboardUrl(port) {
    var h = "";
    try {
      h = location.hostname || "";
    } catch (e) { h = ""; }
    if (!h || h === "0.0.0.0" || h === "::") return "";
    return "http://" + h + ":" + (port || DEFAULT_PORT);
  }

  // 地址选择顺序（与之前完全一致，只把 ② 的推导地址、④ 的默认端口换成解析结果）：
  //   ① dashboardUrl 显式设置且不是回环地址 → 用它（运维声明的对外地址）
  //   ② 从 magpie 访问主机推导出的地址（局域网/网关 IP 场景，用户要的口径）
  //   ③ dashboardUrl 显式设置的回环地址（SSH 隧道场景，可能带自定义端口）
  //   ④ 推导出的回环地址 / 最终兜底 127.0.0.1:<port>
  function resolveDashboardUrl(raw, port) {
    var p = port || DEFAULT_PORT;
    var opt = typeof raw === "string" ? raw.trim() : "";
    var hasOpt = /^https?:\/\//i.test(opt);
    var derived = derivedDashboardUrl(p);
    if (hasOpt && !isLoopbackHost(hostOf(opt))) return opt;
    if (derived && !isLoopbackHost(hostOf(derived))) return derived;
    if (hasOpt) return opt;
    return derived || "http://127.0.0.1:" + p;
  }

  function setDashboardUrl(raw, port) {
    currentPort = port || DEFAULT_PORT;
    var url = resolveDashboardUrl(raw, currentPort);
    var code = $("#dashUrl");
    var link = $("#dashLink");
    if (code) code.textContent = url;
    if (link) link.setAttribute("href", url);
    updateTunnelHint(url);
  }

  // dashboardUrl 写的是回环地址（127.0.0.1/localhost/::1）时提示 SSH 隧道用法：
  // 隧道映射后仍可用 127.0.0.1:<port> 打开，无需改选项。非回环地址或解析失败
  // 一律静默隐藏，不炸页面（沙箱页零网络、零报错的纪律不变）。
  function updateTunnelHint(url) {
    var hint = $("#tunnelHint");
    if (!hint) return;
    var port = "";
    try {
      var u = new URL(url);
      var h = u.hostname;
      if (h === "127.0.0.1" || h === "localhost" || h === "[::1]" || h === "::1") {
        port = u.port || (u.protocol === "https:" ? "443" : "80");
      }
    } catch (e) { port = ""; }
    if (!port) {
      hint.hidden = true;
      return;
    }
    var code = $("#tunnelUrl");
    if (code) code.textContent = "127.0.0.1:" + port;
    hint.hidden = false;
  }

  // ---- 复制（clipboard API 在沙箱里可能被拒 → execCommand 兜底） ------------------

  function showToast(msg, ok) {
    var dash = document.querySelector(".wb-dash");
    if (!dash) return;
    var old = dash.querySelector(".wb-toast");
    if (old) old.remove();
    var p = document.createElement("p");
    p.className = ok ? "wb-toast wb-toast-ok" : "wb-toast";
    p.textContent = msg; // 只走 textContent，无注入面
    dash.appendChild(p);
    setTimeout(function () {
      p.remove();
    }, 3200);
  }

  function copyText(text, done) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { done(true); },
          function () { done(fallbackCopy(text)); },
        );
        return;
      }
    } catch (e) { /* 落到兜底 */ }
    done(fallbackCopy(text));
  }

  function currentUrl() {
    var code = $("#dashUrl");
    return code ? code.textContent : "http://127.0.0.1:" + currentPort;
  }

  function copyDashboardUrl() {
    var text = currentUrl();
    copyText(text, function (ok) {
      showToast(ok ? "已复制：" + text : "复制被沙箱拒绝，请手动选中地址复制。", ok);
    });
  }

  // magpie 的 iframe 只有 sandbox="allow-scripts"，没有 allow-popups：
  // window.open / target="_blank" 会被浏览器静默拦掉。这里先诚实地试一次，
  // 被拦就把地址复制好并给出下一步——绝不让点击「没反应」。
  // 右键链接 →「在新标签页中打开」不受脚本弹窗限制，是另一条可靠路径。
  function openDashboard(e) {
    if (e) e.preventDefault();
    var url = currentUrl();
    var win = null;
    try {
      win = window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      win = null;
    }
    if (win) {
      showToast("已在新窗口打开看板。", true);
      return;
    }
    copyText(url, function (ok) {
      showToast(
        ok
          ? "magpie 沙箱不允许弹新窗口：地址已复制，粘贴到浏览器新标签页即可；也可右键「打开看板」→ 在新标签页中打开。"
          : "magpie 沙箱不允许弹新窗口：请复制上方地址，或右键「打开看板」→ 在新标签页中打开。",
        ok,
      );
    });
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("style", "position:fixed;top:0;left:0;opacity:0");
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  // ---- 宿主桥接（防御式：任何 API 缺失都不炸页面） --------------------------------

  function consumeHost(mp) {
    if (!mp || typeof mp !== "object") return;

    // 初始主题
    try {
      var t = typeof mp.theme === "function" ? mp.theme() : mp.theme;
      if (t != null) applyTheme(t);
    } catch (e) {}

    // 主题变化
    try {
      if (typeof mp.onTheme === "function") mp.onTheme(applyTheme);
    } catch (e) {}

    // 插件选项（dashboardUrl / port；声明默认值见 package.json 的 magpie.options）。
    // 整份 opts 一起读进来：dashboardUrl 决定整条地址，port 决定推导地址与兜底端口。
    // 选项为空字符串时也调用一次：setDashboardUrl("", port) 会按当前 magpie 访问主机重算。
    try {
      if (mp.options && typeof mp.options.get === "function") {
        Promise.resolve(mp.options.get()).then(
          function (opts) {
            var o = opts && typeof opts === "object" ? opts : {};
            setDashboardUrl(
              typeof o.dashboardUrl === "string" ? o.dashboardUrl : "",
              resolvePort(o),
            );
          },
          function () {},
        );
      }
    } catch (e) {}

    // onAction：宿主动作回调。本卡没有需要响应的宿主动作，注册一个安全的空实现，
    // 避免宿主在缺少 handler 时报错；不做任何越权 RPC。
    try {
      if (typeof mp.onAction === "function") {
        mp.onAction(function () {
          /* no-op：入口卡无宿主动作 */
        });
      }
    } catch (e) {}

    // 注意：magpie.read('providers:list' | 'usage:summary') 一律不调用 ——
    // package.json 的 magpie.permissions 为空，未申报任何读取权限。
  }

  function waitForHost(tries) {
    var mp = window.magpie;
    if (mp) {
      consumeHost(mp);
      return;
    }
    if (tries <= 0) return; // 宿主桥始终没出现：静态入口卡照常可用
    setTimeout(function () {
      waitForHost(tries - 1);
    }, 120);
  }

  function start() {
    setDashboardUrl(""); // 先按当前访问 magpie 的主机落一版，宿主选项到达后再覆盖
    var copyBtn = $("#copyBtn");
    if (copyBtn) copyBtn.addEventListener("click", copyDashboardUrl);
    var openLink = $("#dashLink");
    if (openLink) openLink.addEventListener("click", openDashboard);

    var mp = window.magpie;
    var ready = mp ? mp.ready : null;
    if (mp && (typeof ready === "function" || (ready && typeof ready.then === "function"))) {
      // magpie.ready 是 Promise（见 _magpie/bridge.js 契约），不是回调式 API。
      // 加载 bridge.js + await ready 就是「跟 magpie 说上话」：少了这一步，宿主
      // 10 秒内收不到消息，会把本卡标成「已停止工作」。
      try {
        var r = typeof ready === "function" ? ready() : ready;
        Promise.resolve(r).then(
          function (theme) {
            applyTheme(theme);
            consumeHost(mp);
          },
          function () {
            consumeHost(mp);
          },
        );
        return;
      } catch (e) {
        consumeHost(mp);
        return;
      }
    }
    waitForHost(25); // 桥可能稍后注入
  }

  // 仅测试用：本文件是经典 IIFE，无法被 import；tests-shell/page-port.test.mjs 用
  // node:vm 加载后从这里取纯函数断言端口解析边界。运行时无人依赖它，宿主缺 window 也不炸。
  try {
    window.__wbPagePure = { resolvePort: resolvePort, resolveDashboardUrl: resolveDashboardUrl };
  } catch (e) {}

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();

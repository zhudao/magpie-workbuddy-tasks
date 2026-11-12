// tests/release-consistency.test.mjs —— 发布一致性（纯文件级断言，零网络、零导入、
// 零 daemon 启动）。版本号必须四处完全一致（issue #3 的连带教训：看板顶栏显示的
// 版本与实际发布版本对不上时，用户报告的「已更新」根本没生效）：
//   1. package.json            "version"
//   2. index.mjs               const VERSION = "…"
//   3. page/index.html         页脚 <span class="wb-mono" id="wbVersion">v…</span>
//   4. dashboard/index.html    <meta name="wb-version" content="…">
//      （app.js 读 meta 做前后端版本一致性检查；meta 由前端同事维护，但本用例
//       把 meta 缺失当成失败并给出明确提示 —— 绝不为绿而跳过。）

import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/

function mustMatch(text, re, label, hint = "") {
  const m = re.exec(text)
  assert.ok(m, `${label}：没匹配到版本号（正则 ${re}）。${hint}若文件结构改版，请同步更新本用例的正则。`)
  return m[1]
}

describe("发布一致性：版本号四处完全一致", () => {
  test("package.json / index.mjs / page 页脚 / dashboard wb-version meta 同值", () => {
    // ① package.json
    const pkgText = readFileSync(join(ROOT, "package.json"), "utf8")
    const pkgV = String(JSON.parse(pkgText).version ?? "")
    assert.match(
      pkgV,
      SEMVER_RE,
      `package.json 的 version 不是语义化版本号：${JSON.stringify(pkgV)}`,
    )

    // ② index.mjs 的 const VERSION（插件入口，宿主/CLI 读它）
    const idxV = mustMatch(
      readFileSync(join(ROOT, "index.mjs"), "utf8"),
      /const VERSION = "([^"]+)"/,
      "index.mjs 的 const VERSION",
    )

    // ③ page/index.html 页脚（magpie 沙箱入口卡，带 v 前缀）
    const pageV = mustMatch(
      readFileSync(join(ROOT, "page", "index.html"), "utf8"),
      /id="wbVersion">v([^<]+)</,
      "page/index.html 页脚 wbVersion",
    )

    // ④ dashboard/index.html 的 wb-version meta —— 前端同事负责添加；
    //    此刻没有它就算失败（不跳过），提示写清该谁补什么。
    const dashV = mustMatch(
      readFileSync(join(ROOT, "dashboard", "index.html"), "utf8"),
      /<meta\s+name="wb-version"\s+content="([^"]+)"/,
      'dashboard/index.html 的 <meta name="wb-version" content="…">',
      "meta 缺失即发布不一致：请前端同事在 dashboard/index.html <head> 补上 " +
        '<meta name="wb-version" content="' + pkgV + '">（app.js 读它做版本一致性检查）。',
    )

    // 两两比对（以 package.json 为基准），失败信息写清哪个文件哪个值对不上
    const others = [
      ["index.mjs 的 const VERSION", idxV],
      ["page/index.html 页脚 wbVersion", pageV],
      ["dashboard/index.html wb-version meta", dashV],
    ]
    for (const [label, value] of others) {
      assert.equal(
        value,
        pkgV,
        `版本不一致：${label} = ${JSON.stringify(value)}，package.json 的 version = ${JSON.stringify(pkgV)} —— 四处必须完全一致`,
      )
    }
  })
})

#!/usr/bin/env node
/**
 * Regenerates THIRD-PARTY-NOTICES.md.
 *
 * Why this exists: the published package ships `haruyuki.js`, a single-file
 * bundle that inlines nearly every production dependency, plus patched copies of
 * Ink and ink-text-input under `vendor/`. Redistributing that code requires
 * carrying its copyright lines and permission notices (MIT/BSD/ISC/Apache-2.0
 * all say so), and a hand-maintained list would rot on the next `bun install`.
 *
 * Scope: the transitive closure of `dependencies` + `optionalDependencies` in
 * package.json, resolved against the installed `node_modules`. devDependencies
 * are excluded because they are not redistributed.
 *
 * Usage: node scripts/generate-third-party-notices.cjs
 */

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const ROOT = path.resolve(__dirname, "..");
const NODE_MODULES = path.join(ROOT, "node_modules");
const OUTPUT = path.join(ROOT, "THIRD-PARTY-NOTICES.md");

const LICENSE_FILE_RE = /^(licen[cs]e|copying|notice)/i;
// Only lines that *begin* with the word "Copyright" (or ©) are copyright lines.
// Case matters: with /i the Apache body's lowercase sentences ("copyright
// notice that is included in or attached to the work", "copyright license to
// reproduce ...") were collected as attributions. Mid-sentence hits, the MIT
// permission notice, and the Apache body's "(c) ..." lines are excluded too.
// The Apache appendix placeholder is boilerplate, not a real attribution.
const COPYRIGHT_RE = /^(?:\/\/|#|\*|;|\s)*(Copyright\b|©)/;
const COPYRIGHT_PLACEHOLDER_RE = /\[yyyy\]|\[name of copyright owner\]/i;
const MAX_COPYRIGHT_LINES = 3;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function packageDir(name) {
  return path.join(NODE_MODULES, ...name.split("/"));
}

function licenseId(pkg) {
  if (typeof pkg.license === "string" && pkg.license.trim()) {
    return pkg.license.trim();
  }
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses
      .map((entry) => (typeof entry === "string" ? entry : entry.type))
      .filter(Boolean);
    if (types.length > 0) {
      return types.join(" OR ");
    }
  }
  return "(no license field)";
}

function licenseText(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return "";
  }
  const file = entries.find((entry) => LICENSE_FILE_RE.test(entry));
  if (!file) {
    return "";
  }
  try {
    return fs.readFileSync(path.join(dir, file), "utf8").trim();
  } catch {
    return "";
  }
}

function copyrightLines(text, pkg) {
  const found = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (
      line.length > 0 &&
      line.length <= 160 &&
      COPYRIGHT_RE.test(line) &&
      !COPYRIGHT_PLACEHOLDER_RE.test(line)
    ) {
      if (!found.includes(line)) {
        found.push(line);
      }
    }
    if (found.length >= MAX_COPYRIGHT_LINES) {
      break;
    }
  }
  if (found.length === 0 && typeof pkg.author === "string") {
    found.push(pkg.author);
  }
  return found;
}

/** Strips copyright lines so one MIT text can represent every MIT package. */
function canonicalText(text) {
  return text
    .split("\n")
    .filter((line) => !COPYRIGHT_RE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Substance-only comparison key: whitespace- and case-insensitive, and without
 * the leading "MIT License" / "The MIT License (MIT)" title line. Packages whose
 * LICENSE files differ only in that boilerplate share one printed text.
 */
function textKey(text) {
  return canonicalText(text)
    .split("\n")
    .filter(
      (line) =>
        !/^\s*(the\s+)?(mit|isc|bsd|apache|mozilla|blue\s*oak|unlicense)\b[^\n]{0,40}(licen[cs]e)?\s*$/i.test(
          line,
        ),
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Apache-2.0 §4(d) makes a dependency's NOTICE file transitive: if a bundled
 * package ships one, its notices have to travel with our distribution too.
 */
function noticeFileNames(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries.filter((entry) => /^notice/i.test(entry));
}

function collectClosure(rootPkg) {
  const queue = [
    ...Object.keys(rootPkg.dependencies || {}),
    ...Object.keys(rootPkg.optionalDependencies || {}),
  ];
  const seen = new Map();
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) {
      continue;
    }
    const dir = packageDir(name);
    const manifest = path.join(dir, "package.json");
    if (!fs.existsSync(manifest)) {
      seen.set(name, { name, version: "(not installed)", missing: true });
      continue;
    }
    const pkg = readJson(manifest);
    const text = licenseText(dir);
    seen.set(name, {
      name,
      version: pkg.version || "(unknown)",
      license: licenseId(pkg),
      text,
      copyright: copyrightLines(text, pkg),
      notices: noticeFileNames(dir),
    });
    for (const dep of Object.keys(pkg.dependencies || {})) {
      if (!seen.has(dep)) {
        queue.push(dep);
      }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function renderDependencies(packages) {
  const byLicense = new Map();
  for (const entry of packages) {
    const id = entry.missing ? "(未安装)" : entry.license;
    if (!byLicense.has(id)) {
      byLicense.set(id, []);
    }
    byLicense.get(id).push(entry);
  }
  const lines = [
    "## 2. 打包内联的 npm 依赖",
    "",
    "下表按各包 `package.json` 声明的许可证分组。每组的「许可原文」是组内使用最多的一份**逐字**文本；",
    "**每个包的版权行都单独列出** —— 这正是 MIT / BSD / ISC 要求随分发保留的部分。",
    "若某个包自带的文本与组内原文不同，会在「备注」里标出，请以该包目录内的 `LICENSE` 为准。",
    "",
  ];
  const sortedIds = [...byLicense.keys()].sort((a, b) => a.localeCompare(b));
  for (const id of sortedIds) {
    const entries = byLicense.get(id);
    lines.push(`### ${id} — ${entries.length} 个包`, "");
    lines.push("| 包 | 版本 | 版权行 | 备注 |", "|---|---|---|---|");

    const textCounts = new Map();
    for (const entry of entries) {
      if (!entry.text) {
        continue;
      }
      const key = textKey(entry.text);
      textCounts.set(key, (textCounts.get(key) || 0) + 1);
    }
    const ranked = [...textCounts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    const representativeKey = ranked.length > 0 ? ranked[0][0] : "";
    const representativeText = representativeKey
      ? canonicalText(
          entries.find((entry) => entry.text && textKey(entry.text) === representativeKey)
            .text,
        )
      : "";

    for (const entry of entries) {
      const holder = entry.copyright.join(" / ") || "—";
      let note = "";
      if (!entry.text) {
        note = "无许可文件";
      } else if (textKey(entry.text) !== representativeKey) {
        note = "文本有变体";
      }
      lines.push(
        `| \`${entry.name}\` | ${entry.version} | ${holder.replace(/\|/g, "\\|")} | ${note} |`,
      );
    }
    lines.push("");

    if (representativeText) {
      lines.push(
        `**${id} 许可原文**（组内 ${ranked[0][1]} 个包使用此文本）`,
        "",
        "```text",
        representativeText,
        "```",
        "",
      );
    }
    if (ranked.length > 1) {
      const variants = entries.filter(
        (entry) => entry.text && textKey(entry.text) !== representativeKey,
      );
      lines.push(
        `> 另有 ${ranked.length - 1} 种文本变体（共 ${variants.length} 个包，见上表「文本有变体」），以各包目录内的 \`LICENSE\` 为准。`,
        "",
      );
    }
    const withoutText = entries.filter((entry) => !entry.text).map((e) => e.name);
    if (withoutText.length > 0) {
      lines.push(
        `> ⚠️ 这些包未附许可文件，仅按 \`package.json\` 的 \`license\` 字段登记：${withoutText
          .map((name) => `\`${name}\``)
          .join("、")}`,
        "",
      );
    }
  }
  return lines;
}

function renderNonNpmSources() {
  const manifestPath = path.join(ROOT, "scripts", "non-npm-third-party-sources.json");
  if (!fs.existsSync(manifestPath)) {
    return ["## 3. 非 npm 来源的第三方内容", "", "（清单缺失）", ""];
  }
  const manifest = readJson(manifestPath);
  const entries = manifest.sources ?? [];
  const lines = [
    "## 3. 非 npm 来源的第三方内容",
    "",
    "以下表达**随本包分发**，但不在 npm 依赖闭包内，",
    "因此上面的依赖遍历**结构上扫不到**它们。清单维护在",
    "`scripts/non-npm-third-party-sources.json`（许可原文逐字保留）。",
    "",
    "这些提示词是**为基准对照（benchmarking）而收录的第三方原件**：本项目不是",
    "Anthropic / OpenAI / Google 的产品，也不代表它们，文件内容不构成本项目的声明。",
    "",
  ];
  for (const entry of entries) {
    const abs = path.join(ROOT, entry.path);
    const present = fs.existsSync(abs);
    lines.push(`### ${entry.path} — ${entry.license}`, "");
    lines.push(`- **来源**：${entry.origin}`);
    lines.push(`- **版本**：${entry.version}`);
    lines.push(`- **上游**：${entry.reference}`);
    if (entry.licenseCopyright) {
      lines.push(`- **版权行**：${entry.licenseCopyright}`);
    }
    lines.push(
      `- **本分支是否改动**：${entry.modifiedFromUpstream ? "是（见下）" : "否，与上游逐字相同"}`,
    );
    if (present) {
      const buf = fs.readFileSync(abs);
      const sha = createHash("sha256").update(buf).digest("hex");
      lines.push(
        `- **随包文件**：\`${entry.path}\`（${buf.length} 字节，SHA-256 \`${sha}\`）`,
      );
    } else {
      lines.push(`- **随包文件**：缺失（${entry.path} 不存在）`);
    }
    lines.push("");
    const src = entry.licenseTextSource ?? {};
    if (src.kind === "inline" && typeof src.text === "string") {
      lines.push("许可原文：", "", "```text", src.text.trim(), "```", "");
    } else {
      lines.push(
        "许可原文：与仓库根的 `LICENSE` **逐字相同**的标准 Apache License 2.0 文本",
        src.why ? `（${src.why}）` : "",
        "，此处不再重复贴出。",
        "",
      );
    }
  }
  return lines;
}

function main() {
  const rootPkg = readJson(path.join(ROOT, "package.json"));
  const packages = collectClosure(rootPkg);
  const missing = packages.filter((entry) => entry.missing).map((e) => e.name);
  const withText = packages.filter((entry) => entry.text).length;

  const header = [
    "# 第三方组件声明（THIRD-PARTY NOTICES）",
    "",
    "> 本文件由 `node scripts/generate-third-party-notices.cjs` 生成，**请勿手工编辑**。",
    "> 覆盖范围：`package.json` 的 `dependencies` ＋ `optionalDependencies` 的**传递闭包**",
    `> （当前 ${packages.length} 个包，其中 ${withText} 个读取到许可文件）`,
    "> ＋ **非 npm 来源**的第三方表达（见 §3，清单在 `scripts/non-npm-third-party-sources.json`）。",
    "> `devDependencies` 不随包分发，故未列入。",
    "> 法律声明与商标信息见同目录的 `NOTICE`；本包的整体许可为 Apache-2.0（见 `LICENSE`）。",
    "",
    "## 1. 范围与来源",
    "",
    "| 类别 | 是否随本包分发 | 说明 |",
    "|---|---|---|",
    "| `haruyuki.js` / `dist/**` 内联的 npm 依赖 | 是 | 单文件打包把生产依赖内联进产物，见 `build.js` 的 `external` 白名单 |",
    "| `src/skills/builtin/self-configuration/LICENSE` | 是 | 上游随技能附带的 MIT 文本（Copyright (c) 2026 Letta, Inc.），原样保留 |",
    "| 非 npm 来源的第三方表达（`src/agent/prompts/source_*.md`） | 是 | 为基准对照收录的外部系统提示词，见 §3 |",
    "| `node_modules` 中的 `devDependencies` | 否 | 仅开发期使用，不进入发布产物 |",
    "",
    "许可证原文一律**逐字保留英文原文**，不作翻译或改写。",
    "",
  ];

  const upstream = packages.filter((entry) => entry.name.startsWith("@letta-ai/"));
  const notices = packages.filter(
    (entry) => entry.notices && entry.notices.length > 0,
  );

  const body = [
    ...renderDependencies(packages),
    ...renderNonNpmSources(),
    "## 4. 依赖闭包中的上游包",
    "",
  ];

  if (upstream.length > 0) {
    body.push(
      "以下包由 Letta, Inc. 作为**独立 npm 包**发布，本项目的依赖闭包会安装它们（未内联进 `haruyuki.js`）：",
      "",
      ...upstream.map((entry) => `- \`${entry.name}@${entry.version}\` — ${entry.license}`),
      "",
      "它们的资产（包括上游自己的品牌图片与截图）由各自的发布者分发，**不属于本项目的分发物**；",
      "本项目不复制、不重新打包这些资产，`npm pack` 的清单里也不含它们。",
      "",
    );
  } else {
    body.push("闭包内没有 `@letta-ai/*` 包。", "");
  }

  body.push("## 5. NOTICE 文件扫描（Apache-2.0 §4(d)）", "");
  if (notices.length > 0) {
    body.push(
      "Apache-2.0 要求：若被分发的第三方包里带有 `NOTICE` 文件，其内容也必须随本包传递。本闭包中命中：",
      "",
    );
    for (const entry of notices) {
      const file = path.join(packageDir(entry.name), entry.notices[0]);
      body.push(
        `### ${entry.name}@${entry.version}`,
        "",
        "```text",
        fs.readFileSync(file, "utf8").trim(),
        "```",
        "",
      );
    }
  } else {
    body.push(
      "闭包内**没有任何包附带 `NOTICE` 文件**，因此本次分发没有需要向下传递的第三方 NOTICE 声明。",
      "",
    );
  }

  body.push("## 7. 已知缺口", "");
  if (missing.length > 0) {
    body.push(
      `以下包在本地 \`node_modules\` 中不存在，无法读取许可原文：${missing
        .map((name) => `\`${name}\``)
        .join("、")}。`,
      "",
    );
  } else {
    body.push("无。闭包内所有包都已解析到 `node_modules` 中的实体。", "");
  }
  body.push(
    "部分包只在自己的 `package.json` 里声明 `license`、不附带许可文件。上表已按声明登记；",
    "如需更完整的信息，请查阅对应包的发布页。若你发现遗漏或错误，请以该包自身附带的许可文本为准。",
    "",
  );

  fs.writeFileSync(OUTPUT, [...header, ...body].join("\n"), "utf8");
  const size = fs.statSync(OUTPUT).size;
  console.log(
    `wrote ${path.relative(ROOT, OUTPUT)}: ${packages.length} packages, ${(
      size / 1024
    ).toFixed(1)} KB`,
  );
}

main();

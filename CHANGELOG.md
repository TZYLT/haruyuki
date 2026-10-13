# 变更日志

> **本文件记录 Haruyuki 自己的版本变化**，从分家后的第一个自有版本号开始，**并保留分家前的 `-better` 谱系**（见文末）。
> 格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
>
> **来源**：各版本条目由 `git log` 的 conventional commits 回溯整理（`feat` → 新增、`fix` → 修复、`perf` → 性能、`refactor`/`chore` → 变更、`docs` → 文档）。
> 分家前的条目只记 **fork 自己的改动**；上游 `letta-code` 的历史不在此重复。
> **版本号谱系说明**：本 fork 早期使用 `0.35.0-better` … `0.36.2-better` 命名；分家后**重起为 `0.1.0`**（见 `0.1.0` 条目）。
> 因此语义化排序上 `0.36.x-better` 早于 `0.1.0`，这是**刻意的重编号**，不是版本回退。

## [0.2.1] - 2026-10-13

### 新增
- `package.json` 补 `keywords`：此前为空数组，导致在 npm 上按任何关键词都搜不到本包。
- 本文件 `CHANGELOG.md`。
- `.node-version`（`22.19.0`）：此前只有 `engines.node` 声明，用错 Node 版本的贡献者得到的是**运行时**错误，
  而不是安装期的版本提示。

### 变更
- `typescript` 由 `devDependencies` 改为 **`dependencies`**，并在 `build.js` 中标记 `external`。
  这是"构建产物不再内嵌构建机绝对路径"的代价：产物从 21.0 MiB 降到 13.6 MiB，但安装会多出 typescript 依赖（约 +14 MiB 解包）。README 已披露安装体积取舍。
- `package.json` 新增 `release:check` / `release:publish` 两个脚本别名，`CONTRIBUTING.md` 新增「发布流程」一节。
  此前发布步骤只活在 `scripts/release.mjs` 的源码里，而 `CONTRIBUTING.md` 那唯一一句还与脚本**不一致**
  （一处写"先 beta 后 latest"，脚本却 `npm publish --access public` 直发 `latest`）。现改为：
  `release:publish` **只发到 `beta`**，验证后再由人手动 `npm dist-tag add haruyuki@<版本> latest` ——
  脚本**不碰 `latest`**，因为"这个 beta 到底试过没有"它判定不了。
- 发版预检新增一项"构建产物真的能跑、且报的是当前版本"：执行 `node haruyuki.js --version` 并断言它等于
  `package.json` 的 `version`。`haruyuki.js` 里的版本号是**构建期内联**的，此前"bump 了但忘了重建"会一路
  发出去，现在会被预检拦下；该冒烟运行使用临时家目录，不触碰真实的 `~/.haruyuki`。

### 修复
- **构建产物泄漏构建机绝对路径**：`haruyuki@0.2.0` 的 `haruyuki.js` 内含
  `var __dirname = "<构建机仓库路径>/node_modules/typescript/lib"`。Bun 会把内联的 CommonJS 依赖包进
  `__commonJS` 并把 `__dirname`/`__filename` 内联为**构建机绝对路径**；现已通过"不内联"消除。
- **`files` 目录白名单会击穿 `.gitignore`**：`.npmignore`/`.gitignore` 都拦不住白名单目录内的文件，
  `scripts/.haruyuki/settings.local.json`（含家目录路径与本地 agent/会话 id）一度进入打包列表；
  现以 `files` 的 `!scripts/.haruyuki` 排除。
- `CONTRIBUTING.md` 不再记录本机盘符（该文件随包发布）。

### 移除
- `package.json` `files` 中两条冗余 glob（`dist/agent-presets-*.js`、`dist/agent-presets-*.js.map`）——
  同目录已有具名条目，这两条只会让发布预检每次都输出一条可忽略的 warning。
- `bin/letta.js`：它 spawn 的是本仓**既不构建也不发布**的 `letta-<platform>` 预编译二进制，而 `package.json`
  的 `bin` 指向 `haruyuki.js`、`files` 里从来没有 `bin/` —— 它只出现在源码克隆里，徒增"入口到底在哪"的误读。
  删除后 `AGENTS.md` 里描述它的那条 gotcha 一并移除。

### 发布闸门
- 新增 `scripts/check-build-leaks.mjs`：读取 `npm pack` 会发布的每个文本文件，拒绝"机器身份"串
  （构建机仓库根、Windows 用户目录、绝对 `node_modules`）与"本地状态"路径，接入 `scripts/release.mjs` 预检第 10 项。

## [0.2.0] - 2026-10-12

### 新增
- **被动召回**：每轮用户输入自动召回两个来源（过往会话转录、记忆库未进投影的文件），
  结果以 `<system-reminder>` 前置进本轮用户消息。含文本专用会话索引、查询端口与作用域装配、
  去重窗口、注入用户回合、三档显示、`/recall` 命令与 `recall` CLI 子命令、超时降级与熔断。
- 系统的冻结提示词补写三处解释（冻结前缀的应用点、话题标记的成因、召回的"缺失不是证据"）。

### 修复
- 召回：不再注入空片段；超时如实上报，缺失索引按 agent 熔断；**一条损坏会话不再拖垮整库**；
  显示档位与 `/reload` 同步；注入块在被裁剪时保持闭合、且不进入自动化回合；
  当前轮自己的注入在屏幕上可见；召回块在裁剪用户正文时保持完整；CLI 召回显式限定 agent 作用域。
- 搜索：按能够解析的范围读取转录并只计分一次；移除逐 token 的 CJK 切分（性能）。
- 其他：Windows 下测试运行器不再依赖 `PATH` 找 `bun`；随包发布的命令索引重新生成（此前漏了一条命令）。

## [0.1.3] - 2026-10-11

### 新增
- `hryk` 作为 `haruyuki` 的**等价短命令**（同一产物、同一数据、同一行为），`--help` 中提及短名。

### 变更
- 曾尝试以"转发包"方式让 `hryk` 可在 npm 上安装；registry 以 **403（名称过于相似）** 拒绝，
  该链路已移除。**后果**：`npm i -g haruyuki` 只提供 `haruyuki`，短名仅在源码检出与 tarball 内可用。

## [0.1.2] - 2026-10-11

### 变更
- 跟随仓库改名，同步身份信息与路径；忽略项目级 `.npmrc`。
- 无功能变化（该版本只有 `chore` 提交）。

## [0.1.1] - 2026-10-10

### 新增
- `haruyuki-guide` 的速查表索引改为**由命令树生成**（不再手写、不再漏命令）。
- `/compaction` 允许直接编辑压缩率。

### 修复
- 本地后端：agent 的 compaction 设置由"整体替换"改为**合并**。
- `sliding_window_percentage` 统一按**压缩率**语义读取（此前的反向归一化会把比率用反）。
- `/compact` 不再给出一个只会被拒绝的建议；话题边界行标注作者，并解释为何首行被锁定。
- `persona`/`human` 写入记忆库**实际使用的布局位置**。

## [0.1.0] - 2026-10-10

> 分家后的第一个自有版本号（此前为 `0.36.2-better`）。**未发布到 npm**（仅有 git tag）。

### 变更
- **重命名**（breaking）：包名与可执行文件名 `letta-code` → `haruyuki`；配置目录 `~/.letta` → `~/.haruyuki`；
  环境变量前缀 `LETTA_*` → `HARUYUKI_*`。
  **8 个与上游 SDK 契约绑定的名字刻意保留 `LETTA_` 前缀**（上游 SDK 自行读取它们，改名会静默失效）。
- 所有 harness 路径改由共享的 `app-paths` 模块**在调用时**解析，不再于 import 时冻结
  （此前 `HARUYUKI_HOME` 对部分调用点无效）。
- 单元测试改为**并行运行**（此前分块串行）。

### 新增
- 云出站护栏（`cloud-egress` 检查）并镜像进 pre-commit，阻止新增对 Letta Cloud 出站模块的 import。

### 重要性说明
这是"彻底分家"的版本：不合并上游、不 cherry-pick，云功能（Cloud 后端与登录、teleport、
远程电脑/环境路由、托管沙箱、云计划任务、共享记忆）整体移除。

## [0.36.2-better] - 2026-10-09

### 修复
- **停止把 `/feedback` 与错误上报发送到 `api.letta.com`**（改为只写本地日志）。
- 帮助与 flag 守卫只描述**仍然存在**的命令（此前仍在指向已删除的云命令）。
- 信息栏不再默认 Cloud 服务器 URL；移除 agent 选择器中的 Cloud/Shared 标签与其本地替身。
- 恢复 memory-git 凭据与回合后的记忆推送；恢复附加仓库的回合后推送。
- 远程设置缓存改为按其**来源文件**键控（不再跨文件串味）。
- 首启提示如何配置 provider；不再宣称一个本地存储并不执行的 provider key 校验。
- dev 模式在 Windows 可被 spawn，并接受显式指定的模型。

## [0.36.1-better] - 2026-10-05

### 修复
- 本地后端：会话级 `model_settings` 的补丁改为**合并**而非整体替换（否则会静默丢掉未提及的字段）。
- 测试：从隔离清单中移除已删除的遥测套件。

## [0.36.0-better] - 2026-10-04

### 变更
- **取消一切自动改写历史的路径**（轮前/轮后/溢出三条自动压缩链全部删除）；本地后端统一收敛到 `sliding_window`。

### 新增
- **话题裁切**：话题标记的写入端口与转录条目类型、`TopicMark` 工具（可按设置关闭）、
  `/topic` 标记命令、`/topics` 列出话题块、`/compact` 按用户选点修剪、
  上下文压力分级（ok / soft / hard）、过大回合发送前的话题修剪建议。
- 话题设置项（五个"话题通道"旋钮）；话题标记跨会话 fork 继承。

## [0.35.0-better] - 2026-10-03

> 本 fork 的第一个 `-better` 版本。代码历史承接上游 `letta-code`（根提交 `70ac7604`），**本节只记 fork 自己的改动**。

### 新增
- **前缀冻结**（M1–M4）：会话内不再重编译/尾插，停用自动重编译；冻结集合扩展与 fork 继承；
  `/context-pending` 查看待应用项；M4 payload 探针与断言脚本（D-008）。
- 前缀冻结**应用点**的护栏检查（`check:recompile-callsites`）与 V9/V11/V12/V13 验收（跨重启、降级、工具冻结、fork 继承）。

### 修复
- `/personality` 改为**登记**而非立即重编译；`agent.system` 变更不再清空冻结快照；
  `/context-pending` 的准确性、记忆可达性与 git 缓冲区的若干问题。

---

## 附注

- **registry 残留**：npm 上还存在一个 `haruyuki@0.0.0-stage`（早期占名产物），它不是可安装版本，不在本文件中单独列条目。
- **未发布到 npm 的版本**：`0.1.0` 与 `0.1.2` 有 git tag 但未发布（`0.1.2` 仅含 `chore` 提交）。
- **tag 与 Release**：`v0.1.0` … `v0.2.0` 以及分家前的 `v0.35.0-better` … `v0.36.2-better` 均存在于远端；
  各版本尚未逐一补写 GitHub Release notes。

# 变更日志

> **本文件记录 Haruyuki 自己的版本变化**，从分家后的第一个自有版本号开始，**并保留分家前的 `-better` 谱系**（见文末）。
> 格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
>
> **来源**：各版本条目由 `git log` 的 conventional commits 回溯整理（`feat` → 新增、`fix` → 修复、`perf` → 性能、`refactor`/`chore` → 变更、`docs` → 文档）。
> 分家前的条目只记 **fork 自己的改动**；上游 `letta-code` 的历史不在此重复。
> **版本号谱系说明**：本 fork 早期使用 `0.35.0-better` … `0.36.2-better` 命名；分家后**重起为 `0.1.0`**（见 `0.1.0` 条目）。
> 因此语义化排序上 `0.36.x-better` 早于 `0.1.0`，这是**刻意的重编号**，不是版本回退。

## [未发布]

> 计划随 **0.4.1** 发布。按 `CONTRIBUTING.md` 的发布流程，`[未发布]` → `[0.4.1]` 的改名与
> `package.json` 的 bump 一起落在发版提交里（还要重建 `haruyuki.js` 并核对两份 README 的版本字样）。
>
> 给后台隐藏会话一个只读入口：`/maintenance sessions` 能列、能看、能删单条。
> 它们仍然不进 `/resume`、`/search`、召回与普通列表，`include_hidden` 默认仍是 false。

### 新增

- **`/maintenance sessions`**：全屏隐藏会话查看器。列表只取 `hidden === true`（默认当前 agent，
  `a` 切全部 agent），三行行高、`/` 按摘要搜索、20 条一页；`Enter` 进只读详情，`d` 二次确认后
  物理删除单条。
- **详情按形态显示**：fork 默认只显示"最后一条继承消息 + 新增段"，顶部给出
  `origin · parent · N inherited hidden · M new`；独立会话（`context_mode = standalone`）显示全部；
  旧记录按时间戳推断边界，推断失败显示全部并标 `boundary unknown`，不猜测性隐藏。
  `Enter` 展开单条、`r` 切 reasoning。
- **会话形态字段**：`origin`、`parent_conversation_id`、`context_mode`、
  `inherited_message_count`、`inherited_through_message_id`。fork 时写入，旧记录读作 `unknown`，
  不做全库迁移。
- **删除能力**：本地后端 `deleteConversation`，按会话 id 物理删除记录、消息日志、编译快照、
  召回 sidecar 与会话级设置；先把目录移出 live 树再清内存，重启不复活；`default` 与普通会话拒绝。
- **协议**：`conversation_list` 接受 `include_hidden` / `hidden_only`，回传上述形态字段与
  `context_message_count`；新增 `conversation_delete`；`AppServerClient` 增加 `conversationDelete`。

### 变更

- `/maintenance` 的子命令表新增 `sessions`，摘要更新为 "feedback, background shells, workflows,
  GitHub app, hidden sessions"。
- `forkConversation` 现在写入形态字段；`/hidden-sessions` 是内部命令，只在全屏壳里打开，
  兼容壳给"需要全屏壳"的提示。

## [0.4.0] - 2026-10-25

> ⚠️ **这一版收拢命令入口，旧命令名不再执行。** 73 条平铺命令收成 8 个 hub（`/agent` `/session`
> `/memory` `/messages` `/skill` `/context` `/config` `/maintenance`），顶层只留 30 个名字。
> 输入旧名不报错，也不执行，而是回一句"已改为 `/x y`"；完整对照见
> [`docs/commands.zh-CN.md`](docs/commands.zh-CN.md)。
>
> 同一版还换了**首个 agent 的提示词**：新装的第一个 agent 是"陪伴版"——先问怎么称呼你，不先巡检目录。
> 提示词改动只作用于**新建的 agent**，已存在的 agent 前缀是冻结的，不会自己变。
>
> 按语义化版本，`0.4.0` 是预发布期的次版本号，承载不兼容变动：**命令名**。

### 变更（升级前先读这一条）

- **旧命令名不再执行**：43 个名字收进 hub 子命令（`/memfs` → `/memory memfs`、`/rename` →
  `/agent rename` 或 `/session rename`、`/topics` → `/topic list`、`/agents` → `/agent list`、
  `/context-limit` → `/context limit`、`/sleeptime` → `/memory config`、`/compaction` →
  `/compact config`、`/message-history` → `/messages history`、`/clear-messages` → `/messages clear`、
  `/logout` → `/session logout`、`/skill-creator` → `/skill skill-creator`、
  `/secret` → `/config secret`、`/mcp` → `/config mcp`、`/workflows` → `/maintenance workflows` …），
  8 个名字删除（`/chdir` `/reflection` `/set-max-context` `/profiles` `/link` `/unlink`
  `/conversations`）。脚本或肌肉记忆里写着旧名的改成新写法即可，语义不变，只是入口换了位置。
- **`/skills` 并入 `/skill`**：`/skill`（不带参数）与 `/skill list` 都列出可用技能。
- **保持顶层不变的**：`/close` `/exit` `/tabs` `/new` `/fork` `/btw` `/clear` `/compact` `/model`
  `/recall` `/reflect` `/dream` `/resume` `/search` `/reload` `/recompile` `/help` `/doctor`
  `/usage` `/settings` `/cd` `/topic`。
- **desktop 的 `execute_command` 不受影响**：那是协议里的 wire id，不是 slash 命令名，
  公告列表一条没动（`set-max-context` 仍作为未公告的兼容 case 保留）。

### 新增

- **命令 hub 面**：8 个 hub、44 条子命令，未知子命令回一张子命令表而不是静默失败；
  旧名由同一张表回答"改成了什么"。hub 名不能再被 mod 命令占用。
- **`/agent profile`**：本地 agent 档案的 `save`/`load`/`delete`/`usage` 本来有实现，
  却从来没有登记过入口，这次补上（`/profile` 旧名收进 hub）。
- **`/topic list [--all]`**：列话题块并入 `/topic`，不再需要一个平行的 `/topics`。
- **首个 agent 是陪伴版**：`fresh-start` 从 `tutorial` 改为 `memo`，并带上首次见面的
  引导（先问怎么称呼你，不承诺做不到的事，不先扫目录）。
- **`coding` 预设**：把改写前的陪伴版文案原样保存成预设，做工程活时可以显式选回那套语气。
- **memFS 提示词三处**：召回块只是**样本**不是清单；记忆**尽快写**而不是攒到最后；
  **打招呼不等于允许巡检整个工作区**。
- **参考索引多一张 Hub subcommands 表**：由 `hubs.ts` 直接生成，文档不可能写出构建里没有的子命令。

### 修复

- **`chalk` 从来没有被声明成依赖**：源码只用它的类型，解析一直靠 ink 的 5.6.2 被提升到根目录。
  一次干净的 `bun install --frozen-lockfile` 会把 4.1.2 放到根上，`tsc` 随即报
  `has no exported member 'ChalkInstance'`——全新 clone 会踩到、本地工作区反而不会。
- **`/profile` 的命令漂移**：有 handler 没有 registry 条目，自动补全与帮助里都看不到它。
- **`/cd` 不再自称 `/chdir` 的别名**：那个名字已经删除，帮助文本与解析器都只认 `/cd`。

### 已知限制

- **子命令补全没有做**：输入 `/agent` 后按空格，补全框会收起而不是列出子命令
  （`extractSearchQuery` 在第一处空格结束匹配）。hub 本身的发现靠 `/help`、`/agent` 回车、
  以及命令手册。
- **聊天渠道的命令面没有跟着改名**：Slack/Telegram 侧 `/feedback`、`/reflection`、`/cancel`
  是另一套入口，本轮不动。

## [0.3.1] - 2026-10-24

> **修复 TUI 已知问题。** 2026-10-23 的 TUI 修复批：13 项（7 修复 ＋ 4 功能 ＋ 2 项项目/纪律）。逐项台账见内部《40》。
> 2026-10-24 追加一轮（4 项）：重启后的用户消息失真、任务通知行测算造成的顶部空白、用量页单词自切换、全屏壳光标高一行。

### 修复

- **重启后的用户消息**：被动召回的提醒块会引用早先的消息，其中可能包含后台任务通知；通知提取器读到了引用内部的
  `<task-notification>`，把引用块后半、`</system-reminder>` 和用户这一轮自己写的话一起删掉，重启后整条用户消息显示成
  reminder 原文，并在上方多出一条"后台命令完成"事件行。提取器现在只认提醒块**之外**的通知。
- **转录区顶部空白**：行模型在 `HARUYUKI_DEBUG=1` 下把"任务通知完成"事件按压缩摘要的正文计行（模型 7 行、实画 3 行），
  视口因此少画 4 行、空白落在带子顶部；现在按 `EventMessage` 的实画计（`columns - 2` 里的一行 summary）。
- **输入框光标位置**：全屏壳的帧高等于终端行数，Ink 写这种帧时**不补尾部换行**，而它的光标锚点按"补了换行"算，
  于是整帧光标高一行（输入法候选窗在文字上方）。现在测量时识别这种帧并补一行。
- **输入折行**：全屏壳里用户消息按**转录带宽度**换行，不再因为按整终端宽度预排版而被截成省略号（侧栏打开时最明显）。
- **控制台字体**：win conhost 下"调用工具/轮结束变最小号点阵"的根因是**启动 Windows PowerShell 5.1 会重置控制台字体**；
  两处修复：进程启动时间查询改为不共享控制台（`windowsHide`），且字体守护**在 Node 下也能工作**
  （常驻 PowerShell helper attach 到同一控制台；此前守护只在 Bun 下启动，发布产物 `node haruyuki.js` 从未生效）。
- **模糊宽度**：显示侧的行宽/截断改用终端实际列宽（East Asian Ambiguous 字符按终端答案计），页面与状态行的右边界不再漂移。
- **未读徽章**：底栏 `未读 N` 可点击（打开消息历史即清零），并写明快捷键 `ctrl+x h`；不再"出现后永不消失"。
- **窄终端**：顶栏在比当前标签还窄的终端里改为截断标签而不是画出超宽行（超宽行会让 Ink 折行、把帧撑出屏幕）。
- **发布自检**：`release:publish` 不再把"版本来不及在 registry 可见"报成失败；发布成功固定 exit 0，
  并且始终打印 promote 步骤（此前 `fail()` 会吞掉它）。
- **侧栏 Usage 的 `out`**：原先把 cache 填充（输入价格）当输出显示，现读今日 output tokens。

### 新增

- **输入法光标**：终端真实光标落在输入框的光标格上（Ink 7 的 `useCursor`），输入法候选窗不再跑到终端末尾；中文/折行时按显示列计。
- **用量页点词切屏**：顶部只画当前屏名（`Usage / Overview`），点它切到另一屏，词本身随之变成 `Detail`；等价 `Tab`。
- **侧栏信息**：Turn 改为**当前用户轮**的 steps/时钟/tokens（新消息即清零）；Context 的 `sys` / `tools` 分两行；
  Usage 的 `hit`（带一位小数命中率）/ `miss` 分两行，`hit` 在上。

### 变更

- 概览页热力图右侧数据栏顺序：`total tokens`（与 `Last 4 weeks` 同行）／空行／`total cost`／`total turns`／`today cost`／`today turns`。
- `AGENTS.md` 新增 **Wiring exception**：接线时允许给已封顶文件少量增行，但必须记账或先问维护者（新行为仍须新建模块）。

## [0.3.0] - 2026-10-23

> ⚠️ **这一版换的是界面本身，不是配色。** 升级后默认进入**全屏外壳**：备用屏、顶栏页签、右侧信息栏、
> 底栏状态行。旧的**追加式**外壳仍然在，但要显式关掉新外壳才会用到它（见「变更」第一条）。
> agent 行为、记忆格式、配置目录与命令语义都没有变化。
>
> 按语义化版本，`0.3.0` 是预发布期（`0.x`）的**次版本号**，承载不兼容变动；本次不兼容点只有一条：
> **默认外壳**。其余都是新增面。

### 变更（升级前先读这一条）

- **默认外壳改为全屏**：实验开关 `ui_v2` 的默认值由关改为**开**。它在进程启动时一次性决定，
  所以切换要**下一次启动**才生效——顶栏、备用屏与页命令都挂在同一个判断上，当前会话里翻转不会立刻换壳
  （设置行尾的 `restart` 与选择器页脚都会提醒）。
- **回退有三种**，粒度从细到粗：① 会话里 `/experiments` 关掉 full-screen TUI；② 环境变量
  `HARUYUKI_UI_V2=0`（脚本、包装器用）；③ 整版回退 `npm install -g haruyuki@0.2.1`（配置、记忆与会话都在
  `~/.haruyuki`，不随版本号变化）。**已保存的开关值优先于环境变量**：曾选择器里关过的人，
  `HARUYUKI_UI_V2=1` 也打不回来。
- **旧外壳冻结**：命令集、键位、输出语义与 `0.2.1` 一致，不再增加新面，**不预设移除时间**。
  两壳的差异清单（哪些必须一致、哪些允许不同）钉在测试里，不是口头承诺。
- **渲染栈升级**：`ink 5.2.1` → **`ink 7.1.1`**、`react 18.2` → **`react 19.2`**。同时删掉整层
  vendor 字符串补丁——那层补丁靠精确替换 `node_modules/ink` 的源码工作，升级即失效；现在的行为改由
  Ink 7 的原生能力（备用屏、`usePaste`、Kitty 键盘协议、`<Static>` 身份重置）与本仓自有代码承担。

### 新增

- **全屏外壳**：备用屏 ＋ 顶栏（会话页签、`Settings`、`Usage`）＋ 右侧信息栏 ＋ 底栏状态行。
  退出时恢复原屏幕内容，不把界面残留写进滚动历史。
- **转录区重做**：行模型 ＋ 有界视口（每帧只量视口窗口，不量全部历史），千轮会话不卡；
  上滚时按消息 id **回源分页**，取上下文窗口之前的消息。
- **输入与键位**：键位注册表 ＋ 单入口 dispatcher ＋ 焦点所有权；leader 前缀；既有各面统一
  `PageUp`/`PageDown`/`Home`/`End`/`j`/`k` 语义，输入框与覆盖层不再互相抢键。
- **鼠标与复制**：滚轮、拖拽选择、反色高亮；复制走 OSC 52，带本地回退。**纯键盘可完成全部操作。**
- **覆盖层工具包**：41 个面迁到同一套容器（头部／标题／页脚、10 行窗口 ＋ `↑ N more`／`↓ N more`、
  真文本编辑器），顺带把一批"按键停在第一次渲染"的老问题从根上挪开。
- **`Settings` 页**：单页缩进树，约 40 项标量全可编辑；`requiresRestart` 的项标 `restart`。
- **`Usage` 页**：概览（块字、近 4 周热力图、成本与回合）＋ 明细（四档拆分、上下文成分、按模型、
  近 14 天）；新增**用量台账**持久化，`/usage` 改为切页。
- **toast 与消息历史**；**diff 面**分栏。
- **底栏状态行**：左侧常驻上下文用量 `84k/128k(66%)`，右侧 `agent · model`；切换权限模式时左侧
  临时显示 3 秒（如 `Accept edits (shift+tab)`），过后回到上下文用量。

### 修复

- **底栏的上下文用量此前永远不显示**：右列宽度预算被误当成整行宽度，左槽只剩 4 列，什么都画不下。
  现在左右各拿真实列数，且权限模式不再常驻抢占左侧。
- `/context` 加了 **1.5 秒硬截止**：远端不答时至少给出本地那部分，不再一直停在 `Fetching`。
- `/experiments` 此前打印"Opening experiments selector..."却什么都不打开；现在任何非 `diffs`
  参数都会打开选择器，`/experiments diffs` 语义不变。
- 转录回填会**静默丢掉已完成的命令行**；现在会把丢掉的条数写进调试日志，便于定位。

### 已知限制

- 旧外壳不接收新面：页签、侧栏、toast、状态行上下文用量只在全屏外壳里出现。
- tmux 里 OSC 8 链接不可用，默认面板会省略 URL。
- 窄终端（< 80 列或 < 26 行）右侧信息栏折叠；更窄时页签标签截断并显示 `+N`。

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

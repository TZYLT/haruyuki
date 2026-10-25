# 开发说明

> **English readers:** this document is Chinese only for now. In practice a capable LLM translates
> the change list below well enough to be useful; if anything is unclear, or you need a dependable
> answer, please open an issue or write to the author directly. Sorry for the inconvenience.
>
> **本文件既是内部开发纪律，也是对外公开的改动清单。** 本仓库**有意不配 CI**：`.github/` 只放治理文件
> （issue 模板 ＋ PR 模板），门禁＝pre-commit hook ＋ `bun run check` ＋ 发版预检；理由与"清洁环境验证"
> 的替代做法见 **§G**。
> 「纪律」一节是维护者自己的约束；下游读者关心的是 §相对上游的改动清单 —— 那里逐项记录了本分支与上游的差异。
>
> 定位：本项目自 letta-code **v0.34.2** 起与原项目**彻底分家**——不合并上游、不做 cherry-pick、新功能自研；
> **整洁清晰与最小改动同等重要**。安全修复与模型兼容完全自持。
>
> 本文件同时是**相对上游的改动清单**的唯一权威位置（README 只给概要，见 §相对上游的改动清单）。
>
> **AI 辅助披露**：本项目的代码与文档大量由 AI 辅助生成，由人类维护者审阅、裁决与验证。
> 对外声明与使用警告见 [README.md](README.md) 开头的 AIGC 段；每条改动仍须留下可核查的来源与验证记录（纪律 2）。

## 环境要求

- bun **1.3.14**（`engines` 要求 >= 1.3.2；**lockfile** 以 1.3.14 为基线）
- Node **>= 22.19.0**（`.node-version` 固定 **22.19.0**，认这个文件的工具会自动选版本）
- **构建要 Bun，运行只要 Node**：`package.json` 里的 `engines.bun` 是**非标准字段** ——
  npm 只理解 `engines.node`，所以这条约束**不会产生任何安装期提示或警告**，只有读了本节才知道。
- 本机现状：bun 1.3.14（npm 渠道安装）、Node v22.19.0
  （**不写盘符与安装目录**：本文件随包发布，具体路径属构建机信息）

## 常用命令

```bash
bun install --frozen-lockfile    # 安装依赖（无 postinstall 补丁步骤）
bun run dev                      # 从 TypeScript 源码直接运行（改完即生效）
bun run dev -- -p "Hello"        # 带参数运行

bun run check                    # 本地护栏（14 项）：循环依赖 / 分层边界 / 云外联 /
                                 # 导出风格 / 文件命名 / 文件体积 / 模块归属 /
                                 # 前缀冻结应用点 / 测试隔离 / 测试覆盖 /
                                 # skill frontmatter / 内置 skill 脚本 / biome / tsc
bun run build                    # 构建：根目录 haruyuki.js（已 gitignore）+ dist/app-server-client.*

bun run release:check            # 发版前的只读预检（＝ node scripts/release.mjs --check）
                                 # 离线加 --skip-network；完整步骤见 §发布流程

bun test <file>                  # 单文件单测
node scripts/run-unit-tests.cjs  # 全量单测（并行；HARUYUKI_TEST_PARALLEL=0 走串行）

# 生成物（改了就要重跑，勿手改产物）
node scripts/generate-third-party-notices.cjs   # → THIRD-PARTY-NOTICES.md
node scripts/generate-tutor-avatar.cjs          # → assets/tutor-profile.png
```

## 纪律

1. **AI 不推送**：所有 `git push` 由本人手动执行（AI 只做本地提交）。
2. **变更登记**：每条改动/删除记录「文件 + 原因 + 对应需求编号 + 替代方案」，
   **并追加到本文件的 §相对上游的改动清单**。
3. **护栏保留**：`bun run check` 必须全绿；如自研代码触及 `file-size` 上限，允许在
   `scripts/source-file-size-baseline.json` 中按需上调（不删护栏本身）。
4. **依赖策略**：依赖钉死精确版本；**不**用 `vendor/` ＋ 字符串补丁改上游行为
   （`vendor/` 与 `scripts/postinstall-patches.js` 已于 Ink 7 升级时删除，见 `AGENTS.md`
   「No Upstream Patching (Ink)」）。需要不同的行为时，改为**本仓自有的实现**或**显式的适配层**，
   不跟随上游升级也不改 `node_modules`。
5. **不接收上游补丁**：上游 release / 安全公告仅作参考，不做 cherry-pick。
6. **法务要件不可删**：`LICENSE`（含上游版权行与 Brand Assets Exclusion）与 `NOTICE` **原样保留**；
   `THIRD-PARTY-NOTICES.md` 是生成物，**改依赖后必须重跑**生成器。
   不得重新引入 Letta 的名称 / logo / wordmark / **图片** / **ASCII art**（品牌排除条款明文列举，
   注意**图案不在文字 grep 的扫描面内**），也不得把上游文档正文抄进本仓库。
7. **README 只放概要**：改动清单写在本文件，不写进 README。
8. **贡献许可**：向本仓提交的内容默认按 **Apache-2.0** 授权（与 `LICENSE` §5 同构）；**贡献者保留自己贡献的版权**；
   不接受与本许可冲突的附加条款。自有版权的声明范围见 `NOTICE` §1「Scope of the copyright claim」。
9. **`LICENSE` 不动**：它是上游分发文本，与上游 npm 包**逐字节相同**（哈希见 `NOTICE` §2）。
   想主张自有部分的版权 → 给你**从零新写**的文件加 SPDX 头或另附文件，**不要**改 `LICENSE`。
10. **AI 使用的溯源（也是版权举证）**：借助 AI 生成 / 大改时，在提交信息里记下**模型 + 关键提示要点 + 人工改动要点**。
    这是 `NOTICE` §1 版权主张的**证据基础**（证明"人类智力贡献"真实存在），同时也是"未逐字复制他人表达"的抗辩材料。
    与本仓已定的品牌/文档纪律（不得抄上游文档正文）配套使用。
11. **发布到 npm**：只走 **§发布流程** 那一套，**不在这里重复步骤**。硬前提由预检自动核对：
    包名 `haruyuki`、`publishConfig.access: public`、`prepublishOnly` 跑 `bun run build`、
    `LICENSE`/`NOTICE`/`THIRD-PARTY-NOTICES.md`/`README*`/`CONTRIBUTING.md` 都在 `files` 里，
    且打包列表里**内部规划文档为 0**、文件内容里**没有构建机路径**。

## 发布流程

> **谁执行**：维护者本人（纪律 1：AI 不推送；`publish` 与 `push` 同样由本人确认）。
> **一条命令的只读预检**：`bun run release:check`（＝ `node scripts/release.mjs --check`；离线加 `--skip-network`）。

1. **前置**：`bun run check` 14/14；受影响的定向测试跑过；**工作树干净** —— 预检对任何未提交改动**直接报红**
   （这是刻意的：发版应来自已提交状态）。
2. **写 `CHANGELOG.md`**：把顶部的 `[未发布]` 一节填成本次的内容（面向用户：改了什么、为什么）。
3. **bump 版本号（单独一个提交）**：
   - `package.json` 的 `version`；
   - `bun run build` —— **必须重建**：`haruyuki.js` 里的版本号是**构建期内联**的，不重建就会把旧版本号发出去。
     预检第 5 项会跑一次 `node haruyuki.js --version` 并断言它等于 `package.json` 的 `version`，漏掉重建会被拦下；
   - 两份 README 里**写死的** `--version` 字样与体积数字（`README.md` / `README.en.md` 都有）；
   - `README.md` 的版本变动清单里那一行：npm 标记 `-` → `+`；
   - `CHANGELOG.md` 的 `[未发布]` 更名为 `[x.y.z]`。
4. **打 tag**：`git tag -a v<x.y.z> -m "..."`。预检会核对 `HEAD` 上有 `v<version>` 这个 tag，
   没打就报 `HEAD is not tagged`。
5. **预检**：`bun run release:check`。必须 **0 failures**；剩下的 warnings 要能**逐条解释**
   （例如离线 `--skip-network` 会带来两条 "skipped"）。
6. **发布到 beta**：`bun run release:publish`（＝ `release.mjs --publish`）。它会跑预检 → 要求确认令牌
   → `npm publish --tag beta` → 验证 registry 上确实有这个版本且落在 `beta` 上。**它不碰 `latest`。**
7. **试过之后，手动 promote**：脚本**有意不做**这一步。
   ```bash
   npm install -g haruyuki@beta                 # 真的试一下
   npm dist-tag add haruyuki@<x.y.z> latest     # 满意了再把 latest 移过去
   ```
   **为什么这一步是手动的**：`latest` 是所有 `npm install -g haruyuki`（以及 `npx haruyuki`）拿到的版本，
   而 npm 的发布**不能撤回**（只能 `deprecate`）。先挂 `beta`，"发出去但有问题"的窗口里就只有显式装 beta 的人。
   而这个开关的触发条件是"**beta 到底试过没有**"——脚本判定不了，所以它和打 tag、`git push` 同级：**由人来做**。
   放进脚本只会把"publish 完顺手 promote"变成一条命令，beta 这个窗口就成了摆设。
   现状即证据：npm 上 `beta` 与 `latest` 现在同指 `0.2.0`（上一次走完这两步的结果）。
8. **推远端**：`git push` ＋ `git push --tags`（纪律 1：由本人执行；`release.mjs` **从不** push）。
9. **写 GitHub Release**：正文从 `CHANGELOG.md` 的对应小节取（改了什么 / 为什么），挂到该 tag 上。
   分家前的 4 个 `-better` tag 也各补一条，正文一句话说明"**分家前历史，不适用于当前版本序列**"——
   否则看 tag 列表的人会以为 `0.36.2` 比 `0.2` 新。

> **不 `unpublish`、不 `deprecate` 已发布的版本**：`0.2.0` 曾把构建机路径打进产物，处置是**只发下一个版本**
> （`0.2.1`），而不是撤回 —— 撤回会打断已经装过它的人。同一原则适用于以后任何一次出错。

## 架构与分层

详细的架构约束、模块归属与护栏说明见仓库根的 `AGENTS.md`（开发者指南，**不随 npm 包发布**）。

---

## 相对上游的改动清单

> **怎么用**：想知道"本分支到底和上游差在哪、为什么"，读这一节。
> 每一项都尽量给出**改了什么**与**为什么**；数字来自实测（详见仓库内的规划/施工文档，那些文档不入库）。
> 新增改动请**追加**，不要改写已登记的条目（历史取舍值得保留）。

### A. 移除的能力（云）

| 能力 | 处置 | 为什么 |
|---|---|---|
| Letta Cloud 后端、登录与云 agent | 整链移除 | 本 fork 只保留本地后端；留着云后端，"本地自持"就不成立 |
| `haruyuki setup`、`haruyuki backend cloud\|local` | 移除 | 无云可切，命令失去意义（L2 验收时还发现帮助文案仍在指向这些已删命令） |
| teleport（含入站协议与恢复路径） | 整链移除（41 文件 / +73 −3755，含 `teleport.ts` 538 行） | 云端功能，也是最大的入站面 |
| 远程电脑 / 环境路由（`computers`、`environments`、云 `--computer`） | 移除 | 依赖云端注册；删掉云中继后本机已无设备能注册成云环境 |
| 托管沙箱执行 | 移除 | 同上 |
| 云计划任务 | 移除 | `haruyuki cron` 是唯一调度器，且是本地实现 |
| 共享记忆（shared memory） | 命令与技能移除 | 云端共享机制 |
| `usage` **CLI 子命令**与配额自动切换（含设置项 `autoSwapOnQuotaLimit`） | 整链删净 | 配额属于云概念。交互式 `/usage`（本会话用量统计）**保留** |
| AgentFile（`.af`）导入导出 | 移除 | 依赖 agent registry；记忆与 transcript 的导入导出不受影响 |
| 桌面端 / 浏览器端入口 | 本分支不提供 | 保留**本地 app-server 协议**给兼容客户端（上游 LCD 是第三方产品，属刻意保留的指称对象） |
| 依赖云的内置技能：`managing-shared-memory`、`working-across-computers`、`submitting-feedback`、`image-generation` | 整技能删除 | 前两者本就在上游"本地 agent 不需要"的排除清单里；后者包装的是托管图像端点 |

### B. 出站链路

| 项 | 处置 | 为什么 |
|---|---|---|
| 遥测 | 4 个导出签名保留、内部改为写本地日志；无第三方上报 | 调用点改动 = 0，避免把遥测删除扩散成全仓改造 |
| `submitFeedbackMetadata` 上报（4 条上报面） | 改写入 `~/.haruyuki/logs/feedback.jsonl`，零出站 | 它对"非 Desktop-loopback"的**一切**运行都发用户内容 |
| 云外联护栏 | 新增检查项 `scripts/check-cloud-egress.js`（第 3 项） | 禁止非白名单模块 import 会发起云外联的模块；**过渡闭集 28 处按用户裁决冻结并单独立项** |

### C. 改名（对象 → 新值）

| 对象 | 旧 | 新 | 规模 |
|---|---|---|---|
| 包名 | `@letta-ai/letta-code` | `haruyuki` | 1 处 |
| 可执行文件 / bin | `letta` / `letta.js` | `haruyuki` / `haruyuki.js` | `build.js` ＋ `package.json` |
| 配置目录 | `~/.letta` | `~/.haruyuki` | 688 行 / 176 文件 |
| 环境变量前缀 | `LETTA_*` | `HARUYUKI_*` | 335 文件 / 2,013 处 |
| 品牌（自有源码里的 `Letta Code`） | `Letta Code` | `Haruyuki` | 327 文件 / +1537 −1346 → 自有源码命中 **0** |
| 命令名散文 | `letta <子命令>` | `haruyuki <子命令>` | 约 450 行（帮助全文 / 26 个 bundled `SKILL.md` / agent prompts / 渠道向导 / 测试断言） |
| 默认头像 | `assets/tutor-profile.png`（上游图） | 本分支自产的雪花标记（[生成器](scripts/generate-tutor-avatar.cjs)） | 512×512 |
| OAuth 回调页标记 | 上游 `LETTA` ASCII art | `❄ haruyuki` | `src/auth/openai-oauth.ts` |

**刻意保留旧前缀的 8 个环境变量**（`LETTA_CLI_PATH`、`LETTA_LOCAL_BACKEND_DIR`、`LETTA_MEMORY_DIR`、
`LETTA_TRANSCRIPT_ROOT`、`LETTA_SANDBOX`、`LETTA_API_KEY`、`LETTA_BASE_URL`、`LETTA_LOG`）：
运行时依赖的 `@letta-ai/letta-agent-sdk` **自己读这些名字**，只改我们这一侧会让它静默回落到自带副本，
并让记忆围栏从错误的名字计算可写根。**不要"顺手统一"**，细节见 `AGENTS.md`。

**三类刻意不改**（⑦/⑬ 的边界）：① 第三方指称（如 Letta Cloud Desktop / LCD）；② 线格式与落盘契约
（`ToolsetPreference` 的 `letta` id、`local:` 分桶键、`letta.memoryRepository.url` 等）；
③ 与上游共享的协议面。

### D. 机制改动与新增（自研）

| 机制 | 内容 |
|---|---|
| **前缀冻结** | 提示/工具/记忆/模型的改动不立即写入上下文前缀；`/context-pending` 查看待应用项，`/recompile` 显式应用；施加点契约由检查项 `check-recompile-callsites` 守住 |
| **话题裁切** | `/topic`、`/topics`、`/compact`：按话题边界裁上下文（含 `topicBoundaryRewindTurns` 等设置） |
| **后台反思** | 反思 agent 独立运行并整理记忆；`/reflect`、`/dream`、`/sleeptime` 控制触发；Windows 默认关闭自动反思 |
| **本地后端** | 单一后端模式（`--backend local`）：agent / 会话 / 记忆 / transcript 全在本机；MemFS 由 git 版本化 |
| **工具与配置面** | `haruyuki model` 同时识别 `HARUYUKI_*` 与裸环境名（与 `cron`/`messages`/`memory` 对齐）；`app-paths` 的路径**调用期解析**（禁止模块级 `const` 快照） |
| **测试工具** | 单测并行化：**~11–12 min → 162–180 s**（`HARUYUKI_TEST_PARALLEL` 可调，`=0` 走串行逃生舱） |
| **隐藏会话与维护入口（0.4.1）** | `/maintenance sessions`：只列 `hidden === true` 的会话（`hidden_only`），只读详情按"最后一条继承 + 新增段"显示、旧记录标 `boundary unknown`，`d` 二次确认后按会话 id 物理删除单条；会话记录新增 `origin`／`parent_conversation_id`／`context_mode`／`inherited_message_count`／`inherited_through_message_id`；协议补 `conversation_delete` 与 `conversation_list` 的 `include_hidden`／`hidden_only`。需求编号 `44-1`（内部文档）。**替代方案**：无——这些后台会话此前没有任何入口，也不提供批量回收／撤销／转正。未改 `AppView`、设置面与 `/resume` |

### E. 文档、品牌素材与法务（⑮ 批次）

| 项 | 处置 | 为什么 |
|---|---|---|
| `README.md` / `README.en.md` | 按**真实命令面**重写（中文主 ＋ 英文版），只放"特色/目标 ＋ 改动概要" | 原 README 是上游的，把已删除的云功能当卖点，并有 20 多条 `docs.letta.com` 外链 |
| `NOTICE` | 新增 | Apache-2.0 §4(b) 要求"已修改"声明；上游**没有** NOTICE |
| `THIRD-PARTY-NOTICES.md` | 新增（**生成物**） | `haruyuki.js` 内联了几乎全部生产依赖；MIT/BSD/ISC 要求随分发保留版权行与许可通知 |
| `vendor/ink{,-text-input}/LICENSE` | 补回**并入库** → **已于 Ink 7 升级时随 `vendor/` 一并退役** | **真缺口**（当时）：这两份被改过的 MIT 源码随包发布，却没有任何许可文本；两份 LICENSE 也曾漏 `git add`。**本轮退役**：TUI 升到 Ink 7 后不再 vendor/字符串补丁上游，改用 Ink 7 原生行为（kitty、paste、`<Static>` 身份重置、溢出、`log-update`）＋ 构建期 devtools 桩，`vendor/` 与 `scripts/postinstall-patches.js` 已删除，不再随包分发打补丁的第三方源码 |
| 上游文档正文 | **不镜像、不引用** | `docs.letta.com` 无任何授权声明；法务推理见仓库内的版权规避规划文档（该文档不入库） |
| `CONTRIBUTING.md` | 13 → **14** 项护栏 ＋ 纪律 6/7 | 原写"13 项"漏了 `cloud-egress` |
| `docs/examples/mods/README.md` | `~/.letta` → `~/.haruyuki` | ⑪-B 改名漏网；该文件**已跟踪且随包发布** |
| `.skills/adding-models/SKILL.md` | 云目录 `curl` → `haruyuki model list`；CI 步骤改为跑定向测试 | 本分支本地优先；且本仓**没有** `.github/` |
| 反馈渠道（4 份 agent prompts / `AgentInfoBar` / `/feedback` 说明 / tutorial 资源位） | 指向 `discord.gg/letta` 与 `letta-ai/letta-code/issues` → 本项目 issue tracker `github.com/TZYLT/haruyuki/issues` | 让用户去**上游**渠道反馈本分支的问题，既有运营成本，也把第三方指称用成了事实上的引流 |
| `package.json` `description` / `postinstall` echo、`image-resize.ts` 重装提示 | 去掉残留的 `Letta agents` / `letta:` / `@letta-ai/letta-code@latest` | 这几处是 npm 列表页与用户可见报错文案，属"自有源码命中 0"的表面（§C） |
| **代码形态**的上游品牌资产（⑯ 批次） | `AnimatedLogo.tsx` 的 14 帧 Letta logo → **空字符占位**（保留 `LOGO_WIDTH` 网格、`FRAME_SEQUENCE` 与 `staticLogoLines()` API）；`ExitStats.tsx` 三处字形 → 空占位（保留预留列）；`openai-oauth.ts` 回调页的拼字 `LETTA` → `❄ haruyuki`；`assets/tutor-profile.png` 换成自有生成图 | 品牌排除条款列举的是 `logo, wordmark, images, ASCII art`——**图案不在文字 grep 的扫描面内**（纪律 6 已警告）。①那一栏是"图片清干净了，代码形态的没清"：logo 图形按逐字节相同随启动界面渲染并打进 bundle |
| `scripts/generate-tutor-avatar.cjs` ＋ 替换头像 | **改为入库** | 生成器与替换图此前只在工作区 → `git clone` 拿到的是**上游 Letta 头像**，只有 `npm publish` 拿得到替换图；`NOTICE` 却已声明"已替换" |
| 三份外部系统提示词（`source_{claude,codex,gemini}.md`） | 来源与许可**登记到 `THIRD-PARTY-NOTICES.md` §4**；清单入库为 `scripts/non-npm-third-party-sources.json`（供生成器消费，含 SHA-256 便于核对） | 它们是 near-verbatim 收录、随每个构建分发（bundle 内可验），却是**非 npm 来源**：生成器只遍历依赖闭包，结构上扫不到。上游同样没附许可文本——**上游没做不等于再分发方免责** |
| 内联的 `marked` v15.0.4（`src/web/memory-viewer-template.txt`） | 补上 **MIT 许可正文**；**修正**：必须用 **JS 块注释** `/* */`，不能用 `<!-- -->` | 上游压缩构建只带版权行与 URL；MIT 要求版权行**与**许可正文一并随分发保留。它既不在 `node_modules` 也不在依赖闭包里，生成器同样扫不到。**踩过的坑**：那段声明落在 `<script>` **内部**，而 `<script>` 里的 `<!-- -->` 不是 JS 注释（Annex B 只认 `<!--`/`-->` 各自所在行）→ 中间正文被当 JS 解析 → `SyntaxError` → marked 整段不执行 → viewer 白屏。该模板**没有任何测试覆盖**，所以测试全绿而页面是坏的：**改这类内联资源必须做一次 JS 解析验证**（`new vm.Script(<script> 内容)`），不能只查标签配平 |
| 用户可见的 `Letta Cloud` / `Sign in with Letta` 文案 | 改为实际实现措辞（`the server` / `the connected server` / `the access token`） | `chatgpt-usage-service.ts` 16 处、`reflection-launcher.ts`、`connect-xai-oauth.ts`、`task.ts`；文案点名一个本分支不存在的产品，既有误导也暴露未声明的来源。**刻意不改**：8 个 `LETTA_*`、`api.letta.com`/`chat.letta.com` 落盘与存储键、线格式头（`X-Letta-*`）、`Symbol.for("@letta/...")`、`letta_code_*` 遥测标签（本地 sink、无出站出口） |
| `subagents/manager.ts` 系统提示词里的 `docs.letta.com/letta-code` 链接 | 删链接 | 同时违反"品牌"与"不引用上游文档"两条 |
| `persona_tutorial.mdx` 宣称的 bundled reference | 改为"该技能指向的本地参考材料"，并明确**材料缺失时要说出来而不是编内容** | guide 技能指向的 `docs/` 正文在本仓不存在（只有 `docs/examples/`），承诺落空 |

### F. 刻意**不**做的事

| 不做 | 原因 |
|---|---|
| 不改 `LICENSE` 一个字节 | §4(c) 要求保留上游版权行与归属声明；品牌排除条款必须原样在 |
| 不给源码文件逐个加"已修改"头 | §4(b) 只要求"醒目声明"，仓库级 `NOTICE` ＋ README 专节即通行做法（若逐个改头，2000+ 文件全是噪声 diff） |
| 不重命名那 8 个 `LETTA_*` 名 | 见 §C（会静默破坏 SDK 与记忆围栏） |
| 不合并上游 / 不 cherry-pick | 已分家；上游 release 仅供参考 |

### G. 打包与发布面的自有加固

> 不是"相对上游的功能差异"，而是**发布出去的东西不可撤回**，所以单列。每条都对应一次实测缺陷或一次机制验证。

| 改动 | 处置 | 为什么 |
|---|---|---|
| `typescript` 的位置 | 由 `devDependencies` 改为 **`dependencies`**，并在 `build.js` 标记 `external` | Bun 把内联的 CommonJS 依赖包进 `__commonJS`，会把**构建机绝对路径**烧进产物；`haruyuki@0.2.0` 因此泄漏了维护者的仓库路径。无声明式开关可用（`define` 对生成的垫片无效、`root` 只影响多入口命名，均已实测）。代价＝装机量约 +14 MiB 解包 / +2.75 MiB 下载，README 已披露 |
| `files` 增加 `!scripts/.haruyuki` | 取反排除 | **`files` 优先于 `.npmignore` 与 `.gitignore`**：白名单目录内的被忽略文件照样进包（三种情况实测）。`scripts/.haruyuki/settings.local.json` 因此一度进入打包列表，它含家目录路径与本地 agent/会话 id。`files` 支持取反（实测 4 种写法） |
| 新增 `scripts/check-build-leaks.mjs`，接入 `release.mjs` 第 10 项 | 发布**闸门**（阻断，不改产物） | 原有泄漏扫描是**路径级**（只拦 `^docs/\d`），看不见字节里的内容。该脚本扫"机器身份"（构建根、Windows 用户目录、绝对 `node_modules`）与"本地状态路径"，并刻意**只打机器身份**以免误伤产品自带的合法绝对路径（如 `C:\Program Files\...` 启动器回退） |
| **有意不配 CI** | 门禁＝pre-commit hook ＋ `bun run check` ＋ 发版预检；"清洁环境验证"改为**手工一次**：在空临时目录 `git clone <repo>` → `bun install --frozen-lockfile` → `bun run check` | 单人维护；默认工作方式是**直接在 `main` 上提交（含 WIP）再 push**，因此 `push` 触发的 workflow 会**长期标红** —— 那正是"红＝没人看"，比没有 CI 更伤。CI 唯一独有的收益是"全新检出仍通过"，而它一次临时 clone 就能覆盖；其余收益（他人 PR 的自动反馈）在可预见期内不成立（PR 少、多为熟人）。**若将来真有稳定的外部贡献，再重新裁定** |
| `SECURITY.md` / issue 模板 / PR 模板（`.github/`） | 治理文件，**零维护** | 此前没有安全报告渠道（只能开公开 issue）；提 bug 不给版本/平台/入口；PR 作者不知道 `bun run check` 是必须的。三者都是**一次性文件、不产生持续负担**，直接降低"收报告时要追问"的成本 —— 符合"方便他人贡献"的取舍 |
| **不做 `dependabot.yml`** | 依赖更新不由 bot 自动开 PR；安全告警改为**仓库设置里单独开启**（有仪表盘与通知，但不进 PR 流） | 它会**每周固定产生 PR**，对已是单人维护的项目是纯新增负担；与上一条"不给自己找事"同一取舍 |

---

## 竣工前的自检清单

1. `bun run check` = **14/14 PASS**；
2. 受影响的**行为测试**真跑过（`bun test <file>`；改 runner 时另跑一次 `HARUYUKI_TEST_PARALLEL=0`）；
3. `bun run build` 成功，且 `node .\haruyuki.js --version` 打印当前版本；
4. 改了**依赖** → 重跑 `scripts/generate-third-party-notices.cjs`；
5. 改了**素材/品牌面** → 确认没有引入 Letta 的名称/图片/ASCII art（**图案要人眼看**）；
6. 本清单已追加本轮的改动。

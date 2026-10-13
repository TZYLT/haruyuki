# 常用命令说明

> 本文以**源码与 CLI 自带帮助为准**整理（`haruyuki --help` 与 `haruyuki <子命令> --help`），
> 不是从上游文档抄来的。命令面随版本变化，以你手上的 `--help` 输出为最终依据。
>
> 标注说明：**`[隐藏]`** = 仍在注册表里可用但已从补全列表隐藏（多为别名或破坏性操作）。

---

## 一、入口与常用参数

### 四种启动方式

```bash
haruyuki                    # 交互 TUI：恢复本项目上次的会话
haruyuki --new              # 新建会话（保留 agent 记忆），用于并行开会话
haruyuki --resume           # 打开 agent 选择器，挑 agent / 会话
haruyuki --new-agent        # 直接新建 agent（跳过人格选择器）
haruyuki --agent <id>       # 打开指定 agent
```

### headless（无 TUI）

```bash
haruyuki -p "用一句话说明你自己"
haruyuki -p "..." --output-format json          # 带统计的 JSON（text / json / stream-json）
haruyuki -p "..." --input-format stream-json    # 从 stdin 读 JSON，双向通信
```

### 常用顶层参数

| 参数 | 作用 |
|---|---|
| `-h, --help` | 显示帮助并退出 |
| `-v, --version` | 打印版本 |
| `--info` | 显示当前目录、技能与已固定（pinned）的 agent |
| `-n, --name <name>` | 按名字恢复 agent（大小写不敏感） |
| `-m, --model <id>` | 指定模型 ID 或 handle，如 `opus-4.5`、`anthropic/claude-opus-4-5` |
| `-s, --system <id>` | 系统提示预设 |
| `--personality <name>` | 人格预设：`memo` / `tutorial` / `blank` / `linus` / `kawaii` / `claude` / `codex` |
| `--toolset <name>` | 工具集：`auto` / `letta` / `none` / `default` / `codex` |
| `--backend <mode>` | 后端模式，本分支只有 `local` |
| `--memfs` | 为该 agent 打开记忆文件系统 |
| `--ephemeral` | 跑在临时会话里，无 agent、无记忆 |
| `--stateless` | 用已有 agent 但不启用 / 不同步 MemFS |
| `--skill-sources <csv>` | 技能来源：`all,bundled,global,agent,project`（默认 `all`） |
| `--no-skills` / `--no-bundled-skills` / `--no-mods` | 分别关闭全部技能 / 仅内置技能 / 本地 mod |
| `--disable-memory-guard` | 关掉跨 agent 记忆守卫（`--` 谨慎：会允许访问**其他 agent** 的记忆目录） |

> **本地后端提示**：手动冒烟测试时先把 `LETTA_LOCAL_BACKEND_DIR` 指向临时目录，
> 否则会读写你真实的 `~/.haruyuki/lc-local-backend`。

---

## 二、CLI 子命令

### 记忆（`memory`）—— MemFS 的全部操作

```bash
haruyuki memory status   [--agent <id>]                      # 记忆仓状态
haruyuki memory diff     [--agent <id>]                      # 未提交的记忆改动
haruyuki memory resolve  [--agent <id>] --resolutions '<JSON>' # 解决记忆冲突
haruyuki memory backup   [--agent <id>]                      # 留一份快照
haruyuki memory backups  [--agent <id>]                      # 列出快照
haruyuki memory restore  --from <backup> --force [--agent <id>]  # 从快照恢复
haruyuki memory export   --agent <id> --out <dir>            # 导出整棵记忆树
haruyuki memory pull     [--agent <id>]                      # 从远端拉取
haruyuki memory tokens   [--memory-dir <path>] [--agent <id>] [--top <N>] \
                         [--format text|json] [--quiet]      # 估算核心记忆的 token 量
```

- 多数动作需要 `--agent <id>` 或环境变量 `HARUYUKI_AGENT_ID`，**输出为 JSON**。
- `tokens` 还接受 `--memory-dir` 或 `$MEMORY_DIR`；它只报数字，**判断"是否过大"由调用方决定**。
- 记忆是 **git 仓**：提交与推送请直接用 git 命令。
- **改记忆前先 `backup`** —— 这是最便宜的安全垫。

```bash
haruyuki memory backup --agent agent-123
haruyuki memory tokens --format json
```

### Agent（`agents`）

```bash
haruyuki agents list   [--name <名字> | --query <关键词> | --tags <a,b>]
                       [--match-all-tags] [--include-blocks] [--shared] [--limit <n>]
haruyuki agents create [--name <名字>] [--model <handle>] [--personality <预设>]
                       [--description <文本>] [--tags <a,b>] [--pinned]
```

- `list` 默认按**任一**标签匹配；`--match-all-tags` 改为要求全部匹配；默认最多 20 条。
- `create` 默认名字是 `Haruyuki`，会建一个 **memfs 已启用、persona.md 已预填**的 agent。
- **输出仅 JSON**。

### 模型（`model`，别名 `models`）

```bash
haruyuki model get [--default] [--agent <id> | --conversation <id>]
haruyuki model list [--byok | --hosted] [--structured-outputs]
haruyuki model set [handle] [--reasoning <level>] [--default] \
                   [--agent <id> | --conversation <id>]
```

| 动作 | 说明 |
|---|---|
| `get` | 显示当前生效的模型、上下文上限，以及打码后的 `model_settings` |
| `list` | 列出当前后端的模型、目录 ID、可用推理档位、结构化输出支持 |
| `set` | 选择模型 handle、目录 ID 或不歧义的别名 |

- 不带目标参数时，从当前会话推断 agent 与会话。
- **已持久化的会话**会拿到一条 override；`--default` 表示用 agent 默认值。
- 只改 `--reasoning` 时保留模型与其他设置；`set` **不会**中断正在跑的推理。
- **输出为 JSON**。

### 消息（`messages`）

```bash
haruyuki messages search --query <文本> [--mode vector|fts|hybrid] \
                         [--start-date <ISO>] [--end-date <ISO>] [--limit <n>] \
                         [--all-agents] [--agent <id>] [--conversation <id>]
haruyuki messages list  [--agent <id>] [--conversation <id>] \
                        [--after <msg-id>] [--before <msg-id>] \
                        [--order asc|desc] [--limit <n>] [--include-errors]
haruyuki messages transcript --conversation <id> [--agent <id>] \
                        [--limit <n>] [--max-pages <n>] [--include-errors] \
                        [--out <path>]
```

- 搜索模式默认：**本地是 `fts`**，Cloud 是 `hybrid`。
- `list` 默认最新在前（`desc`）、20 条；支持消息 ID 游标翻页。
- `transcript` 触达页数上限时输出里会带 `truncated=true`；`--out` 写文件。
- **输出为 JSON**。
- 想给**另一个 agent** 发消息：

```bash
haruyuki -p --from-agent <发送方id> --agent <目标id> "消息内容"
```

### 执行追踪（`steps`）

```bash
haruyuki steps trace --agent <agent-id> --step <step-id>
```

读取单步的元数据与可用的 provider trace。**本分支不支持本地 provider 的 trace。** 输出为 JSON。

### MCP（`mcp`）

```bash
haruyuki mcp list   [--agent <id>]
haruyuki mcp get    <server> [--agent <id>]
haruyuki mcp tools  [server] [--full] [--agent <id>]
haruyuki mcp schema <tool-name> [--agent <id>]
haruyuki mcp search <query> [--mode hybrid|vector|fts] [--limit <n>] [--agent <id>]
haruyuki mcp call   <tool-name> [--args '<json>' | --args-file <path|->] [--agent <id>]
```

- `tools` 输出的名字可直接喂给 `call`；`--full` 带完整 schema。
- `search` 默认 `hybrid`，`--limit` 取 1–100（默认 5）。
- `--args-file -` 表示从 stdin 读参数。
- **输出为 JSON**；服务端位置与各类内部 ID 不对外暴露。

### 本地 mod（`mods`）

```bash
haruyuki mods list    [--agent <id>]
haruyuki mods package <mod文件> --name <包名> [--out <dir>]
haruyuki mods update  <npm包规范 | git包规范>
haruyuki mods enable  <包规范>
haruyuki mods disable <包规范>
haruyuki mods remove  <包规范>
```

`--agent <id>` 会额外列出该 agent MemFS 目录里的 mod。

### 技能（`skills`）与安装（`install`）

```bash
haruyuki install <东西> [--agent <id> | -n <agent 名>] [--force]
haruyuki skills  list   [--agent <id> | -n <agent 名>]
haruyuki skills  delete <技能名> --agent <id>
```

`<东西>` 可以是下列任一来源：

| 写法 | 含义 |
|---|---|
| `npm:<包名>` | npm 上的 mod 包，如 `npm:@letta-ai/mod-plan-mode` |
| `git:github.com/o/r` / `https://github.com/o/r` | GitHub mod 包 |
| `./path/to/package` | 本地 mod 包（需有 `package.json#letta`） |
| `official/<路径>` | 官方可选技能，如 `official/finance/stocks` |
| `clawhub/<slug>` 或 `clawhub:<slug>` | ClawHub 注册表技能，可带 `@<版本>` |
| `https://…/SKILL.md` | 直接指向外部技能文件 |
| `owner/repo/path` | GitHub 仓库路径简写 |

`--force` 会替换同名技能。

### Provider 对接（`connect`）

```bash
haruyuki connect <provider> [options]
```

- 内置大量 provider，常见的有：`openai`、`anthropic`、`anthropic-oauth`、`openai-oauth`、
  `google`、`google-vertex`、`deepseek`、`xai`、`zai`、`kimi-coding`、`moonshotai`、
  `minimax`、`mistral`、`groq`、`cerebras`、`openrouter`、`together`、`fireworks`、
  `github-copilot`、`chatgpt`（别名 `codex`）、`ollama`、`lmstudio`、`llama-cpp`、
  `openai-compatible`、`amazon-bedrock` 等。
- 完整列表与每个 provider 的参数，跑 `haruyuki connect --help` 看。

```bash
haruyuki connect openai
haruyuki connect anthropic <api_key>
haruyuki connect openai-compatible --base-url http://localhost:8000/v1
haruyuki connect ollama --base-url http://192.168.1.50:11434/v1
haruyuki connect bedrock --method profile --profile <name> --region <region>
```

会话内也可以直接用 `/connect`。

### 密钥（`secret`）

```bash
haruyuki secret set KEY --env SOURCE_VAR   # 从环境变量取值
haruyuki secret set KEY --stdin            # 从 stdin 取值（推荐）
haruyuki secret set KEY VALUE              # 直接给值（会出现在 argv 里）
haruyuki secret list                       # 只列名字，永不回显值
haruyuki secret unset KEY                  # 别名：delete / remove / rm
```

- **优先用 `--env` 或 `--stdin`**：值不会进入 shell 历史、进程列表或 agent 上下文。

```bash
openssl rand -hex 32 | haruyuki secret set WEBHOOK_TOKEN --stdin
```

- `--env` 要传**变量名**而不是 `$NAME`——`$NAME` 会被 harness 先行替换，值就进了命令行参数。
- 正在跑的会话要到**下次启动**才读得到 CLI 侧的新密钥。

### 计划任务（`cron`）

```bash
haruyuki cron add --prompt <文本> --every <间隔> [options]   # 周期执行
haruyuki cron add --prompt <文本> --at <时间> [--once]      # 定时执行
haruyuki cron add --prompt <文本> --cron <5字段表达式>      # 原生 cron
haruyuki cron list [--agent <id>] [--conversation <id>]
haruyuki cron get <id|名字>
haruyuki cron runs --id <id> [--limit <n>]
haruyuki cron delete <id|名字>     # 别名 remove
haruyuki cron delete --all [--agent <id>]
```

- `--every` 接受 `5m` / `2h` / `1d` 这类间隔。
- `--at` 接受 `in 45m`、`3:00pm`，或带明确时区的 RFC 3339 时间戳。
- `--conversation` 省略或设 `new` = 每次新开会话；`self` = 当前会话；`default` = agent 默认会话。
- `cron` 是本分支**唯一**的调度器，且是本地实现。**输出为 JSON**。

### 外部渠道（`channels`）

```bash
haruyuki channels install <渠道>              # 装渠道运行时依赖
haruyuki channels configure <渠道>            # 交互式配置向导
haruyuki channels status                      # 配置 / 路由 / 配对状态
haruyuki channels route list  [--channel <ch>]
haruyuki channels route add   [options]
haruyuki channels route remove [options]
haruyuki channels bind [options]              # 仅 Slack：把应用绑到 agent
haruyuki channels pair [options]              # 批准配对并绑定 agent
```

**本地后端推荐流程**：

```bash
haruyuki channels install <渠道>
haruyuki channels configure <渠道>
haruyuki server --backend local --channels <渠道>
# 先给机器人发一条消息，拿到配对码
haruyuki channels pair --channel <渠道> --code <码> --agent <agent-id> --conversation default
```

- `route add/remove` 与 `pair` **只改文件，不会通知正在运行的 listener**——要么用
  ADE/桌面端的 `/channels` WS 命令，要么重启 server。
- 状态文件在 `~/.haruyuki/channels/<渠道>/`（`accounts.json`、`pairing.yaml`、`routing.json`）。
- **只有**要指向另一个自建服务时才设 `LETTA_BASE_URL`；`--backend local` **不要**设假的值。
- **输出为 JSON**。

### 本地服务（`server`，别名 `app-server`）

```bash
haruyuki server [options]
```

启动**纯本地**服务：接受 App Server 连接并提供消息渠道。它只绑定本地 WebSocket 端点，
**从不注册到、也不外呼**任何远程环境服务。

| 参数 | 作用 |
|---|---|
| `--listen [url]` | 接受 App Server 连接；省略 URL 则绑定一个可用的 loopback 端口 |
| `--channels <list>` | 要启用的渠道（逗号分隔，如 `telegram`） |
| `--install-channel-runtimes` | 启动前先装好所选渠道缺的运行时依赖 |
| `--openai-api` | 提供 OpenAI 兼容的 `/v1/models`、`/v1/chat/completions`、`/v1/responses`（每个 agent 即一个模型） |
| `--ws-auth <mode>` | 非 loopback 监听与带 Origin 的原生客户端的鉴权：`capability-token` 或 `signed-bearer-token` |
| `--ws-token-file` / `--ws-token-sha256` | capability token 的文件路径 / 其 SHA-256 摘要 |
| `--ws-shared-secret-file` `--ws-issuer` `--ws-audience` `--ws-max-clock-skew-seconds` | signed JWT bearer token 的校验参数 |

```bash
haruyuki server
haruyuki server --channels telegram --install-channel-runtimes
haruyuki server --listen ws://127.0.0.1:4500 --openai-api
```

### 本地后端迁移（`local-backend`）

```bash
haruyuki local-backend migrate-transcripts [--storage-dir <path>] [--dry-run]
```

把**未版本化**的实验性本地 transcript 迁到版本化的 pi-ai transcript 格式。
每个被转换的 `messages.jsonl` 都会**先备份**再替换。建议先加 `--dry-run` 看一眼。

### 轨迹（`trajectories`）

```bash
haruyuki trajectories export [--out <dir>] [--source <name>] [--root <source>:<path>] \
                             [--transcript <source>:<path>] [--deepagents <db>:<thread>] \
                             [--project <path>] [--json]
haruyuki trajectories detect [--json]
haruyuki trajectories list   [--out <dir>] [--source <name>] [--project <path>] [--json]
haruyuki trajectories view   <file|sessionId> [--out <dir>] [--tools] [--reasoning]
haruyuki trajectories search <关键词> [--out <dir>] [--source <name>] \
                             [--project <path>] [--role user|assistant] [--json]
```

把历史编码 agent 的会话规范化成一份 trajectory-v1 JSON 目录，供记忆 worker 复阅。
发现与规范化由 `@letta-ai/trajectory` 提供，因此它支持的每个 harness
（Claude Code、Codex、Hermes、Letta、OpenClaw、OpenHands、Deep Agents 及以后新增的）
都会自动包含。默认输出目录 `/tmp/letta-trajectories`。

---

## 三、会话内 slash 命令

> 下面按用途分组。`[隐藏]` 表示仍可用但不在补全列表里。

### 记忆与上下文（这是本分支的重点）

| 命令 | 作用 |
|---|---|
| `/init` | 初始化（或重新初始化）agent 记忆 |
| `/memory` | 查看 agent 记忆 |
| `/palace` | 在浏览器里打开记忆查看器 |
| `/memfs [enable\|disable\|sync\|reset]` | 管理文件系统记忆 |
| `/memory-repository <set\|unset\|status\|push> [url]` | 把记忆仓推送到额外的 git 远端 |
| `/topic <标题> [摘要]` | 在当前会话标记一个话题边界 |
| `/topics [--all]` | 列出当前上下文的话题块 |
| `/compact [n\|help]` | 在你选的话题边界裁掉较老的上下文 |
| `/context` | 查看上下文窗口占用 |
| `/context-limit [tokens] [--override]` | 设置或重置最大上下文窗口（`[隐藏]` 别名 `/set-max-context`） |
| `/context-pending [full]` | 查看已登记但**尚未应用**的前缀改动（记忆 / 系统提示 / 技能 / 工具 / 模型） |
| `/recompile` | 重新编译当前 agent + 会话 —— **会使缓存失效，增加开销** |
| `/compaction` | 压缩模式设置 |

### 反思（被动记忆）

| 命令 | 作用 |
|---|---|
| `/reflect [--recent N \| --conversation ID … \| --auto] [--instruction TEXT]` | 触发反思 |
| `/dream …` | `/reflect` 的别名 |
| `[隐藏] /reflection …` | 同上 |
| `/sleeptime` | 配置睡眠期反思的触发与合并设置 |

### 模型与工具面

| 命令 | 作用 |
|---|---|
| `/model` | 切换模型 |
| `/system` | 切换系统提示 |
| `/personality` | 切换人格 |
| `/toolset` | 切换工具集（取代旧的 `/link`、`/unlink`） |
| `[隐藏] /reasoning-tab [on\|off\|status]` | Tab 键切换推理档位 |
| `[隐藏] /link` `[隐藏] /unlink` | 已废弃，请用 `/toolset` |
| `/experiments` | 开关实验特性 |

### 技能、mod、MCP、密钥

| 命令 | 作用 |
|---|---|
| `/skills` | 浏览可用技能 |
| `/skill-creator [描述]` | 进入技能创建模式 |
| `/mods learn [memory-citations] [options] \| generate-env [请求]` | 运行 mod 学习目标 |
| `/hooks` | 管理 hooks 配置 |
| `/mcp` | 管理 MCP 服务（添加、OAuth 连接） |
| `/secret <set\|list\|unset> [key] [value]` | 管理 shell 命令可用的密钥 |
| `/install-github-app` | 在本仓库装 GitHub Action |

> `/install-github-app` 装的是**上游**的 `letta-ai/letta-code-action`，本分支没有对应产物。

### 会话与 agent 管理

| 命令 | 作用 |
|---|---|
| `/agents` | 浏览 agent（已固定 / Haruyuki / 全部） |
| `/new` | 新建会话（保留记忆） |
| `/fork` | 分叉当前会话 |
| `/btw <问题>` | 分叉会话并问一个旁支问题 |
| `/resume [conversation_id]` | 恢复历史会话 |
| `/pin [名字]` / `/unpin` | 固定 / 取消固定当前 agent |
| `[隐藏] /pinned` `[隐藏] /profiles` | 浏览已固定 agent |
| `/rename agent [名字] \| convo [名字]` | 重命名 agent 或会话 |
| `/description <文本>` | 更新 agent 描述 |
| `/subagents` | 管理自定义 subagent |
| `/clear` | 清空**上下文内**消息 |
| `[隐藏] /clear-messages` | 重置**全部** agent 消息（破坏性） |
| `/chdir <路径>` | 切换本 TUI 会话的工作目录（`[隐藏]` 别名 `/cd`） |

### 检索、诊断与用量

| 命令 | 作用 |
|---|---|
| `/search [查询]` | 跨全部 agent 搜索消息 |
| `/doctor [症状]` | 在当前会话里排查某个 agent 问题 |
| `/usage` | 本会话用量统计与余额 |
| `/bg` | 查看后台 shell 进程 |
| `/workflows` | 查看 workflow 运行、其 agent 与 token 用量 |
| `/feedback` | 把反馈写入**本地**日志（写 bug 请走 `github.com/TZYLT/haruyuki/issues`） |
| `/statusline [请求]` | 自定义底部状态栏 |
| `/title` | 配置终端窗口标题 |
| `/terminal` | 设置终端快捷键（`--revert` 撤销） |
| `/ade` | 在 ADE 里打开 agent |
| `[隐藏] /system-reminders [on\|off\|status]` | 显示 / 隐藏系统提醒 |
| `[隐藏] /stream` | 开关 token 流式输出 |
| `/reload` | 重载设置与本地 mod（**不会**重载 app 的 TypeScript 源码） |
| `/connect` | 对接 LLM API 密钥 |
| `/logout` | 清除已保存凭据并退出 |
| `/exit` | 退出会话 |
| `[隐藏] /help` | 显示可用命令 |

---

## 四、几个容易踩的点

1. **`--help` 是最终依据。** 本文按当前源码整理，命令面会变；有疑问就跑
   `haruyuki <子命令> --help`。
2. **`/recompile` 会花钱。** 它使前缀缓存失效。想看有什么待应用，先 `/context-pending`。
3. **改记忆前先 `haruyuki memory backup`。** 记忆是 git 仓，但快照比 `git reflog` 直观。
4. **密钥别走 argv。** `haruyuki secret set KEY VALUE` 会把值暴露在进程列表里，用 `--stdin`。
5. **`/reload` 救不了改源码。** 改了 app 的 TypeScript 文件必须重启进程；新增 slash 命令同理。
6. **`channels` 的改动不会自动生效。** `route add/remove`、`pair` 之后要重启 server 或用 WS 命令。
7. **`--disable-memory-guard` 是给单 agent 调试用的。** 它允许访问其他 agent 的记忆目录。

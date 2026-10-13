# 安全策略 / Security Policy

> **English summary**: a single-maintainer, local-first fork. Report vulnerabilities **privately**
> via GitHub Security Advisories (`Security` → `Report a vulnerability`) or by email to the address
> in `package.json`. Do **not** open a public issue. Every version before the latest is unsupported.
> Please read "已知的非漏洞" below before reporting — several documented design limits are not bugs.

---

## 1. 支持范围

| 版本 | 是否支持 |
|---|---|
| 最新发布版本（npm `latest`） | ✅ |
| 所有更早版本 | ❌（**不可撤回**：已发布的字节不会变，修复只会出现在新版本里） |

这是一个**单人维护**的 fork，没有专职安全响应。下表是**尽力而为**的期望，不是承诺。

## 2. 如何报告

**优先**：GitHub 的私下渠道 —— 仓库页 `Security` → `Report a vulnerability`
（**需要维护者在 Settings → Code security 中开启 Private vulnerability reporting**；
该入口不可用时，或你不确定它是否开启，请直接用下面这个地址）。

**备用（也是默认）**：邮件到 `package.json` 的 `author` 字段里的地址。

**请不要开公开 issue**。本项目的日志、记忆与凭据都在使用者本机；把复现细节写进公开 issue
等于把攻击面公开给所有人。

### 报告里请带上

- 受影响的**版本**（`haruyuki --version`）与**平台**；
- 是**哪一层**：CLI/TUI、headless、本地 app-server / listener、渠道（Slack/Telegram/Signal）、
  工具实现（尤其会执行命令或读写文件的那几个）、权限/沙箱；
- **最小复现**：确切命令或按键序列；能给出"我预期 X、实际 Y"最好；
- 如果你的机器上有沙箱（seatbelt / bwrap / Windows 受限令牌），说明**它当时是否生效**；
- 你打算**公开披露**的话，给个时间窗，我尽量配合。

### 期望响应

| 阶段 | 期望 |
|---|---|
| 首次确认收到 | 7 天内（尽力） |
| 评估结论（是/不是漏洞、影响面） | 14 天内（尽力） |
| 修复 | 视严重程度与改动面；本项目**不承诺 SLA** |

## 3. 本项目处理这类问题的既有做法（供参考）

- **出站链路是硬约束**：没有遥测、不上报错误、`/feedback` 只写本地日志。任何"把数据发出去"的
  改动都会被视为**回归**，而不是取舍。
- **发布有闸门**：`scripts/release.mjs` 的预检 ＋ `scripts/check-build-leaks.mjs` 会在发布前读取
  将要发布的每个文本文件，拒绝构建机路径与本地状态文件进入包。
- **供应链**：`haruyuki.js` 把绝大多数生产依赖内联进单文件，但依赖闭包仍在包内；
  因此依赖漏洞不会因为"打包了"而消失。若漏洞在**某个依赖**里，请一并说明上游是否已修、
  以及你是否验证过本 fork 反而不受影响。

## 4. 已知的非漏洞（**这些是设计限制，请不要当漏洞报**）

| 事项 | 为什么不是漏洞 |
|---|---|
| **Windows 上进程没有内核级文件系统沙箱** | 已在 README 的「平台与已知限制」披露：Windows 走受限令牌 + 临时 ACL + Job Object 的组合，不提供与 seatbelt / bwrap 等价的保证。**它不隔离同一个用户下的两个进程**，这是已知取舍 |
| **自动反思（reflection）默认关闭** | 默认配置决定，不是缺陷；`/reflect`、`/dream`、`/sleeptime` 可显式触发 |
| **本机日志包含你的提示词与路径** | 本地日志是**刻意**的（无遥测的代价）。`~/.haruyuki/logs/` 属于你，请自行保护该目录 |
| **记忆目录是一个 git 仓，可被推到你的远端** | 记忆即文件树是本项目的核心设计；推送到哪里由你配置 |
| **`haruyuki.js` 体积约 14 MB、安装约 44 MB** | 单文件内联依赖的必然代价，README 已披露 |
| **8 个 `LETTA_*` 环境变量名保留旧前缀** | 与上游 SDK 的契约绑定，改名会让 SDK 静默失效（见 `CONTRIBUTING.md` §C）。它们只影响本机路径与凭据读取，不产生出站调用 |
| **`0.2.0` 的包内含构建机绝对路径** | 已在下一个版本修掉（见 `CHANGELOG.md`）；它泄漏的是**维护者本人**的开发路径，不含使用者数据或凭据。**若你在旧版本里发现同一类问题，请报**——那说明修复有漏网 |
| **代码与文档大量由 AI 辅助生成** | 已在 README 开头与 `CONTRIBUTING.md` 声明；这是**已知前提**，不是漏洞。若你在其中发现具体的逻辑/安全缺陷，那才是漏洞 |

## 5. 报告之外的可操作建议

- 处理不可信内容时，尽量在**独立用户或独立机器**上运行（内核沙箱在 Windows 上不提供隔离保证）。
- 把 `HARUYUKI_HOME` 指到你想隔离的目录；它整体覆盖用户级 harness 根。
- 定期看 `~/.haruyuki/logs/`，确认没有你不预期的出站行为。

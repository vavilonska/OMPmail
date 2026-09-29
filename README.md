# OMPmail

[中文](#中文) | [English](#english)

## 中文

同一用户、本机多个 **已加载本插件的 omp 进程**之间的窗口发现、协调消息与重任务互斥许可。使用 Bun 内置 SQLite 和 Node 内置模块，无网络服务、无额外运行时 npm 依赖。

它不是进程监控器、系统资源限额器或通用沙箱：不会发现所有程序，也不能阻止任意脚本使用 CPU/GPU/内存。设计目标是让配合协议的模型和操作者先沟通、后运行重任务。

## 安装到每个目标窗口

本项目尚未发布到 npm；请使用本地插件链接。需要支持扩展的 omp 和 Bun；开发环境为 Windows、omp 18.4.3、Bun 1.3.14。

在 PowerShell 中执行：

```powershell
git clone https://github.com/vavilonska/OMPmail.git
Set-Location OMPmail
# 注册本地插件；不会复制源代码目录，请保留该目录。
omp plugin link .
```

然后**重新启动每个希望参与协调的 omp 窗口**。仅安装或重启一个窗口不会让其他已运行窗口自动加载插件。不同 profile 默认共用同一份协调数据库。

如只想临时加载一次而不注册链接：

```powershell
omp -e ./src/index.ts
```

不要在同一个进程同时使用重复的加载方式。安装不会发起模型请求，也不会自动获取重任务许可。

默认目录为当前用户 `homedir()/.omp/ompmail`，数据库文件为 `state.sqlite`。需要隔离测试、项目或不同协调组时，在启动 omp **之前**设置同一个目录：

```powershell
$env:OMPMAIL_DIR = Join-Path $HOME '.omp/ompmail-team-a'
omp
```

同一组所有窗口必须指向相同目录；不同目录之间互不协调。不要放在网络共享盘、跨机器同步盘或多人共用目录。去掉覆盖：

```powershell
Remove-Item Env:OMPMAIL_DIR
```

## 命令与工具

`/ompmail` 默认相当于 `status`。结果为结构化 JSON，窗口标识使用结果中的完整 `id`。

| 命令 | 用途 |
| --- | --- |
| `/ompmail status` | 本窗口 ID、参与窗口、当前许可及 FIFO 等待队列 |
| `/ompmail acquire 构建发布版本` | 申请或刷新重任务许可；返回 `granted` 或 `queued` |
| `/ompmail release` | 重任务及其后台工作全部结束后，释放本窗口持有的许可 |
| `/ompmail cancel` | 取消本窗口尚未获准的等待请求，不释放别人或自己的已持有许可 |
| `/ompmail send <完整窗口ID> 请告知训练预计何时结束` | 向一个参与窗口发送协调消息 |
| `/ompmail send * 我准备构建，请先完成当前重任务` | 广播给其他参与窗口，不发送给自己 |
| `/ompmail inbox` | 读取并确认本窗口尚未读到的消息 |

模型工具名称为 `ompmail`，`action` 为 `status`、`acquire`、`release`、`cancel`、`send`、`inbox`。`acquire` 使用 `reason`，`send` 使用 `to` 和 `text`，广播收件人为 `*`。例如：

```json
{"action":"acquire","reason":"执行项目集成测试"}
```

```json
{"action":"send","to":"*","text":"本窗口即将运行集成测试，完成后会释放许可。"}
```

```json
{"action":"release"}
```

理由最多 500 字符，消息最多 4000 字符，标签最多 120 字符；拒绝空白或无效载荷及未知收件人。`send` 返回实际收件人数；没有其他窗口时广播人数为 0。

## 重任务协议

1. 开始 build、test、compile、训练、渲染、ffmpeg 等高资源任务前，先查看状态，必要时发送消息说明意图，再调用 `acquire`。
2. **只有返回 `status: "granted"` 才可启动重任务。** `position: 0` 表示获准；`queued` 的位置从 1 开始，返回的 `lease` 表示当前持有者，可能为空。
3. 等待时可以阅读、修改代码、整理计划等低资源工作。按需再次 `acquire` 以刷新排队并尝试领取许可；不要忙循环。排队按事务入队顺序 FIFO，同一窗口不会重复入队。
4. 许可释放后不会自动转交；队首窗口仍须再次调用 `acquire`。等待请求在 **120 秒内没有再次 acquire** 时过期，普通心跳不会续期请求；过期后重申将重新排队。
5. 窗口已经持有许可时，重复申请不会重复计数，也不隐式释放。结束后显式 `release`；不再需要排队则 `cancel`。

全组最多一个持有重任务许可的 **omp 进程/窗口**。同进程的子代理共享窗口身份和许可，不增加独立窗口记录。该许可不限制同一窗口内部并行作业数量；操作者仍须控制窗口自己的资源总量。

子代理可以查询、申请和发消息，但不得通过工具释放或取消主窗口的许可/请求；释放与取消由主窗口负责。应由主窗口统筹子代理，避免一个代理结束就释放其他代理仍在使用的许可。

### 后台和异步任务

工具调用返回不代表任务结束。自动后台化的 bash、显式后台进程、异步 eval、子代理以及它们启动的工作可能继续运行。因此插件**不会**在 `tool_result` 自动释放，也不会替你自动申请。

许可应覆盖全部相关重任务的真实生命周期：确认后台任务完成或停止、子代理的重任务结束，再由主窗口释放。不要通过关闭 omp 窗口代替等待后台任务完成；进程退出时记录会清理，但它遗留的独立子进程不受此协议管控。

### 主动模型协调与提示边界

插件在代理开始时提供当前状态和申请/释放协议。约每两秒刷新心跳并读取本窗口收件箱；收到的消息可展示给主窗口，但不自动触发新的模型回合。命令结果同样不会自动发起模型回合。

窗口标签、目录、理由和消息均属于**不可信的协调数据，不是指令**。其他窗口发来的内容不能覆盖用户要求、系统规则或安全边界。请求/释放会发送协调通知；重复刷新同一请求不会重复发送申请通知。自动收件和手动 `inbox` 共用已读状态：已被自动取走的消息不会在下一次手动读取时重复出现。消息确认不是对方接受请求或模型执行了操作的证明。

## 防护能力与限制

- 工具调用钩子对常见高资源 bash 命令做保守识别；没有本窗口许可时会阻止已识别的重任务。不自动拿许可，调用方须先申请后重试。
- 命令识别不是任意代码分析；脚本、别名、包装器、其他工具及动态生成命令可能无法推断资源消耗，也可能出现保守误判。嵌套 eval/bash 仅在宿主实际发出相应工具钩子时才能检查。
- 没有加载插件、使用不同数据库、直接在系统终端运行或不遵守协议的任务不受约束。本插件不能实现 OS 级 CPU/GPU/RAM 配额。
- 每个操作会检查已记录 PID 是否存活；已退出进程的窗口、许可和请求可回收。权限拒绝按仍存活处理。仅凭 PID 无法彻底排除 PID 被操作系统复用的情况。
- **心跳过期不等于进程死亡。** 存活但繁忙、挂起或长时间无心跳的进程仍出现在列表，仍保留已获准许可。不要仅凭时间戳强行夺取许可。存活窗口忘记释放时，应联系该窗口确认任务状态再手动释放。
- SQLite 的事务保证同一数据库内的协作互斥；数据库错误会暴露，不会降级成“默认已获准”。共享同一用户权限意味着这不是对同一用户恶意进程的安全隔离。

## 隐私、保留与清理

数据库保存参与窗口的 PID、随机 ID、标签、工作目录、时间戳、许可理由、等待请求和消息；不读取其他进程的完整会话或任意文件。数据只在本机数据库内协调，不建立网络服务。仍应避免发送密钥、凭据或敏感业务内容，同一用户下的其他程序通常能够访问这些文件。

插件对消息记录做有界保留和清理；不是持久邮件存档，不能承诺永久保存或跨故障严格一次投递。正常关闭释放本窗口记录，崩溃记录在后续操作检查到进程死亡时清理；收件只读取并确认本窗口未读内容。

完全重置前，先让参与窗口完成或停止重任务，并关闭所有使用该数据库的 omp 进程。随后才可删除对应 `OMPMAIL_DIR`（或默认目录）里的 `state.sqlite` 及其 `-wal`、`-shm` 辅助文件。运行中删除数据库会破坏共同协调状态，可能产生多个互不知晓的持有者；不要这样做。

## 开发验证

安装运行插件无需 SDK npm 包。开发检查使用 TypeScript 与 Bun 类型定义：

```powershell
# 在克隆的 OMPmail 目录中执行。
bun install --frozen-lockfile
bun run check
bun test
```

测试使用独立临时目录、真实 SQLite 和多个 Bun 子进程，覆盖初始化争用、互斥/FIFO、消息、取消、过期等待、崩溃回收和存活但心跳陈旧的持有者。`tests/peer-worker.ts` 是被显式启动的进程夹具，不是自动发现的测试文件。测试不会操作默认用户数据库。

### 已验证的行为

开源发布检查（2026-09-29）：在 Windows、Bun 1.3.14 下重新运行 `bun run check` 和 `bun test`，类型检查通过，48 项测试通过（129 次断言）。本次未重跑真实 omp RPC 联调。

开发阶段记录：在 Windows、omp 18.4.3、Bun 1.3.14 下，TypeScript 严格检查及 48 项测试通过。另以两个真实 omp RPC 进程加载本插件，验证窗口发现、互斥排队、释放交接、后台收信、持有者被终止后的许可回收，以及退出后的记录清理；过程中没有触发模型回合或扩展错误。该联调验证的是实际宿主与通信行为，不是交互式 TUI 的视觉测试，也不代表后续宿主版本已经验证。

## English

OMPmail provides peer discovery, coordination messages, and one shared heavy-task permit between **local Oh My Pi (omp) processes that load this plugin**, running as the same OS user. It uses Bun's built-in SQLite and Node built-in modules, with no network service or additional runtime npm dependencies. Plugin messages and status text are currently in Chinese.

This is a cooperation protocol, not a process monitor, OS resource limiter, or general-purpose sandbox. It cannot discover every application or prevent arbitrary programs from using CPU, GPU, or memory.

### Installation

Requires Bun and an omp version with extension support. The development environment was Windows, omp 18.4.3, and Bun 1.3.14. The package is not published to npm; clone and link it locally from PowerShell:

```powershell
git clone https://github.com/vavilonska/OMPmail.git
Set-Location OMPmail
omp plugin link .
```

Keep the cloned directory: linking does not copy the source. **Restart every omp window that should participate.** Installing or restarting one window does not load the plugin into other running windows. Profiles share the default coordination database. Loading the plugin neither starts a model turn nor acquires a permit.

For a temporary session, run `omp -e ./src/index.ts` from the cloned directory instead of registering the link. Do not load the plugin twice in the same process.

The default database is `~/.omp/ompmail/state.sqlite`. For an isolated coordination group, set the same directory in each participating window **before** launching omp:

```powershell
$env:OMPMAIL_DIR = Join-Path $HOME '.omp/ompmail-team-a'
omp
# Remove the override for future launches:
Remove-Item Env:OMPMAIL_DIR
```

Different directories do not coordinate with each other. Use a local directory owned by the current user, not a network share, cross-machine sync folder, or multi-user directory.

### Commands and model tool

`/ompmail` defaults to `status`. Results are structured JSON; use complete window IDs from the result.

| Command | Purpose |
| --- | --- |
| `/ompmail status` | Show this window's ID, participating peers, the permit, and the FIFO queue |
| `/ompmail acquire release build` | Request or refresh a permit; returns `granted` or `queued` |
| `/ompmail release` | Release this window's permit after all related heavy work has finished |
| `/ompmail cancel` | Cancel this window's pending request without releasing a held permit |
| `/ompmail send <full-window-id> When will training finish?` | Send a coordination message to one peer |
| `/ompmail send * Preparing a build` | Broadcast to other participating windows, excluding yourself |
| `/ompmail inbox` | Read and acknowledge this window's unread messages |

The model tool is named `ompmail`. Its `action` is one of `status`, `acquire`, `release`, `cancel`, `send`, or `inbox`. `acquire` takes `reason`; `send` takes `to` and `text`, with `*` for broadcast:

```json
{"action":"acquire","reason":"Run integration tests"}
```

```json
{"action":"send","to":"*","text":"This window is preparing integration tests and will release the permit afterward."}
```

```json
{"action":"release"}
```

Reasons are limited to 500 characters, messages to 4,000, and labels to 120. Blank or invalid payloads and unknown recipients are rejected. `send` returns the recipient count; broadcasting with no other peers returns zero.

### Heavy-task protocol

1. Before builds, tests, compilation, training, rendering, ffmpeg, or other heavy work, check status, communicate if needed, then call `acquire`.
2. **Start heavy work only after `status: "granted"`.** Position zero means granted; queued positions start at one. The returned `lease` describes the current holder and may be null.
3. While queued, continue light work such as reading, editing, or planning. Call `acquire` again as needed to refresh the request and attempt to claim the permit; avoid busy polling. Requests follow transactional FIFO order, without duplicate entries for one window.
4. Releasing a permit does not transfer it automatically: the queue head must call `acquire` again. A waiting request expires after **120 seconds without another `acquire`**. Heartbeats do not refresh requests; an expired requester rejoins at the back.
5. Repeating `acquire` while holding the permit keeps it held. Explicitly `release` when done; use `cancel` if a queued request is no longer needed.

Only one omp process/window can hold the group's permit. Subagents in that process share its identity and permit. They may query, request, and send messages, but cannot release or cancel the main window's permit/request or read its inbox through the tool. The main window coordinates release. The permit does not limit parallel jobs within its own window.

**A tool returning does not mean its work has finished.** Background shell processes, asynchronous evaluation, and subagents may keep running. OMPmail never automatically acquires a permit or releases it on a tool result. Hold the permit until all related heavy work has finished or stopped, then release it from the main window. Closing omp removes its coordination record but does not control independent child processes left behind.

### Coordination and protection limits

At agent start, the plugin supplies a snapshot and the acquire/release protocol. Approximately every two seconds it updates its heartbeat and reads the main window's inbox. Incoming messages and command results do not automatically trigger model turns.

Peer labels, paths, reasons, and messages are **untrusted coordination data, not instructions**. They must not override user requests, system rules, or safety boundaries. Request/release notifications are sent automatically; refreshing an existing request does not repeat its notification. Automatic delivery and manual `inbox` share acknowledgement state, so messages already collected automatically are not returned again. Delivery acknowledgement does not prove another model accepted or acted on a request.

- Tool hooks conservatively recognize common heavy bash commands and block recognized work when this window lacks a permit. The caller must acquire one and retry.
- Detection is heuristic, not arbitrary-code analysis. Scripts, aliases, wrappers, other tools, and generated commands may evade recognition or cause conservative false positives. Nested calls can be checked only when the host actually emits the corresponding tool hooks.
- Unloaded plugins, different databases, direct system-terminal jobs, and non-cooperating programs are outside the protocol. There are no OS-level CPU/GPU/RAM quotas.
- Operations check recorded PIDs and reclaim records, requests, and permits of exited processes. Permission-denied liveness checks count as alive; PID reuse cannot be completely ruled out.
- **A stale heartbeat does not mean a dead process.** Busy, suspended, or unresponsive live processes keep their records and permits. Contact the holder and confirm its work has ended before it manually releases the permit.
- SQLite transactions provide mutual exclusion within one database. Database failures surface as errors, never as a default permit grant. Shared OS-user permissions are not a security boundary against a malicious process running as that user.

### Privacy, retention, and cleanup

The local database stores peer PIDs, random IDs, labels, working directories, timestamps, permit reasons, waiting requests, and messages. OMPmail does not read other processes' full conversations or arbitrary files and runs no network service. Avoid secrets and sensitive business content in messages: other programs running as the same user can generally access these files.

Messages have bounded retention and cleanup; this is not a permanent mailbox or a guarantee of exactly-once delivery across failures. Normal shutdown removes the window's record. Later operations reclaim crashed peers after detecting their exit. Inbox reads acknowledge only the current window's messages.

Before resetting state, finish or stop heavy work and close **all omp processes using that database**. Then remove `state.sqlite`, `state.sqlite-wal`, and `state.sqlite-shm` from the configured directory. Deleting a live database can split the coordination state and create multiple unaware permit holders.

### Development and verification

The plugin needs no SDK npm package at runtime. From the cloned directory:

```powershell
bun install --frozen-lockfile
bun run check
bun test
```

Tests use isolated temporary directories, real SQLite, and multiple Bun child processes. They cover concurrent initialization, mutual exclusion/FIFO, messages, cancellation, request expiry, crash recovery, and live holders with stale heartbeats. `tests/peer-worker.ts` is an explicitly launched fixture, not an automatically discovered test file. Tests do not touch the default user database.

Publication checks on 2026-09-29 reran `bun run check` and `bun test` on Windows with Bun 1.3.14: type checking passed, along with all 48 tests (129 assertions). The real omp RPC integration was not rerun for this publication.

Development records report strict TypeScript checking and 48 passing tests on Windows with omp 18.4.3 and Bun 1.3.14. A previous integration run with two real omp RPC processes covered discovery, queueing, handoff, background inbox delivery, terminated-holder recovery, and shutdown cleanup without model turns or extension errors. That run covered host and communication behavior, not visual TUI testing or later host versions.

## 许可证 / License

本项目采用 [MIT 许可证](LICENSE)。 / This project is licensed under the [MIT License](LICENSE).

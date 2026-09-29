# OMPmail

**Peer discovery, local messages, and dynamic resource coordination for parallel Oh My Pi windows.**

让多个 OMP 窗口发现彼此、协商 CPU／内存／GPU 份额，并行执行任务；竞争结束后恢复正常资源使用。

[安装](#安装到每个目标窗口) · [更新](#更新) · [卸载](#卸载) · [English setup](#installation) · [Download / 下载](https://github.com/vavilonska/OMPmail/releases/latest) · [MIT](LICENSE)

![OMPmail — conceptual workflow / 功能流程示意](docs/assets/overview.svg)

> Cooperative protocol; not an OS resource limiter. / 协作协议，不是系统资源限额器。

[中文](#中文) | [English](#english)

## 中文

同一用户、本机多个 **已加载本插件的 omp 进程**之间的窗口发现、协调消息与动态资源协商。使用 Bun 内置 SQLite 和 Node 内置模块，无网络服务、无额外运行时 npm 依赖。

目标是防止协作窗口把资源耗尽，**不是全局一次只能运行一个重任务**。插件不是进程监控器、系统资源限额器或通用沙箱，不能阻止任意程序使用 CPU/GPU/内存。

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

**从旧独占版本升级：** 先让所有旧窗口完成或停止后台重任务，再退出并统一重启。数据库协议升级到 v2；检测到任何仍存活的旧窗口时会明确拒绝升级，不会夺走旧许可或让两套协议并存。不要删除运行中的状态库绕过检查。源码更新不会热替换已加载的插件。

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

## 更新

以下步骤适用于上面的 **Git 克隆 + `omp plugin link .`** 安装方式：

1. 先让所有参与窗口完成或停止重任务，确认子代理与后台进程不再占用额度后释放资源，再关闭这些 omp 窗口。
2. 在**原先克隆的 OMPmail 目录**中更新源码：

   ```powershell
   git pull --ff-only
   ```

   如果有本地修改或分支分叉导致更新失败，先自行保存、提交或处理这些修改；不要用强制重置覆盖自己的代码。
3. 链接仍指向原目录时，不需要重新安装或再次 `link`。如果移动了源码目录，在新目录重新执行 `omp plugin link .`。
4. 重新启动全部参与窗口，执行 `/ompmail status` 检查是否正常加载。旧独占协议升级到资源协议时，必须遵守前面的统一退出／重启要求，不能混用新旧窗口。

本地链接的更新方式是更新源码，**不是 `omp plugin upgrade`**；该命令面向 marketplace 插件。日常更新不需要删除协调数据库，也不需要为了运行本插件安装开发依赖。

## 卸载

1. 先完成或停止所有相关任务，确认子代理和后台工作已结束，释放资源并关闭加载了本插件的窗口；不要靠卸载来停止后台进程。
2. 如果按本页的 `link` 方式安装，在 PowerShell 中执行：

   ```powershell
   omp plugin uninstall omp-mail
   omp plugin list
   ```

   包名是 **`omp-mail`**，不是仓库名 `OMPmail` 或命令名 `ompmail`。在列表中确认已移除；若原先使用了不同 profile 或安装范围，应在相同环境下操作。
3. 如果仅通过 `omp -e ./src/index.ts` 临时加载，后续启动时去掉该参数即可，无需卸载注册。如果还在启动脚本或配置中手工登记了扩展路径，也要移除对应条目。
4. 重新启动剩余工作窗口。未卸载的窗口仍受协议约束，已卸载的窗口不再参与协调；不要混用来绕过资源限制。

卸载插件与删除源码／协调数据是不同操作。需要彻底清理时，可在确认不再使用后删除克隆目录；**只有所有使用同一数据库的窗口都退出后**，才可按[隐私、保留与清理](#隐私保留与清理)删除对应状态数据库。不想清除数据则保留即可。

## 命令与工具

`/ompmail` 默认相当于 `status`。结果为结构化 JSON，窗口标识使用结果中的完整 `id`。

**命令补全：** 输入 `/ompmail ` 后按 Tab，可补全 `status`、`acquire`、`wait`、`release`、`cancel`、`send`、`inbox`，支持前缀筛选。`/ompmail send ` 提供 `*` 和其他参与窗口的名称／完整 ID；输入 ID 前缀也可补全。名单随约两秒心跳更新，不在按键路径访问数据库；进入消息正文或 `acquire` JSON 后不再改写输入。已运行的旧插件没有该回调，需要完成上面的统一升级后使用。

| 命令 | 用途 |
| --- | --- |
| `/ompmail status` | 窗口、机器预算、实际 `leases`、待协商请求、动态建议 `recommendations` |
| `/ompmail acquire <JSON>` | 申请／调整本窗口资源，JSON 包含 `reason`、`demand`，可选 `allocation` |
| `/ompmail wait` | 对已排队请求进行最多 30 秒的可取消等待，每 2 秒刷新并尝试领取资源 |
| `/ompmail release` | 所有相关重任务结束后释放本窗口额度 |
| `/ompmail cancel` | 取消待协商请求，不释放已持有额度 |
| `/ompmail send <完整窗口ID> <消息>` | 定向沟通资源需求和可调整时机 |
| `/ompmail send * <消息>` | 广播给其他窗口，不发送给自己 |
| `/ompmail inbox` | 读取并确认本窗口未读消息 |

模型工具为 `ompmail`，支持上述同名 `action`。首次 `acquire` 必须提供 `reason` 和 `demand`；已持有时可沿用原需求。三个资源维度均为非负整数：

- `cpu`：并行 CPU worker／逻辑处理器份额，不是百分比。
- `memoryMB`：预估峰值物理内存，单位 MiB，须计入子代理及后台任务。
- `gpu`：本机 GPU 计算和显存压力的**聚合协商百分比**（0–100）。它不是硬件探测结果或单卡显存字节配额；多卡／显存特殊需求还需消息协商，不使用 GPU 时填 0。

`minimum` 是真实可执行、无法继续压缩的下限；`preferred` 是任务正常高效执行所需的份额，不要把上一次竞争时的降额写成永久首选值。例如（数值应按任务与 `status.capacity` 调整）：

```json
{"action":"acquire","reason":"执行项目集成测试","demand":{"minimum":{"cpu":1,"memoryMB":512,"gpu":0},"preferred":{"cpu":8,"memoryMB":2048,"gpu":0}}}
```

等价命令是 `/ompmail acquire {"reason":"执行项目集成测试","demand":{"minimum":{"cpu":1,"memoryMB":512,"gpu":0},"preferred":{"cpu":8,"memoryMB":2048,"gpu":0}}}`。

```json
{"action":"send","to":"*","text":"本窗口可在当前批次完成后降低 worker 数，请协商峰值内存。"}
```

```json
{"action":"release"}
```

理由最多 500 字符，消息最多 4000 字符，标签最多 120 字符；拒绝空白或无效载荷及未知收件人。`send` 返回实际收件人数；没有其他窗口时广播人数为 0。

## 动态资源协议

1. 重任务前查看 `status`，根据**当前任务实际需要**申报 `minimum`／`preferred`，必要时互发消息协商。额度覆盖本窗口所有子代理、异步／后台任务的总占用。
2. **只有 `status: "granted"` 才能开始，并以返回的 `allocation` 为准。** 可以同时存在多个已获准窗口。没有资源冲突的请求不必等队首，等待列表不是全局 FIFO 锁。
3. `recommendations[].target` 是动态建议：优先保留运行任务的真实下限，再按等待顺序选出下限可容纳的并行批次，不冲突的资源可跳过队首；批次内剩余预算均分到首选值。空闲窗口不参与分配。暂时无法纳入的请求建议为 `null`，需继续协商或等待，不能因请求过多把本可并行的任务全部堵死。
4. **建议不是授权，也不代表资源已释放。** 运行者先实际降低 worker／批次并发等总占用，再通过 `acquire` 的 `allocation` 确认新额度。不能动态降额的进程等到安全批次边界再调整，禁止只改数据库而不改实际占用。
5. 已持有者不带 `allocation` 再申请时只会保留或增长，不会暗中降额。增长失败时旧额度继续有效，返回 `granted`、`updated: false` 和旧 `allocation`；不能把它误认为新额度获准。
6. 其他任务释放、取消、退出或等待请求过期后，建议重新计算。**每个重任务／安全批次边界重新查看并申请合适额度；只剩自己时可恢复到 `preferred`，不得继续机械沿用竞争时的旧限制。** 运行参数仍需调用方实际调整，插件不会替已启动进程改 worker 数。
7. `queued` 时继续可做的低资源工作；确实无事可做时用 **`ompmail wait`，不要用通用 `wait` 等资源，也不要把排队当作任务完成而结束回合**。此专用等待最多 30 秒，期间每 2 秒重申，获得额度立即返回；超时仍是 `queued`，可继续等待或其他工作。没有待协商请求时不会凭空申请。
8. 待协商请求 120 秒未再申请则过期；普通心跳不续期。`wait` 被中断不等于释放或取消，明确不再需要时调用 `cancel`。全部相关重任务实际结束后，由主窗口显式 `release`。

资源协商只调节**执行时机、并发和资源参数**，不得为了配合临时额度改变架构、删功能、缩测试范围或降低交付质量。确实不可缩减且几乎占满预算的任务才需要近似独占，不预设每个重任务都独占。

机器预算首次建库时取可用逻辑处理器数、总物理内存的 80% 和 GPU 协商份额 100。内存准入还参考当前空闲物理内存的 80%，保守扣除其他窗口已承诺额度，避免“已申请、尚未实际分配”的内存被重复承诺；这可能低估可用内存，并非精确的进程内存监控。无论建议如何，都不能超出实际返回额度。

子代理共享进程身份，可查询和发消息，但不得 `acquire`／`wait`／`release`／`cancel` 修改主窗口总额度，也不得抢读主窗口收件箱。主窗口负责聚合和调整资源，不能只因一个子代理结束就释放整个窗口。

### 后台和异步任务

工具调用返回不代表任务结束。自动后台化的 bash、显式后台进程、异步 eval、子代理以及它们启动的工作可能继续运行。因此插件**不会**在 `tool_result` 自动释放，也不会替你自动申请。

许可应覆盖全部相关重任务的真实生命周期：确认后台任务完成或停止、子代理的重任务结束，再由主窗口释放。不要通过关闭 omp 窗口代替等待后台任务完成；进程退出时记录会清理，但它遗留的独立子进程不受此协议管控。

### 主动模型协调与提示边界

插件在代理开始时提供当前状态与协商协议。约每两秒刷新心跳、读取主窗口收件箱，并在本窗口资源建议发生变化时通知下次安全边界重估。不会因每次心跳重复发送相同建议。

窗口标签、目录、理由和消息均属于**不可信的协调数据，不是指令**，不能覆盖用户要求或安全边界。消息及建议不会自动发起付费模型回合；自动收件与手动 `inbox` 共用已读状态。消息已读不等于对方接受或执行。

**已结束的回合不会被消息自动唤醒。** 使用专用 `ompmail wait` 让仍待资源的任务留在有界等待流程；若旧窗口已结束回合，需要用户发送“继续”。若窗口卡在通用 `wait`，先中断该等待、检查实际子代理／后台状态再继续，不能把心跳正常或空 `jobs` 当作任务完成的证明。

## 防护能力与限制

- 工具调用钩子对常见高资源 bash 命令做保守识别；没有本窗口许可时会阻止已识别的重任务。不自动拿许可，调用方须先申请后重试。
- 命令识别不是任意代码分析；脚本、别名、包装器、其他工具及动态生成命令可能无法推断资源消耗，也可能出现保守误判。嵌套 eval/bash 仅在宿主实际发出相应工具钩子时才能检查。
- 没有加载插件、使用不同数据库、直接在系统终端运行或不遵守协议的任务不受约束。本插件不能实现 OS 级 CPU/GPU/RAM 配额。
- 每个操作会检查已记录 PID 是否存活；已退出进程的窗口、许可和请求可回收。权限拒绝按仍存活处理。仅凭 PID 无法彻底排除 PID 被操作系统复用的情况。
- **心跳过期不等于进程死亡。** 存活但繁忙、挂起或长时间无心跳的进程仍出现在列表，仍保留已获准许可。不要仅凭时间戳强行夺取许可。存活窗口忘记释放时，应联系该窗口确认任务状态再手动释放。
- SQLite 事务保证同一数据库内资源分配不超过机器预算；数据库错误会暴露，不会降级为默认获准。它不强制 OS 实际占用，也不是同一用户恶意进程之间的安全隔离。

## 隐私、保留与清理

数据库保存参与窗口的 PID、随机 ID、标签、工作目录、时间戳、机器预算、资源需求、实际额度、等待请求和消息；不读取其他进程的完整会话或任意文件。数据只在本机数据库内协调，不建立网络服务。仍应避免发送密钥、凭据或敏感业务内容。

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

测试使用独立临时目录、真实 SQLite 和多个 Bun 子进程，覆盖并发准入、资源上限、降额确认、单窗口恢复、内存／GPU 冲突、消息、取消、过期等待、崩溃回收、陈旧心跳、主子代理边界和安全协议迁移。`tests/peer-worker.ts` 是显式启动的进程夹具，测试不会操作默认用户数据库。

2026-09-29 在 Windows、Bun 1.3.14、omp 18.4.3 上完成：`bun run check` 通过；`bun test` **64 项通过、0 失败、256 次断言**。两个真实 omp RPC 进程在独立临时数据库中验证 **单窗 16 CPU → 双窗各 8 CPU → 释放后恢复 16 CPU**，并验证专用 `wait`、释放及零模型回合／零扩展错误。另在真实 TUI 中观察 Tab 将 `/ompmail ` 补成 `status`，以及 `send` 的 ID 前缀补成完整窗口 ID。测试进程及临时适配器／数据库已清理。这些是协商与宿主接入验证，不代表 OS 级限额或任务进展监控。

## English

OMPmail provides peer discovery, local messages, and dynamic CPU/RAM/GPU coordination between **local Oh My Pi processes that load the plugin**, running as the same OS user. Multiple heavy tasks can run concurrently. It uses Bun's SQLite and Node built-ins, without a network service or additional runtime dependencies. Plugin messages are currently in Chinese.

This is a cooperation protocol, not a process monitor, OS resource limiter, or general-purpose sandbox. It cannot discover every application or prevent arbitrary programs from using CPU, GPU, or memory.

### Installation

Requires Bun and an omp version with extension support. The development environment was Windows, omp 18.4.3, and Bun 1.3.14. The package is not published to npm; clone and link it locally from PowerShell:

```powershell
git clone https://github.com/vavilonska/OMPmail.git
Set-Location OMPmail
omp plugin link .
```

Keep the cloned directory: linking does not copy the source. **Restart every omp window that should participate.** Installing or restarting one window does not load the plugin into other running windows. Profiles share the default coordination database. Loading the plugin neither starts a model turn nor acquires a permit.

Upgrading from the exclusive-permit version requires every old window to finish/stop its background work and exit before restarting. Schema v2 refuses migration while any old peer is alive. Do not delete a live database or mix protocols; already running windows do not hot-reload source changes.

For a temporary session, run `omp -e ./src/index.ts` from the cloned directory instead of registering the link. Do not load the plugin twice in the same process.

The default database is `~/.omp/ompmail/state.sqlite`. For an isolated coordination group, set the same directory in each participating window **before** launching omp:

```powershell
$env:OMPMAIL_DIR = Join-Path $HOME '.omp/ompmail-team-a'
omp
# Remove the override for future launches:
Remove-Item Env:OMPMAIL_DIR
```

Different directories do not coordinate with each other. Use a local directory owned by the current user, not a network share, cross-machine sync folder, or multi-user directory.

### Updating

For the **Git clone + `omp plugin link .`** installation above:

1. Finish or stop all related heavy work, including subagents and background processes. Release allocations, then close every participating omp window.
2. Run this in the **original OMPmail clone**:

   ```powershell
   git pull --ff-only
   ```

   If local changes or diverging branches prevent the update, preserve or resolve them first. Do not forcibly reset away your own changes.
3. No reinstall or relink is needed while the link points to the same directory. If you move the clone, run `omp plugin link .` from its new location.
4. Restart every participating window and check `/ompmail status`. Follow the coordinated shutdown/restart requirements above when migrating from the exclusive protocol; do not mix old and new windows.

Update linked source with Git, **not `omp plugin upgrade`**, which targets marketplace plugins. Routine updates do not require deleting coordination state or installing development dependencies just to run this plugin.

### Uninstalling

1. Finish or stop all related work, including subagents and background processes. Release allocations and close windows that loaded the plugin. Uninstalling does not stop background processes.
2. For the linked installation, run:

   ```powershell
   omp plugin uninstall omp-mail
   omp plugin list
   ```

   The package name is **`omp-mail`**, not the repository name `OMPmail` or slash-command name `ompmail`. Confirm removal in the list. Use the same profile/install scope as the original installation.
3. For temporary `omp -e ./src/index.ts` loading, omit that argument on future launches; there is no registration to uninstall. Remove any additional manually configured extension paths or startup-script arguments as well.
4. Restart remaining work windows. Uninstalled windows no longer participate in coordination; do not use a mixed setup to bypass resource limits.

Removing the plugin, deleting its source clone, and clearing coordination state are separate operations. Delete the clone only when no longer needed. Clear the database only **after every window using it has exited**, following [Privacy, retention, and cleanup](#privacy-retention-and-cleanup). Keeping the state is also fine.


### Commands and model tool

`/ompmail` defaults to `status`. Results are structured JSON; use complete window IDs from the result.

**Completion:** type `/ompmail ` and press Tab for prefix-filtered subcommands. `/ompmail send ` offers `*` and other peers' labels/full IDs, including ID-prefix completion. Candidates use the approximately two-second heartbeat cache, without database I/O while typing. Message bodies and acquire JSON are left untouched. Existing windows need the coordinated upgrade above to load the callback.

| Command | Purpose |
| --- | --- |
| `/ompmail status` | Peers, machine budget, actual allocations, pending requests, and recommendations |
| `/ompmail acquire <JSON>` | Request/adjust resources using `reason`, `demand`, and optional `allocation` |
| `/ompmail wait` | Cancellable resource wait, at most 30 seconds, retrying every 2 seconds |
| `/ompmail release` | Release after all related heavy work has actually ended |
| `/ompmail cancel` | Cancel a pending request, without releasing a held allocation |
| `/ompmail send <full-window-id> <message>` | Send a coordination message |
| `/ompmail send * <message>` | Broadcast to other participating windows |
| `/ompmail inbox` | Read and acknowledge unread messages |

The model tool is `ompmail` with the same action names. The first `acquire` requires `reason` and `demand`. Resource vectors use nonnegative integers: `cpu` is logical workers, `memoryMB` is peak RAM in MiB, and `gpu` is an aggregate negotiated percentage (0–100) accounting for compute and VRAM pressure. GPU shares are estimates, not device discovery or per-card VRAM enforcement; coordinate special/multi-GPU needs via messages.

`minimum` is the genuinely irreducible executable demand. `preferred` describes efficient normal operation, **not a permanently pinned reduced share**. Adjust example values to your actual task and `status.capacity`:

```json
{"action":"acquire","reason":"Run integration tests","demand":{"minimum":{"cpu":1,"memoryMB":512,"gpu":0},"preferred":{"cpu":8,"memoryMB":2048,"gpu":0}}}
```

```json
{"action":"send","to":"*","text":"I can reduce worker concurrency at the next safe batch boundary."}
```

```json
{"action":"release"}
```

Reasons are limited to 500 characters, messages to 4,000, and labels to 120. Blank or invalid payloads and unknown recipients are rejected. `send` returns the recipient count; broadcasting with no other peers returns zero.

### Dynamic resource protocol

1. Inspect status, declare real minimum/preferred demand, and communicate as needed. A window's allocation covers all its subagents and asynchronous/background jobs.
2. Start heavy work only after `status: "granted"`, within the **returned `allocation`**. Multiple windows may hold allocations. Non-conflicting requests need not wait behind an incompatible queue head.
3. Recommendations first retain running tasks' minima, then select a runnable cohort of pending requests in arrival order, skipping incompatible requests when independent resources fit. Remaining budget is shared up to preferred demand. Idle peers do not compete. Deferred requests have `target: null`; excess demand must not deadlock an otherwise runnable cohort.
4. A recommendation is **not permission or proof of reduced usage**. Actually reduce running usage before acknowledging a lower `allocation` via `acquire`. Never shrink the accounting while processes still consume the old resources.
5. An existing holder's `acquire` without `allocation` only preserves or grows its grant. A refused adjustment keeps the old grant and returns `granted`, `updated: false`, and the old allocation; it does not authorize growth.
6. Release, cancellation, request expiry, and peer exit recompute recommendations. Reevaluate at each heavy-task/safe-batch boundary. **When contention ends, reacquire up to `preferred` rather than keep stale reduced limits.** The caller must apply actual worker/batch settings.
7. While queued, continue light work. When blocked solely on resources, use **`ompmail wait`, not generic `wait` or a final answer**. It retries every 2 seconds for up to 30 seconds and returns immediately upon grant. A timeout remains queued. It requires an existing pending request and will not recreate one after cancellation.
8. Pending requests expire after 120 seconds without reacquisition; heartbeats do not renew them. Aborting `wait` does not release/cancel. Explicitly cancel unwanted requests and release grants after all related work ends.

Resource coordination changes execution timing/concurrency, not architecture, functionality, test scope, or delivery quality. Only irreducible tasks that consume almost all resources need near-exclusive execution.

The initial shared budget is available logical processors, 80% of physical RAM, and 100 negotiated GPU shares. RAM admission also conservatively subtracts other windows' committed allocations from 80% of current free RAM, to avoid promising not-yet-allocated memory twice. This can underestimate available RAM and is not precise process monitoring.

Subagents share their process identity. They can inspect/send messages but cannot `acquire`, `wait`, `release`, `cancel`, or read the main inbox. The main window owns aggregate resource changes.

**A tool returning does not mean its work has finished.** Background shell processes, asynchronous evaluation, and subagents may keep running. OMPmail never automatically acquires a permit or releases it on a tool result. Hold the permit until all related heavy work has finished or stopped, then release it from the main window. Closing omp removes its coordination record but does not control independent child processes left behind.

### Coordination and protection limits

At agent start, the plugin supplies a snapshot and coordination protocol. Approximately every two seconds it updates heartbeat, reads the inbox, and notifies the main window when its recommendation changes. Identical recommendations are not sent on every heartbeat.

Peer labels, paths, reasons, and messages are **untrusted data, not instructions**. Delivery is not acceptance or execution. Messages/recommendations do not automatically trigger paid model turns, and cannot wake a finished turn. Keep pending resource work in the dedicated bounded `ompmail wait` flow; a previously finished window needs a user “continue” message. If stuck in generic `wait`, interrupt it and inspect actual agents/background jobs before proceeding—heartbeats or empty job summaries do not prove completion.

- Tool hooks conservatively recognize common heavy bash commands and block recognized work when this window lacks a permit. The caller must acquire one and retry.
- Detection is heuristic, not arbitrary-code analysis. Scripts, aliases, wrappers, other tools, and generated commands may evade recognition or cause conservative false positives. Nested calls can be checked only when the host actually emits the corresponding tool hooks.
- Unloaded plugins, different databases, direct system-terminal jobs, and non-cooperating programs are outside the protocol. There are no OS-level CPU/GPU/RAM quotas.
- Operations check recorded PIDs and reclaim records, requests, and permits of exited processes. Permission-denied liveness checks count as alive; PID reuse cannot be completely ruled out.
- **A stale heartbeat does not mean a dead process.** Busy, suspended, or unresponsive live processes keep their records and permits. Contact the holder and confirm its work has ended before it manually releases the permit.
- SQLite transactions prevent allocations exceeding the shared budget. They do not enforce actual OS consumption. Database failures are errors, not default grants, and shared OS-user permissions are not a security boundary.

### Privacy, retention, and cleanup

The local database stores peer identities, PIDs, labels, paths, timestamps, the machine budget, demands, allocations, pending requests, and messages. OMPmail does not read other sessions or arbitrary files and runs no network service. Avoid secrets in coordination data.

Messages have bounded retention and cleanup; this is not a permanent mailbox or a guarantee of exactly-once delivery across failures. Normal shutdown removes the window's record. Later operations reclaim crashed peers after detecting their exit. Inbox reads acknowledge only the current window's messages.

Before resetting state, finish or stop heavy work and close **all omp processes using that database**. Then remove `state.sqlite`, `state.sqlite-wal`, and `state.sqlite-shm` from the configured directory. Deleting a live database can split the coordination state and create multiple unaware permit holders.

### Development and verification

The plugin needs no SDK npm package at runtime. From the cloned directory:

```powershell
bun install --frozen-lockfile
bun run check
bun test
```

Tests use isolated temporary directories, real SQLite, and multiple Bun child processes. They cover concurrent admission, limits, acknowledged reductions, single-window recovery, RAM/GPU contention, messaging, cancellation, expiry, crash recovery, stale heartbeats, parent/child boundaries, and safe protocol migration. They do not modify the default user database.

Verified on 2026-09-29 with Windows, Bun 1.3.14, and omp 18.4.3: `bun run check` passed; **64 tests passed, 0 failed, 256 assertions**. Two real omp RPC processes with an isolated database exercised **16 CPU alone → 8 CPU each → 16 CPU restored**, dedicated resource wait, release, zero model turns, and zero extension errors. A real TUI smoke observed Tab completing the subcommand and a send-recipient ID prefix. Smoke processes, the temporary input adapter, and the database were removed. These checks validate coordination and host integration, not OS-level quotas.

## 许可证 / License

本项目采用 [MIT 许可证](LICENSE)。 / This project is licensed under the [MIT License](LICENSE).

## Related projects / 相关项目

[OMP Pet](https://github.com/vavilonska/omp-pet) · [TokenLedger OMP](https://github.com/vavilonska/tokenledger-omp) · [All projects / 全部项目](https://github.com/vavilonska?tab=repositories)

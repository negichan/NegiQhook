# NegiQhook 开发手册（完整版）

> 本仓库是精简发布版：只保留独立协议端 `qqproto/`、hook 的生产路径（`src/` 与 `scripts/`）以及 API 文档。离线测试、真机探针、示例 bot 和交接包不在这个仓库里；下文提到这些路径时，说的是完整开发树。
>
> 第一次上手先看根目录的 `README.md`。

Windows x64 下的 QQNT 注入实验工程，目标是按 NapCat / SnowLuma 的思路，把「注入 → 进程内执行 JS → 调 QQ NT 内核接口 → 实时收消息」这条链路跑通。

当前进度：

- 注入 QQ 主进程、命名管道双向通信：可用
- 自动探测 QQ 主进程（区分多个同名 `QQ.exe`）：可用
- 在 QQ 的 Node 主线程上执行任意 JS（V8 + libuv `uv_async`）：可用
- 通过 `wrapper.node` 取 QQ 自己的 NT 会话、注册内核消息监听：可用
- 把 `RawMessage` 解析成消息段，经 TCP 推给外部进程：可用
- 真实入站消息：已确认（`onRecvMsg` 收到并解析过私聊文本）
- 本地网页测试台：好友列表、私聊文本发送、SSE 实时消息
- 发送消息：已实测（`sendMsg` 返回 `result=0` 并拿到消息 ID）
- 独立协议端进程 `qqproto` + Satori 适配器（WebSocket 网关 + HTTP API）：可用，官方 37 个方法里 30 个已实现，事件覆盖消息/撤回/申请/进退群/自己发的回显/登录态
- 无头启动（NapCat 式，不建窗口/renderer/托盘）：**真机跑通**——自定义主程序加载、引擎/登录服务初始化、二维码已能出；官方对 `package.json` 的内容校验用"首次读放行"绕过，不改文件也不 patch 二进制（见「无头 QQ」一节）
- 有头启动（`--headed`，正常 QQ 窗口 + 托盘）：同一个启动器/控制台/协议端，登录在 QQ 窗口里（见「有头模式」一节）
- 无托盘 / 窗口隐藏的 launch+quiet 模式：可用（保留完整 QQ，实测 ~238MB 私有工作集）
- 生产路径收口：无头 boot 为主，桥带本地 token（`<profile>\bridge.token`），同一 profile 单 launcher 锁；attach/`--headed` 标为调试路径（见「生产路径与调试路径」）
- 运行可靠性：协议端每 5 秒写 `<profile>\endpoint.health.json` 并开 `GET /health`；launcher 盯着进程与心跳，协议端崩了或心跳卡住会退避重启（默认最多 5 次），`--no-restart` 才恢复成"一崩就整套停"
- 写安全：未验证的 QQ build 默认只读（`--allow-untested` 才放开）；桥内对外写动作有 30/分钟、600/小时、300ms 间隔 + 抖动的预算，连续 3 次风控回包会熔断 60 秒（见「写操作的三道闸」）

**明确不做**：自己实现协议登录/签名、manual map、消息数据库读取、跨平台，也不做驱动级模块摘链或反作弊对抗。注入本身留下的痕迹（启动期的注入器进程、DLL 模块、内存里的自定义主程序）无法彻底消除；能收的都收在「无头 QQ」一节里写清楚了。

## 生产路径与调试路径

- **生产**：`qq_start.bat` → `scripts\headless_launch.js` → 挂起注入 `appinit.dll` → 读完自定义 `app.main.js` 后 hook 还原、DLL 自卸载 → `app.main.js` 用 `wrapper.node` 驱动内核 → 独立 `qqproto`。生产进程里没有 `qqhook.dll`、没有控制管道、没有 `jseval`，桥还带本地 token（`<profile>\bridge.token`，`qqproto --bridge-token` 校验）。
- **调试**：`scripts\qq_launch.js`、`qqinject.exe` 的 attach/`--cmd`、`headless_launch --headed` 会注入 `qqhook.dll` 并走 V8 eval；它们方便热插拔和看现场，但会留下常驻模块/管道/全局变量，不要拿来当长期生产路径。`--headed` 只用于需要 QQ 自己的窗口/托盘时。
- **锁**：同一个 profile 同时只允许一个 launcher（`<profile>\launcher.lock`）；launcher 被强杀留下的锁会按 pid 校验 `node.exe` 后自动清掉。
- **全局状态**：无头入口只写 `globalThis[Symbol.for('qqhook.root')]`；`app.main.js` 把配置和可变状态放进 `Symbol.for('qqhook.bridge.config')` / `Symbol.for('qqhook.bridge.state')`；桥自己只再留一个**不可枚举**的调试句柄 `globalThis.__qqhookProtoBridge`（`.state` / `.dispatch` / `.status` / `.dispose`）。`Object.keys(globalThis)` 里看不到这串名字；attach 路径的旧 `__qqhook*` 仍作为兼容输入被读取，但桥不再写它们。
- **监督**：launcher 除了检查 pid，还看 `<profile>\endpoint.health.json` 的更新时间；协议端死了或事件循环卡住都会退避重启（1.5s→20s，5 次内），恢复健康 15 秒后重试预算清零。`--no-restart` 退回旧行为，`--keep-on-exit` 依旧什么都不停。

## 写操作的三道闸

按"从外到内"排，每一层都只管自己的事：

1. **协议端 `allow_write`（调试页/聊天页/配置页/控制台）**：页面与控制台发的写请求必须显式带 `allow_write: true`，否则服务端 403。这只管"操作者是不是真有这个意图"。控制台还在它前面加了自己的 `writes on|off`（`--read-only` 一进来就是关的）：开关在关的时候 `say`/`recall`/`emit` 连请求都不会发。网络配置的保存也走同一道闸（外加 revision 冲突检查）：误发的 POST 或跨站页面改不了监听端口。
2. **版本闸（`qqproto/lib/compat.js`）**：hello 里的 `qq_version` 只有在 `TESTED_QQ_VERSIONS`（当前 `9.9.36-53644`、`9.9.36-53489`）里才算已验证；`capabilities.missing` 里若缺 `getMsgService.sendMsg` 这类关键方法也算未验证。未验证时**读照常**，写返回 Satori `403` / OneBot `retcode 1401`，并提示 `--allow-untested`。调试 attach 路径不报版本号，这道闸不启用。
3. **行为闸（桥内 `gateWrite`）**：对外可见的写动作默认 30 次/分钟、600 次/小时、两次至少间隔 300ms 再加 0–120ms 抖动；连续 3 次拿到风控类回包（典型 `sendMsg result=121`）就打开熔断 60 秒，期间写动作直接以 `circuit_open` 拒绝，不碰内核。超预算/熔断是 Satori `429`（`retry_after` 带在帧里），桥的 `limits` 随 hello 和每 15 秒一次的 `heartbeat` 帧上报，`/health`、调试页与控制台的 `status` 都能看到。预算可在 `app.config.json` 的 `write_budget`（`per_minute` / `per_hour` / `min_interval_ms` / `jitter_ms` / `breaker_errors` / `breaker_cooldown_ms`）里改，或用 `headless_launch --write-per-minute/--write-per-hour/--write-interval` 传进去。

三道闸都不声称能防住腾讯的服务端风控：`result=121` 本身是服务端决定的，这里做的是"别把一个小号刷成明显的机器"。

## 架构

分成三层，注入侧永远不知道 Satori 是什么。注意：下面这张图里的 `qqhook.dll` 属于 attach/headed 调试路径；生产无头走 `appinit.dll` + 自定义 `app.main.js`，没有常驻的 `qqhook.dll`。

```
QQ.exe（只负责注入与通信）
├─ qqhook.dll                 LoadLibrary 注入，控制管道 + V8/uv 执行
└─ proto_bridge.js            内核事件规范化 + 执行外部动作（TCP 客户端）
        │  上行 {type:'event'} / 下行 {type:'action'} / 回包 {type:'result'}
        ▼
qqproto（独立 Node 进程，不依赖 npm 包）
├─ lib/rpc.js                 桥连接、按 generation 选出最新实例、请求-响应、心跳统计
├─ lib/compat.js              版本适配：已验证 build 表、能力缺口、写操作是否放行
├─ lib/health.js              5 秒一次的健康快照（文件 + /health 共用）
├─ lib/ws.js                  零依赖 RFC6455：服务端 + 客户端（反向 WS 要带握手头）
├─ core/                      协议无关：self/friends/groups/members/messages + 动作
├─ protocols/satori/          /v1/events 网关 + /v1/{method} + 消息元素编解码
└─ protocols/onebot11/        动作表 + CQ 段/事件转换 + 四种传输（HTTP/WS/上报/反向 WS）
```

协议层是按"传输可插拔"写的：`protocols/<name>/` 只依赖 `core` 的动作和 `store` 的缓存，加第三种协议仍然是新增目录，QQ 侧不改一行。Satori 与 OneBot 默认同时开，互不干扰。

注入层、协议层、传输层的边界：

| 层 | 位置 | 职责 | 明确不负责 |
| --- | --- | --- | --- |
| 注入 | `qqhook.dll` / `qqinject.exe` | 注入、执行 JS、维护控制管道 | 消息语义、协议字段 |
| 通信桥 | `scripts/proto_bridge.js` | 内核回调规范化、动作执行、断线重连 | 协议编解码、缓存策略 |
| 协议端 | `qqproto/` | 身份/联系人缓存、方法路由、Satori/OneBot 语法、鉴权 | QQ 原生 API 细节 |

```
QQ.exe (主进程)
├─ qqhook.dll                 LoadLibrary 注入
│  ├─ \\.\pipe\qqhookpoc_pid  控制通道：info / modules / js / jseval ...
│  └─ uv_async               把 JS 调度到 Node 事件循环线程
├─ wrapper.node               QQ 自带原生 NAPI 模块（已加载）
│  └─ NodeIQQNTWrapperSession.getNTWrapperSession('nt_1')
│     └─ getMsgService().addKernelMsgListener(...)
└─ proto_bridge.js            事件规范化 + 动作执行 -> TCP 127.0.0.1:47840（qqproto）

qqinject.exe --listen（旧的单向日志模式，仍保留）
└─ 监听 TCP 47821，逐行打印 msg_bridge.js 的事件
```

关键点：**不读消息库**。消息来自 `addKernelMsgListener` 的 `onRecvMsg` 原生回调；`wrapper.node` 只是通过 `process.dlopen` 再取一份 NAPI 导出（NapCat 同款做法），拿到的是 QQ 自己已经创建并登录的会话。

## 目录

```
src/common/pipe_protocol.h   长度前缀的命名管道帧协议
src/hook/dllmain.cpp         被注入的 DLL：管道、诊断、V8 执行、uv 桥、trayhook
src/injector/main.cpp        注入器：找进程、注入、命令、--listen / --bridge-only / --launch / --headless
src/boot/dllmain.cpp         无头启动 DLL：内存重定向 package.json/app.main.js，启动后自卸载
src/headless/app.main.js     无头主程序：驱动 wrapper/session 登录并装桥，不建任何窗口
src/boottest/main.cpp        离线靶子：验重定向与注入后才加载模块的补丁/还原
src/testhost/main.cpp        无害测试目标（含托盘钩子探针）
scripts/headless_launch.js   启动器：无头（默认）或有头（--headed），拉起 QQ、ready 后起协议端并监督它
scripts/lib/line_editor.js   控制台自己的行编辑：原始模式、宽字符光标、历史、Tab，日志插在中间也不打乱输入
scripts/lib/server_console.js  控制台框架：命令注册表、help、颜色、状态行、未知命令与失败的形状
scripts/lib/instance_console.js 这套实例的命令集（status/health/stats/friends/say/recall/emit/…），全部走 127.0.0.1 调试端口
scripts/lib/restart_policy.js 协议端重启的退避与预算（launcher 用，单独可测）
scripts/qq_fetch_client.js   客户端不在就自己装一个：读官方下载配置、下载、切出 7z 载荷、解包、验收、剪掉残留
scripts/qq_fetch_client_offline_test.js 离线门禁：假 fetch/download/run 跑完整取客户端流程
scripts/headless_stop.js     停止启动器记下的无头 QQ 与协议端（PID 必须分别是 QQ.exe / node.exe 才动）
scripts/qr_console.js        零依赖 PNG→控制台二维码（无头登录码直接打在终端里）
scripts/boot_offline_test.js 无头 DLL 的离线门禁（重定向/放行闸门/还原/自卸载）
qq_start.bat                 日常入口：起无头 QQ + 协议端，二维码打在本窗口
qq_stop.bat                  日常出口：把上面两个停掉
scripts/qq_launch.js         自己拉起 QQ：挂起→注入→恢复，默认无托盘 + 桥 + quiet
scripts/qq_window.js         窗口/quiet 模式 CLI
scripts/qq_tray.js           换托盘图标 CLI（attach 模式、托盘没被吞掉时才有意义）
scripts/proto_bridge.js      QQ 内的双向 RPC 桥（事件上行 / 动作下行）
scripts/msg_bridge.js        旧的单向事件打印桥（配合 --listen）
scripts/web_console.js       QQ 内的网页测试台（配合 --console）
scripts/chat_preview.js      假桥沙箱：不起 QQ 也能打开 /chat 与调试页看效果
scripts/gen_api_docs.js     生成 docs/api 的 Apifox 文档（OneBot 107 个动作 / Satori 37 个方法，状态与代码对账）
docs/api/                    可直接导入 Apifox 的 OpenAPI 3.0（OneBot / Satori）+ 人读的状态总表
qqproto/lib/rpc.js           协议端：桥连接与请求-响应
qqproto/lib/compat.js        协议端：版本适配表与写操作放行判断
qqproto/lib/health.js      协议端：健康快照文件（launcher 的心跳）
qqproto/lib/ws.js            协议端：零依赖 RFC6455 服务端 + 客户端（反向 WS 用）
qqproto/lib/network-config.js 协议端：network.json 的校验、生落盘、按网络热重载
qqproto/lib/image-source.js  图片引用落地：file:// / base64:// / data: / http(s) → 本机缓存文件
qqproto/core/                协议无关的身份、联系人、消息缓存与动作
qqproto/core/message-unique.js OneBot 数字 message_id 与 QQ 原生 msgId 的双向映射
qqproto/protocols/satori/    Satori 网关、HTTP 方法、事件、消息元素编解码
examples/nonebot-satori/     最小 NoneBot2 工程（官方 Satori 适配器），help → ok；依赖装在 .venv（已 ignore）
examples/nonebot-onebot/     最小 NoneBot2 工程（官方 OneBot v11 适配器），同一个 help → ok 插件
qqproto/protocols/satori/upload.js  upload.create 的 multipart 落地（写 data\upload，回 file:// 路径）
qqproto/protocols/onebot11/  OneBot v11 动作表、事件与 CQ 段转换、四种传输
qqproto/ui.js                协议端调试页的后端：日志/事件/投递/调用的同源 SSE
qqproto/ui.html              调试页本身（单文件，无外部依赖）
qqproto/chat.html            QQ 式聊天界面（同一端口的 /chat：会话、气泡、发送、撤回）
qqproto/config.html          网络配置页（/config：Satori、WS 正反向、HTTP 服务器/上报）
qqproto/test/satori-smoke.js 端到端自测脚本（Satori）
qqproto/test/onebot-smoke.js 端到端自测脚本（OneBot，含 HTTP/WS/上报/反向）
qqproto/test/network-config-test.js 离线：配置校验/落盘/热重载 diff/按网络上报自身消息
qqproto/test/image-source-test.js 离线：file:// / base64:// / data: / http(s) 图片解析与缓存
qqproto/test/ui-offline-check.js 离线：假桥跑调试页的 HTTP/SSE/调用面、/health 与配置页
qqproto/test/compat-test.js   离线单元测试（已验证版本、未验证 build、能力缺口、core 闸）
qqproto/test/supervisor-test.js 离线单元测试（健康文件与重启退避预算）
qqproto/test/segments-test.js 离线单元测试（CQ 编解码、消息 id 表、权限）
qqproto/test/satori-elements-test.js 离线单元测试（Satori 的 XML 段编解码）
qqproto/test/satori-methods-test.js 离线：假 core 跑 Satori 方法表/事件/HTTP（含上传与预检）
qqproto/test/core-send-test.js 离线单元测试（core 这道闸转发哪些段、send_message 参数形状）
qqproto/test/bridge-mock.js   离线：假内核跑桥脚本，核对每个原生动作的调用形状
qqproto/test/onebot-actions-test.js 离线：假 core 跑 OneBot 动作表，核对 retcode 与数据形状
qqproto/test/onebot-live-check.js  真机分级验证：默认只读，写与不可逆要显式开闸
scripts/coverage_snapshot.js  算账：桥的动作表有多少个进了离线沙箱
scripts/probe_kernel_methods.js 只读普查：列出 66 个内核服务与它们的方法名
scripts/probe_upload_arity.js   只读：用 NAPI 的 argc 断言问出上传类方法是几个参数
scripts/probe_upload_shape.js   只读：群空间容量、上传入口的空参数回执
scripts/probe_upload_only.js    只读：onlyUploadFile / uploadRMFileWithoutMsg 的形状
scripts/probe_rm_paths.js       只读：内核的富媒体目录与路径助手
scripts/probe_stage_path.js     只读：发送前的落盘路径助手返回什么
scripts/probe_stage_dir.js      只读：getPicTmpPath / getRichMediaFileDir 的真目录
scripts/probe_title.js          群头衔：内核剩下的两个 API 都试过
scripts/probe_send_image.js     会真发一条：把本机图片塞进 picElement 让内核自己传
scripts/probe_send_group_image.js 会真发一条：群聊里的同一形状（这条通了）
scripts/capture_send_shape.js   只读监听：把客户端自己发出去的元素原样抓下来
scripts/capture_event.js       抓一条协议端推出来的原始事件（调试用，Node 内置 WebSocket）
scripts/event_sink.py        独立 TCP 接收器（调试用）
build.bat                    构建（可传一个 DLL 文件名参数）
```

## 构建

```bat
build.bat
build_boot.bat
```

`build.bat` 输出 `bin\qqhook.dll`、`bin\qqinject.exe`、`bin\testhost.exe`。`build_boot.bat` 输出 `bin\headless\appinit.dll` 和两个离线靶子：`bin\boottest.exe`、`bin\boottest\QQNT.dll`（后者故意和真模块同名，用来验「注入后才加载的模块也会被重定向」）。

`.bat` 有两条格式约定，`.gitattributes` 已经把它们钉住了：**必须 CRLF**（LF 版 cmd.exe 会连行都读错），**里面只能有 ASCII**——cmd.exe 按系统 ANSI 码页（本机 936）解析批处理文件，UTF-8 的中文行会被配成半个字符，剩下的字节里就冒出了 `|`、`^` 这类控制符，一句 `echo` 会被拆成几条"不是内部或外部命令"。所以 `qq_start.bat` 自己只印英文，中文提示都由 `scripts\headless_launch.js` 打（那是 Node，读的是 UTF-8）。

如果 QQ 正在运行，`bin\qqhook.dll` 被映射，链接会报 `LNK1104`。二选一：

1. 退出 QQ 后重新 `build.bat`；
2. 运行 `build.bat qqhook-next.dll`，生成 `bin\qqhook-next.dll`（`qqinject.exe` 仍会更新）。注入时加 `--dll bin\qqhook-next.dll`，或等 QQ 退出后改名替换。

## 自测（不碰 QQ）

```bat
bin\testhost.exe
bin\qqinject.exe --pid <testhost PID> --cmd info --cmd "echo hello"
```

## 对真实 QQ 跑

> 想连托盘都不要、由我们启动 QQ：先退出 QQ，再执行
> `node scripts\qq_launch.js --uin <uin>`。它会在挂起状态注入 DLL、恢复进程、
> 安装桥并进入 quiet；托盘图标从头到尾不会创建。下面的 1–3 是普通 attach 流程。

1. 正常启动并登录 QQ。不需要手工找 PID；注入器会按进程名找 `QQ.exe` 并打分：

   ```bat
   bin\qqinject.exe --list
   ```

   典型输出：

   ```
   QQ.exe candidates (higher score = more likely the main process):
     pid=27912 ppid=13336 score=150 wrapper.node QQNT.dll window exe=...\QQ.exe
   ```

   打分规则：加载 `wrapper.node` +100，加载 `QQNT.dll` +20，拥有顶层窗口 +30。渲染/GPU/工具进程也是 `QQ.exe`，会先按父进程关系过滤掉；只剩一个根进程时直接使用；多个根进程时选唯一最高分（且 ≥30）；分数并列则要求显式 `--pid`。

2. 基础验证（省略 `--pid` 即自动探测）：

   ```bat
   bin\qqinject.exe --cmd info --cmd "modules wrapper"
   bin\qqinject.exe --cmd uvprobe
   ```

   多开、或有多个候选时再传 `--pid <PID>` 锁定目标。

3. 启动收消息桥：

   ```bat
   bin\qqinject.exe --listen
   ```

   首次运行会：安装 `msg_bridge.js` → 取 `nt_1` 会话 → 注册 `onRecvMsg` → 监听 `127.0.0.1:47821`。装完桥后会释放控制管道，所以监听期间仍可另开终端发其它命令。

   这是单向打印模式，只适合快速验证链路。要接协议端，改用下面的 `--bridge-only`（见「Satori 协议端」一节）。

   常用参数：

   ```bat
   --pid <n>           指定进程；省略则自动探测
   --port 47821        事件端口（默认 47821，被占用就换一个）
   --bridge-only       安装 scripts/proto_bridge.js 后退出，由 qqproto 监听
   --self-test         安装后立即发 3 条合成消息，验证 解析 -> TCP -> 打印
   --json              打印原始 JSON 行，而不是人类可读的 display
   --js-file <path>    指定桥脚本，默认 <exe>\..\scripts\msg_bridge.js
   ```

   先用自测确认链路：

   ```bat
   bin\qqinject.exe --listen --self-test
   ```

   预期输出：

   ```
   [bridge] bridge installed: registered id=20 port=47821 connected=false ...
   [self-test] self-test emitted 3 synthetic events; port=47821 connected=true
   [私聊] TestFriend(10001): hello from a synthetic private text message
   [群 20002] GroupCard(30003): got it @GroupMate look[图片][表情:/smile]
   ```

   之后保持该窗口运行，收到的真实消息会直接打印：

   ```
   [群 123456] 昵称(10001): 你好[图片]
   ```

   事件同时落盘到 `%TEMP%\qqhook_events.log`。

4. 状态与手动测试（监听期间可用）：

   ```bat
   bin\qqinject.exe --cmd "js JSON.stringify(globalThis.__qqhookBridge.status())"
   bin\qqinject.exe --cmd "js globalThis.__qqhookBridge.selfTest()"
   ```

## 协议端（qqproto）

协议端是**独立进程**，QQ 侧只保留注入与通信桥。

```bat
rem 1. 先起协议端（它监听桥端口）
node qqproto\index.js --port 5140 --bridge-port 47840 --token yourtoken

rem 2. 再把通信桥装进 QQ（只安装，不监听）
bin\qqinject.exe --bridge-only --port 47840
```

第 2 步也可以用 `node qqproto\index.js --install` 自动执行。QQ 重启后桥连接会断开，重跑第 2 步即可；协议端不用重启，桥会自动回连。

**接口清单 / Apifox**：`docs/api/` 下有两份可直接导入 Apifox 的 OpenAPI 3.0 文件（`onebot11.openapi.json`、`satori.openapi.json`）和一份人读总表（`docs/api/README.md`）。每个接口都带 `状态 · 已实现` / `状态 · 未实现` 标签，未实现的写明原因（1400 / 501），不会把“有个 handler 但只会拒绝”算成可用。文档由 `node scripts\gen_api_docs.js` 生成，生成前会逐个核对代码里的 action 表与 `UNIMPLEMENTED` / `REFUSED`、Satori 的 `KNOWN_METHODS` / `features`，对不上直接报错。

常用参数：

```bat
--host 127.0.0.1        只绑回环；绑非回环地址必须再加 --allow-public
--port 5140             Satori HTTP/WS 端口
--bridge-port 47840     通信桥回连端口
--bridge-host 127.0.0.1 桥连接的服务地址，保持回环
--token <s>             访问令牌；省略则每次随机（QQPROTO_TOKEN 亦可）
--install               启动后自动调用 bin\qqinject.exe --bridge-only
--injector <path>       qqinject.exe 路径
--bridge-script <p>     覆盖默认注入脚本 scripts/proto_bridge.js
--pid <n>               多开时指定 QQ 主进程
--log-level info        error | warn | info | debug
--protocol none         首次启动预置哪个协议面：none | satori | onebot | both，默认 none
--config-file <p>       网络配置，默认 qqproto\data\network.json；launcher 传 <profile>\network.json
--ui-port 5150          调试页端口，默认协议端口 +10；0 或 --no-ui 关闭
--no-satori             关掉 Satori，只留 OneBot
```

**默认不启动任何协议端口**：端点起来时只有桥和调试/配置页，Satori 与 OneBot 都由配置页显式打开后才会监听。命令行里的 `--protocol` / `--ob-*` 只是**第一次启动时写进 `network.json` 的种子**；文件一旦存在，就以文件为准（页面保存会立即热应用，重启实例后照样生效）。所以 `--protocol both` 仍可用于测试或脚本化启动，但日常推荐直接在 `http://127.0.0.1:<调试页端口>/config` 里配置。OneBot 的相关种子参数：

```bat
--ob-port 3000          HTTP 动作服务端端口（0 关闭）
--ob-ws-port 3001       WebSocket 服务端端口（0 关闭）
--ob-no-http            关掉 HTTP 动作服务端
--ob-no-ws              关掉独立 WebSocket 服务端
--ob-host 127.0.0.1     OneBot 监听地址，默认跟随 --host
--ob-token <s>          OneBot 访问令牌，默认沿用 --token
--ob-format array       array | string(CQ 码)
--ob-report <url>       HTTP 事件上报，可重复
--ob-report-secret <s>  给上报加 X-Signature: sha1=HMAC-SHA1
--ob-reverse-ws <url>   反向 WebSocket（协议端主动外连），可重复
--ob-report-self        也上报自己发出的消息（默认只走 message_sent 不广播）
--ob-http-ws            在 HTTP 端口上同时接受 WebSocket
--ob-no-http            完全不启 HTTP 动作服务端
--ob-no-ws              完全不启独立 WebSocket 服务端
--ob-heartbeat 30000    心跳间隔（毫秒）
--ob-reconnect 5000     反向 WS 重连间隔（毫秒）
--ob-state <file>       消息 id 映射表，默认 qqproto\data\onebot-msg.json
```

### 调试页（`qqproto/ui.js` + `qqproto/ui.html`）

协议端进程自带一个本地调试页：`http://127.0.0.1:<协议端口+10>/`（副本实例是 5151，主实例是 5150）。它跑在协议端进程里，所以不需要第二个端口去轮询，也不用把 token 抄来抄去：

- 顶部一行状态：桥是否连着（含来源地址、generation、QQ build、这一分钟的写预算用量与熔断状态）、当前账号、两面协议的端口与已实现/已知方法数、token、在线客户端数、事件/投递/调用计数、运行时长；悬停在桥状态上能看到版本适配的告警。同一份数据也走 `GET /health`（调试页端口，桥没连上时是 503），协议端另把它每 5 秒写进 `<profile>\endpoint.health.json` 给 launcher 监督。
- 「协议端输出」：进程的真实日志流，含被 `--log-level` 挡在控制台之外的 `debug` 行，带来源标签（`[bridge]` / `[satori]` / `[onebot]` / `[ui]`），可按级别和关键字过滤；
- 「事件流」：内核事件原文 + 每个协议**实际投递给客户端的报文**（`satori ws×N` / `onebot http|ws|report1|reverse1`），点开就是原文 JSON。协议没客户端时也会记录，并明确标出 `ws×0`；
- 「调用」：按协议列出全部已知方法（分成 只读 / 写操作 / 已知但未实现），参数框预填模板，两种走法——`HTTP`（打到协议自己的端口，带上 token，和机器人客户端走的是同一条路，能顺手验证鉴权与报文形状）与 `内部函数`（绕过端口，直接进 handler，用来判断问题是不是端口那一层）。

另有一条给框架联调用的 `POST /api/emit-test`（同样要 `X-Debug-Call: 1`）：让桥伪造一条**入站**消息丢进内核回调，再照常走转换与广播，所以机器人框架看到的事件和真收到一条消息完全一样，不用第二个账号就能测「收到消息 → 回复」：

```bat
curl -s -X POST http://127.0.0.1:5151/api/emit-test ^
  -H "X-Debug-Call: 1" -H "Content-Type: application/json" ^
  -d "{\"text\":\"help\",\"uin\":\"10000002\",\"group_id\":0}"
```

`uin` 是伪造的发送者（私聊时对端、群聊时是成员），`group_id` 非 0 时按群消息投递，`at_self` 可让内容带上 @机器人。它只是把一条合成事件塞进 `handleIncoming`，不写本机、不发网络消息；你在真机上发出的东西、客户端看到的东西都不经过它。

安全边界：只绑回环（除非 `--allow-public`，此时跟随协议端口地址）；`POST /api/call` 与 `/api/emit-test` 必须带 `X-Debug-Call: 1`，而调试页端口不回应 CORS 预检，所以别站网页打不进来；写操作在页面里默认被拦，参数模板里的群号/QQ 号一律留空。观测钩子只读：`_broadcast` 仍在真正发帧时才分配 `sn`，离线校验会比对「经页面调用」与「直接打端口」的报文，确认加了这个页面没有改变任何客户端看到的内容。

### 聊天界面（`qqproto/chat.html`，`/chat`）

同一个端口上的 `http://127.0.0.1:5151/chat`，做成 QQ 的样子用来调收发：

- 左栏「消息列表 / 群组 / 好友」，可搜索；会话行显示最后一条摘要、时间和未读角标，点开即清零；
- 中间是气泡：自己右侧、别人左侧带名片名，时间按 5 分钟分组，跨天插入日期行；段渲染覆盖 `text / at / image / face / mface / record / video / file / reply / forward / json / gray_tip`，认不出的一律显式打成 `[类型]` 标签，不静默丢；
- 收到的图片直接内联——桥给的是本机路径（`Ori` 或 `Thumb`），页面经 `GET /api/file?path=` 取回，只允许仓库目录和你的用户目录（`--ui-allow-dir` 可以增加），越界就 403；点图开新标签看原图；
- 群会话右侧有成员面板，点成员把 `@名字` 插进输入框；
- 发送走 `POST /api/chat/send` → **core.send**，和两个协议面同一道闸：文本/@/本机图片过，`record/video/file` 之类仍被 core 明确拒掉并回原文。先勾「允许写操作」，而且请求体必须自己带 `allow_write: true`（没这个字段的 POST 在服务端就被 403，不依赖页面自觉）；
- 右键自己发的消息撤回（`/api/chat/recall` → core.recall），成功后气泡变成 QQ 那句「你 撤回了一条消息」；
- 发送后先挂一个半透明的 pending 气泡，内核的回声事件到了再按 message_id 或「同会话同内容（两分钟窗口）」替换掉，不会留下两条重复；
- 历史只来自本进程的内存缓存（`store`），也就是协议端启动之后见过的消息；不读 QQ 的数据库，也不轮询历史。

想看效果又不想动真 QQ：`node scripts\chat_preview.js` 起一个假桥的协议端（每 12 秒推一条，含 @、图片、表情、私聊和成员变动），端口 6101/6102/6103/6104/6111，全程只在本机。

```bat
node qqproto\test\ui-offline-check.js
```

不碰 QQ、不出本机：用假桥（一条普通 TCP socket 说桥的行协议，并按真机形状回 `get_friends/get_groups/get_group_members/send_message/recall`）跑完整 95 项断言——页面本身、方法目录、未实现标记、SSE 回填、两条调用路径、403/405 拦截、事件与投递记录、聊天页的会话/历史/成员、`allow_write` 这道闸、core 拒段、图片预览的目录限制、`/health` 与协议端健康文件、配置页的读写与热重载（含 Satori 换端口、OneBot 同端口重建、revision 冲突、回环拦截），以及"观测不改变报文"和"默认不启动任何协议端口"。

旧的 `bin\qqinject.exe --console`（`scripts/web_console.js`，端口 47830）是跑在 **QQ 进程里**的私聊文本小工具，和这个页面不是一层东西：调协议端、看协议报文用新页面；只想绕开协议端直接从 QQ 内部戳一下好友，才用旧的那个。

### 网络配置页（`qqproto/config.html`，`/config`）

NapCat 风格的网络配置，放在同一个调试端口：`http://127.0.0.1:5151/config`（主实例 5150）。**实例默认不启动任何协议端口**——页面打开 Satori、或者新增一个 OneBot 网络并保存后，对应端口才真正开始监听；不保存就什么都不暴露。

- **协议面**：Satori 一张卡（开关 / 监听地址 / 端口 / token，改端口会先绑新的再放旧的，客户端只会闪断一下）；OneBot 一张全局卡（默认 token、默认消息格式 array|string、心跳、是否上报自身消息）。
- **OneBot 网络**（可多个同时开、互不干扰，NapCat 的四种都对齐了）：HTTP 服务器、WebSocket 服务器（正向）、HTTP 客户端（上报）、WebSocket 客户端（反向）。每张网络卡可以单独启用/停用、改 token、覆盖消息格式、覆盖心跳；正向与反向都支持 `universal / api / event` 角色。每张卡上的「复制」给出框架侧该填的地址。
- **热应用**：保存时按**网络名称**做 diff——没改动的网络保持原对象、连接不断；改了的关闭后重建；删掉的关闭。新增网络即时连上。配置文件是 `<profile>\network.json`（launcher 传 `--config-file`；单独跑 `qqproto\start.bat` 时是 `qqproto\data\network.json`），重启实例后依旧生效。命令行 `--protocol` / `--ob-*` 只负责首次生成这个文件，之后文件优先。
- **安全闸**：监听地址只允许回环（`--allow-public` 是唯一的例外，且是整端点级别）；保存必须同时带 `X-Debug-Call: 1` 与请求体里的 `allow_write: true`（页面右下角「允许修改」），跨站页面和误发的 POST 都改不了端口。页面读到的 `revision` 保存时回传，别处改过就 409，不会互相覆盖。
- 页面是单文件、无外部依赖；`GET /api/network-config` 读当前配置与每个网络的实时状态，`POST /api/network-config` 是保存入口（形状见 `qqproto/lib/network-config.js` 顶部注释）。

最小接法（NoneBot 反向 WS）：框架侧起 `nonebot-adapter-onebot` 的 WS 服务端（默认 `ws://127.0.0.1:8080/onebot/v11/ws`），页面「新增网络 → WebSocket 客户端（反向）」填同一个地址，token 两边一致，保存即连上；正向则反过来，页面开一个 WebSocket 服务器，框架填 `ws://127.0.0.1:3001`。

### 桥协议

`proto_bridge.js` 是 TCP 客户端，协议端是服务端，换行分隔 JSON：

```jsonc
{"type":"hello","bridge":"qqproto/2","bridge_version":2,"token":"<local>","qq_version":"9.9.36-53644","appid":"537391628","qua":"V1_WIN_NQ_9.9.36_53644_GW_B","headless":true,"capabilities":{"services":["Msg","Buddy","Group","Profile","RichMedia"],"actions":53,"missing":[]},"limits":{"budget":{"per_minute":30,"per_hour":600,"min_interval_ms":300,"jitter_ms":120,"breaker_errors":3,"breaker_cooldown_ms":60000},"used_minute":0,"used_hour":0,"open":false},"generation":3,"self":{"uin":10000001,"uid":"u_...","nick":"..."}}
{"type":"heartbeat","time":1793002400000,"last_event_at":1793002398000,"counters":{"event":12,"action":3,"actionError":0,"dropped":0,"recall":0,"send":3},"limits":{"used_minute":1,"open":false,"retry_after":0}}
{"type":"event","event":{"type":"message","direction":"incoming","message_id":"...","chat_type":1,"peer_uin":"...","group_id":0,"sender":{...},"elements":[{"type":"text","data":{"text":"你好"}}],"raw_message":"你好"}}
{"type":"action","id":7,"action":"send_message","params":{"scene":"private","user_id":"10000002","elements":[{"type":"text","data":{"text":"hi"}}]}}
{"type":"result","id":7,"ok":true,"data":{"message_id":"770088...","confirmed":true,"time":1793002400}}
{"type":"result","id":8,"ok":false,"error":"write budget exhausted (30/minute); refusing \"send_message\"","code":"rate_limited","retry_after":60}
```

hello 里的 `token` 是本地 bridge token：`headless_launch.js` 把它写进 `app.config.json`，同时用 `--bridge-token` 传给 `qqproto`。没带这个参数的调试端点不校验，带了这个参数时 token 不对的 hello 会被直接断开。`bridge_version`/`qq_version`/`capabilities` 只用于诊断和版本适配，不改变动作语义：`capabilities.missing` 是桥按服务名逐个 `typeof` 探出来的内核方法缺口，协议端据此（配合 `qqproto/lib/compat.js` 的已验证 build 表）决定是否放行写动作。`limits` 是桥的写预算与熔断状态，之后每 15 秒有一条 `heartbeat` 把它刷新；`/health` 与 `<profile>\endpoint.health.json` 用的是同一份快照。结果帧的 `code`/`retry_after` 只用来把预算与版本闸翻成 Satori `429/403`、OneBot 对应 retcode，不改变成功路径。

桥里的事件有四类：`message`（收发都算，带内核的 `sequence`/`random`，精华和表情回应靠这两个值寻址）、`message_deleted`（撤回）、`request`（加群/好友申请，按 `seq`/`reqTime` 去重后只报一次）、`offline`（被踢下线）。动作表共 53 个（12 个基础 + 41 个扩展；另有 `connected`/`reconnect` 是桥对象自己的方法，不在动作表里。精华列表原本也在扩展里，真机确认内核给不出答案，已经改成协议层显式拒绝）：

```
基础     ping status get_self get_friends get_groups get_group_members get_user
         send_message recall get_cached_message list_cached_messages emit_test
窗口     qq_window tray_icon（只在有窗口/托盘的调试路径有意义，无头下如实报错）
群管理   set_group_ban set_group_whole_ban get_group_shut_list set_group_kick
         set_group_admin set_group_card set_group_name set_group_special_title
         set_group_leave set_group_remark get_group_at_all_remain get_group_detail
         get_group_level_info clear_group_notice_unread
请求     get_group_system_notices handle_group_request get_friend_requests
         handle_friend_request clear_friend_request_unread set_friend_remark delete_friend
公告     send_group_notice list_group_notices delete_group_notice
消息级   mark_read set_msg_reaction set_essence forward_message send_like
群文件   get_group_files get_group_file_count upload_group_file delete_group_file
         create_group_folder delete_group_folder rename_group_folder move_group_file
文本     translate_text ocr_image
```

协议端只认这套动作，Satori/OneBot 语法都留在协议层。除了 `send_message`/`recall` 这类基础动作，其余群管理、请求、公告、文件、OCR 都只是把内核调用包装成一次 RPC；其中**只读的那批已经真机跑过**（群详情、禁言名单、@次数、等级、群文件、申请列表、翻译、OCR；公告列表在本机确认内核读不到，改成明确拒绝），改人改群的那批里**能当场恢复的也已经真机跑过**（改名片、禁言+解除、群文件目录建/改名/删、改群名、改备注、设管理员+取消、同意入群申请、发图片），只有不可逆或会对外打扰的那排（踢人、退群/解散、删好友、点赞、转发、发公告、设精华、表情回应）仍只过了离线假内核。

每次重跑 `--bridge-only` 会递增 `generation`，协议端只认最新的桥；旧实例的连接被挂起但不参与动作，重启 QQ 可以彻底清干净。

### Satori 接口

```
ws  ws://127.0.0.1:5140/v1/events      op: 0 EVENT / 1 PING / 2 PONG / 3 IDENTIFY / 4 READY / 5 META
http POST http://127.0.0.1:5140/v1/{method}
GET  /health                            无需令牌；桥未就绪时 503，内容是 launcher/监控用的同一份快照
```

鉴权支持 `Authorization: Bearer <token>` 或 `?access_token=<token>`（HTTP 与 WS 都可以带）。WS 的 upgrade 允许**不带**凭据——Satori 客户端（NoneBot 的适配器就是这样）在 IDENTIFY 里送 token；带了但不对的凭据会在 upgrade 阶段被拒，不带凭据又不在 10 秒内发对 token 的 IDENTIFY 会被 `1008` 关掉。

已实现的方法（`login.get` 的 `features` 里逐项声明，调试页也按这张表标"已实现/未实现"）：

```
login.get  user.get  friend.list  friend.delete  friend.approve
guild.get  guild.list  guild.member.get/list/kick/mute
guild.member.role.set/unset/list  guild.role.list
channel.get/list/update/mute  user.channel.create
message.create/get/list/delete  reaction.create/delete/clear
guild.approve  guild.member.approve  upload.create
```

方法表就是 `@satorijs/protocol` 1.7.0 的 `Methods`：**37 个，一个不多一个不少**，`satori-methods-test.js` 会拿官方表逐项比对（之前多出来的 `guild.member.role.get`、`guild.role.get`、`command.update` 三个不存在的名字已经删掉）。37 个里 **30 个已实现**，剩下 7 个返回 501 并带原因：`message.update`（本版本内核没有改消息接口）、`reaction.list`（能设置表情回应，但列不出谁回应了）、`channel.create` / `channel.delete`（建群、退群/解散不走内核 API，一律手动）、`guild.role.create/update/delete`（QQ 角色固定为 owner/admin/member，没有角色表）。

映射约定：私聊是 `channel.type = 1 (DIRECT)`，`channel.id` 用对方 QQ 号；群是 `channel.type = 0` 且 `guild.id = channel.id = 群号`；QQ 的三种成员角色映射成 `roles[].id = owner|admin|member`。

事件：`message-created`、`send`（自己发出的消息回显——它**不再**冒充 message-created，否则机器人会回自己）、`message-deleted`（撤回）、`friend-request` / `guild-member-request`（好友申请、加群申请，`message.id` 就是审批要回传的 flag，QQ 里加群即加 guild，所以不发 `guild-request`）、`guild-member-added` / `guild-member-removed`（进退群：内核只把它当灰条塞在消息里，桥侧已经单独抽成 `group_member` 事件，OneBot 那边同时出 `group_increase`/`group_decrease` 通知）、`login-updated`（桥上线/掉线，`status` 用 1 ONLINE / 2 CONNECT / 3 DISCONNECT / 4 RECONNECT）。

发送支持 `<text>`、`<at>`、`<img src="<本机路径>"/>`（也接受 `file:///...`）、`<file src="..." title="..."/>`、`<quote id="..."/>`（回复；quoted 消息必须在桥的缓存里，因为 QQ 要用它的 seq/msgId/sender 拼 replyElement）、`<emoji id="14"/>`（QQ 表情）。`<audio>/<video>` 仍然 501（语音要 silk、视频要缩略图），`<sharp>` 直接拒绝（QQ 没有频道提及）。`message.create` 的 `referrer` 等价于 `<quote>`。

收到的 `message.content` 是**内层片段**，和 `@satorijs/element` 的 `toString()` 一致：纯文本是转义后的裸文本（`help`，不是 `<text>help</text>`），媒体才是标签，没有外层 `<message>` 包装。之前包了一层 `<message>`，NoneBot 会把整条消息解析成一个 `RenderMessage` 节点，引用检测与 @ 检查都看不到真正的段——这是对接 NoneBot 时实测暴露并修掉的。

`upload.create` 收 `multipart/form-data`（≤32MB、≤8 个文件），文件落到 `qqproto\data\upload\`，回 `file:///<绝对路径>` —— 直接塞进 `<img src>` 就能发出去。`message.list` 支持 `next`（下标游标）/`order`/`direction` 翻页；WS 的 IDENTIFY 带 `sn` 时会补发它错过的帧（环形缓冲 200 条，只包含当时有客户端在线的那些——没人听的时候不占 sn）；HTTP 加了 CORS 预检（`OPTIONS` → 204），浏览器里的 Satori 客户端也能用。

> 这一轮新接上的东西里，**离线验过、真机没验过**的是：replyElement 的发送形状（照 NapCat 的同一份字段写的）、faceElement 的发送形状、`guild-member-*` 事件（灰条元素照 NapCat 的 `TipGroupElement` 枚举）、`set_msg_reaction` 系的表情回应、`upload.create` 的端到端（真机上传只看过 `message.create` 带 `<img>` 那条）。都是"发错了会明确报错"，不会静默丢。

映射上还有一条：`message.get/list` 只读协议端内存里最近 2000 条事件，不读消息数据库、不拉历史。

QQ 内核把 @ 存成 uid，Satori 侧统一用 QQ 号：协议端会先查好友/群成员缓存把 uid 换回 QQ 号，查不到才保留 `u_xxx`，所以刚进群、还没同步过成员列表的人可能被写成 uid。

自测（会真实发一条私聊再撤回，只对自己控制的账号跑）：

```bat
node qqproto\test\satori-smoke.js --token yourtoken --channel 10000002
```

典型输出：

```
PASS  health — {"uin":10000001,...}
PASS  login.get — 10000001
PASS  friend.list — 2 friends
PASS  guild.list — 1 groups
PASS  gateway READY
PASS  message.create — 7700889304421466889
PASS  gateway message-created — 1 events
PASS  gateway message-deleted
ALL PASS
```

### 接 NoneBot（`nonebot-adapter-satori`）——真机跑通

`examples\nonebot-satori\` 是一个最小工程：`bot.py` + `.env` + `plugins\help_ok.py`（整条消息是 `help` 或 `/help` 时回 `ok`），用官方的 `nonebot-adapter-satori` 1.3.0 连 `ws://127.0.0.1:5141/v1/events`，驱动的是本仓库起的 QQ 实例。先 `qq_start.bat`（无头/有头都行）把 QQ 和协议端跑起来，再：

```bat
cd examples\nonebot-satori
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
set PYTHONUTF8=1
.venv\Scripts\python bot.py
```

看到 `Bot qq:<uin> connected` 就通了；然后在 QQ 里给那个号发 `help`，它回 `ok`。日志里两条**预期内**的噪声：`send`（自己发出的回显）在适配器里没有对应事件类，会打 `Unknown payload type: send`；桥掉线时 `login-updated` 的 status 3/4 会被它的 `Event.login` 校验挡掉（它的模型只收 ONLINE），不影响正常收发。Windows 控制台默认按 ANSI 码页写日志，中文昵称会变成 `？？？`，`PYTHONUTF8=1` 后就是 UTF-8。

**没有第二个账号也能验**：调试页加了一个合成事件入口（只在回环调试端口上、要 `X-Debug-Call: 1`），把一条假消息喂进桥让它走完整的事件链路；它自己不发消息，机器人回复了才是真消息：

```bat
curl -X POST http://127.0.0.1:5151/api/emit-test ^
  -H "X-Debug-Call: 1" -H "Content-Type: application/json" ^
  -d "{\"text\":\"help\",\"uin\":<你的另一个号>}"
```

这一轮对接实测暴露并修掉了四处：WS upgrade 不再要求 token（改为 IDENTIFY 校验，否则 NoneBot 根本连不上）；`message.content` 去掉 `<message>` 包装与 `<text>` 节点；READY 的 `proxy_urls` 用回 spec 的 snake_case；事件补齐 `member`/`user`/`created_at`（`guild-member-request` 要 member、`message-deleted` 要顶层 user）。另外内核的 `sendMsg` 返回的 Promise 曾在消息已经发出去（回显都到了）之后 30 秒都不落地，导致整个 `message.create` 超时——桥现在以 `onAddSendMsg` 回显和内核结果谁先到为准（10 秒兜底），不再假等 Promise。

## OneBot v11 协议端

OneBot 与 Satori 跑在同一个进程里，共用 `qqproto/core` 的动作与缓存，只是外面多了一层 v11 语法。目的是让现成的机器人框架（NoneBot2 的 `OneBotV11`、Koishi 的 `adapter-onebot`、XiaoHei/微-群宝 之类）直接连，不用再写适配。

四种传输，任选其一或同时开：

| 传输 | 参数 | 方向 | 说明 |
| --- | --- | --- | --- |
| HTTP 服务端 | `--ob-port 3000` | 框架调过来 | `POST /{action}`、`GET /{action}?...`、`POST /` 带 `{action,params,echo}` |
| WebSocket 服务端 | `--ob-ws-port 3001` | 框架连过来 | `/` 收事件也能发动作，`/api` 只发动作 |
| HTTP 事件上报 | `--ob-report <url>` | 协议端推过去 | 带 `X-Self-ID`，可选 `X-Signature: sha1=HMAC-SHA1` |
| 反向 WebSocket | `--ob-reverse-ws <url>` | 协议端连过去 | 握手带 `X-Self-ID`、`x-client-role: Universal`、`User-Agent: OneBot/11`、`Authorization: Bearer`，断线 5 秒重连 |

`--ob-http-ws` 可以让 HTTP 端口顺便接受 WebSocket 升级（NoneBot 的 HTTP+HTTP-client 模式）。鉴权与 Satori 一样支持 `Authorization: Bearer <token>` 或 `?access_token=<token>`，不匹配一律 401。

### 动作覆盖

已路由 79 个动作（`qqproto/protocols/onebot11/actions.js`）。前两组是已经拿真机 QQ 验过的；后面几组是这一轮按 NapCat 的内核调用形状补上的，**只读的那批已经真机跑过 15 项全 PASS**（见下面「真机分级验证」），写侧能当场恢复的那批也跑过一整轮（21 PASS / 1 FAIL，群头衔是本机做不到不是没验）。

```
元信息     get_status get_version_info get_login_info
           can_send_msg can_send_image can_send_record can_get_http_file can_handle_url_unsafe_tags
联系人     get_friend_list get_group_list get_group_info get_group_member_list get_group_member_info
           get_stranger_info get_user_info set_friend_remark delete_friend get_buddy_list
收发       send_private_msg send_group_msg send_msg get_msg delete_msg
           get_group_msg_history get_friend_msg_history
           send_group_forward_msg send_private_forward_msg
标记已读   set_msg_read mark_msg_as_read mark_group_msg_as_read      （真的调 setMsgRead）

群管理     set_group_name set_group_remark set_group_card set_group_special_title
           set_group_role set_group_admin set_group_kick set_group_ban set_group_whole_ban
           set_group_leave get_group_at_all_remain get_group_banned_list get_group_shut_list
           get_group_detail_info get_group_level_info
请求处理   get_group_system_msg get_group_add_request set_group_add_request
           get_friend_requests set_friend_add_request
           mark_group_notify_as_read clear_friend_notice
消息级     set_msg_reaction del_msg_reaction set_essence_msg unset_essence_msg
           get_essence_msg_list send_like          ← 列表读不到：内核不答，回 1400
群公告     send_group_notice get_group_notice set_group_announcement
           del_group_notice delete_group_notice   ← 列表读不到：本机实测内核只回默认信封，回 1400
群文件     get_group_file_list get_group_file_count del_group_file upload_group_file
           create_group_file_folder delete_group_file_folder rename_group_file_folder move_group_file
文本工具   translate_enzh ocr_image（只吃本机已存在的路径） image_ocr
```

上面这批里**只读的那一行已真机实测**（`get_group_system_msg`、`get_friend_requests`、`get_group_file_list/count`、`translate_enzh`、`ocr_image`，加群管理段的 `get_group_shut_list`、`get_group_at_all_remain`、`get_group_detail_info`、`get_group_level_info`）；写的那一排里能当场恢复的也实测过（禁言+解除、改群名、改群备注、设管理员+取消、申请处理、群文件目录建/改名/删、发图片、发群文件），仍只过离线假内核的是踢人、退群/解散、删好友、点赞、转发、发公告与删公告、设精华、表情回应、群文件的删除与移动。

权限类失败按 NapCat 的取值翻译成 OneBot retcode：内核回 `result=120101005 / ERR_NOT_GROUP_ADMIN` 这类会是 `1401`，引用了本 QQ 版本没有的方法会是 `1400`，桥侧缓存里没有这条消息会是 `1404`，其余 `1200`。

仍然显式拒绝（回 `1400` + 一句原因，比"未知动作"好排查）的能力只有这四类，都是架构上不做的事：

| 动作 | 为什么不做 |
| --- | --- |
| `upload_private_file` `set_qq_avatar` | 群文件已经能发（同一招：落进客户端 `File/Ori` + `fileElement`，见「发文件」一节）；私聊文件与头像还没验——头像的 `setHeader` 参数不是路径，且有可见副作用 |
| `get_group_file_url` `get_group_honor_info` `get_vip_info` `send_group_sign` `get_message_like` | 要手拼 OIDB 数据包 |
| `get_online_clients` `get_risk_tips_info` `get_school_clockin` 等 | 要拿账号 cookie 去请求 qun.qq.com |
| `get_forward_msg` `get_forward_msg_single` `get_collection_list` | 要读 QQ 的本地消息数据库 |

信封固定是 `{status, retcode, data, message, wording, echo}`，retcode 沿用 NapCat 的取值：`0` 成功、`1200` 内部错误、`1400` 参数错误/未实现、`1401` 权限不足、`1403` 令牌错误、`1404` 资源不存在。

### 事件覆盖

```
message      private / group        收到消息（sub_type: friend / other / self / group）
message_sent private / group        自己发出的消息，默认不广播，--ob-report-self 打开
notice       group_recall / friend_recall / offline   撤回与掉线
request      friend / group         加群申请与好友申请（flag 可直接回传给对应 set_*_add_request）
meta_event   lifecycle(connect/enable/disable) + heartbeat(默认 30s)
```

`request` 事件是这一轮新加的：QQ 把加群审批放在 `onGroupNotifiesUpdated`、好友申请放在 `onBuddyReqChange` 里推过来，同一个请求会被反复推，桥侧按 `seq`/`reqTime` 去重后只报一次，`flag` 就是这两个值，`set_group_add_request` / `set_friend_add_request` 原样回填即可（和 NapCat 一样，处理前会拿 flag 回查一遍申请列表，顺便确定它在哪一屏）。同样**未实测**。

`message_id` 不是 QQ 的原生 msgId。QQ 的 msgId 是 64 位十进制串（如 `7700907345670587295`），超过 JS 安全整数，而 v11 要求它是 number，所以协议端维护一张自增映射表（`core/message-unique.js`，落盘在 `--ob-state`，重启后同一个原生 id 仍然换回同一个数字）。`get_msg`/`delete_msg` 认这个数字，返回体里另给 `real_id` 放原生串。

消息段：`text`、`at`、`image` 双向可收发；`record video file json forward face mface reply` 只读——收到能解析成对应段，发出去会明确回 1400（上传要 secapi 握手，还没做，见「下一步」第 2 项）。收到的图片段多带两个字段：`path` 是客户端已经下载到本机的文件（原图在 `Pic/<yyyy-mm>/Ori/<md5><ext>`、只有缩略图时在 `Thumb/<md5>_<n><ext>`），`thumb` 表示给的是不是缩略图；把这两个字段原样回传给发送接口就能把这张图再发出去。发图时 `file` 也认 `file://` / `base64://` / `data:` / `http(s)`，协议端会先落进自己的图片缓存再交给桥（Zhenxun 的 `IMAGE_TO_BYTES=True` 走的就是 base64 这一路）。`--ob-format string` 会把 `message` 也输出成 CQ 码；`raw_message` 始终是 CQ 码。@ 目标在 QQ 内核里存的是 uid，协议端会用好友/群成员缓存反查成 QQ 号，查不到才留 `u_xxx`。

### 接 NoneBot（`nonebot-adapter-onebot`）——真机跑通

`examples\nonebot-onebot\` 是 OneBot 版的最小工程，插件和 Satori 那个一模一样（`plugins\help_ok.py`：整条消息是 `help` 或 `/help` 就回 `ok`），官方 `nonebot-adapter-onebot` 2.4.6（nonebot2 2.5.0）以**正向 WebSocket 客户端**连 `ws://127.0.0.1:3101/`，token 走 `Authorization: Bearer`：

```bat
qq_start.bat                          :: 在 5151/config 开 HTTP 3100 + WS 3101；首次也可 --protocol onebot 预置
cd examples\nonebot-onebot
python -m venv .venv
.venv\Scripts\python -m pip install -r requirements.txt
set PYTHONUTF8=1
.venv\Scripts\python bot.py
```

`.env` 里要三样：`DRIVER=~httpx+~websockets`、`ONEBOT_ACCESS_TOKEN=<协议端 --token>`、`ONEBOT_WS_URLS=["ws://127.0.0.1:3101/"]`。nonebot2 2.5.0 不会自动带驱动依赖，`httpx` / `websockets` 必须自己装（requirements 里已列），少了会在 `nonebot.init()` 直接抛 `Please install httpx first`。

看到 `OneBot V11 | Bot 10000001 connected` 就通了。真机验证：合成一条来自 `10000002` 的私聊 `help` → 日志 `[message.private.other]: Message 5 from 10000002 'help'` → matcher 命中 → `Calling API send_msg` → `send_msg` 回 `retcode 0` → matcher `running complete`，QQ 侧真实发出 `ok`（缓存里能看到 outgoing 回显）。**这条链路零报错**——比 Satori 适配器干净，没有 `Unknown payload type` / `login-updated` 校验那类噪声。同时验了 HTTP 传输：`get_login_info` / `get_status` / `get_version_info` 都是 `retcode 0`。

一个容易踩的点：Satori 和 OneBot 两个 NoneBot 工程**同时**跑在同一个账号上时，一条 `help` 会收到两份 `ok`（两个 matcher 都命中）。调试时只留一个。

### 发图片是怎么发生的

不写 Highway、不碰 secapi、不拿 cookie，靠的是内核自己就会给图片做上传：把文件放进客户端自己的媒体树，再交一个和客户端一样的 `picElement` 给 `sendMsg`。三步都在桥里（`scripts/proto_bridge.js` 的 `imageInfoOf` / `picOriDir` / `stagePic` / `buildPicElement`）：

1. 读本机文件算 `md5`、大小、宽高（PNG 读 IHDR，JPEG 扫 SOF 段），目标目录取 `getRichMediaService().getPicTmpPath()` 里 Pic 那一项往上两级再拼 `<yyyy-mm>/Ori`，把文件按 `<md5><ext>` 复制过去（同名已存在就不重复复制）。
2. 构造 `picElement`：字段逐个照真机抓到的那条（`scripts/capture_send_shape.js`）——`fileName` 必须就是 `<md5><ext>`、`original: true`、`picType: 1000`、`md5HexStr`/`sourcePath`/`fileSize`（字符串）都填上，`thumbPath` 给一个空 `Map` 也能发；缩略图是客户端显示层的事，不属于上传。
3. `msgService.sendMsg('0', peer, elements, new Map())`，内核随后自己发起上传，桥等 `onMsgInfoListUpdate` 里带回的 `guildId` 作为发送确认。

真机验过三种写法：OneBot 段数组、OneBot 的 `[CQ:image,file=<本机路径>]` 串、Satori 的 `<img src="<本机路径>"/>`，群 20000001 里 `retcode 0` 且 `message_sent` 事件正常带出图片段，一条 640×360 的 PNG 从请求到确认约 18 秒。图片来源现在按 NapCat 的口径收：本机路径 / `file://` / `base64://` / `data:` / `http(s)` 都行，非本机的由协议端先解码或下载到 `qqproto/data/media/<sha256>.<ext>`（30 MB、30 秒、最多 5 次跳转，只认真实 PNG/JPEG/GIF/WebP/BMP 字节，一周前的缓存会清掉），再把手里的本机路径交给桥；桥和内核本身仍然只读本机文件。发一张图会往 `Documents/Tencent Files/<uin>/nt_qq/nt_data/Pic/<yyyy-mm>/Ori` 落一份副本，这是客户端自己的目录。

两个弯路记在这里，因为都像"形状不对"而都不是：`fileName` 用了原始文件名而不是 md5 名会失败；更大的坑是拿一个**根本发不出去的对端**试——10000003 不是好友且临时会话被关，这种 peer 会回 `fileErrCode 2006003 / fileSrvErrCode 0`（服务器压根没收到），看起来特别像上传接口的问题。

### 收图：字节就在客户端自己的目录里

收下来的图不需要任何下载接口。客户端把原图存成 `nt_data/Pic/<yyyy-mm>/Ori/<md5><ext>`、缩略图存成同月 `Thumb/<md5>_<n><ext>`（这台机器上逐个文件比对过：**文件名就是文件内容的 md5**），所以桥在把图片元素转成段的时候顺手找一遍：先看元素自己带的路径（`sourcePath`/`filePath`/`thumbPath` 的 Map 值），没有再按 md5 扫最近 6 个月的 Ori、最后退到 Thumb。找到就把绝对路径放进 `path`、把"这是缩略图"放进 `thumb`；找不到就留空，不假装有。

真机验证：拿一张早先收到的图（`2677932547…png`，就是客户端下载下来的原图）走 `emit_test` 的 `image_md5` 钩子，从桥的转换一路到 OneBot 事件，`message[1].data.path` 就是 `…\Pic\2026-10\Ori\2677932547….png`，`thumb:false`；`raw_message` 里也带 `path=`。没下载过的图（编造的 md5）回空路径。只找到缩略图时 `thumb:true`、给的是 `Thumb/<md5>_0.jpg`。**取不到的一种情况**：客户端压根没下过这张图（只有服务器地址），这时段落里 `url` 可能仍是空的——强制下载要拿收到的 `fileUuid` 去试 `downloadFileForFileUuid(peer, fileUuid, …)`（3 参数），还没有真数据可试。

### 发文件：同一招，元素更小

`upload_group_file` 走的是和图片同一套“落盘 + 交给客户端”的路，只是元素更小：

1. 算 md5、大小、文件名（没扩展名就补上）；
2. `getMsgService().getRichMediaFilePathForGuild({md5HexStr, fileName, elementType: 3, elementSubType: 0, thumbSize: 0, needCreate: true, downloadType: 1, file_uuid: ''})` 给出 `nt_data/File/Ori/<md5><ext>`——注意文件**没有月份目录**，和 `Pic` 不同；复制过去（已存在就不重复复制）；
3. 元素只有四个字段：`{elementType: 3, fileElement: {fileName, folderId, filePath, fileSize}}`，`fileSize` 是字符串，`folderId` 为空表示根目录；
4. `sendMsg` 后内核自己上传，结果走异步回调 `onRichMediaUploadComplete`（`fileErrCode 0` + `fileId` + `totalSize`）。发送出来的元素里 `fileUuid` 始终是空串，所以 `file_id` 只能从这个回调拿——桥会等它（120 秒上限），失败时把 `fileErrCode/fileErrMsg` 原样抛出，不谎报成功。
5. 回调说成功之后，桥把**这次发送自己拷进去的那一份**删掉（`fileErrCode 0` 才删）。Windows 上回调先到、句柄后放，第一次删除常报 `EPERM`，所以每 2 秒重试、最多 10 轮；真机上还遇到过一次上传其实成功但回调没来，所以发送被内核接受后 3 分钟还会兜底扫一遍（正常路径已删掉时是无害的空操作）。发送前就已经在 `File/Ori` 里的文件一律不动——那可能是客户端的缓存或收到的消息。图片同理，只是不阻塞发送：上传报告到了再删 `Pic/<yyyy-mm>/Ori` 里的那份。这一步和 NapCat 的 `deleteAfterSentFiles` 是一个意思，只是我们有内核回调当"读完盘了"的信号。`upload_group_file` 的 RPC 超时放宽到 180 秒（曾实测有一次 20 秒默认值内没传完）。

真机：测试群 20000001 里一个 100 字节的 txt，`retcode 0`、`file_id /c4864ccb-…`，`get_group_file_list` 里随即出现（busId 102、parent `/`），`message_sent` 事件带 `[文件]`，从请求到事件约 10 秒；随后 `delete_msg` 撤回 + `del_group_file` 删除，列表回到 0。私聊文件没验，语音要先 silk 编码、视频要先抓缩略图（NapCat 用 ffmpeg），都还没做。

`get_msg` 与两个 history 动作只读协议端内存里最近 2000 条事件，不会去翻 QQ 的消息数据库或历史，所以进程重启后它们是空的。同理，精华、表情回应、转发这些按消息寻址的动作，只能用**注入之后亲眼见过的那条消息**——桥把内核事件里的 `msgSeq`/`msgRandom` 存进了事件缓存，NapCat 靠读数据库拿这两个值的地方在这里换成了读缓存。

### 托盘模式：只留一个图标

QQ 是 Electron，前端和通知都在我们注入的这个进程里，所以不需要无头启动也能把界面收干净：

```bat
node scripts\qq_window.js status
node scripts\qq_window.js quiet
node scripts\qq_window.js quiet --no-mute
node scripts\qq_window.js show
node scripts\qq_window.js hide
```

`quiet` 做这几件事，全部走 Electron 的公开对象，不碰内核：

1. 把现有的每个 `BrowserWindow` 都 `hide()`，托盘（`Tray`）原样留着；
2. 监听 `browser-window-created`，之后新冒出来的聊天/通知窗口同样隐藏，并给每个窗口挂 `show` 监听——即使从托盘点开，也会立刻再藏起来；
3. `flashFrame`、`Tray.displayBalloon`、主进程 `Notification.show` 在 quiet 期间变成空操作；
4. 给每个页面注入一个带开关的 `Notification` 包装（页面里的 web Notification 也不会弹）；
5. 默认把所有 renderer 静音（`--no-mute` 可关），`show` 时只恢复 quiet 自己静音的那几个。

登录/扫码窗口不会被藏（URL 含 `login`/`qrcode` 或标题含"登录"），避免重启后没法扫码。状态是进程内的，QQ 重启后要重新执行一次；`show` 会退出 quiet 并把主面板拉回来。桥里对应的是 `qq_window` 动作（`status|hide|show|quiet`），OneBot 没有这个标准动作，所以用脚本调。

真机验过：主窗口 `hide()`/`show()` 都生效；quiet 下从进程里调用 `win.show()`，400ms 后 `isVisible()` 又是 `false`；四个窗口全部静音；主面板页面里 `window.__qqhookQuietNotification` 和 `__qqhookQuietMode` 都为真。**还没验的一件事**：真来一条消息时 QQ 到底走窗口、web Notification 还是 Windows 原生 toast——前三条路径已经堵住，原生 toast 需要另一个号发消息才能确认；如果确认是原生 toast，再补一个按 AUMID 关通知的开关。

#### 连托盘都不要：自己拉起 QQ（launch 模式）

`quiet` 仍然会建托盘，只是把窗口收起来。要让托盘**根本不存在**，就得赶在 QQ 的主进程创建 `Tray` 之前注入：

```bat
:: QQ 必须先退出（当前会话里 bin\qqhook.dll 被锁，新版可能叫 qqhook-next.dll）
node scripts\qq_launch.js --uin 10000003 --dll bin\qqhook-next.dll
node scripts\qq_launch.js --uin 10000003 --keep-tray
node scripts\qq_launch.js --uin 10000003 --no-quiet --no-bridge
```

`qq_launch.js` 调 `qqinject --launch`，顺序是：

1. `CreateProcessW(QQ.exe, ..., CREATE_SUSPENDED)`，命令行带 `--enable-logging -q <uin>`；
2. 主线程还停着的时候把 `qqhook.dll` 注进去，校验模块确实在模块列表里，再 `ResumeThread`；
3. 启动环境带 `QQHOOK_TRAY=0`。DLL 的 pipe 线程等 `QQNT.dll` 出现，把它导入表里的 `shell32!Shell_NotifyIconW` 换成自己的函数。QQ 第一次建托盘时 `NIM_ADD` 返回成功，但 Windows 从不加图标；之后 tooltip/气泡走的 `NIM_MODIFY` 也一起吞掉。JS 里的 `Tray` 对象还在，QQ 的关闭到托盘逻辑不会因为拿不到对象报错，但通知区域里没有任何图标；
4. 等 `process.mainModule` 出现（QQ 的 app main 已经加载）再装 `proto_bridge.js`。如果内核 session 还没建好，桥会每秒重试，不把安装判失败；hello 也会等登录列表里有真实账号再发；
5. 默认再跑一次 `qq_window.js quiet`，把 BrowserWindow 也藏起来。

这和 NapCat 的 boot 一样用了“挂起 → 注入 → 恢复”，但**没有改 QQ 的 `resources/app/package.json`**，也不像 NapCat 那样绕开 QQ 的前端主进程：我们保留完整 QQ，只吞掉托盘的 Shell API。代价是托盘图标没法再点：想恢复主面板用 `node scripts\qq_window.js show`，想彻底回到普通模式就用 `--keep-tray` 重启。`trayhook off` 只会恢复导入表，不会补建已经错过的图标；要图标就重启（不带 `QQHOOK_TRAY=0`）。

手动版：

```bat
bin\qqinject.exe --launch "C:\Program Files\Tencent\QQNT\QQ.exe" --uin <uin> --dll bin\qqhook-next.dll --bridge-only --port 47840
bin\qqinject.exe --pid <pid> --cmd "trayhook status"
bin\qqinject.exe --pid <pid> --cmd "trayhook off"
```

`trayhook status` 回 `installed=1 blocked=1 slots=1 calls=N last=0 qqnt=loaded`：`calls` 是 QQ 被吞掉的 `Shell_NotifyIconW` 次数，`last=0` 是 `NIM_ADD`。钩子是进程内的，DLL 注入前不生效；attach 模式默认不装，只有 `QQHOOK_TRAY=0/off` 或手动 `trayhook on` 才装。

离线验证用 `bin\testhost.exe` 的托盘探针（`/guard:cf` 编译）：注入 `qqhook-next.dll` 后 `trayhook on`，探针的 `NIM_ADD` 返回成功但 `Shell_NotifyIconGetRect` 找不到图标；`trayhook off` 后下一次就真的出现。这条同时证明 CFG 进程里换 IAT 指向不会被拦。

#### 换托盘图标

```bat
node scripts\qq_tray.js status
node scripts\qq_tray.js set C:\path\icon.png --tooltip "bot"
node scripts\qq_tray.js reset
```

Electron 把 `Tray` 实例藏在原生层，没有 `getAll()`；桥是在 QQ 建好托盘之后才注入的，所以拿不到现成引用。桥在安装时会给 `Tray.prototype` 的 `setImage`/`setToolTip`/`setContextMenu` 挂一层捕捉，QQ **下一次更新托盘**（收消息、状态变化）时把 `this` 存下来，之后 `set` 就能用。自定义图标期间会吞掉 QQ 自己的 `setImage`，避免来消息时又被换回去；`reset` 用捕捉到的上一张 QQ 图标恢复，同时恢复 quiet 前的 tooltip。`status` 里的 `captured:false` 就表示还没等到那次更新。

如果 QQ 是用 launch 模式（`QQHOOK_TRAY=0`）启动的，托盘图标根本没有创建，`set` 只是更新一个不存在的图标；要换图标请用 `--keep-tray` 重启。

`v8.queryObjects(Tray, {format:'summary'})` 只能数出 2 个实例和摘要，`format` 不支持返回引用；inspector 在这个 Electron 里不可用（`ERR_INSPECTOR_NOT_AVAILABLE`）。托盘的宿主窗口类名是 `Electron_NotifyIconHostWindow`；QQ 的托盘 PNG 在 asar 里是加密的，所以 reset 不靠解包资源。

### 有头模式（`--headed`：正常 QQ 窗口 + 托盘，同样自动起协议端）

> 这是**调试/兼容路径**：它注入 `bin\qqhook.dll` 并走 V8 eval，会在 QQ 进程里留下常驻模块和控制管道。生产默认仍然是无头 boot 主程序（见上）。

和无头共用同一个启动器和同一个控制台，只是把"自己当 Electron 主程序"换成"让 QQ 正常起，再把钩子装进去"：`qqinject.exe --launch` 挂起启动 `qqclient\QQ.exe`，注入 `bin\qqhook.dll`，恢复后由注入器等 QQ 的主程序就绪，再把 `scripts\proto_bridge.js` 装进去（`--bridge-only`）。QQ 的窗口、托盘、renderer、GPU 全是它自己的，扫码/登录也都在 QQ 的窗口里完成。链路更稳：跑的就是官方原本的启动路径，不经过我们那份内存重定向（也就不存在"官方改校验就跟着坏"的问题）。

```bat
qq_start.bat --headed              :: 正常 QQ 窗口 + 协议端；登录在 QQ 窗口里
qq_start.bat --headed --protocol both   :: 同上；首次可预置 OneBot，之后在 /config 里配
```

和默认的无头模式相比：

- **不生成** `app.package.json` / `app.main.js` / `app.config.json`，也不碰 `--data` / `--user-data`（那两项只属于无头；有头用 QQ 自己的目录，传了会打一行 note 并忽略）。`--trace`、`--no-qr`、`--ascii` 同理只对无头有意义。
- **二维码**：没有 `qrcode.png` 可打，`qr` 会直接告诉你"看 QQ 自己的登录窗口"。启动器从**协议端日志**判断状态：`QQ bridge connected`（桥进来了）→ `QQ bridge ready: <uin> <nick>`（账号就绪）；控制台把这两行照常转成 `[ep]`。
- **账号缓存**：有头模式从 `QQ bridge ready` 那一行拿到实际登录的号，写进自己的 `<profile>\account-headed.json`（`via: headed`），下次启动从这里取 `-q <uin>`；无头仍然用 `<profile>\account.json`（`via: quick/qr`）。**两份缓存是故意分开的**：有头跑的是 QQ 自己的配置目录，无头用的是 `--data/--user-data` 那套，实测两个客户端同时登录的是两个不同的号——共用一份会让下一次启动拿着对方的号去快速登录。`--forget` 只清当前模式那一份。
- **窗口别乱关**：关窗口通常只是收到托盘（QQ 自己的行为）；真正退出 QQ 或 `stop`、Ctrl+C 两次才会收掉整套。控制台仍然是实例前台，`status` 会写 `有头 QQ` 与桥/账号状态，`log` 只剩 `[ep]` 一份（无头才有 `[qq]`）。
- **停止**：`headless_stop.js` / `qq_stop.bat` 一视同仁——按 pid 文件与镜像名核对后 `taskkill /T /F`，有头的 renderer 子进程一起走。

和正常 QQ 并存的安全边界不变：只认 `qqclient\QQ.exe` 这一份（按镜像路径），不会挡住你的正常客户端，也不会去注入它。

### 无头 QQ（NapCat 式，不建任何窗口）——已跑通，含对官方文件校验的处理

**先说结论**：跑通了。难点是 QQ 9.9.36 会**校验 `resources\app\package.json` 的内容**：只要它的字节和官方不一样（哪怕只把 `main` 改一个字段），QQ.exe 的引导存根就弹「文件已损坏，请重新安装 QQ」并 `ExitProcess(0)`，我们的 `app.main.js` 连被 stat 的机会都没有。过法见下，**不改 QQ 任何文件，也不 patch 腾讯的代码**。

真机 trace（`--trace`，见下）显示存根的顺序是：`versions\config.json` → stat/open 并 `LoadLibraryExW` `versions\<v>\QQNT.dll` → `resources\app\application.json` → `resources\app\package.json` → 校验（QQ.exe 自己在 stdout 打一个 64 位十六进制摘要和一个 `0`）→ 决定继续或退出。`resources\app\application.json` 是一组 base64 签名，键恰好是 `application.asar`、`wrapper.node`、`major.node`、`package.json`——这四个文件的内容都是被验的。

三条实测的补充事实：

- 把 `app.package.json` 换成与官方**字节完全一致**的副本，同一个重定向就正常启动完整 UI（多进程、读 `AppData\Roaming\QQ`），证明验的是内容而不是路径；
- 入口 JS 在 asar 里按偏移读：trace 只见反复 `CreateFileW ...\resources\app\application.asar`，从不出现 `application.asar\app_launcher\index.js` 这样的路径，所以也没法按内层文件名劫持（而 asar 本身同样在签名清单里）；
- `ELECTRON_RUN_AS_NODE=1 QQ.exe <脚本>` 被存根无视，照旧 `[preload] register done. major.node / wrapper.node` 并起完整 UI，没有可用的 node 模式。

还有一个坑要记住：那次 `ExitProcess(0)` 之后进程卡在退出流程里，`Stop-Process` 和 `taskkill /F` 都报「没有该处理器的实例」，只能等它自己走完。无头实验失败一次就可能留一个杀不掉的 `QQ.exe`。

**过法**：校验器和 Node 都要读 `package.json`，而**校验器一定先读**（它在存根阶段，Node 在它后面）。所以 `appinit.dll` 加了一道闸门：第一次打开 `resources\app\package.json` 原样放行，让存根哈希到磁盘上真正那一份；从第二次读开始才换成我们改了 `main` 的副本。`app.main.js` 不参与这套——它在 QQ 目录里本来就不存在，没有"真文件"可校验。日志里能看见这条分界：

```
create: package.json verifier read passed through
create: package.json -> app.package.json (armed)
create: app.main.js -> app.main.js
```

这也顺带解释了 NapCat 为什么能工作：它的 `NapCatWinBootHook.dll` 只 hook `CreateFileW` + `GetFileInformationByName`，存根那次校验读走的正是它没覆盖的路径，等于天然放行；我们 hook 的接口更全，反而必须自己加这道放行闸门。

还核实过一条**没有采用**的路：校验代码在 QQNT.dll 里（社区特征码 `48 89 CE ... 48 8B 49 18 E8` 在本机 9.9.36-53644 的 `QQNT.dll` 中唯一命中于文件偏移 `0x510197`，QQ.exe 里没有；而 `QQNT.dll` 不在那四个签名项内），LiteLoader 的 `QQNTFileVerifyPatch` 就是把那个 `call` 原地换成 `mov eax,1`。不采用的理由很实在：社区 issue 里"装了 LL 的 patch 或框架就会被检测死号"的说法，让这条路的风险明显大于收益——而且我们已经有不改二进制就能过的方法。

下面保留原设计说明——离线侧由 `scripts\boot_offline_test.js` 钉住（第一次读放行、第二次读取重定向、还原后回原文件、DLL 真卸载）。

前面两种办法都保留完整 QQ，只是把窗口/托盘藏起来，renderer、GPU、聊天页面全都还在。要连 renderer 都不要，就得让 Electron 加载我们自己的 app main。NapCat 靠改 `resources/app/package.json`；这里不落盘，改成**启动时在内存里重定向这两个文件的打开与属性查询**：

日常就用仓库根目录这两条，别的都不用记。新克隆的机器只多一步：先跑 `build.bat` 和 `build_boot.bat`（`bin\` 里的 `qqinject.exe`、`headless\appinit.dll` 都是构建产物，不入库，要 MSVC Build Tools 的 C++ 工作负载）；QQ 本体不用准备，`qqclient\` 是空的就自己下载并解出来。

```bat
qq_start.bat                       :: 起无头 QQ + 协议端；用缓存账号不扫码，协议端口默认不开
qq_start.bat --headed              :: 换成正常 QQ 窗口（有头），其余一模一样
qq_start.bat --uin 10000002      :: 换成本机历史里的另一个号（并更新缓存）
qq_start.bat --qr                  :: 这次强制扫码
qq_start.bat --forget              :: 忘掉缓存账号
qq_start.bat --protocol both       :: 首次启动就预置 Satori + OneBot（network.json 已存在时不生效）
qq_start.bat --allow-untested      :: 未验证的 QQ build 也允许写（默认只读）
qq_start.bat --no-restart          :: 协议端崩了/心跳卡住就整套停，不自动重启
qq_start.bat --read-only           :: 这个控制台的写命令（say/recall/emit）一进来就是关的
qq_start.bat --write-per-minute 10 --write-interval 500 :: 收紧或放宽桥的写预算
qq_start.bat --trace               :: 只在排查启动问题时用
qq_start.bat --detach              :: 老行为：状态打完就退出，QQ 与协议端留在后台
qq_start.bat --keep-on-exit        :: 退出这个窗口时什么都不停
qq_start.bat --no-download         :: 这台机器不许联网：qqclient\ 没客户端就直接报错
qq_start.bat --qq-file X.exe       :: 用你自己在浏览器里存下的官方安装包解出客户端
qq_start.bat --allow-mirror        :: 官方 CDN 拒绝本机客户端时，允许改用同一文件的社区镜像（会核对 sha256）
qq_stop.bat                        :: 把这两个都停掉（按 pid 文件 + 进程名核对，绝不碰你的正常 QQ）
```

**和你的正常 QQ 并存**：启动前那道"是不是已经开过"只认**这一份** `qqclient\QQ.exe`——比较完整镜像路径（`Win32_Process.ExecutablePath`），拿不到路径的进程一律不算。范围也止于这一份：其他安装即便同时在跑，launcher 既不列它们的地址，也不注入、不停止它们。`qqinject.exe --launch` 里是同一套判断：只有**同一路径**的副本才会拒启。两层都验过（用临时拷的假安装代替真客户端，免得为了测一句检查去扫码）：本机正常 QQ 在跑、又开着另一个路径的 `QQ.exe` 时，第三份副本照样走完"启动→注入失败"；反过来 `--exe` 指向正在跑的那一份会立刻被拒并报出 pid 与路径。

**这个窗口就是这个实例的前台，做成服务端控制台的样子**：ready 之后 `qq_start.bat` 不退出，`[qq]`（QQ 里的无头主程序）和 `[ep]`（协议端）的日志一直打在 `qq> ` 提示符上面。行编辑器是启动器自己写的（`scripts\lib\line_editor.js`，不用 readline），所以日志插在中间不会打乱你正在打的那半行、退格删的是一个汉字而不是它的半个字节、宽字符的光标按"格"算而不是按码点数、↑/↓ 走历史、Tab 先补命令再补参数（`say`/`history` 补 `friends`、`groups` 拿到的 QQ 号与 `g:群号`），Ctrl+C 一次是取消当前行、两次才收掉整套，Ctrl+D 空行是"输入关了"（日志照打，进程不停）。

渲染有两档，因为"控制台"在 Windows 上不是同一个东西：启动时朝终端问一句"光标在哪"（`CSI 6 n`），会答的（Windows Terminal、任何 xterm，几毫秒内回 `CSI row;col R`）就切到 VT 渲染——支持跨行重画和颜色；不回话的（Win10 的 conhost，它会把转义序列当字打出来）就留在**普通档**：只用回车、空格和"整行滑动"重画，一个转义字节都不发，颜色也是关的。`NO_COLOR`、或者输出被接到管道上时，同样只剩纯文本。

命令分四组，`help` 全列、`help <命令>` 看单个，前导 `/` 也认：

| 命令 | 说明 |
| --- | --- |
| `status`（`s`） | 一行一项：两边 pid 与存活、桥 generation 与心跳年龄、QQ build、版本闸、写预算已用/熔断、健康文件多久前写的、所有端口 |
| `uptime` / `health [json]` / `stats` | 运行时长与账号；`endpoint.health.json` 的自检（`json` 是原文）；协议端与桥的计数（内核事件、已投递、调用、发送、撤回、本分钟写）与方法覆盖数 |
| `log [qq\|ep] [n]` / `tail on\|off` / `watch [on\|off\|秒]` / `clear` | 翻两份日志的最后 n 行（文件是 append 的，所以看得到本窗口之前的历史）；实时日志开关（关掉时登录判定照跑，只是不打字）；定时打一行状态；清屏 |
| `self` / `friends [过滤]` / `groups [过滤]` / `members <群号>` / `chats` / `history <号\|g:群> [n]` | 读的都是协议端正在用的那几条调试端口路由（`/api/snapshot`、`/api/chats`、`/api/conversation`），`history` 会把 `message_id` 一起打出来给 `recall` 用 |
| `say <号\|g:群> <文字>` / `recall <号\|g:群> <id>` / `emit <号\|群> <文字>` | 真的发、真的撤、以及造一条"收到的消息"喂进事件流（框架测试用，它自己不发消息）。三个都要过 `writes`、协议端的 `allow_write` + `X-Debug-Call`、版本闸、桥的写预算这四道 |
| `writes on\|off` / `--read-only` | 控制台这一层的写总开关；`--read-only` 让它一进来就是关的（只读观察） |
| `qr` / `restart endpoint` / `ports` / `config` / `stop`（`end`） | 重打当前二维码；只换协议端（桥会重连，generation +1）；列端口与令牌；打印网络配置页地址、配置文件位置和每个网络的实时状态；收掉整套并退出 |

**QQ 自己没了，窗口不再跟着消失**：以前 `app.fatal` 出现或 QQ 进程消失，启动器打印一句就退出、双击打开的那个 cmd 窗口跟着没了，现场也就没了（"怎么启动不起来"最难查的就是这个）。现在改成：协议端被顺手停掉（`headless_stop.js --endpoint-only`），窗口留着并切到"已停"状态——`log qq`、`log ep`、`health` 还能翻，`status` 会显示 pid 已经不在了，提示符变成 `qq[停]> `，要关就 `stop`。`--detach` 那条脚本路径没变（打完状态就交回 cmd）。

**离开它就等于收掉整套**：`stop` 或 Ctrl+C 两次会跑 `headless_stop.js`；窗口被直接点掉时，协议端进程（带 `--watch <启动器 pid>`，它本身是 detached 的，所以活得下来）连续两次确认启动器没了，就替它把无头 QQ 停掉、清掉自己的 `endpoint.pid` 与健康文件再退出。协议端进程自己没了、或它的 `endpoint.health.json` 超过 35 秒没更新，则由启动器先把它杀掉并按 1.5s→3s→6s→12s→20s 退避重启（连续健康 15 秒后预算清零），5 次还不行才收掉整套——`--no-restart` 才是旧的"一崩就全停"。`--detach` 回到旧行为（打印完就交回 cmd，收尾靠 `qq_stop.bat`；注意 detach 后没有这个监督循环），`--keep-on-exit` 则退出时什么都不停。有头模式一样有控制台，只是没有 `[qq]` 与二维码那一份：`qr` 会说去 QQ 窗口扫，`log` 只列 `[ep]`。

起来之后直接开 `http://127.0.0.1:5151/`：账号/桥/端口状态、协议端自己的输出（含被日志级别挡在控制台外的 debug 行）、内核事件与各协议实际投递的报文、以及一个能按协议挑方法发调用的面板（好友列表、群列表、收发消息都在这里点）。QQ 式聊天界面在 `http://127.0.0.1:5151/chat`，网络配置在 `http://127.0.0.1:5151/config`。详见「协议端（qqproto）→ 调试页 / 聊天界面 / 网络配置页」。

**账号缓存**：`app.main.js` 每次登录成功都把实际进去的账号写进 `<profile>\account.json`（`uin/uid/nick/via/savedAt`），launcher 下次启动读出它并自动带上 `-q <uin>` 走 `quickLoginWithUin`，实测从下令到 `app.ready` + 协议端就绪约 2 秒、完全不扫码（有头模式没有 app.main.js，改由启动器在 `[ep]` 里看到 `QQ bridge ready: <uin>` 时写自己那份 `account-headed.json`，`via: headed`；两份缓存分开的原因见「有头模式」一节）。缓存只是"请求"，不是"保证"：内核拒绝快速登录时主程序照样落回二维码（有头就是 QQ 窗口里的码），登录成功再把缓存改成实际账号，所以 token 过期不会把流程卡死。缓存按 profile 分开放，两个实例各记各的号；它不在启动清理清单里，重启不丢。

`qq_start.bat` 里锁死了这一份副本要用到的所有隔离参数（`qqclient\QQ.exe`、profile `qqclient\headless`、数据 `qqclient\data`、Electron 目录 `qqclient\electron`、桥端口 47841），session 一 ready 就自动拉起协议端：**默认不预启任何协议端口**，只开调试页 `http://127.0.0.1:5151/`（含 `/config` 网络配置页），Satori 与 OneBot 都在配置页里打开后才会监听（首次生成 `<profile>\network.json`，以后以文件为准）。要脚本化地预置可以 `qq_start.bat --protocol both`（或 `--protocol onebot` 只开它），但文件已存在时命令行只是摆设。各 profile 的 OneBot 消息 id 状态文件按相对路径分开（`qqproto\data\onebot-msg-qqclient-headless.json`），不会和你主实例的 `onebot-msg.json` 抢同一张表。启动器打印的参数是**后写的赢**，所以你在 `qq_start.bat` 后面补的 `--protocol` / `--token` / `--uin` 会覆盖里面写死的那一份。

底层命令是 `node scripts\headless_launch.js`，参数同一套：`--headed --uin <uin> --port 47841 --start-endpoint --ep-port 5141 --protocol none|satori|onebot|both --ui-port 5151 --ob-port 3100 --ob-ws-port 3101 --token <t> [--allow-untested] [--no-restart] [--read-only] [--write-per-minute n --write-per-hour n --write-interval ms] [--trace] [--dry-run] [--force] [--wait 300] [--no-log]`。手动跑这一份副本时把路径带上：

```bat
node scripts\headless_launch.js --exe D:\qq-hook-poc\qqclient\QQ.exe ^
  --profile D:\qq-hook-poc\qqclient\headless --data D:\qq-hook-poc\qqclient\data ^
  --user-data D:\qq-hook-poc\qqclient\electron --port 47841 --start-endpoint --wait 300
```

`--uin` 只在账号已经在本机登录记录里时才会走快速登录（实测 0.3 秒返回 `quick result 0` 并直接 `QRCodeLoginSucceed`）；不传或快速登录失败就自动落回二维码，launcher 收到 `qrcode saved` 就把码打在控制台里，过期续码（最多 5 次）每续一张打一张新的；`--ascii` 换成 `##`/空格，`--no-qr` 只报路径。

要同时跑多份 QQ，就给每一份一套独立的 `--profile/--data/--user-data/--port`：`appinit.dll` 按自己所在目录找 `app.package.json`，所以 launcher 会把 DLL 复制进 profile；`app.main.js` 再把 `app.setPath('userData'/'sessionData'/'crashDumps'/'logs')` 和 session 的 `account_path` 分别指到独立目录。`qqclient\` 就是照这个做的官方 9.9.36-53644 完整副本（`QQ.exe` md5 与源一致，只删掉 `LiteLoaderQQNT`、`LiteLoaderQQNT_bak`、`beacon_report.log`），它和你正在用的主客户端各用一个桥端口（47841 / 47840），互不影响。

**没装过 QQ 也能起来**：`headless_launch.js` 发现 `--exe` 指的位置没有客户端时，会把 `scripts\qq_fetch_client.js` 当子进程跑一遍（`--qq-file/--proxy/--tool/--cache/--expect-sha256/--arch` 原样转，`--allow-mirror/--allow-installer/--allow-any-dir/--no-download` 按开关转），装完接着走原来的流程。判断标准不是"目录里有东西"，而是无头启动真正会读的那几件：`QQ.exe`、`versions\<版本>\resources\app\package.json`、同目录的 `wrapper.node`、`versions\<版本>\QQNT.dll`；`--check` 就是只看这个，缺件时退出码 3。

拿东西的顺序：先读官方页面自己用的那份配置 `qq-web.cdn-go.cn/im.qq.com_new/latest/rainbow/pcConfig.json`（读不到就走页面上的代理 `im.qq.com/proxy/domain/...`），它给出版本、更新日和 `ntDownloadX64Url`；下载用 System32 的 `curl.exe`（支持 `--retry` 与 `.part` 断点续传，`--proxy` 或环境里的 `HTTPS_PROXY/https_proxy/HTTP_PROXY` 都算）。**本机实测**：`qqdl.gtimg.cn` 对 `/qqfile/QQNTV2/...` 一律回 403 —— curl（Schannel）、Node https、WinHTTP 和走本机代理都一样，而同一个主机的老路径 `/qqfile/qq/PCQQ/...` 却给 206，也就是这是 CDN 侧对非浏览器客户端的策略，不是网络故障。所以留了两个出口：`--qq-file` 用你自己在浏览器里存下的同一个文件；`--allow-mirror` 才允许改用社区镜像 `Rodert/qq-versions`（NapCat 自己的发布流就是从这里拉同一个包），镜像的 GitHub API 会给出该 asset 的 sha256，下载后先核对再解包；官方 asset 没有公布 digest 的一律不选。

解包不跑腾讯的安装器：那个包是 `Microsoft.Windows.HummerSetup`（PDB 字符串 `...\QQInstaller\Setup3\build\Release\HummerSetup.pdb`），尾部是它自己的任务图 XML（`SetupConfigure/ShowInstallDialog/KillTencentProcess`），manifest 里写的是 `requestedExecutionLevel level="requireAdministrator"`——静默参数没人验证过，而且它会写注册表、装快捷方式、可能直接把 QQ 起起来。包体本身是 **PE 桩 + 两段 7z**：第一段只有 licence 的 rtf（本机那个包是 28 KB），第二段才是客户端树（`Files\QQ.exe`、`Files\versions\9.9.33-52230\...`，311,776,517 字节压缩 / 1,151,776,750 字节解出、1868 个文件），直接把 `.exe` 交给 7-Zip 只会解出那份 licence。所以 `qq_fetch_client.js` 自己扫 7z 签名、按 StartHeader 的 CRC32 与 `32 + NextHeaderOffset + NextHeaderSize` 校验每个候选、取最大的那段切成 `.client.7z`，再让归档工具解它；解出来的树按"能不能无头启动"验收（exit 0 与"有没有树"都不可信），通过就 `rename`（跨卷退回 `cpSync`）进 `--into`，顺手删掉 `LiteLoaderQQNT*` 和 `beacon_report.log`，切片用完就删、300 MB 的安装包留在 `--cache` 里给下次复用。

本机没有归档工具时它会自举一个：从 npm registry 取 `7zip-bin`（默认 7za，只认 7z/zip/cab/xz——正好够解第二段），按 registry 公布的 sha512 校验 tarball，用 System32 的 `tar` 展开取 `package\win\x64\7za.exe`，存进 `bin\7zip\` 并写 `installed.json` 记下包名、版本、tarball、integrity 和取出的二进制；`--no-bootstrap` 拒绝这一步，`--tool` 指你信得过的全功能 `7z.exe`（PATH 与 `C:\Program Files\[（x86）\]7-Zip` 里的会自动找到，完整 7z 优先于 7za）。`--allow-installer` 是最后一条路：按 `/S /D=`、`/ai /gm2 /InstallPath=`、`/S`、`/silent /Dir=` 逐个试跑它自己——要 UAC、会改系统，默认不开。安全边界照旧：只往本仓库里写（`--into` 指到仓库外要 `--allow-any-dir`），不碰 `C:\Program Files\Tencent\QQNT`，不动在跑的 QQ，`--dry-run` 只报计划、一个字节都不写。

真机验证过整条链：`node scripts\qq_fetch_client.js --into build\tmp\client-mirror --cache build\tmp --allow-mirror --proxy http://127.0.0.1:7890` → 官方 URL 403（curl 重试 3 次）→ 社区镜像的包已在 cache、sha256 与 GitHub 公布的 digest 一致 → 160568 处切出 297 MB 的 7z → `bin\7zip\7za.exe` 解出 → 验收通过 → 落进目标目录，报 `QQ 9.9.33-52230 ready`；launcher 侧 `--exe build\tmp\client3\QQ.exe ... --dry-run` 也确实在缺客户端时自动跑完这套并接着生成 profile（版本判定与 appid 从 `major.node` 里读，9.9.33-52230 这种没写进 `APPID_TABLE` 的版本能自己适应）。

`node scripts\qq_fetch_client_offline_test.js`（47 项）是这个文件自己的门禁：假 fetch/download/run，全离线。钉住"什么算一个客户端"（缺 `wrapper.node`、缺 `QQNT.dll`、只有版本号没目录各报各的名字）、config 主地址挂了要走代理、x86/arm64 挑对应包、镜像里没公布 digest 的不选、镜像落后官方版本时要明说换了哪个版本、7z 签名候选的 CRC 与越界校验、licence 与客户端谁大取谁、切片必须逐字节等于原区间、`matchesIntegrity` 认 sha512/sha1/shasum 三种形式、sha256 不对就停在原地不许解包、`--check/--dry-run/--no-download/--no-bootstrap/--qq-file` 都不许起网络、仓库外目录要被拦、`run 0 但没树`算失败、以及"没 `--allow-installer` 就绝不排空腾讯自己的安装器"。

`headless_launch.js` 先从 `versions\config.json` 找版本，读当前 `resources\app\package.json`，把 `main` 改写成 `./app.main.js` 存到 `bin\headless\app.package.json`，再写一个三行的入口 `bin\headless\app.main.js`（把真实目录挂到 `globalThis[Symbol.for('qqhook.root')]`，再 require `src\headless\app.main.js`）、把 `scripts\proto_bridge.js` 复制成 `core.js`，写 `app.config.json`（版本、appid、QUA、wrapper 路径、桥端口、桥 token、日志/二维码路径，以及可选的 `write_budget`），然后执行：



```bat
bin\qqinject.exe --launch "C:\Program Files\Tencent\QQNT\QQ.exe" --dll bin\headless\appinit.dll --headless --uin <uin>
```

`appinit.dll` 在 QQ 被 `CREATE_SUSPENDED` 创建、主线程还停在入口点时注入。它把主模块和 `QQNT.dll` 导入表里的 `CreateFileW`、`CreateFile2`、`GetFileAttributesW`、`GetFileAttributesExW`（以及系统提供 `GetFileInformationByName` 时的同名 API）换成自己的函数：凡是以 `resources\app\package.json` / `resources\app\app.main.js` 结尾的打开或 stat，都改成 `bin\headless` 下那份（`app.main.js` 在 QQ 目录里本来不存在，Node 解析主模块前会先 stat，所以属性查询也必须一起重定向；Node 也可能走 `CreateFile2`）；其他路径原样放行。`QQNT.dll` 是随后才加载的，所以同时挂了 `LoadLibraryExW/A`、`LoadLibraryW/A`，模块加载返回后立刻打补丁，另有轮询兜底（打中一次后从 20ms 退到 100ms）。我们的 app main 被读进去后 3 秒，钩子全部还原，DLL 自己 `FreeLibraryAndExitThread`——**QQ 的文件一个字节没改，进程里也不留下常驻的自定义原生模块**。

这个 DLL 有五条硬约束，都是真机踩出来的：

- **`/MT` 静态运行时**。QQ 安装根目录自带 `msvcp140.dll / ucrtbase.dll / vcruntime140(_1).dll`，`/MD` 构建会绑到 QQ 自己那份 CRT；实测 `/MD` 版让 QQ.exe 崩在 CRT locale（WER：`0xc00000fd @ appinit.dll`，随后 `0xc06d007e @ KERNELBASE`）。`/MT` 后 `dumpbin /DEPENDENTS` 只剩 KERNEL32.dll。
- **只 patch 安装目录内的模块**。早期版本给 `ADVAPI32.dll` 打了 3 个槽；现在按主模块目录前缀过滤，`KERNELBASE/SHELL32/uxtheme/kernel.appcore` 一律跳过（并记一行 trace）。改系统 DLL 的导入表既危险又是大 footprint。
- **每线程重入守卫**：`thread_local` 计数，钩子里再进钩子直接原样放行，不重定向；路径比较用 ASCII 折叠，不碰 `std::towlower`（钩子里不该依赖 CRT 的 locale 状态）。
- **还原前确认没有钩子在执行**，否则宁可让 DLL 常驻也不 `FreeLibraryAndExitThread`。
- **诊断开关**：profile 里有 `appinit.trace` 哨兵文件时（`headless_launch.js --trace` 会创建），每个钩子调用都记一行路径，上限 2000 行；`qqinject.exe --report-exit <ms>` 在恢复线程后等子进程并打印退出码；`--no-std-handles` 用来区分"是否设置 STARTF_USESTDHANDLES"这两种启动形状。`bin\headless\appinit.log` 由此能直接指出是谁把进程关掉的（本次是 `ExitProcess code=0 from QQ.exe+0xDDF7C`）。

`src\headless\app.main.js` 按 NapCat 的顺序驱动官方内核，不实现登录协议，只调用 QQ 自己的登录服务：

1. `process.dlopen` 加载 `wrapper.node`（QQ 已经映射的那一份）；
2. `NodeIQQNTWrapperEngine.get().initWithDeskTopConfig(...)`；
3. `NodeIKernelLoginService.get().initConfig(...)` → `addKernelLoginListener` → `connect`，等 `onLoginConnected` 和 `getMsfStatus() !== 3`；
4. `getLoginList()`；命令行带 `-q <uin>` 且账号在本地登录记录里就用 `quickLoginWithUin`，否则 `getQRCodePicture()` 把二维码写到 `bin\headless\qrcode.png`（URL 也进日志），过期自动续 5 次；
5. `getMachineGuid()` 按 QQ 的格式切好，填进 `session.init`；`NodeIQQNTStartupSessionWrapper.create()` + `NodeIQQNTWrapperSession.getNTWrapperSession('nt_1')`，`session.init(config, depends, dispatcher, listener)` 后 `startupSession.start()`；
6. 等 `onOpentelemetryInit({is_init:true})`，再 eval `proto_bridge.js`，写 `app.ready`。失败写 `app.fatal` 并退出。

看这些文件：`bin\headless\appinit.log`（重定向与卸载）、`app.log`（登录/会话每一步）、`core.log`（桥）、`app.ready`、`app.fatal`、`qrcode.png`。进程树里只剩主进程和必要的基础设施进程，没有 `BrowserWindow`、renderer、GPU 和托盘。协议端不用改，桥还是连 `127.0.0.1:47840`，断了会自己回连。

**回滚**：`qq_stop.bat`（等价于 `node scripts\headless_stop.js --profile qqclient\headless`，只认 profile 里的 `qq.pid`/`endpoint.pid`，且进程名必须分别是 `QQ.exe`/`node.exe` 才动），然后正常启动你的 QQ 就行；`qqproto` 主实例可以一直开着。想回到普通的 attach 模式，就按前面的步骤重新注入 `qqhook.dll`（`scripts\qq_launch.js`）。

**边界说明（不能保证不被检测）**：

- 不写 QQ 目录、不改 `package.json`、不建命名管道、不设环境变量；`appinit.dll` 在启动完成后卸载，`bin\headless\app.main.js` 只是一个三行入口（把真实目录放进 `globalThis[Symbol.for('qqhook.root')]` 再 require `src\headless\app.main.js`），桥日志和二维码都在 `bin\headless`；
- 启动的那几秒里，进程列表能看到 `qqinject.exe`，模块列表里能看到 `appinit.dll`；主程序是内存里的自定义 JS，进程里没有 renderer/窗口，和正常客户端本来就不同；
- 登录用的是同一个 `appid`/QUA（本版本 `537391628` / `V1_WIN_NQ_9.9.36_53644_GW_B`）、同一份机器 GUID 和本地登录记录，没有伪造设备；
- 没做模块摘链、manual map、驱动级隐藏或对抗 QQ 的客户端扫描。QQ 若做内存/模块扫描或服务端风控，仍有被发现的可能；这条路线能控制的是"少留东西"，不是"保证隐身"。只用自己控制的账号测试。

**离线验证**：一条命令 `node scripts\boot_offline_test.js`（它自己起 `bin\boottest.exe`，在它等待的 5 秒窗口里注入，再断言输出）。预期：`FIRST PACKAGE`/`FIRST MAIN` 是重定向后的内容，`FAKE PACKAGE` 和 `FAKE CREATE2 PACKAGE`/`FAKE CREATE2 MAIN` 也是（`bin\boottest\QQNT.dll` 是注入后才 `LoadLibraryW` 的替身模块，同时覆盖 `CreateFileW` 与 `CreateFile2` 两条路），`FAKE STAT` 里 package/main 的 size 正好等于重定向过去的那两份文件（这证明 Node 解析前的 stat 也被顶掉了；有现成的 `bin\headless\app.package.json`/`app.main.js` 就用它，没有就在 `%TEMP%` 造一份隔离副本，所以新 clone 只跑过 `build_boot.bat` 也能验），6 秒后的 `SECOND`/`FAKE SECOND`/`FAKE SECOND CREATE2 PACKAGE` 全部回到 `ORIGINAL_*`，`APPINIT STILL LOADED: no` 证明 DLL 已从模块列表消失，`appinit.log` 里有 `hooks restored` / `unloading appinit.dll`。另外 `node qqproto\test\headless-main-mock.js` 用假 Electron/内核把 app main 的登录、会话初始化、桥安装整条流程跑一遍，并断言 bridge token/version 确实传进了桥；`node qqproto\test\bridge-auth-test.js` 验证 bridge token 拒绝错 token、接受对 token，同时保留无 token 的调试模式；`node scripts\qr_console.js --self-test` 验二维码解码器。`GetFileInformationByName` 这条 hook 只在系统导出该 API 时安装，当前 boottest 的假模块没有导入它（真机验证时看 `appinit.log` 的 `info-name slots=`）。

### 离线校验

```bat
node scripts\boot_offline_test.js
node scripts\qr_console.js --self-test
node qqproto\test\compat-test.js
node qqproto\test\supervisor-test.js
node qqproto\test\bridge-auth-test.js
node qqproto\test\bridge-mock.js
node qqproto\test\headless-main-mock.js
node qqproto\test\onebot-actions-test.js
node qqproto\test\segments-test.js
node qqproto\test\satori-elements-test.js
node qqproto\test\satori-methods-test.js
node qqproto\test\core-send-test.js
node scripts\qq_fetch_client_offline_test.js
node scripts\console_offline_test.js
node qqproto\test\network-config-test.js
node qqproto\test\image-source-test.js
node qqproto\test\ui-offline-check.js
```

`bridge-mock.js` 把 `scripts/proto_bridge.js` 放进 vm 沙箱跑，配一个假的内核：每个方法记下 `(service, method, args)`，需要回调才答的动作（群详情、禁言列表、审批列表、好友申请、群文件列表、公告列表、群等级）由假内核按真机实测形状触发监听器——公告是 `('0','0',{srvCode:0,role:1,feeds:[…],nextIndex})` 且信封里的 `groupCode` 恒为 `'0'`（所以回调没法按群匹配），等级和"没内容时 promise 永远不落地"这两种行为也照真机写。假 fs 还会把 `copyFileSync` 记成一笔账、并按真机目录结构回 `readdirSync`，于是"发图片要先落进 `nt_data/Pic/<yyyy-mm>/Ori/<md5><ext>`"和"收图按 md5 在 Ori/Thumb 里找"这两件事都是离线验的（68 项），连"发完只删自己拷的那一份、客户端本来就有的不动、发送失败不删"也钉成了断言。另外它还兜住"本版本没这个方法""读不到公告板""type 8 不是申请""createGroupFolder 不回 id""图片段没这个文件"这类失败是否老实报出来，以及"灰条里的进群/退群要变成自己的事件、不能顺手当成一条空消息"和"回复元素要拿缓存里的 seq/msgId/sender 拼"。写预算与熔断故意从 **action 帧**进去（不是直接调 `dispatch`），钉住"2 次写成功后第 3 次在碰到内核前就说 budget exhausted"和"两次 `result=121` 打开熔断、冷却后才允许再发"；沙箱还用 symbol 配置跑，并断言桥除了一个**不可枚举**的调试句柄外没有留下任何 `__qqhook*` 全局。全程不碰 QQ、不联网。53 个桥动作里 43 个进了沙箱，没进去的 12 个（`ping status get_self get_friends get_groups get_group_members get_user recall list_cached_messages emit_test connected reconnect`）都是早就真机验过的基础动作，脚本 `node scripts\coverage_snapshot.js` 就是用来算这个账的。`compat-test.js`（7 项）核对已验证 build 表、读写动作分类、未验证版本与关键内核方法缺失时 core 在 RPC 之前就拦下；它还会把桥脚本里的 `WRITE_ACTIONS` 抠出来和协议端比一遍，防两边漂移。`supervisor-test.js`（4 项）验健康文件写/删与重启退避预算（指数退避、上限 5 次、窗口过期或健康 15 秒后清零）。`bridge-auth-test.js` 除 token 放行/拒绝外，还验 `heartbeat` 进了 `rpc.stats()`、结果帧上的 `code/retry_after` 能原样变成 rejected Error 的属性。`onebot-actions-test.js`（25 项）用假 core 校验协议层的数据：路由、retcode 翻译、参数别名、请求事件形状、公告板读不到时的拒绝、`other_requests` 分栏、`set_group_add_request` 不把 `invite` 这个词当成内核类型号转发，以及版本闸回 `1401`。`segments-test.js`（16 项）管 CQ 编解码转义、消息 id 表、权限映射、"哪些段允许过 core"，以及"收到再发"时图片段优先用本机 `path`。`satori-elements-test.js`（8 项）验 Satori 的 XML 段：`<img src>`（含 `file://`）转成本机路径段、`<file>` 带名字、`<quote>`/`<emoji>` 变成 reply/face 段而不是被丢掉、`audio/video/sharp` 要报错、转义能原样往返。`core-send-test.js`（8 项）盯的是 core 这道闸——它就是那个曾经把 `image` 段在桥之前就拦下来、还回一句"没实现"的地方，所以现在把"文本/@ 怎么填 uid、图片/文件转发成什么形状、reply 与 face 的 id、空路径要本地拒绝、record/video 仍然拒绝"钉成单测；`image-source-test.js`（25 项）把图片引用的写法钉住：`file://` 回转本机路径、`base64`/`data:` 解码进内容寻址缓存（同字节复用同一文件）、`http(s)` 下载（302 跟随、404/超限/非图片/连接拒绝各有明确错误）、缓存一周清理；`satori-methods-test.js`（14 项）对着 `@satorijs/protocol` 1.7.0 的 37 个方法逐个比对，并验审批/禁言/踢人/角色/改名/全员禁言/表情回应/分页/`referrer`/上传/事件形状/HTTP 预检、403 映射、预算拒绝的 `429` 和 `/health` 的 200/503。协议面这几个套件（`compat`/`onebot-actions`/`segments`/`satori-elements`/`satori-methods`/`core-send`）合计 78 项；`network-config-test.js`（58 项）把配置文件这条链钉住：四种网络的字段校验（名称/端口/URL/角色/格式/心跳）、回环与 `--allow-public`、端口冲突与数量上限、CLI 首次种子（含 `--protocol none` 双关）、原子写与坏 JSON、`toOneBotConfig` 的继承规则，以及 `OneBotProtocol.reload` 的 diff（同名同配置保持同一个对象、改了的重建、删掉的关闭、token/格式变化按继承关系重建）和"按网络上报自身消息"；`ui-offline-check.js`（95 项）用一条普通 TCP socket 扮桥（hello + 两条消息事件，并按真机形状回答 `get_friends/get_groups/get_group_members/send_message/recall`），把调试页、聊天页与网络配置页整条链路钉住：页面能不能出、方法目录里"已实现/未实现"标得对不对、参数模板在不在、SSE 回填与新行、两条调用路径（经端口 / 经内部函数）、没带 `X-Debug-Call` 与 CORS 预检要被拒、内核事件与各协议的实际投递有没有进流、会话列表/缓存历史/群成员能不能出、`allow_write` 不在就 403、`record` 段仍被 core 拒、图片预览只允许仓库与用户目录（越界 403、缺文件 404）、`/health` 与 `--health-file` 落的那份 JSON 是否一致，以及最关键的一条——"经页面调用"和"直接打端口"拿到的报文必须逐字节一致，也就是这个观测层不许改变任何客户端看到的内容；配置页那一段还验了首启种子、两个写闸（`X-Debug-Call` 与 `allow_write`）、回环拦截、重名拒绝、revision 409、落盘、OneBot 网络换 token 后同端口重建（其余网络保持不动、新 token 生效），以及 Satori 换端口的真热重载（新端口应答、旧端口关闭），并用第二个进程确认"不给 `--protocol` 时一个协议端口都不绑"；`headless-main-mock.js` 另外用假 Electron/内核把无头 app main 从登录到装桥整条链路跑一遍，并断言配置只经 symbol 传入、进程里没有留下可枚举的 `__qqhook*` 全局。`qq_fetch_client_offline_test.js`（47 项）钉的是取客户端那条链，fetch/download/run 全注入假的，一样不联网：见上面「没装过 QQ 也能起来」那段末尾的清单。`console_offline_test.js`（53 项）管这个控制台自己：假 tty 流里逐字符回显、退格删汉字、行内光标移动与插入、Ctrl+A/E/K/U/W、Delete、↑/↓ 走历史、跨包断开半个 ESC 序列也不能漏字、窄终端换行后的光标回算、**日志插在中间时正在打的字不丢**（先清提示符区再重画），普通 conhost 那一档**一个转义字节都不许出现**、行太长只能滑动不许换行、"光标在哪"的探测有人答就升级成 VT 渲染、没人答就留在普通档、探测的回复不能漏进输入行，Tab 的三种情形（唯一候选直接补全加空格 / 多候选只吃公共前缀并把候选另起一行 / 无候选响铃），Ctrl+C 一次取消本行两次才算要停，Ctrl+D 空行是 EOF 非空是删字符；命令层验 tokenize 的引号成组、别名与前导斜杠同路、未知命令的提示、`help` 分组与 `help <命令>`、异常被接住成红色一行、`error.dead` 是一句人话而不是"失败了"、异步命令的在飞计数、`NO_COLOR` 与非终端的输出形状、`watch` 的状态行开关；QQ 命令则对着一个真的 loopback HTTP 桩（`/api/snapshot`、`/api/chats`、`/api/conversation`、`/api/chat/send`、`/api/chat/recall`、`/api/emit-test`）跑，钉住"打的是哪条路由、`allow_write` 与 `X-Debug-Call` 在不在、`g:` 前缀怎么去掉、群号走 `group_id` 而 QQ 号走 `uin`、`writes off` 之后一个请求都不发、实例停了以后要网络的命令直说不、`--ui-port 0` 时不挂住"，全程不碰 QQ、不出本机。

### 真机自测

```bat
node qqproto\test\segments-test.js
node qqproto\test\onebot-smoke.js --token yourtoken --user 10000002 --group 20000002 --check-report --check-reverse
```

前者是离线单测（CQ 编解码转义、消息 id 表、权限映射），秒级完成；后者会**真实发一条私聊和一条群聊再各自撤回**，只对自己控制的账号跑。`--check-report` / `--check-reverse` 需要协议端启动时带上 `--ob-report http://127.0.0.1:4899 --ob-reverse-ws ws://127.0.0.1:4900`（脚本自己在这两个端口上起接收端）。加 `--skip-send` 一条消息都不发（图片那项退化成"本机没有这个文件要报清楚原因"，同样不碰 QQ）；加 `--image <本机路径>` 会真发一张图。典型输出：

```
PASS  get_status — {"online":true,"good":true,"checker":true,"app_initialized":true}
PASS  get_login_info — 10000001 测试账号
PASS  get_group_member_list — 4 人
PASS  can_send_* probes — text yes, image yes (image sends take a local file path), http file no
PASS  rejects a missing token — HTTP 401
PASS  image needs a file on this machine — image does not exist: C:\...\qqhook-no-such-file.png
PASS  image send (real message) — message_id 71   （只有带 --image 时才有这一项）
PASS  ws /api sends no lifecycle — 0 frames
PASS  ws action with echo — {"user_id":10000001,...}
PASS  lifecycle connect — {"post_type":"meta_event","meta_event_type":"lifecycle","sub_type":"connect",...}
PASS  heartbeat — interval 30000 status {"online":true,"good":true}
PASS  send_private_msg — message_id 38 real 7700912999076991359
PASS  get_msg id is reversible — 38
PASS  http report received the message — 1 reports
PASS  reverse ws connected / lifecycle / heartbeat / action answered
PASS  delete_msg — recalled
PASS  friend_recall notice — user 10000002
PASS  send_group_msg — 39
PASS  group_recall notice — user 10000001 operator 10000001
WARN  send_group_msg with at — 1200 sendMsg result=121
ALL PASS
```

`WARN` 不计入退出码，两种情况都发生在 QQ 那一侧：群撤回回执是客户端回调（消息列表刷新时才给，实测 2～4 秒到，偶尔十几秒不到，窗口留了 20 秒；桥已把 `onRecvMsg`、`onAddSendMsg`、`onMsgInfoListUpdate` 三条路径都归一成 notice）；短时间内重复 @ 同一个人会被风控拒回 `sendMsg result=121`，协议端原样转成 `retcode 1200` 并带上原因，不会假装发送成功。@ 段本身的可逆性由 `at segment keeps a QQ number` 在发送成功时校验，离线单测也覆盖了 uid→QQ 号的反查。

### 真机分级验证

新增的那 38 个桥动作不需要一次性全暴露给 QQ。`onebot-live-check.js` 按"对外影响"分档，默认只跑最安全的读档：

```bat
:: 先只看计划，一个请求都不发
node qqproto\test\onebot-live-check.js --token yourtoken --group 20000002 --dry-run

:: 只读档（默认）：群详情/禁言名单/@次数/等级/群文件/公告列表/精华列表（应显式拒绝）/申请列表/翻译/本地 OCR
node qqproto\test\onebot-live-check.js --token yourtoken --group 20000002 --user 10000003

:: OCR 想吃一张本机已存在的图片，就加 --image；不给这一项就是 SKIP
... --image C:\Users\you\ Pictures\shot.png

:: 可回写档：改自己群名片立刻改回、给备用号禁言 60 秒立刻解除、建探测目录随即删掉
node qqproto\test\onebot-live-check.js --token yourtoken --group 20000002 --user 10000002 --allow-write --max-write 3

:: 加清红点这类本地可见状态
... --i-understand
```

只读档这一档已经真机跑过，15 项全 PASS、写操作 0 次（测试群 4 人，群里的真实数据）：

```
PASS  get_group_list — 1 条（含 20000002: true）
PASS  群成员（新字段是否填上） — 4 人；title 0、mute 0、level 4 有条目
PASS  群详情（getGroupDetailInfo + 回调） — 测试群 4/2000，群主 10000002，创建 1517881808
PASS  禁言名单（onShutUpMemberListChanged） — 0 人被禁言
PASS  @全体剩余次数（atInfo） — can_at_all=false 群=10 我=0
PASS  群等级信息 — 6 个头衔：1=青铜 2=白银 3=黄金 4=铂金 5=钻石 6=王者，用户可见 1
PASS  群文件计数（batchGetGroupFileCount） — 2 个
PASS  群文件列表（onGroupFileInfoUpdate） — 2 项，文件夹 0
PASS  群公告列表（pskey + getGroupBulletinList） — 读不到公告板：内核只回默认信封，已按"能力不可用"明确拒绝
PASS  精华列表（应明确拒绝而不是卡住） — 按预期没打到 QQ：[1400] …needs the qun.qq.com web api
PASS  加群/邀请/其它通知列表 — 申请 0，邀请 0，其它（管理员变更这类）1
PASS  处理加群申请（不存在的 flag，应本地拦下） — 按预期没打到 QQ：[1200] no such group request: 0
PASS  好友申请列表（getBuddyReq） — 未读 1，共 2 条（备用号刚发的那条真实申请，flag 就是 reqTime）
PASS  英译中（translateEnWordToZn） — hello -> 你好
PASS  本地 OCR（wantWinScreenOCR） — 3 个文本框，识别 14 字：Hello 世界 12345
```

这份输出里三件事值得单独说，都是备好现场之后才看出来的：

- **公告板读不到，脚本改成明确拒绝**。群里确实有一条真公告，但 `getGroupBulletinList` 在本机四种参数布局（`(code, pskey, 0, 20)`、`(code, pskey, 20, 0)`、页码传字符串、群号传数字、起始传 1）下都只回同一个默认信封 `srvCode:0 / feeds:[] / inst:[] / server_time:"0"`，回调的第二参数只是把我们传的第三个参数原样念回来。桥把这个情况标成 `answered: false`，协议层回 1400 带原因——因为"读不到"和"没有公告"在返回值里长得一模一样，不能拿前者冒充后者。想再看一眼原始推送就加 `debug`（写进 `%TEMP%\qqhook_proto.log`），想换参数布局加 `arg_variant`。
- **群通知屏幕里混着非申请的条目**。把本账号设为管理员这条通知也是 `getSingleScreenNotifies` 返回的（`type 8`，`user1` 是被设置的人，`user2` 是操作者，状态已是已处理）。现在它进 `other_requests`，不再冒充"加群申请"，也不会产生 `request` 事件；拿它的 flag 去调 `set_group_add_request` 会在本地被拒（`type 8 is not a join/invite request`），`operateSysNotify` 根本不会被调用。
- **"没跑到"和"确实是空"分得开了**。桥会写两种不同的日志：`getGroupBulletinList: 0 feeds (srvCode=0, role=3, server_time=…)` 是问到了但板上确实没有，`got no onShutUpMemberListChanged push within 3000ms` 是压根没回。

写档也在新群 20000001（本账号是群主）跑过一次 `--allow-write --i-understand`，20 项 PASS / 0 FAIL / 写操作 3 次，三项全部当场恢复：

```
PASS  改自己群名片（立刻改回） — 已改成「协议端自测」，紧接着发恢复
DONE  恢复群名片 — 已恢复
PASS  给备用号禁言 60 秒（立刻解除） — duration=60，紧接着发解除
DONE  解除禁言 — 已恢复
PASS  建群文件目录（随后删掉） — folder_id /111d47bf-…      ← 见下，这一条是修完才过的
PASS  清群通知未读（只是本地红点） — {"cleared":true,"doubt":false}
PASS  标记某会话已读 — {"chat_type":2,"peer_uid":"20000001","marked":true,"result":0}
```

跑完复查过：群文件列表空、禁言名单空、四个成员的名片都是空串，账号被留在原状态。**`createGroupFolder` 在本机不回文件夹 id**（只回一个 plain result），第一次跑的时候目录建出来了却拿不到 id、自动删除没成立，只能事后按名字从根目录列表里找到 `/b36819f1-…` 手动删掉。现在动作会在这种情形下读一次根列表、按刚建的名字把 id 找回来（找不到就写日志说明），所以恢复动作拿得到可用的 `folder_id`；假内核也照这个实测形状改成"不回 id"，另加一条"回了 id 就不许再多跑一次列表"的用例。

分档的理由：只读档的这些动作走的是"打开面板才会走的路径"——pskey、`getGroupDetailInfo`、`getGroupFileList`、`getSingleScreenNotifies` 之类，不改任何东西也不给任何人发通知，但它们恰好覆盖了新实现里最容易出错的部分（内核回调等待、pskey、字段解析），所以先跑这一档就能把大部分实现问题暴露出来。写档全部要求自带回退，两次写之间强制间隔 60 秒起，一次会话最多 3 次。踢人、退群/解散、删好友、点赞、转发、发公告、设精华这几类**脚本不提供**：前者要么需要被踢的号重新发加群申请（那才是最典型的风控触发点），要么会给别人留痕，想验就在客户端手动做。

任何一次非预期失败都会立刻熔断（不重试），并把 `%TEMP%\qqhook_proto.log` 的末尾打出来；返回里出现 `result=121` 会明确提示"风控已触发，本轮到此为止"。跑之前先确认两件事：桥重新注入过（`--bridge-only`），协议端重启过——`/` 的 hello 会回报当前路由动作数，脚本在 preflight 里就把它打出来，小于 70 就是旧进程。

原则仍然是之前那条：只在自己的机器、自己控制的两个号、自己建的群上跑；封禁风险的真实来源是频率、时段和对他人的影响，不是"用了 API"本身，但任何一次"这次没出事"都不构成安全证明。

## 发消息测试台（网页）
```bat
bin\qqinject.exe --console
```

输出类似：

```
[console] console listening on http://127.0.0.1:47830/?token=...
[+] open: http://127.0.0.1:47830/?token=...
```

浏览器打开这个 URL 即可：

- 左侧是从 QQ 本地好友缓存拉取的好友（`getBuddyListV2` + `getCoreAndBaseInfo('nodeStore', uids)`），已过滤当前账号；
- 选中好友后发送文本，走 `generateMsgUniqueId` + `sendMsg('0', peer, [textElement], new Map())`；
- 收到的私聊消息通过 SSE 实时推到页面（`onRecvMsg`），自己从其它客户端发出的消息也会显示在右侧；
- 页面只在内存里保留本轮消息，不读历史、不落库。

可选参数：

```bat
--console-port 47830     页面端口，只绑定 127.0.0.1
--console-token <token>  固定令牌；默认每次随机，URL 会变
```

接口：

```
GET  /api/status        当前账号、好友数、监听 id
GET  /api/friends       好友列表
POST /api/send          {uid, text}；text 最长 4000 字，只支持文本
GET  /api/events        SSE：收到的消息、发送确认、系统通知
```

页面与后端源码：`scripts/console.html`、`scripts/web_console.js`。QQ 重启后重新执行 `--console` 即可。

## 事件格式

下面这套贴近 OneBot 11 的行格式属于旧的 `msg_bridge.js`（`--listen` 模式）。`proto_bridge.js` 上报的是协议无关事件：`type` 为 `message` / `message_deleted` / `request` / `offline`，`message` 带 `direction`（`incoming` / `outgoing`）、`chat_type`、`peer_uid`、`peer_uin`、`group_id`、`sender{uin,uid,nick,card,remark}`、`elements[]`、`raw_message` 以及内核的 `sequence`/`random`（精华、表情回应、转发按这两个值寻址）；`request` 带 `kind`（`friend`/`group`）、`flag`、`group_id`、`user_uid`、`comment`。协议层再把它翻译成 Satori 的 `message-created` / `message-deleted` 或 OneBot 的 `notice` / `request`。

每个事件一行 JSON，字段尽量贴近 OneBot 11：

```json
{
  "post_type": "message",
  "message_type": "group",
  "sub_type": "normal",
  "message_id": "1234567890",
  "time": 1792994267,
  "self_id": 10000,
  "user_id": 10001,
  "group_id": 123456,
  "chat_type": 2,
  "peer_uin": "123456",
  "peer_name": "群名",
  "sender": {
    "user_id": 10001,
    "nickname": "昵称",
    "card": "群名片",
    "remark": "好友备注",
    "uid": "u_xxx"
  },
  "message": [
    { "type": "reply", "data": { "id": "999", "sender_uin": "10001", "text": "原消息" } },
    { "type": "text",  "data": { "text": "你好" } },
    { "type": "at",    "data": { "qq": "10001", "name": "昵称" } },
    { "type": "image", "data": { "file": "a.png", "url": "", "file_size": 12345, "md5": "...", "file_uuid": "..." } }
  ],
  "raw_message": "你好@昵称[图片]",
  "display": "[群 123456] 昵称(10001): 你好@昵称[图片]",
  "synthetic": false
}
```

已支持的消息段：

| 段 | elementType | 主要字段 |
| --- | --- | --- |
| `text` | 1（无 @） | `text` |
| `at` | 1（`atType`/`atNtUid`） | `qq`、`name`；全体为 `qq: "all"` |
| `image` | 2 | `file`、`url`、`file_size`、`md5`、`file_uuid`、宽高 |
| `file` | 3 | `name`、`size`、`md5`、`file_uuid` |
| `record` | 4 | `file`、`duration`、`md5` |
| `video` | 5 | `file`、`size`、`duration`、`md5` |
| `face` | 6 | `id`、`text` |
| `reply` | 7 | `id`、`sender_uin`、`text` |
| `json` | 10 | `text`（ark 内容，截断） |
| `mface` | 11 | `id`、`name`、`summary` |
| `forward` | 16 | `id` |
| `unknown` | 其它 | `element_type`、`keys` |

## DLL 命令

```
ping | info | modules [filter] | windows | threads | echo <text>
v8probe [tid] | uvprobe | js <code> | jseval <base64> | unload | help
```

- `jseval` 接收 base64 编码的 UTF-8 JS，避免多行/引号在命令行里转义。
- 旧版 DLL 没有 `jseval` 时，注入器会自动回退到 `js eval(Buffer.from(...))`。
- `unload` 在 V8/uv 桥初始化后会被拒绝：`uv_async` 句柄还挂在 Node 循环上，直接卸载会让 QQ 崩溃。需要先实现 `uv_close` + 移除内核监听的安全拆除。

## 已验证 / 未验证

已在 QQ 9.9.36-53644（Electron/Node v24.11.1，Windows x64）上验证：

- x64 注入、模块枚举、`wrapper.node` 基址读取；
- 免 `--pid` 自动探测主进程（同名多进程按 `wrapper.node` / `QQNT.dll` / 顶层窗口评分）；
- `QQNT.dll` 导出的 V8 API 解析与主线程执行（`uvprobe`、`js`）；
- `process.dlopen` 取 `wrapper.node` 导出，`getNTWrapperSession('nt_1')` 返回活会话；
- `getMSFService().getServerTime()` 返回服务器时间，确认会话在线；
- `addKernelMsgListener` 返回监听 id，可用 `removeKernelMsgListener(id)` 移除；
- 合成消息 → 段解析 → TCP → 注入器打印，含断线重连与 `self_id` 解析；
- 监听期间控制管道已释放，可并发执行 `js` 命令；
- **真实入站**：好友私聊文本「你好」经 `onRecvMsg` 收到并解析，服务号卡片消息也能落到 `json` 段；
- **主动发送**：`generateMsgUniqueId` + `sendMsg('0', peer, [textElement], new Map())` 返回 `result=0`，拿到 `message_id`，`onAddSendMsg` 同步计数；
- 本地测试台：好友列表拉取、页面发送、SSE 实时消息全链路；
- 双向桥：`get_friends` / `get_groups` / `get_group_members` / `send_message` / `recall` 全部实测通过，动作有超时与断线清理；
- 群列表来自 `getGroupList` + `onGroupListUpdate(updateType, groupList)`，群成员来自 `getAllMemberList(groupCode, true)`（`false` 会拿到空 Map）；
- 群聊发送、群消息事件、撤回回调：`send_message(scene=group)` 与 `message.delete` 实测成功，撤回能产出 `message-deleted`；
- Satori 端到端：`satori-smoke` 的 health / login / 好友 / 群 / READY / 发送 / 事件 / 撤回 8 项全 PASS；HTTP 无令牌与错令牌均 401；WS upgrade 带错令牌直接拒绝，不带令牌则允许握到 IDENTIFY 再用 token 判定；
- **NoneBot2 + `nonebot-adapter-satori` 1.3.0 真机跑通**：`examples\nonebot-satori` 连 `ws://127.0.0.1:5141/v1/events`（upgrade 不带凭据、token 走 IDENTIFY），日志 `Bot qq:10000001 connected`；合成一条私聊 `help` 后插件命中并 `message.create` 回 `ok`，NoneBot 侧 Matcher 正常完成、`ok` 作为真实私聊发出（同一个 `send` 回显的 `channel.id` 也正确了）。这一轮修掉：WS upgrade 要求 token（NoneBot 不带，改为 IDENTIFY 校验）、`content` 外层 `<message>`、READY 的 `proxy_urls`、事件缺 `member`/`user`、以及 `sendMsg` 的 Promise 在消息已发出后 30 秒不落地导致的 `message.create` 超时；
- **NoneBot2 + `nonebot-adapter-onebot` 2.4.6 真机跑通**：`examples\nonebot-onebot` 以正向 WS 连 `ws://127.0.0.1:3101/`（`Authorization: Bearer`），日志 `OneBot V11 | Bot 10000001 connected`；合成私聊 `help` → `[message.private.other]` → 插件 `on_fullmatch` → `send_msg` 回 `retcode 0` → matcher 完成，`ok` 作为真实私聊到达主账号，全程无 ERROR/WARNING。同一实例的 OneBot HTTP 端口（3100）`get_login_info` / `get_status` / `get_version_info` 均 `retcode 0`。切换方式：在 `http://127.0.0.1:5151/config` 里启用对应网络（首次启动也可 `qq_start.bat --protocol onebot|both` 预置）；两个 NoneBot 工程别同时跑（会各回一份 `ok`）；
- **调试页合成事件**：`POST /api/emit-test`（回环、需 `X-Debug-Call: 1`）把一条假消息喂进桥，框架侧收到的是完整的 `message-created`；它自己不发消息，适合没有第二个账号时测命令链路；
- 桥热更新代际：重复 `--bridge-only` 后，协议端只认最新 `generation`，旧实例不会抢连接；
- OneBot v11 端到端（`onebot-smoke`）：HTTP 动作、GET 查询、表单与 JSON 混合、`/` 的 `{action,params,echo}`、401、未实现动作 1400、WS `/api` 动作带 `echo`、事件角色 `lifecycle/heartbeat`、HTTP 上报（`X-Self-ID` + `X-Signature` HMAC-SHA1 校验通过）、反向 WS 外连并双向收发，全部实测通过；
- OneBot 收发的真实消息链路：`send_private_msg` / `send_group_msg`（含 `[CQ:at,qq=…]`）发出并撤回，`get_msg` 用数字 `message_id` 取回、`delete_msg` 用同一个数字 id 撤回，`friend_recall` 通知到位；
- **有头模式（`--headed`）真机跑通**：`qqinject --launch --bridge-only --keep-tray` 注入 `bin\qqhook.dll` 后 QQ 正常起（主进程 + renderer/GPU 一组、托盘保留），协议桥连上后 `/health` 的 `bridge:true`、Satori `/v1/login.get` 的 `status:1`、`friend.list`、调试页 `/api/chats`（好友/群列表）都是真数据；控制台从 `[ep] QQ bridge ready` 判定登录并写 `<profile>\account-headed.json`（`via: headed`）。`headless_stop.js` 按 pid 把整棵 QQ 进程树收干净（实测 1 主 + 9 子，一次收完），同一时间你的正常 QQ（另一个安装路径）7 个进程全程没动、也没被注入。有头客户端用它自己的登录态：实测自动进去的号和当时无头缓存的那个号不是同一个，所以两份缓存分开（见「有头模式」）；
- 段与 id 的离线单测（`segments-test.js`）：CQ 转义/反转义、文本里的伪 CQ 不被误解析、uid→QQ 号反查、原生 msgId 与数字 id 的双向映射在重启后保持一致；
- 入站消息经合成事件（桥的 `emit_test`）走完整链路：私聊与群聊（带 @）都能产出正确的 `message` 事件、`sender.role`、`raw_message`；
- QQ 撤回回执的实际来源：`onMsgInfoListUpdate` 只是其中一条，`onRecvMsg` / `onAddSendMsg` 也会收到灰条，现在三条路径都会归一成 `notice`；
- 短时间内重复 @ 同一个人会被 QQ 拒回 `sendMsg result=121`（风控/频控，隔几分钟再发就成功），协议端原样转成 `retcode 1200` 并带上原因，不会假装发送成功；连续 3 次这类回包后桥会熔断 60 秒，期间写动作不再进内核（离线假内核也钉了这条）。
- 离线假内核（`bridge-mock.js`）：53 个桥动作里的 43 个，其服务名、方法名、参数布局、回调匹配与失败信息都在沙箱里逐项验过一遍（假内核的回调形状照真机实测写），全程不发消息。没进沙箱的 12 个是 `ping`/`status`/`get_self`/`get_friends`/`get_groups`/`get_group_members`/`get_user`/`recall`/`list_cached_messages`/`emit_test`/`connected`/`reconnect`，都是早就真机验过的基础动作。`send_message` 这一轮进来了，连带图片段"先复制进 `Pic/<yyyy-mm>/Ori/<md5><ext>` 再交元素"这一步也在沙箱里用假 fs 核对过。
- 写操作三道闸的离线行为已钉住：未验证 build 在 `Core.call` 里就被拒（RPC 一帧都没发），版本闸/预算闸的错误码分别落成 Satori `403/429` 与 OneBot `1401/1200`；桥内 budget 用满后第 N+1 次写不碰假内核，连续 `result=121` 会打开熔断并在冷却后恢复。launcher 的退避策略与健康文件由 `supervisor-test.js` 单独覆盖（不真起进程）。
- **图片发送已真机走通，且是内核路**：不写 Highway、不做 secapi。把本机图片按 `<md5><ext>` 复制进客户端自己的 `Documents/Tencent Files/<uin>/nt_qq/nt_data/Pic/<yyyy-mm>/Ori`，再交一个照客户端抓样构造的 `picElement`（`fileName` 就是那个 md5 名、`original:true`、`picType:1000`、`thumbPath` 给空 Map）给 `sendMsg`，内核自己发起上传。三种写法都在群 20000001 上验过：OneBot 段数组 `retcode 0 message_id 69 real 7775243794437380587`、OneBot 的 `[CQ:image,file=…]` 串（发完当场 `delete_msg` 撤回，`message_id 71`）、Satori 的 `<message><text>…</text><img src="…"/></message>`（返回 `id 7775244438184891228`）。640×360 的 90 KB PNG 从请求到发送确认约 18 秒，`message_sent` 事件正常带出图片段，全程没有 `result=121`。抓样与复现脚本：`scripts/capture_send_shape.js`、`scripts/probe_send_group_image.js`。
- **收图路径也真机验过**：用 `emit_test` 的 `image_md5` 钩子把一张真收下来的图（`2677932547…png`）从桥的 `convertElement` 一路送到 OneBot 事件，`message[1].data.path` = `…\Pic\2026-10\Ori\2677932547….png`、`thumb:false`，`raw_message` 里也带 `path=`；编造的 md5 回空路径、只有缩略图时退到 `Thumb/<md5>_0.jpg` 并置 `thumb:true`。另外确认了客户端命名就是内容 md5（对同一目录里 5 个文件逐个 `md5sum` 比对）。
- **群文件上传也真机走通了**：`upload_group_file` 把本机文件落进客户端 `nt_data/File/Ori/<md5><ext>`、交一个 `fileElement{fileName, folderId, filePath, fileSize}` 给 `sendMsg`，内核自己上传。测试群 20000001 里一个 100 字节 txt：`retcode 0`、`file_id /c4864ccb-…`（来自 `onRichMediaUploadComplete`，发送元素里的 `fileUuid` 恒为空）、群文件列表随即出现（busId 102、parent `/`）、~10 秒后 `message_sent` 事件带 `[文件]`；跑完 `delete_msg` + `del_group_file` 清干净、列表回到 0。私聊文件、语音、视频、头像还没验。
- **上传半边的探索结论**：内核里所有 `upload` 方法都枚举过，`uploadRMFileWithoutMsg` 的真实入参键名用 Proxy 套出来了（`transferId` 必须是 UUID，`bizType/filePath/peerUid/useNTV2`），第一次以 `bizType:0` 真机传成功（`fileErrCode 0`、拿到 `fileId`），同参数重试变 `2006020 illegal params`；文本文件与其它 `bizType` 没回调。**但 NapCat 的源码表明正常发送不走这个入口**——它和我们一样把文件落进客户端媒体树再 `sendMsg`（见「发文件」），所以这条路只在对“客户端不接的元素”才需要。
- **只读档真机（15 项全 PASS，写操作 0 次）**：`get_group_list`、`get_group_member_list`（`role`/`shut_up_time`/`special_title`/`level`/`last_sent_time` 都填上了，且 `role` 实测能对上新鲜状态：群主 10000002=owner、本账号 10000001=admin、备用号=member）、`get_group_detail`（群主 `10000002`、成员 4/2000、建群时间）、`get_group_shut_list`、`get_group_at_all_remain`、`get_group_level_info`（6 个头衔）、`get_group_file_count`（2 个）、`get_group_files`（2 项）、`get_group_system_msg`、`set_group_add_request` 的假 flag 本地拦截、`get_friend_requests`（备用号 10000003 刚发的真申请：`flag=reqTime=1793026827`、`req_type 1`、`unread true`、`comment` 带原文）、`translate_text`、`ocr_image`（本机图片识别出 3 个文本框，拼成 `Hello\n世界\n12345`）。
- **入群申请的同意路径已用真数据走通**：新建群 20000001「测试群」（本账号是群主，成员 3→4）里那条 `type 5` 邀请，从 `onGroupNotifiesUpdated` 推成 `request` 事件 → `get_group_system_msg` 列出 `flag 1793028557978606 / is_processed false` → `set_group_add_request` 同意回 `result 0` → 再读成员表里 10000003 已入群（`join_time 1793028764`）。注意同意后那条申请**仍在列表里**，只是 `is_processed` 变成 `true`，框架要自己过滤，别按"列表非空"重复处理。
- 过程中真机咬出一个协议层 bug：`set_group_add_request` 的 OneBot `type` 参数是 `add`/`invite` 这种**词**，而桥要的是内核的数字通知类型；老代码 `num('invite')` 得到 0，加上新的守卫就回成"type 0 is not a join/invite request"。现在只有真正的数字类型才转发，其余一律让桥按 flag 去屏幕列表里查（这也是唯一能拿对 `doubt` 标志的做法），并加了回归测试。
- **`request` 事件的真实推送已到位**：那条真好友申请在 15:00:29 由 `onBuddyReqChange` 推进来，协议端日志出现 `event: request`（15:16:25 又出现一次——桥重新注入后去重集合是空的，同一条会重报一次，这是热更新的预期行为，不是新事件）。
- **群通知屏幕里的非申请条目已分辨**：把本账号设为管理员那条通知也在 `getSingleScreenNotifies` 里，`type 8`（`user1` 被设置的人、`user2` 操作者、状态已处理）。它现在归 `other_requests`，不产生 `request` 事件，拿它的 flag 去 `set_group_add_request` 会在本地被拒且不会调 `operateSysNotify`。
- **公告板在本机读不到（实测结论）**：群里手动发了真公告之后，`getGroupBulletinList` 仍只回默认信封——四种参数布局逐一实测都是 `srvCode:0 / feeds:[] / inst:[] / server_time:"0"`，回调第二参数只是把第三个入参原样念回。所以 `list_group_notices` 带 `answered` 标志，协议层在读不到时回 1400 说明原因（NapCat 的 `get_group_notice` 走的也是 qun.qq.com web api，不是内核；发公告与删公告仍走内核，可用）。
- 真机才暴露出来的四条内核行为，已全部回写进桥和假内核：
  - `getGroupBulletinList` 是**四个参数** `(groupCode, pskey, pageStart, pageLimit)`，少传直接触发 NAPI 断言 `assertion (argc == 4) failed`；答案走 `onGetGroupBulletinListResult('0','0',{srvCode,role,feeds,nextIndex,…})`，且信封里的 `groupCode` 恒为 `'0'`，无法按群匹配；
  - `getGroupMemberLevelInfo` 的 promise **永不落地**，等级只从 `onGroupMemberLevelInfoChange` 拿；同理 `getGroupShutUpMemberList` 在无人被禁言时也不落地——先 `await` 返回值再等回调会直接把动作卡到超时；
  - `getGroupDetailInfo` 的第一次推送常是冷缓存半成品（群名为空、群主 0），必须继续等到 `memberNum` 或群主出现，并用 `groupExt.groupOwnerId` 兜底；
  - `fetchGroupEssenceList` 既不落地也没有已知回调，精华**列表**做不到，于是删掉桥动作、协议层显式回 1400 带原因（`set_essence_msg`/`unset_essence_msg` 走的是另一条，仍可用）。
- `wantWinScreenOCR` 的返回是**文本框数组** `[{text,pt1..pt4,charBox,score}]`，没有现成的整段文字，`text` 由框拼接而来。

尚未验证：
- 语音 / 视频发送与头像上传（仍回 1400，接收侧能解析）；
- 这一轮刚接上的 Satori 能力里有五样**只过了离线门禁**：replyElement 的发送形状、faceElement 的发送形状、`guild-member-*` 事件、表情回应（`set_msg_reaction`）、`upload.create` 端到端。都按 NapCat 的同一份字段/枚举写，发错会明确报错，但真机一次都没跑过；
- **有头模式**只验了"起→登录→桥→只读调用→收掉"这一圈：长时间稳定性、`-q` 换到另一个号（本次它按自己记住的账号进的，没换）、"关闭到托盘"之后的表现、以及和正常 QQ 登录同一个账号时会不会互相挤下线，都没专门测；
- **写档在新群里跑过一整轮（21 PASS / 1 FAIL，8 次写）**：`set_group_card`（改自己名片→清空）、`set_group_ban`（备用号 60 秒→解除）、`create_group_file_folder` + `rename_group_file_folder` + `delete_group_file_folder`（建目录拿到 id→改名→删掉）、`set_group_name`（「测试群」→「协议端自测」→改回原名）、`set_group_remark`（→改回原备注）、`set_group_admin`（备用号设管理员→取消）、`mark_group_notify_as_read`、`mark_msg_as_read` 都实测通过并当场恢复；跑完复查过群文件空、禁言名单空、群名与备注回到原值、备用号不再是管理员。唯一的 FAIL 是群头衔，见下条；
- **群头衔在本机做不到**：枚举 `NodeIKernelGroupService` 的 243 个方法后确认 `modifyMemberSpecialTitle` 已经不在了；剩下的两个里 `getGroupHonorList(param)` 对 `group_id`/`groupCode`/`gid`（字符串与数字都试）一律回 `errCode 20000 param(group_id) error`，`setIdentityTitleInfo(param)` 能打服务端（cmd 0x899）但对 memberUid/memberUin/uid/specialText 各种写法都回 `result 10005 not group member(0x899_0)`。NapCat 是用 0x899 原始包写的（`packet/transformer/action/SetSpecialTitle.ts`），而原始包正是本项目不做的那一层，所以现在动作直接以这个原因回 1400；
  - **剩下的媒体**：群文件已经通了（见「发文件」一节）；私聊文件、语音、视频、头像还没验。私聊文件大概率同一招（元素一样，只是 peer 换成好友），语音要先 silk 编码、视频要先抓缩略图（NapCat 用 ffmpeg），头像的 `setHeader` 入参还不是路径形状。
  - **文件/语音/视频/头像的上传**：内核里所有带 `upload` 的方法都枚举过一遍（`getBdhUploadService.uploadFile`、`getFlashTransferService.*`、`getSkinService.uploadImage`、`getGroupService.uploadGroupBulletinPic`（公告图片，吃本机路径、能传）、`onlyUploadFile`、`uploadRMFileWithoutMsg`），还用 Proxy 把原生层真正读的键套了出来（`uploadRMFileWithoutMsg` 读 `transferId(UUID)/bizType/filePath/peerUid/useNTV2`，不是之前猜的 `sKey/md5/sha1`）：第一次 `bizType:0` 传成功过（`fileErrCode 0` + `fileId`），同参数重试回 `2006020 illegal params`。**但查了 NapCat 现在的源码后结论变了**：它的普通发送不走这条路，而是和图片一样“复制进客户端媒体树 + fileElement + sendMsg”（详见「下一步」第 2 项），所以文件发送按那个形状做即可，`uploadRMFileWithoutMsg` 先放一边。
  - 好消息是收图不再欠（见上面「收图」一节）。另外验到可用的只读 API：`getGroupSpace('20000001')` 回 `totalSpace 10737418240 / usedSpace 0 / allUpload false`（还没接成动作）、`getRichMediaCodecInfo({})` 回编解码能力结构、`getPicTmpPath()`/`getPttTmpPath()`/`getVideoTmpPath()`/`getFileTmpPath()` 回各媒体目录。
- **本轮新增的写侧剩下的部分**：踢人、退群/解散、删好友、点赞、转发、发公告与删公告、设精华、群文件的删除与移动。这些仍只过了离线假内核——按分档规矩，跑它们要么加 `--allow-write`（自带回退、间隔 60 秒起、一次最多 3 次），要么脚本压根不提供（踢人/退群/删好友/点赞/转发/发公告/设精华），后者请在客户端手动确认。表情回应（`set_msg_reaction`）这轮接进了 Satori 的 `reaction.create/delete/clear`，但桥动作本身依旧只有离线假内核覆盖；群头衔已从这一类里出去了：它不是"没验"，是本机做不到（见上）；
- **`type 7` 的"别人申请进群"还没见过**：真机验到的是 `type 5` 的群邀请（新建的测试群里，备用号被邀请进来），`request` 事件、`get_group_system_msg` 与 `set_group_add_request` 的同意路径都已用真 flag 走通；`type 7` 走的是同一条 `operateSysNotify`，只是分栏不同，仍欠一条真数据；
- **成员变动类通知**：桥现在会把灰条里的进群（`TipGroupElement.type 1`）/退群（3）抽成 `group_member` 事件，Satori 对应 `guild-member-added/removed`、OneBot 对应 `group_increase`/`group_decrease`；但这条真机还没吃过——之前那次入群（成员数 3→4）发生在桥产生这个事件之前，`type 8` 管理员变更仍按消息处理；
- 公告的**逐条字段解析**：内核在本机读不到板（见上），所以 `normalizeNoticeFeed` 里 `feeds`/`inst` 的字段映射只按 NapCat 的 web api 形状和假内核回放验过，没吃过真数据；真要验只能改走 qun.qq.com（本项目不做 cookie 请求）；
- NapCat 靠读消息数据库实现的动作用我们的事件缓存替代（精华、表情回应、转发要 `msgSeq`/`msgRandom`），所以只对**注入之后亲眼见过**的消息有效，这个限制在真机上还没量化过；
- 长时间运行稳定性、其它 QQ 版本、账号切换；
- 真实入站的群消息（协议转换链路已用合成事件验证，仍欠一条对方亲手发来的群消息）；
- 群撤回通知的到达时间：偶发超过 20 秒，测试记为 WARN；
- 安全软件/风控下的行为。

## 限制与风险

- 注入与自动收发消息违反 QQ 用户协议，账号有封禁风险；只在自己的机器、自己的账号上测试。
- `LoadLibrary` 注入会在模块列表中留下 `qqhook.dll`，没有任何隐藏设计。
- QQ 版本更新可能改变 `wrapper.node` 导出、`elementType` 字段或 NAPI 行为；本项目不保证跨版本。
- 事件 TCP 仍只绑定 `127.0.0.1`，不加密；生产桥带本地 token 校验，调试端点可以不校验。不要改成公网监听。
- 无头启动会生成 `<profile>\bridge.token`（本地 bridge 令牌）。`qqproto --bridge-token` 会校验它；不传这个参数的调试端点保持旧的“谁连上谁说话”行为。token 文件按用户目录权限保护，不要把 profile 目录共享给别人。
- 同一个 profile 由 `<profile>\launcher.lock` 串行化；launcher 被强杀后，下一次启动会按 pid 校验 `node.exe`，确认是残留锁才清掉。
- 版本闸只保护"这个 build 我们没验过"，不保护"验过的 build 一定不会变"：`9.9.36-53644` 写进了已验证表，也不等于腾讯服务端不会改风控。换 QQ 版本时先看 `qqproto` 日志里的 `compat:` 与 `capabilities.missing`，别直接上 `--allow-untested`。
- 写预算与熔断只是行为限流：它挡的是脚本自己打出的突发，不改变腾讯已经下发给账号的任何判定；`limits.open` 只在桥的这一个进程里有效，桥重连或换代际后清零。
- `<profile>\endpoint.health.json` 每 5 秒重写，里面有账号 uin、桥计数、写预算和内存数字。它和 `endpoint.log` 一样在 profile 目录里，别共享这个目录；`--detach` 或单独跑 `qqproto` 时不传 `--health-file` 就不会落这个文件。
- launcher 只监督协议端，不自动重启 QQ：QQ 进程消失就整套收尾（重新登录可能触发扫码/风控，不该由脚本替你做决定）。
- `qqproto` 默认只绑回环且强制令牌；绑非回环地址必须显式加 `--allow-public`。桥端口本身没有鉴权，能连上 `127.0.0.1:47840` 的进程等于能操作这个账号，不要和多用户机器共用。
- OneBot 的 HTTP/WS/上报/反向 WS 共用同一个令牌；反向 WS 会把令牌拼进 URL 查询串，本机之外不要走明文 `ws://`。
- `qqproto/data/onebot-msg.json` 会落盘数字消息 id 与原生 msgId 的映射（最多 20000 条），里面包含本账号的消息标识；已经在 `.gitignore` 里，别提交。
- Satori 的 `upload.create` 会把客户端传来的文件写进 `qqproto\data\upload\`（≤32MB、≤8 个/次），只认 `multipart/form-data` 且要走令牌校验；这个目录不会自动清理，自己定期清。
- 反复热更新桥脚本会在原生侧留下旧监听（id 不同）与旧代际的挂起连接：旧桥被保留为"不响应的空闲 socket"以免 2 秒重连风暴，但连接数会一直增加，重启 QQ 才彻底干净。新加的动作只在 `proto_bridge.js` 里，改完必须重新 `--bridge-only` 注入才会生效。
- `ocr_image` 与群公告配图吃的是**本机已存在的路径**（桥只做 `fs.existsSync` 检查，不下载也不上传），所以能连上桥端口的人等于能让 QQ 读这个账号可见的任意本地图片；这条风险与"桥端口没有鉴权"是同一条。
- 不读消息数据库、不轮询历史消息；收到的就是内核实时回调。
- `d8-disassembler` 与本项目无关：它处理 V8 字节码，而 `wrapper.node` / `QQNT.dll` 是原生 PE。

## 下一步

1. 写档剩下的部分：只读 15 项、写侧 3 项（改名片 / 禁言 / 建群文件目录）和入群申请的同意路径都已真机走通，且都当场恢复。剩下的写动作按风险分两拨——改群名与群备注、设管理员、群头衔、群文件的删除与移动、目录改名这类可以在测试群 20000001 里继续加 `--allow-write` 跑；踢人、退群/解散、删好友、点赞、转发、发公告、设精华脚本不提供，需要在客户端手动确认。公告列表已确认内核读不到，只能走 qun.qq.com，本项目不做。
   - **文件 / 语音 / 视频 / 头像**：群文件已经按 NapCat 的形状真机跑通（详见「发文件」）：`getRichMediaFilePathForGuild` 落盘 → `fileElement` → `sendMsg`，不需要 secapi。剩下的顺序建议是：私聊文件（同一形状，换个 peer 试一次）→ 语音（先 silk 编码，NapCat 用 ffmpeg + silk 编码器）→ 视频（ffmpeg 抓缩略图）→ 头像（`setHeader` 形状未明，且有可见副作用）。
   - **文件 / 语音 / 视频 / 头像**：查 NapCat 现在的源码才发现，它的普通 OneBot 发送**根本不用自写 highway**——和图片同一招：`apis/file.ts uploadFile()` 先算 md5/大小，用 `getRichMediaFilePathForGuild({md5HexStr, fileName, elementType, elementSubType, thumbSize, needCreate: true, downloadType: 1, file_uuid: ""})` 要一个媒体树路径、把文件复制进去，再交一个 `fileElement: {fileName, folderId, filePath, fileSize}`（图片则是我们抓过的 `picElement`）给客户端 `sendMsg`，上传由客户端完成。它自己的 highway（`packet/highway/*`）只用于下载、合并转发上传和 packet 模式发送。所以下一步**先照这个形状把文件发送做出来**（本机路径 → `getRichMediaFilePathForGuild` → 复制 → fileElement → sendMsg），不需要 secapi；语音要先 silk 编码、视频要先抓缩略图（NapCat 用 ffmpeg），再看要不要引入这层依赖。`uploadRMFileWithoutMsg` 那条（`{transferId: UUID, bizType, filePath, peerUid, useNTV2}`，成功过一次、重试回 2006020）先放一边，它不是正常发送用的入口。
   - **自写 highway 的路**（真要走到那一步才用）：图片 `OidbSvcTrpcTcp.0x11C4_100`（群）/`0x11C5_100`（私）、语音 `0x126d_100`、群文件 `0x6D6`；响应里 `upload.uKey` 非空才需要传，上传会话是 `HttpConn.0x6ff_501` 换的 `sigSession/sessionKey`，TCP 帧是 `0x28 | headLen | bodyLen | protobuf 头(command/ticket/ext) | 分块 | 0x29`，块大小 BlockSize、每块带 md5+offset，命令号 1004(群图)/1005(群视频)/1006(群文件)/1007(私语音)/1008(群语音)，`encrypt:false`。相比 NapCat 的发送路径，这条路只在“没有客户端可用”时才值得写。
   通了之后 `record/video/file` 段、Satori 的 `upload.create`、`upload_group_file`/`upload_private_file`/`set_qq_avatar` 一起活。现在 `file` 段（本机路径）与 Satori 的 `upload.create` 都已接上（后者只过了离线门禁），`record/video` 段与头像还在上面那三步里。
3. 引用回复：**这轮已补齐**——桥按 NapCat 的 `replyElement` 字段（`replayMsgSeq/replayMsgId/senderUin/replyMsgClientSeq/_replyMsgPeer`）从自己的缓存里拼，Satori 的 `<quote id>` 与 `message.create` 的 `referrer` 都走它；只过了离线门禁，真机欠一次。
4. 群内成员变动类事件：进群/退群**这轮已接**（灰条 `TipGroupElement.type` 1/3 → `group_member` → Satori `guild-member-*` / OneBot `group_increase|decrease`），同样欠真机；管理员变更、精华、表情回应通知还没接。
5. 协议端配置落文件（`qqproto/config.json`），多账号各起一个进程 + 各自桥端口，或在一个进程里做账号路由。
6. 增加原始 `RawMessage` 落盘开关，便于版本适配和字段对照——新动作读的内核字段比原来多得多，这个开关的用处也跟着变大。
7. 实现安全拆除：`removeKernelMsgListener` + `uv_close` 后再允许 `unload`（群/好友监听也要一起摘）。
8. 长时间运行、多账号与其它 QQ 版本的适配。版本适配已经从"猜字段"变成有形状的一层：桥在 hello/heartbeat 里报 `qq_version` 与 `capabilities.missing`，协议端按 `qqproto/lib/compat.js` 的已验证表决定要不要放行写，launcher 再按健康文件监督协议端。剩下的是拿真实新版本跑一遍、把确认过的 build 加进表，并观察长时间运行下 `limits`/重启计数是否合理。

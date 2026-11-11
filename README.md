# NegiQhook

Windows x64 上的 QQNT 无头注入桥 + 独立协议端。它把 QQ 主进程变成一个没有窗口/托盘/renderer 的内核服务，由 `qqproto` 对 bot 框架提供 **Satori** 与 **OneBot v11**。

> 只用于自己控制的账号与测试环境。注入违反 QQ 使用条款，项目不保证不被检测。默认只绑 `127.0.0.1`，不读消息数据库。

## 特性

- **无头启动**：挂起注入 `appinit.dll`，在内存里重定向 `package.json` / `app.main.js`，由自定义主程序驱动官方 `wrapper.node`。不改 QQ 文件、不 patch 二进制，boot 完成后 DLL 自卸载。
- **本地桥**：QQ 内的 `proto_bridge.js` 通过 TCP + NDJSON 提供内核动作与事件；带本地 token、写预算、抖动和风控熔断。
- **独立协议端**：`qqproto` 是纯 Node、零第三方依赖的进程。
  - Satori：官方 37 个方法中 30 个可用，7 个明确返回 501 并写明原因。
  - OneBot v11：HTTP 动作服务端、WS 服务端、HTTP 上报、反向 WS；支持 array/string 消息格式、心跳、按网络上报告自身消息。
  - 默认**不监听任何协议端口**；在 `/config` 里打开并保存后才开始监听，配置落盘、重启仍生效。
- **调试界面**：`/` 状态与报文调试台，`/chat` QQ 式聊天界面，`/config` NapCat 风格网络配置。页面与控制台都走本地回环，写操作要显式 `allow_write`。
- **媒体**：图片引用支持本地路径、`file://`、`base64://`、`data:`、`http(s)`，协议端解析成内容寻址缓存后再交给内核；文件发送只接受本机已有路径。
- **不碰数据库**：消息来自内核回调，协议端只在内存里缓存启动后见过的消息。

## 架构

```text
QQ.exe (headless)
  ├─ appinit.dll ── 启动时重定向 package.json / app.main.js，随后卸载
  ├─ app.main.js ── 初始化引擎/登录，加载官方 wrapper.node
  └─ proto_bridge.js ── TCP(127.0.0.1) + NDJSON
                              │
                        qqproto 进程
                        ├─ core / store / 写闸
                        ├─ Satori   (HTTP + WS)
                        └─ OneBot11 (HTTP/WS 服务端、上报、反向 WS)
                              │
                        bot 框架 / 调试页
```

## 环境

- Windows 10/11 x64
- Node.js **20+**
- 从源码构建需要 Visual Studio Build Tools 的 C++ 工作负载（`build.bat` 自己用 vswhere 找 `vcvars64.bat`）
- 仓库**不包含 QQ 客户端**；第一次启动会自动下载并解包到 `qqclient/`（约 1.4 GB，只写本目录）

## 构建与启动

```bat
build.bat
build_boot.bat
qq_start.bat
```

- `build.bat`：`bin\qqhook.dll`、`bin\qqinject.exe`。
- `build_boot.bat`：`bin\headless\appinit.dll`。
- `qq_start.bat`：无头启动 + 登录 + 协议端 + 控制台。第一次会下载 QQ 并打印二维码；之后用 `qqclient\headless\account.json` 里的账号快速登录。
- 官方 CDN 对部分非浏览器客户端会 403：用浏览器存下安装包后 `qq_start.bat --qq-file <安装包>`，或加 `--allow-mirror` 走核对过 sha256 的社区镜像；代理用 `--proxy http://host:port`。
- 启动后打开 `http://127.0.0.1:5151/`；协议端口在 `http://127.0.0.1:5151/config` 里开启。默认 token 为 `testtoken123`，可在配置页改。

也可以单独跑协议端（不启动 QQ）：

```bat
qqproto\start.bat
```

## 文档

- [HANDBOOK.md](HANDBOOK.md)：完整手册。无头原理、有头/托盘模式、协议字段、配置项、安全边界和真机结论都在这里。
- [docs/api/README.md](docs/api/README.md)：OneBot v11 与 Satori 的接口总表；同目录有两份可直接导入 Apifox 的 OpenAPI 3.0 文件。由 `node scripts\gen_api_docs.js` 生成。

## 仓库范围

本仓库是精简发布版，只包含协议端与 hook 的生产路径：

```text
src\boot        boot DLL：重定向 package.json / app.main.js
src\headless    无头主程序：驱动 wrapper.node、登录、装桥
src\hook        attach 调试用 hook DLL
src\injector    挂起注入器
scripts         proto_bridge.js、无头启动器、客户端获取、窗口/托盘/二维码辅助
qqproto         独立协议端：core、Satori、OneBot v11、调试/聊天/配置页
docs\api        生成的接口文档
```

QQ 客户端、运行数据（`qqproto/data/`、`qqclient/`）、本地 token、离线测试套件、真机探针和示例 bot 都不在这个仓库里。离线测试所在路径见 `HANDBOOK.md`，但对应的测试文件不在公开仓库内。

## 安全边界

- 只用自己控制的账号；桥和协议端只绑回环，绑公网必须显式 `--allow-public`。
- 不读 QQ 消息数据库；不实现登录/签名，只调用 QQ 自己的登录与内核服务。
- 写操作默认有 30/分钟、600/小时、最小 300ms 间隔的预算；连续风控回包会熔断，未验证的 QQ build 默认只读。
- 注入本身会在启动期留下注入器进程、DLL 模块和内存中的自定义主程序；没有做驱动级隐藏或反检测对抗。QQ 若做内存/模块扫描或服务端风控，仍有被发现的可能。

## 已验证环境

- QQNT 9.9.36-53644（主测试 build）
- Windows 11 x64 + Node.js 20/22
- 官方 NoneBot2 Satori 与 OneBot v11 adapter 均真机跑通过 `help → ok`

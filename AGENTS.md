# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 构建与运行

```bash
npm run build          # tsc → dist/
npm run start          # node dist/index.js
```

项目未配置测试框架、代码检查器或格式化工具。

修改 `.ts` 文件后需 `npm run build` 并重启 Claude Code 进程（MCP 服务器仅在启动时加载代码）。修改 `src/public/index.html` 只需刷新浏览器。

## 架构

这是一个将本机串口和 shell 终端暴露给 Claude Code 的 MCP 服务器，同时内置 xterm.js 浏览器终端 UI 用于实时观测。四个子系统共享 `SerialManager` 和 `ShellManager` 两个单例：

```
Claude Code ←stdio (MCP)→ mcp-server.ts ──┐
                                           ▼
                                   serial-manager.ts  (EventEmitter 单例)
                                   shell-manager.ts   (EventEmitter 单例)
                                           ▲
浏览器 (xterm.js) ←WebSocket── web-server.ts ──┘
```

**关键约束**：绝对不能写 `stdout`——MCP 用 stdout 传输协议帧，污染会导致连接断开。所有日志必须写 `stderr`。

### SerialManager (`src/serial-manager.ts`)

- 以 `serial` 导出的单例，继承 `EventEmitter`
- 三种事件：`frame`（串口 RX 数据，含 utf8/hex/base64 三种表示）、`state`（端口开/关）、`tool-call`（MCP 工具调用通知）
- 64KB 滑动窗口接收缓冲区
- `announceToolCall()` 是 MCP 服务器到 Web UI 的桥接方法，让浏览器底栏显示 Claude 正在调什么工具

### MCP Server (`src/mcp-server.ts`)

- 10 个工具：
  - 串口：`list_ports`、`open_port`、`close_port`、`write_data`、`read_buffer`、`get_status`
  - Shell：`shell_start`、`shell_write`、`shell_read`、`shell_kill`
- 所有工具输出为人类可读的格式化文本（非 JSON）
- `read_buffer` / `shell_read` 会将 `\r\n` 规整为 `\n`，方便 Claude 解析终端输出

### Web Server (`src/web-server.ts`)

- Express 托管 `src/public/` 静态文件，带兼容开发与编译环境的路径回退逻辑
- WebSocket 在 `/ws` 路径广播 `SerialManager` 和 `ShellManager` 事件给所有浏览器客户端
- 浏览器发送 `{op, id, ...}` 消息，服务器回复 `{type: "ack", id, ...}`
- 端口通过 `SERIAL_MCP_UI_PORT` 环境变量配置（默认 3737）

### Browser UI (`src/public/index.html`)

- 单个自包含 HTML 文件，CSS/JS 全部内联（无构建步骤）
- xterm.js 从 CDN 加载，使用 FitAddon 和 WebLinksAddon
- 二进制安全渲染：使用 `b64` 字段解码为 `Uint8Array` 后调用 `term.write()`
- WebSocket 断线自动重连（1.2 秒间隔）
- Header Tab 栏切换串口/Shell 终端（`▸ tty` + `▸ sh:会话名` + `+` 新建按钮）
- 每个 shell 会话独立 xterm.js Terminal 实例，Tab 切换时切换 DOM 可见性
- Inspector 中 shell 帧用青色(cyan)标记，与串口 RX/TX 区分
- 侧边栏 Shell 面板：session 选择器、start/kill 按钮、shell 类型选择

### ShellManager (`src/shell-manager.ts`)

- 以 `shell` 导出的单例，继承 `EventEmitter`
- 管理多个 PTY 会话（`node-pty`），按 `name` 索引
- 三种事件：`shell-data`（PTY 输出数据，含 utf8/hex/base64 三种表示）、`shell-state`（会话列表变化）、`tool-call`（MCP 工具调用通知）
- 64KB 滑动窗口输出缓冲区
- Windows 上自动检测 shell：wsl.exe → pwsh.exe → powershell.exe → cmd.exe
- `announceToolCall()` 桥接 MCP 工具调用到 Web UI

## TypeScript 配置

ESM 项目（`"type": "module"`）。目标 ES2022，严格模式。输出到 `dist/`，源码在 `src/`。`src/public/` 目录不参与 TypeScript 编译。

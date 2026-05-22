# serial-mcp

> 让 Claude Code 直接操作串口，并在浏览器里像 MobaXterm 一样**实时围观**这台终端。

一个 Node.js 实现的 MCP（Model Context Protocol）服务器，把本机串口暴露给 Claude，同时内置一个 xterm.js 全功能终端 UI 让你旁观/接管会话。

---

## ✨ 是什么 / 为什么

调试嵌入式设备时，传统方式是：你在 MobaXterm 里手动敲命令、复制输出贴给 LLM、再把回复里的命令贴回去。麻烦、易错、丢上下文。

这个 MCP 让 Claude **直接控制**串口，同时浏览器开一个**同一根线**的终端视图——既不抢人，也不被人抢：

```
                                           ┌─────────────────────┐
                                    ┌──────►   Claude (LLM)      │
   ┌──────────┐   stdio (MCP)       │      └─────────────────────┘
   │          ◄─────────────────────┘
   │ serial-  │                            ┌─────────────────────┐
   │   mcp    │   WebSocket          ┌─────►  浏览器 xterm.js    │
   │ process  ◄──────────────────────┘      │  http://127.0.0.1: │
   │          │                             │       3737         │
   └────┬─────┘                             └─────────────────────┘
        │ node-serialport
        ▼
   ┌──────────┐
   │  COM1 /  │
   │ ttyUSB0  │
   └──────────┘
```

**核心设计**：MCP 与 Web UI 共享同一个 `SerialManager` 单例。Claude 调工具、你在浏览器按键、Claude 调工具、你又按键……都走同一根串口，UI 上看到的就是真实的合并视图。

---

## 🧠 基本原理

| 组件 | 职责 | 文件 |
|---|---|---|
| **SerialManager** | 串口打开/关闭/读写的单例 + EventEmitter，所有共享状态在这里 | `src/serial-manager.ts` |
| **MCP Server** | 注册 6 个工具，通过 stdio 跟 Claude 通信 | `src/mcp-server.ts` |
| **Web Server** | Express 静态托管 UI + WebSocket 双向桥接 | `src/web-server.ts` |
| **Web UI** | 单页 HTML，内嵌 xterm.js 终端 | `src/public/index.html` |
| **入口** | 并行启动 MCP stdio 与 Web 服务 | `src/index.ts` |

事件流：
- 串口 RX 数据 → `SerialManager` emit `frame` (含 utf8/hex/base64) → WebSocket 广播 → xterm 写入原始字节（保留 ANSI 转义、颜色、光标控制）
- Claude 调用工具 → `SerialManager` 写串口 + emit `tool-call` → UI 底栏闪显 `▸ tool_name`
- 浏览器按键 → xterm `onData` → WebSocket → `SerialManager` 写串口

---

## 📋 提供的 MCP 工具

| 工具 | 入参 | 输出（可读文本） |
|---|---|---|
| `list_ports` | — | 对齐的端口列表（path · 厂商 · PNP ID） |
| `open_port` | `path` *(必填)*, `baudRate` (默认 9600), `dataBits` (5/6/7/8), `stopBits` (1/1.5/2), `parity` (none/even/odd/mark/space) | `✓ 已打开 COM1` + 当前状态块 |
| `close_port` | — | `○ 已关闭 COM1` |
| `write_data` | `data` *(必填)*, `encoding` (`utf8` 或 `hex`，默认 utf8) | `→ 已发送 N 字节` + 预览 |
| `read_buffer` | `maxBytes` (默认 1024), `clear` (默认 true) | `← 接收 N 字节` + 分隔线包裹的纯文本输出 + hex 预览 |
| `get_status` | — | `● 当前状态` 块 |

输出统一为人类可读的多行文本（不是 JSON 大堆）。`read_buffer` 会把 `\r\n` 规整成 `\n` 方便 Claude 解析终端输出。

---

## 🚀 安装

### 先决条件

- Windows 10 / 11、macOS 或 Linux
- **Node.js ≥ 20**（推荐 22 或 24）
- **Claude Code** CLI 已装好（`claude --version` 能跑）

### 一键安装

```bash
# 1. 进入插件目录（如果还没有）
cd ~/.claude/mcps         # Windows: C:\Users\<you>\.claude\mcps
git clone <this-repo> serial-mcp   # 或手工把代码拷进来
cd serial-mcp

# 2. 安装依赖 & 构建
npm install
npm run build

# 3. 注册到 Claude Code（user scope，跨项目可用）
claude mcp add --scope user serial-mcp -- node "$(pwd)/dist/index.js"
# Windows PowerShell/Git Bash:
# claude mcp add --scope user serial-mcp -- node "C:\Users\<you>\.claude\mcps\serial-mcp\dist\index.js"

# 4. 验证
claude mcp list
# 应该看到：serial-mcp: node …\dist\index.js - ✓ Connected
```

完全退出 Claude Code（`/exit` 让 `claude` 进程退出），重新启动后 `/mcp` 即可看到 `serial-mcp` 及其 6 个工具。

> **注意**：Claude Code 仅在启动时读取 MCP 配置。光在交互里 `/clear` 不会重新加载 MCP，必须让 `claude` 进程整体退出。

### 卸载

```bash
claude mcp remove serial-mcp -s user
```

### 修改后重新生效

```bash
cd ~/.claude/mcps/serial-mcp
npm run build      # 改了 .ts 文件后必跑
# 改了 src/public/index.html → 只需刷新浏览器
# 改了 .ts → 必须重启 Claude Code 让 MCP 进程换成新 dist 代码
```

---

## 🖥️ Web UI 使用

启动 Claude Code 后，MCP 进程自动起来，UI 监听在：

```
http://127.0.0.1:3737
```

打开浏览器即用。要换端口：

```bash
# Linux/macOS
SERIAL_MCP_UI_PORT=8080 claude

# Windows PowerShell
$env:SERIAL_MCP_UI_PORT="8080"; claude
```

或者改 `claude mcp add` 时加 env：
```bash
claude mcp remove serial-mcp -s user
claude mcp add --scope user --env SERIAL_MCP_UI_PORT=8080 serial-mcp -- node "$(pwd)/dist/index.js"
```

### UI 功能

- **主区域** — xterm.js 全功能终端
  - 完整 ANSI 颜色、光标控制、滚屏
  - 点击进入后键盘直接发送到串口
  - 支持复制（选中即可，或点 `copy` 按钮）
- **左侧端口面板** — 选择 COM 口、波特率/数据位/停止位/校验位、Open/Close
- **左侧 Terminal 面板**
  - `local echo` — 本地回显（设备无回显时打开）
  - `send CR+LF on enter` — 部分老设备需要 CRLF
  - `clear` — 清屏（不影响串口）
  - `inspector` — 底部展开 hex 检视器，看每帧的时间戳/方向/hex
- **左侧 Quick Send** — Ctrl-C / Ctrl-D / ESC / ↑ ↓ / Tab 等热键
- **顶栏** — 连接状态 LED、当前端口@波特率、RX/TX 字节计数（K/M 自动换算）
- **底栏** — 最近一次 MCP 工具调用（橙紫色 `▸ tool_name`，让你一眼看到 Claude 触发了什么）

---

## 🤝 协作模式

UI 和 Claude **完全对等**——同一根串口、同一份缓冲区。常见姿势：

1. **Claude 主探，你旁观**：让 Claude 跑一连串命令探索设备，你在浏览器里看实时输出，必要时直接键盘介入纠偏
2. **你手探，Claude 解读**：你在浏览器里敲完一段命令，让 Claude `read_buffer` 后帮你分析输出
3. **Claude 写脚本你验证**：Claude 用 `write_data` 发批量指令，你在 UI 里看反馈是否符合预期

---

## 🐛 排障

| 现象 | 处理 |
|---|---|
| `claude mcp list` 显示 `✗ Failed to connect` | `node dist/index.js` 手动跑一次看 stderr 报错 |
| `/mcp` 里看不到 serial-mcp | 没真正重启 Claude Code。`/exit` 让 `claude` 进程退出再 `claude` |
| 浏览器开不了 `:3737` | 端口被占。设 `SERIAL_MCP_UI_PORT=别的端口` |
| UI 加载但终端不显示 RX | 旧版 `dist/` 没编译到新的 `b64` 字段。`npm run build` 后重启 Claude |
| `open_port` 报 `Access denied` | Windows: 端口已被其他程序占用（MobaXterm 没关、设备管理器禁用…） |
| 中文乱码 | 设备输出大概率是 GBK；当前 UI 按 UTF-8 解码。后续可在 UI 增加编码切换（待实现） |
| 修改 `.ts` 后没生效 | 忘了 `npm run build`；或忘了重启 Claude Code |

`dist/index.js` 启动时会把 UI 地址打到 **stderr**，Claude Code 日志里也能看到：

```
[serial-mcp] Serial MCP UI: http://127.0.0.1:3737
[serial-mcp] MCP stdio transport connected
```

> **重要**：所有 log 必须写 stderr，**绝不能写 stdout**——MCP 用 stdout 做协议帧，污染会导致连接断开。

---

## 📁 文件结构

```
serial-mcp/
├── package.json
├── tsconfig.json
├── README.md                ← 你正在看
├── src/
│   ├── index.ts             # 入口：并行启 MCP + Web，处理 SIGINT 优雅关串口
│   ├── serial-manager.ts    # 核心单例：串口生命周期 + 事件总线
│   ├── mcp-server.ts        # 6 个工具的 schema + handler
│   ├── web-server.ts        # Express + WebSocket，订阅 SerialManager 事件
│   └── public/
│       └── index.html       # 完整 UI（xterm.js + 所有 CSS/JS 内联）
└── dist/                    # tsc 输出，git 不跟踪
```

---

## 🔧 技术栈

- **MCP**: [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) ^1.0
- **串口**: [`serialport`](https://serialport.io/) ^12（自带 Win/macOS/Linux 预编译二进制）
- **HTTP/WS**: [`express`](https://expressjs.com/) ^4 + [`ws`](https://github.com/websockets/ws) ^8
- **终端**: [`@xterm/xterm`](https://xtermjs.org/) 5.5 + `addon-fit` + `addon-web-links`（CDN 引入）
- **语言**: TypeScript 5

---

## 🛣️ 路线图（视使用情况添加）

- [ ] 编码切换（UTF-8 / GBK / Latin-1）
- [ ] 保存会话日志到文件
- [ ] 触发器 / 自动应答（regex match → auto send）
- [ ] 端口分组多窗格
- [ ] 录制 & 回放
- [ ] MCP `subscribe` 资源：让 Claude 持续观察 RX 流而不是 poll `read_buffer`

---

## 📄 许可

MIT —— kgg 自用，欢迎 fork。

---

## 🧪 一次完整探索的样子

下面是用这个 MCP 一次性识别出一台陌生工业相机的流程片段：

```
Claude → list_ports        ← 发现 COM1
Claude → open_port 115200  ← 进入
Claude → write_data "\r\n" → 得到 ~ # 提示符 → BusyBox 嵌入式 Linux
Claude → uname -a / cat /proc/cpuinfo → Xilinx Zynq ARMv7
Claude → cat /dav/initrun.sh → 看到 hikio.ko / fpga.bit / cascade addressing
Claude → gethardinfo → DevType: MV-CIS-660mm-18-91F4M
                     → 锁定为海康 660mm 接触式图像传感器
```

整个过程 LLM 全自动跑，浏览器里的终端把过程同步展示给人，关键时候人也能随时接管。这就是它存在的理由。

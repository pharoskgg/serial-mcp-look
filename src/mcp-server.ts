import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { serial } from "./serial-manager.js";
import { shell } from "./shell-manager.js";

const TOOLS = [
  {
    name: "list_ports",
    description: "List all serial ports available on this machine.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_port",
    description:
      "Open a serial port. If a port is already open, it is closed first. " +
      "Default baudRate=115200, dataBits=8, stopBits=1, parity='none'.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Port path e.g. COM3 or /dev/ttyUSB0" },
        baudRate: { type: "number" },
        dataBits: { type: "number", enum: [5, 6, 7, 8] },
        stopBits: { type: "number", enum: [1, 1.5, 2] },
        parity: { type: "string", enum: ["none", "even", "odd", "mark", "space"] },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "close_port",
    description: "Close the currently open serial port.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "write_data",
    description:
      "Write data to the open serial port. " +
      "encoding='utf8' sends the string as-is; 'hex' parses hex pairs (whitespace ignored).",
    inputSchema: {
      type: "object",
      properties: {
        data: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "hex"], default: "utf8" },
      },
      required: ["data"],
      additionalProperties: false,
    },
  },
  {
    name: "read_buffer",
    description:
      "Return up to maxBytes from the most recent receive buffer (default 1024). " +
      "If clear=true (default), the buffer is emptied after reading.",
    inputSchema: {
      type: "object",
      properties: {
        maxBytes: { type: "number", default: 1024 },
        clear: { type: "boolean", default: true },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_status",
    description: "Return current connection status, port options, and byte counters.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "shell_start",
    description:
      "Start a local shell session (PTY). On Windows, defaults to cmd.exe.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name (default: shell-1)" },
        shell: { type: "string", description: "Shell executable e.g. wsl.exe, cmd.exe, powershell" },
        cols: { type: "number", description: "Terminal columns (default: 80)" },
        rows: { type: "number", description: "Terminal rows (default: 24)" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "shell_write",
    description:
      "Write data to a running shell session's stdin. encoding='utf8' sends the string as-is; 'hex' parses hex pairs.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name" },
        data: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "hex"], default: "utf8" },
      },
      required: ["name", "data"],
      additionalProperties: false,
    },
  },
  {
    name: "shell_read",
    description:
      "Read recent output from a shell session. If clear=true (default), the buffer is emptied after reading.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name" },
        maxBytes: { type: "number", default: 4096 },
        clear: { type: "boolean", default: true },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "shell_kill",
    description: "Kill a running shell session.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name" },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
] as const;

function text(s: string) {
  return { content: [{ type: "text", text: s }] };
}

function fail(msg: string) {
  return {
    content: [{ type: "text", text: `✕ 错误：${msg}` }],
    isError: true,
  };
}

function previewHex(hex: string, maxBytes = 48): string {
  const parts = hex.split(" ").filter(Boolean);
  if (parts.length <= maxBytes) return parts.join(" ");
  return parts.slice(0, maxBytes).join(" ") + ` … (+${parts.length - maxBytes})`;
}

function cleanTerminal(utf8: string): string {
  // \r\n -> \n, lone \r -> \n, strip trailing whitespace per line
  return utf8.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function visibleEscapes(s: string): string {
  // Show non-printable chars as \xHH; preserve \n as actual newlines for layout
  return s.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, (c) => {
    const code = c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
    return `\\x${code}`;
  });
}

type Status = ReturnType<typeof import("./serial-manager.js").serial.status>;

function fmtStatus(s: Status, header: string): string {
  if (!s.isOpen) {
    if (s.lastError) return `${header}\n  ○ 未连接（上次错误：${s.lastError}）`;
    return `${header}\n  ○ 未连接`;
  }
  const o = s.options!;
  const parity = (o.parity || "none").toUpperCase()[0];
  return [
    `${header}`,
    `  ● ${s.path}  @ ${o.baudRate} ${o.dataBits}${parity}${o.stopBits}`,
    `  RX ${s.rxBytes} B   TX ${s.txBytes} B${s.lastError ? `\n  ⚠ 上次错误：${s.lastError}` : ""}`,
  ].join("\n");
}

export function createMcpServer() {
  const server = new Server(
    { name: "serial-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;

    try {
      switch (name) {
        case "list_ports": {
          serial.announceToolCall(name, "");
          const ports = await serial.list();
          if (ports.length === 0) return text("未找到任何串口");
          const lines = [`找到 ${ports.length} 个串口：`, ""];
          const w = Math.max(8, ...ports.map((p) => p.path.length));
          for (const p of ports) {
            const meta = [p.manufacturer, p.serialNumber, p.pnpId].filter(Boolean).join(" · ");
            lines.push(`  ${p.path.padEnd(w)}   ${meta || "—"}`);
          }
          return text(lines.join("\n"));
        }
        case "open_port": {
          const path = String(args.path ?? "");
          if (!path) return fail("'path' 是必填项");
          serial.announceToolCall(name, `${path} @${args.baudRate ?? 115200}`);
          const status = await serial.open({
            path,
            baudRate: args.baudRate as number | undefined,
            dataBits: args.dataBits as 5 | 6 | 7 | 8 | undefined,
            stopBits: args.stopBits as 1 | 1.5 | 2 | undefined,
            parity: args.parity as
              | "none"
              | "even"
              | "odd"
              | "mark"
              | "space"
              | undefined,
          });
          return text(fmtStatus(status, `✓ 已打开 ${path}`));
        }
        case "close_port": {
          serial.announceToolCall(name, "");
          const wasPath = serial.status().path;
          const status = await serial.close();
          return text(fmtStatus(status, wasPath ? `○ 已关闭 ${wasPath}` : "○ 当前无打开的端口"));
        }
        case "write_data": {
          const data = String(args.data ?? "");
          const encoding = (args.encoding ?? "utf8") as "utf8" | "hex";
          serial.announceToolCall(
            name,
            `${encoding}: ${data.length > 40 ? data.slice(0, 40) + "…" : data}`
          );
          const r = await serial.write(data, encoding);
          const preview =
            encoding === "utf8"
              ? visibleEscapes(data.length > 200 ? data.slice(0, 200) + "…" : data)
              : data.replace(/\s+/g, " ").trim();
          return text(`→ 已发送 ${r.bytes} 字节 (${encoding})\n  ${preview}`);
        }
        case "read_buffer": {
          const maxBytes = (args.maxBytes as number | undefined) ?? 1024;
          const clear = (args.clear as boolean | undefined) ?? true;
          serial.announceToolCall(name, `maxBytes=${maxBytes} clear=${clear}`);
          const r = serial.readBuffer(maxBytes, clear);
          if (r.bytes === 0) return text("← 缓冲区为空（0 字节）");
          const sep = "─".repeat(56);
          return text(
            [
              `← 接收 ${r.bytes} 字节${clear ? "（已清空缓冲区）" : ""}`,
              sep,
              cleanTerminal(r.utf8),
              sep,
              `hex: ${previewHex(r.hex)}`,
            ].join("\n")
          );
        }
        case "get_status": {
          serial.announceToolCall(name, "");
          const s = serial.status();
          return text(fmtStatus(s, "● 当前状态"));
        }
        case "shell_start": {
          const sessionName = String(args.name ?? "shell-1");
          const shellPath = args.shell ? String(args.shell) : undefined;
          const cols = (args.cols as number | undefined) ?? 80;
          const rows = (args.rows as number | undefined) ?? 24;
          shell.announceToolCall(name, `${sessionName} ${shellPath ?? "auto"}`);
          const info = await shell.start(sessionName, shellPath, cols, rows);
          return text(
            `✓ 已启动 shell 会话\n  ● ${info.name}  ${info.shell}  PID ${info.pid}  ${info.cols}×${info.rows}`
          );
        }
        case "shell_write": {
          const sessionName = String(args.name ?? "");
          if (!sessionName) return fail("'name' 是必填项");
          const data = String(args.data ?? "");
          const encoding = (args.encoding ?? "utf8") as "utf8" | "hex";
          shell.announceToolCall(
            name,
            `${sessionName} ${encoding}: ${data.length > 40 ? data.slice(0, 40) + "…" : data}`
          );
          const r = await shell.write(sessionName, data, encoding);
          return text(`→ 已发送 ${r.bytes} 字节到 ${sessionName} (${encoding})`);
        }
        case "shell_read": {
          const sessionName = String(args.name ?? "");
          if (!sessionName) return fail("'name' 是必填项");
          const maxBytes = (args.maxBytes as number | undefined) ?? 4096;
          const clear = (args.clear as boolean | undefined) ?? true;
          shell.announceToolCall(name, `${sessionName} maxBytes=${maxBytes} clear=${clear}`);
          const r = shell.readBuffer(sessionName, maxBytes, clear);
          if (r.bytes === 0) return text(`← ${sessionName} 缓冲区为空（0 字节）`);
          const sep = "─".repeat(56);
          return text(
            [
              `← ${sessionName} 接收 ${r.bytes} 字节${clear ? "（已清空缓冲区）" : ""}`,
              sep,
              r.utf8,
              sep,
              `hex: ${previewHex(r.hex)}`,
            ].join("\n")
          );
        }
        case "shell_kill": {
          const sessionName = String(args.name ?? "");
          if (!sessionName) return fail("'name' 是必填项");
          shell.announceToolCall(name, sessionName);
          await shell.kill(sessionName);
          return text(`○ 已结束 shell 会话 ${sessionName}`);
        }
        default:
          return fail(`未知工具：${name}`);
      }
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  });

  return server;
}

export async function startMcp() {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

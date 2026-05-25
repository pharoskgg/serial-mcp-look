import { EventEmitter } from "node:events";
import { execSync } from "node:child_process";
import type { IPty } from "node-pty";
import { spawn } from "node-pty";
import { type Frame } from "./serial-manager.js";

export type SessionInfo = {
  name: string;
  shell: string;
  pid: number;
  isRunning: boolean;
  cols: number;
  rows: number;
  created: number;
};

export type ShellStatus = {
  sessions: SessionInfo[];
};

const MAX_BUFFER = 64 * 1024;

function bufToHex(b: Buffer): string {
  return b.toString("hex").toUpperCase().match(/.{1,2}/g)?.join(" ") ?? "";
}

/** Detect preferred shell on Windows. */
function detectShell(): string {
  for (const candidate of ["wsl.exe", "pwsh.exe", "powershell.exe", "cmd.exe"]) {
    try {
      execSync(`where ${candidate}`, { stdio: "ignore" });
      return candidate;
    } catch {
      continue;
    }
  }
  return "cmd.exe";
}

type ShellEntry = {
  pty: IPty;
  info: SessionInfo;
  outputBuffer: Buffer;
};

export class ShellManager extends EventEmitter {
  private sessions = new Map<string, ShellEntry>();

  /** Normalise \r\n and lone \r to \n, matching the MCP serial helper. */
  private cleanOutput(utf8: string): string {
    return utf8.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  /**
   * Start a new shell session.
   * @param name  Session name (default "shell-1")
   * @param shellPath  Shell executable (default auto-detect)
   * @param cols  PTY columns (default 80)
   * @param rows  PTY rows (default 24)
   */
  async start(
    name: string = "shell-1",
    shellPath?: string,
    cols: number = 80,
    rows: number = 24
  ): Promise<SessionInfo> {
    if (this.sessions.has(name)) {
      throw new Error(`Session "${name}" already exists`);
    }

    const shell = shellPath ?? detectShell();

    const pty = spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: { ...process.env },
    });

    const entry: ShellEntry = {
      pty,
      info: {
        name,
        shell,
        pid: pty.pid,
        isRunning: true,
        cols,
        rows,
        created: Date.now(),
      },
      outputBuffer: Buffer.alloc(0),
    };

    this.sessions.set(name, entry);

    pty.onData((data: string) => {
      const chunk = Buffer.from(data, "utf8");
      entry.outputBuffer = Buffer.concat([entry.outputBuffer, chunk]).subarray(
        Math.max(0, entry.outputBuffer.length + chunk.length - MAX_BUFFER)
      );

      const frame: Frame = {
        ts: Date.now(),
        dir: "rx",
        utf8: data,
        hex: bufToHex(chunk),
        b64: chunk.toString("base64"),
        bytes: chunk.length,
      };
      this.emit("shell-data", name, frame);
    });

    pty.onExit(({ exitCode, signal }) => {
      entry.info.isRunning = false;
      this.emit("shell-state", this.list());
    });

    // Give the PTY a moment to start before announcing
    await new Promise((r) => setTimeout(r, 50));
    this.emit("shell-state", this.list());
    return entry.info;
  }

  /** Write data to a session's stdin. */
  async write(
    name: string,
    data: string,
    encoding: "utf8" | "hex" = "utf8"
  ): Promise<{ bytes: number }> {
    const entry = this.sessions.get(name);
    if (!entry) throw new Error(`Session "${name}" not found`);
    if (!entry.info.isRunning) throw new Error(`Session "${name}" is not running`);

    const text = encoding === "hex"
      ? Buffer.from(data.replace(/\s+/g, ""), "hex").toString("utf8")
      : data;

    entry.pty.write(text);

    const bytes = Buffer.byteLength(text, "utf8");
    return { bytes };
  }

  /** Read buffered output from a session. */
  readBuffer(
    name: string,
    maxBytes: number = 4096,
    clear: boolean = true
  ): { utf8: string; hex: string; bytes: number } {
    const entry = this.sessions.get(name);
    if (!entry) throw new Error(`Session "${name}" not found`);

    const take = entry.outputBuffer.subarray(
      Math.max(0, entry.outputBuffer.length - maxBytes)
    );
    const result = {
      utf8: this.cleanOutput(take.toString("utf8")),
      hex: bufToHex(take),
      bytes: take.length,
    };
    if (clear) entry.outputBuffer = Buffer.alloc(0);
    return result;
  }

  /** Kill a session. */
  async kill(name: string): Promise<void> {
    const entry = this.sessions.get(name);
    if (!entry) throw new Error(`Session "${name}" not found`);

    try {
      entry.pty.kill();
    } catch {
      // PTY may already be dead
    }
    this.sessions.delete(name);
    this.emit("shell-state", this.list());
  }

  /** Kill all sessions (used during shutdown). */
  async killAll(): Promise<void> {
    const names = Array.from(this.sessions.keys());
    await Promise.all(names.map((n) => this.kill(n).catch(() => {})));
  }

  /** List all sessions. */
  list(): SessionInfo[] {
    return Array.from(this.sessions.values()).map((e) => e.info);
  }

  /** Get a single session's info. */
  status(name: string): SessionInfo | null {
    return this.sessions.get(name)?.info ?? null;
  }

  /** Notify web UI about MCP tool calls. */
  announceToolCall(name: string, summary: string) {
    this.emit("tool-call", { ts: Date.now(), name, summary });
  }
}

export const shell = new ShellManager();

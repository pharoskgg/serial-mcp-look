import { startMcp } from "./mcp-server.js";
import { startWebServer } from "./web-server.js";
import { serial } from "./serial-manager.js";
import { shell } from "./shell-manager.js";

// CRITICAL: MCP stdio uses stdout for protocol. All logging MUST go to stderr.
function log(...args: unknown[]) {
  console.error("[serial-mcp]", ...args);
}

async function main() {
  const uiPort = parseInt(process.env.SERIAL_MCP_UI_PORT ?? "33571", 10);
  let uiUrl: string | undefined;

  // 启动 Web UI；失败不影响 MCP 主服务启动。
  try {
    const ui = await startWebServer(uiPort);
    uiUrl = ui.url;
    if (ui.didFallback) {
      log(`Serial MCP UI: ${ui.url} (preferred port ${ui.requestedPort} was busy)`);
    } else {
      log(`Serial MCP UI: ${ui.url}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`UI failed to start on ${uiPort}: ${message}`);
  }

  // 启动 MCP stdio 服务（阻塞，用于保持进程存活）。
  await startMcp({ uiUrl });
  log("MCP stdio transport connected");
}

async function shutdown(signal: string) {
  log(`received ${signal}, closing serial port and shell sessions…`);
  try {
    await serial.close();
    await shell.killAll();
  } catch (e) {
    log("error closing port:", e);
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => log("uncaught:", err));
process.on("unhandledRejection", (err) => log("unhandled rejection:", err));

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});

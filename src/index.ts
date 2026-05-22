import { startMcp } from "./mcp-server.js";
import { startWebServer } from "./web-server.js";
import { serial } from "./serial-manager.js";

// CRITICAL: MCP stdio uses stdout for protocol. All logging MUST go to stderr.
function log(...args: unknown[]) {
  console.error("[serial-mcp]", ...args);
}

async function main() {
  const uiPort = parseInt(process.env.SERIAL_MCP_UI_PORT ?? "3737", 10);

  // Start Web UI; failure here is non-fatal — MCP must still come up.
  startWebServer(uiPort)
    .then(({ url }) => log(`Serial MCP UI: ${url}`))
    .catch((err) => log(`UI failed to start on ${uiPort}: ${err.message}`));

  // Start MCP stdio server (blocking — keeps the process alive).
  await startMcp();
  log("MCP stdio transport connected");
}

async function shutdown(signal: string) {
  log(`received ${signal}, closing serial port…`);
  try {
    await serial.close();
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

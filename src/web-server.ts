import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { serial, type Frame, type Status } from "./serial-manager.js";
import { shell, type SessionInfo } from "./shell-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type WebServerInstance = {
  server: http.Server;
};

type WebServerResult = {
  url: string;
  port: number;
  requestedPort: number;
  didFallback: boolean;
};

function createWebServer(): WebServerInstance {
  const app = express();
  const candidates = [
    path.resolve(__dirname, "public"),
    path.resolve(__dirname, "..", "src", "public"),
  ];
  const staticDir = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
  if (staticDir) app.use(express.static(staticDir));

  const server = http.createServer(app);

  return { server };
}

function listenOn(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => reject(err);
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

function isAddressInUse(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "EADDRINUSE"
  );
}

function closeFailedInstance({ server }: WebServerInstance) {
  try {
    server.close();
  } catch {
    // 忽略启动失败后的清理错误，后续会继续尝试备用端口。
  }
}

function attachBridge(wss: WebSocketServer) {
  function broadcast(msg: unknown) {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  serial.on("state", (s: Status) => broadcast({ type: "status", status: s }));
  serial.on("frame", (f: Frame) => broadcast({ type: "frame", frame: f }));
  serial.on("tool-call", (e: { ts: number; name: string; summary: string }) =>
    broadcast({ type: "tool-call", ...e })
  );

  shell.on("shell-data", (sessionName: string, f: Frame) =>
    broadcast({ type: "shell-frame", session: sessionName, frame: f })
  );
  shell.on("shell-state", (sessions: SessionInfo[]) =>
    broadcast({ type: "shell-list", sessions })
  );
  shell.on("tool-call", (e: { ts: number; name: string; summary: string }) =>
    broadcast({ type: "tool-call", ...e })
  );

  wss.on("connection", async (ws) => {
    // initial sync
    try {
      const ports = await serial.list();
      ws.send(JSON.stringify({ type: "ports", ports }));
    } catch (e) {
      ws.send(JSON.stringify({ type: "ports", ports: [] }));
    }
    ws.send(JSON.stringify({ type: "status", status: serial.status() }));
    ws.send(JSON.stringify({ type: "shell-list", sessions: shell.list() }));

    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const id = msg.id;
      const reply = (extra: Record<string, unknown> = {}) =>
        ws.send(JSON.stringify({ type: "ack", id, ...extra }));
      try {
        switch (msg.op) {
          case "refresh": {
            const ports = await serial.list();
            ws.send(JSON.stringify({ type: "ports", ports }));
            reply();
            break;
          }
          case "status": {
            ws.send(JSON.stringify({ type: "status", status: serial.status() }));
            reply();
            break;
          }
          case "open": {
            await serial.open({
              path: msg.path,
              baudRate: msg.baudRate,
              dataBits: msg.dataBits,
              stopBits: msg.stopBits,
              parity: msg.parity,
            });
            reply();
            break;
          }
          case "close": {
            await serial.close();
            reply();
            break;
          }
          case "write": {
            await serial.write(String(msg.data ?? ""), msg.encoding === "hex" ? "hex" : "utf8");
            reply();
            break;
          }
          case "shell-start": {
            const info = await shell.start(
              msg.name ?? "shell-1",
              msg.shell || undefined,
              msg.cols ?? 80,
              msg.rows ?? 24
            );
            reply({ info });
            break;
          }
          case "shell-write": {
            await shell.write(
              String(msg.name ?? ""),
              String(msg.data ?? ""),
              msg.encoding === "hex" ? "hex" : "utf8"
            );
            reply();
            break;
          }
          case "shell-kill": {
            await shell.kill(String(msg.name ?? ""));
            reply();
            break;
          }
          case "shell-list": {
            ws.send(JSON.stringify({ type: "shell-list", sessions: shell.list() }));
            reply();
            break;
          }
          default:
            reply({ error: `unknown op: ${msg.op}` });
        }
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        reply({ error: m });
      }
    });
  });
}

export async function startWebServer(port: number): Promise<WebServerResult> {
  let instance = createWebServer();

  try {
    const actualPort = await listenOn(instance.server, port);
    const wss = new WebSocketServer({ server: instance.server, path: "/ws" });
    attachBridge(wss);
    return {
      url: `http://127.0.0.1:${actualPort}`,
      port: actualPort,
      requestedPort: port,
      didFallback: false,
    };
  } catch (err) {
    closeFailedInstance(instance);
    if (!isAddressInUse(err)) throw err;
  }

  instance = createWebServer();
  const actualPort = await listenOn(instance.server, 0);
  const wss = new WebSocketServer({ server: instance.server, path: "/ws" });
  attachBridge(wss);
  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    requestedPort: port,
    didFallback: true,
  };
}

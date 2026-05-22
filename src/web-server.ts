import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { serial, type Frame, type Status } from "./serial-manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startWebServer(port: number): Promise<{ url: string }> {
  const app = express();
  const candidates = [
    path.resolve(__dirname, "public"),
    path.resolve(__dirname, "..", "src", "public"),
  ];
  const staticDir = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
  if (staticDir) app.use(express.static(staticDir));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

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

  wss.on("connection", async (ws) => {
    // initial sync
    try {
      const ports = await serial.list();
      ws.send(JSON.stringify({ type: "ports", ports }));
    } catch (e) {
      ws.send(JSON.stringify({ type: "ports", ports: [] }));
    }
    ws.send(JSON.stringify({ type: "status", status: serial.status() }));

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
          default:
            reply({ error: `unknown op: ${msg.op}` });
        }
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        reply({ error: m });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${port}` });
    });
  });
}

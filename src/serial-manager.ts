import { EventEmitter } from "node:events";
import { SerialPort } from "serialport";

export type OpenOptions = {
  path: string;
  baudRate?: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 1.5 | 2;
  parity?: "none" | "even" | "odd" | "mark" | "space";
};

export type PortInfo = {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  vendorId?: string;
  productId?: string;
};

export type FrameDirection = "rx" | "tx";

export type Frame = {
  ts: number;
  dir: FrameDirection;
  utf8: string;
  hex: string;
  b64: string;
  bytes: number;
};

export type Status = {
  isOpen: boolean;
  path: string | null;
  options: Required<Omit<OpenOptions, "path">> | null;
  rxBytes: number;
  txBytes: number;
  lastError: string | null;
};

const MAX_BUFFER = 64 * 1024;

function bufToHex(b: Buffer): string {
  return b.toString("hex").toUpperCase().match(/.{1,2}/g)?.join(" ") ?? "";
}

function bufToPrintableUtf8(b: Buffer): string {
  // Replace non-printable bytes with dot for display safety
  const s = b.toString("utf8");
  return s.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, ".");
}

export class SerialManager extends EventEmitter {
  private port: SerialPort | null = null;
  private currentPath: string | null = null;
  private currentOptions: Required<Omit<OpenOptions, "path">> | null = null;
  private rxBuffer: Buffer = Buffer.alloc(0);
  private rxBytes = 0;
  private txBytes = 0;
  private lastError: string | null = null;

  async list(): Promise<PortInfo[]> {
    const ports = await SerialPort.list();
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      pnpId: p.pnpId,
      vendorId: p.vendorId,
      productId: p.productId,
    }));
  }

  status(): Status {
    return {
      isOpen: !!this.port?.isOpen,
      path: this.currentPath,
      options: this.currentOptions,
      rxBytes: this.rxBytes,
      txBytes: this.txBytes,
      lastError: this.lastError,
    };
  }

  async open(opts: OpenOptions): Promise<Status> {
    if (this.port?.isOpen) {
      await this.close();
    }
    const fullOpts = {
      baudRate: opts.baudRate ?? 9600,
      dataBits: opts.dataBits ?? 8,
      stopBits: opts.stopBits ?? 1,
      parity: opts.parity ?? "none",
    } as const;

    await new Promise<void>((resolve, reject) => {
      const p = new SerialPort(
        {
          path: opts.path,
          baudRate: fullOpts.baudRate,
          dataBits: fullOpts.dataBits,
          stopBits: fullOpts.stopBits,
          parity: fullOpts.parity,
          autoOpen: false,
        },
        (err) => {
          // constructor callback fires after open attempt when autoOpen true; we use autoOpen false
        }
      );
      this.port = p;
      p.open((err) => {
        if (err) {
          this.port = null;
          this.lastError = err.message;
          reject(err);
          return;
        }
        this.currentPath = opts.path;
        this.currentOptions = fullOpts;
        this.lastError = null;
        this.rxBytes = 0;
        this.txBytes = 0;
        this.rxBuffer = Buffer.alloc(0);
        this.attachListeners(p);
        this.emit("state", this.status());
        resolve();
      });
    });

    return this.status();
  }

  private attachListeners(p: SerialPort) {
    p.on("data", (chunk: Buffer) => {
      this.rxBytes += chunk.length;
      this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]).subarray(
        Math.max(0, this.rxBuffer.length + chunk.length - MAX_BUFFER)
      );
      const frame: Frame = {
        ts: Date.now(),
        dir: "rx",
        utf8: bufToPrintableUtf8(chunk),
        hex: bufToHex(chunk),
        b64: chunk.toString("base64"),
        bytes: chunk.length,
      };
      this.emit("frame", frame);
    });
    p.on("error", (err) => {
      this.lastError = err.message;
      this.emit("state", this.status());
    });
    p.on("close", () => {
      this.emit("state", this.status());
    });
  }

  async close(): Promise<Status> {
    const p = this.port;
    if (!p) return this.status();
    await new Promise<void>((resolve) => {
      if (!p.isOpen) {
        resolve();
        return;
      }
      p.close(() => resolve());
    });
    this.port = null;
    this.currentPath = null;
    this.currentOptions = null;
    this.emit("state", this.status());
    return this.status();
  }

  async write(data: string, encoding: "utf8" | "hex"): Promise<{ bytes: number }> {
    if (!this.port?.isOpen) {
      throw new Error("Serial port is not open");
    }
    const buf =
      encoding === "hex"
        ? Buffer.from(data.replace(/\s+/g, ""), "hex")
        : Buffer.from(data, "utf8");
    await new Promise<void>((resolve, reject) => {
      this.port!.write(buf, (err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      this.port!.drain((err) => (err ? reject(err) : resolve()));
    });
    this.txBytes += buf.length;
    const frame: Frame = {
      ts: Date.now(),
      dir: "tx",
      utf8: bufToPrintableUtf8(buf),
      hex: bufToHex(buf),
      b64: buf.toString("base64"),
      bytes: buf.length,
    };
    this.emit("frame", frame);
    return { bytes: buf.length };
  }

  readBuffer(maxBytes: number, clear: boolean): { utf8: string; hex: string; bytes: number } {
    const take = this.rxBuffer.subarray(Math.max(0, this.rxBuffer.length - maxBytes));
    const result = {
      utf8: bufToPrintableUtf8(take),
      hex: bufToHex(take),
      bytes: take.length,
    };
    if (clear) this.rxBuffer = Buffer.alloc(0);
    return result;
  }

  /** UI announcements: emit a tool-call event so the web UI can show what Claude did. */
  announceToolCall(name: string, summary: string) {
    this.emit("tool-call", { ts: Date.now(), name, summary });
  }
}

export const serial = new SerialManager();

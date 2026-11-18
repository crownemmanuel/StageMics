// A pretend Shader video recorder: the three endpoints StageMics uses (shader/docs/stagemics-markers.md),
// so the scene-marker link can be tried without Shader. Prints every marker it saves.
//
//   node scripts/fake-shader.ts [--port 9202] [--key <pairing key>] [--idle]
//
// --idle starts without a take; type "r" + Enter to start or stop one. app/check.ts drives it in-process.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const FAKE_SHADER_PROTOCOL = "shader.recorder/1";

export interface SavedEvent {
  session: string;
  body: Record<string, unknown>;
  raw: string;
  receivedAt: number;
}

export class FakeShader {
  key: string;
  take: { id: string; name: string; startedUtc: number } | null = null;
  /** Takes that existed (events may still be replayed to them). */
  takes = new Set<string>();
  events: SavedEvent[] = [];
  /** Save the next N events but answer 500, as if the answer was lost. */
  loseAcks = 0;
  /** The fake's monotonic clock runs this far from this computer's wall clock (ms), like another computer. */
  clockMs: number;
  private server: Server | null = null;
  private readonly mono0 = process.hrtime.bigint();

  constructor(opts: { key?: string; clockMs?: number } = {}) {
    this.key = opts.key ?? "";
    this.clockMs = opts.clockMs ?? 5000;
  }

  startTake(name = "Fake take") {
    this.take = { id: randomUUID(), name, startedUtc: Date.now() };
    this.takes.add(this.take.id);
    return this.take.id;
  }

  stopTake() {
    this.take = null;
  }

  /** Nanosecond ticks of a clock unrelated to the wall clock. */
  ticks() {
    return process.hrtime.bigint() - this.mono0 + BigInt(this.clockMs) * 1_000_000n;
  }

  listen(port: number, host = "127.0.0.1") {
    return new Promise<void>((ok, fail) => {
      const s = createServer((req, res) => void this.handle(req, res));
      s.once("error", fail);
      s.listen(port, host, () => {
        this.server = s;
        ok();
      });
    });
  }

  close() {
    return new Promise<void>((ok) => {
      if (!this.server) return ok();
      this.server.closeAllConnections();
      this.server.close(() => ok());
      this.server = null;
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const t2 = this.ticks();
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    let raw = "";
    for await (const c of req) raw += c;
    if (this.key && req.headers.authorization !== `Bearer ${this.key}`) return send(401, { status: "rejected", code: "UNAUTHORIZED", error: "Wrong or missing pairing key" });
    const url = req.url ?? "";
    if (req.method === "GET" && url === "/recorder/v1/session") {
      return send(200, {
        protocol: FAKE_SHADER_PROTOCOL, app: "Fake Shader", version: "0.0.1",
        recording: !!this.take, recordingSessionId: this.take?.id ?? null, sessionName: this.take?.name ?? null, showRunId: null,
        startedUtc: this.take ? String(this.take.startedUtc) : null, sessionClockId: "fake-mono", ticksPerSecond: "1000000000",
      });
    }
    if (req.method === "POST" && url === "/recorder/v1/clock/probe") {
      const j = JSON.parse(raw || "{}");
      return send(200, { t1: j.t1, t2: String(t2), t3: String(this.ticks()), sessionClockId: "fake-mono", ticksPerSecond: "1000000000", utc: String(Date.now()) });
    }
    const m = /^\/recorder\/v1\/sessions\/([^/]+)\/events$/.exec(url);
    if (req.method === "POST" && m) {
      const session = decodeURIComponent(m[1]);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(400, { status: "rejected", code: "BAD_JSON", error: "Not JSON" });
      }
      if (body.protocol !== FAKE_SHADER_PROTOCOL) return send(422, { status: "rejected", code: "BAD_PROTOCOL", error: `Unsupported protocol ${String(body.protocol)}` });
      if (!this.takes.has(session) || body.recordingSessionId !== session) return send(404, { status: "rejected", code: "UNKNOWN_SESSION", error: "No such take" });
      const same = this.events.find((e) => e.body.eventId === body.eventId);
      if (same) return same.raw === raw ? send(200, { status: "duplicate", eventId: body.eventId }) : send(409, { status: "rejected", code: "EVENT_ID_CONFLICT", error: "Same event id, different content" });
      this.events.push({ session, body, raw, receivedAt: Date.now() });
      if (this.loseAcks > 0) {
        this.loseAcks--;
        return send(500, { status: "rejected", code: "TEST", error: "answer lost (test)" });
      }
      return send(201, { status: "saved", eventId: body.eventId, recordingSessionId: session, journalSequence: String(this.events.length) });
    }
    send(404, { status: "rejected", code: "NOT_FOUND", error: `${req.method} ${url}` });
  }
}

if (import.meta.main) {
  const arg = (k: string) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const port = Number(arg("--port") ?? 9202);
  const fake = new FakeShader({ key: arg("--key") ?? "" });
  if (!process.argv.includes("--idle")) fake.startTake("Fake take");
  const seen = fake.events.push.bind(fake.events);
  fake.events.push = (...e: SavedEvent[]) => {
    for (const x of e) {
      const b = x.body as { type: string; label: string; sequence: string; time: { utc: string; clock?: { uncertaintyTicks: string } }; alreadyLive?: boolean };
      const late = x.receivedAt - Number(b.time.utc);
      console.log(`${new Date(Number(b.time.utc)).toLocaleTimeString()}  #${b.sequence} ${b.type.padEnd(11)} ${b.label}${b.alreadyLive ? " (already live)" : ""}${late > 1000 ? ` (arrived ${(late / 1000).toFixed(1)} s late)` : ""}${b.time.clock ? ` ±${Number(b.time.clock.uncertaintyTicks) / 1e6} ms` : ""}`);
    }
    return seen(...e);
  };
  await fake.listen(port, "0.0.0.0");
  console.log(`fake Shader recorder on http://0.0.0.0:${port}/recorder/v1 ${fake.key ? "(key required)" : "(no key)"} — ${fake.take ? `recording "${fake.take.name}"` : "idle"}; type r + Enter to start/stop a take`);
  process.stdin.on("data", (d) => {
    if (String(d).trim() !== "r") return;
    if (fake.take) {
      fake.stopTake();
      console.log("take stopped");
    } else console.log(`take started: ${fake.startTake(`Fake take ${fake.takes.size + 1}`)}`);
  });
}

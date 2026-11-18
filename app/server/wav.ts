// Mono 24-bit Broadcast WAV files: what the recorder writes and exports. The `bext` chunk carries the time of
// day the file starts at (samples since midnight), so an editor can line the tracks up with camera timecode.
//
// Layout: RIFF header (12) · fmt (8 + 16) · bext (8 + 602 + coding history) · data (8 + samples).
// The sizes in the RIFF and data headers are patched as the file grows; a file cut short by a crash is
// repaired from its length on disk (repairWav).

import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";

export const BYTES = 3;
const FULL = 8388608; // 2^23
const MAX_RIFF = 0xffff_ffff;

export interface WavMeta {
  rate: number;
  /** When the first sample was recorded (ms since 1970, local time of day goes into bext). */
  startedAt: number;
  description: string;
}

/** The header up to and including the data chunk's size field; `dataOffset` is where samples start. */
export function wavHeader(meta: WavMeta, frames: number): { header: Buffer; dataOffset: number } {
  const history = Buffer.from(`A=PCM,F=${meta.rate},W=24,M=mono,T=StageMics\r\n`, "latin1");
  const bextLen = 602 + history.length + (history.length % 2);
  const dataOffset = 12 + 8 + 16 + 8 + bextLen + 8;
  const dataBytes = frames * BYTES;
  const h = Buffer.alloc(dataOffset);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(Math.min(MAX_RIFF, dataOffset - 8 + dataBytes), 4);
  h.write("WAVE", 8, "latin1");
  h.write("fmt ", 12, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(meta.rate, 24);
  h.writeUInt32LE(meta.rate * BYTES, 28);
  h.writeUInt16LE(BYTES, 32);
  h.writeUInt16LE(24, 34);
  const b = 36;
  h.write("bext", b, "latin1");
  h.writeUInt32LE(bextLen, b + 4);
  const at = new Date(meta.startedAt);
  const p = b + 8;
  h.write(meta.description.slice(0, 255), p, "latin1");
  h.write("StageMics", p + 256, "latin1");
  h.write(`SM${at.getTime().toString(36)}`.slice(0, 31), p + 288, "latin1");
  const pad = (v: number) => String(v).padStart(2, "0");
  h.write(`${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, p + 320, "latin1");
  h.write(`${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`, p + 330, "latin1");
  const midnight = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const ref = BigInt(Math.round(((at.getTime() - midnight) / 1000) * meta.rate));
  h.writeBigUInt64LE(ref, p + 338);
  h.writeUInt16LE(1, p + 346); // bext version 1; UMID and reserved stay zero
  history.copy(h, p + 602);
  h.write("data", dataOffset - 8, "latin1");
  h.writeUInt32LE(Math.min(MAX_RIFF, dataBytes), dataOffset - 4);
  return { header: h, dataOffset };
}

/** Will a mono 24-bit file of this many samples fit in a WAV (4 GB)? About 8 hours at 48 kHz. */
export const fitsInWav = (frames: number) => frames * BYTES + 2048 < MAX_RIFF;

/** Write the RIFF and data sizes for `frames` samples. */
export async function patchSizes(fh: FileHandle, dataOffset: number, frames: number) {
  const dataBytes = frames * BYTES;
  const four = Buffer.alloc(4);
  four.writeUInt32LE(Math.min(MAX_RIFF, dataOffset - 8 + dataBytes));
  await fh.write(four, 0, 4, 4);
  four.writeUInt32LE(Math.min(MAX_RIFF, dataBytes));
  await fh.write(four, 0, 4, dataOffset - 4);
}

/** Float samples [from, to) of `src` → 24-bit little-endian into `out` at `at`. Returns the byte length. */
export function encode24(src: Float32Array, from: number, to: number, out: Buffer, at = 0): number {
  let o = at;
  for (let i = from; i < to; i++) {
    let v = Math.round(src[i] * FULL);
    if (v > FULL - 1) v = FULL - 1;
    else if (v < -FULL) v = -FULL;
    out[o] = v & 0xff;
    out[o + 1] = (v >> 8) & 0xff;
    out[o + 2] = (v >> 16) & 0xff;
    o += BYTES;
  }
  return o - at;
}

/** 24-bit little-endian → floats, added (× gain) into `dst` from `at`. */
export function mix24(buf: Buffer, frames: number, dst: Float32Array, at: number, gain: (i: number) => number = () => 1) {
  for (let i = 0; i < frames; i++) {
    const o = i * BYTES;
    let v = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
    if (v & 0x800000) v -= 0x1000000;
    dst[at + i] += (v / FULL) * gain(i);
  }
}

/** Where the samples start and the sample rate, from a WAV's chunks. */
export async function readWavInfo(path: string): Promise<{ dataOffset: number; rate: number; frames: number; size: number }> {
  const fh = await open(path, "r");
  try {
    const size = (await fh.stat()).size;
    const head = Buffer.alloc(Math.min(size, 4096));
    await fh.read(head, 0, head.length, 0);
    if (head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") throw new Error(`${path} is not a WAV file`);
    let p = 12;
    let rate = 0;
    while (p + 8 <= head.length) {
      const id = head.toString("latin1", p, p + 4);
      const len = head.readUInt32LE(p + 4);
      if (id === "fmt ") rate = head.readUInt32LE(p + 12);
      if (id === "data") {
        const dataOffset = p + 8;
        return { dataOffset, rate, size, frames: Math.max(0, Math.floor((size - dataOffset) / BYTES)) };
      }
      p += 8 + len + (len % 2);
    }
    throw new Error(`${path} has no data chunk`);
  } finally {
    await fh.close();
  }
}

/** A file whose writer stopped (crash, power): cut it to whole samples and write the right sizes. */
export async function repairWav(path: string): Promise<{ frames: number; rate: number }> {
  const info = await readWavInfo(path);
  const fh = await open(path, "r+");
  try {
    const end = info.dataOffset + info.frames * BYTES;
    if (end !== info.size) await fh.truncate(end);
    await patchSizes(fh, info.dataOffset, info.frames);
    await fh.datasync();
  } finally {
    await fh.close();
  }
  return { frames: info.frames, rate: info.rate };
}

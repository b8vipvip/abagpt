import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { makeLoaf, verifyLoaf, extractLoaf, type LoafEntry, type LoafExtractedEntry } from "./loaf.js";
import { encodePngSpeak, decodePngSpeak } from "./pngspeak.js";
import { encodeGptgif, decodeGptgif, calibrateGptgif, gunzipGptgifOutput, FONT as GPTGIF_FONT } from "./gptgif.js";
import {
  encodeGptgifV4,
  decodeGptgifV4,
  randomFont,
  randomPalette,
  validateFont,
  validatePalette,
  fontToBytes,
  fontFromBytes,
  paletteToBytes,
  paletteFromBytes,
  defaultPalette,
  type GlyphFont,
} from "./gptgif-v4.js";
import { writeGif, readGif, type GifColor, type GifFrame } from "./gif89a.js";

// Everything here re-exposes Mirror's fun-and-real file-format zoo
// (LoaF/PngSpeak/gptgif/gptgif-v4/GIF89a) as plain HTTP endpoints, so they're
// usable directly from API clients, GPT Actions, or curl -- not just from the
// decoder-challenge flow in decoder-challenges.ts.
//
// Three query params control the wire shape, independently of each other:
//   raw_in=1   the request body IS the input bytes -- no JSON, no base64.
//              Send it with Content-Type: application/octet-stream (or the
//              format's own mime, e.g. image/png / image/gif / text/plain)
//              and any non-binary options (width, clusterMap, format, ...)
//              move from the JSON body into the query string instead.
//   raw_out=1  the response IS the output bytes, with the right content-type
//              and a content-disposition, instead of a JSON envelope.
//   raw=1      shorthand for raw_in=1&raw_out=1 (fully "give me bytes, take
//              bytes"). raw_in/raw_out still win if given explicitly; e.g.
//              raw=1&raw_out=0 is NOT a thing -- raw only ever turns things
//              on, so mix raw=1 with an explicit opposite by just not using
//              raw and setting raw_in/raw_out individually instead.
// Default (all unset) is JSON-in/JSON-out with base64 fields, which is the
// friendliest shape for GPT Actions and other tool-calling clients.
//
// Security note: pngspeak's own `rand` option can take a filesystem path as a
// padding source. `rand` IS exposed here (as literal/repeated-string or ""
// for random padding, matching the CLI), but every call site passes
// `randAllowFilePath: false` so that mode can never trigger an arbitrary
// local file read no matter what string a caller sends.

const b64 = z.string().max(8_000_000, "单次请求的载荷过大。");
const bytesOf = (s: string) => Buffer.from(s, "base64");

const FORMATS = ["loaf", "pngspeak", "gptgif", "gptgif-v4"] as const;
type FormatName = (typeof FORMATS)[number];

const FORMAT_INFO: Record<FormatName, { label: string; extension: string; mime: string; roundTrips: boolean; blurb: string }> = {
  loaf: { label: "LoaF", extension: "loaf", mime: "text/plain", roundTrips: true, blurb: "将 tar+gzip 归档以十六进制编码，写入一行带校验和的文本。" },
  pngspeak: { label: "PngSpeak", extension: "pngspk.png", mime: "image/png", roundTrips: true, blurb: "将原始字节逐一存储为 RGBA 像素，并封装在未压缩扫描线的 PNG 图像中。" },
  // Not self-round-trippable through this API without help: gptgif clusters
  // glyph tiles with k-means, and cluster label order is not deterministic
  // (see gptgif.ts/calibrateGptgif's own doc comment) -- decoding for real
  // needs a clusterMap derived from /api/convert/gptgif/calibrate plus a
  // human or GPT reading the rendered glyphs, exactly like decoder-challenges.
  gptgif: { label: "gptgif（原版）", extension: "gptgif.gif", mime: "image/gif", roundTrips: false, blurb: "将字节渲染为动画 GIF 中的字形网格；解码需要经过校准的簇映射（参见 /calibrate）。" },
  "gptgif-v4": { label: "gptgif v4", extension: "gptgif-v4.gif", mime: "image/gif", roundTrips: true, blurb: "使用可随机化的字形字体和调色板进行编码（可通过 seed 复现）。" },
};

function encodeWithFormat(format: FormatName, data: Buffer, opts: { fontSeed?: number; paletteSeed?: number } = {}): Buffer {
  switch (format) {
    case "loaf": return Buffer.from(makeLoaf([{ name: "payload.bin", content: data, mtime: new Date(0) }]));
    case "pngspeak": return encodePngSpeak(data);
    case "gptgif": return encodeGptgif([data]);
    case "gptgif-v4": return encodeGptgifV4([data], {
      fontSeed: opts.fontSeed,
      paletteSeed: opts.paletteSeed,
    });
  }
}

function decodeWithFormat(format: FormatName, artifact: Buffer): Buffer {
  switch (format) {
    case "loaf": {
      const [entry] = extractLoaf(artifact.toString("utf8"));
      if (!entry) throw new Error("LoaF 归档中没有任何条目。");
      return entry.content;
    }
    case "pngspeak": return decodePngSpeak(artifact);
    // decodeGptgif faithfully mirrors the reference CLI's gzip-wrapped
    // stdout (see gptgif.ts); unwrap it here so callers of this generic
    // helper get the true original bytes back, matching every other format.
    case "gptgif": return gunzipGptgifOutput(decodeGptgif(artifact));
    case "gptgif-v4": return decodeGptgifV4(artifact);
  }
}

/** @internal Maps older LoaF entry shapes into the stable HTTP response shape. */
export function serializeLoafEntry(e: LoafExtractedEntry) {
  return {
    name: e.name,
    isDirectory: e.isDirectory,
    isSymlink: e.isSymlink ?? false,
    linkTarget: e.linkTarget,
    bytes: e.content.length,
    contentBase64: e.content.toString("base64"),
  };
}

/** @internal Runs one gauntlet leg independently so a broken codec cannot stop the rest. */
export function runGauntletFormat(
  format: FormatName,
  original: Buffer,
  encode: typeof encodeWithFormat = encodeWithFormat,
  decode: typeof decodeWithFormat = decodeWithFormat,
) {
  try {
    const artifact = encode(format, original);
    const recovered = decode(format, artifact);
    return { format, ok: original.equals(recovered), artifactBytes: artifact.length };
  } catch (err) {
    return { format, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---- raw_in / raw_out / raw plumbing -----------------------------------

// Any content-type a caller might reasonably send raw bytes with. Fastify
// requires an explicit parser per content-type (its defaults only understand
// JSON/text/urlencoded/multipart), so anything not registered here 415s.
const RAW_BODY_CONTENT_TYPES = ["application/octet-stream", "image/png", "image/gif", "text/plain"];

function registerRawBodyParsers(app: FastifyInstance) {
  for (const type of RAW_BODY_CONTENT_TYPES) {
    app.addContentTypeParser(type, { parseAs: "buffer" }, (_req, body, done) => done(null, body as Buffer));
  }
}

class RawIoError extends Error {
  statusCode = 400;
}

/** The literal request body bytes, for raw_in=1 routes. */
function rawBody(req: FastifyRequest): Buffer {
  if (!Buffer.isBuffer(req.body)) {
    throw new RawIoError(
      `raw_in 需要请求体为原始字节。请使用以下 Content-Type 之一发送：${RAW_BODY_CONTENT_TYPES.join(", ")}；不要发送 JSON。`,
    );
  }
  return req.body;
}

// `raw` is a shorthand that only ever turns raw_in/raw_out ON (never off);
// an explicit raw_in=0 next to raw=1 still leaves raw_in on, same as any
// other "shorthand plus explicit override that doesn't actually conflict"
// query convention -- there's no real use case for wanting raw=1 to *un-set*
// the other two, so this keeps the merge rule simple instead of inventing
// precedence rules nobody will remember.
const IoQuery = z.object({
  raw: z.coerce.boolean().optional(),
  raw_in: z.coerce.boolean().optional(),
  raw_out: z.coerce.boolean().optional(),
});

function normalizeIo<T extends { raw?: boolean; raw_in?: boolean; raw_out?: boolean }>(
  v: T,
): Omit<T, "raw" | "raw_in" | "raw_out"> & { raw_in: boolean; raw_out: boolean } {
  const { raw, raw_in, raw_out, ...rest } = v;
  return { ...rest, raw_in: !!(raw_in || raw), raw_out: !!(raw_out || raw) } as Omit<T, "raw" | "raw_in" | "raw_out"> & {
    raw_in: boolean;
    raw_out: boolean;
  };
}

/** Just the raw_in/raw_out/raw decision, ignoring any other query fields, so
 * a route can pick which body/query schema to parse with before validating
 * the rest strictly. */
function peekRawIn(query: unknown): boolean {
  return normalizeIo(IoQuery.passthrough().parse(query)).raw_in;
}

function sendArtifact(reply: FastifyReply, rawOut: boolean, format: FormatName, artifact: Buffer, extra: Record<string, unknown> = {}) {
  const info = FORMAT_INFO[format];
  reply.header("cache-control", "no-store");
  if (rawOut) {
    return reply.header("content-disposition", `attachment; filename="mirror-convert.${info.extension}"`).type(info.mime).send(artifact);
  }
  return reply.send({ format, bytes: artifact.length, dataBase64: artifact.toString("base64"), ...extra });
}

/** Generic bytes-in body for routes with no options besides the payload. */
const DataBody = z.object({ dataBase64: b64 }).strict();

// gptgif/gptgif-v4 both concatenate multiple input files before encoding
// (the reference CLI's `cf output in1 in2 ...`); `parts` exposes that same
// multi-input concatenation as an alternative to a single `dataBase64`.
// JSON-body-only -- raw_in's single request body can't represent more than
// one part, same reasoning as loaf/encode's entries array.
const partsField = z.array(b64).min(1).max(64).optional();
function bodyToInputs(body: { dataBase64?: string; parts?: string[] }): Buffer[] {
  return body.parts ? body.parts.map(bytesOf) : [bytesOf(body.dataBase64!)];
}
const GptgifEncodeBody = z.object({ dataBase64: b64.optional(), parts: partsField }).strict()
  .refine((v) => (v.dataBase64 !== undefined) !== (v.parts !== undefined), { message: "gptgif 编码：dataBase64 和 parts 必须且只能提供其中一项。" });

const LoafEntryIn = z.object({
  name: z.string().min(1).max(4096),
  contentBase64: b64.optional(),
  mtime: z.string().datetime().optional(),
  /** Makes this entry a symlink pointing at the given target instead of a file/directory (mirrors `tar -p`'s own symlink preservation; see loaf.ts). */
  linkTarget: z.string().min(1).max(4096).optional(),
}).strict();
const LoafEncodeBody = z.object({ entries: z.array(LoafEntryIn).min(1).max(256) }).strict();
const LoafDecodeBody = z.object({ loaf: z.string().max(64_000_000), verify: z.boolean().optional() }).strict();
// raw_in mode for loaf/encode can only describe *one* entry (the request
// body is one blob), so it takes that entry's name/mtime as query params
// instead of the JSON body's `entries` array. Same default name
// ("payload.bin") the rest of Mirror already uses for a single-file loaf.
const LoafEncodeOptsQuery = IoQuery.extend({
  name: z.string().min(1).max(4096).optional(),
  mtime: z.string().datetime().optional(),
}).strict();

// `rand` mirrors pngspeak's own `-r/--rand`: an empty string (or omitted)
// means cryptographically random padding, any other string is repeated to
// fill the needed length. The reference CLI also lets `-r` name a filesystem
// path to read padding from; that mode is never reachable through this API
// (see module doc) -- `randAllowFilePath: false` is always passed to the
// underlying encoder/decoder regardless of transport (raw_in or JSON).
const randField = z.string().max(65536).optional();
const PngSpeakEncodeOptsQuery = IoQuery.extend({
  width: z.coerce.number().int().min(1).max(4096).optional(),
  height: z.coerce.number().int().min(1).max(4096).optional(),
  length: z.coerce.number().int().min(0).max(64_000_000).optional(),
  rand: randField,
  upscaleWidth: z.coerce.number().int().min(1).max(4096).optional(),
  upscaleHeight: z.coerce.number().int().min(1).max(4096).optional(),
}).strict();
const PngSpeakEncodeBody = z.object({
  dataBase64: b64,
  width: z.number().int().min(1).max(4096).optional(),
  height: z.number().int().min(1).max(4096).optional(),
  length: z.number().int().min(0).max(64_000_000).optional(),
  rand: randField,
  upscaleWidth: z.number().int().min(1).max(4096).optional(),
  upscaleHeight: z.number().int().min(1).max(4096).optional(),
}).strict();

const PngSpeakDecodeOptsQuery = IoQuery.extend({ length: z.coerce.number().int().min(0).max(64_000_000).optional(), rand: randField }).strict();
const PngSpeakDecodeBody = z.object({ dataBase64: b64, length: z.number().int().min(0).max(64_000_000).optional(), rand: randField }).strict();

const GptgifDecodeOptsQuery = IoQuery.extend({ clusterMap: z.string().optional() }).strict();
const GptgifDecodeBody = z.object({ dataBase64: b64, clusterMap: z.string().optional() }).strict();
const GptgifCalibrateOptsQuery = GptgifDecodeOptsQuery;
const GptgifCalibrateBody = GptgifDecodeBody;

// Mirrors gptgif-v4's own `--font FILE`/`--font-seed N` (and palette
// equivalent) mutual exclusivity: at most one font source and one palette
// source may be given, exactly matching the C CLI's
// "choose --font or --font-seed, not both" refusal.
const fontSeedField = z.coerce.number().int().min(0).max(0xffffffff).optional();
const GptgifV4EncodeOptsQuery = IoQuery.extend({
  fontSeed: fontSeedField,
  paletteSeed: fontSeedField,
  fontBase64: b64.optional(),
  paletteBase64: b64.optional(),
}).strict();
const GptgifV4EncodeBody = z.object({
  dataBase64: b64.optional(),
  parts: partsField,
  fontSeed: z.number().int().min(0).max(0xffffffff).optional(),
  paletteSeed: z.number().int().min(0).max(0xffffffff).optional(),
  /** Exactly 128 bytes: gptgif-v4.c's `--font FILE` binary format (16 glyphs x 8 rows). See /api/convert/gptgif-v4/font/random or /font/default to obtain one. */
  fontBase64: b64.optional(),
  /** Exactly 768 bytes: gptgif-v4.c's `--palette FILE` binary format (256 x RGB). */
  paletteBase64: b64.optional(),
}).strict()
  .refine((v) => (v.dataBase64 !== undefined) !== (v.parts !== undefined), { message: "gptgif-v4 编码：dataBase64 和 parts 必须且只能提供其中一项。" });

/** Wraps a thrown Error as a 400 rather than letting it fall through to a 500 -- used for caller-input problems (bad font/palette bytes) that aren't Zod errors. */
function as400<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new RawIoError(err instanceof Error ? err.message : String(err));
  }
}

function resolveGptgifV4Font(opts: { fontSeed?: number; fontBase64?: string }): GlyphFont | undefined {
  if (opts.fontSeed !== undefined && opts.fontBase64 !== undefined) {
    throw new RawIoError("gptgif-v4：fontSeed 和 fontBase64 不能同时提供。");
  }
  if (opts.fontBase64 !== undefined) return as400(() => fontFromBytes(bytesOf(opts.fontBase64!)));
  return opts.fontSeed !== undefined ? randomFont(opts.fontSeed) : undefined;
}
function resolveGptgifV4Palette(opts: { paletteSeed?: number; paletteBase64?: string }): GifColor[] | undefined {
  if (opts.paletteSeed !== undefined && opts.paletteBase64 !== undefined) {
    throw new RawIoError("gptgif-v4：paletteSeed 和 paletteBase64 不能同时提供。");
  }
  if (opts.paletteBase64 !== undefined) return as400(() => paletteFromBytes(bytesOf(opts.paletteBase64!)));
  return opts.paletteSeed !== undefined ? randomPalette(opts.paletteSeed) : undefined;
}

const GifColorIn = z.object({ r: z.number().int().min(0).max(255), g: z.number().int().min(0).max(255), b: z.number().int().min(0).max(255) }).strict();
const GifFrameIn = z.object({
  pixels: z.array(z.number().int().min(0).max(255)),
  delayCs: z.number().int().min(0).max(65535).optional(),
}).strict();
const GifEncodeBody = z.object({
  width: z.number().int().min(1).max(2048),
  height: z.number().int().min(1).max(2048),
  colors: z.array(GifColorIn).min(1).max(256),
  frames: z.array(GifFrameIn).min(1).max(256),
}).strict();
// raw_in mode for gif89a/encode can only describe one frame's worth of raw
// pixel bytes (again, the body is one blob) -- width/height become required
// query params since there's nowhere else for them to come from, and the
// palette defaults to a full 256-shade grayscale ramp (index i == gray level
// i) so a plain byte stream "just works" as a viewable image with no extra
// params at all; pass ?colors=RRGGBB,RRGGBB,... to use a real palette.
const GifRawEncodeOptsQuery = IoQuery.extend({
  width: z.coerce.number().int().min(1).max(2048),
  height: z.coerce.number().int().min(1).max(2048),
  colors: z.string().regex(/^[0-9a-fA-F]{6}(,[0-9a-fA-F]{6})*$/, "colors 必须是以逗号分隔的 6 位十六进制 RRGGBB 颜色值，例如 ff0000,00ff00,0000ff。").optional(),
  delayCs: z.coerce.number().int().min(0).max(65535).optional(),
}).strict();

function grayscalePalette(): GifColor[] {
  return Array.from({ length: 256 }, (_, i) => ({ r: i, g: i, b: i }));
}
function parseColorsCsv(csv: string): GifColor[] {
  return csv.split(",").map((hex) => ({
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  }));
}

const formatCsv = z.string().transform((s, ctx) => {
  const parts = s.split(",").map((p) => p.trim());
  for (const p of parts) {
    if (!(FORMATS as readonly string[]).includes(p)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${p}" 不是已知格式（${FORMATS.join(", ")}）。` });
      return z.NEVER;
    }
  }
  return parts as FormatName[];
});
const OnionOptsQuery = IoQuery.extend({ chain: formatCsv }).strict();
const OnionBody = z.object({ dataBase64: b64, chain: z.array(z.enum(FORMATS)).min(1).max(6) }).strict();

const PromptOptsQuery = IoQuery.extend({
  format: z.enum(FORMATS),
  filename: z.string().min(1).max(256).optional(),
  note: z.string().max(2000).optional(),
}).strict();
const PromptBody = z.object({
  dataBase64: b64,
  format: z.enum(FORMATS),
  filename: z.string().max(256).default("payload.bin"),
  note: z.string().max(2000).optional(),
}).strict();

const RoundtripOptsQuery = IoQuery.extend({ format: z.enum(FORMATS) }).strict();
const RoundtripBody = z.object({ dataBase64: b64, format: z.enum(FORMATS) }).strict();

const FORTUNES = [
  "你将解码一个意想不到的字节。",
  "今天生成的 GIF 将比生成它的每一次聊天都存在得更久。",
  "某个 Base64 字符串正梦想着自己变成一张图片。",
  "Bug 不在你的代码里，而在你发明的格式规范中。",
  "相信校验和。它见过很多事情。",
  "你输出的每个像素，都是对未来解码器的一份承诺。",
  "今天的幸运调色板 seed：就是你传入的那个值。",
  "tar 归档一旦经过 gzip 压缩，就再也不像是人眼能直接读懂的东西了。",
];

export function registerConversionRoutes(app: FastifyInstance) {
  registerRawBodyParsers(app);

  // ---- Discovery -----------------------------------------------------
  app.get("/api/convert/formats", async () => ({
    formats: FORMATS.map((f) => ({ id: f, ...FORMAT_INFO[f] })),
    io: {
      raw_in: `将请求体作为原始字节发送（Content-Type 必须为以下类型之一：${RAW_BODY_CONTENT_TYPES.join(", ")}），而不是使用 JSON dataBase64 字段。非二进制选项请放在查询参数中。`,
      raw_out: "以原始字节形式返回响应，并设置正确的 Content-Type，而不是返回 JSON dataBase64 字段。",
      raw: "raw_in=1&raw_out=1 的简写。",
    },
  }));

  // ---- Per-format encode/decode ---------------------------------------
  app.post("/api/convert/loaf/encode", async (req, reply) => {
    const rawQ = req.query as Record<string, unknown>;
    let io: { raw_in: boolean; raw_out: boolean };
    let entries: LoafEntry[];
    if (peekRawIn(rawQ)) {
      const opts = normalizeIo(LoafEncodeOptsQuery.parse(rawQ));
      io = opts;
      entries = [{ name: opts.name ?? "payload.bin", content: rawBody(req), mtime: opts.mtime ? new Date(opts.mtime) : undefined }];
    } else {
      io = normalizeIo(IoQuery.strict().parse(rawQ));
      const body = LoafEncodeBody.parse(req.body);
      entries = body.entries.map((e) => ({
        name: e.name,
        content: e.linkTarget === undefined && e.contentBase64 !== undefined ? bytesOf(e.contentBase64) : undefined,
        mtime: e.mtime ? new Date(e.mtime) : undefined,
        linkTarget: e.linkTarget,
      }));
    }
    const loaf = makeLoaf(entries);
    reply.header("cache-control", "no-store");
    if (io.raw_out) return reply.type("text/plain").send(loaf);
    return { format: "loaf", loaf, bytes: loaf.length };
  });
  app.post("/api/convert/loaf/decode", async (req, reply) => {
    const DecodeOptsQuery = IoQuery.extend({ verify: z.coerce.boolean().optional() }).strict();
    const io = normalizeIo(DecodeOptsQuery.parse(req.query));
    const loaf = io.raw_in ? rawBody(req).toString("utf8") : LoafDecodeBody.parse(req.body).loaf;
    const wantVerify = io.raw_in ? io.verify : (LoafDecodeBody.parse(req.body).verify ?? io.verify);
    let entries;
    try {
      entries = extractLoaf(loaf, { verify: wantVerify });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    reply.header("cache-control", "no-store");
    return {
      entries: entries.map(serializeLoafEntry),
    };
  });
  app.post("/api/convert/loaf/verify", async (req, reply) => {
    const io = normalizeIo(IoQuery.strict().parse(req.query));
    const loaf = io.raw_in ? rawBody(req).toString("utf8") : LoafDecodeBody.parse(req.body).loaf;
    reply.header("cache-control", "no-store");
    return verifyLoaf(loaf);
  });

  app.post("/api/convert/pngspeak/encode", async (req, reply) => {
    const rawQ = req.query as Record<string, unknown>;
    const usingRawIn = peekRawIn(rawQ);
    const data = usingRawIn ? rawBody(req) : bytesOf(PngSpeakEncodeBody.parse(req.body).dataBase64);
    const opts = usingRawIn
      ? normalizeIo(PngSpeakEncodeOptsQuery.parse(rawQ))
      : { ...normalizeIo(IoQuery.strict().parse(rawQ)), ...PngSpeakEncodeBody.parse(req.body) };
    const artifact = encodePngSpeak(data, {
      width: opts.width,
      height: opts.height,
      length: opts.length,
      rand: opts.rand,
      randAllowFilePath: false,
      upscaleWidth: opts.upscaleWidth,
      upscaleHeight: opts.upscaleHeight,
    });
    return sendArtifact(reply, opts.raw_out, "pngspeak", artifact);
  });
  app.post("/api/convert/pngspeak/decode", async (req, reply) => {
    const rawQ = req.query as Record<string, unknown>;
    const usingRawIn = peekRawIn(rawQ);
    const data = usingRawIn ? rawBody(req) : bytesOf(PngSpeakDecodeBody.parse(req.body).dataBase64);
    const decodeOpts = usingRawIn ? normalizeIo(PngSpeakDecodeOptsQuery.parse(rawQ)) : PngSpeakDecodeBody.parse(req.body);
    const decoded = decodePngSpeak(data, { length: decodeOpts.length, rand: decodeOpts.rand, randAllowFilePath: false });
    reply.header("cache-control", "no-store");
    return { bytes: decoded.length, dataBase64: decoded.toString("base64") };
  });

  app.post("/api/convert/gptgif/encode", async (req, reply) => {
    const io = normalizeIo(IoQuery.strict().parse(req.query));
    const inputs = io.raw_in ? [rawBody(req)] : bodyToInputs(GptgifEncodeBody.parse(req.body));
    const artifact = encodeGptgif(inputs);
    return sendArtifact(reply, io.raw_out, "gptgif", artifact);
  });
  app.post("/api/convert/gptgif/decode", async (req, reply) => {
    const rawQ = req.query as Record<string, unknown>;
    const usingRawIn = peekRawIn(rawQ);
    const artifact = usingRawIn ? rawBody(req) : bytesOf(GptgifDecodeBody.parse(req.body).dataBase64);
    const clusterMap = usingRawIn ? normalizeIo(GptgifDecodeOptsQuery.parse(rawQ)).clusterMap : GptgifDecodeBody.parse(req.body).clusterMap;
    // The reference decoder's stdout is itself gzip-compressed (a faithfully
    // ported quirk of gptungif.py, see gptgif.ts); unwrap it so this route
    // hands back the actual original bytes like every other decode route.
    const data = gunzipGptgifOutput(decodeGptgif(artifact, { clusterMap }));
    reply.header("cache-control", "no-store");
    return { bytes: data.length, dataBase64: data.toString("base64") };
  });
  app.post("/api/convert/gptgif/calibrate", async (req, reply) => {
    const rawQ = req.query as Record<string, unknown>;
    const usingRawIn = peekRawIn(rawQ);
    const artifact = usingRawIn ? rawBody(req) : bytesOf(GptgifCalibrateBody.parse(req.body).dataBase64);
    const clusterMap = usingRawIn ? normalizeIo(GptgifCalibrateOptsQuery.parse(rawQ)).clusterMap : GptgifCalibrateBody.parse(req.body).clusterMap;
    const report = calibrateGptgif(artifact, { clusterMap });
    reply.header("cache-control", "no-store");
    return { clusterMap: report };
  });

  app.post("/api/convert/gptgif-v4/encode", async (req, reply) => {
    const rawQ = req.query as Record<string, unknown>;
    const usingRawIn = peekRawIn(rawQ);
    const inputs = usingRawIn ? [rawBody(req)] : bodyToInputs(GptgifV4EncodeBody.parse(req.body));
    const opts = usingRawIn
      ? normalizeIo(GptgifV4EncodeOptsQuery.parse(rawQ))
      : { ...normalizeIo(IoQuery.strict().parse(rawQ)), ...GptgifV4EncodeBody.parse(req.body) };
    const font = resolveGptgifV4Font(opts);
    const palette = resolveGptgifV4Palette(opts);
    const artifact = as400(() => encodeGptgifV4(inputs, { font, palette }));
    return sendArtifact(reply, opts.raw_out, "gptgif-v4", artifact, { fontSeed: opts.fontSeed, paletteSeed: opts.paletteSeed });
  });
  app.post("/api/convert/gptgif-v4/decode", async (req, reply) => {
    const io = normalizeIo(IoQuery.strict().parse(req.query));
    const data = io.raw_in ? rawBody(req) : bytesOf(DataBody.parse(req.body).dataBase64);
    const decoded = decodeGptgifV4(data);
    reply.header("cache-control", "no-store");
    return { bytes: decoded.length, dataBase64: decoded.toString("base64") };
  });
  // Fun/useful: hand back a fresh random font+palette without encoding
  // anything, so callers can preview or reuse a seed's exact glyph shapes.
  // Includes both the structured JSON form and the raw fontBase64/
  // paletteBase64 bytes (gptgif-v4.c's own --font/--palette FILE format),
  // so the response can be fed straight back into /encode's fontBase64/
  // paletteBase64 fields.
  app.get("/api/convert/gptgif-v4/random-style", async (req, reply) => {
    const Query = z.object({
      fontSeed: z.coerce.number().int().min(0).max(0xffffffff).optional(),
      paletteSeed: z.coerce.number().int().min(0).max(0xffffffff).optional(),
    }).strict();
    const q = Query.parse(req.query);
    const fontSeed = q.fontSeed ?? randomBytes(4).readUInt32LE();
    const paletteSeed = q.paletteSeed ?? randomBytes(4).readUInt32LE();
    const font = randomFont(fontSeed);
    const palette = randomPalette(paletteSeed);
    reply.header("cache-control", "no-store");
    return {
      fontSeed,
      paletteSeed,
      font,
      palette,
      fontBase64: fontToBytes(font).toString("base64"),
      paletteBase64: paletteToBytes(palette).toString("base64"),
    };
  });
  // The built-in default font+palette gptgif-v4 uses when no font/palette
  // source is given at all, in the same downloadable-bytes form.
  app.get("/api/convert/gptgif-v4/default-style", async (_req, reply) => {
    const font = GPTGIF_FONT;
    const palette = defaultPalette();
    reply.header("cache-control", "no-store");
    return {
      font,
      palette,
      fontBase64: fontToBytes(font).toString("base64"),
      paletteBase64: paletteToBytes(palette).toString("base64"),
    };
  });
  // Dry-run font/palette validation -- exactly gptgif-v4.c's own
  // validate_font()/validate_palette() checks (run automatically before any
  // encode), exposed standalone so a caller can test a custom font/palette
  // without spending an encode call to find out it's rejected.
  app.post("/api/convert/gptgif-v4/font/validate", async (req, reply) => {
    const Body = z.object({ fontBase64: b64 }).strict();
    const { fontBase64 } = Body.parse(req.body);
    reply.header("cache-control", "no-store");
    try {
      const font = fontFromBytes(bytesOf(fontBase64));
      validateFont(font);
      return { valid: true };
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  app.post("/api/convert/gptgif-v4/palette/validate", async (req, reply) => {
    const Body = z.object({ paletteBase64: b64 }).strict();
    const { paletteBase64 } = Body.parse(req.body);
    reply.header("cache-control", "no-store");
    try {
      const palette = paletteFromBytes(bytesOf(paletteBase64));
      validatePalette(palette);
      return { valid: true };
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
  // ASCII-art preview of gptgif's fixed built-in hex-digit font (used by
  // the original/v1 format, and as gptgif-v4's default font) -- purely a
  // documentation/fun endpoint, same rendering style as /gptgif/calibrate.
  app.get("/api/convert/gptgif/font-preview", async (_req, reply) => {
    const lines: string[] = [];
    for (let n = 0; n < GPTGIF_FONT.length; n++) {
      lines.push("", `Glyph ${n.toString(16)}:`);
      for (let y = 0; y < 8; y++) {
        let line = "";
        for (let x = 0; x < 8; x++) line += GPTGIF_FONT[n][y] & (1 << (7 - x)) ? "#" : ".";
        lines.push(line);
      }
    }
    reply.header("cache-control", "no-store").type("text/plain");
    return lines.join("\n");
  });

  // ---- Raw GIF89a: general encode/inspect, not tied to gptgif ----------
  app.post("/api/convert/gif89a/encode", async (req, reply) => {
    const rawQ = req.query as Record<string, unknown>;
    let io: { raw_in: boolean; raw_out: boolean };
    let width: number, height: number, colors: GifColor[], frames: GifFrame[];
    if (peekRawIn(rawQ)) {
      const opts = normalizeIo(GifRawEncodeOptsQuery.parse(rawQ));
      io = opts;
      width = opts.width;
      height = opts.height;
      colors = opts.colors ? parseColorsCsv(opts.colors) : grayscalePalette();
      const pixels = rawBody(req);
      if (pixels.length !== width * height) {
        return reply.code(400).send({ error: `原始请求体包含 ${pixels.length} 个字节；预期长度为 width*height = ${width * height}（raw_in 模式下每个像素使用 1 个调色板索引字节，且仅支持单帧）。` });
      }
      for (const idx of pixels) {
        if (idx >= colors.length) return reply.code(400).send({ error: `像素字节值 ${idx} 超出 ${colors.length} 色调色板的范围。自定义调色板请传入 ?colors=RRGGBB,RRGGBB,...。` });
      }
      frames = [{ pixels: Uint8Array.from(pixels), delayCs: opts.delayCs }];
    } else {
      io = normalizeIo(IoQuery.strict().parse(rawQ));
      const body = GifEncodeBody.parse(req.body);
      width = body.width;
      height = body.height;
      colors = body.colors;
      for (const f of body.frames) {
        if (f.pixels.length !== width * height) {
          return reply.code(400).send({ error: `当前帧包含 ${f.pixels.length} 个像素；预期像素数为 width*height = ${width * height}。` });
        }
        for (const idx of f.pixels) {
          if (idx >= colors.length) return reply.code(400).send({ error: `像素索引 ${idx} 超出 ${colors.length} 色调色板的范围。` });
        }
      }
      frames = body.frames.map((f) => ({ pixels: Uint8Array.from(f.pixels), delayCs: f.delayCs }));
    }
    const artifact = writeGif({ width, height, globalColorTable: colors, frames });
    reply.header("cache-control", "no-store");
    if (io.raw_out) return reply.header("content-disposition", 'attachment; filename="mirror.gif"').type("image/gif").send(artifact);
    return { bytes: artifact.length, dataBase64: artifact.toString("base64") };
  });
  app.post("/api/convert/gif89a/inspect", async (req, reply) => {
    const io = normalizeIo(IoQuery.strict().parse(req.query));
    const data = io.raw_in ? rawBody(req) : bytesOf(DataBody.parse(req.body).dataBase64);
    const gif = readGif(data);
    reply.header("cache-control", "no-store");
    return {
      width: gif.width,
      height: gif.height,
      colors: gif.globalColorTable,
      frameCount: gif.frames.length,
      frames: gif.frames.map((f) => ({ delayCs: f.delayCs, pixelCount: f.pixels.length })),
    };
  });

  // ---- Cross-cutting: round-trip check, onion nesting, GPT prompt ----
  app.post("/api/convert/roundtrip", async (req, reply) => {
    const rawQ = req.query as Record<string, unknown>;
    const usingRawIn = peekRawIn(rawQ);
    const original = usingRawIn ? rawBody(req) : bytesOf(RoundtripBody.parse(req.body).dataBase64);
    const format = usingRawIn ? normalizeIo(RoundtripOptsQuery.parse(rawQ)).format : RoundtripBody.parse(req.body).format;
    const artifact = encodeWithFormat(format, original);
    const recovered = decodeWithFormat(format, artifact);
    reply.header("cache-control", "no-store");
    return {
      format,
      ok: original.equals(recovered),
      originalBytes: original.length,
      artifactBytes: artifact.length,
      recoveredBytes: recovered.length,
      artifactBase64: artifact.toString("base64"),
    };
  });

  // "Onion" mode: wrap the payload through several formats in sequence for
  // no practical reason beyond it being funny that you can -- decode.loaf(
  // decode.pngspeak(decode.gptgif(artifact))) has to unwind in exact reverse.
  app.post("/api/convert/onion/encode", async (req, reply) => {
    const rawQ = req.query as Record<string, unknown>;
    const usingRawIn = peekRawIn(rawQ);
    let current: Buffer = usingRawIn ? rawBody(req) : bytesOf(OnionBody.parse(req.body).dataBase64);
    const opts = usingRawIn ? normalizeIo(OnionOptsQuery.parse(rawQ)) : { ...normalizeIo(IoQuery.strict().parse(rawQ)), ...OnionBody.parse(req.body) };
    for (const format of opts.chain) current = encodeWithFormat(format, current);
    const finalFormat = opts.chain[opts.chain.length - 1];
    return sendArtifact(reply, opts.raw_out, finalFormat, current, { chain: opts.chain });
  });
  app.post("/api/convert/onion/decode", async (req, reply) => {
    const rawQ = req.query as Record<string, unknown>;
    const usingRawIn = peekRawIn(rawQ);
    let current: Buffer = usingRawIn ? rawBody(req) : bytesOf(OnionBody.parse(req.body).dataBase64);
    const chain = usingRawIn ? normalizeIo(OnionOptsQuery.parse(rawQ)).chain : OnionBody.parse(req.body).chain;
    for (const format of [...chain].reverse()) current = decodeWithFormat(format, current);
    reply.header("cache-control", "no-store");
    return { chain, bytes: current.length, dataBase64: current.toString("base64") };
  });

  // Build a ready-to-paste ChatGPT/GPT prompt around arbitrary caller data,
  // generalizing the transport trick decoder-challenges.ts uses for its own
  // server-generated secrets -- here the data is whatever the caller sends.
  app.post("/api/convert/gpt-prompt", async (req, reply) => {
    const rawQ = req.query as Record<string, unknown>;
    const usingRawIn = peekRawIn(rawQ);
    const data = usingRawIn ? rawBody(req) : bytesOf(PromptBody.parse(req.body).dataBase64);
    const opts = usingRawIn
      ? (() => {
          const parsed = normalizeIo(PromptOptsQuery.parse(rawQ));
          return { ...parsed, filename: parsed.filename ?? "payload.bin" };
        })()
      : PromptBody.parse(req.body);
    const artifact = encodeWithFormat(opts.format, data);
    const info = FORMAT_INFO[opts.format];
    const transport = gzipSync(artifact).toString("base64");
    const filename = opts.filename.replace(/[^a-zA-Z0-9._-]/g, "_") || "payload.bin";
    const prompt =
      `Mirror 文件转换负载。格式：${info.label}（${info.blurb}）\n` +
      `下方以 base64(gzip(文件字节)) 形式传输文件，以便作为纯文本粘贴时仍能完整保留。\n` +
      `首先对传输内容进行 Base64 解码和 gzip 解压，得到名为 "decoded.${info.extension}" 的文件；然后再解码 ${info.label} 格式本身，以恢复原始字节。\n` +
      (opts.note ? `\n发送者备注：${opts.note}\n` : "") +
      `\n恢复后载荷的原始文件名提示：${filename}\n` +
      `\nBEGIN_GZIP_BASE64\n${transport}\nEND_GZIP_BASE64`;
    reply.header("cache-control", "no-store");
    return { format: opts.format, filename, artifactBytes: artifact.length, transportBytes: transport.length, prompt };
  });

  // ---- Pure fun / mostly useless -------------------------------------
  app.get("/api/convert/mystery", async (req, reply) => {
    const Query = z.object({ text: z.string().max(4096).optional() }).strict();
    const q = Query.parse(req.query);
    const format = FORMATS[Math.floor(Math.random() * FORMATS.length)];
    const data = q.text !== undefined ? Buffer.from(q.text, "utf8") : randomBytes(64);
    const artifact = encodeWithFormat(format, data);
    reply.header("cache-control", "no-store");
    return { format, surprise: FORMAT_INFO[format].blurb, bytes: artifact.length, dataBase64: artifact.toString("base64") };
  });

  app.get("/api/convert/fortune", async (req, reply) => {
    const Query = z.object({ format: z.enum(FORMATS).default("pngspeak") }).strict();
    const q = Query.parse(req.query);
    const fortune = FORTUNES[Math.floor(Math.random() * FORTUNES.length)];
    const artifact = encodeWithFormat(q.format, Buffer.from(fortune, "utf8"));
    const info = FORMAT_INFO[q.format];
    reply.header("cache-control", "no-store");
    return reply.header("content-disposition", `inline; filename="fortune.${info.extension}"`).type(info.mime).send(artifact);
  });

  // Round-trips a payload through every format at once and reports which
  // ones survived -- a stress test dressed up as a party trick.
  app.post("/api/convert/gauntlet", async (req, reply) => {
    const io = normalizeIo(IoQuery.strict().parse(req.query));
    const original = io.raw_in ? rawBody(req) : bytesOf(DataBody.parse(req.body).dataBase64);
    reply.header("cache-control", "no-store");
    return {
      results: FORMATS.map((format) => runGauntletFormat(format, original)),
    };
  });
}

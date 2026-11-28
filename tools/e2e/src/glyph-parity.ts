import { BrickCompiler, bakeReceptors } from "@brr/import";
import { decodePlanGlyph } from "@brr/schema/bundle";
import { decode, decodedOrThrow, issueText } from "@brr/schema/decode";
import { readdir, readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import * as v from "valibot";

const LISTING_FILE = "glyphs.json";
const LIBRARY_KEY = "glyph-parity";
const MISMATCHES_SHOWN = 20;
const NO_RECEPTOR_PART = 0;

const NativeOptions = v.strictObject({
  studPrimitives: v.array(v.string()),
  unofficialAllowlist: v.array(v.string()),
  translucentColors: v.array(v.number()),
  tableDepthLdu: v.number(),
});
type NativeOptions = v.InferOutput<typeof NativeOptions>;

const NativeModel = v.strictObject({
  file: v.string(),
  drawn: v.array(v.picklist([0, 1])),
  glyph: v.exactOptional(v.string()),
  glyphIssue: v.exactOptional(v.string()),
});
type NativeModel = v.InferOutput<typeof NativeModel>;

const NativeGlyphs = v.strictObject({
  options: NativeOptions,
  models: v.array(NativeModel),
});

interface ShardJob {
  readonly native: string;
  readonly root: string;
  readonly wasm: string;
  readonly ldraw: string;
  readonly options: NativeOptions;
  readonly models: ReadonlyArray<NativeModel>;
}

interface ShardResult {
  identical: number;
  decoded: number;
  glyphBytes: number;
  readonly mismatches: string[];
}

function json(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

async function libraryPaths(root: string): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    paths.set(relative(root, path).replaceAll("\\", "/").toLowerCase(), path);
  }
  return paths;
}

async function compareShard(job: ShardJob): Promise<ShardResult> {
  const compiler = new BrickCompiler(new WebAssembly.Module(await readFile(job.wasm)));
  const paths = await libraryPaths(job.ldraw);
  const library = { key: LIBRARY_KEY, files: new Map<string, string>(), absent: new Set<string>() };
  const result: ShardResult = { identical: 0, decoded: 0, glyphBytes: 0, mismatches: [] };
  for (const model of job.models) {
    const drawnCount = model.drawn.filter((kept) => kept === 1).length;
    const request = {
      source: await readFile(join(job.root, model.file), "utf8"),
      drawn: Uint8Array.from(model.drawn),
      receptors: bakeReceptors(new Uint32Array(drawnCount).fill(NO_RECEPTOR_PART), [null]),
      studPrimitives: job.options.studPrimitives,
      unofficialAllowlist: job.options.unofficialAllowlist,
      translucentColors: job.options.translucentColors,
      tableDepthLdu: job.options.tableDepthLdu,
      vehicles: null,
      glyph: true,
    };
    let baked = compiler.bake(request, library);
    while (baked.status === "need") {
      for (const path of baked.paths) {
        const file = paths.get(path);
        if (file === undefined) library.absent.add(path);
        else library.files.set(path, await readFile(file, "utf8"));
      }
      baked = compiler.bake(request, library);
    }
    if (baked.status !== "baked") {
      result.mismatches.push(`${model.file}: WASM bake ${baked.status}: ${baked.message}`);
      continue;
    }
    if (model.glyph === undefined) {
      if (baked.glyph === null && baked.glyphIssue === (model.glyphIssue ?? null))
        result.identical++;
      else result.mismatches.push(`${model.file}: native has no glyph (${model.glyphIssue})`);
      continue;
    }
    if (baked.glyph === null) {
      result.mismatches.push(`${model.file}: WASM has no glyph`);
      continue;
    }
    const decoded = decodePlanGlyph(baked.glyph);
    if (decoded.ok) result.decoded++;
    else result.mismatches.push(`${model.file}: ${issueText(decoded.issues)}`);
    result.glyphBytes += baked.glyph.length;
    const same = sameBytes(baked.glyph, await readFile(join(job.native, model.glyph)));
    if (!same) result.mismatches.push(`${model.file}: glyph bytes differ`);
    if (same && decoded.ok) result.identical++;
  }
  return result;
}

function runWorker(job: ShardJob): Promise<ShardResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: job,
      execArgv: process.execArgv,
    });
    worker.once("message", (result: ShardResult) => resolve(result));
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`glyph parity worker exited with ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      native: { type: "string", default: "../../.cache/glyph-parity" },
      root: { type: "string", default: "../.." },
      ldraw: { type: "string", default: "../../.cache/ldraw-library" },
      wasm: {
        type: "string",
        default: "../../target/wasm32-wasip1/release/brick_compile_wasm.wasm",
      },
      workers: { type: "string", default: String(availableParallelism()) },
    },
  });
  const workers = Number(values.workers);
  const started = performance.now();
  const listing = decodedOrThrow(
    decode(NativeGlyphs, json(await readFile(join(values.native, LISTING_FILE)))),
    LISTING_FILE,
  );
  const results = await Promise.all(
    Array.from({ length: workers }, (_, worker) =>
      runWorker({
        native: values.native,
        root: values.root,
        wasm: values.wasm,
        ldraw: values.ldraw,
        options: listing.options,
        models: listing.models.filter((_model, i) => i % workers === worker),
      }),
    ),
  );
  const sum = (pick: (result: ShardResult) => number) =>
    results.reduce((total, result) => total + pick(result), 0);
  const mismatches = results.flatMap((result) => result.mismatches).toSorted();
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  process.stdout.write(
    `plan glyph parity: ${sum((r) => r.identical)} of ${listing.models.length} models identical between the native bake and the shipped WASM compiler (glyphs and glyph issues); ${sum((r) => r.decoded)} glyphs, ${sum((r) => r.glyphBytes)} bytes, decoded by @brr/schema; ${seconds} s on ${workers} workers\n`,
  );
  for (const mismatch of mismatches.slice(0, MISMATCHES_SHOWN))
    process.stdout.write(`  ${mismatch}\n`);
  if (mismatches.length > MISMATCHES_SHOWN) {
    process.stdout.write(`  and ${mismatches.length - MISMATCHES_SHOWN} more\n`);
  }
  if (mismatches.length > 0) process.exitCode = 1;
}

if (isMainThread) {
  await main();
} else {
  parentPort?.postMessage(await compareShard(workerData as ShardJob), []);
}

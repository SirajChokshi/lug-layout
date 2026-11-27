import { BrickCompiler, bakeReceptors } from "@brr/import";
import {
  decodePlanGlyph,
  PrimitiveConnectorTable,
  SectionVocabularyFile,
  type CompilerConnectorInputs,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow, issueText } from "@brr/schema/decode";
import { readdir, readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import * as v from "valibot";

const LISTING_FILE = "glyphs.json";
const LIBRARY_KEY = "glyph-parity";
const BATCH_PARTS = 64;
const MISMATCHES_SHOWN = 20;
const NO_RECEPTOR_PART = 0;

const NativeOptions = v.strictObject({
  studPrimitives: v.array(v.string()),
  unofficialAllowlist: v.array(v.string()),
  translucentColors: v.array(v.number()),
  tableDepthLdu: v.number(),
});
type NativeOptions = v.InferOutput<typeof NativeOptions>;

const NativePart = v.union([
  v.strictObject({ part: v.string(), glyph: v.string() }),
  v.strictObject({ part: v.string(), glyphIssue: v.string() }),
  v.strictObject({ part: v.string(), failed: v.string() }),
]);
type NativePart = v.InferOutput<typeof NativePart>;

const NativeModel = v.strictObject({
  file: v.string(),
  drawn: v.array(v.picklist([0, 1])),
  glyph: v.exactOptional(v.string()),
  glyphIssue: v.exactOptional(v.string()),
});
type NativeModel = v.InferOutput<typeof NativeModel>;

const NativeGlyphs = v.strictObject({
  options: NativeOptions,
  parts: v.record(v.string(), NativePart),
  models: v.array(NativeModel),
});

const InferredConnectors = v.object({ cavityProbe: v.string() });

interface ShardJob {
  readonly native: string;
  readonly root: string;
  readonly wasm: string;
  readonly ldraw: string;
  readonly options: NativeOptions;
  readonly connectors: CompilerConnectorInputs;
  readonly parts: ReadonlyArray<readonly [string, NativePart]>;
  readonly models: ReadonlyArray<NativeModel>;
}

interface ShardResult {
  identicalParts: number;
  identicalModels: number;
  decoded: number;
  glyphBytes: number;
  readonly mismatches: string[];
}

interface Shard {
  readonly job: ShardJob;
  readonly compiler: BrickCompiler;
  readonly paths: ReadonlyMap<string, string>;
  readonly library: { readonly key: string; files: Map<string, string>; absent: Set<string> };
  readonly result: ShardResult;
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

async function hold(shard: Shard, requested: ReadonlyArray<string>): Promise<void> {
  for (const path of requested) {
    const file = shard.paths.get(path);
    if (file === undefined) shard.library.absent.add(path);
    else shard.library.files.set(path, await readFile(file, "utf8"));
  }
}

async function matches(
  { job, result }: Shard,
  label: string,
  file: string,
  glyph: Uint8Array | null,
): Promise<boolean> {
  if (glyph === null) {
    result.mismatches.push(`${label}: WASM has no glyph`);
    return false;
  }
  const decoded = decodePlanGlyph(glyph);
  if (decoded.ok) result.decoded++;
  else result.mismatches.push(`${label}: ${issueText(decoded.issues)}`);
  result.glyphBytes += glyph.length;
  const same = sameBytes(glyph, await readFile(join(job.native, file)));
  if (!same) result.mismatches.push(`${label}: glyph bytes differ`);
  return same && decoded.ok;
}

async function compareParts(shard: Shard): Promise<void> {
  const { job, compiler, library, result } = shard;
  for (let start = 0; start < job.parts.length; start += BATCH_PARTS) {
    const batch = job.parts.slice(start, start + BATCH_PARTS);
    const request = {
      lod: "standard" as const,
      studPrimitives: job.options.studPrimitives,
      unofficialAllowlist: job.options.unofficialAllowlist,
      connectors: job.connectors,
      parts: batch.map(([, part]) => part.part),
      model: "",
      inlineChecks: [],
      glyphs: { translucentColors: job.options.translucentColors },
    };
    let output = compiler.compile(request, library);
    for (;;) {
      const requested = output.parts.flatMap((outcome) =>
        outcome.status === "need" ? outcome.paths : [],
      );
      if (requested.length === 0) break;
      await hold(shard, requested);
      output = compiler.compile(request, library);
    }
    for (const [i, [id, expected]] of batch.entries()) {
      const outcome = output.parts[i];
      if (outcome === undefined) {
        result.mismatches.push(`${id}: no outcome`);
      } else if ("failed" in expected) {
        if (outcome.status === "failed" && outcome.message === expected.failed)
          result.identicalParts++;
        else
          result.mismatches.push(
            `${id}: native failed (${expected.failed}), WASM ${outcome.status}`,
          );
      } else if (outcome.status !== "compiled") {
        result.mismatches.push(`${id}: WASM ${outcome.status}`);
      } else if ("glyphIssue" in expected) {
        if (outcome.glyph === null && outcome.glyphIssue === expected.glyphIssue)
          result.identicalParts++;
        else result.mismatches.push(`${id}: native has no glyph (${expected.glyphIssue})`);
      } else if (await matches(shard, id, expected.glyph, outcome.glyph)) {
        result.identicalParts++;
      }
    }
  }
}

async function compareModels(shard: Shard): Promise<void> {
  const { job, compiler, library, result } = shard;
  for (const model of job.models) {
    const drawn = Uint8Array.from(model.drawn);
    const drawnCount = model.drawn.filter((kept) => kept === 1).length;
    const request = {
      source: await readFile(join(job.root, model.file), "utf8"),
      drawn,
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
      await hold(shard, baked.paths);
      baked = compiler.bake(request, library);
    }
    if (baked.status !== "baked") {
      result.mismatches.push(`${model.file}: WASM bake ${baked.status}: ${baked.message}`);
    } else if (model.glyph === undefined) {
      if (baked.glyph === null && baked.glyphIssue === (model.glyphIssue ?? null))
        result.identicalModels++;
      else result.mismatches.push(`${model.file}: native has no glyph (${model.glyphIssue})`);
    } else if (await matches(shard, model.file, model.glyph, baked.glyph)) {
      result.identicalModels++;
    }
  }
}

async function compareShard(job: ShardJob): Promise<ShardResult> {
  const shard: Shard = {
    job,
    compiler: new BrickCompiler(new WebAssembly.Module(await readFile(job.wasm))),
    paths: await libraryPaths(job.ldraw),
    library: { key: LIBRARY_KEY, files: new Map(), absent: new Set() },
    result: { identicalParts: 0, identicalModels: 0, decoded: 0, glyphBytes: 0, mismatches: [] },
  };
  await compareParts(shard);
  await compareModels(shard);
  return shard.result;
}

async function connectorInputs(
  primitivesPath: string,
  vocabularyPath: string,
  inferredPath: string,
): Promise<CompilerConnectorInputs> {
  const primitives = decodedOrThrow(
    decode(PrimitiveConnectorTable, json(await readFile(primitivesPath))),
    primitivesPath,
  );
  const vocabulary = decodedOrThrow(
    decode(SectionVocabularyFile, json(await readFile(vocabularyPath))),
    vocabularyPath,
  );
  const inferred = decodedOrThrow(
    decode(InferredConnectors, json(await readFile(inferredPath))),
    inferredPath,
  );
  return {
    primitives,
    sectionVocabulary: { sizes: vocabulary.sizes, lengths: vocabulary.lengths },
    cavityProbe: inferred.cavityProbe,
    infer: [],
    shadowPatchManifest: null,
  };
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

function dealt<T>(items: ReadonlyArray<T>, workers: number, worker: number): T[] {
  return items.filter((_, i) => i % workers === worker);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      native: { type: "string", default: "../../.cache/glyph-parity" },
      root: { type: "string", default: "../.." },
      ldraw: { type: "string", default: "../../.cache/ldraw-library" },
      primitives: { type: "string", default: "../asset-pipeline/primitive-connectors.json" },
      vocabulary: { type: "string", default: "../asset-pipeline/section-vocabulary.json" },
      inferred: { type: "string", default: "../asset-pipeline/inferred-connectors.json" },
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
  const connectors = await connectorInputs(values.primitives, values.vocabulary, values.inferred);
  const parts = Object.entries(listing.parts).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const results = await Promise.all(
    Array.from({ length: workers }, (_, worker) =>
      runWorker({
        native: values.native,
        root: values.root,
        wasm: values.wasm,
        ldraw: values.ldraw,
        options: listing.options,
        connectors,
        parts: dealt(parts, workers, worker),
        models: dealt(listing.models, workers, worker),
      }),
    ),
  );
  const sum = (pick: (result: ShardResult) => number) =>
    results.reduce((total, result) => total + pick(result), 0);
  const mismatches = results.flatMap((result) => result.mismatches).toSorted();
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  process.stdout.write(
    `plan glyph parity: ${sum((r) => r.identicalParts)} of ${parts.length} parts and ${sum((r) => r.identicalModels)} of ${listing.models.length} models identical between the native bake and the shipped WASM compiler (glyphs and failures); ${sum((r) => r.decoded)} glyphs, ${sum((r) => r.glyphBytes)} bytes, decoded by @brr/schema; ${seconds} s on ${workers} workers\n`,
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

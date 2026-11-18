import { BrickCompiler } from "@brr/import";
import {
  LibraryBakeBucket,
  LibraryBakeIndex,
  libraryBakeBucket,
  type LibraryBakeOptions,
  type LibraryBakePart,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readdir, readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const INDEX_FILE = "library-bake.json";
const PART_ID_PREFIX = "ldraw:";
const PART_EXTENSION = ".dat";
const LIBRARY_KEY = "library-bake-parity";
const BATCH_PARTS = 64;
const MISMATCHES_SHOWN = 20;

type Expected =
  | { readonly id: string; readonly part: LibraryBakePart }
  | { readonly id: string; readonly failed: string };

interface ShardJob {
  readonly records: string;
  readonly wasm: string;
  readonly ldraw: string;
  readonly options: LibraryBakeOptions;
  readonly expected: ReadonlyArray<Expected>;
}

interface ShardResult {
  readonly identical: number;
  readonly mismatches: ReadonlyArray<string>;
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

function reference(id: string): string {
  return `${id.slice(PART_ID_PREFIX.length)}${PART_EXTENSION}`;
}

async function compareShard(job: ShardJob): Promise<ShardResult> {
  const compiler = new BrickCompiler(new WebAssembly.Module(await readFile(job.wasm)));
  const paths = await libraryPaths(job.ldraw);
  const library = { key: LIBRARY_KEY, files: new Map<string, string>(), absent: new Set<string>() };
  let identical = 0;
  const mismatches: string[] = [];
  for (let start = 0; start < job.expected.length; start += BATCH_PARTS) {
    const batch = job.expected.slice(start, start + BATCH_PARTS);
    const request = {
      lod: "standard" as const,
      studPrimitives: job.options.studPrimitives,
      unofficialAllowlist: job.options.unofficialAllowlist,
      primitives: job.options.primitives,
      parts: batch.map(({ id }) => reference(id)),
      model: "",
      inlineChecks: [],
      records: true,
    };
    let output = compiler.compile(request, library);
    for (;;) {
      const requested = output.parts.flatMap((outcome) =>
        outcome.status === "need" ? outcome.paths : [],
      );
      if (requested.length === 0) break;
      for (const path of requested) {
        const file = paths.get(path);
        if (file === undefined) library.absent.add(path);
        else library.files.set(path, await readFile(file, "utf8"));
      }
      output = compiler.compile(request, library);
    }
    for (const [i, expected] of batch.entries()) {
      const outcome = output.parts[i];
      if (outcome === undefined) {
        mismatches.push(`${expected.id}: no outcome`);
        continue;
      }
      if ("failed" in expected) {
        if (outcome.status === "failed" && outcome.message === expected.failed) identical++;
        else
          mismatches.push(
            `${expected.id}: native failed (${expected.failed}), WASM ${outcome.status}`,
          );
        continue;
      }
      if (outcome.status !== "compiled" || outcome.record === null) {
        mismatches.push(`${expected.id}: WASM ${outcome.status}`);
        continue;
      }
      const [record, glb] = await Promise.all([
        readFile(join(job.records, expected.part.record)),
        readFile(join(job.records, expected.part.glb)),
      ]);
      const recordSame = sameBytes(outcome.record, record);
      const glbSame = sameBytes(outcome.glb, glb);
      if (recordSame && glbSame) identical++;
      else
        mismatches.push(
          `${expected.id}: ${[recordSame ? null : "record", glbSame ? null : "GLB"].filter((x) => x !== null).join(" and ")} differ`,
        );
    }
  }
  return { identical, mismatches };
}

async function expectedParts(records: string): Promise<{
  readonly options: LibraryBakeOptions;
  readonly expected: ReadonlyArray<Expected>;
}> {
  const index = decodedOrThrow(
    decode(LibraryBakeIndex, json(await readFile(join(records, INDEX_FILE)))),
    INDEX_FILE,
  );
  const expected: Expected[] = Object.entries(index.failed).map(([id, failed]) => ({ id, failed }));
  for (const [bucket, file] of index.buckets.entries()) {
    const listed = decodedOrThrow(
      decode(LibraryBakeBucket, json(await readFile(join(records, file)))),
      file,
    );
    if (listed.bucket !== bucket)
      throw new Error(`${file} holds bucket ${listed.bucket}, not ${bucket}`);
    for (const [id, part] of Object.entries(listed.parts)) {
      if (libraryBakeBucket(id) !== bucket) throw new Error(`${id} is filed in bucket ${bucket}`);
      expected.push({ id, part });
    }
  }
  return {
    options: index.options,
    expected: expected.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
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
      if (code !== 0) reject(new Error(`parity worker exited with ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      records: { type: "string", default: "../asset-pipeline/dist/library-bake" },
      wasm: {
        type: "string",
        default: "../../target/wasm32-wasip1/release/brick_compile_wasm.wasm",
      },
      ldraw: { type: "string", default: "../../.cache/ldraw-library" },
      workers: { type: "string", default: String(availableParallelism()) },
    },
  });
  const workers = Number(values.workers);
  const started = performance.now();
  const { options, expected } = await expectedParts(values.records);
  const shards = Array.from({ length: workers }, (): Expected[] => []);
  for (const [i, part] of expected.entries()) shards[i % workers]?.push(part);
  const results = await Promise.all(
    shards.map((shard) =>
      runWorker({
        records: values.records,
        wasm: values.wasm,
        ldraw: values.ldraw,
        options,
        expected: shard,
      }),
    ),
  );
  const identical = results.reduce((sum, result) => sum + result.identical, 0);
  const mismatches = results.flatMap((result) => result.mismatches).toSorted();
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  process.stdout.write(
    `library bake parity: ${identical} of ${expected.length} parts identical between the native pipeline and the shipped WASM compiler (records, standard GLBs and failures) in ${seconds} s on ${workers} workers\n`,
  );
  for (const mismatch of mismatches.slice(0, MISMATCHES_SHOWN))
    process.stdout.write(`  ${mismatch}\n`);
  if (mismatches.length > MISMATCHES_SHOWN) {
    process.stdout.write(`  and ${mismatches.length - MISMATCHES_SHOWN} more\n`);
  }
  if (identical !== expected.length) process.exitCode = 1;
}

if (isMainThread) {
  await main();
} else {
  parentPort?.postMessage(await compareShard(workerData as ShardJob), []);
}

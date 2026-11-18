import {
  BrickCompiler,
  importStudioFile,
  LdrawMirror,
  ModelImportEngine,
  type FetchFunction,
  type IBakeHelper,
  type ImportResult,
} from "@brr/import";
import type { StudioRejection } from "@brr/schema/bundle";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bundle } from "./bundle.ts";
import type { InputFormat } from "./corpus.ts";

const HTTP_NOT_FOUND = 404;
const NO_BAKE_HELPERS: ReadonlyArray<IBakeHelper> = [];
const NOT_FOUND_MARKER = ".absent";

export interface HeldOutInput {
  readonly name: string;
  readonly format: InputFormat;
  readonly bytes: Uint8Array;
}

export type ImportOutcome =
  | { readonly kind: "imported"; readonly result: ImportResult }
  | {
      readonly kind: "rejected";
      readonly rejection: StudioRejection;
      readonly surfacedMessage: string;
    }
  | { readonly kind: "threw"; readonly message: string };

function keyOf(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

export function cachingFetch(directory: string): FetchFunction {
  return async (url) => {
    const path = join(directory, keyOf(url));
    const hit = await readFile(path).catch(() => null);
    if (hit) return new Response(hit);
    if (await readFile(path + NOT_FOUND_MARKER).catch(() => null)) {
      return new Response(null, { status: HTTP_NOT_FOUND });
    }
    const response = await fetch(url);
    await mkdir(directory, { recursive: true });
    if (response.status === HTTP_NOT_FOUND) {
      await writeFile(path + NOT_FOUND_MARKER, url);
      return new Response(null, { status: HTTP_NOT_FOUND });
    }
    if (!response.ok) return response;
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(path, bytes);
    return new Response(bytes);
  };
}

function now(): number {
  return performance.now();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function studioArchive(
  compiler: BrickCompiler,
  bytes: Uint8Array,
): ReturnType<BrickCompiler["readStudio"]> | null {
  try {
    return compiler.readStudio(bytes);
  } catch {
    return null;
  }
}

export async function importThroughWorkerPath(
  bundle: Bundle,
  fetchUrl: FetchFunction,
  input: HeldOutInput,
): Promise<ImportOutcome> {
  const compiler = new BrickCompiler(bundle.compiler);
  const mirror = new LdrawMirror(bundle.source, fetchUrl);
  const engine = new ModelImportEngine(
    compiler,
    mirror,
    bundle.connectors,
    bundle.records,
    now,
    NO_BAKE_HELPERS,
  );
  const job = { ...bundle.job, fileName: input.name };
  try {
    switch (input.format) {
      case "ldraw":
        return {
          kind: "imported",
          result: await engine.importText({
            ...job,
            text: new TextDecoder().decode(input.bytes),
          }),
        };
      case "studio":
        return {
          kind: "imported",
          result: await importStudioFile(engine, compiler, mirror, {
            kind: "studio",
            job,
            bytes: input.bytes,
            bricklinkParts: bundle.bricklinkParts,
          }),
        };
      default: {
        const unhandled: never = input.format;
        throw new Error(`unhandled input format ${String(unhandled)}`);
      }
    }
  } catch (error) {
    const message = messageOf(error);
    if (input.format !== "studio") return { kind: "threw", message };
    const archive = studioArchive(compiler, input.bytes);
    if (archive?.status !== "rejected") return { kind: "threw", message };
    return { kind: "rejected", rejection: archive, surfacedMessage: message };
  }
}

import { ConnectorRecords } from "@brr/catalog/connector-records";
import {
  BrickCompiler,
  LdrawMirror,
  ModelImportEngine,
  type FetchFunction,
  type ImportResult,
} from "@brr/import";
import { readFile } from "node:fs/promises";
import type { IImportWorkerPool, ImportRun } from "./import-worker-pool.ts";

const HTTP_NOT_FOUND = 404;
const pinnedLibrary = new URL("../../../../.cache/ldraw/", import.meta.url);

const pinnedMirror: FetchFunction = async (url) => {
  const path = /\/ldraw\/(?<path>.+)$/u.exec(url)?.groups?.["path"];
  if (path === undefined) return new Response(null, { status: HTTP_NOT_FOUND });
  return readFile(new URL(path, pinnedLibrary), "utf8").then(
    (text) => new Response(text),
    () => new Response(null, { status: HTTP_NOT_FOUND }),
  );
};

export class InProcessImportPool implements IImportWorkerPool {
  async run(request: ImportRun): Promise<ImportResult> {
    const { input } = request;
    if (input.kind !== "ldraw") throw new Error("the in-process import pool reads LDraw text only");
    const readJson = async (path: string): Promise<unknown> =>
      JSON.parse(await readFile(new URL(path, request.bundleBaseUrl), "utf8"));
    const engine = new ModelImportEngine(
      new BrickCompiler(new WebAssembly.Module(await readFile(new URL(request.compilerUrl)))),
      new LdrawMirror(input.job.source, pinnedMirror),
      new ConnectorRecords(readJson, request.connectorIndexes, request.connectorVocabulary),
      () => 0,
      [],
    );
    return engine.importText(input.job);
  }
}

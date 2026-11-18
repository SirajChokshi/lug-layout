import type { FetchFunction, ImportWorkerRequest } from "@brr/import";
import type { RpcPort } from "@brr/rpc";
import type { CompilerVehicles, PrimitiveConnectorTable } from "@brr/schema/bundle";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { importWorkerModule } from "./import-worker.module.ts";
import { IMPORT_CLOCK, IMPORT_FETCH, IMPORT_WORKER_SERVICE } from "./tokens.ts";

const bundleRoot = new URL(
  "../../../../tools/asset-pipeline/dist/bundle/standard/",
  import.meta.url,
);
const pinnedLibrary = new URL("../../../../.cache/ldraw/", import.meta.url);
const probeFile = new URL("../../../import/test-data/critic-gap-3.mpd", import.meta.url);
const COMPILER_URL = "https://bundle.example/brick-compile.wasm";
const LIBRARY_URL = "https://library.example/mirror";
const HTTP_NOT_FOUND = 404;
const OPAQUE_ALPHA = 255;
const idlePort: RpcPort = { postMessage: () => undefined, addEventListener: () => undefined };

interface Manifest {
  readonly source: { readonly repo: string; readonly commit: string; readonly root: string };
  readonly partTable: { readonly file: string };
  readonly studPrimitives: ReadonlyArray<{ readonly name: string }>;
  readonly colors: ReadonlyArray<{ readonly code: number; readonly alpha: number }>;
  readonly compiler: {
    readonly file: string;
    readonly vehicles?: CompilerVehicles;
    readonly primitives?: PrimitiveConnectorTable;
  };
  readonly tablePlane: { readonly depthBelowTopLdu: number };
}

async function readManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(new URL("manifest.json", bundleRoot), "utf8")) as Manifest;
}

function servedFrom(manifest: Manifest, requested: string[]): FetchFunction {
  const libraryPrefix = `${LIBRARY_URL}/${manifest.source.repo}/${manifest.source.commit}/${manifest.source.root}/`;
  return async (url) => {
    requested.push(url);
    if (url === COMPILER_URL)
      return new Response(await readFile(new URL(manifest.compiler.file, bundleRoot)));
    if (!url.startsWith(libraryPrefix)) return new Response(null, { status: HTTP_NOT_FOUND });
    const path = url.slice(libraryPrefix.length).split("/").map(decodeURIComponent).join("/");
    return readFile(new URL(path, pinnedLibrary), "utf8").then(
      (text) => new Response(text),
      () => new Response(null, { status: HTTP_NOT_FOUND }),
    );
  };
}

it("imports with the compiler and LDraw library the request names and the worker clock, downloading the compiler once", async () => {
  const manifest = await readManifest();
  const partTable = JSON.parse(
    await readFile(new URL(manifest.partTable.file, bundleRoot), "utf8"),
  ) as { readonly parts: ReadonlyArray<{ readonly id: string }> };
  const requested: string[] = [];
  let clockReads = 0;
  const container = new Container();
  container.load(importWorkerModule(idlePort));
  container.rebind(IMPORT_FETCH).toConstantValue(servedFrom(manifest, requested));
  container.rebind(IMPORT_CLOCK).toConstantValue(() => {
    clockReads++;
    return 0;
  });
  const service = container.get(IMPORT_WORKER_SERVICE);
  const request = (text: string): ImportWorkerRequest => ({
    kind: "import",
    compilerUrl: COMPILER_URL,
    ldrawLibraryUrl: LIBRARY_URL,
    input: {
      kind: "ldraw",
      job: {
        fileName: "critic-gap-3.mpd",
        text,
        lod: "standard",
        source: manifest.source,
        studPrimitives: manifest.studPrimitives.map((primitive) => primitive.name),
        unofficialAllowlist: [],
        bundlePartIds: partTable.parts.map((part) => part.id),
        ldconfigCodes: manifest.colors.map((color) => color.code),
        translucentColors: manifest.colors
          .filter((color) => color.alpha < OPAQUE_ALPHA)
          .map((color) => color.code),
        vehicles: manifest.compiler.vehicles ?? null,
        tableDepthLdu: manifest.tablePlane.depthBelowTopLdu,
        primitives: manifest.compiler.primitives ?? null,
      },
    },
  });
  const text = await readFile(probeFile, "utf8");

  const first = await service.run(request(text));
  await service.run(request(text));

  expect(clockReads).toBeGreaterThan(0);
  expect(first.report.fetched.found).toBeGreaterThan(0);
  expect(requested.filter((url) => url === COMPILER_URL)).toHaveLength(1);
  expect(
    requested.filter((url) => url !== COMPILER_URL && !url.startsWith(`${LIBRARY_URL}/`)),
  ).toEqual([]);
});

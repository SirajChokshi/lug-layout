import { readFile } from "node:fs/promises";
import type { BlueBrickMap } from "@brr/schema/bluebrick";
import { CrosswalkFile, TrackCatalog, TrackShape, type BundleManifest } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { BlueBrickPartMapper, MirrorPartResolver } from "./bluebrick-mapping.ts";
import { BrickCompiler } from "./brick-compiler.ts";
import { LdrawMirror, type FetchFunction, type MirrorSource } from "./ldraw-mirror.ts";
import { BricklinkPartsCrosswalk } from "./studio-mapping.ts";

const bundleRoot = new URL("../../../tools/asset-pipeline/dist/bundle/standard/", import.meta.url);
const pinnedLibrary = new URL("../../../.cache/ldraw/", import.meta.url);
const blueBrickFixtures = new URL("../../test-fixtures/bluebrick/", import.meta.url);
const HTTP_NOT_FOUND = 404;

export const BUNDLE_TIMEOUT_MS = 60_000;

interface Manifest {
  readonly source: MirrorSource;
  readonly compiler: { readonly file: string };
  readonly crosswalk: { readonly file: string };
  readonly colors: ReadonlyArray<{ readonly code: number }>;
  readonly models: ReadonlyArray<{ readonly name: string; readonly origin: string }>;
  readonly trackCatalog: unknown;
  readonly trackShapes: ReadonlyArray<unknown>;
}

export interface BlueBrickBundle {
  readonly compiler: BrickCompiler;
  readonly mapper: BlueBrickPartMapper;
  readonly track: Pick<BundleManifest, "trackCatalog" | "trackShapes">;
}

const pinnedMirror: FetchFunction = async (url) => {
  const path = /\/ldraw\/(?<path>.+)$/u.exec(url)?.groups?.["path"];
  if (path === undefined) return new Response(null, { status: HTTP_NOT_FOUND });
  return readFile(new URL(path, pinnedLibrary), "utf8").then(
    (text) => new Response(text),
    () => new Response(null, { status: HTTP_NOT_FOUND }),
  );
};

async function bundleJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(file, bundleRoot), "utf8"));
}

export async function blueBrickBundle(): Promise<BlueBrickBundle> {
  const manifest = (await bundleJson("manifest.json")) as Manifest;
  const compiler = new BrickCompiler(
    new WebAssembly.Module(await readFile(new URL(manifest.compiler.file, bundleRoot))),
  );
  const crosswalk = decodedOrThrow(
    decode(CrosswalkFile, await bundleJson(manifest.crosswalk.file)),
    manifest.crosswalk.file,
  );
  const mapper = new BlueBrickPartMapper(
    new MirrorPartResolver(compiler, new LdrawMirror(manifest.source, pinnedMirror)),
    new BricklinkPartsCrosswalk(crosswalk.bricklinkParts),
    new Set(manifest.colors.map((color) => color.code)),
    new Set(manifest.models.filter((model) => model.origin === "omr").map((model) => model.name)),
  );
  const track = {
    trackCatalog: decodedOrThrow(decode(TrackCatalog, manifest.trackCatalog), "trackCatalog"),
    trackShapes: manifest.trackShapes.map((shape) =>
      decodedOrThrow(decode(TrackShape, shape), "trackShapes"),
    ),
  };
  return { compiler, mapper, track };
}

export async function readFixture(compiler: BrickCompiler, file: string): Promise<BlueBrickMap> {
  const read = compiler.readBlueBrick(await readFile(new URL(file, blueBrickFixtures)));
  if (read.status !== "read") throw new Error(`${file}: ${read.message}`);
  return read.map;
}

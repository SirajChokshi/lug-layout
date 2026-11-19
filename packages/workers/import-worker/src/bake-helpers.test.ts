import {
  BrickCompiler,
  LdrawMirror,
  ModelImportEngine,
  type FetchFunction,
  type IBakeHelper,
  type ImportResult,
} from "@brr/import";
import { SectionVocabularyFile, type BundleRail } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readFile } from "node:fs/promises";
import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { serveBakes } from "./bake-helper-host.ts";
import { BakeHelperProxy } from "./bake-helper-proxy.ts";

const bundleRoot = new URL(
  "../../../../tools/asset-pipeline/dist/bundle/standard/",
  import.meta.url,
);
const pinnedLibrary = new URL("../../../../.cache/ldraw/", import.meta.url);
const customPileFile = new URL("../../../import/test-data/custom-pile.ldr", import.meta.url);
const paletteTemplate = new URL(
  "../../../../docs/verified-facts/scenes/mils-road-straight.ldr",
  import.meta.url,
);
const COMPILER_URL = "bundle/compiler.wasm";
const HELPERS = 2;
const BAKE_TIMEOUT_MS = 120_000;
const OPAQUE_ALPHA = 255;
const HTTP_NOT_FOUND = 404;

interface Manifest {
  readonly source: { readonly repo: string; readonly commit: string; readonly root: string };
  readonly partTable: { readonly file: string };
  readonly studPrimitives: ReadonlyArray<{ readonly name: string }>;
  readonly colors: ReadonlyArray<{ readonly code: number; readonly alpha: number }>;
  readonly tablePlane: { readonly depthBelowTopLdu: number };
  readonly compiler: {
    readonly file: string;
    readonly rails: ReadonlyArray<BundleRail>;
    readonly sectionVocabulary: { readonly file: string };
    readonly cavityProbe: string;
  };
}

const pinnedMirror: FetchFunction = async (url) => {
  const path = /\/ldraw\/(?<path>.+)$/u.exec(url)?.groups?.["path"];
  if (path === undefined) return new Response(null, { status: HTTP_NOT_FOUND });
  return readFile(new URL(path, pinnedLibrary), "utf8").then(
    (text) => new Response(text),
    () => new Response(null, { status: HTTP_NOT_FOUND }),
  );
};

const openPorts: Array<{ close(): void }> = [];
afterEach(() => {
  for (const port of openPorts.splice(0)) port.close();
});

async function importer(manifest: Manifest, module: WebAssembly.Module) {
  const partTable = JSON.parse(
    await readFile(new URL(manifest.partTable.file, bundleRoot), "utf8"),
  ) as { readonly parts: ReadonlyArray<{ readonly id: string }> };
  const vocabularyFile = new URL(manifest.compiler.sectionVocabulary.file, bundleRoot);
  const vocabulary = decodedOrThrow(
    decode(SectionVocabularyFile, JSON.parse(await readFile(vocabularyFile, "utf8"))),
    vocabularyFile.pathname,
  );
  return (fileName: string, text: string, commit: string, helpers: ReadonlyArray<IBakeHelper>) => {
    const source = { ...manifest.source, commit };
    const engine = new ModelImportEngine(
      new BrickCompiler(module),
      new LdrawMirror(source, pinnedMirror),
      { read: async () => ({ kind: "unlisted" }) },
      () => 0,
      helpers,
    );
    return engine.importText({
      fileName,
      text,
      lod: "standard",
      source,
      studPrimitives: manifest.studPrimitives.map((primitive) => primitive.name),
      unofficialAllowlist: [],
      primitives: null,
      sectionVocabulary: { sizes: vocabulary.sizes, lengths: vocabulary.lengths },
      cavityProbe: manifest.compiler.cavityProbe,
      bundlePartIds: partTable.parts.map((part) => part.id),
      ldconfigCodes: manifest.colors.map((color) => color.code),
      translucentColors: manifest.colors
        .filter((color) => color.alpha < OPAQUE_ALPHA)
        .map((color) => color.code),
      tableDepthLdu: manifest.tablePlane.depthBelowTopLdu,
      rails: manifest.compiler.rails,
    });
  };
}

type CompilerFor = () => Promise<BrickCompiler>;

function helpersOverPorts(compilers: ReadonlyArray<CompilerFor>): ReadonlyArray<IBakeHelper> {
  return compilers.map((compilerFor) => {
    const channel = new MessageChannel();
    openPorts.push(channel.port1, channel.port2);
    serveBakes(channel.port2 as unknown as MessagePort, compilerFor);
    return new BakeHelperProxy(channel.port1 as unknown as MessagePort).helper(COMPILER_URL);
  });
}

function reactors(module: WebAssembly.Module, count: number): ReadonlyArray<CompilerFor> {
  return Array.from({ length: count }, () => {
    const compiler = Promise.resolve(new BrickCompiler(module));
    return () => compiler;
  });
}

function reactorsHeldUntil(
  module: WebAssembly.Module,
  count: number,
  requests: number,
): ReadonlyArray<CompilerFor> {
  return Array.from({ length: count }, () => {
    const { promise: held, resolve: release } = Promise.withResolvers<BrickCompiler>();
    let asked = 0;
    return () => {
      asked++;
      if (asked === requests) release(new BrickCompiler(module));
      return held;
    };
  });
}

const unloadable: CompilerFor = () => Promise.reject(new Error("GET compiler failed with 503"));

async function bundleInputs() {
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", bundleRoot), "utf8"),
  ) as Manifest;
  const module = new WebAssembly.Module(
    await readFile(new URL(manifest.compiler.file, bundleRoot)),
  );
  return { manifest, module, importText: await importer(manifest, module) };
}

it(
  "bakes a custom file over helper ports the same as on one reactor, import after import and across libraries",
  async () => {
    const { manifest, module, importText } = await bundleInputs();
    const text = await readFile(customPileFile, "utf8");
    const helpers = helpersOverPorts(reactors(module, HELPERS));
    const otherLibrary = `${manifest.source.commit}-again`;

    const alone = await importText("custom-pile.ldr", text, manifest.source.commit, []);
    const imports: ImportResult[] = [];
    for (const commit of [manifest.source.commit, manifest.source.commit, otherLibrary]) {
      imports.push(await importText("custom-pile.ldr", text, commit, helpers));
    }

    expect(alone.bake?.studCover.covered).toBeGreaterThan(0);
    for (const helped of imports) {
      expect(helped.report.bakeHelpersFailed).toBe(0);
      expect(helped.bake).toEqual(alone.bake);
    }
  },
  BAKE_TIMEOUT_MS,
);

it(
  "bakes two files with different parts and libraries at once over the same helper ports as each bakes alone, in as many rounds",
  async () => {
    const { manifest, module, importText } = await bundleInputs();
    const pile = await readFile(customPileFile, "utf8");
    const road = await readFile(paletteTemplate, "utf8");
    const otherLibrary = `${manifest.source.commit}-other`;
    const helpers = helpersOverPorts(reactorsHeldUntil(module, HELPERS, 2));

    const pileAlone = await importText("custom-pile.ldr", pile, manifest.source.commit, []);
    const roadAlone = await importText("mils-road-straight.ldr", road, otherLibrary, []);
    const [pileHelped, roadHelped] = await Promise.all([
      importText("custom-pile.ldr", pile, manifest.source.commit, helpers),
      importText("mils-road-straight.ldr", road, otherLibrary, helpers),
    ]);

    expect(pileHelped.report.bakeHelpersFailed).toBe(0);
    expect(roadHelped.report.bakeHelpersFailed).toBe(0);
    expect(pileHelped.report.bakeRounds).toBe(pileAlone.report.bakeRounds);
    expect(roadHelped.report.bakeRounds).toBe(roadAlone.report.bakeRounds);
    expect(pileHelped.bake).toEqual(pileAlone.bake);
    expect(roadHelped.bake).toEqual(roadAlone.bake);
  },
  BAKE_TIMEOUT_MS,
);

it(
  "bakes a custom file the same when a helper's compiler fails to load, and counts that helper failed",
  async () => {
    const { manifest, module, importText } = await bundleInputs();
    const text = await readFile(customPileFile, "utf8");
    const helpers = helpersOverPorts([...reactors(module, 1), unloadable]);

    const alone = await importText("custom-pile.ldr", text, manifest.source.commit, []);
    const helped = await importText("custom-pile.ldr", text, manifest.source.commit, helpers);

    expect(helped.report.bakeHelpersFailed).toBe(1);
    expect(helped.bake).toEqual(alone.bake);
  },
  BAKE_TIMEOUT_MS,
);

it("rejects a pending bake when the helper's end of the port closes", async () => {
  const channel = new MessageChannel();
  openPorts.push(channel.port1, channel.port2);
  const helper = new BakeHelperProxy(channel.port1 as unknown as MessagePort).helper(COMPILER_URL);
  const request = {} as Parameters<IBakeHelper["bake"]>[0];

  const pending = helper.bake(request, { key: "unused", files: new Map(), absent: new Set() });
  channel.port2.close();

  await expect(pending).rejects.toThrow("port closed");
});

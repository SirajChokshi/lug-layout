import type { IPartBundleLoader } from "@brr/catalog";
import {
  BrickCompiler,
  LdrawMirror,
  ModelImportEngine,
  type FetchFunction,
  type ImportResult,
  type PartConnectorSource,
  type RollingDiagnosticsRows,
} from "@brr/import";
import type { BundleLod } from "@brr/schema/bundle";
import { readFile } from "node:fs/promises";
import type { IModelImporter } from "./worker-model-importer.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const pinnedLibrary = new URL("../../../../.cache/ldraw/", import.meta.url);
const pinnedOmr = new URL("../../../../.cache/omr/", import.meta.url);
const HTTP_NOT_FOUND = 404;
const LDRAW_PATH = /\/ldraw\/(?<path>.+)$/u;

const pinnedMirror: FetchFunction = async (url) => {
  const path = LDRAW_PATH.exec(url)?.groups?.["path"];
  if (path === undefined) return new Response(null, { status: HTTP_NOT_FOUND });
  return readFile(new URL(path, pinnedLibrary), "utf8").then(
    (text) => new Response(text),
    () => new Response(null, { status: HTTP_NOT_FOUND }),
  );
};

export function pinnedOmrModel(file: string): Promise<string> {
  return readFile(new URL(file, pinnedOmr), "utf8");
}

const NO_CONNECTOR_RECORDS: PartConnectorSource = { read: async () => ({ kind: "unlisted" }) };

export class InThreadModelImporter implements IModelImporter {
  constructor(
    private readonly loader: IPartBundleLoader,
    private readonly connectors: PartConnectorSource = NO_CONNECTOR_RECORDS,
  ) {}

  async importText(
    fileName: string,
    text: string,
    lod: BundleLod = "standard",
  ): Promise<ImportResult> {
    const context = await this.loader.importContext(lod);
    const wasm = await readFile(new URL(context.compilerPath, bundleRoot));
    const engine = new ModelImportEngine(
      new BrickCompiler(await WebAssembly.compile(wasm)),
      new LdrawMirror(context.source, pinnedMirror),
      this.connectors,
      null,
      () => 0,
      [],
      null,
    );
    return engine.importText({
      fileName,
      text,
      lod,
      source: context.source,
      studPrimitives: context.studPrimitiveNames,
      unofficialAllowlist: context.unofficialAllowlist,
      primitives: context.primitives,
      sectionVocabulary: context.sectionVocabulary.vocabulary,
      cavityProbe: context.cavityProbe,
      bundlePartIds: context.partIds,
      ldconfigCodes: context.ldconfigCodes,
      translucentColors: context.translucentCodes,
      tableDepthLdu: context.tableDepthLdu,
      vehicles: context.vehicles,
    });
  }

  importStudio(fileName: string): Promise<ImportResult> {
    return Promise.reject(new Error(`${fileName}: Studio files are not imported in this test`));
  }

  async rollingDiagnostics(): Promise<RollingDiagnosticsRows> {
    return {};
  }
}

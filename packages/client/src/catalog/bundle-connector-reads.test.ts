import { ASSET_FETCHER, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const CONNECTOR_FILE = /\/(?:connectivity|connectors?)-[^/]+\.json$/u;
const CONNECTOR_RECORD = /\/(?:connectivity|connectors)-(?!index\.)[^/]+\.json$/u;
const MANIFEST = /\/manifest\.json$/u;
const BRICK = "ldraw:3001";
const LOD = "standard";
const FORMS = ["packed", "per-part"] as const;
type Form = (typeof FORMS)[number];

function withoutPacks(manifest: string): string {
  const { connectorPacks: _packs, ...rest } = JSON.parse(manifest);
  return JSON.stringify(rest);
}

class BundleFiles implements IAssetFetcher {
  readonly requested: string[] = [];
  failing = false;

  constructor(private readonly form: Form) {}

  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    if (CONNECTOR_FILE.test(path)) this.requested.push(path);
    if (this.failing && CONNECTOR_RECORD.test(path)) throw new TypeError(`Failed to fetch ${path}`);
    const text = await readFile(new URL(path, bundleRoot), "utf8");
    return this.form === "per-part" && MANIFEST.test(path) ? withoutPacks(text) : text;
  }
}

function loaderOver(files: BundleFiles) {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(files);
  return container.get(PART_BUNDLE_LOADER);
}

async function bundlePartIds(): Promise<ReadonlyArray<string>> {
  const manifest = JSON.parse(await readFile(new URL(`${LOD}/manifest.json`, bundleRoot), "utf8"));
  const index = JSON.parse(
    await readFile(new URL(`${LOD}/${manifest.connectivity.file}`, bundleRoot), "utf8"),
  );
  return Object.keys(index.parts);
}

it.each(FORMS)(
  "fetches a part's connector records once a session from the %s bundle and hands every reader the same record, and fetches them again after a read fails",
  async (form) => {
    const files = new BundleFiles(form);
    const loader = loaderOver(files);
    const records = () => files.requested.filter((path) => CONNECTOR_RECORD.test(path));
    const read = () => loader.readPartConnectors(LOD, BRICK);

    files.failing = true;
    const failure = await read().then(
      () => "read",
      (error: unknown) => String(error),
    );
    const failed = records();
    files.failing = false;
    const reads = await Promise.all([read(), read(), read()]);
    const later = await read();
    const retried = records().slice(failed.length);
    const loads = [...reads, later];

    expect({
      failure,
      loaded: loads.map((load) => load.kind),
      distinctRecords: new Set(loads).size,
      retried: retried.toSorted(),
    }).toEqual({
      failure: expect.stringContaining("Failed to fetch"),
      loaded: ["loaded", "loaded", "loaded", "loaded"],
      distinctRecords: 1,
      retried: [...new Set([...failed, ...retried])].toSorted(),
    });
  },
);

it("reads every part the bundle lists from its two connector packs, one request each a session, exactly as its per-part files give them", async () => {
  const packedFiles = new BundleFiles("packed");
  const perPartFiles = new BundleFiles("per-part");
  const packed = loaderOver(packedFiles);
  const perPart = loaderOver(perPartFiles);
  const parts = await bundlePartIds();

  const fromPacks = await Promise.all(parts.map((id) => packed.readPartConnectors(LOD, id)));
  const fromFiles = await Promise.all(parts.map((id) => perPart.readPartConnectors(LOD, id)));
  const { connectorPacks } = await packed.loadIndex(LOD);
  const packFiles = [connectorPacks?.connectivity.file, connectorPacks?.connectors.file];

  expect({
    packedRequests: packedFiles.requested.toSorted(),
    perPartRequestsOfPacks: perPartFiles.requested.filter((path) => path.includes("-pack.")),
    loads: fromPacks,
  }).toEqual({
    packedRequests: packFiles.map((file) => `${LOD}/${file}`).toSorted(),
    perPartRequestsOfPacks: [],
    loads: fromFiles,
  });
}, 60_000);

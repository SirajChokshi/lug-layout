import { ASSET_FETCHER, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const CONNECTOR_RECORD = /\/(?:connectivity|connectors)-(?!index\.)[^/]+\.json$/u;
const BRICK = "ldraw:3001";
const LOD = "standard";

class RecordCountingFetcher implements IAssetFetcher {
  readonly records: string[] = [];
  failing = false;

  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    if (CONNECTOR_RECORD.test(path)) {
      this.records.push(path);
      if (this.failing) throw new TypeError(`Failed to fetch ${path}`);
    }
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

it("fetches a part's connector records once a session and hands every reader the same record, and fetches them again after a read fails", async () => {
  const fetcher = new RecordCountingFetcher();
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(fetcher);
  const loader = container.get(PART_BUNDLE_LOADER);
  const read = () => loader.readPartConnectors(LOD, BRICK);

  fetcher.failing = true;
  const failure = await read().then(
    () => "read",
    (error: unknown) => String(error),
  );
  const failed = [...fetcher.records];
  fetcher.failing = false;
  const reads = await Promise.all([read(), read(), read()]);
  const later = await read();
  const retried = fetcher.records.slice(failed.length);

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
});

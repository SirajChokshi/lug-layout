import { ASSET_FETCHER, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import type { ModelRunningGear } from "@brr/schema/bundle";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const OFFICIAL_SWEEP_TIMEOUT_MS = 240_000;

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

function summary(gear: ModelRunningGear) {
  return {
    vehicles: gear.vehicles.map((vehicle) => ({
      guides: vehicle.guides.map((guide) => guide.kind),
      bogieWheelsets: vehicle.bogies.map((bogie) => bogie.wheelsets.length),
      fixedAxles: vehicle.fixedAxles.length,
      wheelsets: vehicle.wheelsets.length,
      seated: vehicle.wheelsets.filter((wheelset) => wheelset.seated).length,
      body: vehicle.body.length,
      endCandidates: [vehicle.frontEndCandidates.length, vehicle.rearEndCandidates.length],
    })),
    couplings: gear.vehicleCouplings.map((coupling) => ({
      vehicles: coupling.vehicles,
      pivot: coupling.pivot !== null,
    })),
    unresolved: gear.unresolvedRunningGear.map((report) => ({
      reason: report.reason,
      instances: report.instances.length,
      wheelsets: report.wheelsets.length,
    })),
    unreadRows: gear.unreadRollingBands.instance.length,
  };
}

it(
  "reads the running gear of every official model from its identified positions as the bundle records it",
  async () => {
    const container = new Container();
    container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
    container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
    const loader = container.get(PART_BUNDLE_LOADER);
    const manifest = await loader.loadManifest("standard");
    const summaries: Record<string, ReturnType<typeof summary>> = {};
    for (const entry of manifest.models.filter((model) => model.origin === "omr")) {
      const record = await loader.loadModelRecord("standard", entry.name);
      summaries[entry.name] = summary(record.model.runningGear);
    }

    await expect(`${JSON.stringify(summaries, null, 1)}\n`).toMatchFileSnapshot(
      "./official-running-gear.snapshot.json",
    );
  },
  OFFICIAL_SWEEP_TIMEOUT_MS,
);

import {
  ASSET_FETCHER,
  catalogModule,
  PART_BUNDLE_LOADER,
  BUNDLE_BASE_URL,
  type BakedVehicle,
  type IAssetFetcher,
} from "@brr/catalog";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { vehicleSpec } from "../sim/consist.ts";
import {
  detectedBogies,
  effectiveVehicle,
  parseRunningGearOverride,
  RUNNING_GEAR_OVERRIDE_VERSION,
  toModelFrame,
  type RunningGearOverride,
} from "./override.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }
  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

async function gp38(): Promise<{ vehicle: BakedVehicle; sha256: string }> {
  const container = new Container();
  container.load(catalogModule);
  container.bind(BUNDLE_BASE_URL).toConstantValue("unused/");
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const loaded = await container.get(PART_BUNDLE_LOADER).loadModel("standard", "10133-1");
  const vehicle = loaded.model.vehicles[0];
  if (!vehicle) throw new Error("10133-1 has no vehicle");
  return { vehicle, sha256: loaded.entry.sha256 };
}

describe("Running gear overrides on 10133-1", () => {
  it("moves a bogie-mounted coupling to the body, and a coupling face, as the override says", async () => {
    const { vehicle, sha256 } = await gp38();
    const front = vehicle.frontCoupler;
    if (!front || front.bogie === null)
      throw new Error("10133-1's front coupler hangs from a bogie");
    const bogies = detectedBogies(vehicle).map((bogie, b) =>
      b === front.bogie
        ? { ...bogie, instances: bogie.instances.filter((i) => i !== front.instance) }
        : bogie,
    );
    const movedFace = toModelFrame(vehicle, [front.face[0] + 0.75, front.face[1], front.face[2]]);
    const override: RunningGearOverride = {
      version: RUNNING_GEAR_OVERRIDE_VERSION,
      modelSha256: sha256,
      model: "10133-1",
      vehicles: [{ vehicle: 0, bogies, couplers: [{ instance: front.instance, face: movedFace }] }],
    };
    const restored = parseRunningGearOverride(JSON.parse(JSON.stringify(override)));
    expect(restored).toEqual(override);
    const result = effectiveVehicle(vehicle, restored?.vehicles[0]);
    expect(result.issues).toEqual([]);
    const effective = result.vehicle;
    if (!effective) throw new Error("override was rejected");
    expect(effective.frontCoupler?.bogie).toBeNull();
    expect(effective.body).toContain(front.instance);
    const before = vehicleSpec(vehicle, false);
    const after = vehicleSpec(effective, false);
    expect(after.lengthLdu - before.lengthLdu).toBeCloseTo(0.75, 9);
    expect(after.frontBogieLdu - before.frontBogieLdu).toBeCloseTo(0.75, 9);
    expect(after.rearBogieLdu - before.rearBogieLdu).toBeCloseTo(0.75, 9);
  });

  it("refuses running gear that can't run and says why, instead of guessing", async () => {
    const { vehicle, sha256 } = await gp38();
    const [first, second] = detectedBogies(vehicle);
    if (!first || !second) throw new Error("10133-1 has two bogies");
    const noWheels = effectiveVehicle(vehicle, {
      vehicle: 0,
      bogies: [first, { ...second, instances: [] }],
    });
    expect(noWheels.vehicle).toBeNull();
    expect(noWheels.issues).toContain("bogie 2 carries no wheelset");
    const shared = effectiveVehicle(vehicle, {
      vehicle: 0,
      bogies: [first, { ...second, instances: [...second.instances, first.instances[0] ?? 0] }],
    });
    expect(shared.vehicle).toBeNull();
    expect(shared.issues.some((issue) => issue.includes("is in two bogies"))).toBe(true);
    expect(
      parseRunningGearOverride({ version: 2, modelSha256: sha256, model: "x", vehicles: [] }),
    ).toBeNull();
  });
});

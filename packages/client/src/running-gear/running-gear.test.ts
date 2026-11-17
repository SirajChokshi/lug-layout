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
import {
  IndexedDbRunningGearOverrideStore,
  type IRunningGearOverrideStore,
} from "./override-store.ts";
import { BOX_FLOATS, RunningGearEditor, type GearModelSource } from "./running-gear-editor.ts";

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

async function gearSource(name: string): Promise<GearModelSource> {
  const container = new Container();
  container.load(catalogModule);
  container.bind(BUNDLE_BASE_URL).toConstantValue("unused/");
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  const loaded = await container.get(PART_BUNDLE_LOADER).loadModel("standard", name);
  return {
    name,
    sha256: loaded.entry.sha256,
    vehicles: loaded.model.vehicles,
    instanceBoxes: new Float32Array(loaded.model.instanceCount * BOX_FLOATS),
  };
}

async function gp38(): Promise<{ vehicle: BakedVehicle; sha256: string }> {
  const source = await gearSource("10133-1");
  const vehicle = source.vehicles[0];
  if (!vehicle) throw new Error("10133-1 has no vehicle");
  return { vehicle, sha256: source.sha256 };
}

class MemoryOverrideStore implements IRunningGearOverrideStore {
  readonly records = new Map<string, RunningGearOverride>();

  async load(modelSha256: string): Promise<RunningGearOverride | null> {
    return this.records.get(modelSha256) ?? null;
  }
  async save(override: RunningGearOverride): Promise<void> {
    this.records.set(override.modelSha256, structuredClone(override));
  }
  async remove(modelSha256: string): Promise<void> {
    this.records.delete(modelSha256);
  }
  async all(): Promise<ReadonlyArray<RunningGearOverride>> {
    return [...this.records.values()];
  }
}

function frontFace(vehicle: BakedVehicle): { instance: number; x: number; z: number } {
  const coupler = vehicle.frontCoupler;
  if (!coupler) throw new Error("the vehicle has a front coupler");
  return { instance: coupler.instance, x: coupler.face[0], z: coupler.face[2] };
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
    const front = frontFace(vehicle);
    const pivotAt = (x: number) => toModelFrame(vehicle, [x, first.pivot[1], 0]);
    const refusals: ReadonlyArray<
      readonly [string, Parameters<typeof effectiveVehicle>[1], RegExp]
    > = [
      [
        "a bogie without wheels",
        { vehicle: 0, bogies: [first, { ...second, instances: [] }] },
        /^bogie 2 carries no wheelset$/,
      ],
      [
        "a part in two bogies",
        {
          vehicle: 0,
          bogies: [first, { ...second, instances: [...second.instances, first.instances[0] ?? 0] }],
        },
        /is in two bogies/,
      ],
      [
        "a coupling face inboard of its bogie pivot",
        {
          vehicle: 0,
          couplers: [{ instance: front.instance, face: toModelFrame(vehicle, [10, 0, front.z]) }],
        },
        /^the front guide lies [\d.]+ LDU ahead of the front coupling face, outside the vehicle$/,
      ],
      [
        "a pivot far outside the vehicle",
        { vehicle: 0, bogies: [{ ...first, pivot: pivotAt(5000) }, second] },
        /^the front guide lies [\d.]+ LDU ahead of the front coupling face, outside the vehicle$/,
      ],
      [
        "the front face moved behind the rear face",
        {
          vehicle: 0,
          couplers: [
            { instance: front.instance, face: toModelFrame(vehicle, [-1000, 0, front.z]) },
          ],
        },
        /^the front coupling face must lie ahead of the rear one/,
      ],
    ];
    for (const [, override, reason] of refusals) {
      const result = effectiveVehicle(vehicle, override);
      expect(result.vehicle).toBeNull();
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatch(reason);
    }
    const oneCoupler: BakedVehicle = { ...vehicle, rearCoupler: null };
    const crossed = effectiveVehicle(oneCoupler, {
      vehicle: 0,
      couplers: [{ instance: front.instance, face: toModelFrame(vehicle, [0, 0, front.z]) }],
    });
    expect(crossed.vehicle).toBeNull();
    expect(crossed.issues[0]).toMatch(/front coupling face .* must stay ahead/);
    expect(
      parseRunningGearOverride({ version: 2, modelSha256: sha256, model: "x", vehicles: [] }),
    ).toBeNull();
  });
});

describe("Running gear editor", () => {
  it("refuses to save gear the sim would refuse, and reports a refused saved override instead of hiding it", async () => {
    const source = await gearSource("10133-1");
    const vehicle = source.vehicles[0];
    if (!vehicle) throw new Error("10133-1 has no vehicle");
    const front = frontFace(vehicle);
    const store = new MemoryOverrideStore();
    const editor = new RunningGearEditor(store);
    await editor.setModels([source]);
    editor.select("10133-1", 0);
    editor.setCouplerFace(front.instance, 10, front.z);
    await editor.save();
    expect(store.records.size).toBe(0);
    expect(editor.snapshot().error).toMatch(/^not saved, this running gear cannot run: /);

    const inboard = toModelFrame(vehicle, [10, 0, front.z]);
    await store.save({
      version: RUNNING_GEAR_OVERRIDE_VERSION,
      modelSha256: source.sha256,
      model: "10133-1",
      vehicles: [{ vehicle: 0, couplers: [{ instance: front.instance, face: inboard }] }],
    });
    const reloaded = new RunningGearEditor(store);
    await reloaded.setModels([source]);
    expect(reloaded.effectiveVehicles("10133-1")).toEqual([vehicle]);
    expect(reloaded.gearSource("10133-1", 0)).toBe("override refused");
    expect(reloaded.snapshot().models[0]?.sources).toEqual(["override refused"]);
    reloaded.select("10133-1", 0);
    expect(reloaded.snapshot().view?.savedOverrideRefused?.[0]).toMatch(/front guide lies/);
  });

  it("resets only the selected vehicle of a model that bakes two", async () => {
    const source = await gearSource("10205-1");
    expect(source.vehicles).toHaveLength(2);
    const store = new MemoryOverrideStore();
    const editor = new RunningGearEditor(store);
    await editor.setModels([source]);
    for (const [v, vehicle] of source.vehicles.entries()) {
      const front = frontFace(vehicle);
      editor.select("10205-1", v);
      editor.setCouplerFace(front.instance, front.x + 0.5, front.z);
      await editor.save();
    }
    expect(editor.snapshot().models[0]?.sources).toEqual(["override", "override"]);
    editor.select("10205-1", 1);
    await editor.reset();
    expect(store.records.get(source.sha256)?.vehicles.map((v) => v.vehicle)).toEqual([0]);
    expect(editor.snapshot().models[0]?.sources).toEqual(["override", "detected"]);
    editor.select("10205-1", 0);
    await editor.reset();
    expect(store.records.has(source.sha256)).toBe(false);
  });

  it("runs the detected gear and says so when IndexedDB is missing", async () => {
    expect(globalThis.indexedDB).toBeUndefined();
    const source = await gearSource("10133-1");
    const editor = new RunningGearEditor(new IndexedDbRunningGearOverrideStore());
    await editor.setModels([source]);
    expect(editor.effectiveVehicles("10133-1")).toEqual(source.vehicles);
    expect(editor.snapshot().storeProblem).toMatch(/this browser has no IndexedDB/);
  });
});

import {
  ASSET_FETCHER,
  catalogModule,
  PART_BUNDLE_LOADER,
  BUNDLE_BASE_URL,
  type BakedVehicle,
  type IAssetFetcher,
  type Vec3Tuple,
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
import { instanceBoxes } from "./instance-boxes.ts";
import { exactLduText, RunningGearEditor, type GearModelSource } from "./running-gear-editor.ts";

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

function bundleLoader() {
  const container = new Container();
  container.load(catalogModule);
  container.bind(BUNDLE_BASE_URL).toConstantValue("unused/");
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  return container.get(PART_BUNDLE_LOADER);
}

async function gearSource(name: string): Promise<GearModelSource> {
  const loaded = await bundleLoader().loadModel("standard", name);
  return {
    name,
    sha256: loaded.entry.sha256,
    vehicles: loaded.model.vehicles,
    instanceBoxes: instanceBoxes(loaded.model, loaded.bundle),
  };
}

async function gp38(): Promise<{ vehicle: BakedVehicle; sha256: string; boxes: Float64Array }> {
  const source = await gearSource("10133-1");
  const vehicle = source.vehicles[0];
  if (!vehicle) throw new Error("10133-1 has no vehicle");
  return { vehicle, sha256: source.sha256, boxes: source.instanceBoxes };
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

function outsideBox(instance: number): RegExp {
  return new RegExp(
    `^the coupling face of part ${instance} lies [\\d.]+ LDU outside that part's box$`,
  );
}

function typed(value: number): number {
  return Number(exactLduText(value));
}

describe("Running gear overrides on 10133-1", () => {
  it("moves a bogie-mounted coupling to the body, and a coupling face, as the override says", async () => {
    const { vehicle, sha256, boxes } = await gp38();
    const front = vehicle.frontCoupler;
    if (!front || front.bogie === null)
      throw new Error("10133-1's front coupler hangs from a bogie");
    const bogies = detectedBogies(vehicle).map((bogie, b) =>
      b === front.bogie
        ? { ...bogie, instances: bogie.instances.filter((i) => i !== front.instance) }
        : bogie,
    );
    const movedFace: Vec3Tuple = [front.face[0] - 0.75, front.face[1], front.face[2]];
    const override: RunningGearOverride = {
      version: RUNNING_GEAR_OVERRIDE_VERSION,
      modelSha256: sha256,
      model: "10133-1",
      vehicles: [{ vehicle: 0, bogies, couplers: [{ instance: front.instance, face: movedFace }] }],
    };
    const restored = parseRunningGearOverride(JSON.parse(JSON.stringify(override)));
    expect(restored).toEqual(override);
    const result = effectiveVehicle(vehicle, restored?.vehicles[0], boxes);
    expect(result.issues).toEqual([]);
    const effective = result.vehicle;
    if (!effective) throw new Error("override was rejected");
    expect(effective.frontCoupler?.bogie).toBeNull();
    expect(effective.body).toContain(front.instance);
    const before = vehicleSpec(vehicle, false);
    const after = vehicleSpec(effective, false);
    expect(after.lengthLdu - before.lengthLdu).toBeCloseTo(-0.75, 9);
    expect(after.frontBogieLdu - before.frontBogieLdu).toBeCloseTo(-0.75, 9);
    expect(after.rearBogieLdu - before.rearBogieLdu).toBeCloseTo(-0.75, 9);
  });

  it("refuses running gear that can't run and says why, instead of guessing", async () => {
    const { vehicle, sha256, boxes } = await gp38();
    const [first, second] = detectedBogies(vehicle);
    if (!first || !second) throw new Error("10133-1 has two bogies");
    const front = frontFace(vehicle);
    const rear = vehicle.rearCoupler;
    if (!rear) throw new Error("10133-1 has a rear coupler");
    const pivotAt = (x: number): Vec3Tuple => [x, first.pivot[1], 0];
    const faceAt = (instance: number, x: number) => ({
      instance,
      face: [x, 0, front.z] satisfies Vec3Tuple,
    });
    const refusals: ReadonlyArray<
      readonly [string, Parameters<typeof effectiveVehicle>[1], ReadonlyArray<RegExp>]
    > = [
      [
        "a bogie without wheels",
        { vehicle: 0, bogies: [first, { ...second, instances: [] }] },
        [/^bogie 2 carries no wheelset$/],
      ],
      [
        "a part in two bogies",
        {
          vehicle: 0,
          bogies: [first, { ...second, instances: [...second.instances, first.instances[0] ?? 0] }],
        },
        [/is in two bogies/],
      ],
      [
        "a coupling face inboard of its bogie pivot",
        { vehicle: 0, couplers: [faceAt(front.instance, 10)] },
        [outsideBox(front.instance)],
      ],
      [
        "both faces pushed out to 1500 LDU, where a reverse used to throw",
        { vehicle: 0, couplers: [faceAt(front.instance, 1500), faceAt(rear.instance, -1500)] },
        [outsideBox(front.instance), outsideBox(rear.instance)],
      ],
      [
        "a face at 20000 LDU, which used to stop the run from loading",
        { vehicle: 0, couplers: [faceAt(front.instance, 20000)] },
        [outsideBox(front.instance)],
      ],
      [
        "a pivot far outside the vehicle",
        { vehicle: 0, bogies: [{ ...first, pivot: pivotAt(5000) }, second] },
        [/^bogie 1's pivot lies [\d.]+ LDU outside the footprint of its parts$/],
      ],
    ];
    for (const [, override, reasons] of refusals) {
      const result = effectiveVehicle(vehicle, override, boxes);
      expect(result.vehicle).toBeNull();
      expect(result.issues).toHaveLength(reasons.length);
      reasons.forEach((reason, i) => expect(result.issues[i]).toMatch(reason));
    }
    expect(
      parseRunningGearOverride({ version: 3, modelSha256: sha256, model: "x", vehicles: [] }),
    ).toBeNull();
  });

  it("accepts every baked vehicle's own detected gear restated as an override", async () => {
    const loader = bundleLoader();
    const manifest = await loader.loadManifest("standard");
    let checked = 0;
    for (const { name } of manifest.models) {
      const source = await gearSource(name);
      source.vehicles.forEach((vehicle, v) => {
        checked++;
        const couplers = [vehicle.frontCoupler, vehicle.rearCoupler].flatMap((c) =>
          c ? [{ instance: c.instance, face: c.face }] : [],
        );
        const result = effectiveVehicle(
          vehicle,
          { vehicle: v, bogies: detectedBogies(vehicle), couplers },
          source.instanceBoxes,
        );
        expect({ name, v, issues: result.issues }).toEqual({ name, v, issues: [] });
      });
    }
    expect(checked).toBeGreaterThanOrEqual(10);
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

    const inboard: Vec3Tuple = [10, 0, front.z];
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
    expect(reloaded.snapshot().view?.savedOverrideRefused?.[0]).toMatch(
      /^the coupling face of part \d+ lies [\d.]+ LDU outside that part's box$/,
    );
  });

  it("accepts every pivot and coupling face typed back exactly as the panel shows it", async () => {
    const manifest = await bundleLoader().loadManifest("standard");
    let retyped = 0;
    for (const { name } of manifest.models) {
      const source = await gearSource(name);
      if (source.vehicles.length === 0) continue;
      const store = new MemoryOverrideStore();
      const editor = new RunningGearEditor(store);
      await editor.setModels([source]);
      for (let v = 0; v < source.vehicles.length; v++) {
        editor.select(name, v);
        const shown = editor.snapshot().view;
        if (!shown) throw new Error(`${name} vehicle ${v} has no view`);
        shown.pivots.forEach((pivot, b) => editor.setPivot(b, typed(pivot[0]), typed(pivot[2])));
        for (const coupler of shown.couplers) {
          editor.setCouplerFace(coupler.instance, typed(coupler.face[0]), typed(coupler.face[2]));
          retyped++;
        }
        const after = editor.snapshot().view;
        expect({ name, v, issues: after?.issues }).toEqual({ name, v, issues: [] });
        expect(after?.couplers.map((c) => c.face)).toEqual(shown.couplers.map((c) => c.face));
        expect(after?.pivots).toEqual(shown.pivots);
        await editor.save();
        expect(editor.snapshot().error).toBeNull();
      }
    }
    expect(retyped).toBeGreaterThanOrEqual(10);
  });

  it("reads a version 1 record saved in the model frame as the same gear in the vehicle frame", async () => {
    const source = await gearSource("10133-1");
    const vehicle = source.vehicles[0];
    if (!vehicle) throw new Error("10133-1 has no vehicle");
    const front = frontFace(vehicle);
    const moved: Vec3Tuple = [front.x - 0.5, vehicle.frontCoupler?.face[1] ?? 0, front.z];
    const store = new MemoryOverrideStore();
    await store.save({
      version: 1,
      modelSha256: source.sha256,
      model: "10133-1",
      vehicles: [
        {
          vehicle: 0,
          couplers: [{ instance: front.instance, face: toModelFrame(vehicle, moved) }],
        },
      ],
    });
    const editor = new RunningGearEditor(store);
    await editor.setModels([source]);
    expect(editor.gearSource("10133-1", 0)).toBe("override");
    editor.select("10133-1", 0);
    const face = editor.snapshot().view?.couplers.find((c) => c.instance === front.instance)?.face;
    moved.forEach((value, axis) => expect(face?.[axis]).toBeCloseTo(value, 9));
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
      editor.setCouplerFace(front.instance, front.x - 0.5, front.z);
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

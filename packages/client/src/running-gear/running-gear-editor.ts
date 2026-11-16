import type { BakedVehicle, Vec3Tuple } from "@brr/catalog";
import type { VehicleSpec } from "@brr/sim";
import { inject, injectable } from "inversify";
import { vehicleSpec } from "../sim/consist.ts";
import { RUNNING_GEAR_OVERRIDES } from "../tokens.ts";
import {
  detectedBogies,
  effectiveVehicle,
  RUNNING_GEAR_OVERRIDE_VERSION,
  toModelFrame,
  type BogieOverride,
  type CouplerOverride,
  type RunningGearOverride,
  type VehicleOverride,
} from "./override.ts";
import type { IRunningGearOverrideStore } from "./override-store.ts";

export const BOX_FLOATS = 6;

export interface GearModelSource {
  readonly name: string;
  readonly sha256: string;
  readonly vehicles: ReadonlyArray<BakedVehicle>;
  readonly instanceBoxes: Float32Array;
}

export interface GearBox {
  readonly instance: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly bogie: number | null;
  readonly wheelset: boolean;
  readonly coupler: boolean;
}

export interface GearCoupler {
  readonly instance: number;
  readonly face: Vec3Tuple;
  readonly bogie: number | null;
  readonly obsoleteSources: ReadonlyArray<string>;
}

export interface GearView {
  readonly model: string;
  readonly sha256: string;
  readonly vehicle: number;
  readonly source: "detected" | "override";
  readonly boxes: ReadonlyArray<GearBox>;
  readonly pivots: ReadonlyArray<Vec3Tuple>;
  readonly axles: ReadonlyArray<Vec3Tuple>;
  readonly couplers: ReadonlyArray<GearCoupler>;
  readonly spec: VehicleSpec | null;
  readonly detectedSpec: VehicleSpec;
  readonly issues: ReadonlyArray<string>;
}

export interface GearModelView {
  readonly name: string;
  readonly sha256: string;
  readonly vehicles: number;
  readonly overridden: boolean;
}

export interface GearSnapshot {
  readonly models: ReadonlyArray<GearModelView>;
  readonly selected: { readonly model: string; readonly vehicle: number } | null;
  readonly view: GearView | null;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly error: string | null;
}

export interface IRunningGear {
  subscribe(listener: () => void): () => void;
  snapshot(): GearSnapshot;
  setModels(models: ReadonlyArray<GearModelSource>): Promise<void>;
  effectiveVehicles(model: string): ReadonlyArray<BakedVehicle>;
  select(model: string, vehicle: number): void;
  assignPart(instance: number, bogie: number | null): void;
  setPivot(bogie: number, xLdu: number, zLdu: number): void;
  setCouplerFace(instance: number, xLdu: number, zLdu: number): void;
  addBogie(): void;
  removeBogie(bogie: number): void;
  save(): Promise<void>;
  reset(): Promise<void>;
}

const EMPTY: GearSnapshot = {
  models: [],
  selected: null,
  view: null,
  dirty: false,
  busy: false,
  error: null,
};

function detectedFace(vehicle: BakedVehicle, instance: number): Vec3Tuple | null {
  for (const coupler of [vehicle.frontCoupler, vehicle.rearCoupler]) {
    if (coupler?.instance === instance) return toModelFrame(vehicle, coupler.face);
  }
  return null;
}

function toDetected(vehicle: BakedVehicle, model: Vec3Tuple): Vec3Tuple {
  const cos = Math.cos(vehicle.yawRadians);
  const sin = Math.sin(vehicle.yawRadians);
  const dx = model[0] - vehicle.originXLdu;
  const dz = model[2] - vehicle.originZLdu;
  return [dx * cos + dz * sin, model[1], -dx * sin + dz * cos];
}

@injectable()
export class RunningGearEditor implements IRunningGear {
  private readonly listeners = new Set<() => void>();
  private models: ReadonlyArray<GearModelSource> = [];
  private readonly stored = new Map<string, RunningGearOverride>();
  private selected: { model: string; vehicle: number } | null = null;
  private draft: VehicleOverride | null = null;
  private dirty = false;
  private busy = false;
  private error: string | null = null;
  private current: GearSnapshot = EMPTY;

  constructor(@inject(RUNNING_GEAR_OVERRIDES) private readonly store: IRunningGearOverrideStore) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): GearSnapshot {
    return this.current;
  }

  async setModels(models: ReadonlyArray<GearModelSource>): Promise<void> {
    this.models = models;
    this.stored.clear();
    for (const model of models) {
      const override = await this.store.load(model.sha256);
      if (override) this.stored.set(model.sha256, override);
    }
    this.publish();
  }

  effectiveVehicles(model: string): ReadonlyArray<BakedVehicle> {
    const source = this.source(model);
    if (!source) throw new Error(`model ${model} has no running gear source`);
    const override = this.stored.get(source.sha256);
    return source.vehicles.map((vehicle, v) => {
      const result = effectiveVehicle(
        vehicle,
        override?.vehicles.find((o) => o.vehicle === v),
      );
      return result.vehicle ?? vehicle;
    });
  }

  select(model: string, vehicle: number): void {
    const source = this.source(model);
    if (!source || !source.vehicles[vehicle]) return;
    this.selected = { model, vehicle };
    this.draft = this.storedVehicle(source.sha256, vehicle) ?? null;
    this.dirty = false;
    this.error = null;
    this.publish();
  }

  assignPart(instance: number, bogie: number | null): void {
    this.edit((draft) => {
      const bogies = (draft.bogies ?? []).map((b, i) => ({
        ...b,
        instances:
          i === bogie
            ? [...b.instances.filter((x) => x !== instance), instance]
            : b.instances.filter((x) => x !== instance),
      }));
      return { ...draft, bogies };
    });
  }

  setPivot(bogie: number, xLdu: number, zLdu: number): void {
    this.edit((draft, vehicle) => ({
      ...draft,
      bogies: (draft.bogies ?? []).map((b, i) => {
        if (i !== bogie) return b;
        const y = toDetected(vehicle, b.pivot)[1];
        return { ...b, pivot: toModelFrame(vehicle, [xLdu, y, zLdu]) };
      }),
    }));
  }

  setCouplerFace(instance: number, xLdu: number, zLdu: number): void {
    this.edit((draft, vehicle) => {
      const existing = draft.couplers?.find((c) => c.instance === instance)?.face;
      const base = existing ?? detectedFace(vehicle, instance);
      if (!base) return draft;
      const y = toDetected(vehicle, base)[1];
      const others = (draft.couplers ?? []).filter((c) => c.instance !== instance);
      const moved: CouplerOverride = { instance, face: toModelFrame(vehicle, [xLdu, y, zLdu]) };
      return { ...draft, couplers: [...others, moved] };
    });
  }

  addBogie(): void {
    this.edit((draft, vehicle) => {
      const bogie: BogieOverride = { instances: [], pivot: toModelFrame(vehicle, [0, 0, 0]) };
      return { ...draft, bogies: [...(draft.bogies ?? []), bogie] };
    });
  }

  removeBogie(bogie: number): void {
    this.edit((draft) => ({
      ...draft,
      bogies: (draft.bogies ?? []).filter((_, i) => i !== bogie),
    }));
  }

  async save(): Promise<void> {
    const source = this.selectedSource();
    const selected = this.selected;
    if (!source || !selected || !this.draft) return;
    const previous = this.stored.get(source.sha256);
    const others = (previous?.vehicles ?? []).filter((v) => v.vehicle !== selected.vehicle);
    const override: RunningGearOverride = {
      version: RUNNING_GEAR_OVERRIDE_VERSION,
      modelSha256: source.sha256,
      model: source.name,
      vehicles: [...others, this.draft].toSorted((a, b) => a.vehicle - b.vehicle),
    };
    await this.persist(async () => {
      await this.store.save(override);
      this.stored.set(source.sha256, override);
      this.dirty = false;
    });
  }

  async reset(): Promise<void> {
    const source = this.selectedSource();
    if (!source) return;
    await this.persist(async () => {
      await this.store.remove(source.sha256);
      this.stored.delete(source.sha256);
      this.draft = null;
      this.dirty = false;
    });
  }

  private async persist(work: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.error = null;
    this.publish();
    try {
      await work();
    } catch (e) {
      this.error = String(e);
    } finally {
      this.busy = false;
      this.publish();
    }
  }

  private source(model: string): GearModelSource | undefined {
    return this.models.find((m) => m.name === model);
  }

  private selectedSource(): GearModelSource | undefined {
    return this.selected ? this.source(this.selected.model) : undefined;
  }

  private storedVehicle(sha256: string, vehicle: number): VehicleOverride | undefined {
    return this.stored.get(sha256)?.vehicles.find((v) => v.vehicle === vehicle);
  }

  private edit(change: (draft: VehicleOverride, vehicle: BakedVehicle) => VehicleOverride): void {
    const source = this.selectedSource();
    const selected = this.selected;
    const vehicle = selected ? source?.vehicles[selected.vehicle] : undefined;
    if (!vehicle || !selected) return;
    const draft: VehicleOverride = this.draft ?? {
      vehicle: selected.vehicle,
      bogies: detectedBogies(vehicle),
      couplers: [],
    };
    this.draft = change({ ...draft, bogies: draft.bogies ?? detectedBogies(vehicle) }, vehicle);
    this.dirty = true;
    this.publish();
  }

  private publish(): void {
    this.current = {
      models: this.models.map((m) => ({
        name: m.name,
        sha256: m.sha256,
        vehicles: m.vehicles.length,
        overridden: this.stored.has(m.sha256),
      })),
      selected: this.selected,
      view: this.view(),
      dirty: this.dirty,
      busy: this.busy,
      error: this.error,
    };
    for (const listener of this.listeners) listener();
  }

  private view(): GearView | null {
    const source = this.selectedSource();
    const selected = this.selected;
    const detected = selected ? source?.vehicles[selected.vehicle] : undefined;
    if (!source || !selected || !detected) return null;
    const result = effectiveVehicle(detected, this.draft ?? undefined);
    const shown = result.vehicle ?? detected;
    const local = (p: Vec3Tuple): Vec3Tuple => toDetected(detected, toModelFrame(shown, p));
    const owner = new Map<number, number>();
    shown.bogies.forEach((bogie, b) => {
      for (const instance of bogie.instances) owner.set(instance, b);
    });
    const wheelsets = new Set(detected.wheelsets.map((w) => w.instance));
    const couplerInstances = new Set(
      [detected.frontCoupler, detected.rearCoupler].flatMap((c) => (c ? [c.instance] : [])),
    );
    const members = [...detected.body, ...detected.bogies.flatMap((b) => [...b.instances])];
    const boxes = members.map((instance) =>
      this.box(source, detected, instance, owner, wheelsets, couplerInstances),
    );
    let spec: VehicleSpec | null = null;
    const issues = [...result.issues];
    if (result.vehicle) {
      try {
        spec = vehicleSpec(result.vehicle, false);
      } catch (e) {
        issues.push(String(e));
      }
    }
    return {
      model: source.name,
      sha256: source.sha256,
      vehicle: selected.vehicle,
      source: this.draft ? "override" : "detected",
      boxes,
      pivots: shown.bogies.map((bogie) => local(bogie.pivot)),
      axles: [...shown.bogies.flatMap((bogie) => bogie.axles), ...shown.fixedAxles].map(local),
      couplers: [shown.frontCoupler, shown.rearCoupler].flatMap((c) =>
        c
          ? [
              {
                instance: c.instance,
                face: local(c.face),
                bogie: c.bogie,
                obsoleteSources: c.obsoleteSources,
              },
            ]
          : [],
      ),
      spec,
      detectedSpec: vehicleSpec(detected, false),
      issues,
    };
  }

  private box(
    source: GearModelSource,
    detected: BakedVehicle,
    instance: number,
    owner: ReadonlyMap<number, number>,
    wheelsets: ReadonlySet<number>,
    couplers: ReadonlySet<number>,
  ): GearBox {
    const b = source.instanceBoxes;
    const o = instance * BOX_FLOATS;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (const x of [b[o] ?? 0, b[o + 3] ?? 0]) {
      for (const z of [b[o + 2] ?? 0, b[o + 5] ?? 0]) {
        const p = toDetected(detected, [x, 0, z]);
        minX = Math.min(minX, p[0]);
        maxX = Math.max(maxX, p[0]);
        minZ = Math.min(minZ, p[2]);
        maxZ = Math.max(maxZ, p[2]);
      }
    }
    return {
      instance,
      minX,
      maxX,
      minY: b[o + 1] ?? 0,
      maxY: b[o + 4] ?? 0,
      minZ,
      maxZ,
      bogie: owner.get(instance) ?? null,
      wheelset: wheelsets.has(instance),
      coupler: couplers.has(instance),
    };
  }
}

import type { PartModel, PartShapeAsset } from "@brr/catalog";
import type { VehicleSpec } from "@brr/sim";
import type {
  ConnectorRef,
  ModelRunningGear,
  ModelVehicle,
  UnreadRollingBands,
  UnresolvedRunningGear,
  Vec3,
} from "@brr/schema/bundle";
import { injectable } from "inversify";
import { plannedConsist } from "../sim/consist.ts";
import { BOX_FLOATS } from "../edit/local-box.ts";
import { instanceBoxes } from "./instance-boxes.ts";
import { toVehicleFrame } from "./vehicle-frame.ts";
import { isPlayable, unreadSummary, type UnreadSummary } from "./running-gear-summary.ts";

export interface GearModelSource {
  readonly name: string;
  readonly sha256: string;
  readonly runningGear: ModelRunningGear;
  readonly instanceBoxes: Float64Array;
  readonly unread: UnreadSummary;
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
  readonly endCandidate: boolean;
}

export type AxisLine = readonly [Vec3, Vec3];

export interface GearView {
  readonly sha256: string;
  readonly vehicle: number;
  readonly boxes: ReadonlyArray<GearBox>;
  readonly pivots: ReadonlyArray<Vec3>;
  readonly axisLines: ReadonlyArray<AxisLine>;
  readonly frontEndCandidates: ReadonlyArray<ConnectorRef>;
  readonly rearEndCandidates: ReadonlyArray<ConnectorRef>;
  readonly spec: VehicleSpec;
}

export interface GearModelView {
  readonly name: string;
  readonly sha256: string;
  readonly vehicles: number;
  readonly playable: boolean;
  readonly unresolved: ReadonlyArray<UnresolvedRunningGear>;
  readonly unread: UnreadSummary;
  readonly unreadRollingBands: UnreadRollingBands;
}

export interface GearSelection {
  readonly model: string;
  readonly vehicle: number;
}

export interface GearSnapshot {
  readonly models: ReadonlyArray<GearModelView>;
  readonly selected: GearSelection | null;
  readonly view: GearView | null;
}

export interface IRunningGear {
  subscribe(listener: () => void): () => void;
  snapshot(): GearSnapshot;
  setModels(models: ReadonlyArray<GearModelSource>): void;
  select(model: string, vehicle: number): void;
}

const EMPTY: GearSnapshot = { models: [], selected: null, view: null };

export function gearModelSource(
  name: string,
  sha256: string,
  model: Omit<PartModel, "studCover">,
  bundle: { readonly parts: ReadonlyArray<PartShapeAsset> },
): GearModelSource {
  const { runningGear } = model;
  return {
    name,
    sha256,
    runningGear,
    instanceBoxes: instanceBoxes(model, bundle),
    unread: unreadSummary(runningGear),
  };
}

function modelView(source: GearModelSource): GearModelView {
  const { runningGear } = source;
  return {
    name: source.name,
    sha256: source.sha256,
    vehicles: runningGear.vehicles.length,
    playable: isPlayable(runningGear),
    unresolved: runningGear.unresolvedRunningGear,
    unread: source.unread,
    unreadRollingBands: runningGear.unreadRollingBands,
  };
}

function box(
  boxes: Float64Array,
  vehicle: ModelVehicle,
  instance: number,
  marks: Pick<GearBox, "bogie" | "wheelset" | "endCandidate">,
): GearBox {
  const o = instance * BOX_FLOATS;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const x of [boxes[o] ?? 0, boxes[o + 3] ?? 0]) {
    for (const z of [boxes[o + 2] ?? 0, boxes[o + 5] ?? 0]) {
      const p = toVehicleFrame(vehicle, [x, 0, z]);
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
    minY: boxes[o + 1] ?? 0,
    maxY: boxes[o + 4] ?? 0,
    minZ,
    maxZ,
    ...marks,
  };
}

function plannedSpec(source: GearModelSource, index: number): VehicleSpec {
  const planned = plannedConsist(source.runningGear, source.instanceBoxes, false).find(
    (candidate) => candidate.vehicle === index,
  );
  if (!planned) throw new Error(`${source.name} plans no vehicle ${index}`);
  return planned.spec;
}

function gearView(source: GearModelSource, index: number, vehicle: ModelVehicle): GearView {
  const owner = new Map<number, number>();
  vehicle.bogies.forEach((bogie, b) => {
    for (const instance of bogie.instances) owner.set(instance, b);
  });
  const wheelsets = new Set(
    vehicle.wheelsets.flatMap((wheelset) => wheelset.members.map((member) => member.instance)),
  );
  const ends = new Set(
    [...vehicle.frontEndCandidates, ...vehicle.rearEndCandidates].map((end) => end.instance),
  );
  const members = [...vehicle.body, ...vehicle.bogies.flatMap((bogie) => [...bogie.instances])];
  return {
    sha256: source.sha256,
    vehicle: index,
    boxes: members.map((instance) =>
      box(source.instanceBoxes, vehicle, instance, {
        bogie: owner.get(instance) ?? null,
        wheelset: wheelsets.has(instance),
        endCandidate: ends.has(instance),
      }),
    ),
    pivots: vehicle.bogies.map((bogie) => toVehicleFrame(vehicle, bogie.pivot)),
    axisLines: vehicle.wheelsets.map(({ axisLine: [near, far] }): AxisLine => [
      toVehicleFrame(vehicle, near),
      toVehicleFrame(vehicle, far),
    ]),
    frontEndCandidates: vehicle.frontEndCandidates,
    rearEndCandidates: vehicle.rearEndCandidates,
    spec: plannedSpec(source, index),
  };
}

@injectable()
export class RunningGearInspector implements IRunningGear {
  private readonly listeners = new Set<() => void>();
  private models: ReadonlyArray<GearModelSource> = [];
  private selected: GearSelection | null = null;
  private current: GearSnapshot = EMPTY;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): GearSnapshot {
    return this.current;
  }

  setModels(models: ReadonlyArray<GearModelSource>): void {
    this.models = models;
    if (this.selected && !this.vehicleOf(this.selected)) this.selected = null;
    this.publish();
  }

  select(model: string, vehicle: number): void {
    const selection = { model, vehicle };
    if (!this.vehicleOf(selection)) return;
    this.selected = selection;
    this.publish();
  }

  private vehicleOf(selection: GearSelection): ModelVehicle | undefined {
    return this.source(selection.model)?.runningGear.vehicles[selection.vehicle];
  }

  private source(model: string): GearModelSource | undefined {
    return this.models.find((source) => source.name === model);
  }

  private publish(): void {
    const selected = this.selected;
    const source = selected ? this.source(selected.model) : undefined;
    const vehicle = selected ? this.vehicleOf(selected) : undefined;
    this.current = {
      models: this.models.map(modelView),
      selected,
      view: selected && source && vehicle ? gearView(source, selected.vehicle, vehicle) : null,
    };
    for (const listener of this.listeners) listener();
  }
}

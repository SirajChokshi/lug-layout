import type { Vec3Tuple } from "./part-bundle.ts";

export type VehicleGuideKind = "bogiePivot" | "fixedAxle";

export interface VehicleCoupler {
  readonly instance: number;
  readonly face: Vec3Tuple;
  readonly bogie: number | null;
  readonly obsoleteSources: ReadonlyArray<string>;
}

export interface VehicleBogie {
  readonly instances: Uint32Array;
  readonly pivot: Vec3Tuple;
  readonly axles: ReadonlyArray<Vec3Tuple>;
}

export interface VehicleWheelset {
  readonly instance: number;
  readonly centre: Vec3Tuple;
}

export interface VehicleRailContact {
  readonly railPart: string;
  readonly railTopY: number;
  readonly spreadLdu: number;
}

export interface BakedVehicle {
  readonly originXLdu: number;
  readonly originZLdu: number;
  readonly yawRadians: number;
  readonly guideKind: VehicleGuideKind;
  readonly frontGuideLdu: number;
  readonly rearGuideLdu: number;
  readonly body: Uint32Array;
  readonly bogies: ReadonlyArray<VehicleBogie>;
  readonly fixedAxles: ReadonlyArray<Vec3Tuple>;
  readonly wheelsets: ReadonlyArray<VehicleWheelset>;
  readonly frontCoupler: VehicleCoupler | null;
  readonly rearCoupler: VehicleCoupler | null;
  readonly railContacts: ReadonlyArray<VehicleRailContact>;
}

const GUIDE_KINDS: ReadonlyArray<VehicleGuideKind> = ["bogiePivot", "fixedAxle"];

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function list(value: unknown, label: string): ReadonlyArray<unknown> {
  if (!Array.isArray(value)) throw new Error(`${label}: expected an array`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label}: expected a finite number`);
  }
  return value;
}

function vec3(value: unknown, label: string): Vec3Tuple {
  const items = list(value, label);
  if (items.length !== 3) throw new Error(`${label}: expected 3 numbers`);
  return [finite(items[0], label), finite(items[1], label), finite(items[2], label)];
}

function instanceList(value: unknown, label: string, instanceCount: number): Uint32Array {
  return Uint32Array.from(list(value, label), (item) => instanceIndex(item, label, instanceCount));
}

function instanceIndex(value: unknown, label: string, instanceCount: number): number {
  const index = finite(value, label);
  if (!Number.isInteger(index) || index < 0 || index >= instanceCount) {
    throw new Error(`${label}: ${index} is not an instance of this model`);
  }
  return index;
}

function parseCoupler(
  value: unknown,
  label: string,
  instanceCount: number,
  bogieCount: number,
): VehicleCoupler | null {
  if (value === null) return null;
  const raw = record(value, label);
  const bogie = raw["bogie"];
  if (
    bogie !== null &&
    (!Number.isInteger(bogie) || Number(bogie) < 0 || Number(bogie) >= bogieCount)
  ) {
    throw new Error(`${label}.bogie: ${String(bogie)} is not a bogie of this vehicle`);
  }
  return {
    instance: instanceIndex(raw["instance"], `${label}.instance`, instanceCount),
    face: vec3(raw["face"], `${label}.face`),
    bogie: bogie === null ? null : Number(bogie),
    obsoleteSources: stringList(raw["obsoleteSources"], `${label}.obsoleteSources`),
  };
}

function stringList(value: unknown, label: string): ReadonlyArray<string> {
  return list(value, label).map((item, i) => {
    if (typeof item !== "string") throw new Error(`${label}[${i}]: expected a string`);
    return item;
  });
}

function guideKind(value: unknown, label: string): VehicleGuideKind {
  const match = GUIDE_KINDS.find((kind) => kind === value);
  if (match === undefined) throw new Error(`${label}: ${String(value)} is not a guide kind`);
  return match;
}

export function parseBakedVehicle(
  value: unknown,
  label: string,
  instanceCount: number,
): BakedVehicle {
  const raw = record(value, label);
  const origin = list(raw["origin"], `${label}.origin`);
  const guides = list(raw["guides"], `${label}.guides`);
  const bogies = list(raw["bogies"], `${label}.bogies`).map((bogie, b) => {
    const entry = record(bogie, `${label}.bogies[${b}]`);
    return {
      instances: instanceList(entry["instances"], `${label}.bogies[${b}].instances`, instanceCount),
      pivot: vec3(entry["pivot"], `${label}.bogies[${b}].pivot`),
      axles: list(entry["axles"], `${label}.bogies[${b}].axles`).map((axle, a) =>
        vec3(axle, `${label}.bogies[${b}].axles[${a}]`),
      ),
    };
  });
  return {
    originXLdu: finite(origin[0], `${label}.origin[0]`),
    originZLdu: finite(origin[1], `${label}.origin[1]`),
    yawRadians: finite(raw["yaw"], `${label}.yaw`),
    guideKind: guideKind(raw["guideKind"], `${label}.guideKind`),
    frontGuideLdu: finite(guides[0], `${label}.guides[0]`),
    rearGuideLdu: finite(guides[1], `${label}.guides[1]`),
    body: instanceList(raw["body"], `${label}.body`, instanceCount),
    bogies,
    fixedAxles: list(raw["fixedAxles"], `${label}.fixedAxles`).map((axle, a) =>
      vec3(axle, `${label}.fixedAxles[${a}]`),
    ),
    wheelsets: list(raw["wheelsets"], `${label}.wheelsets`).map((wheelset, w) => {
      const entry = record(wheelset, `${label}.wheelsets[${w}]`);
      return {
        instance: instanceIndex(
          entry["instance"],
          `${label}.wheelsets[${w}].instance`,
          instanceCount,
        ),
        centre: vec3(entry["centre"], `${label}.wheelsets[${w}].centre`),
      };
    }),
    frontCoupler: parseCoupler(
      raw["frontCoupler"],
      `${label}.frontCoupler`,
      instanceCount,
      bogies.length,
    ),
    rearCoupler: parseCoupler(
      raw["rearCoupler"],
      `${label}.rearCoupler`,
      instanceCount,
      bogies.length,
    ),
    railContacts: list(raw["railContacts"], `${label}.railContacts`).map((contact, c) => {
      const entry = record(contact, `${label}.railContacts[${c}]`);
      const railPart = entry["railPart"];
      if (typeof railPart !== "string") {
        throw new Error(`${label}.railContacts[${c}].railPart: expected a string`);
      }
      return {
        railPart,
        railTopY: finite(entry["railTopY"], `${label}.railContacts[${c}].railTopY`),
        spreadLdu: finite(entry["spreadLdu"], `${label}.railContacts[${c}].spreadLdu`),
      };
    }),
  };
}

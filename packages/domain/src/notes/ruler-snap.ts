import { STUD_LDU, planeHypot } from "@brr/math";
import type { PlacementRecordV1, RulerEndV2 } from "@brr/schema/world";
import { modelEnd } from "./note-state.ts";

export interface SnapModel {
  readonly placement: PlacementRecordV1;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly under: boolean;
}

export type RulerSnapKind = "corner" | "edge" | "centre" | "stud" | "point";

export interface RulerSnap {
  readonly end: RulerEndV2;
  readonly x: number;
  readonly z: number;
  readonly kind: RulerSnapKind;
  readonly model: number;
}

export const NO_SNAP_MODEL = -1;

interface Feature {
  readonly x: number;
  readonly z: number;
  readonly kind: RulerSnapKind;
}

function onStud(ldu: number): number {
  return Math.round(ldu / STUD_LDU) * STUD_LDU + 0;
}

function boxFeatures(model: SnapModel): ReadonlyArray<Feature> {
  const { minX, minZ, maxX, maxZ } = model;
  const midX = (minX + maxX) / 2;
  const midZ = (minZ + maxZ) / 2;
  return [
    { x: minX, z: minZ, kind: "corner" },
    { x: maxX, z: minZ, kind: "corner" },
    { x: maxX, z: maxZ, kind: "corner" },
    { x: minX, z: maxZ, kind: "corner" },
    { x: midX, z: minZ, kind: "edge" },
    { x: maxX, z: midZ, kind: "edge" },
    { x: midX, z: maxZ, kind: "edge" },
    { x: minX, z: midZ, kind: "edge" },
    { x: midX, z: midZ, kind: "centre" },
  ];
}

function exactLdu(feature: Feature): boolean {
  return Number.isSafeInteger(feature.x) && Number.isSafeInteger(feature.z);
}

function attached(models: ReadonlyArray<SnapModel>, model: number, x: number, z: number) {
  const placement = models[model]?.placement;
  if (!placement) throw new Error(`no snap model ${model}`);
  return modelEnd(placement, { x, z });
}

export function snapRulerEnd(
  x: number,
  z: number,
  reach: number,
  models: ReadonlyArray<SnapModel>,
): RulerSnap {
  let best: RulerSnap | null = null;
  let bestDistance = reach;
  for (let m = 0; m < models.length; m++) {
    const model = models[m];
    if (!model) continue;
    for (const feature of boxFeatures(model)) {
      if (!exactLdu(feature)) continue;
      const distance = planeHypot(feature.x - x, feature.z - z);
      if (distance > bestDistance || (best !== null && distance === bestDistance)) continue;
      bestDistance = distance;
      best = {
        end: attached(models, m, feature.x, feature.z),
        x: feature.x,
        z: feature.z,
        kind: feature.kind,
        model: m,
      };
    }
  }
  if (best) return best;
  const studX = onStud(x);
  const studZ = onStud(z);
  const under = models.findIndex((model) => model.under);
  if (under !== NO_SNAP_MODEL) {
    return {
      end: attached(models, under, studX, studZ),
      x: studX,
      z: studZ,
      kind: "stud",
      model: under,
    };
  }
  return {
    end: { on: "point", x: studX, z: studZ },
    x: studX,
    z: studZ,
    kind: "point",
    model: NO_SNAP_MODEL,
  };
}

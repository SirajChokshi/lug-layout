import { CHUNK_LDU, isLatticePose } from "@brr/math";
import * as v from "valibot";
import { SafeInteger, strictMessage } from "./fields.ts";

const Millimetres = v.pipe(v.number(), v.finite("must be a finite number of mm"));

const OriginChunk = v.config(
  v.pipe(
    SafeInteger,
    v.check(
      (chunk) => isLatticePose(chunk * CHUNK_LDU, 0, 0),
      "puts the plan origin outside the int32 LDU range",
    ),
  ),
  { abortPipeEarly: true },
);

export const PlanRectV1 = v.strictObject(
  { x: Millimetres, z: Millimetres, width: Millimetres, depth: Millimetres },
  strictMessage,
);

export const PlanTableV1 = v.strictObject(
  { name: v.string(), rect: PlanRectV1, heightMm: Millimetres },
  strictMessage,
);

export const PlanObstacleV1 = v.strictObject({ name: v.string(), rect: PlanRectV1 }, strictMessage);

export const PlanFootprintV1 = v.strictObject(
  {
    roomWidthMm: Millimetres,
    roomDepthMm: Millimetres,
    tables: v.array(PlanTableV1),
    obstacles: v.array(PlanObstacleV1),
  },
  strictMessage,
);

export const PlanRecordV1 = v.strictObject(
  {
    name: v.string(),
    originChunkX: OriginChunk,
    originChunkZ: OriginChunk,
    maxOverhangMm: Millimetres,
    maxReachMm: Millimetres,
    footprint: PlanFootprintV1,
  },
  strictMessage,
);
export type PlanRecordV1 = v.InferOutput<typeof PlanRecordV1>;

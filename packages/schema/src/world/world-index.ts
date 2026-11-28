import * as v from "valibot";
import { Count, FiniteNumber, WorldName, strictMessage } from "./fields.ts";

export const WorldIndexEntry = v.strictObject(
  {
    id: v.pipe(v.string(), v.minLength(1, "is empty")),
    name: v.string(),
    placements: Count,
    track: Count,
    shards: Count,
    savedAt: FiniteNumber,
  },
  strictMessage,
);
export type WorldIndexEntry = v.InferOutput<typeof WorldIndexEntry>;

export const WorldVersionEntry = v.strictObject(
  {
    version: Count,
    name: WorldName,
    placements: Count,
    track: Count,
    savedAt: FiniteNumber,
  },
  strictMessage,
);
export type WorldVersionEntry = v.InferOutput<typeof WorldVersionEntry>;

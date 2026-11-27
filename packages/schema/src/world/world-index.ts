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

export const KIT_LIBRARIES = ["personal", "club"] as const;
export type KitLibrary = (typeof KIT_LIBRARIES)[number];

export const KitIndexEntry = v.strictObject(
  {
    id: v.pipe(v.string(), v.minLength(1, "is empty")),
    name: WorldName,
    library: v.picklist(KIT_LIBRARIES),
    placements: Count,
    track: Count,
  },
  strictMessage,
);
export type KitIndexEntry = v.InferOutput<typeof KitIndexEntry>;

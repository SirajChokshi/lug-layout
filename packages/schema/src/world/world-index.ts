import * as v from "valibot";
import { Count, FiniteNumber, strictMessage } from "./fields.ts";

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

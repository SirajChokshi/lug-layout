import { PartExtras } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import * as v from "valibot";

const GLB_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const VEC3_FLOATS = 3;
const ROUND = 0;
const MALE = 0;

const Finite = v.pipe(v.number(), v.finite());

const AXIS_CODE = v.pipe(v.number(), v.integer(), v.minValue(-1), v.maxValue(5));

const ConnectorTable = v.pipe(
  v.object({
    profile: v.array(v.picklist([0, 1])),
    gender: v.array(v.picklist([0, 1])),
    radius: v.array(Finite),
    origin: v.array(Finite),
    axis: v.union([v.array(AXIS_CODE), v.array(Finite)]),
    axisFree: v.optional(v.array(Finite)),
    reach: v.array(Finite),
    source: v.optional(v.array(v.union([v.string(), v.number()]))),
  }),
  v.check(
    ({ profile, gender, radius, origin, axis, reach, source }) =>
      [gender, radius, reach, ...(source ? [source] : [])].every(
        (column) => column.length === profile.length,
      ) &&
      origin.length === profile.length * VEC3_FLOATS &&
      (axis.length === profile.length || axis.length === profile.length * VEC3_FLOATS),
    "the connector columns do not have one entry per connector",
  ),
);
type ConnectorTable = v.InferOutput<typeof ConnectorTable>;

export type ConnectorFamily =
  | "male round"
  | "female round"
  | "male cross"
  | "female cross"
  | "stud record"
  | "technic hole record"
  | "technic shaft record";

export interface PartConnectors {
  readonly title: string;
  readonly source: "connector table" | "pre-engine records" | "unreadable connector table";
  readonly counts: ReadonlyMap<ConnectorFamily, number>;
  readonly tiers: ReadonlyMap<string, number>;
  readonly total: number;
  readonly problem: string | null;
}

function glbJson(glb: Uint8Array, label: string): unknown {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (glb.byteLength < GLB_HEADER_BYTES + CHUNK_HEADER_BYTES)
    throw new Error(`${label}: not a GLB`);
  const length = view.getUint32(GLB_HEADER_BYTES, true);
  const start = GLB_HEADER_BYTES + CHUNK_HEADER_BYTES;
  return JSON.parse(new TextDecoder().decode(glb.subarray(start, start + length)));
}

function rawConnectors(document: unknown): unknown {
  if (typeof document !== "object" || document === null) return undefined;
  const extras: unknown = Reflect.get(document, "extras");
  if (typeof extras !== "object" || extras === null) return undefined;
  return Reflect.get(extras, "connectors");
}

function familyOf(table: ConnectorTable, index: number): ConnectorFamily {
  const male = table.gender[index] === MALE;
  if (table.profile[index] === ROUND) return male ? "male round" : "female round";
  return male ? "male cross" : "female cross";
}

function counted(
  entries: ReadonlyArray<readonly [ConnectorFamily, number]>,
): PartConnectors["counts"] {
  return new Map(entries.filter(([, count]) => count > 0));
}

function summary(
  title: string,
  source: PartConnectors["source"],
  counts: PartConnectors["counts"],
  problem: string | null,
  tiers: PartConnectors["tiers"] = new Map(),
): PartConnectors {
  let total = 0;
  for (const count of counts.values()) total += count;
  return { title, source, counts, tiers, total, problem };
}

function decodedExtras(document: unknown, label: string): PartExtras {
  const extras: unknown =
    typeof document === "object" && document !== null ? Reflect.get(document, "extras") : null;
  return decodedOrThrow(decode(PartExtras, extras), `${label} extras`);
}

export function partExtras(glb: Uint8Array, label: string): PartExtras {
  return decodedExtras(glbJson(glb, label), label);
}

export function partConnectors(glb: Uint8Array, label: string): PartConnectors {
  const document = glbJson(glb, label);
  const extras = decodedExtras(document, label);
  const title = extras.ldraw.title;
  const table = rawConnectors(document);
  if (table !== undefined) {
    const decoded = decode(ConnectorTable, table);
    if (!decoded.ok) {
      return summary(
        title,
        "unreadable connector table",
        new Map(),
        decoded.issues[0]?.message ?? "",
      );
    }
    const tally = new Map<ConnectorFamily, number>();
    const tiers = new Map<string, number>();
    for (let i = 0; i < decoded.value.profile.length; i++) {
      const family = familyOf(decoded.value, i);
      tally.set(family, (tally.get(family) ?? 0) + 1);
      const tier = decoded.value.source?.[i];
      if (tier !== undefined) tiers.set(String(tier), (tiers.get(String(tier)) ?? 0) + 1);
    }
    return summary(title, "connector table", tally, null, tiers);
  }
  return summary(
    title,
    "pre-engine records",
    counted([
      ["stud record", extras.studs.length],
      ["technic hole record", extras.technic?.holes.length ?? 0],
      ["technic shaft record", extras.technic?.shaft ? 1 : 0],
    ]),
    null,
  );
}

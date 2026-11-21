import { CHUNK_LDU, isLatticePose } from "@brr/math";
import * as v from "valibot";
import { decode, type Decoded, type Issue } from "../decode/index.ts";
import {
  CREDITS_FILE,
  Count,
  MANIFEST_FILE,
  SafeInteger,
  ShardListV1,
  canonicalJson,
  compareSuperChunks,
  manifestJson,
  readShardFiles,
  shardPath,
  strictMessage,
  unexpectedFiles,
  type ArchiveText,
  type ImportedFile,
  type ShardEntryV1,
  type WorldShardV1,
} from "../world/index.ts";

export const PLAN_FORMAT = "brr.plan";
export const PLAN_SCHEMA_VERSION = 1;
export const PLAN_SHEET_FILE = "plan.svg";
export const PARTS_CSV_FILE = "parts.csv";
export const BRICKLINK_XML_FILE = "bricklink.xml";
export const REBRICKABLE_CSV_FILE = "rebrickable.csv";
export const PLAN_OUTPUT_FILES = [
  PLAN_SHEET_FILE,
  PARTS_CSV_FILE,
  BRICKLINK_XML_FILE,
  REBRICKABLE_CSV_FILE,
] as const;
export type PlanOutputFile = (typeof PLAN_OUTPUT_FILES)[number];
export type PlanOutputs = Readonly<Record<PlanOutputFile, string>>;

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

const PlanFormat = v.literal(PLAN_FORMAT, (issue) =>
  typeof issue.input === "string"
    ? `is "${issue.input}", not "${PLAN_FORMAT}": this isn't a Brick Railroad plan file this app reads`
    : `must be "${PLAN_FORMAT}"`,
);

function versionMessage(input: unknown): string {
  if (typeof input !== "number") return `must be ${PLAN_SCHEMA_VERSION}`;
  if (input > PLAN_SCHEMA_VERSION) {
    return `is ${input}, newer than plan schema ${PLAN_SCHEMA_VERSION}, the newest this app reads; open it in a newer version of the app`;
  }
  return `is ${input}, older than plan schema ${PLAN_SCHEMA_VERSION}, the only one this app reads`;
}

const PlanSchemaVersion = v.literal(PLAN_SCHEMA_VERSION, (issue) => versionMessage(issue.input));

const PlanFormatField = v.looseObject({ format: PlanFormat });
const PlanVersionField = v.looseObject({ schemaVersion: PlanSchemaVersion });

const PlanManifestFields = v.strictObject(
  {
    format: PlanFormat,
    schemaVersion: PlanSchemaVersion,
    bundleVersion: v.string(),
    plan: PlanRecordV1,
    placements: Count,
    track: Count,
    shards: ShardListV1,
    credits: v.literal(CREDITS_FILE, `must be "${CREDITS_FILE}"`),
    outputs: v.strictTuple(
      [
        v.literal(PLAN_SHEET_FILE),
        v.literal(PARTS_CSV_FILE),
        v.literal(BRICKLINK_XML_FILE),
        v.literal(REBRICKABLE_CSV_FILE),
      ],
      `must be ${PLAN_OUTPUT_FILES.join(", ")}`,
    ),
    disclaimer: v.pipe(v.string(), v.minLength(1, "is empty")),
  },
  strictMessage,
);

export const PlanManifestV1 = v.pipe(
  PlanManifestFields,
  v.forward(
    v.partialCheck(
      [["placements"], ["shards"]],
      (manifest) =>
        manifest.placements === manifest.shards.reduce((sum, entry) => sum + entry.placements, 0),
      "must equal the sum of the shards' placements",
    ),
    ["placements"],
  ),
  v.forward(
    v.partialCheck(
      [["track"], ["shards"]],
      (manifest) => manifest.track === manifest.shards.reduce((sum, entry) => sum + entry.track, 0),
      "must equal the sum of the shards' track pieces",
    ),
    ["track"],
  ),
);
export type PlanManifestV1 = v.InferOutput<typeof PlanManifestV1>;

export interface PlanHeader {
  readonly bundleVersion: string;
  readonly plan: PlanRecordV1;
  readonly disclaimer: string;
}

export interface PlanFiles {
  readonly manifest: PlanManifestV1;
  readonly shards: ReadonlyArray<WorldShardV1>;
  readonly credits: string;
  readonly outputs: PlanOutputs;
}

export type PlanArchive = PlanFiles & {
  readonly imports: ReadonlyArray<ImportedFile>;
};

export function planManifest(
  header: PlanHeader,
  shards: ReadonlyArray<ShardEntryV1>,
): PlanManifestV1 {
  const entries = [...shards];
  entries.sort((a, b) => compareSuperChunks(a.superChunk, b.superChunk));
  return {
    format: PLAN_FORMAT,
    schemaVersion: PLAN_SCHEMA_VERSION,
    bundleVersion: header.bundleVersion,
    plan: header.plan,
    placements: entries.reduce((sum, entry) => sum + entry.placements, 0),
    track: entries.reduce((sum, entry) => sum + entry.track, 0),
    shards: entries,
    credits: CREDITS_FILE,
    outputs: [...PLAN_OUTPUT_FILES],
    disclaimer: header.disclaimer,
  };
}

export function planArchiveFiles(archive: PlanFiles): ArchiveText[] {
  const shards = [...archive.shards];
  shards.sort((a, b) => compareSuperChunks(a.superChunk, b.superChunk));
  return [
    { name: MANIFEST_FILE, text: canonicalJson(archive.manifest) },
    ...shards.map((shard) => ({ name: shardPath(shard.superChunk), text: canonicalJson(shard) })),
    { name: CREDITS_FILE, text: archive.credits },
    ...PLAN_OUTPUT_FILES.map((name) => ({ name, text: archive.outputs[name] })),
  ];
}

function readOutputs(files: ReadonlyMap<string, string>, issues: Issue[]): PlanOutputs | null {
  const read = (name: PlanOutputFile): string => {
    const text = files.get(name);
    if (text === undefined) issues.push({ path: name, message: "is missing" });
    return text ?? "";
  };
  const outputs = {
    [PLAN_SHEET_FILE]: read(PLAN_SHEET_FILE),
    [PARTS_CSV_FILE]: read(PARTS_CSV_FILE),
    [BRICKLINK_XML_FILE]: read(BRICKLINK_XML_FILE),
    [REBRICKABLE_CSV_FILE]: read(REBRICKABLE_CSV_FILE),
  };
  return PLAN_OUTPUT_FILES.every((name) => files.has(name)) ? outputs : null;
}

export function readPlanFiles(files: ReadonlyMap<string, string>): Decoded<PlanFiles> {
  const json = manifestJson(files);
  if (!json.ok) return json;
  const format = decode(PlanFormatField, json.value, MANIFEST_FILE);
  if (!format.ok) return format;
  const version = decode(PlanVersionField, json.value, MANIFEST_FILE);
  if (!version.ok) return version;
  const manifest = decode(PlanManifestV1, json.value, MANIFEST_FILE);
  if (!manifest.ok) return manifest;
  const read = readShardFiles(files, manifest.value.shards);
  const credits = files.get(CREDITS_FILE);
  const issues: Issue[] = [
    ...read.issues,
    ...(credits === undefined ? [{ path: CREDITS_FILE, message: "is missing" }] : []),
  ];
  const outputs = readOutputs(files, issues);
  issues.push(
    ...unexpectedFiles(
      files,
      new Set([MANIFEST_FILE, CREDITS_FILE, ...PLAN_OUTPUT_FILES, ...read.paths]),
      "is not part of a plan",
    ),
  );
  if (issues.length > 0 || credits === undefined || outputs === null) return { ok: false, issues };
  return { ok: true, value: { manifest: manifest.value, shards: read.shards, credits, outputs } };
}

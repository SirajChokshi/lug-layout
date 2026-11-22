import { describe, expect, it } from "vitest";
import {
  CREDITS_FILE,
  MANIFEST_FILE,
  canonicalJson,
  importRef,
  shardEntry,
  worldShards,
  type PlacementRecordV1,
  type TrackRecordV1,
} from "../world/index.ts";
import {
  PLAN_SHEET_FILE,
  planArchiveFiles,
  planManifest,
  readPlanFiles,
  type PlanOutputs,
  type PlanRecordV1,
} from "./index.ts";

const SHA = "a".repeat(64);
const OUTPUTS: PlanOutputs = {
  "plan.svg": "<svg/>",
  "parts.csv": "Part,Color,Quantity\n",
  "bricklink.xml": "<INVENTORY/>",
  "rebrickable.csv": "Part,Color,Quantity\n",
};

const plan: PlanRecordV1 = {
  name: "Club table",
  originChunkX: -2,
  originChunkZ: 3,
  maxOverhangMm: 0,
  maxReachMm: 700,
  footprint: {
    roomWidthMm: 2400,
    roomDepthMm: -5,
    tables: [{ name: "Table 1", rect: { x: 0, z: 0, width: 768, depth: 512.5 }, heightMm: 750 }],
    obstacles: [{ name: "Pillar", rect: { x: -40, z: 600, width: 80, depth: 80 } }],
  },
};

const placements: PlacementRecordV1[] = [
  { ref: "ldraw:3811", color: 2, x: -1280, z: 1920, yPlates: 0, rot: 0 },
  { ref: importRef(SHA), color: 0, x: -1220, z: 2020, yPlates: 1, rot: 3 },
];

const track: TrackRecordV1[] = [
  {
    index: 0,
    ref: "ldraw:74746",
    heading: 3,
    position: ["-63", "0", "0", "0", "97", "0", "0", "1"],
    yPlates: 1,
  },
];

function byValue(records: ReadonlyArray<PlacementRecordV1>): PlacementRecordV1[] {
  const sorted = [...records];
  sorted.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
  return sorted;
}

function planFiles(): Map<string, string> {
  const shards = worldShards(placements, track);
  const manifest = planManifest(
    { bundleVersion: "1fd935a2278f8b65", plan, disclaimer: "disclaimer" },
    shards.map(shardEntry),
  );
  return new Map(
    planArchiveFiles({ manifest, shards, credits: "credits", outputs: OUTPUTS }).map((file) => [
      file.name,
      file.text,
    ]),
  );
}

function withManifest(files: Map<string, string>, patch: Record<string, unknown>) {
  const manifest: unknown = JSON.parse(files.get(MANIFEST_FILE) ?? "{}");
  return new Map([...files, [MANIFEST_FILE, canonicalJson({ ...Object(manifest), ...patch })]]);
}

describe("plan archive files", () => {
  it("read back to the plan, its exact placements and track, and its credits", () => {
    const read = readPlanFiles(planFiles());
    expect(read.ok && read.value.manifest.plan).toEqual(plan);
    expect(read.ok && byValue(read.value.shards.flatMap((shard) => shard.placements))).toEqual(
      byValue(placements),
    );
    expect(read.ok && read.value.shards.flatMap((shard) => shard.track)).toEqual(track);
    expect(read.ok && read.value.credits).toBe("credits");
    expect(read.ok && read.value.outputs).toEqual(OUTPUTS);
  });

  it.each([
    [
      "a different format, like the draft #50 archive",
      (files: Map<string, string>) =>
        new Map([
          ...files,
          [MANIFEST_FILE, JSON.stringify({ format: "brrplan", version: 1, plan: {} })],
        ]),
      [
        {
          path: `${MANIFEST_FILE}.format`,
          message: `is "brrplan", not "brr.plan": this isn't a Brick Railroad plan file this app reads`,
        },
      ],
    ],
    [
      "an older schema version",
      (files: Map<string, string>) => withManifest(files, { schemaVersion: 0 }),
      [
        {
          path: `${MANIFEST_FILE}.schemaVersion`,
          message: "is 0, older than plan schema 1, the only one this app reads",
        },
      ],
    ],
    [
      "a newer schema version",
      (files: Map<string, string>) => withManifest(files, { schemaVersion: 2 }),
      [
        {
          path: `${MANIFEST_FILE}.schemaVersion`,
          message:
            "is 2, newer than plan schema 1, the newest this app reads; open it in a newer version of the app",
        },
      ],
    ],
    [
      "a placement count that disagrees with the shards",
      (files: Map<string, string>) => withManifest(files, { placements: 3 }),
      [
        {
          path: `${MANIFEST_FILE}.placements`,
          message: "must equal the sum of the shards' placements",
        },
      ],
    ],
    [
      "a file that isn't part of a plan, and no credits or printable plan",
      (files: Map<string, string>) =>
        new Map([
          ...[...files].filter(([name]) => name !== CREDITS_FILE && name !== PLAN_SHEET_FILE),
          ["notes.txt", "notes"],
        ]),
      [
        { path: CREDITS_FILE, message: "is missing" },
        { path: PLAN_SHEET_FILE, message: "is missing" },
        { path: "notes.txt", message: "is not part of a plan" },
      ],
    ],
  ])("refuse %s", (_case, edit, issues) => {
    expect(readPlanFiles(edit(planFiles()))).toEqual({ ok: false, issues });
  });
});

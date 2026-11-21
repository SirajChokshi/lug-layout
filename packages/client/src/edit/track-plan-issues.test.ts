import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
  type PartBundle,
} from "@brr/catalog";
import { emptyFacts, PlanDelta, type PlanIssue, type TrackChange } from "@brr/domain";
import {
  CHUNK_LDU,
  STUD_LDU,
  attachPose16,
  chunkKey,
  chunkOf,
  mmFromLdu,
  pose16,
  zeta16,
  type Pose16,
} from "@brr/math";
import { INSTANCE_MATRIX_FLOATS, SCENE_BACKEND, type WorldBox } from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { beforeAll, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import {
  heldPieces,
  latticeFrame,
  modelTrackEnds,
  type FramedTrackPiece,
  type TrackInstances,
} from "../connect/model-track-ends.ts";
import {
  catalogPieceOf,
  chainedPoses,
  instancesAt,
} from "../connect/track-instances.test-support.ts";
import { writeFullRebuild, writeTrackChange, type PlanModelSource } from "../plan/plan-producer.ts";
import type { IPlanService } from "../plan/plan-service.ts";
import { RecordingBackend } from "../plan/plan-sync.test-support.ts";
import { ColorTable } from "../scene/viewer-scene.ts";
import { PLAN_SERVICE } from "../tokens.ts";
import { TrackDrawing, type TrackCarrier } from "./track-drawing.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const STRAIGHT = "ldraw:74746";
const CURVE = "ldraw:74747";
const RIGHT_SWITCH = "ldraw:75541-f1";
const PLASTIC_STRAIGHT = "ldraw:53401";
const PLASTIC_CURVE = "ldraw:53400";
const HALF_TURN_CURVES = 8;
const ORIGIN_CHUNK = -2;
const MODEL_AT = { x: 0, z: 1280 } as const;
const MODEL_LABEL_AT = "at 0, 1280";
const FAR_EAST_STUDS = 600n;
const ROOM_DEPTH_MM = 3000;
const OFF_FIELD_RADIANS = (0.1 * Math.PI) / 180;
const UNCHECKED_ENDS = "so the plan can't check their ends or join anything to them.";

class BundleDirectoryFetcher implements IAssetFetcher {
  async bytes(path: string): Promise<ArrayBuffer> {
    const buffer = await readFile(new URL(path, bundleRoot));
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  }

  async text(path: string): Promise<string> {
    return readFile(new URL(path, bundleRoot), "utf8");
  }
}

let bundle: PartBundle;

beforeAll(async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  bundle = await container
    .get(PART_BUNDLE_LOADER)
    .load("standard", (part) => part.role === "track");
});

function studPose(x: bigint, z: bigint, heading: number): Pose16 {
  return pose16(zeta16([x, 0n, 0n, 0n, z, 0n, 0n, 0n]), heading);
}

function catalogIndex(partId: string): number {
  return bundle.trackCatalog.pieces.indexOf(catalogPieceOf(bundle, partId));
}

interface Room {
  readonly plans: IPlanService;
  readonly backend: RecordingBackend;
  readonly planId: string;
  readonly tableId: string;
  readonly drawing: TrackDrawing;
  readonly delta: PlanDelta;
}

function room(widthMm = 4000): Room {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  const backend = new RecordingBackend();
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const plans = container.get(PLAN_SERVICE);
  const planId = plans.createPlan({
    name: "Room",
    roomWidthMm: widthMm,
    roomDepthMm: ROOM_DEPTH_MM,
    originChunkX: ORIGIN_CHUNK,
    originChunkZ: ORIGIN_CHUNK,
  });
  plans.updatePlan(planId, { maxReachMm: ROOM_DEPTH_MM });
  const tableId = plans.addTable(planId, {
    name: "Table",
    rect: { x: 0, z: 0, width: widthMm, depth: ROOM_DEPTH_MM },
    heightMm: 750,
  });
  const drawing = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  return { plans, backend, planId, tableId, drawing, delta: new PlanDelta() };
}

function boundsOf(instances: TrackInstances): WorldBox {
  const box = { minX: Infinity, minY: Infinity, minZ: Infinity };
  const top = { maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  const m = instances.matrices;
  for (let i = 0; i < instances.count; i++) {
    const part = bundle.parts[instances.partIndex[i] ?? -1];
    if (!part) throw new Error(`instance ${i} has no part`);
    const o = i * INSTANCE_MATRIX_FLOATS;
    for (const x of [part.boundsMin[0], part.boundsMax[0]]) {
      for (const y of [part.boundsMin[1], part.boundsMax[1]]) {
        for (const z of [part.boundsMin[2], part.boundsMax[2]]) {
          const at = [0, 4, 8].map(
            (r) =>
              (m[o + r] ?? 0) * x +
              (m[o + r + 1] ?? 0) * y +
              (m[o + r + 2] ?? 0) * z +
              (m[o + r + 3] ?? 0),
          );
          box.minX = Math.min(box.minX, (at[0] ?? 0) + MODEL_AT.x);
          box.minY = Math.min(box.minY, at[1] ?? 0);
          box.minZ = Math.min(box.minZ, (at[2] ?? 0) + MODEL_AT.z);
          top.maxX = Math.max(top.maxX, (at[0] ?? 0) + MODEL_AT.x);
          top.maxY = Math.max(top.maxY, at[1] ?? 0);
          top.maxZ = Math.max(top.maxZ, (at[2] ?? 0) + MODEL_AT.z);
        }
      }
    }
  }
  return { ...box, ...top };
}

interface UserModel {
  readonly model: PlanModelSource;
  readonly carrier: TrackCarrier;
  readonly held: ReadonlyArray<FramedTrackPiece>;
}

function turnedOffTheField(instances: TrackInstances, instance: number): TrackInstances {
  const m = Float64Array.from(instances.matrices);
  const o = instance * INSTANCE_MATRIX_FLOATS;
  const cos = Math.cos(OFF_FIELD_RADIANS);
  const sin = Math.sin(OFF_FIELD_RADIANS);
  for (const column of [0, 2]) {
    const x = m[o + column] ?? 0;
    const z = m[o + 8 + column] ?? 0;
    m[o + column] = cos * x - sin * z;
    m[o + 8 + column] = sin * x + cos * z;
  }
  return { ...instances, matrices: m };
}

function userModel(
  label: string,
  pieces: ReadonlyArray<readonly [string, Pose16]>,
  written: (instances: TrackInstances) => TrackInstances = (instances) => instances,
): UserModel {
  const frame = latticeFrame(MODEL_AT.x, MODEL_AT.z, 0);
  if (!frame) throw new Error("the model is off the lattice");
  const instances = written(instancesAt(bundle, pieces));
  const track = modelTrackEnds(instances, bundle.parts, bundle.trackCatalog);
  const held = heldPieces(track, frame, 0);
  const model: PlanModelSource = {
    id: 1,
    handle: {
      chunkKey: chunkKey(chunkOf(MODEL_AT.x), chunkOf(MODEL_AT.z)),
      slot: 0,
      x: MODEL_AT.x,
      z: MODEL_AT.z,
    },
    placeable: { id: `user:${label}`, label },
    box: boundsOf(instances),
    shape: null,
    facts: emptyFacts(),
  };
  return {
    model,
    carrier: {
      model,
      held: held.length,
      unverified: track.unverified,
      unidentified: track.unidentified,
    },
    held,
  };
}

function place(at: Room, user: UserModel): void {
  at.drawing.syncHeld(user.held, [user.carrier]);
  writeFullRebuild(at.delta, [user.model], at.drawing);
  at.plans.apply(at.delta);
}

function commit(at: Room, change: TrackChange): void {
  at.drawing.applyTrack(change);
  writeTrackChange(at.delta, at.drawing, change);
  at.plans.apply(at.delta);
}

function layFrom(at: Room, start: Pose16, partIds: ReadonlyArray<string>): TrackChange {
  const first = at.drawing.pieceCount;
  return {
    lift: [],
    lay: chainedPoses(bundle, start, partIds).map(([partId, pose], k) => ({
      index: first + k,
      piece: catalogIndex(partId),
      pose,
      yPlates: 0,
    })),
  };
}

function lifted(change: TrackChange): TrackChange {
  return { lift: change.lay, lay: [] };
}

function planMm(ldu: number): number {
  return Math.round(mmFromLdu(ldu - ORIGIN_CHUNK * CHUNK_LDU));
}

function planAt(xLdu: number, zLdu: number): string {
  return `(${planMm(xLdu)} mm, ${planMm(zLdu)} mm)`;
}

function endLabels(issues: ReadonlyArray<PlanIssue>): ReadonlyArray<string> {
  return issues.map((issue) => issue.message.replace(/^.* on /u, ""));
}

function rows(issues: ReadonlyArray<PlanIssue>) {
  return issues.map(({ rule, severity, placements, message }) => ({
    rule,
    severity,
    placements,
    message,
  }));
}

function endFacing(drawing: TrackDrawing, heading: number): Pose16 {
  const end = drawing.endPoses().find((pose) => pose.heading === heading);
  if (!end) throw new Error(`no open end faces heading ${heading}`);
  return end;
}

function entryOnto(end: Pose16, partId: string): Pose16 {
  const entry = catalogPieceOf(bundle, partId).connectors[0]?.pose;
  if (!entry) throw new Error(`${partId} has no entry`);
  return attachPose16(entry, end);
}

it("reports each open end of a user's model's own track and of laid track in the plan by position, follows a lay and its undo, and clears every row once a loop closes", () => {
  const at = room();
  const run = userModel(
    "My 9V run",
    chainedPoses(bundle, studPose(0n, 0n, 0), [STRAIGHT, STRAIGHT]),
  );
  place(at, run);
  const model = [{ chunkKey: run.carrier.model.handle.chunkKey, slot: 0 }];
  const west = MODEL_AT.x;
  const east = MODEL_AT.x + 32 * STUD_LDU;
  const placed = rows(at.plans.issues(at.planId));

  const onward = layFrom(at, entryOnto(endFacing(at.drawing, 0), STRAIGHT), [STRAIGHT]);
  commit(at, onward);
  const laid = rows(at.plans.issues(at.planId));
  const laidPiece = at.drawing.footprintAt(0).key;
  commit(at, lifted(onward));
  const undone = rows(at.plans.issues(at.planId));

  const loop = [
    ...Array<string>(HALF_TURN_CURVES).fill(CURVE),
    STRAIGHT,
    STRAIGHT,
    ...Array<string>(HALF_TURN_CURVES).fill(CURVE),
  ];
  commit(at, layFrom(at, entryOnto(endFacing(at.drawing, 0), CURVE), loop));

  const openEnd = (x: number, placements: unknown, label: string) => ({
    rule: "trackOpenEnd",
    severity: "error",
    placements,
    message: `Open track end at ${planAt(x, MODEL_AT.z)} on ${label}: nothing joins it.`,
  });
  expect(placed).toEqual([
    openEnd(west, model, `My 9V run ${MODEL_LABEL_AT}`),
    openEnd(east, model, `My 9V run ${MODEL_LABEL_AT}`),
  ]);
  expect(laid).toEqual([
    openEnd(east + 16 * STUD_LDU, [laidPiece], "Train Track 9V Straight #1"),
    openEnd(west, model, `My 9V run ${MODEL_LABEL_AT}`),
  ]);
  expect(undone).toEqual(placed);
  expect(at.plans.issues(at.planId)).toEqual([]);
  expect(at.plans.issueCount(at.planId)).toBe(0);
  expect(at.backend.boxes).toEqual([]);
});

const KINK = planAt(MODEL_AT.x + 16 * STUD_LDU, MODEL_AT.z);
const WEST_END = planAt(MODEL_AT.x, MODEL_AT.z);
const SOUTH_END = planAt(MODEL_AT.x + 16 * STUD_LDU, MODEL_AT.z + 16 * STUD_LDU);

it.each([
  {
    label: "My kinked run",
    pieces: [studPose(0n, 0n, 0), studPose(16n, 0n, 4)],
    open: [WEST_END, SOUTH_END],
    join: `Two track ends of My kinked run ${MODEL_LABEL_AT} meet at ${KINK} but don't join: their headings are 90° off a straight join.`,
  },
  {
    label: "My junction",
    pieces: [studPose(0n, 0n, 0), studPose(16n, 0n, 0), studPose(16n, 0n, 4)],
    open: [WEST_END, planAt(MODEL_AT.x + 32 * STUD_LDU, MODEL_AT.z), SOUTH_END],
    join: `3 track ends of My junction ${MODEL_LABEL_AT} meet at ${KINK}, so none of them joins: a track end joins exactly one other.`,
  },
])(
  "reports the track ends of $label that meet without joining as one error, and not also as open ends",
  ({ label, pieces, open, join }) => {
    const at = room();
    place(
      at,
      userModel(
        label,
        pieces.map((pose) => [STRAIGHT, pose] as const),
      ),
    );

    expect(
      at.plans.issues(at.planId).map((issue) => [issue.rule, issue.severity, issue.message]),
    ).toEqual([
      ...open.map((end) => [
        "trackOpenEnd",
        "error",
        `Open track end at ${end} on ${label} ${MODEL_LABEL_AT}: nothing joins it.`,
      ]),
      ["trackJoin", "error", join],
    ]);
  },
);

it("counts a point where laid track meets without joining only in a room one of its pieces overlaps, not in the empty corner of their L", () => {
  const at = room();
  at.plans.removeTable(at.planId, at.tableId);
  const corner = { chunk: 1, sizeMm: 80 };
  const layL = () => {
    commit(at, at.drawing.pieceChange(catalogIndex(STRAIGHT), studPose(22n, 47n, 0)));
    commit(at, at.drawing.pieceChange(catalogIndex(STRAIGHT), studPose(22n, 47n, 12)));
  };
  layL();
  const wholeRoom = at.plans.issues(at.planId).map((issue) => issue.rule);
  at.plans.updatePlan(at.planId, {
    originChunkX: corner.chunk,
    originChunkZ: corner.chunk,
    roomWidthMm: corner.sizeMm,
    roomDepthMm: corner.sizeMm,
  });

  expect(wholeRoom.filter((rule) => rule.startsWith("track"))).toEqual([
    "trackOpenEnd",
    "trackOpenEnd",
    "trackJoin",
  ]);
  expect(at.plans.issues(at.planId)).toEqual([]);
  expect(at.backend.boxes).toEqual([]);
});

it("warns that a user's model holds plastic curves whose connector poses are unverified, naming the part and count, beside the open ends of its certified straight", () => {
  const at = room();
  const plastic = userModel(
    "My plastic run",
    chainedPoses(bundle, studPose(0n, 0n, 0), [PLASTIC_STRAIGHT, PLASTIC_CURVE, PLASTIC_CURVE]),
  );
  place(at, plastic);

  expect(
    at.plans.issues(at.planId).map((issue) => [issue.rule, issue.severity, issue.message]),
  ).toEqual([
    [
      "trackOpenEnd",
      "error",
      `Open track end at ${WEST_END} on My plastic run ${MODEL_LABEL_AT}: nothing joins it.`,
    ],
    [
      "trackOpenEnd",
      "error",
      `Open track end at ${KINK} on My plastic run ${MODEL_LABEL_AT}: nothing joins it.`,
    ],
    [
      "trackUnverified",
      "warning",
      `My plastic run ${MODEL_LABEL_AT} holds 2 × 53400 Train Track 6 Studs Wide Curved, whose connector poses are unverified, ${UNCHECKED_ENDS}`,
    ],
  ]);
});

it("warns that a user's model holds a straight turned off the exact track field, beside the open ends of the straight it was meant to join", () => {
  const at = room();
  place(
    at,
    userModel(
      "My bent run",
      chainedPoses(bundle, studPose(0n, 0n, 0), [STRAIGHT, STRAIGHT]),
      (instances) => turnedOffTheField(instances, 1),
    ),
  );

  expect(
    at.plans.issues(at.planId).map((issue) => [issue.rule, issue.severity, issue.message]),
  ).toEqual([
    [
      "trackOpenEnd",
      "error",
      `Open track end at ${WEST_END} on My bent run ${MODEL_LABEL_AT}: nothing joins it.`,
    ],
    [
      "trackOpenEnd",
      "error",
      `Open track end at ${KINK} on My bent run ${MODEL_LABEL_AT}: nothing joins it.`,
    ],
    [
      "trackUnidentified",
      "warning",
      `My bent run ${MODEL_LABEL_AT} holds 1 × 74746 Train Track 9V Straight placed where no exact track pose fits, ${UNCHECKED_ENDS}`,
    ],
  ]);
});

it("counts a track row only in a plan whose room holds its piece, keeps the plan's list as it was while track is laid outside the room, and relabels the rows of a thrown switch", () => {
  const at = room();
  commit(at, at.drawing.pieceChange(catalogIndex(RIGHT_SWITCH), studPose(FAR_EAST_STUDS, 0n, 0)));
  const outside = { issues: at.plans.issueCount(at.planId), boxes: at.backend.boxes.length };
  const grownMm = 8000;
  at.plans.updatePlan(at.planId, { roomWidthMm: grownMm });
  at.plans.updateTable(at.planId, at.tableId, {
    rect: { x: 0, z: 0, width: grownMm, depth: ROOM_DEPTH_MM },
  });
  const grown = at.plans.issues(at.planId);
  const boxes = at.backend.boxes;
  commit(at, at.drawing.pieceChange(catalogIndex(STRAIGHT), studPose(-FAR_EAST_STUDS, 0n, 0)));
  const laidOutside = { issues: at.plans.issues(at.planId), boxes: at.backend.boxes };
  const lever = at.drawing.switchLevers()[0];
  const thrown = lever ? at.drawing.switchThrow(lever.placement) : null;
  if (!thrown) throw new Error("the switch has no lever");
  commit(at, thrown.change);

  expect(outside).toEqual({ issues: 0, boxes: 0 });
  expect(endLabels(grown)).toEqual(
    Array(3).fill("Train Track 9V Switch Right Straight #1: nothing joins it."),
  );
  expect(boxes).toHaveLength(3);
  expect(laidOutside.issues).toBe(grown);
  expect(laidOutside.boxes).toBe(boxes);
  expect(endLabels(at.plans.issues(at.planId))).toEqual(
    Array(3).fill("Train Track 9V Switch Right Branching #1: nothing joins it."),
  );
});

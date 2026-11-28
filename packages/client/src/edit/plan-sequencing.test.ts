import {
  ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  type IAssetFetcher,
  type PartBundle,
} from "@brr/catalog";
import {
  EditHistory,
  PlanDelta,
  World,
  type AppliedEdit,
  type LayeredPose,
  type PlacementRef,
  type PlacementRequest,
  NO_OWNER,
} from "@brr/domain";
import { pose16, STUD_LDU, zeta16, type Pose16 } from "@brr/math";
import { SCENE_BACKEND } from "@brr/render";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { beforeAll, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import {
  writeFullRebuild,
  writeTrackLay,
  writeTrackThrow,
  writeViewUpdate,
} from "../plan/plan-producer.ts";
import { PlanService } from "../plan/plan-service.ts";
import { deepSame, lcg, RecordingBackend } from "../plan/plan-sync.test-support.ts";
import { ColorTable } from "../scene/viewer-scene.ts";
import { partPlaceable, type Placeable } from "./placeable.ts";
import { PlacedChunks } from "./placed-chunks.ts";
import { TrackDrawing } from "./track-drawing.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const GROUND_PARTS = ["ldraw:3811", "ldraw:30225b"];
const RIGHT_SWITCH = "ldraw:75541-f1";
const SEEDS = 4;
const CELLS = 14;
const CELL_LDU = 640;
const ACTIONS = 300;
const SWEEP_TIMEOUT_MS = 120_000;

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
let placeables: Placeable[];

beforeAll(async () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(new BundleDirectoryFetcher());
  container.rebind(SCENE_BACKEND).toConstantValue(new RecordingBackend());
  bundle = await container
    .get(PART_BUNDLE_LOADER)
    .load("standard", (part) => part.role === "track" || GROUND_PARTS.includes(part.id));
  const colors = new ColorTable(bundle);
  placeables = GROUND_PARTS.map((id) => {
    const index = bundle.parts.findIndex((part) => part.id === id);
    const part = bundle.parts[index];
    const color = part?.producedColor;
    if (!part || color === undefined) throw new Error(`${id} has no produced colour`);
    return partPlaceable(
      part,
      index,
      color,
      String(color),
      bundle.parts,
      colors,
      bundle.tablePlane.depthBelowTopLdu,
    );
  });
});

function withRegions(plans: PlanService): PlanService {
  const planId = plans.createPlan({
    name: "Room",
    roomWidthMm: 3000,
    roomDepthMm: 2400,
    originChunkX: -1,
    originChunkZ: -1,
  });
  plans.addTable(planId, {
    name: "Table",
    rect: { x: 400, z: 300, width: 1200, depth: 900 },
    heightMm: 750,
  });
  plans.addObstacle(planId, { name: "Pillar", rect: { x: 1700, z: 1500, width: 200, depth: 200 } });
  plans.updatePlan(planId, { maxOverhangMm: 40 });
  return plans;
}

class Sequence {
  readonly next: () => number;
  readonly history = new EditHistory(new World());
  readonly placed = new PlacedChunks(new RecordingBackend());
  readonly drawing = new TrackDrawing(bundle, bundle.parts, new ColorTable(bundle));
  readonly plansBackend = new RecordingBackend();
  readonly plans = withRegions(new PlanService(this.plansBackend));
  readonly delta = new PlanDelta();
  readonly refs: PlacementRef[] = [];
  readonly mismatches: unknown[] = [];

  constructor(readonly seed: number) {
    this.next = lcg(seed);
  }

  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  pose(taken: Set<string> = new Set()): LayeredPose {
    const occupied = new Set(taken);
    for (const ref of this.refs) {
      const handle = ref.handle;
      if (handle?.live) occupied.add(`${handle.x},${handle.z}`);
    }
    let x = 0;
    let z = 0;
    for (let tries = 0; tries < 64; tries++) {
      x = (this.int(CELLS) - CELLS / 2) * CELL_LDU + CELL_LDU / 2;
      z = (this.int(CELLS) - CELLS / 2) * CELL_LDU + CELL_LDU / 2;
      if (!occupied.has(`${x},${z}`)) break;
    }
    taken.add(`${x},${z}`);
    const refId = this.int(placeables.length);
    return {
      refId,
      colorId: placeables[refId]?.worldColor ?? 0,
      x,
      z,
      yPlates: 0,
      rot: this.int(4),
      layer: 0,
      owner: NO_OWNER,
    };
  }

  live(): PlacementRef | null {
    const alive = this.refs.filter((ref) => ref.handle?.live === true);
    return alive[this.int(alive.length)] ?? null;
  }

  show(edit: AppliedEdit | null): void {
    if (!edit) return;
    for (const change of edit.changes) {
      if (change.from === null && !this.refs.includes(change.placement)) {
        this.refs.push(change.placement);
      }
    }
    const view = this.placed.apply(edit, (refId) => {
      const placeable = placeables[refId];
      if (!placeable) throw new Error(`no placeable ${refId}`);
      return placeable;
    });
    writeViewUpdate(this.delta, view);
    this.plans.apply(this.delta);
  }

  lay(commit: { readonly laid: number }): void {
    writeTrackLay(this.delta, this.drawing, commit.laid);
    this.plans.apply(this.delta);
  }

  studPose(heading: number): Pose16 {
    const x = BigInt(this.int(60) - 30);
    const z = BigInt(this.int(60) - 30);
    return pose16(zeta16([x, 0n, 0n, 0n, z, 0n, 0n, 0n]), heading);
  }

  act(): void {
    const roll = this.int(12);
    const ref = this.live();
    if (roll <= 2 || ref === null) {
      this.show(this.history.place(this.pose()));
      return;
    }
    switch (roll) {
      case 3:
        this.show(this.history.rotate(ref));
        return;
      case 4:
        this.show(this.history.remove(ref));
        return;
      case 5: {
        const taken = new Set<string>();
        const requests: PlacementRequest[] = [
          { placement: ref, to: this.next() < 0.5 ? null : this.pose(taken) },
          { placement: null, to: this.pose(taken) },
          { placement: null, to: this.pose(taken) },
        ];
        this.show(this.history.commit("road", requests));
        return;
      }
      case 6:
        this.show(this.history.undo());
        return;
      case 7:
        this.show(this.history.redo());
        return;
      case 8: {
        const x = (this.int(60) - 30) * STUD_LDU;
        const z = (this.int(60) - 30) * STUD_LDU;
        this.drawing.beginDrag(x, z, x, z);
        this.drawing.moveDrag(
          x + (this.int(9) - 4) * 16 * STUD_LDU,
          z + (this.int(9) - 4) * 16 * STUD_LDU,
        );
        const { change } = this.drawing.endDrag();
        this.drawing.applyTrack(change);
        if (change.lay.length > 0) this.lay({ laid: change.lay.length });
        return;
      }
      case 9: {
        const part = this.drawing.pieceParts().find((p) => p.piece.id === RIGHT_SWITCH);
        if (part) {
          const change = this.drawing.pieceChange(
            part.catalogIndex,
            this.studPose(this.int(4) * 4),
            0,
          );
          this.drawing.applyTrack(change);
          this.lay({ laid: change.lay.length });
        }
        return;
      }
      case 10: {
        const levers = this.drawing.switchLevers();
        const lever = levers[this.int(levers.length)];
        const thrown = lever ? this.drawing.switchThrow(lever.placement) : null;
        if (lever && thrown) {
          this.drawing.applyTrack(thrown.change);
          writeTrackThrow(this.delta, this.drawing, lever.placement);
          this.plans.apply(this.delta);
        }
        return;
      }
      default:
        writeFullRebuild(this.delta, this.placed.models(), this.drawing);
        this.plans.apply(this.delta);
    }
  }

  check(step: number): void {
    const rebuiltBackend = new RecordingBackend();
    const rebuilt = withRegions(new PlanService(rebuiltBackend));
    const delta = new PlanDelta();
    writeFullRebuild(delta, this.placed.models(), this.drawing);
    rebuilt.apply(delta);
    const pairs: ReadonlyArray<readonly [string, unknown, unknown]> = [
      ["materialize", this.plans.materialize(), rebuilt.materialize()],
      ["activePlanId", this.plans.activePlanId(), rebuilt.activePlanId()],
      ["overlays sent", this.plansBackend.overlays, rebuiltBackend.overlays],
      ["issue boxes sent", this.plansBackend.boxes, rebuiltBackend.boxes],
    ];
    for (const [what, incremental, full] of pairs) {
      if (!deepSame(incremental, full)) this.mismatches.push({ seed: this.seed, step, what });
    }
    const placements = this.plans.materialize().placements;
    for (let p = 0; p < this.drawing.pieceCount; p++) {
      const footprint = this.drawing.footprintAt(p);
      const row = placements.find(
        (placement) =>
          placement.key.chunkKey === footprint.key.chunkKey &&
          placement.key.slot === footprint.key.slot,
      );
      if (!deepSame(row, { ...footprint, box: { ...footprint.box } })) {
        this.mismatches.push({ seed: this.seed, step, what: `track row ${p}` });
      }
    }
  }
}

it(
  "keeps the plan equal to a full rebuild from the placed models and track after every real edit",
  () => {
    const mismatches: unknown[] = [];
    let trackRows = 0;
    let models = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const sequence = new Sequence(seed);
      for (let step = 0; step < ACTIONS && sequence.mismatches.length === 0; step++) {
        sequence.act();
        sequence.check(step);
      }
      mismatches.push(...sequence.mismatches.slice(0, 3));
      trackRows += sequence.drawing.pieceCount;
      models += sequence.placed.models().length;
    }
    expect(mismatches).toEqual([]);
    expect([trackRows > 0, models > 0]).toEqual([true, true]);
  },
  SWEEP_TIMEOUT_MS,
);

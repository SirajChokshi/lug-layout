import {
  SCENE_BACKEND,
  type BufferMemory,
  type ISceneBackend,
  type RebaseEvent,
  type WorldBox,
} from "@brr/render";
import { Container } from "inversify";
import { expect, it } from "vitest";
import { PlanDelta } from "@brr/domain";
import { mainThreadModules } from "../client.module.ts";
import { writeFullRebuild } from "./plan-producer.ts";
import { PLAN_SERVICE } from "../tokens.ts";

class IssueBoxBackend implements ISceneBackend {
  issueBoxes: ReadonlyArray<WorldBox> = [];
  async init(): Promise<never> {
    throw new Error("not used");
  }
  setPalette(): void {}
  addParts(): void {}
  setPartMeshes(): void {}
  setFarStuds(): void {}
  setFarModelMesh(): void {}
  setColors(): void {}
  setChunk(): void {}
  deleteChunk(): void {}
  setNeededMeshListener(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setIssueBoxes(boxes: ReadonlyArray<WorldBox>): void {
    this.issueBoxes = boxes;
  }
  rayThrough(): void {}
  setView(): void {}
  resize(): void {}
  renderFrame(): void {}
  needsFrame(): boolean {
    return true;
  }
  async waitForGpu(): Promise<void> {}
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return [];
  }
  bufferMemory(): BufferMemory {
    return { vertexIndexBytes: 0, otherBytes: 0 };
  }
  forceTier(): void {}
  setFarModel(): void {}
}

it("commits an unchecked plan, tables kept, when a placement box cannot be read", () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  const backend = new IssueBoxBackend();
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const plans = container.get(PLAN_SERVICE);
  const planId = plans.createPlan({
    name: "Room",
    roomWidthMm: 4000,
    roomDepthMm: 3000,
    originChunkX: 0,
    originChunkZ: 0,
  });
  plans.addTable(planId, {
    name: "Table 1",
    rect: { x: 800, z: 800, width: 2400, depth: 1200 },
    heightMm: 750,
  });
  const unreadable: WorldBox = Object.defineProperty(
    { minX: 0, minY: 0, minZ: 0, maxX: 640, maxY: 8, maxZ: 640 },
    "minX",
    {
      get(): number {
        throw new Error("box is gone");
      },
    },
  );
  const delta = new PlanDelta();
  writeFullRebuild(
    delta,
    [
      {
        id: 1,
        handle: { chunkKey: 5, slot: 2, x: 0, z: 0 },
        placeable: { id: "ldraw:3811", label: "3811" },
        box: unreadable,
      },
    ],
    null,
  );
  plans.apply(delta);
  const placement = {
    key: { chunkKey: 5, slot: 2 },
    ref: "ldraw:3811",
    label: "3811 at 0, 0",
    box: unreadable,
  };

  const dump = plans.materialize();
  expect(dump.placements).toEqual([placement]);
  expect(plans.regionView(planId).tables.map((t) => t.studs.studsWide)).toEqual([300]);
  expect(dump.checks[0]?.issues.map((i) => [i.rule, i.message])).toEqual([
    ["unchecked", 'Plan "Room" could not be checked: Error: box is gone'],
  ]);
  expect(backend.issueBoxes).toEqual([]);
});

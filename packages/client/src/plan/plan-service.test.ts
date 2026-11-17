import {
  SCENE_BACKEND,
  type BufferMemory,
  type ISceneBackend,
  type RebaseEvent,
  type WorldBox,
} from "@brr/render";
import { Container } from "inversify";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { PLAN_SERVICE } from "../tokens.ts";

class IssueBoxBackend implements ISceneBackend {
  issueBoxes: ReadonlyArray<WorldBox> = [];
  async init(): Promise<never> {
    throw new Error("not used");
  }
  setPalette(): void {}
  setChunk(): void {}
  deleteChunk(): void {}
  setGhost(): void {}
  placeGhost(): void {}
  setGhostTone(): void {}
  cueGhost(): void {}
  setSnapTargets(): void {}
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setMarkers(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  setIssueBoxes(boxes: ReadonlyArray<WorldBox>): void {
    this.issueBoxes = boxes;
  }
  rayThrough(): void {}
  setView(): void {}
  resize(): void {}
  renderFrame(): void {}
  async waitForGpu(): Promise<void> {}
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return [];
  }
  bufferMemory(): BufferMemory {
    return { vertexIndexBytes: 0, otherBytes: 0 };
  }
}

it("commits an unchecked plan, tables kept, when a placement box cannot be read", () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused" }));
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
  const placement = {
    key: { chunkKey: 5, slot: 2 },
    ref: "ldraw:3811",
    label: "3811",
    box: unreadable,
  };
  plans.setPlacements([placement]);

  const snapshot = plans.snapshot();
  expect(snapshot.placements).toEqual([placement]);
  expect(snapshot.checks[0]?.tables.map((t) => t.studs.studsWide)).toEqual([300]);
  expect(snapshot.checks[0]?.issues.map((i) => [i.rule, i.message])).toEqual([
    ["unchecked", 'Plan "Room" could not be checked: Error: box is gone'],
  ]);
  expect(backend.issueBoxes).toEqual([]);
});

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
  setSelectionBox(): void {}
  setPlanOverlays(): void {}
  setGroundGrid(): void {}
  setGuides(): void {}
  projectToScreen(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
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

it("keeps every drawn table where it was drawn while later tables grow the room in any direction", () => {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(SCENE_BACKEND).toConstantValue(new IssueBoxBackend());
  const plans = container.get(PLAN_SERVICE);
  const drawn = [
    { minX: -160, minZ: 320, maxX: 2840, maxZ: 1820 },
    { minX: 160, minZ: -800, maxX: 1120, maxZ: 160 },
    { minX: -2400, minZ: 2000, maxX: -1600, maxZ: 2800 },
    { minX: 3200, minZ: -1600, maxX: 4000, maxZ: -960 },
  ];
  const ids = drawn.map((rect) => plans.drawTable(rect));
  const second = ids[1];
  if (!second) throw new Error("no second table");
  plans.updateTable(second.planId, second.tableId, {
    rect: { x: -64, z: 0, width: 640, depth: 640 },
  });

  const [check] = plans.snapshot().checks;
  expect(
    check?.tables
      .slice(0, 1)
      .concat(check.tables.slice(2))
      .map((t) => t.surface),
  ).toEqual([drawn[0], drawn[2], drawn[3]]);
  expect(check?.issues).toEqual([]);
});

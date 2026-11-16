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

it("keeps the plan current when a float model box hangs off a table far from world zero", () => {
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
    originChunkZ: -7,
  });
  const tableId = plans.addTable(planId, {
    name: "Table 1",
    rect: { x: 800, z: 0, width: 2400, depth: 1321 },
    heightMm: 750,
  });
  const box = { minX: 3680, minY: 0, minZ: -1180, maxX: 4320, maxY: 836, maxZ: -509.9517464892578 };
  plans.setPlacements([
    { key: { chunkKey: 5, slot: 2 }, ref: "omr:10185-1", label: "10185-1", box },
  ]);

  const [check] = plans.snapshot().checks;
  expect(check?.inside).toEqual([{ chunkKey: 5, slot: 2 }]);
  expect(check?.issues.map((i) => [i.rule, i.placements])).toEqual([
    ["fit", [{ chunkKey: 5, slot: 2 }]],
  ]);
  expect(backend.issueBoxes).toEqual([box]);

  plans.updateTable(planId, tableId, { rect: { x: 800, z: 0, width: 2400, depth: 1400 } });
  expect(plans.snapshot().checks[0]?.issues[0]?.message).toContain("reaches 188.1 mm");
});

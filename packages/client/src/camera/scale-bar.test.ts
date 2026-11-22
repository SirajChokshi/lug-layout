import { STUD_LDU } from "@brr/math";
import {
  SCENE_BACKEND,
  type BackendInfo,
  type BufferMemory,
  type ISceneBackend,
  type RebaseEvent,
} from "@brr/render";
import { Container } from "inversify";
import { describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { EDITOR_CAMERA, SCALE_BAR } from "../tokens.ts";
import { SCALE_BAR_MAX_PX, scaleBarFor, type ScaleBarView } from "./scale-bar.ts";

const WIDTH_PX = 1200;
const HEIGHT_PX = 800;
const PAST_TWEEN_MS = 1_000;
const ZOOM_IN = 6;

class ViewRecordingBackend implements ISceneBackend {
  orthoHalfHeightLdu: number | undefined;

  async init(): Promise<BackendInfo> {
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
  setGhostVerdict(): void {}
  setSelectionBoxes(): void {}
  setMarkers(): void {}
  setTrackEnds(): void {}
  setGround(): void {}
  setPlanOverlays(): void {}
  setIssueBoxes(): void {}
  setGuides(): void {}
  projectToNdc(): void {}
  rayThrough(): void {}
  setVehicle(): void {}
  setVehiclePose(): void {}
  deleteVehicle(): void {}
  setView(...view: Parameters<ISceneBackend["setView"]>): void {
    this.orthoHalfHeightLdu = view[6];
  }
  resize(): void {}
  renderFrame(): void {}
  needsFrame(): boolean {
    return false;
  }
  async waitForGpu(): Promise<void> {}
  bufferMemory(): BufferMemory {
    return { vertexIndexBytes: 0, otherBytes: 0 };
  }
  rebaseLog(): ReadonlyArray<RebaseEvent> {
    return [];
  }
  forceTier(): void {}
  setFarModel(): void {}
}

function editorView() {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  const backend = new ViewRecordingBackend();
  container.rebind(SCENE_BACKEND).toConstantValue(backend);
  const camera = container.get(EDITOR_CAMERA);
  camera.resize(WIDTH_PX, HEIGHT_PX);
  return { backend, camera, scaleBar: container.get(SCALE_BAR) };
}

const ROUNDING_PX = 0.5;

function scaleErrorPx(bar: ScaleBarView, lduPerPx: number): number {
  return Math.abs(bar.widthPx - (bar.studs * STUD_LDU) / lduPerPx);
}

function drawnLduPerPx(backend: ViewRecordingBackend): number {
  return (2 * (backend.orthoHalfHeightLdu ?? Number.NaN)) / HEIGHT_PX;
}

describe("scaleBarFor", () => {
  it.each<[number, ScaleBarView]>([
    [0.1, { studs: 0.5, widthPx: 100, label: "1/2 stud · 4 mm" }],
    [1, { studs: 4, widthPx: 80, label: "4 studs · 3.2 cm" }],
    [20, { studs: 64, widthPx: 64, label: "64 studs · 51.2 cm" }],
    [50, { studs: 256, widthPx: 102, label: "256 studs · 2.05 m" }],
  ])("at %d LDU a pixel shows %o", (lduPerPx, bar) => {
    expect(scaleBarFor(lduPerPx)).toEqual(bar);
  });

  it("spans a power of two studs, true to scale and at least half its widest, from a stud filling the screen to a whole room", () => {
    for (let lduPerPx = 0.01; lduPerPx < 500; lduPerPx *= 1.07) {
      const bar = scaleBarFor(lduPerPx);
      expect(Number.isInteger(Math.log2(bar.studs))).toBe(true);
      expect(scaleErrorPx(bar, lduPerPx)).toBeLessThanOrEqual(ROUNDING_PX);
      expect(bar.widthPx).toBeLessThanOrEqual(SCALE_BAR_MAX_PX);
      expect(bar.widthPx).toBeGreaterThanOrEqual(SCALE_BAR_MAX_PX / 2);
    }
  });
});

describe("the editor's scale bar", () => {
  it("shows only in the true-to-scale 2D plan, at the scale the renderer draws, and follows the zoom", () => {
    const { backend, camera, scaleBar } = editorView();
    camera.frame(0);
    scaleBar.refresh();
    expect(scaleBar.view()).toBeNull();

    camera.setMode("plan");
    camera.frame(0);
    camera.frame(PAST_TWEEN_MS);
    scaleBar.refresh();
    const planned = scaleBar.view();
    if (!planned) throw new Error("no scale bar in the 2D plan");
    const plannedLduPerPx = drawnLduPerPx(backend);
    expect(scaleErrorPx(planned, plannedLduPerPx)).toBeLessThanOrEqual(ROUNDING_PX);

    camera.zoomBy(ZOOM_IN);
    scaleBar.refresh();
    const zoomed = scaleBar.view();
    if (!zoomed) throw new Error("no scale bar after zooming the 2D plan");
    expect(zoomed.studs).toBeLessThan(planned.studs);
    const zoomedLduPerPx = drawnLduPerPx(backend);
    expect(zoomedLduPerPx).toBeLessThan(plannedLduPerPx);
    expect(scaleErrorPx(zoomed, zoomedLduPerPx)).toBeLessThanOrEqual(ROUNDING_PX);

    camera.setMode("orbit");
    scaleBar.refresh();
    expect(scaleBar.view()).toBeNull();
  });
});

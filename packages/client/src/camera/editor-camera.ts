import { roomRect, type LduRect } from "@brr/domain";
import { chunkOf } from "@brr/math";
import { SCENE_BACKEND, type ISceneBackend, type WorldBox } from "@brr/render";
import type { SavedViewV1 } from "@brr/schema/world";
import { inject, injectable } from "inversify";
import type { IPlanService } from "../plan/plan-service.ts";
import { PLAN_SERVICE } from "../tokens.ts";
import { ViewCamera, type ViewMode } from "./view-camera.ts";

export { FOOTPRINT_FLOATS } from "./view-camera.ts";

export type { ViewMode } from "./view-camera.ts";
export type ScrollGesture = "zoom" | "pan";

export interface CameraSnapshot {
  readonly mode: ViewMode;
  readonly scroll: ScrollGesture;
  readonly scrollDetected: boolean;
}

export interface WheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly ndcX: number;
  readonly ndcY: number;
}

export interface IEditorCamera {
  subscribe(listener: () => void): () => void;
  snapshot(): CameraSnapshot;
  resize(widthPx: number, heightPx: number): void;
  setSafeArea(leftPx: number, topPx: number, rightPx: number, bottomPx: number): void;
  frame(nowMs: number): void;
  orbit(dxPx: number, dyPx: number): void;
  pan(fromNdcX: number, fromNdcY: number, toNdcX: number, toNdcY: number): void;
  panBy(dxPx: number, dyPx: number): void;
  wheel(input: WheelInput): void;
  pinch(scaleRatio: number, ndcX: number, ndcY: number): void;
  zoomStep(steps: number): void;
  setMode(mode: ViewMode): void;
  setScroll(scroll: ScrollGesture): void;
  focus(box: WorldBox): void;
  fitAll(): void;
  lookAt(x: number, z: number, animate: boolean): void;
  viewPlan(planId: string): void;
  viewFootprint(out: Float64Array): void;
  targetChunk(): { readonly chunkX: number; readonly chunkZ: number };
  savedView(): SavedViewV1;
  restoreView(view: SavedViewV1 | null): void;
}

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
const LINE_PX = 16;
const PAGE_PX = 800;
const WHEEL_ZOOM_PER_PX = 0.0015;
const PINCH_ZOOM_PER_PX = 0.01;
const ZOOM_STEP_LOG = 0.35;
const HOME_HALF_LDU = 640;

const HOME_BOX: WorldBox = {
  minX: -HOME_HALF_LDU,
  minY: 0,
  minZ: -HOME_HALF_LDU,
  maxX: HOME_HALF_LDU,
  maxY: 0,
  maxZ: HOME_HALF_LDU,
};

function wheelPixels(delta: number, deltaMode: number): number {
  if (deltaMode === DOM_DELTA_LINE) return delta * LINE_PX;
  if (deltaMode === DOM_DELTA_PAGE) return delta * PAGE_PX;
  return delta;
}

function looksLikeTrackpad(input: WheelInput): boolean {
  return (
    input.deltaMode === 0 &&
    input.deltaX !== 0 &&
    input.deltaY !== 0 &&
    !input.shiftKey &&
    !input.ctrlKey
  );
}

function flatBox(rect: LduRect): WorldBox {
  return { minX: rect.minX, minY: 0, minZ: rect.minZ, maxX: rect.maxX, maxY: 0, maxZ: rect.maxZ };
}

function union(boxes: ReadonlyArray<WorldBox>): WorldBox | null {
  const first = boxes[0];
  if (!first) return null;
  let { minX, minY, minZ, maxX, maxY, maxZ } = first;
  for (const box of boxes) {
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    minZ = Math.min(minZ, box.minZ);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
    maxZ = Math.max(maxZ, box.maxZ);
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

@injectable()
export class EditorCamera implements IEditorCamera {
  private readonly listeners = new Set<() => void>();
  private readonly view = new ViewCamera();
  private readonly hit = new Float64Array(2);
  private state: CameraSnapshot = { mode: "orbit", scroll: "zoom", scrollDetected: false };

  constructor(
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
    @inject(PLAN_SERVICE) private readonly plans: IPlanService,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): CameraSnapshot {
    return this.state;
  }

  private update(patch: Partial<CameraSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  resize(widthPx: number, heightPx: number): void {
    this.view.resize(widthPx, heightPx);
  }

  setSafeArea(leftPx: number, topPx: number, rightPx: number, bottomPx: number): void {
    this.view.setSafeArea(leftPx, topPx, rightPx, bottomPx);
  }

  frame(nowMs: number): void {
    this.view.step(nowMs);
    this.view.apply(this.backend);
  }

  orbit(dxPx: number, dyPx: number): void {
    this.view.orbit(dxPx, dyPx);
    this.view.apply(this.backend);
  }

  pan(fromNdcX: number, fromNdcY: number, toNdcX: number, toNdcY: number): void {
    this.view.grabPan(fromNdcX, fromNdcY, toNdcX, toNdcY);
    this.view.apply(this.backend);
  }

  panBy(dxPx: number, dyPx: number): void {
    this.view.scrollPan(dxPx, dyPx);
    this.view.apply(this.backend);
  }

  wheel(input: WheelInput): void {
    this.applyWheel(input);
    this.view.apply(this.backend);
  }

  private applyWheel(input: WheelInput): void {
    if (!this.state.scrollDetected && looksLikeTrackpad(input)) {
      this.update({ scroll: "pan", scrollDetected: true });
    }
    const dx = wheelPixels(input.deltaX, input.deltaMode);
    const dy = wheelPixels(input.deltaY, input.deltaMode);
    if (input.ctrlKey) {
      this.view.zoomAt(input.ndcX, input.ndcY, dy * PINCH_ZOOM_PER_PX);
      return;
    }
    if (this.state.scroll === "zoom" || input.deltaMode !== 0) {
      this.view.glideZoomAt(input.ndcX, input.ndcY, (dy === 0 ? dx : dy) * WHEEL_ZOOM_PER_PX);
      return;
    }
    if (input.altKey) {
      this.view.orbit(-dx, -dy);
      return;
    }
    this.view.scrollPan(dx, dy);
  }

  pinch(scaleRatio: number, ndcX: number, ndcY: number): void {
    if (!(scaleRatio > 0)) return;
    this.view.zoomAt(ndcX, ndcY, -Math.log(scaleRatio));
    this.view.apply(this.backend);
  }

  zoomStep(steps: number): void {
    this.view.glideZoomAtSafeCentre(-steps * ZOOM_STEP_LOG);
  }

  setMode(mode: ViewMode): void {
    this.view.setMode(mode);
    this.update({ mode });
  }

  setScroll(scroll: ScrollGesture): void {
    this.update({ scroll, scrollDetected: true });
  }

  focus(box: WorldBox): void {
    this.view.frame(box);
  }

  fitAll(): void {
    const { placements, plans } = this.plans.snapshot();
    const box =
      union(placements.map((placement) => placement.box)) ??
      union(plans.map((plan) => flatBox(roomRect(plan)))) ??
      HOME_BOX;
    this.view.frame(box);
  }

  lookAt(x: number, z: number, animate: boolean): void {
    if (animate) this.view.centreOn(x, z);
    else this.view.jumpTo(x, z);
  }

  viewPlan(planId: string): void {
    const plan = this.plans.snapshot().plans.find((p) => p.id === planId);
    if (!plan) return;
    this.view.setMode("plan", flatBox(roomRect(plan)));
    if (this.state.mode !== "plan") this.update({ mode: "plan" });
  }

  viewFootprint(out: Float64Array): void {
    this.view.footprint(out);
  }

  targetChunk(): { readonly chunkX: number; readonly chunkZ: number } {
    return { chunkX: chunkOf(this.view.targetX()), chunkZ: chunkOf(this.view.targetZ()) };
  }

  savedView(): SavedViewV1 {
    return this.view.savedView();
  }

  restoreView(view: SavedViewV1 | null): void {
    this.view.restore(view);
    if (this.state.mode !== "orbit") this.update({ mode: "orbit" });
    this.view.apply(this.backend);
  }
}

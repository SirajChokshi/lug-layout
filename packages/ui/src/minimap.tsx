import {
  FOOTPRINT_FLOATS,
  overviewOf,
  type CatalogItemView,
  type EditorSnapshot,
  type IEditor,
  type IEditorCamera,
  type IPlanService,
  type LduRect,
  type OverviewView,
  type TrackRouteView,
} from "@brr/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePlanSnapshot } from "./plan-panel.tsx";

const OPEN_BY_DEFAULT_MIN_VIEWPORT_PX = 860;
const MAP_PADDING_PX = 10;
const MIN_SPAN_LDU = 2_560;
const TRACK_STROKE = "#3b3f45";
const TRACK_WIDTH_PX = 3;
const MODEL_FILL = "rgb(226 170 72 / 0.9)";
const MODEL_STROKE = "#8a5a14";
const ROOM_STROKE = "#5d6b7a";
const TABLE_FILL = "rgb(176 132 84 / 0.35)";
const OBSTACLE_FILL = "rgb(180 40 40 / 0.25)";
const VIEW_FILL = "rgb(31 111 235 / 0.14)";
const VIEW_STROKE = "#1f6feb";
const BACKGROUND = "#eef2f6";
const TARGET_RADIUS_PX = 2.5;
const WHEEL_STEP_PX = 100;
const PINCH_ZOOM_PER_PX = 0.01;
const PARALLEL_TANGENTS = 1e-6;

interface MapTransform {
  widthPx: number;
  heightPx: number;
  scale: number;
  originX: number;
  originZ: number;
}

type ItemKind = "ground" | "road" | "track" | "model";

const BOX_DRAW_ORDER: ReadonlyArray<ItemKind> = ["ground", "road", "model"];

function itemKind(item: CatalogItemView | undefined): ItemKind {
  if (!item) return "track";
  switch (item.kind) {
    case "baseplate":
      return "ground";
    case "road-plate":
      return "road";
    case "model":
    case "mils-module":
    case "rolling-stock":
      return "model";
    case "track":
      return "track";
    default: {
      const unhandled: never = item.kind;
      throw new Error(`unhandled catalog kind ${String(unhandled)}`);
    }
  }
}

function fitTransform(
  out: MapTransform,
  bounds: LduRect | null,
  centreX: number,
  centreZ: number,
): boolean {
  const midX = bounds ? (bounds.minX + bounds.maxX) / 2 : centreX;
  const midZ = bounds ? (bounds.minZ + bounds.maxZ) / 2 : centreZ;
  const spanX = Math.max(bounds ? bounds.maxX - bounds.minX : 0, MIN_SPAN_LDU);
  const spanZ = Math.max(bounds ? bounds.maxZ - bounds.minZ : 0, MIN_SPAN_LDU);
  const scale = Math.min(
    (out.widthPx - 2 * MAP_PADDING_PX) / spanX,
    (out.heightPx - 2 * MAP_PADDING_PX) / spanZ,
  );
  const originX = midX - out.widthPx / 2 / scale;
  const originZ = midZ - out.heightPx / 2 / scale;
  if (out.scale === scale && out.originX === originX && out.originZ === originZ) return false;
  out.scale = scale;
  out.originX = originX;
  out.originZ = originZ;
  return true;
}

function fillRect(
  context: CanvasRenderingContext2D,
  map: MapTransform,
  rect: LduRect,
  stroke: string | null,
): void {
  const x = (rect.minX - map.originX) * map.scale;
  const y = (rect.minZ - map.originZ) * map.scale;
  const w = Math.max((rect.maxX - rect.minX) * map.scale, 1);
  const h = Math.max((rect.maxZ - rect.minZ) * map.scale, 1);
  context.fillRect(x, y, w, h);
  if (stroke === null) return;
  context.strokeStyle = stroke;
  context.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

function traceRoute(context: CanvasRenderingContext2D, map: MapTransform, route: TrackRouteView) {
  const { from, to } = route;
  const fromX = (from.xLdu - map.originX) * map.scale;
  const fromY = (from.zLdu - map.originZ) * map.scale;
  const toX = (to.xLdu - map.originX) * map.scale;
  const toY = (to.zLdu - map.originZ) * map.scale;
  const fromDirX = Math.cos(from.headingRadians);
  const fromDirY = Math.sin(from.headingRadians);
  const toDirX = Math.cos(to.headingRadians);
  const toDirY = Math.sin(to.headingRadians);
  const cross = fromDirX * toDirY - fromDirY * toDirX;
  context.moveTo(fromX, fromY);
  if (Math.abs(cross) < PARALLEL_TANGENTS) {
    context.lineTo(toX, toY);
    return;
  }
  const along = ((toX - fromX) * toDirY - (toY - fromY) * toDirX) / cross;
  context.quadraticCurveTo(fromX + fromDirX * along, fromY + fromDirY * along, toX, toY);
}

function drawContent(
  context: CanvasRenderingContext2D,
  map: MapTransform,
  overview: OverviewView,
  routes: ReadonlyArray<TrackRouteView>,
  catalog: ReadonlyMap<string, CatalogItemView>,
): void {
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, map.widthPx, map.heightPx);
  context.lineWidth = 1;
  for (const room of overview.rooms) {
    context.fillStyle = "#ffffff";
    fillRect(context, map, room, ROOM_STROKE);
  }
  context.fillStyle = TABLE_FILL;
  for (const table of overview.tables) fillRect(context, map, table, null);
  context.fillStyle = OBSTACLE_FILL;
  for (const obstacle of overview.obstacles) fillRect(context, map, obstacle, null);
  for (const kind of BOX_DRAW_ORDER) {
    for (const item of overview.items) {
      const entry = catalog.get(item.ref);
      if (itemKind(entry) !== kind) continue;
      if (kind === "model") {
        context.fillStyle = MODEL_FILL;
        fillRect(context, map, item.rect, MODEL_STROKE);
      } else {
        context.fillStyle = entry?.color?.rgb ?? TRACK_STROKE;
        fillRect(context, map, item.rect, null);
      }
    }
  }
  context.beginPath();
  for (const route of routes) traceRoute(context, map, route);
  context.strokeStyle = TRACK_STROKE;
  context.lineWidth = TRACK_WIDTH_PX;
  context.lineCap = "round";
  context.stroke();
}

function drawView(
  context: CanvasRenderingContext2D,
  map: MapTransform,
  footprint: Float64Array,
): void {
  context.beginPath();
  for (let corner = 0; corner < FOOTPRINT_FLOATS - 2; corner += 2) {
    const x = ((footprint[corner] ?? 0) - map.originX) * map.scale;
    const y = ((footprint[corner + 1] ?? 0) - map.originZ) * map.scale;
    if (corner === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
  context.fillStyle = VIEW_FILL;
  context.fill();
  context.strokeStyle = VIEW_STROKE;
  context.lineWidth = 1.5;
  context.stroke();
  context.beginPath();
  context.arc(
    ((footprint[FOOTPRINT_FLOATS - 2] ?? 0) - map.originX) * map.scale,
    ((footprint[FOOTPRINT_FLOATS - 1] ?? 0) - map.originZ) * map.scale,
    TARGET_RADIUS_PX,
    0,
    Math.PI * 2,
  );
  context.fillStyle = VIEW_STROKE;
  context.fill();
}

function gestureScale(event: Event): number | null {
  return "scale" in event && typeof event.scale === "number" ? event.scale : null;
}

interface MinimapProps {
  readonly editor: IEditor;
  readonly camera: IEditorCamera;
  readonly plans: IPlanService;
  readonly snapshot: EditorSnapshot;
}

export function Minimap({ editor, camera, plans, snapshot }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [open, setOpen] = useState(() => window.innerHeight >= OPEN_BY_DEFAULT_MIN_VIEWPORT_PX);
  const planSnapshot = usePlanSnapshot(plans);
  const { overview, routes } = useMemo(
    () => ({ overview: overviewOf(planSnapshot), routes: editor.trackRoutes() }),
    [editor, planSnapshot],
  );
  const catalog = useMemo(
    () => new Map(snapshot.catalog.map((item) => [item.id, item])),
    [snapshot.catalog],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const layer = document.createElement("canvas");
    const layerContext = layer.getContext("2d");
    if (!layerContext) return;
    const footprint = new Float64Array(FOOTPRINT_FLOATS);
    const map: MapTransform = {
      widthPx: 0,
      heightPx: 0,
      scale: Number.NaN,
      originX: Number.NaN,
      originZ: Number.NaN,
    };
    const fitCanvas = (): void => {
      const pixelRatio = window.devicePixelRatio;
      map.widthPx = canvas.clientWidth;
      map.heightPx = canvas.clientHeight;
      map.scale = Number.NaN;
      canvas.width = Math.round(map.widthPx * pixelRatio);
      canvas.height = Math.round(map.heightPx * pixelRatio);
      layer.width = canvas.width;
      layer.height = canvas.height;
      layerContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };
    const resizes = new ResizeObserver(fitCanvas);
    resizes.observe(canvas);
    fitCanvas();
    let frame = 0;
    const draw = (): void => {
      frame = requestAnimationFrame(draw);
      if (map.widthPx === 0 || map.heightPx === 0) return;
      const moved = camera.viewFootprint(footprint);
      const relayout = fitTransform(
        map,
        overview.bounds,
        footprint[FOOTPRINT_FLOATS - 2] ?? 0,
        footprint[FOOTPRINT_FLOATS - 1] ?? 0,
      );
      if (!relayout && !moved) return;
      if (relayout) drawContent(layerContext, map, overview, routes, catalog);
      context.clearRect(0, 0, map.widthPx, map.heightPx);
      context.drawImage(layer, 0, 0, map.widthPx, map.heightPx);
      drawView(context, map, footprint);
    };
    draw();
    const toWorld = (event: PointerEvent): readonly [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [
        map.originX + (event.clientX - rect.left) / map.scale,
        map.originZ + (event.clientY - rect.top) / map.scale,
      ];
    };
    let dragging: number | null = null;
    let gestureLastScale = 1;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      dragging = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      const [x, z] = toWorld(event);
      camera.lookAt(x, z, true);
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (dragging !== event.pointerId) return;
      const [x, z] = toWorld(event);
      camera.lookAt(x, z, false);
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (dragging !== event.pointerId) return;
      dragging = null;
      canvas.releasePointerCapture(event.pointerId);
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      if (event.ctrlKey) camera.zoomBy(Math.exp(-event.deltaY * PINCH_ZOOM_PER_PX));
      else camera.zoomStep(-event.deltaY / WHEEL_STEP_PX);
    };
    const onGestureStart = (event: Event): void => {
      event.preventDefault();
      gestureLastScale = gestureScale(event) ?? 1;
    };
    const onGestureChange = (event: Event): void => {
      event.preventDefault();
      const scale = gestureScale(event);
      if (scale === null) return;
      camera.zoomBy(scale / gestureLastScale);
      gestureLastScale = scale;
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("gesturestart", onGestureStart);
    canvas.addEventListener("gesturechange", onGestureChange);
    return () => {
      cancelAnimationFrame(frame);
      resizes.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("gesturestart", onGestureStart);
      canvas.removeEventListener("gesturechange", onGestureChange);
    };
  }, [camera, overview, routes, catalog]);

  return (
    <details
      className="minimap"
      aria-label="Minimap"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <h2>Minimap</h2>
        <span className="minimap-legend">{overview.items.length} placed · north up</span>
      </summary>
      <canvas
        ref={canvasRef}
        title="Click or drag to move the view. The blue outline is the part of the ground the panels leave uncovered."
      />
    </details>
  );
}

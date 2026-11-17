import {
  FOOTPRINT_FLOATS,
  overviewOf,
  type CatalogItemView,
  type EditorSnapshot,
  type IEditorCamera,
  type IPlanService,
  type LduRect,
  type OverviewView,
} from "@brr/client";
import { useEffect, useMemo, useRef } from "react";
import { usePlanSnapshot } from "./plan-panel.tsx";

const MAP_WIDTH_PX = 240;
const MAP_HEIGHT_PX = 168;
const MAP_PADDING_PX = 10;
const MIN_SPAN_LDU = 2_560;
const TRACK_FILL = "#4a4f57";
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

interface MapTransform {
  readonly scale: number;
  readonly originX: number;
  readonly originZ: number;
}

type ItemKind = "ground" | "road" | "track" | "model";

const DRAW_ORDER: ReadonlyArray<ItemKind> = ["ground", "road", "track", "model"];

function itemKind(item: CatalogItemView | undefined): ItemKind {
  if (!item) return "track";
  switch (item.kind) {
    case "baseplate":
      return "ground";
    case "road-plate":
      return "road";
    case "model":
    case "mils-module":
      return "model";
    case "track":
      return "track";
    default: {
      const unhandled: never = item.kind;
      throw new Error(`unhandled catalog kind ${String(unhandled)}`);
    }
  }
}

function transformFor(bounds: LduRect | null, centreX: number, centreZ: number): MapTransform {
  const midX = bounds ? (bounds.minX + bounds.maxX) / 2 : centreX;
  const midZ = bounds ? (bounds.minZ + bounds.maxZ) / 2 : centreZ;
  const spanX = Math.max(bounds ? bounds.maxX - bounds.minX : 0, MIN_SPAN_LDU);
  const spanZ = Math.max(bounds ? bounds.maxZ - bounds.minZ : 0, MIN_SPAN_LDU);
  const scale = Math.min(
    (MAP_WIDTH_PX - 2 * MAP_PADDING_PX) / spanX,
    (MAP_HEIGHT_PX - 2 * MAP_PADDING_PX) / spanZ,
  );
  return {
    scale,
    originX: midX - MAP_WIDTH_PX / 2 / scale,
    originZ: midZ - MAP_HEIGHT_PX / 2 / scale,
  };
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

function drawContent(
  context: CanvasRenderingContext2D,
  map: MapTransform,
  overview: OverviewView,
  catalog: ReadonlyMap<string, CatalogItemView>,
): void {
  context.fillStyle = BACKGROUND;
  context.fillRect(0, 0, MAP_WIDTH_PX, MAP_HEIGHT_PX);
  context.lineWidth = 1;
  for (const room of overview.rooms) {
    context.fillStyle = "#ffffff";
    fillRect(context, map, room, ROOM_STROKE);
  }
  context.fillStyle = TABLE_FILL;
  for (const table of overview.tables) fillRect(context, map, table, null);
  context.fillStyle = OBSTACLE_FILL;
  for (const obstacle of overview.obstacles) fillRect(context, map, obstacle, null);
  for (const kind of DRAW_ORDER) {
    for (const item of overview.items) {
      const entry = catalog.get(item.ref);
      if (itemKind(entry) !== kind) continue;
      if (kind === "model") {
        context.fillStyle = MODEL_FILL;
        fillRect(context, map, item.rect, MODEL_STROKE);
      } else {
        context.fillStyle = kind === "track" ? TRACK_FILL : (entry?.color?.rgb ?? TRACK_FILL);
        fillRect(context, map, item.rect, null);
      }
    }
  }
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

function sameFootprint(a: Float64Array, b: Float64Array): boolean {
  for (let i = 0; i < FOOTPRINT_FLOATS; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface MinimapProps {
  readonly camera: IEditorCamera;
  readonly plans: IPlanService;
  readonly snapshot: EditorSnapshot;
}

export function Minimap({ camera, plans, snapshot }: MinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const planSnapshot = usePlanSnapshot(plans);
  const overview = useMemo(() => overviewOf(planSnapshot), [planSnapshot]);
  const catalog = useMemo(
    () => new Map(snapshot.catalog.map((item) => [item.id, item])),
    [snapshot.catalog],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const pixelRatio = window.devicePixelRatio;
    canvas.width = Math.round(MAP_WIDTH_PX * pixelRatio);
    canvas.height = Math.round(MAP_HEIGHT_PX * pixelRatio);
    const layer = document.createElement("canvas");
    layer.width = canvas.width;
    layer.height = canvas.height;
    const layerContext = layer.getContext("2d");
    if (!layerContext) return;
    layerContext.scale(pixelRatio, pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    const footprint = new Float64Array(FOOTPRINT_FLOATS);
    const drawn = new Float64Array(FOOTPRINT_FLOATS).fill(Number.NaN);
    let map: MapTransform | null = null;
    let frame = 0;
    const draw = (): void => {
      frame = requestAnimationFrame(draw);
      camera.viewFootprint(footprint);
      const centreX = footprint[FOOTPRINT_FLOATS - 2] ?? 0;
      const centreZ = footprint[FOOTPRINT_FLOATS - 1] ?? 0;
      const next = transformFor(overview.bounds, centreX, centreZ);
      const relayout =
        map === null ||
        next.scale !== map.scale ||
        next.originX !== map.originX ||
        next.originZ !== map.originZ;
      if (!relayout && sameFootprint(footprint, drawn)) return;
      if (relayout) {
        map = next;
        drawContent(layerContext, next, overview, catalog);
      }
      drawn.set(footprint);
      context.clearRect(0, 0, MAP_WIDTH_PX, MAP_HEIGHT_PX);
      context.drawImage(layer, 0, 0, MAP_WIDTH_PX, MAP_HEIGHT_PX);
      drawView(context, next, footprint);
    };
    draw();
    const toWorld = (event: PointerEvent): readonly [number, number] | null => {
      if (!map) return null;
      const rect = canvas.getBoundingClientRect();
      return [
        map.originX + (event.clientX - rect.left) / map.scale,
        map.originZ + (event.clientY - rect.top) / map.scale,
      ];
    };
    let dragging: number | null = null;
    const onPointerDown = (event: PointerEvent): void => {
      const world = toWorld(event);
      if (!world || event.button !== 0) return;
      dragging = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      camera.lookAt(world[0], world[1], true);
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (dragging !== event.pointerId) return;
      const world = toWorld(event);
      if (world) camera.lookAt(world[0], world[1], false);
    };
    const onPointerUp = (event: PointerEvent): void => {
      if (dragging !== event.pointerId) return;
      dragging = null;
      canvas.releasePointerCapture(event.pointerId);
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      camera.zoomStep(-event.deltaY / WHEEL_STEP_PX);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
    };
  }, [camera, overview, catalog]);

  return (
    <section className="minimap" aria-label="Minimap">
      <canvas
        ref={canvasRef}
        style={{ width: MAP_WIDTH_PX, height: MAP_HEIGHT_PX }}
        title="Click or drag to move the view. The blue outline is what the camera sees."
      />
      <span className="minimap-legend">{overview.items.length} placed · north up, +x right</span>
    </section>
  );
}

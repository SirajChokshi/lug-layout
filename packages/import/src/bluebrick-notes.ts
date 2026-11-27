import {
  STUD_LDU,
  addExactRational,
  divideExactRational,
  exactRational,
  exactRationalEquals,
  exactRationalFromDecimal,
  exactRationalToFloat64,
  floorExactRational,
  meanExactRational,
  multiplyExactRational,
  parseExactDecimal,
  subtractExactRational,
  type ExactRational,
} from "@brr/math";
import type {
  BlueBrickAreaLayer,
  BlueBrickBrickRef,
  BlueBrickColor,
  BlueBrickDecimal,
  BlueBrickMap,
  BlueBrickPoint,
} from "@brr/schema/bluebrick";
import { decode, issueText } from "@brr/schema/decode";
import {
  BASE_LAYER,
  BASE_LAYER_ID,
  EventRecordV2,
  Label,
  NoteRecordV2,
  ZONE_VERTEX_MAX,
  canonicalOutline,
  type LayerRecordV2,
  type PointEndV2,
  type StudPoint,
} from "@brr/schema/world";
import webColors from "./dotnet-web-colors.json" with { type: "json" };

export type BlueBrickNoteAnchor = "center" | "from" | "to";

export type BlueBrickNoteIssue =
  | { readonly kind: "gridLayer"; readonly layer: number }
  | { readonly kind: "renamedLayer"; readonly layer: number; readonly name: string }
  | { readonly kind: "ungrouped"; readonly layer: number; readonly groups: number }
  | {
      readonly kind: "moved";
      readonly layer: number;
      readonly item: number;
      readonly at: BlueBrickNoteAnchor;
      readonly dx: number;
      readonly dz: number;
    }
  | {
      readonly kind: "turned";
      readonly layer: number;
      readonly item: number;
      readonly degrees: BlueBrickDecimal;
    }
  | {
      readonly kind: "detached";
      readonly layer: number;
      readonly item: number;
      readonly end: "from" | "to";
      readonly brick: BlueBrickBrickRef;
    }
  | { readonly kind: "circularRuler"; readonly layer: number; readonly item: number }
  | {
      readonly kind: "unknownColor";
      readonly layer: number;
      readonly item: number;
      readonly name: string;
    }
  | {
      readonly kind: "refused";
      readonly layer: number;
      readonly item: number;
      readonly reason: string;
    }
  | { readonly kind: "eventField"; readonly field: string; readonly reason: string };

export interface BlueBrickNotes {
  readonly layers: ReadonlyArray<LayerRecordV2>;
  readonly layerIds: ReadonlyArray<number | null>;
  readonly notes: ReadonlyArray<NoteRecordV2>;
  readonly event: EventRecordV2 | null;
  readonly issues: ReadonlyArray<BlueBrickNoteIssue>;
}

type GridPoint = readonly [number, number];

interface Step {
  readonly point: GridPoint;
  readonly direction: number;
}

interface Exit {
  readonly point: GridPoint;
  directions: number;
  walked: number;
}

interface Rounded {
  readonly value: number;
  readonly shift: number;
  readonly exact: boolean;
}

const POINTS_PER_INCH = 72;
const BLUEBRICK_TEXT_PIXELS_PER_INCH = 96;
const DEGREES_PER_QUARTER_TURN = 90;
const QUARTER_TURNS = 4;
const HALF = exactRational(1n, 2n);
const LDU_PER_STUD = exactRational(BigInt(STUD_LDU), 1n);
const RGB_MASK = 0xff_ffff;
const HEX_RADIX = 16;
const RGB_HEX_DIGITS = 6;
const WEB_COLORS: ReadonlyMap<string, string> = new Map(Object.entries(webColors));
const STEPS: ReadonlyArray<GridPoint> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
const CELL_EDGES: ReadonlyArray<{ readonly from: GridPoint; readonly across: GridPoint }> = [
  { from: [0, 0], across: [0, -1] },
  { from: [1, 0], across: [1, 0] },
  { from: [1, 1], across: [0, 1] },
  { from: [0, 1], across: [-1, 0] },
];
const LEFT_THEN_STRAIGHT_THEN_RIGHT = [1, 0, 3] as const;

function pointKey(point: GridPoint): string {
  return `${point[0]},${point[1]}`;
}

function stepOf(direction: number): GridPoint {
  const step = STEPS[direction];
  if (!step) throw new Error(`${direction} is not a grid direction`);
  return step;
}

function turn(directions: number, incoming: number): number {
  for (const offset of LEFT_THEN_STRAIGHT_THEN_RIGHT) {
    const direction = (incoming + offset) % QUARTER_TURNS;
    if ((directions & (1 << direction)) !== 0) return direction;
  }
  throw new Error("an area boundary dead-ends");
}

function boundaryLoops(cells: ReadonlyArray<GridPoint>): Step[][] {
  const filled = new Set(cells.map(pointKey));
  const exits = new Map<string, Exit>();
  for (const [x, y] of cells) {
    CELL_EDGES.forEach(({ from, across }, direction) => {
      if (filled.has(pointKey([x + across[0], y + across[1]]))) return;
      const point: GridPoint = [x + from[0], y + from[1]];
      const exit = exits.get(pointKey(point)) ?? { point, directions: 0, walked: 0 };
      exit.directions |= 1 << direction;
      exits.set(pointKey(point), exit);
    });
  }
  const loops: Step[][] = [];
  for (const start of exits.values()) {
    for (let first = 0; first < QUARTER_TURNS; first++) {
      if ((start.directions & ~start.walked & (1 << first)) === 0) continue;
      const loop: Step[] = [];
      let at = start;
      let direction = first;
      do {
        at.walked |= 1 << direction;
        loop.push({ point: at.point, direction });
        const [dx, dy] = stepOf(direction);
        const next = exits.get(pointKey([at.point[0] + dx, at.point[1] + dy]));
        if (!next) throw new Error("an area boundary doesn't close");
        at = next;
        direction = turn(at.directions, direction);
      } while (at !== start || direction !== first);
      loops.push(loop);
    }
  }
  return loops;
}

function corners(loop: ReadonlyArray<Step>): GridPoint[] {
  return loop
    .filter((step, i) => step.direction !== loop.at(i - 1)?.direction)
    .map((step) => step.point);
}

function twiceArea(points: ReadonlyArray<GridPoint>): number {
  const [originX, originY] = points[0] ?? [0, 0];
  let sum = 0;
  points.forEach(([x, y], i) => {
    const [nextX, nextY] = points[(i + 1) % points.length] ?? [x, y];
    sum += (x - originX) * (nextY - originY) - (nextX - originX) * (y - originY);
  });
  return sum;
}

function leftmost(points: ReadonlyArray<GridPoint>): number {
  return points.reduce((least, [x]) => Math.min(least, x), Number.POSITIVE_INFINITY);
}

function revisitedColumn(loop: ReadonlyArray<Step>): number | null {
  const seen = new Set<string>();
  for (const { point } of loop) {
    if (seen.has(pointKey(point))) return point[0];
    seen.add(pointKey(point));
  }
  return null;
}

function cutColumn(cells: ReadonlyArray<GridPoint>, loops: ReadonlyArray<Step[]>): number | null {
  for (const loop of loops) {
    const points = corners(loop);
    if (twiceArea(points) < 0) return leftmost(points);
    const revisited = revisitedColumn(loop);
    if (revisited !== null) return revisited;
  }
  const [only] = loops;
  if (only && corners(only).length <= ZONE_VERTEX_MAX) return null;
  const least = leftmost(cells);
  const most = cells.reduce((greatest, [x]) => Math.max(greatest, x), least);
  return least + Math.floor((most - least + 1) / 2);
}

function components(cells: ReadonlyArray<GridPoint>): GridPoint[][] {
  const unvisited = new Map(cells.map((cell) => [pointKey(cell), cell]));
  const found: GridPoint[][] = [];
  for (const seed of cells) {
    if (!unvisited.delete(pointKey(seed))) continue;
    const component = [seed];
    for (let i = 0; i < component.length; i++) {
      const [x, y] = component[i] ?? seed;
      for (const [dx, dy] of STEPS) {
        const key = pointKey([x + dx, y + dy]);
        const neighbour = unvisited.get(key);
        if (!neighbour) continue;
        unvisited.delete(key);
        component.push(neighbour);
      }
    }
    found.push(component);
  }
  return found;
}

function simpleOutlines(cells: ReadonlyArray<GridPoint>): GridPoint[][] {
  const outlines: GridPoint[][] = [];
  const pending = components(cells);
  for (let piece = pending.pop(); piece; piece = pending.pop()) {
    const loops = boundaryLoops(piece);
    const cut = cutColumn(piece, loops);
    const [only] = loops;
    if (cut === null) {
      if (only) outlines.push(corners(only));
      continue;
    }
    pending.push(
      ...components(piece.filter(([x]) => x < cut)),
      ...components(piece.filter(([x]) => x >= cut)),
    );
  }
  return outlines;
}

function zonesOf(layer: BlueBrickAreaLayer): Array<{ rgb: number; outline: StudPoint[] }> {
  const byColor = new Map<number, GridPoint[]>();
  for (const { x, y, rgb } of layer.cells) {
    const cells = byColor.get(rgb) ?? [];
    cells.push([x, y]);
    byColor.set(rgb, cells);
  }
  const cellLdu = layer.cellSize * STUD_LDU;
  return [...byColor].flatMap(([rgb, cells]) =>
    simpleOutlines(cells).map((outline) => ({
      rgb,
      outline: canonicalOutline(outline.map(([x, y]) => [x * cellLdu + 0, y * cellLdu + 0])),
    })),
  );
}

function hexRgb(rgb: number): string {
  return `#${(rgb & RGB_MASK).toString(HEX_RADIX).padStart(RGB_HEX_DIGITS, "0")}`;
}

function rgbOf(color: BlueBrickColor): string | null {
  switch (color.kind) {
    case "argb":
      return hexRgb(color.argb);
    case "named":
      return WEB_COLORS.get(color.name.toLowerCase()) ?? null;
    default: {
      const unhandled: never = color;
      throw new Error(`unhandled ${String(unhandled)}`);
    }
  }
}

function exact(text: BlueBrickDecimal): ExactRational {
  return exactRationalFromDecimal(parseExactDecimal(text));
}

function middle(start: BlueBrickDecimal, size: BlueBrickDecimal): ExactRational {
  const from = exact(start);
  return meanExactRational(from, addExactRational(from, exact(size)));
}

function nearest(value: ExactRational, step: number): Rounded {
  const steps = divideExactRational(value, exactRational(BigInt(step), 1n));
  const rounded = exactRational(floorExactRational(addExactRational(steps, HALF)), 1n);
  return {
    value: Number(rounded.numerator) * step,
    shift: exactRationalToFloat64(subtractExactRational(rounded, steps)) * step,
    exact: exactRationalEquals(rounded, steps),
  };
}

function inLdu(studs: ExactRational, stepLdu: number): Rounded {
  return nearest(multiplyExactRational(studs, LDU_PER_STUD), stepLdu);
}

function pointEnd(point: BlueBrickPoint): { end: PointEndV2; x: Rounded; z: Rounded } {
  const x = inLdu(exact(point.x), 1);
  const z = inLdu(exact(point.y), 1);
  return { end: { on: "point", x: x.value, z: z.value }, x, z };
}

function quarterTurnOf(clockwiseDegrees: number): number {
  const clockwise = clockwiseDegrees / DEGREES_PER_QUARTER_TURN;
  return ((-clockwise % QUARTER_TURNS) + QUARTER_TURNS) % QUARTER_TURNS;
}

function digits(value: number, count: number): string {
  return String(value).padStart(count, "0");
}

function isoDate({ year, month, day }: BlueBrickMap["properties"]["date"]): string {
  return `${digits(year, 4)}-${digits(month, 2)}-${digits(day, 2)}`;
}

function eventOf(
  properties: BlueBrickMap["properties"],
  issues: BlueBrickNoteIssue[],
): EventRecordV2 | null {
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["author", properties.author],
    ["club", properties.lug],
    ["event", properties.event],
    ["startDate", isoDate(properties.date)],
    ["comment", properties.comment],
  ];
  const kept = fields
    .filter(([, text]) => text.trim() !== "")
    .flatMap(([field, text]) => {
      const read = decode(EventRecordV2, { [field]: text }, "event");
      if (read.ok) return [read.value];
      issues.push({ kind: "eventField", field, reason: issueText(read.issues) });
      return [];
    });
  return kept.length === 0 ? null : kept.reduce((event, field) => ({ ...event, ...field }));
}

function layerTable(
  map: BlueBrickMap,
  issues: BlueBrickNoteIssue[],
): Pick<BlueBrickNotes, "layers" | "layerIds"> {
  const firstBrickLayer = map.layers.findIndex((layer) => layer.kind === "brick");
  const layers: LayerRecordV2[] = firstBrickLayer === -1 ? [BASE_LAYER] : [];
  const layerIds: Array<number | null> = [];
  let nextId = BASE_LAYER_ID + 1;
  map.layers.forEach((layer, position) => {
    if (layer.kind === "grid") {
      layerIds.push(null);
      issues.push({ kind: "gridLayer", layer: position });
      return;
    }
    const id = position === firstBrickLayer ? BASE_LAYER_ID : nextId++;
    const named = decode(Label, layer.name).ok;
    const name = named ? layer.name : `Layer ${position + 1}`;
    if (!named && layer.name.trim() !== "") {
      issues.push({ kind: "renamedLayer", layer: position, name });
    }
    layerIds.push(id);
    layers.push({
      id,
      name,
      kind: layer.kind === "brick" ? "parts" : "notes",
      visible: layer.visible,
      locked: false,
      opacity: layer.opacity,
    });
  });
  return { layers, layerIds };
}

function moved(
  layer: number,
  item: number,
  at: BlueBrickNoteAnchor,
  x: Rounded,
  z: Rounded,
): BlueBrickNoteIssue[] {
  return x.exact && z.exact ? [] : [{ kind: "moved", layer, item, at, dx: x.shift, dz: z.shift }];
}

export function blueBrickNotes(map: BlueBrickMap): BlueBrickNotes {
  const issues: BlueBrickNoteIssue[] = [];
  const notes: NoteRecordV2[] = [];
  const { layers, layerIds } = layerTable(map, issues);
  const add = (layer: number, item: number, note: NoteRecordV2): boolean => {
    const read = decode(NoteRecordV2, note, `layers[${layer}][${item}]`);
    if (read.ok) notes.push(read.value);
    else issues.push({ kind: "refused", layer, item, reason: issueText(read.issues) });
    return read.ok;
  };
  const colorOf = (layer: number, item: number, color: BlueBrickColor): string | null => {
    const rgb = rgbOf(color);
    if (rgb === null && color.kind === "named") {
      issues.push({ kind: "unknownColor", layer, item, name: color.name });
    }
    return rgb;
  };
  map.layers.forEach((layer, position) => {
    const id = layerIds[position];
    if (id === null || id === undefined) return;
    if ((layer.kind === "text" || layer.kind === "ruler") && layer.groups.length > 0) {
      issues.push({ kind: "ungrouped", layer: position, groups: layer.groups.length });
    }
    switch (layer.kind) {
      case "grid":
      case "brick":
        return;
      case "area": {
        const name = layers.find((row) => row.id === id)?.name ?? layer.name;
        zonesOf(layer).forEach(({ rgb, outline }, item) => {
          add(position, item, {
            kind: "zone",
            index: notes.length,
            layer: id,
            name,
            color: hexRgb(rgb),
            outline,
          });
        });
        return;
      }
      case "text":
        layer.texts.forEach((text, item) => {
          const color = colorOf(position, item, text.color);
          if (color === null) return;
          const x = inLdu(middle(text.area.x, text.area.width), STUD_LDU);
          const z = inLdu(middle(text.area.y, text.area.height), STUD_LDU);
          const turned = nearest(exact(text.orientation), DEGREES_PER_QUARTER_TURN);
          const added = add(position, item, {
            kind: "text",
            index: notes.length,
            layer: id,
            text: text.text,
            x: x.value,
            z: z.value,
            rot: quarterTurnOf(turned.value),
            heightStuds: Math.round(
              (text.font.size * BLUEBRICK_TEXT_PIXELS_PER_INCH) / POINTS_PER_INCH,
            ),
            color,
          });
          if (!added) return;
          issues.push(...moved(position, item, "center", x, z));
          if (!turned.exact) {
            issues.push({ kind: "turned", layer: position, item, degrees: text.orientation });
          }
        });
        return;
      case "ruler":
        layer.rulers.forEach((ruler, item) => {
          if (ruler.shape === "circular") {
            issues.push({ kind: "circularRuler", layer: position, item });
            return;
          }
          const color = colorOf(position, item, ruler.color);
          if (color === null) return;
          const from = pointEnd(ruler.from);
          const to = pointEnd(ruler.to);
          const note: NoteRecordV2 = {
            kind: "ruler",
            index: notes.length,
            layer: id,
            from: from.end,
            to: to.end,
            color,
          };
          if (!add(position, item, note)) return;
          issues.push(
            ...moved(position, item, "from", from.x, from.z),
            ...moved(position, item, "to", to.x, to.z),
          );
          const attachments = [
            ["from", ruler.fromAttachment],
            ["to", ruler.toAttachment],
          ] as const;
          for (const [end, brick] of attachments) {
            if (brick) issues.push({ kind: "detached", layer: position, item, end, brick });
          }
        });
        return;
      default: {
        const unhandled: never = layer;
        throw new Error(`unhandled ${String(unhandled)}`);
      }
    }
  });
  return { layers, layerIds, notes, event: eventOf(map.properties, issues), issues };
}

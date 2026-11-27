import type { Box, DrawItem, Paint, Point } from "./draw-list.ts";
import type { SheetLayerId } from "./plan-drawing.ts";
import type { LegendEntry } from "./sheet-blocks.ts";
import { PAINTS, SMALL_MM, textStyle } from "./sheet-paints.ts";

export type LegendExtra = "issue" | "tile" | "registration" | "seam";

const REGISTRATION_RING = 0.6;

function swatchRect(paint: Paint, role = "swatch"): (box: Box) => DrawItem[] {
  return (box) => [{ kind: "rect", role, paint, box }];
}

function middleLine(box: Box, paint: Paint): DrawItem {
  const y = box.y + box.height / 2;
  return { kind: "line", role: "swatch", paint, from: [box.x, y], to: [box.x + box.width, y] };
}

export function registrationMark(center: Point, halfMm: number, role = "registration"): DrawItem[] {
  const [x, y] = center;
  return [
    {
      kind: "circle",
      role,
      paint: PAINTS.registration,
      center,
      radius: halfMm * REGISTRATION_RING,
    },
    {
      kind: "line",
      role,
      paint: PAINTS.registration,
      from: [x - halfMm, y],
      to: [x + halfMm, y],
    },
    {
      kind: "line",
      role,
      paint: PAINTS.registration,
      from: [x, y - halfMm],
      to: [x, y + halfMm],
    },
  ];
}

const LAYER_ENTRIES: Readonly<Record<SheetLayerId, LegendEntry>> = {
  room: { label: "Room walls", swatch: swatchRect(PAINTS.room) },
  tables: { label: "Table top", swatch: swatchRect(PAINTS.table) },
  obstacles: {
    label: "Obstacle",
    swatch: (box) => [
      { kind: "rect", role: "swatch", paint: PAINTS.obstacle, box },
      {
        kind: "line",
        role: "swatch",
        paint: PAINTS.hatch,
        from: [box.x + box.height, box.y],
        to: [box.x, box.y + box.height],
      },
      {
        kind: "line",
        role: "swatch",
        paint: PAINTS.hatch,
        from: [box.x + box.width, box.y],
        to: [box.x + box.width - box.height, box.y + box.height],
      },
    ],
  },
  roadway: { label: "Roadway (road surface)", swatch: swatchRect(PAINTS.roadway) },
  models: { label: "Model footprint", swatch: swatchRect(PAINTS.model) },
  track: { label: "Track piece outline", swatch: swatchRect(PAINTS.track) },
  ramps: { label: "Suggested ramp, not counted", swatch: swatchRect(PAINTS.ramp) },
  dimensions: {
    label: "Dimension in studs and cm",
    swatch: (box) => [
      middleLine(box, PAINTS.dimension),
      {
        kind: "line",
        role: "swatch",
        paint: PAINTS.dimension,
        from: [box.x, box.y],
        to: [box.x, box.y + box.height],
      },
      {
        kind: "line",
        role: "swatch",
        paint: PAINTS.dimension,
        from: [box.x + box.width, box.y],
        to: [box.x + box.width, box.y + box.height],
      },
    ],
  },
  numbers: {
    label: "Placement number (see key)",
    swatch: (box) => {
      const center: Point = [box.x + box.height / 2, box.y + box.height / 2];
      return [
        { kind: "circle", role: "swatch", paint: PAINTS.number, center, radius: box.height / 2 },
        {
          kind: "text",
          role: "swatch",
          style: textStyle(SMALL_MM * 0.8, { anchor: "middle", bold: true }),
          at: [center[0], center[1] + SMALL_MM * 0.3],
          text: "1",
          turn: "none",
        },
      ];
    },
  },
};

const EXTRA_ENTRIES: Readonly<Record<LegendExtra, LegendEntry>> = {
  issue: { label: "Placement with a plan issue", swatch: swatchRect(PAINTS.modelFlagged) },
  tile: { label: "Tile page, by column and row", swatch: swatchRect(PAINTS.tileCell) },
  registration: {
    label: "Registration mark: align pages",
    swatch: (box) =>
      registrationMark([box.x + box.width / 2, box.y + box.height / 2], box.height / 2, "swatch"),
  },
  seam: { label: "Seam: trim one page along it", swatch: (box) => [middleLine(box, PAINTS.seam)] },
};

export function legendEntries(
  layers: ReadonlyArray<SheetLayerId>,
  extras: ReadonlyArray<LegendExtra>,
): ReadonlyArray<LegendEntry> {
  return [
    ...layers.map((layer) => LAYER_ENTRIES[layer]),
    ...extras.map((extra) => EXTRA_ENTRIES[extra]),
  ];
}

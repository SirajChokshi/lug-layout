import type { PartBundle } from "@brr/catalog";
import type { PartRole } from "@brr/schema/bundle";
import { footprintOf, plateDepthBelowOrigin, type PartFootprint } from "./part-footprint.ts";
import { World } from "@brr/domain";
import { CHUNK_LDU, STUD_LDU } from "@brr/math";
import { ModuleWriter } from "./placements.ts";
import type { ColorTable } from "./viewer-scene.ts";

const SLOT_CELLS = 6;
const BRICK_AREA_FIRST_CELL = 20;
const BRICK_AREA_COLUMNS = 2;
const STACK_LAYERS = 3;
const TRACK_ROW_CHUNK_Z = 1;
const TRACK_GAP_LDU = 40;

const DISPLAY_COLORS = {
  ground: "Green",
  track: "Dark_Bluish_Grey",
  bricks: [
    "Red",
    "White",
    "Blue",
    "Yellow",
    "Tan",
    "Light_Bluish_Grey",
    "Reddish_Brown",
    "Dark_Tan",
    "Black",
  ],
} as const;

const BRICK_ROLES: ReadonlySet<PartRole> = new Set<PartRole>(["wall", "roof", "detail"]);

function slotOrigin(slotStartCell: number, spanStuds: number): number {
  const offsetCells = Math.floor((SLOT_CELLS - spanStuds) / 2);
  return (slotStartCell + offsetCells) * STUD_LDU + (spanStuds * STUD_LDU) / 2;
}

function partWithRole(bundle: PartBundle, role: PartRole): number {
  const index = bundle.parts.findIndex((part) => part.role === role);
  if (index < 0) throw new Error(`bundle has no ${role} part for the display`);
  return index;
}

export function buildPartDisplay(bundle: PartBundle, colors: ColorTable): World {
  const half = CHUNK_LDU / 2;
  const world = new World();
  const studded = new ModuleWriter(world, 0, 0);
  studded.push(
    partWithRole(bundle, "ground"),
    colors.indexOfName(DISPLAY_COLORS.ground),
    half,
    half,
    0,
    0,
  );

  const trackColor = colors.indexOfName(DISPLAY_COLORS.track);
  const trackRow = new ModuleWriter(world, 0, TRACK_ROW_CHUNK_Z);
  let trackEdgeX = 0;
  bundle.parts.forEach((part, index) => {
    if (part.role !== "track" && part.role !== "crossing") return;
    const [minX, , minZ] = part.boundsMin;
    const [maxX] = part.boundsMax;
    const x = Math.ceil(trackEdgeX - minX);
    trackRow.push(
      index,
      trackColor,
      x,
      Math.ceil(TRACK_GAP_LDU - minZ),
      plateDepthBelowOrigin(part),
      0,
    );
    trackEdgeX = x + maxX + TRACK_GAP_LDU;
  });

  const bricks: PartFootprint[] = [];
  bundle.parts.forEach((part, index) => {
    if (BRICK_ROLES.has(part.role)) bricks.push(footprintOf(part, index));
  });
  bricks.forEach((brick, slot) => {
    const column = slot % BRICK_AREA_COLUMNS;
    const row = Math.floor(slot / BRICK_AREA_COLUMNS);
    const x = slotOrigin(BRICK_AREA_FIRST_CELL + column * SLOT_CELLS, brick.widthStuds);
    const z = slotOrigin(1 + row * SLOT_CELLS, brick.depthStuds);
    for (let layer = 0; layer < STACK_LAYERS; layer++) {
      const color = DISPLAY_COLORS.bricks[(slot + layer) % DISPLAY_COLORS.bricks.length] ?? "Red";
      studded.push(
        brick.index,
        colors.indexOfName(color),
        x,
        z,
        (layer + 1) * brick.heightPlates,
        0,
      );
    }
  });

  let roadChunk = 1;
  bundle.parts.forEach((part, index) => {
    if (part.role !== "road") return;
    if (part.producedColor === undefined) {
      throw new Error(`${part.id}: road plates need a sourced produced colour in palette.json`);
    }
    const road = new ModuleWriter(world, roadChunk, 0);
    road.push(index, colors.indexOfCode(part.producedColor), half, half, 0, 0);
    roadChunk++;
  });
  return world;
}

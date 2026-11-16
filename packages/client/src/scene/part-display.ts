import type { PartBundle, PartRole } from "@brr/catalog";
import { footprintOf, plateDepthBelowOrigin, type PartFootprint } from "./part-footprint.ts";
import { CHUNK_LDU, PlacementWriter, STUD_LDU, type ChunkPlacements } from "./placements.ts";
import type { ColorTable } from "./viewer-scene.ts";

const SLOT_CELLS = 6;
const BRICK_AREA_FIRST_CELL = 20;
const BRICK_AREA_COLUMNS = 2;
const STACK_LAYERS = 3;
const TRACK_ORIGIN_X_LDU = 200;
const TRACK_FIRST_ORIGIN_Z_LDU = 120;
const TRACK_SPACING_Z_LDU = 220;

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

export function buildPartDisplay(bundle: PartBundle, colors: ColorTable): ChunkPlacements[] {
  const half = CHUNK_LDU / 2;
  const studded = new PlacementWriter();
  studded.push(
    partWithRole(bundle, "ground"),
    colors.indexOfName(DISPLAY_COLORS.ground),
    half,
    half,
    0,
    0,
  );

  const trackColor = colors.indexOfName(DISPLAY_COLORS.track);
  let trackRow = 0;
  bundle.parts.forEach((part, index) => {
    if (part.role !== "track") return;
    const z = TRACK_FIRST_ORIGIN_Z_LDU + trackRow * TRACK_SPACING_Z_LDU;
    studded.push(index, trackColor, TRACK_ORIGIN_X_LDU, z, plateDepthBelowOrigin(part), 0);
    trackRow++;
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

  const chunks = [studded.finish(0, 0)];
  bundle.parts.forEach((part, index) => {
    if (part.role !== "road") return;
    if (part.producedColor === undefined) {
      throw new Error(`${part.id}: road plates need a sourced produced colour in palette.json`);
    }
    const road = new PlacementWriter();
    road.push(index, colors.indexOfCode(part.producedColor), half, half, 0, 0);
    chunks.push(road.finish(chunks.length, 0));
  });
  return chunks;
}

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LevelCrossingRecipe,
  type LevelCrossingEvidence,
  type LevelCrossingSlope,
  type Palette,
  type TrackSystem,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { compose, type Affine } from "../ldraw/affine.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";
import {
  isStudPrimitive,
  normalizeReference,
  parseLdraw,
  splitMultiPart,
  subfilePlacement,
} from "../ldraw/parse.ts";
import { walkPart } from "../ldraw/walk.ts";
import { CERTIFIED_RESIDUAL_LIMIT_LDU } from "../track/track-ends.ts";
import { measureBaseplate, measureRails } from "../verify/geometry.ts";

const MOVED_TITLE = "~Moved to ";
const RAIL_SECTION_X = 20;
const QUARTER_TURNS_BUNDLE = [
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
  [0, 0, 1, 0, 1, 0, -1, 0, 0],
  [-1, 0, 0, 0, 1, 0, 0, 0, -1],
  [0, 0, -1, 0, 1, 0, 1, 0, 0],
] as const;
const RECIPE_PATH = fileURLToPath(
  new URL("../../../../docs/verified-facts/level-crossing.json", import.meta.url),
);

export const LEVEL_CROSSING_FILE = "level-crossing.json";

export interface CrossingSource {
  readonly model: string;
  readonly section: string;
  readonly trackPart: string;
  readonly trackSystem: TrackSystem;
  readonly use: "recipe" | "cross-check";
}

export interface CrossingSpec {
  readonly part: string;
  readonly sources: ReadonlyArray<CrossingSource>;
}

export const LEVEL_CROSSING_SPEC: CrossingSpec = {
  part: "4515",
  sources: [
    {
      model: "10128-1",
      section: "10128 - level crossing.ldr",
      trackPart: "74746",
      trackSystem: "lego-9v",
      use: "recipe",
    },
    {
      model: "7936-1",
      section: "7936 - crossing.ldr",
      trackPart: "53401",
      trackSystem: "lego-plastic",
      use: "cross-check",
    },
  ],
};

interface PartInstance {
  readonly part: string;
  readonly transform: Affine;
}

interface SlopeGeometry {
  readonly halfX: number;
  readonly halfZ: number;
  readonly riseLdu: number;
  readonly lowLipLdu: number;
  readonly highEdgeZ: number;
  readonly bottomY: number;
}

interface SourceReading {
  readonly evidence: LevelCrossingEvidence;
  readonly slopes: ReadonlyArray<LevelCrossingSlope>;
  readonly trackHalfWidthLdu: number;
  readonly railTopAboveBedLdu: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function whole(value: number, what: string): number {
  const rounded = Math.round(value);
  if (Math.abs(value - rounded) > CERTIFIED_RESIDUAL_LIMIT_LDU) {
    throw new Error(
      `${what} is ${value}, not within ${CERTIFIED_RESIDUAL_LIMIT_LDU} of a whole LDU`,
    );
  }
  return rounded + 0;
}

function resolveMoved(library: LdrawLibrary, instance: PartInstance): PartInstance {
  const file = library.load(`${instance.part}.dat`);
  if (!file?.header.title.startsWith(MOVED_TITLE)) return instance;
  const lines = file.lines.filter((line) => line.kind === "subfile");
  const [target] = lines;
  if (lines.length !== 1 || !target || target.kind !== "subfile") {
    throw new Error(`${instance.part}.dat is a moved stub without exactly one subfile`);
  }
  return resolveMoved(library, {
    part: target.reference.replace(/\.dat$/u, ""),
    transform: compose(instance.transform, subfilePlacement(target).transform),
  });
}

function sectionInstances(
  library: LdrawLibrary,
  modelText: string,
  section: string,
): ReadonlyArray<PartInstance> {
  const wanted = normalizeReference(section);
  const found = splitMultiPart(modelText).find((entry) => entry.name === wanted);
  if (!found) throw new Error(`the model has no section ${section}`);
  return parseLdraw(found.source).lines.flatMap((line) =>
    line.kind === "subfile"
      ? [
          resolveMoved(library, {
            part: line.reference.replace(/\.dat$/u, ""),
            transform: subfilePlacement(line).transform,
          }),
        ]
      : [],
  );
}

function inverseRigid(transform: Affine): Affine {
  const [a, b, c, d, e, f, g, h, i, x, y, z] = transform;
  return [
    a,
    d,
    g,
    b,
    e,
    h,
    c,
    f,
    i,
    -(a * x + d * y + g * z),
    -(b * x + e * y + h * z),
    -(c * x + f * y + i * z),
  ];
}

function toBundle(transform: Affine): Affine {
  const [a, b, c, d, e, f, g, h, i, x, y, z] = transform;
  return [a, -b, -c, -d, e, f, -g, h, i, x, -y, -z];
}

function quarterTurn(transform: Affine, what: string): 0 | 1 | 2 | 3 {
  const rotation = transform.slice(0, 9).map((value) => whole(value, what));
  const index = QUARTER_TURNS_BUNDLE.findIndex((turn) =>
    turn.every((value, k) => value === rotation[k]),
  );
  if (index !== 0 && index !== 1 && index !== 2 && index !== 3) {
    throw new Error(`${what} is not a quarter turn about the vertical axis`);
  }
  return index;
}

function slopeGeometry(library: LdrawLibrary, part: string): SlopeGeometry {
  const measured = measureBaseplate(library, part);
  const vertices: Array<readonly [number, number, number]> = [];
  walkPart(library, `${part}.dat`, {
    reference: (placed) => (isStudPrimitive(placed.file) ? "skip" : "descend"),
    polygon: (placed) => vertices.push(...placed.vertices),
  });
  const top = vertices.filter(([, y]) => y === measured.bodyTopY);
  const towardsMax = top.every(([, , z]) => z > 0);
  const towardsMin = top.every(([, , z]) => z < 0);
  if (towardsMax === towardsMin) {
    throw new Error(`${part}: its highest face does not lie on one side across z`);
  }
  const highEdgeZ = towardsMax ? measured.zExtent.to : measured.zExtent.from;
  const lowEdgeZ = towardsMax ? measured.zExtent.from : measured.zExtent.to;
  const lowTop = Math.min(...vertices.filter(([, , z]) => z === lowEdgeZ).map(([, y]) => y));
  const halfX = measured.widthLdu / 2;
  const halfZ = measured.depthLdu / 2;
  if (measured.xExtent.from !== -halfX || measured.zExtent.from !== -halfZ) {
    throw new Error(`${part}: its body is not centred on its origin`);
  }
  return {
    halfX,
    halfZ,
    riseLdu: measured.thicknessLdu,
    lowLipLdu: whole(measured.bodyBottomY - lowTop, `${part} low lip`),
    highEdgeZ,
    bottomY: measured.bodyBottomY,
  };
}

function footprint(
  rot: 0 | 1 | 2 | 3,
  offset: readonly [number, number, number],
  geometry: SlopeGeometry,
): LevelCrossingSlope["footprint"] {
  const [a, , c, , , , g, , i] = QUARTER_TURNS_BUNDLE[rot];
  const xs = [-geometry.halfX, geometry.halfX];
  const zs = [-geometry.halfZ, geometry.halfZ];
  const cornersX = xs.flatMap((x) => zs.map((z) => a * x + c * z + offset[0]));
  const cornersZ = xs.flatMap((x) => zs.map((z) => g * x + i * z + offset[2]));
  return {
    minX: Math.min(...cornersX) + 0,
    maxX: Math.max(...cornersX) + 0,
    minZ: Math.min(...cornersZ) + 0,
    maxZ: Math.max(...cornersZ) + 0,
  };
}

function highEdgeAcross(
  rot: 0 | 1 | 2 | 3,
  offset: readonly [number, number, number],
  geometry: SlopeGeometry,
  what: string,
): number {
  const [, , , , , , g, , i] = QUARTER_TURNS_BUNDLE[rot];
  if (g !== 0) throw new Error(`${what}: its high edge runs across the track, not along it`);
  return i * -geometry.highEdgeZ + offset[2] + 0;
}

function readSource(
  library: LdrawLibrary,
  modelText: string,
  source: CrossingSource,
  spec: CrossingSpec,
  sha: string,
): SourceReading {
  const instances = sectionInstances(library, modelText, source.section);
  const tracks = instances.filter((instance) => instance.part === source.trackPart);
  const slopes = instances.filter((instance) => instance.part === spec.part);
  const [reference] = tracks;
  if (!reference) throw new Error(`${source.section} has no ${source.trackPart} track`);
  if (slopes.length === 0) throw new Error(`${source.section} has no ${spec.part}`);
  const toTrack = inverseRigid(reference.transform);
  for (const track of tracks) {
    const relative = compose(toTrack, track.transform);
    const what = `${source.section} ${source.trackPart} relative to the first`;
    if (quarterTurn(relative, what) % 2 !== 0) throw new Error(`${what} is not parallel`);
    if (whole(relative[10], `${what} (y)`) !== 0 || whole(relative[11], `${what} (z)`) !== 0) {
      throw new Error(`${what} is off the first track's centreline`);
    }
  }
  const track = measureBaseplate(library, source.trackPart);
  const rails = measureRails(library, source.trackPart, RAIL_SECTION_X);
  const bed = track.bodyBottomY;
  const relatives = slopes.map((slope, index) => {
    const what = `${source.section} ${spec.part} #${index + 1} in the track frame`;
    const local = compose(toTrack, slope.transform);
    return {
      what,
      local,
      along: whole(local[9], `${what} (x)`),
      height: whole(local[10] - bed, `${what} (y)`),
      across: whole(local[11], `${what} (z)`),
    };
  });
  const alongSum = relatives.reduce((sum, slope) => sum + slope.along, 0);
  const centre = alongSum / relatives.length;
  if (!Number.isInteger(centre)) {
    throw new Error(`${source.section}: the slopes' centre along the track is not a whole LDU`);
  }
  const geometry = slopeGeometry(library, spec.part);
  const crossingSlopes = relatives.map(({ what, local, along, height, across }) => {
    const shifted: Affine = [
      local[0],
      local[1],
      local[2],
      local[3],
      local[4],
      local[5],
      local[6],
      local[7],
      local[8],
      along - centre,
      height,
      across,
    ];
    const bundle = toBundle(shifted);
    const rot = quarterTurn(bundle, what);
    const offset: readonly [number, number, number] = [
      bundle[9] + 0,
      bundle[10] + 0,
      bundle[11] + 0,
    ];
    return {
      rot,
      offset: [offset[0], offset[1], offset[2]] as [number, number, number],
      footprint: footprint(rot, offset, geometry),
      highEdgeAcrossLdu: highEdgeAcross(rot, offset, geometry, what),
    };
  });
  const trackHalfWidthLdu = whole(track.depthLdu / 2, `${source.trackPart} half width`);
  const railTopAboveBedLdu = whole(rails.railTopAboveUndersideLdu, `${source.trackPart} rail top`);
  const highEdges = crossingSlopes.map((slope) => Math.abs(slope.highEdgeAcrossLdu));
  const [highEdge] = highEdges;
  if (highEdge === undefined || highEdges.some((edge) => edge !== highEdge)) {
    throw new Error(`${source.section}: the slopes' high edges are not all equally far out`);
  }
  if (crossingSlopes.some((slope) => slope.offset[1] !== geometry.bottomY)) {
    throw new Error(`${source.section}: a slope does not rest on the track's underside`);
  }
  return {
    evidence: {
      model: source.model,
      sha256: sha,
      section: source.section,
      trackPart: `ldraw:${source.trackPart}`,
      trackSystem: source.trackSystem,
      use: source.use,
      trackPieces: tracks.length,
      slopes: crossingSlopes.length,
      centreAlongTrackLdu: centre,
      alongOffsetsLdu: crossingSlopes.map((slope) => slope.offset[0]),
      acrossOffsetsLdu: crossingSlopes.map((slope) => slope.offset[2]),
      highEdgeAcrossLdu: highEdge,
      trackHalfWidthLdu,
      railTopAboveBedLdu,
    },
    slopes: crossingSlopes,
    trackHalfWidthLdu,
    railTopAboveBedLdu,
  };
}

export function buildLevelCrossing(
  library: LdrawLibrary,
  models: ReadonlyMap<string, string>,
  palette: Palette,
  spec: CrossingSpec = LEVEL_CROSSING_SPEC,
): LevelCrossingRecipe {
  const readings = spec.sources.map((source) => {
    const entry = palette.models.find((model) => model.name === source.model);
    if (!entry) throw new Error(`palette.json has no model ${source.model}`);
    const text = models.get(source.model);
    if (text === undefined) throw new Error(`model ${source.model} was not read`);
    const sha = sha256(text);
    if (sha !== entry.sha256) throw new Error(`${source.model} does not match its pinned sha256`);
    return { source, reading: readSource(library, text, source, spec, sha) };
  });
  const recipes = readings.filter(({ source }) => source.use === "recipe");
  const [recipe] = recipes;
  if (!recipe || recipes.length !== 1) throw new Error("the spec needs exactly one recipe source");
  const { reading } = recipe;
  if (reading.evidence.highEdgeAcrossLdu !== reading.trackHalfWidthLdu) {
    throw new Error(
      `${recipe.source.section}: the slopes' high edges are ${reading.evidence.highEdgeAcrossLdu} LDU from the centreline, not flush with the ${reading.trackHalfWidthLdu} LDU track edge`,
    );
  }
  const geometry = slopeGeometry(library, spec.part);
  if (geometry.riseLdu !== reading.railTopAboveBedLdu) {
    throw new Error(
      `${spec.part} rises ${geometry.riseLdu} LDU, but the rail top is ${reading.railTopAboveBedLdu} LDU above the bed`,
    );
  }
  const title = library.load(`${spec.part}.dat`)?.header.title ?? spec.part;
  return decodedOrThrow(
    decode(LevelCrossingRecipe, {
      source: `tools/asset-pipeline cli.ts facts (src/crossing/level-crossing.ts): the ${spec.part} placements of the recipe model's crossing section, read relative to its first ${recipe.source.trackPart} and identified as quarter turns with whole-LDU offsets within ${CERTIFIED_RESIDUAL_LIMIT_LDU} LDU; the other sources are cross-checks`,
      frame:
        "bundle frame, +Y up and z = -z_LDraw; origin on the track centreline at the crossing centre, at the track's underside (the bed); +x along the track; rot is a quarter turn in the editor's Rot90 sense (x' = cos x + sin z, z' = -sin x + cos z)",
      part: `ldraw:${spec.part}`,
      title,
      trackSystem: recipe.source.trackSystem,
      trackPart: `ldraw:${recipe.source.trackPart}`,
      trackHalfWidthLdu: reading.trackHalfWidthLdu,
      railTopAboveBedLdu: reading.railTopAboveBedLdu,
      slopeRiseLdu: geometry.riseLdu,
      lowLipLdu: geometry.lowLipLdu,
      slopes: reading.slopes,
      evidence: readings.map((entry) => entry.reading.evidence),
    }),
    "level crossing recipe",
  );
}

export function readCrossingModels(
  omrRoot: string,
  palette: Palette,
  spec: CrossingSpec = LEVEL_CROSSING_SPEC,
): ReadonlyMap<string, string> {
  return new Map(
    spec.sources.map((source) => {
      const entry = palette.models.find((model) => model.name === source.model);
      if (!entry) throw new Error(`palette.json has no model ${source.model}`);
      return [source.model, readFileSync(join(omrRoot, entry.file), "utf8")];
    }),
  );
}

export function loadLevelCrossing(): LevelCrossingRecipe {
  return decodedOrThrow(
    decode(LevelCrossingRecipe, JSON.parse(readFileSync(RECIPE_PATH, "utf8"))),
    RECIPE_PATH,
  );
}

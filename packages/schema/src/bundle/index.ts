import {
  compareExactRational,
  isCanonicalExactDecimalText,
  isCanonicalExactRationalText,
  parseExactRational,
  pose16,
  ZETA16_COEFFICIENT_COUNT,
  ZETA16_ORDER,
  zeta16,
  type Zeta16,
} from "@brr/math";
import * as v from "valibot";
import { LevelCrossingFacts, PlanOutline } from "./level-crossing.ts";

const MATRIX_FLOATS = 12;
const STUD_PHASES = 20;
const BITS_PER_WORD = 32;
export const EMPTY_COLUMN = -1;
export const ALPHA_OPAQUE = 255;

const Finite = v.pipe(v.number(), v.finite());
const Integer = v.pipe(v.number(), v.integer());
const Count = v.pipe(Integer, v.minValue(0));
const StudPhase = v.pipe(Integer, v.minValue(0), v.maxValue(STUD_PHASES - 1));
const IntegerString = v.pipe(v.string(), v.regex(/^-?\d+$/u));
const Zeta16Coefficients = v.pipe(v.array(IntegerString), v.length(ZETA16_COEFFICIENT_COUNT));
const Matrix = v.pipe(v.array(Finite), v.length(MATRIX_FLOATS));

export const ExactDecimalText = v.pipe(
  v.string(),
  v.check(
    (text) => isCanonicalExactDecimalText(text),
    "must be an exact decimal written canonically",
  ),
  v.description(
    "an exact decimal in LDU, written canonically: an optional minus, the integer digits, and a fractional part with no trailing zeros; read with @brr/math parseExactDecimal",
  ),
);
export type ExactDecimalText = v.InferOutput<typeof ExactDecimalText>;

export const ExactRationalText = v.pipe(
  v.unknown(),
  v.check((text) => isCanonicalExactRationalText(text), "must be a reduced exact rational"),
  v.object({ numerator: v.string(), denominator: v.string() }),
  v.description(
    "an exact rational as decimal integer strings: the numerator carries the sign, the denominator is positive and shares no factor with it; read with @brr/math parseExactRational",
  ),
);
export type ExactRationalText = v.InferOutput<typeof ExactRationalText>;

export function encodeZeta16(value: Zeta16): string[] {
  return value.map((coefficient) => coefficient.toString());
}

export function decodeZeta16(coefficients: ReadonlyArray<string>): Zeta16 {
  return zeta16(coefficients.map((coefficient) => BigInt(coefficient)));
}

export const Sha256Hex = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));
export type Sha256Hex = v.InferOutput<typeof Sha256Hex>;

export const Vec3 = v.tuple([Finite, Finite, Finite]);
export type Vec3 = v.InferOutput<typeof Vec3>;

const Bounds = v.object({ min: Vec3, max: Vec3 });

export const CUSTOM_PART_NAMESPACE = "custom:";

export function isCustomPartId(partId: string): boolean {
  return partId.startsWith(CUSTOM_PART_NAMESPACE);
}

export const PartRole = v.picklist(["ground", "road", "track", "wall", "roof", "detail", "model"]);
export type PartRole = v.InferOutput<typeof PartRole>;

export const DisplayColor = v.object({ ldraw: Integer, source: v.string() });
export type DisplayColor = v.InferOutput<typeof DisplayColor>;

export const ProducedColors = v.object({
  rebrickable: v.string(),
  colors: v.array(v.object({ ldraw: Integer, elements: v.array(v.string()) })),
});
export type ProducedColors = v.InferOutput<typeof ProducedColors>;

export const TrackEnd = v.object({
  marker: v.string(),
  xStuds: Finite,
  zStuds: Finite,
  headingSteps: Integer,
  headingResidualDegrees: Finite,
  toleranceLdu: Finite,
  fieldSearch: v.nullable(v.object({ bestResidualLdu: Finite, solutionCount: Count })),
  fieldCertified: v.boolean(),
  coefficients: v.nullable(Zeta16Coefficients),
});
export type TrackEnd = v.InferOutput<typeof TrackEnd>;

export const PoseStatus = v.picklist(["certified", "unverified"]);
export type PoseStatus = v.InferOutput<typeof PoseStatus>;

export const PieceKind = v.picklist(["straight", "curve", "switch", "crossing"]);
export type PieceKind = v.InferOutput<typeof PieceKind>;

export const TrackSystem = v.picklist(["lego-9v", "lego-plastic"]);
export type TrackSystem = v.InferOutput<typeof TrackSystem>;

export const TrackConnector = v.pipe(
  v.object({
    coefficients: Zeta16Coefficients,
    heading: Integer,
    status: PoseStatus,
    residualLdu: Finite,
  }),
  v.transform((connector) => ({
    ...connector,
    pose: pose16(decodeZeta16(connector.coefficients), connector.heading),
  })),
);
export type TrackConnector = v.InferOutput<typeof TrackConnector>;

export const TrackPathSegment = v.variant("kind", [
  v.object({ kind: v.literal("straight"), lengthLdu: Finite }),
  v.object({ kind: v.literal("arc"), radiusLdu: Finite, sweepRadians: Finite }),
]);
export type TrackPathSegment = v.InferOutput<typeof TrackPathSegment>;

export const TrackRoute = v.object({
  from: Count,
  to: Count,
  lengthLdu: Finite,
  segments: v.array(TrackPathSegment),
});
export type TrackRoute = v.InferOutput<typeof TrackRoute>;

export const TrackPartFrame = v.object({ xLdu: Finite, zLdu: Finite, headingHalfSteps: Integer });
export type TrackPartFrame = v.InferOutput<typeof TrackPartFrame>;

export const TrackPiece = v.pipe(
  v.object({
    id: v.string(),
    part: v.string(),
    title: v.string(),
    kind: PieceKind,
    system: TrackSystem,
    joinClass: v.literal("lego-train"),
    status: PoseStatus,
    connectors: v.array(TrackConnector),
    routes: v.array(TrackRoute),
    partFrame: TrackPartFrame,
  }),
  v.check(
    (piece) =>
      piece.routes.every(
        (route) =>
          route.from !== route.to &&
          route.from < piece.connectors.length &&
          route.to < piece.connectors.length,
      ),
    "every route must join two different connectors of its piece",
  ),
);
export type TrackPiece = v.InferOutput<typeof TrackPiece>;

export const TrackCatalog = v.object({
  n: v.literal(ZETA16_ORDER),
  pieces: v.array(TrackPiece),
});
export type TrackCatalog = v.InferOutput<typeof TrackCatalog>;

export const BundleSource = v.object({
  kind: v.literal("github-mirror"),
  repo: v.string(),
  commit: v.string(),
  root: v.string(),
});
export type BundleSource = v.InferOutput<typeof BundleSource>;

export const ModelSection = v.object({
  name: v.string(),
  title: v.string(),
  author: v.string(),
  license: v.nullable(v.string()),
  ldrawOrg: v.nullable(v.string()),
});
export type ModelSection = v.InferOutput<typeof ModelSection>;

export const ModelLattice = v.object({
  phase: v.tuple([StudPhase, StudPhase]),
  phaseLayerY: Finite,
  phaseLayerStuds: Count,
  phaseLayerAgreeing: Count,
  aabb: Bounds,
});
export type ModelLattice = v.InferOutput<typeof ModelLattice>;

const InlinePartResolution = v.object({
  inline: v.string(),
  official: v.string(),
  maxMeasuredDistanceLdu: Finite,
});

export const NotDrawnSection = v.variant("kind", [
  v.object({
    kind: v.literal("looseGeometry"),
    section: v.string(),
    triangles: Count,
    quads: Count,
    reason: v.string(),
  }),
  v.object({
    kind: v.literal("customPart"),
    section: v.string(),
    instances: v.optional(Count),
    colors: v.optional(v.array(v.object({ color: Integer, instances: Count }))),
    reason: v.string(),
  }),
]);
export type NotDrawnSection = v.InferOutput<typeof NotDrawnSection>;

const CellGridSize = v.tuple([Count, Count]);
const ColumnPlates = v.pipe(Integer, v.minValue(EMPTY_COLUMN));

function cellCount([width, depth]: readonly [number, number]): number {
  return width * depth;
}

function footingListedInOrder(
  instance: ReadonlyArray<number>,
  cell: ReadonlyArray<number>,
): boolean {
  if (instance.length !== cell.length) return false;
  for (let k = 1; k < instance.length; k++) {
    const previous = instance[k - 1] ?? 0;
    const current = instance[k] ?? 0;
    if (current < previous || (current === previous && (cell[k] ?? 0) <= (cell[k - 1] ?? 0))) {
      return false;
    }
  }
  return true;
}

const InstanceFooting = v.pipe(
  v.object({ instance: v.array(Count), cell: v.array(Count) }),
  v.check(
    ({ instance, cell }) => footingListedInOrder(instance, cell),
    "the footing pairs are not listed once each by instance and then by cell",
  ),
);

export const ModelFileCells = v.pipe(
  v.object({
    origin: v.tuple([Finite, Finite]),
    size: CellGridSize,
    bottomY: Finite,
    footprint: v.array(Count),
    flat: v.array(Count),
    columnBottom: v.array(ColumnPlates),
    columnTop: v.array(ColumnPlates),
    footing: InstanceFooting,
  }),
  v.check(
    ({ size, footprint, flat }) => [...footprint, ...flat].every((cell) => cell < cellCount(size)),
    "a footprint cell lies outside the cell grid",
  ),
  v.check(
    ({ size, columnBottom, columnTop }) =>
      columnBottom.length === cellCount(size) && columnTop.length === cellCount(size),
    "the column arrays do not cover the cell grid",
  ),
  v.check(
    ({ size, footing }) => footing.cell.every((cell) => cell < cellCount(size)),
    "a footing cell lies outside the cell grid",
  ),
);
export type ModelFileCells = v.InferOutput<typeof ModelFileCells>;

export const ModelFileCover = v.pipe(
  v.object({
    studs: Count,
    coveredStuds: Count,
    keptOpenBelow: Count,
    visibleBits: v.array(Count),
    cells: v.nullable(ModelFileCells),
  }),
  v.check(
    ({ studs, visibleBits }) => visibleBits.length === Math.ceil(studs / BITS_PER_WORD),
    "the visible-stud bitset does not match the stud count",
  ),
);
export type ModelFileCover = v.InferOutput<typeof ModelFileCover>;

export const BundleModelCover = v.object({
  studs: Count,
  coveredStuds: Count,
  keptOpenBelow: Count,
  cells: v.nullable(
    v.object({
      footprintCells: Count,
      flatCells: Count,
      restY: Finite,
      size: CellGridSize,
      heightPlates: ColumnPlates,
    }),
  ),
});
export type BundleModelCover = v.InferOutput<typeof BundleModelCover>;

export const ModelOrigin = v.picklist(["omr", "generated"]);
export type ModelOrigin = v.InferOutput<typeof ModelOrigin>;

export const ModelSet = v.object({ name: v.string(), year: Integer, source: v.string() });
export type ModelSet = v.InferOutput<typeof ModelSet>;

export const ModelRole = v.picklist(["mils-module"]);
export type ModelRole = v.InferOutput<typeof ModelRole>;

const LineNumber = v.pipe(Integer, v.minValue(1));
const OmrLine = v.strictObject({ line: LineNumber, text: v.string() });

export const ErratumEvidence = v.variant("kind", [
  v.strictObject({ kind: v.literal("mirror-twin"), twin: OmrLine, summary: v.string() }),
  v.strictObject({
    kind: v.literal("wall-course"),
    course: v.pipe(v.array(OmrLine), v.minLength(2)),
    summary: v.string(),
  }),
]);
export type ErratumEvidence = v.InferOutput<typeof ErratumEvidence>;

export const OmrErratum = v.strictObject({
  model: v.string(),
  file: v.string(),
  sha256: Sha256Hex,
  line: LineNumber,
  from: v.string(),
  to: v.string(),
  evidence: ErratumEvidence,
});
export type OmrErratum = v.InferOutput<typeof OmrErratum>;

export const OmrErrata = v.strictObject({ errata: v.array(OmrErratum) });
export type OmrErrata = v.InferOutput<typeof OmrErrata>;

export const ModelErratum = v.object({
  line: LineNumber,
  from: v.string(),
  to: v.string(),
  summary: v.string(),
});
export type ModelErratum = v.InferOutput<typeof ModelErratum>;

const IntegerVec3 = v.tuple([Integer, Integer, Integer]);
const CountVec3 = v.tuple([Count, Count, Count]);

export const BundleFarMesh = v.object({
  file: v.string(),
  voxels: Count,
  triangles: Count,
  origin: IntegerVec3,
  dims: CountVec3,
});
export type BundleFarMesh = v.InferOutput<typeof BundleFarMesh>;

export const BundleModelEntry = v.object({
  name: v.string(),
  file: v.string(),
  origin: ModelOrigin,
  set: v.nullable(ModelSet),
  role: v.optional(ModelRole),
  source: v.string(),
  authors: v.array(v.string()),
  licenses: v.array(v.string()),
  sections: v.array(ModelSection),
  inlinePartsResolvedToOfficial: v.array(InlinePartResolution),
  instances: Count,
  lattice: v.nullable(ModelLattice),
  vehicles: Count,
  sha256: Sha256Hex,
  cover: BundleModelCover,
  notDrawn: v.optional(v.array(NotDrawnSection)),
  errata: v.optional(v.array(ModelErratum)),
  farMesh: v.optional(v.nullable(BundleFarMesh)),
});
export type BundleModelEntry = v.InferOutput<typeof BundleModelEntry>;

const CompiledMesh = v.object({
  bounds: Bounds,
  colors: v.array(Integer),
  studs: Count,
  triangles: Count,
  vertices: Count,
});

export const ManifestPart = v.object({
  ...CompiledMesh.entries,
  id: v.string(),
  path: v.string(),
  role: PartRole,
  file: v.string(),
  title: v.string(),
  ldrawCategory: v.string(),
  keywords: v.array(v.string()),
  author: v.string(),
  license: v.nullable(v.string()),
  displayColor: v.optional(DisplayColor),
  producedColors: v.optional(ProducedColors),
  trackEnds: v.optional(v.array(TrackEnd)),
});
export type ManifestPart = v.InferOutput<typeof ManifestPart>;

export const TECHNIC_STEPS_PER_LDU = 16;

const TechnicAxis = v.picklist([0, 1, 2]);
const TechnicLine = { axis: TechnicAxis, at: v.tuple([Integer, Integer]) };
const TechnicProfile = { from: Integer, radii: v.pipe(v.array(Count), v.minLength(1)) };

export const TechnicHole = v.object({ ...TechnicLine, ...TechnicProfile });
export type TechnicHole = v.InferOutput<typeof TechnicHole>;

export const TechnicShaftComponent = v.object({
  ...TechnicProfile,
  pin: v.nullable(v.object({ origin: Integer, direction: v.picklist([-1, 1]) })),
});
export type TechnicShaftComponent = v.InferOutput<typeof TechnicShaftComponent>;

export const TechnicShaft = v.object({
  ...TechnicLine,
  components: v.pipe(v.array(TechnicShaftComponent), v.minLength(1)),
});
export type TechnicShaft = v.InferOutput<typeof TechnicShaft>;

export const PartTechnic = v.object({
  stepsPerLdu: v.literal(TECHNIC_STEPS_PER_LDU),
  holes: v.array(TechnicHole),
  shaft: v.nullable(TechnicShaft),
});
export type PartTechnic = v.InferOutput<typeof PartTechnic>;

export const ROLLING_STEPS_PER_LDU = 16;

const RollingAxis = v.pipe(
  v.picklist([0, 1, 2]),
  v.description("the part-frame axis the band turns about: 0 is x, 1 is y, 2 is z (y up)"),
);
const RollingAt = v.pipe(
  v.tuple([Integer, Integer]),
  v.description(
    "the axis line's two coordinates perpendicular to `axis`, in ascending axis order, in sixteenths of an LDU",
  ),
);
const RollingAlong = v.pipe(
  Integer,
  v.description("a position along `axis`, in sixteenths of an LDU"),
);
export const RollingSurface = v.pipe(
  v.object({
    source: v.literal("measured"),
    axis: RollingAxis,
    at: RollingAt,
    from: RollingAlong,
    to: RollingAlong,
    radii: v.pipe(
      v.tuple([Count, Count]),
      v.description(
        "the radius at `from`, then at `to`, in sixteenths of an LDU; equal for a cylinder, different for a cone",
      ),
    ),
  }),
  v.check(({ from, to }) => from < to, "a rolling surface runs from below `to`"),
  v.description(
    "an outward round band of the part's own triangles, with its ends in sixteenths: an end that identifies to the grid is published there, and a cylinder's end that doesn't is published at the nearest sixteenth inside the band, so a band never extends past its triangles; neighbours on one axis line share the end sixteenths that identify",
  ),
);
export type RollingSurface = v.InferOutput<typeof RollingSurface>;

const EndRadii = v.pipe(
  v.tuple([v.nullable(Count), v.nullable(Count)]),
  v.description("the radius at `from` and at `to` in sixteenths, null where it didn't identify"),
);

export const UnreadRaw = v.pipe(
  v.object({
    from: ExactRationalText,
    to: ExactRationalText,
    radii: v.optional(v.tuple([v.nullable(ExactRationalText), v.nullable(ExactRationalText)])),
  }),
  v.check(
    ({ from, to }) => compareExactRational(parseExactRational(from), parseExactRational(to)) <= 0,
    "a raw band runs from no higher than `to`",
  ),
  v.description(
    "the band as the reader measured it, never rounded or identified: each value the exact rational of its Float64. `from` and `to` are its ends in LDU along its axis (an unoriented band's along its own fitted line); `radii`, the radius at `from` and then at `to`, null where none was measured, appears wherever a radius was measured",
  ),
);
export type UnreadRaw = v.InferOutput<typeof UnreadRaw>;

const UnreadEnds = {
  from: v.optional(RollingAlong),
  to: v.optional(RollingAlong),
};

export const UnreadBandDiagnostic = v.pipe(
  v.variant("reason", [
    v.object({ reason: v.literal("unoriented"), raw: UnreadRaw }),
    v.object({
      reason: v.literal("centre"),
      axis: RollingAxis,
      radii: v.optional(EndRadii),
      ...UnreadEnds,
      raw: UnreadRaw,
    }),
    v.object({
      reason: v.literal("radius"),
      axis: RollingAxis,
      at: RollingAt,
      radii: EndRadii,
      ...UnreadEnds,
      raw: UnreadRaw,
    }),
    v.object({
      reason: v.literal("width"),
      axis: RollingAxis,
      at: RollingAt,
      radii: v.tuple([Count, Count]),
      ...UnreadEnds,
      raw: UnreadRaw,
    }),
    v.object({
      reason: v.picklist(["faceted", "partial", "facing", "irregular", "arcs"]),
      axis: RollingAxis,
      at: v.optional(RollingAt),
      radii: v.optional(EndRadii),
      ...UnreadEnds,
      raw: UnreadRaw,
    }),
  ]),
  v.check(
    (band) =>
      !("from" in band) || band.from === undefined || band.to === undefined || band.from <= band.to,
    "an unread band runs from no higher than `to`",
  ),
  v.description(
    "the whole row of a band the part compile found round evidence for (a ring fitting a circle with at least the coarse stud's facet count, or a revolution axis) but could not read as an outward rolling surface, as the rolling diagnostics file carries it. unoriented: round about a line that is not a part axis. centre: closed about a part axis, but no axis line identified. radius: axis line identified, a radius not. width: axis line and both radii identified, an end not (a cone; a cylinder's end is read inside the band). faceted: closed with fewer facets than the Standard-LOD stud. partial: round about the line but not a closed band. facing: outward can't be told from the winding. irregular: smooth and round about a part axis but not one complete band (oblique cuts, patches between holes), or curved about a part axis with no circle fitted. arcs: its ring fits a circle but its arcs don't go round (a band broken by prints or cut-outs). `at`, `from` and `to` appear wherever they identified; `radii` appears wherever a radius was measured, with null for an end whose radius didn't identify. `raw` carries the band as measured",
  ),
);
export type UnreadBandDiagnostic = v.InferOutput<typeof UnreadBandDiagnostic>;

const AXIAL_UNREAD_REASONS = [
  "centre",
  "radius",
  "width",
  "faceted",
  "partial",
  "facing",
  "irregular",
  "arcs",
] as const;

export const UnreadBand = v.pipe(
  v.variant("reason", [
    v.object({ reason: v.literal("unoriented") }),
    v.object({ reason: v.picklist(AXIAL_UNREAD_REASONS), axis: RollingAxis }),
  ]),
  v.description(
    "one entry per band the part compile found round evidence for but could not read as an outward rolling surface, in the order of the part's rows in the rolling diagnostics file: only the row's reason and, for every reason but unoriented, the part axis it turns about. The rest of each row, and what each reason means, is in the diagnostics file, which only inspection loads",
  ),
);
export type UnreadBand = v.InferOutput<typeof UnreadBand>;

export function servedUnreadBand(row: UnreadBandDiagnostic): UnreadBand {
  return row.reason === "unoriented"
    ? { reason: row.reason }
    : { reason: row.reason, axis: row.axis };
}

function unreadAxis(band: UnreadBand): number | null {
  return band.reason === "unoriented" ? null : band.axis;
}

export function rollingDiagnosticsFit(
  served: ReadonlyArray<UnreadBand>,
  rows: ReadonlyArray<UnreadBandDiagnostic>,
): boolean {
  return (
    served.length === rows.length &&
    served.every((band, index) => {
      const row = rows[index];
      if (row === undefined) return false;
      const expected = servedUnreadBand(row);
      return band.reason === expected.reason && unreadAxis(band) === unreadAxis(expected);
    })
  );
}

export const PartRolling = v.object({
  stepsPerLdu: v.literal(ROLLING_STEPS_PER_LDU),
  surfaces: v.array(RollingSurface),
  unread: v.array(UnreadBand),
});
export type PartRolling = v.InferOutput<typeof PartRolling>;

export const RollingDiagnosticsFile = v.strictObject({
  stepsPerLdu: v.literal(ROLLING_STEPS_PER_LDU),
  parts: v.pipe(
    v.record(v.string(), v.pipe(v.array(UnreadBandDiagnostic), v.minLength(1))),
    v.description(
      "every part with unread bands, by part id: its whole rows, in the order its served rolling lists them, so a served entry's index names its row here",
    ),
  ),
});
export type RollingDiagnosticsFile = v.InferOutput<typeof RollingDiagnosticsFile>;

export const RollingDiagnosticsRef = v.strictObject({ file: v.string(), sha256: Sha256Hex });
export type RollingDiagnosticsRef = v.InferOutput<typeof RollingDiagnosticsRef>;

export const TOP_SURFACE_STEPS_PER_LDU = 16;

const TopSurfaceRow = v.pipe(
  v.string(),
  v.regex(/^[.fpu]+$/u),
  v.description(
    "one row of cells, in order along +x, one character per cell: f flat, p pocket, u undecided, . open",
  ),
);

export const PartTopSurface = v.pipe(
  v.object({
    stepsPerLdu: v.literal(TOP_SURFACE_STEPS_PER_LDU),
    top: v.pipe(Integer, v.description("the part's top height, in sixteenths of an LDU")),
    origin: v.pipe(
      v.tuple([Integer, Integer]),
      v.description("the cell grid's minimum x and z corner, in sixteenths of an LDU"),
    ),
    size: v.pipe(
      v.tuple([v.pipe(Integer, v.minValue(1)), v.pipe(Integer, v.minValue(1))]),
      v.description("the grid's columns along x, then its rows along z, in 20 LDU cells"),
    ),
    cells: v.pipe(v.array(TopSurfaceRow), v.description("the grid's rows, in order along +z")),
  }),
  v.check(
    ({ size: [columns, rows], cells }) =>
      cells.length === rows && cells.every((row) => row.length === columns),
    "the cell rows don't match the grid size",
  ),
  v.description(
    "what the part's top presents on each cell of its 20 LDU grid, read exactly from the LDraw decimals of its own Standard-LOD triangles. The grid covers the part's plan, which must be whole studs, and the top is the part's highest point, which must be on a sixteenth; otherwise the part has no top surface. f: every point of the cell's square lies within the 0.0005 LDU identification residual of a face lying wholly at the top height (studs standing on it don't matter). p: an upright stud centred on the cell stands below the top, every side of its group of such cells is the part's edge or an f cell, and along x or z the group's run through the cell ends in f cells at both ends. u: the cell isn't covered and a face without exact geometry may lie at the top there. .: none of these",
  ),
);
export type PartTopSurface = v.InferOutput<typeof PartTopSurface>;

export const StudRecord = v.object({ primitive: v.string(), color: Integer, matrix: Matrix });
export type StudRecord = v.InferOutput<typeof StudRecord>;

export const PartShape = v.object({
  id: v.string(),
  title: v.string(),
  role: PartRole,
  file: v.string(),
  bounds: Bounds,
  studs: v.array(StudRecord),
  displayColor: v.optional(DisplayColor),
  producedColors: v.optional(ProducedColors),
  trackEnds: v.optional(v.array(TrackEnd)),
  technic: v.optional(PartTechnic),
  rolling: v.optional(PartRolling),
  topSurface: v.optional(PartTopSurface),
  outline: v.optional(PlanOutline),
});
export type PartShape = v.InferOutput<typeof PartShape>;

const FileRef = v.object({ file: v.string() });

export const CatalogPart = v.object({ ...ManifestPart.entries, shape: FileRef });
export type CatalogPart = v.InferOutput<typeof CatalogPart>;

export const PART_FOOTPRINT_FLOATS = 4;

const TRACK_HULL_MIN_FLOATS = 6;

export const TrackShape = v.object({
  piece: v.string(),
  footprints: v.pipe(v.array(Finite), v.length(ZETA16_ORDER * PART_FOOTPRINT_FLOATS)),
  hull: v.pipe(
    v.array(Finite),
    v.minLength(TRACK_HULL_MIN_FLOATS, "needs at least three points"),
    v.check((hull) => hull.length % 2 === 0, "must hold x, z pairs"),
  ),
  minY: Finite,
  maxY: Finite,
  outline: PlanOutline,
});
export type TrackShape = v.InferOutput<typeof TrackShape>;

export const StudPrimitive = v.object({
  ...CompiledMesh.entries,
  name: v.string(),
  path: v.string(),
  file: v.string(),
});
export type StudPrimitive = v.InferOutput<typeof StudPrimitive>;

export const CompilerVehicles = v.object({
  parts: v.object({
    bogiePivots: v.array(v.string()),
    pivotPins: v.array(v.string()),
    wheelsets: v.array(v.string()),
    wheels: v.array(v.string()),
    couplers: v.array(v.string()),
  }),
  railHeads: v.array(
    v.object({ railPart: v.string(), inner: ExactDecimalText, outer: ExactDecimalText }),
  ),
});
export type CompilerVehicles = v.InferOutput<typeof CompilerVehicles>;
export const TECHNIC_ROLES = ["hole", "pin", "axleEnd"] as const;

export const PrimitiveConnectorTable = v.strictObject({
  source: BundleSource,
  license: v.string(),
  primitives: v.array(
    v.strictObject({
      file: v.string(),
      title: v.string(),
      derivation: v.string(),
      snaps: v.optional(v.array(v.string())),
      whereOpen: v.optional(v.array(v.string())),
      holeEnd: v.optional(
        v.strictObject({
          counterbore: v.strictObject({ radius: Finite, length: Finite }),
          boreRadius: Finite,
        }),
      ),
      technic: v.optional(v.picklist(TECHNIC_ROLES)),
      stud: v.optional(v.literal(true)),
    }),
  ),
});
export type PrimitiveConnectorTable = v.InferOutput<typeof PrimitiveConnectorTable>;

export const SECTION_SHAPE_CODES = ["R", "A", "S", "_L", "L_"] as const;

export const SectionVocabulary = v.strictObject({
  sizes: v.array(
    v.strictObject({
      gender: v.picklist(["M", "F"]),
      shape: v.picklist(SECTION_SHAPE_CODES),
      size: Finite,
    }),
  ),
  lengths: v.array(v.strictObject({ shape: v.picklist(SECTION_SHAPE_CODES), length: Finite })),
});
export type SectionVocabulary = v.InferOutput<typeof SectionVocabulary>;

export const SectionVocabularyRef = v.strictObject({ file: v.string(), sha256: Sha256Hex });
export type SectionVocabularyRef = v.InferOutput<typeof SectionVocabularyRef>;

export const LibraryBakeIndexRef = v.strictObject({ file: v.string(), sha256: Sha256Hex });
export type LibraryBakeIndexRef = v.InferOutput<typeof LibraryBakeIndexRef>;

export const LibraryConnectorsIndexRef = v.strictObject({ file: v.string(), sha256: Sha256Hex });
export type LibraryConnectorsIndexRef = v.InferOutput<typeof LibraryConnectorsIndexRef>;

export const ShadowLibraryIndexRef = v.strictObject({ file: v.string(), sha256: Sha256Hex });
export type ShadowLibraryIndexRef = v.InferOutput<typeof ShadowLibraryIndexRef>;

export const BundleCompiler = v.object({
  file: v.string(),
  unofficialAllowlist: v.array(v.string()),
  vehicles: v.optional(CompilerVehicles),
  primitives: v.optional(PrimitiveConnectorTable),
  sectionVocabulary: SectionVocabularyRef,
  cavityProbe: v.string(),
  libraryBake: v.optional(LibraryBakeIndexRef),
  libraryConnectors: v.optional(LibraryConnectorsIndexRef),
  shadowLibrary: v.optional(ShadowLibraryIndexRef),
});
export type BundleCompiler = v.InferOutput<typeof BundleCompiler>;

export const StudioArchive = v.object({
  status: v.literal("read"),
  entry: v.string(),
  ldraw: v.string(),
  studioVersion: v.nullable(v.string()),
  convertedLines: Count,
  unconvertedLines: v.array(LineNumber),
  bricklinkIds: v.record(v.string(), v.string()),
  customParts: v.array(v.string()),
  customFiles: v.array(v.object({ name: v.string(), text: v.string() })),
});
export type StudioArchive = v.InferOutput<typeof StudioArchive>;

export const StudioRejectionKind = v.picklist(["notZip", "encrypted", "noModel"]);
export type StudioRejectionKind = v.InferOutput<typeof StudioRejectionKind>;

export const StudioRejection = v.object({
  status: v.literal("rejected"),
  kind: StudioRejectionKind,
  message: v.string(),
});
export type StudioRejection = v.InferOutput<typeof StudioRejection>;

export const StudioRead = v.variant("status", [StudioArchive, StudioRejection]);
export type StudioRead = v.InferOutput<typeof StudioRead>;

export const BundleColor = v.object({
  code: Integer,
  name: v.string(),
  rgb: v.string(),
  alpha: v.pipe(Integer, v.minValue(0), v.maxValue(ALPHA_OPAQUE)),
});
export type BundleColor = v.InferOutput<typeof BundleColor>;

export const BundleCredit = v.object({
  path: v.string(),
  title: v.string(),
  author: v.string(),
  license: v.nullable(v.string()),
});
export type BundleCredit = v.InferOutput<typeof BundleCredit>;

export const BundleThumbnail = v.object({ item: v.string(), file: v.string() });
export type BundleThumbnail = v.InferOutput<typeof BundleThumbnail>;

export const BundleLod = v.picklist(["standard", "low", "far"]);
export type BundleLod = v.InferOutput<typeof BundleLod>;

export const CONNECTIVITY_LICENSE = "CC BY-SA 4.0";
export const CONNECTOR_SOURCE = { shadow: 1, primitive: 2, inferred: 4, patch: 8 } as const;
export const CONNECTOR_STATUS = { verified: 0, unverified: 1 } as const;
export const CONNECTIVITY_SOURCES: ReadonlyArray<number> = [
  CONNECTOR_SOURCE.shadow,
  CONNECTOR_SOURCE.patch,
];
const AXIS_FREE = -1;
const MAX_PIECE = 0xffff;
const AXIS_LAST = 5;
const VECTOR_FLOATS = 3;

export const ConnectorPackage = v.picklist(["connectivity", "connectors"]);
export type ConnectorPackage = v.InferOutput<typeof ConnectorPackage>;

const ConnectorFaces = v.object({
  gender: v.array(v.picklist([0, 1])),
  source: v.array(v.picklist(Object.values(CONNECTOR_SOURCE))),
  status: v.array(v.picklist(Object.values(CONNECTOR_STATUS))),
  caps: v.array(Count),
  slide: v.array(v.boolean()),
  group: v.array(v.string()),
  origin: v.array(Integer),
  axis: v.array(v.pipe(Integer, v.minValue(AXIS_FREE), v.maxValue(AXIS_LAST))),
  sectionStart: v.array(Count),
  sectionCount: v.array(Count),
  sectionCode: v.array(Count),
  sectionSize: v.array(Finite),
  sectionLength: v.array(Finite),
  piece: v.array(v.pipe(Integer, v.minValue(0), v.maxValue(MAX_PIECE))),
});

const ConnectorFreeFaces = v.object({
  face: v.array(Count),
  origin: v.array(Finite),
  axis: v.array(Finite),
});

export const UnreadableConnector = v.picklist(["generic", "closedAtBothEnds"]);
export type UnreadableConnector = v.InferOutput<typeof UnreadableConnector>;

export const ConnectorRecordFile = v.pipe(
  v.object({
    part: v.string(),
    license: v.string(),
    sectionVocabulary: v.optional(Sha256Hex),
    faces: ConnectorFaces,
    free: ConnectorFreeFaces,
    unreadable: v.array(UnreadableConnector),
  }),
  v.check(({ faces, free }) => {
    const count = faces.gender.length;
    const perFace = [
      faces.source,
      faces.status,
      faces.caps,
      faces.slide,
      faces.group,
      faces.axis,
      faces.sectionStart,
      faces.sectionCount,
      faces.piece,
    ];
    const sections = faces.sectionCode.length;
    return (
      perFace.every((column) => column.length === count) &&
      faces.origin.length === count * VECTOR_FLOATS &&
      faces.sectionSize.length === sections &&
      faces.sectionLength.length === sections &&
      faces.sectionStart.every((start, i) => start + (faces.sectionCount[i] ?? 0) <= sections) &&
      free.origin.length === free.face.length * VECTOR_FLOATS &&
      free.axis.length === free.face.length * VECTOR_FLOATS &&
      free.face.every((face) => face < count && faces.axis[face] === AXIS_FREE)
    );
  }, "connector record arrays are inconsistent"),
);
export type ConnectorRecordFile = v.InferOutput<typeof ConnectorRecordFile>;

export const ConnectorIndexFile = v.object({
  package: ConnectorPackage,
  licenses: v.array(v.string()),
  attribution: v.array(v.string()),
  sectionVocabulary: v.optional(Sha256Hex),
  source: BundleSource,
  parts: v.record(v.string(), v.nullable(FileRef)),
});
export type ConnectorIndexFile = v.InferOutput<typeof ConnectorIndexFile>;

export const ConnectorPackFile = v.object({
  package: ConnectorPackage,
  files: v.record(v.string(), v.unknown()),
});
export type ConnectorPackFile = v.InferOutput<typeof ConnectorPackFile>;

export const ConnectorPacks = v.object({ connectivity: FileRef, connectors: FileRef });
export type ConnectorPacks = v.InferOutput<typeof ConnectorPacks>;

export const TablePlane = v.object({
  part: v.string(),
  depthBelowTopLdu: v.pipe(Finite, v.gtValue(0)),
});
export type TablePlane = v.InferOutput<typeof TablePlane>;

export const BundleIndex = v.object({
  bundleVersion: v.pipe(v.string(), v.regex(/^[0-9a-f]{16}$/u)),
  unit: v.literal("LDU"),
  upAxis: v.literal("+Y"),
  lod: BundleLod,
  source: BundleSource,
  studPrimitives: v.array(StudPrimitive),
  colors: v.array(BundleColor),
  models: v.array(BundleModelEntry),
  catalogParts: v.array(CatalogPart),
  modified: v.string(),
  disclaimer: v.string(),
  inputs: v.object({
    ldraw: BundleSource,
    omr: BundleSource,
    lockSha256: Sha256Hex,
    paletteSha256: Sha256Hex,
  }),
  trackCatalog: TrackCatalog,
  trackShapes: v.array(TrackShape),
  tablePlane: TablePlane,
  levelCrossing: LevelCrossingFacts,
  compiler: v.nullable(BundleCompiler),
  connectors: FileRef,
  connectivity: FileRef,
  crosswalk: FileRef,
  connectorPacks: v.optional(ConnectorPacks),
  partTable: FileRef,
  creditTable: FileRef,
  thumbnails: v.array(BundleThumbnail),
  rollingDiagnostics: v.optional(RollingDiagnosticsRef),
  libraryParts: v.optional(FileRef),
});
export type BundleIndex = v.InferOutput<typeof BundleIndex>;

export const PartTableFile = v.object({ parts: v.array(ManifestPart) });
export type PartTableFile = v.InferOutput<typeof PartTableFile>;

export const CreditTableFile = v.object({ credits: v.array(BundleCredit) });
export type CreditTableFile = v.InferOutput<typeof CreditTableFile>;

export const BundleManifest = v.object({
  ...BundleIndex.entries,
  ...PartTableFile.entries,
  ...CreditTableFile.entries,
});
export type BundleManifest = v.InferOutput<typeof BundleManifest>;

export const CROSSWALK_FORMAT = 1;
const MOVED_VIA = /^moved:.+$/u;

export const RebrickableVia = v.union([
  v.picklist(["rebrickable-api", "ldraw-keyword", "bricklink-keyword"]),
  v.pipe(v.string(), v.regex(MOVED_VIA)),
]);
export type RebrickableVia = v.InferOutput<typeof RebrickableVia>;

export const BrickLinkVia = v.picklist(["rebrickable-api", "ldraw-keyword"]);
export type BrickLinkVia = v.InferOutput<typeof BrickLinkVia>;

export const CrosswalkComponent = v.object({ part: v.string(), color: Integer });
export type CrosswalkComponent = v.InferOutput<typeof CrosswalkComponent>;

export const RejectedAssemblyIds = v.object({
  assemblies: v.array(v.string()),
  rebrickable: v.array(v.string()),
  bricklink: v.array(v.string()),
});
export type RejectedAssemblyIds = v.InferOutput<typeof RejectedAssemblyIds>;

export const CrosswalkPart = v.object({
  rebrickable: v.nullable(v.string()),
  bricklink: v.nullable(v.string()),
  via: v.object({
    rebrickable: v.nullable(RebrickableVia),
    bricklink: v.nullable(BrickLinkVia),
  }),
  rebrickableAlternatives: v.optional(v.array(v.string())),
  bricklinkAlternatives: v.optional(v.array(v.string())),
  rejectedAssemblyIds: v.optional(RejectedAssemblyIds),
  components: v.optional(v.array(CrosswalkComponent)),
});
export type CrosswalkPart = v.InferOutput<typeof CrosswalkPart>;

export const CrosswalkColor = v.object({
  name: v.string(),
  rebrickable: v.nullable(Integer),
  bricklink: v.nullable(Integer),
  rebrickableAlternatives: v.optional(v.array(Integer)),
  bricklinkAlternatives: v.optional(v.array(Integer)),
});
export type CrosswalkColor = v.InferOutput<typeof CrosswalkColor>;

export const CrosswalkSourcePin = v.object({
  repo: v.string(),
  commit: v.string(),
  root: v.string(),
  files: v.record(v.string(), Sha256Hex),
});
export type CrosswalkSourcePin = v.InferOutput<typeof CrosswalkSourcePin>;

export const CrosswalkFile = v.object({
  format: v.literal(CROSSWALK_FORMAT),
  sources: v.record(v.string(), CrosswalkSourcePin),
  parts: v.record(v.string(), CrosswalkPart),
  colors: v.record(IntegerString, CrosswalkColor),
  bricklinkParts: v.record(v.string(), v.array(v.string())),
  bricklinkPartVariants: v.record(v.string(), v.array(v.string())),
  bricklinkColors: v.record(IntegerString, v.array(Integer)),
});
export type CrosswalkFile = v.InferOutput<typeof CrosswalkFile>;

export const LIBRARY_PARTS_FORMAT = 1;

export const LibraryPartColumns = v.strictObject({
  id: v.array(v.string()),
  title: v.array(v.string()),
  category: v.array(Count),
  keywords: v.array(v.array(v.string())),
  rebrickable: v.array(v.string()),
  colorCount: v.array(v.pipe(Count, v.minValue(1))),
  colors: v.array(Integer),
});
export type LibraryPartColumns = v.InferOutput<typeof LibraryPartColumns>;

export const LibraryPartsFile = v.pipe(
  v.strictObject({
    format: v.literal(LIBRARY_PARTS_FORMAT),
    sources: v.record(v.string(), CrosswalkSourcePin),
    categories: v.array(v.string()),
    parts: LibraryPartColumns,
  }),
  v.check(({ categories, parts }) => {
    const count = parts.id.length;
    const perPart = [
      parts.title,
      parts.category,
      parts.keywords,
      parts.rebrickable,
      parts.colorCount,
    ];
    const colors = parts.colorCount.reduce((sum, colorCount) => sum + colorCount, 0);
    return (
      perPart.every((column) => column.length === count) &&
      parts.colors.length === colors &&
      parts.category.every((category) => category < categories.length)
    );
  }, "library part columns are inconsistent"),
);
export type LibraryPartsFile = v.InferOutput<typeof LibraryPartsFile>;

export const VehicleGuideKind = v.picklist(["bogiePivot", "fixedAxle"]);
export type VehicleGuideKind = v.InferOutput<typeof VehicleGuideKind>;

export const VehicleCoupler = v.object({
  instance: Count,
  face: Vec3,
  bogie: v.nullable(Count),
  obsoleteSources: v.array(v.string()),
});
export type VehicleCoupler = v.InferOutput<typeof VehicleCoupler>;

export const VehicleBogie = v.object({
  instances: v.array(Count),
  pivot: Vec3,
  axles: v.array(Vec3),
});
export type VehicleBogie = v.InferOutput<typeof VehicleBogie>;

export const VehicleWheelset = v.object({ instance: Count, centre: Vec3 });
export type VehicleWheelset = v.InferOutput<typeof VehicleWheelset>;

export const VehicleRailContact = v.object({
  railPart: v.string(),
  railTopY: Finite,
  spreadLdu: Finite,
});
export type VehicleRailContact = v.InferOutput<typeof VehicleRailContact>;

export const ModelVehicle = v.pipe(
  v.object({
    origin: v.tuple([Finite, Finite]),
    yaw: Finite,
    guideKind: VehicleGuideKind,
    guides: v.tuple([Finite, Finite]),
    body: v.array(Count),
    bogies: v.array(VehicleBogie),
    fixedAxles: v.array(Vec3),
    wheelsets: v.array(VehicleWheelset),
    frontCoupler: v.nullable(VehicleCoupler),
    rearCoupler: v.nullable(VehicleCoupler),
    railContacts: v.array(VehicleRailContact),
  }),
  v.check(
    ({ bogies, frontCoupler, rearCoupler }) =>
      [frontCoupler, rearCoupler].every(
        (coupler) => coupler === null || coupler.bogie === null || coupler.bogie < bogies.length,
      ),
    "a coupler names a bogie the vehicle does not have",
  ),
);
export type ModelVehicle = v.InferOutput<typeof ModelVehicle>;

const ByteRange = v.pipe(v.tuple([Count, Count]), v.readonly());
const IndexRange = v.tuple([Count, Count]);

const StringList = v.pipe(v.array(v.string()), v.readonly());

export const SHADOW_NAMESPACE = "shadow:";
export const SHADOW_PATCH_NAMESPACE = "shadow-patch:";

export const InferredConnectorRecords = v.strictObject({
  connectivity: v.nullable(ConnectorRecordFile),
  connectors: v.nullable(ConnectorRecordFile),
});
export type InferredConnectorRecords = v.InferOutput<typeof InferredConnectorRecords>;

export const ShadowPatchManifest = v.looseObject({
  patches: v.array(v.looseObject({ part: v.string(), status: v.string() })),
});
export type ShadowPatchManifest = v.InferOutput<typeof ShadowPatchManifest>;

export const CompilerConnectorInputs = v.strictObject({
  primitives: v.nullable(PrimitiveConnectorTable),
  sectionVocabulary: SectionVocabulary,
  cavityProbe: v.string(),
  infer: StringList,
  shadowPatchManifest: v.nullable(ShadowPatchManifest),
});
export type CompilerConnectorInputs = v.InferOutput<typeof CompilerConnectorInputs>;

export const BakeShard = v.pipe(
  v.strictObject({ from: Count, to: Count, of: Count, visibilityOnly: v.boolean() }),
  v.check(
    (shard) => shard.from <= shard.to && shard.to <= shard.of && shard.of > 0,
    "a bake shard is a slice of the candidates",
  ),
  v.readonly(),
);
export type BakeShard = v.InferOutput<typeof BakeShard>;

export const AUTHORED_LINE_KINDS = ["instance", "placement"] as const;
export const AUTHORED_GRIDS = [
  "whole",
  "half",
  "quarter",
  "eighth",
  "sixteenth",
  "unidentified",
] as const;
const AUTHORED_AXES = [0, 1, 2] as const;
const AuthoredLineKind = v.picklist(AUTHORED_LINE_KINDS);

export const AuthoredLines = v.pipe(
  v.object({ line: v.array(Count), lineKind: v.array(AuthoredLineKind) }),
  v.check(
    ({ line, lineKind }) => line.length === lineKind.length,
    "authored line columns must have equal lengths",
  ),
);
export type AuthoredLines = v.InferOutput<typeof AuthoredLines>;

export const AuthoredRows = v.pipe(
  v.object({
    line: v.array(Count),
    lineKind: v.array(AuthoredLineKind),
    axis: v.array(v.picklist(AUTHORED_AXES)),
    printed: v.array(v.string()),
    grid: v.array(v.picklist(AUTHORED_GRIDS)),
    identified: v.array(v.nullable(ExactRationalText)),
    residual: v.array(v.nullable(ExactRationalText)),
  }),
  v.check(
    (rows) =>
      [rows.lineKind, rows.axis, rows.printed, rows.grid, rows.identified, rows.residual].every(
        (column) => column.length === rows.line.length,
      ),
    "authored row columns must have equal lengths",
  ),
  v.check(
    ({ grid, identified, residual }) =>
      grid.every(
        (name, row) =>
          (name === "unidentified") === (identified[row] === null) &&
          (identified[row] === null) === (residual[row] === null),
      ),
    "an authored row has an identified value and residual exactly when its grid isn't unidentified",
  ),
);
export type AuthoredRows = v.InferOutput<typeof AuthoredRows>;

export const AuthoredIdentification = v.object({
  ruleVersion: v.pipe(Integer, v.minValue(1)),
  rows: AuthoredRows,
  excludedRotated: AuthoredLines,
});
export type AuthoredIdentification = v.InferOutput<typeof AuthoredIdentification>;

export function authoredLinesFit(
  lines: AuthoredLines,
  instanceCount: number,
  placementCount: number,
): boolean {
  return lines.line.every((line, row) =>
    lines.lineKind[row] === "instance" ? line < instanceCount : line < placementCount,
  );
}

export const CompilerRequest = v.variant("op", [
  v.strictObject({
    op: v.literal("readModel"),
    omrAuthoringIdentification: v.exactOptional(v.boolean()),
  }),
  v.strictObject({ op: v.literal("readStudio") }),
  v.strictObject({
    op: v.literal("compile"),
    lod: BundleLod,
    studPrimitives: StringList,
    unofficialAllowlist: StringList,
    connectors: CompilerConnectorInputs,
    parts: StringList,
    inlineChecks: v.pipe(
      v.array(v.strictObject({ inline: v.string(), official: v.string() })),
      v.readonly(),
    ),
    records: v.exactOptional(v.boolean()),
  }),
  v.strictObject({
    op: v.literal("bakeNeeds"),
    studPrimitives: StringList,
    vehicles: v.exactOptional(v.nullable(CompilerVehicles)),
  }),
  v.strictObject({
    op: v.literal("bake"),
    studPrimitives: StringList,
    unofficialAllowlist: StringList,
    translucentColors: v.pipe(v.array(Count), v.readonly()),
    tableDepthLdu: v.pipe(Finite, v.gtValue(0)),
    vehicles: v.nullable(CompilerVehicles),
    shard: v.exactOptional(BakeShard),
    keepParts: v.exactOptional(v.boolean()),
    omrAuthoringIdentification: v.exactOptional(v.boolean()),
  }),
]);
export type CompilerRequest = v.InferOutput<typeof CompilerRequest>;

export const CompilerLibraryDelta = v.strictObject({
  key: v.string(),
  files: v.pipe(v.array(v.strictObject({ path: v.string(), bytes: ByteRange })), v.readonly()),
  absent: StringList,
});
export type CompilerLibraryDelta = v.InferOutput<typeof CompilerLibraryDelta>;

export const CompilerRecordDelta = v.strictObject({
  key: v.string(),
  files: v.pipe(v.array(v.strictObject({ reference: v.string(), bytes: ByteRange })), v.readonly()),
  references: StringList,
});
export type CompilerRecordDelta = v.InferOutput<typeof CompilerRecordDelta>;

export const CompilerEnvelope = v.strictObject({
  request: CompilerRequest,
  segments: v.record(v.string(), ByteRange),
  library: v.exactOptional(CompilerLibraryDelta),
  records: v.exactOptional(CompilerRecordDelta),
});
export type CompilerEnvelope = v.InferOutput<typeof CompilerEnvelope>;

export const CompilerBlobs = v.record(v.string(), ByteRange);
export type CompilerBlobs = v.InferOutput<typeof CompilerBlobs>;

export const CompilerModelRead = v.object({
  status: v.literal("read"),
  sections: v.array(ModelSection),
  parts: v.array(v.string()),
  inlineParts: v.array(v.object({ inline: v.string(), official: v.string() })),
  looseGeometry: v.array(
    v.object({ section: v.string(), triangles: Count, quads: Count, occurrences: Count }),
  ),
  instances: Count,
  authoredIdentification: v.optional(AuthoredIdentification),
  blobs: CompilerBlobs,
});
export type CompilerModelRead = v.InferOutput<typeof CompilerModelRead>;

const CompilerNeed = v.object({ status: v.literal("need"), paths: v.array(v.string()) });

export const MalformedFinding = v.pipe(
  v.object({
    file: v.string(),
    kind: v.picklist(["nonFinite", "unparsed", "unresolvable"]),
  }),
  v.description(
    "one finding that made the compile refuse a part before building any mesh. nonFinite: a number that is NaN or infinite. unparsed: a type 1 to 4 line that does not parse. unresolvable: a position, in the part's frame, too far out to resolve the 0.0005 LDU identification. `file` is a path: for unparsed, the file holding the line; for nonFinite, the file whose own line holds the value, or the part when only a composed position is non-finite; for unresolvable, the part",
  ),
);
export type MalformedFinding = v.InferOutput<typeof MalformedFinding>;

const CompilerFailure = v.object({
  status: v.literal("failed"),
  kind: v.picklist(["unresolved", "tooDeep", "unofficial", "noStudRing", "malformed", "tooLarge"]),
  message: v.string(),
  missing: v.exactOptional(v.string()),
  from: v.exactOptional(v.string()),
  path: v.exactOptional(v.string()),
  ldrawOrg: v.exactOptional(v.string()),
  findings: v.exactOptional(v.array(MalformedFinding)),
  cause: v.exactOptional(v.picklist(["beyondAddressSpace", "memoryUnavailable"])),
});

const Reference = { reference: v.string() };
const InlinePair = { inline: v.string(), official: v.string() };

export const CompilerCompile = v.object({
  status: v.literal("compiled"),
  parts: v.array(
    v.variant("status", [
      v.object({
        status: v.literal("compiled"),
        ...Reference,
        glb: ByteRange,
        record: v.nullable(ByteRange),
        file: v.string(),
        header: ModelSection,
        files: Count,
        connectors: v.nullable(InferredConnectorRecords),
      }),
      v.object({ ...CompilerNeed.entries, ...Reference }),
      v.object({ ...CompilerFailure.entries, ...Reference }),
    ]),
  ),
  inline: v.array(
    v.variant("status", [
      v.object({
        status: v.literal("measured"),
        ...InlinePair,
        maxMeasuredDistanceLdu: Finite,
        surfaceWithinWeld: v.boolean(),
        inlineColors: v.array(Count),
        officialColors: v.array(Count),
        colorsMatch: v.boolean(),
        withinWeld: v.boolean(),
      }),
      v.object({ ...CompilerNeed.entries, ...InlinePair }),
      v.object({ ...CompilerFailure.entries, ...InlinePair }),
    ]),
  ),
  weldEpsilonLdu: Finite,
});
export type CompilerCompile = v.InferOutput<typeof CompilerCompile>;

export const CompilerVehicle = v.object({
  origin: v.tuple([Finite, Finite]),
  yaw: Finite,
  guideKind: VehicleGuideKind,
  guides: v.tuple([Finite, Finite]),
  body: IndexRange,
  bogies: v.array(v.object({ instances: IndexRange, pivot: Vec3, axles: v.array(Vec3) })),
  fixedAxles: v.array(Vec3),
  wheelsets: v.array(VehicleWheelset),
  frontCoupler: v.nullable(VehicleCoupler),
  rearCoupler: v.nullable(VehicleCoupler),
  railContacts: v.array(VehicleRailContact),
});
export type CompilerVehicle = v.InferOutput<typeof CompilerVehicle>;

const Duration = v.pipe(Finite, v.minValue(0));

export const CompilerBakePhases = v.object({
  decodeMs: Duration,
  compileMs: Duration,
  latticeMs: Duration,
  coverMs: Duration,
  vehiclesMs: Duration,
});
export type CompilerBakePhases = v.InferOutput<typeof CompilerBakePhases>;

const SeatIntrusion = v.object({
  at: v.tuple([Finite, Finite]),
  depth: Finite,
  instance: Count,
});

export const SeatRefusal = v.object({
  phase: v.tuple([StudPhase, StudPhase]),
  floorY: Finite,
  intrusions: v.array(SeatIntrusion),
});
export type SeatRefusal = v.InferOutput<typeof SeatRefusal>;

export const CompilerBaked = v.object({
  status: v.literal("baked"),
  instances: Count,
  recordedParts: Count,
  resumedParts: Count,
  lattice: v.nullable(ModelLattice),
  latticeIssue: v.exactOptional(v.string()),
  seatRefusals: v.exactOptional(v.array(SeatRefusal)),
  cover: v.object({
    studs: Count,
    coveredStuds: Count,
    keptOpenBelow: Count,
    cells: v.nullable(
      v.object({ origin: v.tuple([Finite, Finite]), size: CellGridSize, bottomY: Finite }),
    ),
  }),
  vehicles: v.exactOptional(v.array(CompilerVehicle)),
  vehicleIssue: v.exactOptional(v.string()),
  phases: CompilerBakePhases,
  blobs: CompilerBlobs,
});
export type CompilerBaked = v.InferOutput<typeof CompilerBaked>;

export const CompilerBakeNeeds = v.variant("status", [
  v.object({ status: v.literal("complete") }),
  CompilerNeed,
]);
export type CompilerBakeNeeds = v.InferOutput<typeof CompilerBakeNeeds>;

export const CompilerBake = v.variant("status", [
  CompilerBaked,
  CompilerNeed,
  v.object({ status: v.literal("failed"), message: v.string() }),
]);
export type CompilerBake = v.InferOutput<typeof CompilerBake>;

export const CompilerError = v.object({ status: v.literal("error"), message: v.string() });

function vehicleInstances(vehicle: ModelVehicle): ReadonlyArray<number> {
  return [
    ...vehicle.body,
    ...vehicle.bogies.flatMap((bogie) => bogie.instances),
    ...vehicle.wheelsets.map((wheelset) => wheelset.instance),
    ...[vehicle.frontCoupler, vehicle.rearCoupler].flatMap((coupler) =>
      coupler === null ? [] : [coupler.instance],
    ),
  ];
}

export const MODEL_ROOT = -1;

export interface SubmodelTreeArrays {
  readonly parent: ArrayLike<number>;
  readonly matrices: ArrayLike<number>;
  readonly ofPart: ArrayLike<number>;
}

function isInstanceIndex(value: number | undefined, below: number): boolean {
  return value !== undefined && Number.isInteger(value) && value >= MODEL_ROOT && value < below;
}

export function submodelTreeFits(tree: SubmodelTreeArrays, instanceCount: number): boolean {
  const count = tree.parent.length;
  if (tree.matrices.length !== count * MATRIX_FLOATS || tree.ofPart.length !== instanceCount) {
    return false;
  }
  for (let n = 0; n < count; n++) {
    if (!isInstanceIndex(tree.parent[n], n)) return false;
  }
  for (let i = 0; i < instanceCount; i++) {
    if (!isInstanceIndex(tree.ofPart[i], count)) return false;
  }
  return true;
}

export const SubmodelTree = v.object({
  parent: v.array(Integer),
  matrices: v.array(Finite),
  ofPart: v.array(Integer),
});

export const ModelFile = v.pipe(
  v.object({
    name: v.string(),
    file: v.string(),
    source: v.string(),
    retrieved: v.string(),
    sha256: Sha256Hex,
    sections: v.array(ModelSection),
    inlinePartsResolvedToOfficial: v.array(InlinePartResolution),
    parts: v.array(v.string()),
    shapes: v.array(PartShape),
    lattice: v.nullable(ModelLattice),
    vehicles: v.array(ModelVehicle),
    cover: ModelFileCover,
    notDrawn: v.optional(v.array(NotDrawnSection)),
    instances: v.object({
      part: v.array(Count),
      color: v.array(Integer),
      matrix: v.array(Finite),
    }),
    partTransforms: v.array(Finite),
    submodels: SubmodelTree,
    authoredIdentification: v.optional(AuthoredIdentification),
  }),
  v.check(
    ({ parts, instances, partTransforms }) =>
      instances.part.length === instances.color.length &&
      instances.matrix.length === instances.part.length * MATRIX_FLOATS &&
      partTransforms.length === instances.part.length * MATRIX_FLOATS &&
      instances.part.every((index) => index < parts.length),
    "model instance arrays are inconsistent",
  ),
  v.check(
    ({ instances, submodels }) => submodelTreeFits(submodels, instances.part.length),
    "model sub-model tree is inconsistent",
  ),
  v.check(
    ({ instances, submodels, authoredIdentification }) =>
      authoredIdentification === undefined ||
      [authoredIdentification.rows, authoredIdentification.excludedRotated].every((lines) =>
        authoredLinesFit(lines, instances.part.length, submodels.parent.length),
      ),
    "authored identification names an instance or placement the model doesn't have",
  ),
  v.check(
    ({ parts, shapes }) =>
      shapes.length === parts.length && shapes.every((shape, i) => shape.id === parts[i]),
    "model shapes do not follow its part list",
  ),
  v.check(
    ({ vehicles, instances }) =>
      vehicles.every((vehicle) =>
        vehicleInstances(vehicle).every((index) => index < instances.part.length),
      ),
    "a vehicle names an instance the model does not have",
  ),
  v.check(
    ({ cover, instances }) =>
      (cover.cells?.footing.instance ?? []).every((index) => index < instances.part.length),
    "a footing cell names an instance the model does not have",
  ),
);
export type ModelFile = v.InferOutput<typeof ModelFile>;

const LdrawSource = v.object({
  path: v.string(),
  author: v.string(),
  license: v.nullable(v.string()),
});

export const PartExtras = v.object({
  unit: v.literal("LDU"),
  upAxis: v.literal("+Y"),
  ldraw: v.object({
    file: v.string(),
    name: v.string(),
    title: v.string(),
    author: v.string(),
    license: v.nullable(v.string()),
    ldrawOrg: v.nullable(v.string()),
    note: v.string(),
  }),
  sources: v.array(LdrawSource),
  studs: v.array(StudRecord),
  bounds: Bounds,
  technic: v.optional(PartTechnic),
  rolling: v.optional(PartRolling),
  topSurface: v.optional(PartTopSurface),
});
export type PartExtras = v.InferOutput<typeof PartExtras>;

const GltfIndex = Count;

export const GltfPrimitive = v.object({
  attributes: v.object({ POSITION: GltfIndex, NORMAL: GltfIndex }),
  indices: GltfIndex,
  mode: Integer,
  extras: v.object({ ldrawColor: Integer }),
});
export type GltfPrimitive = v.InferOutput<typeof GltfPrimitive>;

export const GltfAccessor = v.object({
  bufferView: GltfIndex,
  componentType: Integer,
  count: Count,
  type: v.picklist(["SCALAR", "VEC3"]),
  min: v.optional(Vec3),
  max: v.optional(Vec3),
});
export type GltfAccessor = v.InferOutput<typeof GltfAccessor>;

export const GltfBufferView = v.object({
  buffer: GltfIndex,
  byteOffset: Count,
  byteLength: Count,
  target: Integer,
});
export type GltfBufferView = v.InferOutput<typeof GltfBufferView>;

export const GltfDocument = v.object({
  asset: v.object({ version: v.literal("2.0"), generator: v.string() }),
  scene: GltfIndex,
  scenes: v.array(v.object({ nodes: v.array(GltfIndex) })),
  nodes: v.array(v.object({ mesh: GltfIndex, name: v.string() })),
  meshes: v.array(v.object({ name: v.string(), primitives: v.array(GltfPrimitive) })),
  accessors: v.array(GltfAccessor),
  bufferViews: v.array(GltfBufferView),
  buffers: v.array(v.object({ byteLength: Count })),
  extras: PartExtras,
});
export type GltfDocument = v.InferOutput<typeof GltfDocument>;

export const FarMeshExtras = v.object({
  unit: v.literal("LDU"),
  upAxis: v.literal("+Y"),
  model: v.string(),
  ldraw: v.object({
    file: v.string(),
    name: v.string(),
    source: v.string(),
    authors: v.array(v.string()),
    licenses: v.array(v.string()),
    sections: v.array(ModelSection),
    note: v.string(),
    sources: v.pipe(v.array(LdrawSource), v.minLength(1)),
  }),
  voxels: v.object({
    cellLdu: IntegerVec3,
    cellMarginLdu: Finite,
    origin: IntegerVec3,
    dims: CountVec3,
    count: Count,
    cellIndex: v.string(),
    geometry: v.string(),
  }),
  arrays: v.object({ voxelCells: GltfIndex, voxelColors: GltfIndex }),
});
export type FarMeshExtras = v.InferOutput<typeof FarMeshExtras>;

export const FarMeshGltfDocument = v.object({ ...GltfDocument.entries, extras: FarMeshExtras });
export type FarMeshGltfDocument = v.InferOutput<typeof FarMeshGltfDocument>;

export const RUNNING_GEAR_OVERRIDE_VERSION = 2;
export const MODEL_FRAME_OVERRIDE_VERSION = 1;

export const BogieOverride = v.strictObject({ instances: v.array(Count), pivot: Vec3 });
export type BogieOverride = v.InferOutput<typeof BogieOverride>;

export const CouplerOverride = v.strictObject({ instance: Count, face: Vec3 });
export type CouplerOverride = v.InferOutput<typeof CouplerOverride>;

export const VehicleOverride = v.strictObject({
  vehicle: Count,
  bogies: v.optional(v.array(BogieOverride)),
  couplers: v.optional(v.array(CouplerOverride)),
});
export type VehicleOverride = v.InferOutput<typeof VehicleOverride>;

export const RunningGearOverride = v.strictObject({
  version: v.picklist([RUNNING_GEAR_OVERRIDE_VERSION, MODEL_FRAME_OVERRIDE_VERSION]),
  modelSha256: Sha256Hex,
  model: v.string(),
  vehicles: v.array(VehicleOverride),
});
export type RunningGearOverride = v.InferOutput<typeof RunningGearOverride>;

export const PaletteModel = v.strictObject({
  name: v.string(),
  origin: ModelOrigin,
  role: v.optional(ModelRole),
  file: v.string(),
  sha256: Sha256Hex,
  source: v.string(),
  retrieved: v.string(),
  notDrawn: v.optional(v.array(v.strictObject({ section: v.string(), reason: v.string() }))),
  set: v.optional(v.strictObject(ModelSet.entries)),
});
export type PaletteModel = v.InferOutput<typeof PaletteModel>;

export const AuditGroup = v.strictObject({ group: v.string(), parts: v.array(v.string()) });
export type AuditGroup = v.InferOutput<typeof AuditGroup>;

export const GithubMirror = v.strictObject(BundleSource.entries);
export type GithubMirror = v.InferOutput<typeof GithubMirror>;

export const GithubArchive = v.strictObject({
  kind: v.literal("github-archive"),
  repo: v.string(),
  commit: v.string(),
  root: v.string(),
});
export type GithubArchive = v.InferOutput<typeof GithubArchive>;

export const SectionVocabularyFile = v.strictObject({
  source: GithubArchive,
  archive: v.strictObject({ file: v.string(), sha256: Sha256Hex }),
  license: v.string(),
  attribution: v.array(v.string()),
  ...SectionVocabulary.entries,
});
export type SectionVocabularyFile = v.InferOutput<typeof SectionVocabularyFile>;

export const LIBRARY_CONNECTORS_FORMAT = 1;
export const LIBRARY_CONNECTORS_INDEX_FILE = "library-connectors.json";

export const LibraryConnectorsIndex = v.strictObject({
  format: v.literal(LIBRARY_CONNECTORS_FORMAT),
  ldraw: GithubMirror,
  shadow: GithubArchive,
  sectionVocabulary: Sha256Hex,
  connectivity: v.strictObject({ file: v.string() }),
  connectors: v.strictObject({ file: v.string() }),
});
export type LibraryConnectorsIndex = v.InferOutput<typeof LibraryConnectorsIndex>;

export const LibraryConnectorsPin = v.strictObject({
  index: LibraryConnectorsIndexRef,
  parts: Count,
  records: v.strictObject({ connectivity: Count, connectors: Count }),
  faces: v.strictObject({ connectivity: Count, connectors: Count }),
  partsWithPieces: Count,
});
export type LibraryConnectorsPin = v.InferOutput<typeof LibraryConnectorsPin>;

export const SHADOW_LIBRARY_FORMAT = 1;
export const SHADOW_LIBRARY_INDEX_FILE = "shadow-library.json";

const AddressedFiles = v.record(v.string(), v.string());

export const ShadowLibraryIndex = v.strictObject({
  format: v.literal(SHADOW_LIBRARY_FORMAT),
  source: GithubArchive,
  license: v.literal(CONNECTIVITY_LICENSE),
  attribution: v.array(v.string()),
  shadow: AddressedFiles,
  patches: AddressedFiles,
  patchManifest: v.strictObject({ file: v.string() }),
  licenseText: v.strictObject({ file: v.string() }),
});
export type ShadowLibraryIndex = v.InferOutput<typeof ShadowLibraryIndex>;

export const ShadowLibraryPin = v.strictObject({
  index: ShadowLibraryIndexRef,
  archive: v.strictObject({ file: v.string(), sha256: Sha256Hex }),
  patchManifest: Sha256Hex,
  files: v.strictObject({ shadow: Count, patches: Count }),
});
export type ShadowLibraryPin = v.InferOutput<typeof ShadowLibraryPin>;

export const CatalogLocation = v.variant("kind", [GithubMirror, GithubArchive]);
export type CatalogLocation = v.InferOutput<typeof CatalogLocation>;

export const LdrawLibraryIndex = v.strictObject({
  format: v.literal(1),
  source: GithubMirror,
  archive: v.strictObject({ file: v.string(), sha256: Sha256Hex }),
  files: v.record(v.string(), Sha256Hex),
});
export type LdrawLibraryIndex = v.InferOutput<typeof LdrawLibraryIndex>;

export const LIBRARY_BAKE_FORMAT = 1;

export const LibraryBakeOptions = v.strictObject({
  studPrimitives: StringList,
  unofficialAllowlist: StringList,
  primitives: PrimitiveConnectorTable,
});
export type LibraryBakeOptions = v.InferOutput<typeof LibraryBakeOptions>;

export const LibraryBakePart = v.strictObject({ record: v.string(), glb: v.string() });
export type LibraryBakePart = v.InferOutput<typeof LibraryBakePart>;

export const LIBRARY_BAKE_BUCKETS = 256;
export const LIBRARY_BAKE_INDEX_FILE = "library-bake.json";
export const CONTENT_DIGEST_HEX_DIGITS = 16;
const ADDRESSED_NAME = /\.(?<digest>[0-9a-f]{16})(?<extension>\.[^./]+)$/u;

export function contentAddressedFile(file: string, sha256: string): string {
  const dot = file.lastIndexOf(".");
  const stem = dot < 0 ? file : file.slice(0, dot);
  const extension = dot < 0 ? "" : file.slice(dot);
  return `${stem}.${sha256.slice(0, CONTENT_DIGEST_HEX_DIGITS)}${extension}`;
}

export function contentDigestOf(file: string): string | null {
  return ADDRESSED_NAME.exec(file)?.groups?.["digest"] ?? null;
}
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function libraryBakeBucket(partId: string): number {
  let hash = FNV_OFFSET;
  for (let unit = 0; unit < partId.length; unit++) {
    hash = Math.imul(hash ^ partId.charCodeAt(unit), FNV_PRIME) >>> 0;
  }
  return hash % LIBRARY_BAKE_BUCKETS;
}

export const LibraryBakeBucket = v.strictObject({
  bucket: v.pipe(Count, v.maxValue(LIBRARY_BAKE_BUCKETS - 1)),
  parts: v.record(v.string(), LibraryBakePart),
  rollingDiagnostics: v.optional(RollingDiagnosticsRef),
});
export type LibraryBakeBucket = v.InferOutput<typeof LibraryBakeBucket>;

export const LibraryBakeIndex = v.strictObject({
  format: v.literal(LIBRARY_BAKE_FORMAT),
  source: GithubMirror,
  options: LibraryBakeOptions,
  licenses: StringList,
  buckets: v.pipe(v.array(v.string()), v.length(LIBRARY_BAKE_BUCKETS), v.readonly()),
  failed: v.record(v.string(), v.string()),
});
export type LibraryBakeIndex = v.InferOutput<typeof LibraryBakeIndex>;

export const LibraryBakePin = v.strictObject({
  index: LibraryBakeIndexRef,
  parts: Count,
  records: Count,
  failed: Count,
});
export type LibraryBakePin = v.InferOutput<typeof LibraryBakePin>;

export const CatalogSourceUse = v.picklist([
  "crosswalk",
  "inventory-check",
  "categories",
  "connectors",
]);
export type CatalogSourceUse = v.InferOutput<typeof CatalogSourceUse>;

export const CatalogSource = v.strictObject({
  name: v.string(),
  use: CatalogSourceUse,
  describes: v.string(),
  source: CatalogLocation,
  files: v.array(v.string()),
});
export type CatalogSource = v.InferOutput<typeof CatalogSource>;

export const Palette = v.strictObject({
  source: BundleSource,
  config: v.array(v.string()),
  unofficialAllowlist: v.array(v.string()),
  parts: v.array(
    v.strictObject({
      id: v.string(),
      role: PartRole,
      displayColor: v.optional(v.strictObject(DisplayColor.entries)),
      producedColors: v.optional(
        v.strictObject({
          ...ProducedColors.entries,
          colors: v.array(v.strictObject(ProducedColors.entries.colors.item.entries)),
        }),
      ),
    }),
  ),
  omrSource: BundleSource,
  models: v.array(PaletteModel),
  vehicleParts: v.strictObject({
    bogiePivots: v.array(v.string()),
    pivotPins: v.array(v.string()),
    wheelsets: v.array(v.string()),
    wheels: v.array(v.string()),
    couplers: v.array(v.string()),
  }),
  audit: v.array(AuditGroup),
  connectivitySource: BundleSource,
  producedColorSource: v.optional(v.string()),
  catalogSources: v.array(CatalogSource),
});
export type Palette = v.InferOutput<typeof Palette>;

export const FixtureModels = v.strictObject({ models: v.array(PaletteModel) });
export type FixtureModels = v.InferOutput<typeof FixtureModels>;

export {
  CrossingRamp,
  CrossingTrackSystem,
  LevelCrossingFacts,
  OUTLINE_UNITS_PER_LDU,
  PartOutline,
  PlanAxis,
  PlanBox,
  PlanOutline,
  PlanOutlinesFile,
  PlanPoint,
  PlanRing,
  RampRise,
} from "./level-crossing.ts";

export {
  MilsBuild,
  MilsBuildFeature,
  MilsBuildRiver,
  MilsFeature,
  MilsFinish,
  MilsModuleEdge,
  MilsProfile,
  MilsSpec,
  MilsSpecLevelFeature,
  MilsSpecRiver,
  MilsSurfaceFeature,
  MilsTemplate,
} from "./mils-profile.ts";

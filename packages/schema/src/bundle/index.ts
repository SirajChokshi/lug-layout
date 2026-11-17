import { pose16, ZETA16_COEFFICIENT_COUNT, ZETA16_ORDER, zeta16, type Zeta16 } from "@brr/math";
import * as v from "valibot";

const MATRIX_FLOATS = 12;
const STUD_PHASES = 20;
const BITS_PER_WORD = 32;
export const EMPTY_COLUMN = -1;
const ALPHA_OPAQUE = 255;

const Finite = v.pipe(v.number(), v.finite());
const Integer = v.pipe(v.number(), v.integer());
const Count = v.pipe(Integer, v.minValue(0));
const StudPhase = v.pipe(Integer, v.minValue(0), v.maxValue(STUD_PHASES - 1));
const IntegerString = v.pipe(v.string(), v.regex(/^-?\d+$/u));
const Zeta16Coefficients = v.pipe(v.array(IntegerString), v.length(ZETA16_COEFFICIENT_COUNT));
const Matrix = v.pipe(v.array(Finite), v.length(MATRIX_FLOATS));

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
  v.object({ kind: v.literal("customPart"), section: v.string(), reason: v.string() }),
]);
export type NotDrawnSection = v.InferOutput<typeof NotDrawnSection>;

const CellGridSize = v.tuple([Count, Count]);
const ColumnPlates = v.pipe(Integer, v.minValue(EMPTY_COLUMN));

function cellCount([width, depth]: readonly [number, number]): number {
  return width * depth;
}

export const ModelFileCells = v.pipe(
  v.object({
    origin: v.tuple([Finite, Finite]),
    size: CellGridSize,
    bottomY: Finite,
    groundY: v.nullable(Finite),
    footprint: v.array(Count),
    flat: v.array(Count),
    columnBottom: v.array(ColumnPlates),
    columnTop: v.array(ColumnPlates),
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
      groundY: v.nullable(Finite),
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
  author: v.string(),
  license: v.nullable(v.string()),
  displayColor: v.optional(DisplayColor),
  producedColors: v.optional(ProducedColors),
  trackEnds: v.optional(v.array(TrackEnd)),
  baseplate: v.boolean(),
});
export type ManifestPart = v.InferOutput<typeof ManifestPart>;

export const StudPrimitive = v.object({
  ...CompiledMesh.entries,
  name: v.string(),
  path: v.string(),
  file: v.string(),
});
export type StudPrimitive = v.InferOutput<typeof StudPrimitive>;

export const BundleCompiler = v.object({
  file: v.string(),
  unofficialAllowlist: v.array(v.string()),
});
export type BundleCompiler = v.InferOutput<typeof BundleCompiler>;

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

export const BundleLod = v.picklist(["standard", "low", "far"]);
export type BundleLod = v.InferOutput<typeof BundleLod>;

export const BundleManifest = v.object({
  bundleVersion: v.pipe(v.string(), v.regex(/^[0-9a-f]{16}$/u)),
  unit: v.literal("LDU"),
  upAxis: v.literal("+Y"),
  lod: BundleLod,
  source: BundleSource,
  parts: v.array(ManifestPart),
  studPrimitives: v.array(StudPrimitive),
  colors: v.array(BundleColor),
  credits: v.array(BundleCredit),
  models: v.array(BundleModelEntry),
  modified: v.string(),
  disclaimer: v.string(),
  inputs: v.object({
    ldraw: BundleSource,
    omr: BundleSource,
    lockSha256: Sha256Hex,
    paletteSha256: Sha256Hex,
  }),
  trackCatalog: TrackCatalog,
  compiler: v.nullable(BundleCompiler),
});
export type BundleManifest = v.InferOutput<typeof BundleManifest>;

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
    lattice: v.nullable(ModelLattice),
    vehicles: v.array(ModelVehicle),
    cover: ModelFileCover,
    notDrawn: v.optional(v.array(NotDrawnSection)),
    instances: v.object({
      part: v.array(Count),
      color: v.array(Integer),
      matrix: v.array(Finite),
    }),
  }),
  v.check(
    ({ parts, instances }) =>
      instances.part.length === instances.color.length &&
      instances.matrix.length === instances.part.length * MATRIX_FLOATS &&
      instances.part.every((index) => index < parts.length),
    "model instance arrays are inconsistent",
  ),
  v.check(
    ({ vehicles, instances }) =>
      vehicles.every((vehicle) =>
        vehicleInstances(vehicle).every((index) => index < instances.part.length),
      ),
    "a vehicle names an instance the model does not have",
  ),
);
export type ModelFile = v.InferOutput<typeof ModelFile>;

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
  sources: v.array(
    v.object({ path: v.string(), author: v.string(), license: v.nullable(v.string()) }),
  ),
  studs: v.array(v.object({ primitive: v.string(), color: Integer, matrix: Matrix })),
  bounds: Bounds,
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

export const Palette = v.strictObject({
  source: BundleSource,
  config: v.array(v.string()),
  studPrimitives: v.array(v.string()),
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
});
export type Palette = v.InferOutput<typeof Palette>;

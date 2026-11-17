import { pose16, ZETA16_COEFFICIENT_COUNT, ZETA16_ORDER, zeta16, type Zeta16 } from "@brr/math";
import * as v from "valibot";

const MATRIX_FLOATS = 12;
const STUD_PHASES = 20;
const ALPHA_OPAQUE = 255;

const Finite = v.pipe(v.number(), v.finite());
const Integer = v.pipe(v.number(), v.integer());
const Count = v.pipe(Integer, v.minValue(0));
const StudPhase = v.pipe(Integer, v.minValue(0), v.maxValue(STUD_PHASES - 1));
const Sha256Hex = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));
const IntegerString = v.pipe(v.string(), v.regex(/^-?\d+$/u));
const Zeta16Coefficients = v.pipe(v.array(IntegerString), v.length(ZETA16_COEFFICIENT_COUNT));
const Matrix = v.pipe(v.array(Finite), v.length(MATRIX_FLOATS));

export function encodeZeta16(value: Zeta16): string[] {
  return value.map((coefficient) => coefficient.toString());
}

export function decodeZeta16(coefficients: ReadonlyArray<string>): Zeta16 {
  return zeta16(coefficients.map((coefficient) => BigInt(coefficient)));
}

export const Vec3 = v.tuple([Finite, Finite, Finite]);
export type Vec3 = v.InferOutput<typeof Vec3>;

const Bounds = v.object({ min: Vec3, max: Vec3 });

export const PartRole = v.picklist(["ground", "road", "track", "wall", "roof", "detail", "model"]);
export type PartRole = v.InferOutput<typeof PartRole>;

export const DisplayColor = v.object({ ldraw: Integer, source: v.string() });
export type DisplayColor = v.InferOutput<typeof DisplayColor>;

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
    partFrame: v.object({ xLdu: Finite, zLdu: Finite, headingHalfSteps: Integer }),
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
  maxVertexDistanceLdu: Finite,
});

export const ModelOrigin = v.picklist(["omr", "generated"]);
export type ModelOrigin = v.InferOutput<typeof ModelOrigin>;

export const ModelRole = v.picklist(["road-module"]);
export type ModelRole = v.InferOutput<typeof ModelRole>;

export const BundleModelEntry = v.object({
  name: v.string(),
  file: v.string(),
  origin: ModelOrigin,
  set: v.nullable(v.object({ name: v.string(), year: Integer, source: v.string() })),
  role: v.optional(ModelRole),
  source: v.string(),
  authors: v.array(v.string()),
  licenses: v.array(v.string()),
  sections: v.array(ModelSection),
  inlinePartsResolvedToOfficial: v.array(InlinePartResolution),
  instances: Count,
  lattice: v.nullable(ModelLattice),
  vehicles: Count,
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
  trackEnds: v.optional(v.array(TrackEnd)),
});
export type ManifestPart = v.InferOutput<typeof ManifestPart>;

export const StudPrimitive = v.object({
  ...CompiledMesh.entries,
  name: v.string(),
  path: v.string(),
  file: v.string(),
});
export type StudPrimitive = v.InferOutput<typeof StudPrimitive>;

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
  colors: v.array(
    v.object({
      code: Integer,
      name: v.string(),
      rgb: v.string(),
      alpha: v.pipe(Integer, v.minValue(0), v.maxValue(ALPHA_OPAQUE)),
    }),
  ),
  credits: v.array(
    v.object({
      path: v.string(),
      title: v.string(),
      author: v.string(),
      license: v.nullable(v.string()),
    }),
  ),
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

import * as v from "valibot";

const Count = v.pipe(v.number(), v.integer(), v.minValue(0));
const Positive = v.pipe(v.number(), v.integer(), v.minValue(1));
const PlateOffset = v.pipe(v.number(), v.integer());
const Source = v.pipe(v.string(), v.minLength(1));
const ColorList = v.pipe(v.array(Count), v.minLength(1));
const PartList = v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1));

const CitedCount = v.strictObject({ value: Count, source: Source });
const CitedPositive = v.strictObject({ value: Positive, source: Source });
const CitedRange = v.pipe(
  v.strictObject({ min: PlateOffset, max: PlateOffset, source: Source }),
  v.check((range) => range.min <= range.max, "min must not exceed max"),
);
const CitedColors = v.strictObject({ values: ColorList, source: Source });

export const MilsFinish = v.picklist(["plate", "tile"]);
export type MilsFinish = v.InferOutput<typeof MilsFinish>;

export const MilsSurfaceFeature = v.picklist(["path", "track", "road", "river"]);
export type MilsSurfaceFeature = v.InferOutput<typeof MilsSurfaceFeature>;

export const MilsFeature = v.picklist(["path", "track", "road", "river", "rail"]);
export type MilsFeature = v.InferOutput<typeof MilsFeature>;

export const MilsModuleEdge = v.picklist(["minX", "maxX", "minZ", "maxZ"]);
export type MilsModuleEdge = v.InferOutput<typeof MilsModuleEdge>;

export const MilsSpecLevelFeature = v.strictObject({
  widthStuds: CitedPositive,
  aboveSurfacePlates: CitedRange,
  ldrawColors: CitedColors,
});
export type MilsSpecLevelFeature = v.InferOutput<typeof MilsSpecLevelFeature>;

export const MilsSpecRiver = v.strictObject({
  widthStuds: CitedPositive,
  waterPlates: CitedCount,
  ldrawColors: CitedColors,
  bankStartPlates: CitedCount,
  bankRisePlatesPerStud: CitedPositive,
});
export type MilsSpecRiver = v.InferOutput<typeof MilsSpecRiver>;

export const MilsSpec = v.strictObject({
  moduleStuds: CitedPositive,
  surfacePlates: CitedPositive,
  features: v.strictObject({
    path: MilsSpecLevelFeature,
    track: MilsSpecLevelFeature,
    road: MilsSpecLevelFeature,
    river: MilsSpecRiver,
  }),
  rail: v.strictObject({ source: Source }),
});
export type MilsSpec = v.InferOutput<typeof MilsSpec>;

export const MilsBuildFeature = v.strictObject({
  widthStuds: Positive,
  plates: Count,
  finish: MilsFinish,
  ldrawColor: Count,
});
export type MilsBuildFeature = v.InferOutput<typeof MilsBuildFeature>;

export const MilsBuildRiver = v.strictObject({
  ...MilsBuildFeature.entries,
  bedLdrawColor: Count,
  bankStartPlates: Count,
  bankRisePlatesPerStud: Positive,
});
export type MilsBuildRiver = v.InferOutput<typeof MilsBuildRiver>;

export const MilsBuild = v.strictObject({
  terrainLdrawColor: Count,
  structureLdrawColor: Count,
  parts: v.strictObject({
    baseplate: v.string(),
    corner: v.string(),
    edgeJoin: v.string(),
    edgeCourse: PartList,
    support: PartList,
    plates: PartList,
    tiles: PartList,
  }),
  features: v.strictObject({
    path: MilsBuildFeature,
    track: MilsBuildFeature,
    road: MilsBuildFeature,
    river: MilsBuildRiver,
  }),
  rail: v.strictObject({ part: v.string(), ldrawColor: Count }),
});
export type MilsBuild = v.InferOutput<typeof MilsBuild>;

export const MilsTemplate = v.strictObject({
  name: v.pipe(v.string(), v.regex(/^[a-z0-9-]+$/u)),
  title: v.pipe(v.string(), v.minLength(1)),
  feature: v.nullable(MilsFeature),
  edges: v.array(MilsModuleEdge),
});
export type MilsTemplate = v.InferOutput<typeof MilsTemplate>;

export const MilsProfile = v.strictObject({
  profile: v.literal("mils"),
  frame: v.string(),
  spec: MilsSpec,
  build: MilsBuild,
  elementSource: Source,
  elements: v.record(v.pipe(v.string(), v.regex(/^[^@]+@\d+$/u)), v.array(v.string())),
  templates: v.pipe(v.array(MilsTemplate), v.minLength(1)),
});
export type MilsProfile = v.InferOutput<typeof MilsProfile>;

import * as v from "valibot";

const Finite = v.pipe(v.number(), v.finite());
const Positive = v.pipe(Finite, v.minValue(0));
const Unit = v.pipe(v.number(), v.safeInteger());

export const OUTLINE_UNITS_PER_LDU = 1_000_000;

export const PlanPoint = v.tuple([Unit, Unit]);
export type PlanPoint = v.InferOutput<typeof PlanPoint>;

export const PlanRing = v.pipe(v.array(PlanPoint), v.minLength(3));
export type PlanRing = v.InferOutput<typeof PlanRing>;

export const PlanOutline = v.pipe(v.array(PlanRing), v.minLength(1));
export type PlanOutline = v.InferOutput<typeof PlanOutline>;

export const PlanAxis = v.picklist(["x", "z"]);
export type PlanAxis = v.InferOutput<typeof PlanAxis>;

export const RampRise = v.object({ axis: PlanAxis, toward: v.picklist([-1, 1]) });
export type RampRise = v.InferOutput<typeof RampRise>;

export const PlanBox = v.object({ minX: Finite, minZ: Finite, maxX: Finite, maxZ: Finite });
export type PlanBox = v.InferOutput<typeof PlanBox>;

export const CrossingRamp = v.object({
  part: v.string(),
  title: v.string(),
  undersideY: Finite,
  lowEdgeLdu: Positive,
  highEdgeLdu: Positive,
  runLdu: Positive,
  rise: RampRise,
  footprint: PlanBox,
  antiStuds: v.array(v.tuple([Finite, Finite])),
});
export type CrossingRamp = v.InferOutput<typeof CrossingRamp>;

export const CrossingTrackSystem = v.object({
  system: v.string(),
  straight: v.string(),
  railTopLdu: Positive,
});
export type CrossingTrackSystem = v.InferOutput<typeof CrossingTrackSystem>;

export const LevelCrossingFacts = v.object({
  systems: v.array(CrossingTrackSystem),
  ramps: v.array(CrossingRamp),
});
export type LevelCrossingFacts = v.InferOutput<typeof LevelCrossingFacts>;

export const PartOutline = v.object({ part: v.string(), rings: PlanOutline, roundedLdu: Positive });
export type PartOutline = v.InferOutput<typeof PartOutline>;

export const PlanOutlinesFile = v.object({
  unitsPerLdu: v.literal(OUTLINE_UNITS_PER_LDU),
  outlines: v.array(PartOutline),
});
export type PlanOutlinesFile = v.InferOutput<typeof PlanOutlinesFile>;

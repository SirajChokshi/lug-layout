import type { IPlanService } from "./plan-service.ts";

export interface UncheckedPlanRule {
  readonly id: string;
  readonly text: string;
  readonly owner: string;
}

export const NOT_YET_ASSIGNED = "not yet assigned";

export const UNCHECKED_PLAN_RULES: ReadonlyArray<UncheckedPlanRule> = [
  {
    id: "modelTrackSeam",
    text: "A model's own track at a table seam is judged by the model's footing cells, so a track container whose end sits exactly on a seam is reported as across the seam",
    owner: `${NOT_YET_ASSIGNED} (needs per-part footing and carried-track outlines on model rows)`,
  },
  {
    id: "seamJoins",
    text: "Whether placements meeting at a seam join or leave a gap",
    owner: "E6 (#511)",
  },
  {
    id: "modelTrackOverlap",
    text: "Models overlapping laid track: refused while editing, not checked in a loaded world, where support is judged as if that track weren't there",
    owner: NOT_YET_ASSIGNED,
  },
  {
    id: "supportChains",
    text: "Support through chains: models held only by each other's side connections, off the table, count as held",
    owner: NOT_YET_ASSIGNED,
  },
  {
    id: "trackSupportLoading",
    text: "Laid track's support while its support parts or stud seats are still loading: counted as held until they load",
    owner: NOT_YET_ASSIGNED,
  },
  {
    id: "roadSurfaces",
    text: "Road joins for models that aren't palette road plates",
    owner: "#150",
  },
  { id: "clearance", text: "Clearance envelopes along the track", owner: "M6" },
  { id: "realElements", text: "Real-element badges L1 and L2", owner: NOT_YET_ASSIGNED },
  {
    id: "mixedTrack",
    text: "Mixed 9V and plastic track in one powered loop",
    owner: NOT_YET_ASSIGNED,
  },
  {
    id: "aisles",
    text: "Aisles: reach counts every free table edge as somewhere to stand",
    owner: NOT_YET_ASSIGNED,
  },
];

export function buildableAsPlanned(plans: IPlanService, planId: string): boolean {
  return (
    UNCHECKED_PLAN_RULES.length === 0 &&
    plans.issueCount(planId) === 0 &&
    plans.unmeasuredCount(planId) === 0
  );
}

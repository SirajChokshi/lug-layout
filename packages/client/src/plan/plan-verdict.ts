import type { PlanIssue } from "@brr/domain";
import type { IPlanService } from "./plan-service.ts";

export interface UncheckedPlanRule {
  readonly id: string;
  readonly text: string;
  readonly owner: string;
}

export const NOT_YET_ASSIGNED = "not yet assigned";

export const UNCHECKED_PLAN_RULES: ReadonlyArray<UncheckedPlanRule> = [
  {
    id: "runFrameTrack",
    text: "A model's own track off the track lattice (in a run frame) counts as ordinary parts: its footing cells and box can report it across a seam or off the table where its exact outline wouldn't",
    owner: `${NOT_YET_ASSIGNED} (needs exact poses for run-frame track)`,
  },
  {
    id: "seamJoins",
    text: "Whether placements meeting at a seam join or leave a gap: stud mates name no partner, so a join through a bridging part can't be told from a gap yet",
    owner: NOT_YET_ASSIGNED,
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

function blocksBuilding(issue: PlanIssue): boolean {
  return issue.rule !== "bomMapping";
}

export function buildableAsPlanned(plans: IPlanService, planId: string): boolean {
  return (
    UNCHECKED_PLAN_RULES.length === 0 &&
    !plans.issues(planId).some(blocksBuilding) &&
    plans.unmeasuredCount(planId) === 0
  );
}

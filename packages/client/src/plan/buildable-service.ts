import {
  checkBuildable,
  placementId,
  DEFAULT_MAX_REACH_MM,
  type BuildableCatalog,
  type BuildablePlacement,
  type Crosswalk,
  type BuildableReport,
  type ItemSpec,
  type ModuleProfileId,
  type ModuleStandards,
} from "@brr/domain";
import { isRot90 } from "@brr/math";
import { SCENE_BACKEND, type ISceneBackend } from "@brr/render";
import { inject, injectable } from "inversify";
import { PLAN_SERVICE } from "../tokens.ts";
import type { IPlanService, PlanSnapshot } from "./plan-service.ts";

export const DEFAULT_MODULE_PROFILE: ModuleProfileId = "free";

export interface PlanSettings {
  readonly profile: ModuleProfileId;
  readonly maxReachMm: number;
}

export interface BuildableSnapshot {
  readonly ready: boolean;
  readonly reports: ReadonlyArray<BuildableReport>;
  readonly settings: Readonly<Record<string, PlanSettings>>;
  readonly profiles: ReadonlyArray<ModuleProfileId>;
  readonly colorNames: Readonly<Record<number, string>>;
}

export interface IBuildableService {
  subscribe(listener: () => void): () => void;
  snapshot(): BuildableSnapshot;
  setCatalog(
    specs: ReadonlyArray<ItemSpec>,
    standards: ModuleStandards,
    crosswalk: Crosswalk,
    colorNames: Readonly<Record<number, string>>,
  ): void;
  setProfile(planId: string, profile: ModuleProfileId): void;
  setMaxReach(planId: string, maxReachMm: number): void;
}

const DEFAULT_SETTINGS: PlanSettings = {
  profile: DEFAULT_MODULE_PROFILE,
  maxReachMm: DEFAULT_MAX_REACH_MM,
};

function buildablePlacements(plan: PlanSnapshot): BuildablePlacement[] {
  return plan.placements.flatMap((p) => {
    const rot = p.rot;
    if (!isRot90(rot)) return [];
    const { box } = p;
    return [
      {
        key: p.key,
        ref: p.ref,
        label: p.label,
        box: { minX: box.minX, minZ: box.minZ, maxX: box.maxX, maxZ: box.maxZ },
        x: p.x,
        z: p.z,
        rot,
      },
    ];
  });
}

@injectable()
export class BuildableService implements IBuildableService {
  private readonly listeners = new Set<() => void>();
  private catalog: BuildableCatalog | null = null;
  private settings: Record<string, PlanSettings> = {};
  private state: BuildableSnapshot = {
    ready: false,
    reports: [],
    settings: {},
    profiles: ["free"],
    colorNames: {},
  };
  private colorNames: Readonly<Record<number, string>> = {};

  constructor(
    @inject(PLAN_SERVICE) private readonly plans: IPlanService,
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
  ) {
    plans.subscribe(() => this.recompute());
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): BuildableSnapshot {
    return this.state;
  }

  setCatalog(
    specs: ReadonlyArray<ItemSpec>,
    standards: ModuleStandards,
    crosswalk: Crosswalk,
    colorNames: Readonly<Record<number, string>>,
  ): void {
    this.catalog = {
      specs: new Map(specs.map((spec) => [spec.ref, spec])),
      standards,
      crosswalk,
    };
    this.colorNames = colorNames;
    this.recompute();
  }

  private settingsFor(planId: string): PlanSettings {
    return this.settings[planId] ?? DEFAULT_SETTINGS;
  }

  setProfile(planId: string, profile: ModuleProfileId): void {
    this.settings = { ...this.settings, [planId]: { ...this.settingsFor(planId), profile } };
    this.recompute();
  }

  setMaxReach(planId: string, maxReachMm: number): void {
    this.settings = { ...this.settings, [planId]: { ...this.settingsFor(planId), maxReachMm } };
    this.recompute();
  }

  private recompute(): void {
    const catalog = this.catalog;
    const plan = this.plans.snapshot();
    const placements = buildablePlacements(plan);
    const reports = catalog
      ? plan.plans.flatMap((region, i) => {
          const check = plan.checks[i];
          return check
            ? [checkBuildable(region, check, placements, catalog, this.settingsFor(region.id))]
            : [];
        })
      : [];
    const settings = Object.fromEntries(
      plan.plans.map((region) => [region.id, this.settingsFor(region.id)]),
    );
    this.state = {
      ready: catalog !== null,
      reports,
      settings,
      profiles: ["free", ...(catalog?.standards.profiles.map((p) => p.id) ?? [])],
      colorNames: this.colorNames,
    };
    const flagged = new Set(
      reports.flatMap((r) => r.issues.flatMap((issue) => issue.placements.map(placementId))),
    );
    this.backend.setIssueBoxes(
      plan.placements.filter((p) => flagged.has(placementId(p.key))).map((p) => p.box),
    );
    for (const listener of this.listeners) listener();
  }
}

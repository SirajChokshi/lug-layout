import { type TrainExpectation, expectationOf } from "./expectation.ts";
import type { RailHeadBands } from "./placement.ts";
import { soundness } from "./soundness.ts";
import { LINK_RECIPES } from "./train-links.ts";
import { TrainModel } from "./train-model.ts";
import type { TrainPools } from "./train-pools.ts";
import { CAR_RECIPES } from "./train-recipes.ts";
import { SeededRandom } from "../generator.ts";

export interface GeneratedTrain {
  readonly name: string;
  readonly kind: string;
  readonly text: string;
  readonly model: TrainModel;
  readonly expected: TrainExpectation;
  readonly problems: ReadonlyArray<string>;
}

export interface TrainGeneration {
  readonly trains: ReadonlyArray<GeneratedTrain>;
  readonly notBuilt: ReadonlyArray<string>;
}

const ATTEMPTS = 50;

export function generateTrains(
  pools: TrainPools,
  rails: ReadonlyArray<RailHeadBands>,
  seed: number,
  perKind: number,
): TrainGeneration {
  const random = new SeededRandom(seed);
  const seats = new Map<string, number>();
  const trains: GeneratedTrain[] = [];
  const notBuilt: string[] = [];
  for (const [kind, recipe] of [...CAR_RECIPES, ...LINK_RECIPES]) {
    for (let k = 0; k < perKind; k++) {
      let built: GeneratedTrain | null = null;
      for (let attempt = 0; attempt < ATTEMPTS && !built; attempt++) {
        const model = new TrainModel();
        const rail = rails[random.int(rails.length)];
        if (!rail) break;
        const plan = recipe({ model, pools, random, rails, rail, seats });
        if (!plan) continue;
        const expected = expectationOf(model, plan, rails);
        if (!expected) continue;
        const name = `held-out-train-${seed}-${trains.length + 1}.ldr`;
        built = {
          name,
          kind,
          text: model.ldraw(name, `Held-out generated train: ${kind} (seed ${seed})`),
          model,
          expected,
          problems: soundness(model, plan, rails),
        };
      }
      if (built) trains.push(built);
      else notBuilt.push(kind);
    }
  }
  return { trains, notBuilt };
}

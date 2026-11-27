import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBundle } from "../src/held-out/bundle.ts";
import { runTrains, trainsMarkdown } from "../src/held-out/trains/train-harness.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const cache = join(root, ".cache/held-out");
const seed = Number(process.argv[2]);
const started = performance.now();
const bundle = await openBundle(join(root, "tools/asset-pipeline/dist/bundle"));
const trains = await runTrains(
  bundle,
  root,
  cache,
  join(cache, "results", `seed-${seed}`),
  seed,
  1,
);
process.stdout.write(`${trainsMarkdown(trains, seed)}\n`);
const listed = (pick: (o: (typeof trains.outcomes)[number]) => ReadonlyArray<string>) =>
  trains.outcomes.flatMap((o) => pick(o).map((p) => `${o.train.name}: ${p}`));
process.stdout.write(
  `bundle ${bundle.version}; problems ${JSON.stringify(listed((o) => o.train.problems))}; failures ${JSON.stringify(listed((o) => o.failures))}; mismatches ${JSON.stringify(listed((o) => o.mismatches))}; ${Math.round((performance.now() - started) / 1000)} s\n`,
);

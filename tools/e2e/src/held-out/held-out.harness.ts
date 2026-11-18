import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { bundlePartGlb, openBundle, type Bundle } from "./bundle.ts";
import { checkInput, type ConnectorMemo, type InputChecks } from "./checks.ts";
import { fetchPinned, formatOf, readCorpus } from "./corpus.ts";
import {
  blockPools,
  generateBuilds,
  isPoolCandidate,
  type GeneratedKind,
  type PoolCandidate,
} from "./generator.ts";
import { overlappingPairs } from "./generated-integrity.ts";
import {
  cachingFetch,
  importThroughWorkerPath,
  type HeldOutInput,
  type ImportOutcome,
} from "./import-path.ts";
import { partExtras } from "./part-connectors.ts";
import { markdownReport, partCoverage, type CheckedInput, type InputSet } from "./report.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CORPUS = fileURLToPath(new URL("../../held-out/corpus.json", import.meta.url));
const BUNDLE_ROOT =
  process.env["HELD_OUT_BUNDLE"] ?? join(REPO_ROOT, "tools/asset-pipeline/dist/bundle");
const CACHE_ROOT = join(REPO_ROOT, ".cache/held-out");
const SEED_RANGE = 2 ** 31;
const DEFAULT_BUILDS_PER_KIND = 4;
const HARNESS_TIMEOUT_MS = 3_600_000;
const MS_PER_SECOND = 1000;
const STUD_TOP_Y = 7;

const SET_OF_KIND: Readonly<Record<GeneratedKind, InputSet>> = {
  "MILS-style module": "generated MILS-style modules",
  modular: "generated modulars",
  "small MOC": "generated small MOCs",
};

function seedFromEnvironment(): number {
  const given = process.env["HELD_OUT_SEED"];
  if (given === undefined || given === "") return randomInt(SEED_RANGE);
  const seed = Number(given);
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`HELD_OUT_SEED ${given} is not a seed`);
  return seed;
}

function revision(): string {
  const sha = process.env["GITHUB_SHA"];
  if (sha) return sha.slice(0, 12);
  return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: REPO_ROOT })
    .toString()
    .trim();
}

async function poolCandidates(bundle: Bundle): Promise<PoolCandidate[]> {
  const candidates: PoolCandidate[] = [];
  for (const part of bundle.parts.values()) {
    if (!isPoolCandidate(part.title)) continue;
    const extras = partExtras(await bundlePartGlb(bundle, part), part.id);
    candidates.push({ part, studTopsY: extras.studs.map((stud) => stud.matrix[STUD_TOP_Y] ?? 0) });
  }
  return candidates;
}

interface Detail {
  readonly input: string;
  readonly set: InputSet;
  readonly checks: InputChecks;
}

function detailJson(details: ReadonlyArray<Detail>): string {
  return JSON.stringify(
    details.map(({ input, set, checks }) => ({
      input,
      set,
      outcomes: Object.fromEntries(checks.outcomes),
      skippedAndReported: checks.skippedAndReported,
      connectorSources: Object.fromEntries(checks.connectorSources),
      drawnInstances: checks.drawnInstances,
    })),
    null,
    2,
  );
}

it(
  "runs the pinned held-out corpus and freshly generated builds through the import worker path and the editor's checks",
  async () => {
    const started = performance.now();
    const seed = seedFromEnvironment();
    process.stdout.write(`held-out generator seed ${seed} (HELD_OUT_SEED=${seed} reproduces it)\n`);
    const bundle = await openBundle(BUNDLE_ROOT);
    const fetchUrl = cachingFetch(join(CACHE_ROOT, "ldraw"));
    const memo: ConnectorMemo = new Map();
    const checked: CheckedInput[] = [];
    const details: Detail[] = [];
    const run = async (
      set: InputSet,
      label: string,
      input: HeldOutInput,
    ): Promise<ImportOutcome> => {
      const outcome = await importThroughWorkerPath(bundle, fetchUrl, input);
      const checks = await checkInput(outcome, bundle, memo);
      checked.push({ set, checks });
      details.push({ input: label, set, checks });
      process.stdout.write(`${set}: ${checked.length} inputs checked\n`);
      return outcome;
    };
    const unsound: string[] = [];
    const overlapsOf = (outcome: ImportOutcome): number =>
      outcome.kind === "imported" ? overlappingPairs(outcome.result, bundle) : -1;

    const corpus = await readCorpus(CORPUS);
    for (const file of corpus) {
      const format = formatOf(file);
      const bytes = await fetchPinned(file, join(CACHE_ROOT, "corpus"));
      const name = decodeURIComponent(basename(new URL(file.url).pathname));
      await run(format === "studio" ? "corpus, Studio" : "corpus, LDraw", file.url, {
        name,
        format,
        bytes,
      });
    }

    const perKind = Number(process.env["HELD_OUT_BUILDS_PER_KIND"] ?? DEFAULT_BUILDS_PER_KIND);
    const pools = blockPools(await poolCandidates(bundle), bundle.parts.values(), bundle.colors);
    const encoder = new TextEncoder();
    const builds = join(CACHE_ROOT, "results", `seed-${seed}`);
    await mkdir(builds, { recursive: true });
    for (const build of generateBuilds(pools, seed, perKind)) {
      await writeFile(join(builds, build.name), build.text);
      const built = await run(SET_OF_KIND[build.kind], build.name, {
        name: build.name,
        format: "ldraw",
        bytes: encoder.encode(build.text),
      });
      const doubled = await run("generated copies with a doubled part", `${build.name} doubled`, {
        name: build.name,
        format: "ldraw",
        bytes: encoder.encode(build.collidingText),
      });
      if (overlapsOf(built) !== 0) unsound.push(`${build.name}: parts overlap`);
      if (overlapsOf(doubled) < 1) unsound.push(`${build.name} doubled: no part overlaps`);
    }

    const report = markdownReport(
      {
        coverage: partCoverage(memo.values()),
        revision: revision(),
        bundleVersion: bundle.version,
        ldraw: `${bundle.source.repo}@${bundle.source.commit.slice(0, 7)}`,
        seed,
        corpusFiles: corpus.length,
        elapsedSeconds: Math.round((performance.now() - started) / MS_PER_SECOND),
      },
      checked,
    );
    const results = join(CACHE_ROOT, "results");
    await mkdir(results, { recursive: true });
    await writeFile(join(results, `seed-${seed}.md`), report);
    await writeFile(join(results, `seed-${seed}.detail.json`), detailJson(details));
    const summary = process.env["GITHUB_STEP_SUMMARY"];
    if (summary) await appendFile(summary, `${report}\n`);
    process.stdout.write(`${report}\n`);
    expect(
      details
        .filter(({ set }) => set.startsWith("generated"))
        .flatMap(({ input, checks }) =>
          checks.outcomes.get("import")?.kind === "pass" ? [] : [input],
        ),
      "generated builds use only bundle parts, so each must import cleanly",
    ).toEqual([]);
    expect(unsound, "a generated build overlaps nowhere, and its doubled copy somewhere").toEqual(
      [],
    );
  },
  HARNESS_TIMEOUT_MS,
);

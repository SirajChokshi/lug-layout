import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STUD_LDU } from "@brr/math";
import { expect, it } from "vitest";
import { acceptanceMarkdown, runAcceptance } from "./acceptance.ts";
import { collisions } from "./assembly.ts";
import { openBundle } from "./bundle.ts";
import { checkInput, type ConnectorMemo, type InputChecks } from "./checks.ts";
import { fetchPinned, formatOf, readCorpus } from "./corpus.ts";
import {
  blockPools,
  generateBuilds,
  modulePair,
  type BlockPools,
  type GeneratedKind,
} from "./generator.ts";
import { importsWithinLimit } from "./import-limit.ts";
import { cachingFetch, type HeldOutInput } from "./import-path.ts";
import { runTrains, trainsMarkdown } from "./trains/train-harness.ts";
import { poolCandidates } from "./pool-candidates.ts";
import { markdownReport, partCoverage, type CheckedInput, type InputSet } from "./report.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CORPUS = fileURLToPath(new URL("../../held-out/corpus.json", import.meta.url));
const BUNDLE_ROOT =
  process.env["HELD_OUT_BUNDLE"] ?? join(REPO_ROOT, "tools/asset-pipeline/dist/bundle");
const CACHE_ROOT = join(REPO_ROOT, ".cache/held-out");
const RECORDS_ROOT = join(REPO_ROOT, ".cache/library-bake");
const LIBRARY_CONNECTORS_ROOT = join(REPO_ROOT, "tools/asset-pipeline/dist/library-connectors");
const SEED_RANGE = 2 ** 31;
const DEFAULT_BUILDS_PER_KIND = 4;
const DEFAULT_TRAINS_PER_KIND = 1;
const DEFAULT_IMPORT_LIMIT_SECONDS = 60;
const HARNESS_TIMEOUT_MS = 3_600_000;
const MS_PER_SECOND = 1000;
const PALETTE_TEMPLATE = "docs/verified-facts/scenes/mils-plain.ldr";
const SQUARE_MODULE_LDU = 640;

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

function importLimitFromEnvironment(): number {
  const given = process.env["HELD_OUT_IMPORT_LIMIT_SECONDS"];
  if (given === undefined || given === "") return DEFAULT_IMPORT_LIMIT_SECONDS;
  const limit = Number(given);
  if (!(limit > 0)) throw new Error(`HELD_OUT_IMPORT_LIMIT_SECONDS ${given} is not a time limit`);
  return limit;
}

function revision(): string {
  const sha = process.env["GITHUB_SHA"];
  if (sha) return sha.slice(0, 12);
  return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: REPO_ROOT })
    .toString()
    .trim();
}

function bareBaseplate(pools: BlockPools): string {
  const square = pools.baseplates.find(
    (block) =>
      block.width * STUD_LDU === SQUARE_MODULE_LDU && block.depth * STUD_LDU === SQUARE_MODULE_LDU,
  );
  if (!square) throw new Error("the bundle has no square module baseplate");
  return `0 Bare baseplate\n0 Name: baseplate.ldr\n1 2 0 0 0 1 0 0 0 1 0 0 0 1 ${square.reference}\n`;
}

interface Detail {
  readonly input: string;
  readonly set: InputSet;
  readonly checks: InputChecks;
  readonly importSeconds: number;
}

function detailJson(details: ReadonlyArray<Detail>): string {
  return JSON.stringify(
    details.map(({ input, set, checks, importSeconds }) => ({
      input,
      set,
      importSeconds,
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
    const bundle = await openBundle(BUNDLE_ROOT, RECORDS_ROOT, LIBRARY_CONNECTORS_ROOT);
    const ldrawCache = join(CACHE_ROOT, "ldraw");
    const fetchUrl = cachingFetch(ldrawCache);
    const importLimitSeconds = importLimitFromEnvironment();
    const imports = importsWithinLimit(
      {
        bundle: BUNDLE_ROOT,
        ldrawCache,
        records: RECORDS_ROOT,
        libraryConnectors: LIBRARY_CONNECTORS_ROOT,
      },
      importLimitSeconds,
    );
    const memo: ConnectorMemo = new Map();
    const checked: CheckedInput[] = [];
    const details: Detail[] = [];
    const run = async (set: InputSet, label: string, input: HeldOutInput): Promise<void> => {
      const { outcome, seconds } = await imports.run(input);
      const checks = await checkInput(outcome, bundle, memo);
      checked.push({
        set,
        checks,
        importSeconds: seconds,
        importFinished: outcome.kind !== "unfinished",
        bakedFromRecords:
          outcome.kind === "imported" ? (outcome.result.report.records?.bakedFromRecords ?? 0) : 0,
        timings: outcome.kind === "imported" ? outcome.result.report.timings : null,
        compilerStartMs: outcome.kind === "imported" ? outcome.compilerStartMs : null,
      });
      details.push({ input: label, set, checks, importSeconds: seconds });
      process.stdout.write(`${set}: ${checked.length} inputs checked\n`);
    };
    const unsound: string[] = [];

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
    const pools = blockPools(
      await poolCandidates(bundle, fetchUrl),
      bundle.parts.values(),
      bundle.colors,
    );
    const encoder = new TextEncoder();
    const builds = join(CACHE_ROOT, "results", `seed-${seed}`);
    await mkdir(builds, { recursive: true });
    for (const build of generateBuilds(pools, seed, perKind)) {
      await writeFile(join(builds, build.name), build.text);
      await run(SET_OF_KIND[build.kind], build.name, {
        name: build.name,
        format: "ldraw",
        bytes: encoder.encode(build.text),
      });
      await run("generated copies with a doubled part", `${build.name} doubled`, {
        name: build.name,
        format: "ldraw",
        bytes: encoder.encode(build.collidingText),
      });
      if (collisions(build.assembly) !== 0) unsound.push(`${build.name}: parts collide`);
      if (collisions(build.collidingAssembly) < 1)
        unsound.push(`${build.name} doubled: no collision`);
    }
    await imports.close();

    const pair = modulePair(pools, seed);
    for (const model of [pair.subject, pair.renamedSubject, pair.partner]) {
      await writeFile(join(builds, model.names.file), model.text);
    }
    const acceptance = await runAcceptance({
      bundle,
      fetchUrl,
      pair,
      templateName: basename(PALETTE_TEMPLATE),
      templateText: await readFile(join(REPO_ROOT, PALETTE_TEMPLATE), "utf8"),
      bareBaseplate: bareBaseplate(pools),
      repoRoot: REPO_ROOT,
    });

    const trains = await runTrains(
      bundle,
      REPO_ROOT,
      CACHE_ROOT,
      builds,
      seed,
      Number(process.env["HELD_OUT_TRAINS_PER_KIND"] ?? DEFAULT_TRAINS_PER_KIND),
    );

    const report = markdownReport(
      {
        coverage: partCoverage(memo.values()),
        revision: revision(),
        bundleVersion: bundle.version,
        ldraw: `${bundle.source.repo}@${bundle.source.commit.slice(0, 7)}`,
        seed,
        corpusFiles: corpus.length,
        elapsedSeconds: Math.round((performance.now() - started) / MS_PER_SECOND),
        importLimitSeconds,
        recordsIndex: bundle.recordsIndex,
        threadStartsMs: imports.threadStartsMs(),
      },
      checked,
    ).concat("\n", acceptanceMarkdown(acceptance), "\n", trainsMarkdown(trains, seed));
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
    expect(unsound, "a generated build collides nowhere, and its doubled copy somewhere").toEqual(
      [],
    );
    expect(
      trains.outcomes.flatMap(({ train }) =>
        train.problems.map((problem) => `${train.name}: ${problem}`),
      ),
      "every generated train is sound: nothing overlaps, each planned wheelset meets its rail, each negative misses",
    ).toEqual([]);
    expect(
      trains.outcomes.flatMap(({ train, failures }) =>
        failures.map((failure) => `${train.name}: ${failure}`),
      ),
      "generated trains use only official library parts, so each must import cleanly",
    ).toEqual([]);
    expect(
      trains.outcomes.flatMap(({ train, mismatches }) =>
        mismatches.map((mismatch) => `${train.name}: ${mismatch}`),
      ),
      "an imported train keeps the generator's instance order, parts and positions, which its expected outcome indexes",
    ).toEqual([]);
    expect(
      acceptance.scenarioProblems,
      "the acceptance pair engages every pin in a hole with no collision only when aligned; one stud forward or back, at least one pin collides or misses a hole",
    ).toEqual([]);
    expect(
      bundle.recordsIndex !== null && checked.every((input) => input.bakedFromRecords === 0),
      "with precompiled records pinned, some input bakes its pinned parts from them",
    ).toBe(false);
  },
  HARNESS_TIMEOUT_MS,
);

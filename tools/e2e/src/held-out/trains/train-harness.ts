import { PRIMITIVE_FAMILIES } from "./part-geometry.ts";
import { PartReader } from "./part-readings.ts";
import { PinnedLibrary } from "./pinned-library.ts";
import type { RailHeadBands } from "./placement.ts";
import { trainPools } from "./train-pools.ts";
import { type GeneratedTrain, generateTrains } from "./trains.ts";
import { bundlePartId } from "@brr/import";
import {
  compareExactDecimal,
  EXACT_DECIMAL_ZERO,
  parseExactDecimal,
  exactRationalFromDecimal,
  exactRationalToFloat64,
} from "@brr/math";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bundle } from "../bundle.ts";
import { importThroughWorkerPath, type ImportOutcome } from "../import-path.ts";

const GEOMETRY_FACTS = "docs/verified-facts/geometry.json";
const MATRIX_FLOATS = 12;
const TRANSLATION = [3, 7, 11] as const;
const SAME_LDU = 1e-3;
const MS_PER_SECOND = 1000;

interface RailFacts {
  readonly rails: ReadonlyArray<{
    readonly part: string;
    readonly railHeads: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  }>;
}

export interface TrainOutcome {
  readonly train: GeneratedTrain;
  readonly imported: string;
  readonly failures: ReadonlyArray<string>;
  readonly mismatches: ReadonlyArray<string>;
}

export interface TrainRun {
  readonly outcomes: ReadonlyArray<TrainOutcome>;
  readonly notBuilt: ReadonlyArray<string>;
  readonly pools: Readonly<Record<string, number>>;
  readonly seconds: {
    readonly pools: number;
    readonly generation: number;
    readonly imports: number;
  };
}

function ldu(text: string): number {
  return exactRationalToFloat64(exactRationalFromDecimal(parseExactDecimal(text)));
}

async function railBands(repoRoot: string): Promise<ReadonlyArray<RailHeadBands>> {
  const facts = JSON.parse(await readFile(join(repoRoot, GEOMETRY_FACTS), "utf8")) as RailFacts;
  return facts.rails.map((rail) => {
    const outer = rail.railHeads.find(
      (band) => compareExactDecimal(parseExactDecimal(band.from), EXACT_DECIMAL_ZERO) > 0,
    );
    if (!outer)
      throw new Error(`${GEOMETRY_FACTS} gives ${rail.part} no rail head on the positive side`);
    return { part: rail.part, inner: ldu(outer.from), outer: ldu(outer.to) };
  });
}

function importFailures(outcome: ImportOutcome): string[] {
  if (outcome.kind !== "imported") return [describe(outcome)];
  return outcome.result.report.parts
    .filter((part) => part.kind !== "bundle" && part.kind !== "compiled")
    .map((part) => `${part.official}: ${part.kind}`);
}

function importMismatches(train: GeneratedTrain, outcome: ImportOutcome): string[] {
  if (outcome.kind !== "imported" || importFailures(outcome).length > 0) return [];
  const { result } = outcome;
  const placements = train.model.placements;
  if (result.instanceCount !== placements.length) {
    return [`imported ${result.instanceCount} instances of ${placements.length}`];
  }
  const out: string[] = [];
  placements.forEach((placement, index) => {
    const part = result.partIds[result.partIndex[index] ?? 0];
    if (part !== bundlePartId(placement.reading.reference))
      out.push(`instance ${index} is ${part}`);
    const moved = TRANSLATION.some(
      (offset, axis) =>
        Math.abs(
          (result.matrices[index * MATRIX_FLOATS + offset] ?? 0) - (placement.position[axis] ?? 0),
        ) > SAME_LDU,
    );
    if (moved) out.push(`instance ${index} moved`);
  });
  return [...new Set(out)];
}

function describe(outcome: ImportOutcome): string {
  switch (outcome.kind) {
    case "imported":
      return `${outcome.result.instanceCount} instances, ${outcome.result.report.compileRounds} compile rounds`;
    case "rejected":
      return `rejected: ${outcome.surfacedMessage}`;
    case "threw":
      return `threw: ${outcome.message}`;
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled outcome ${String(unhandled)}`);
    }
  }
}

export async function runTrains(
  bundle: Bundle,
  repoRoot: string,
  cacheRoot: string,
  resultsDirectory: string,
  seed: number,
  perKind: number,
): Promise<TrainRun> {
  const started = performance.now();
  const library = await PinnedLibrary.open(repoRoot, join(cacheRoot, "ldraw-library"));
  const families = new RegExp(
    Object.values(PRIMITIVE_FAMILIES)
      .map((pattern) => pattern.source)
      .join("|"),
    "u",
  );
  const vocabulary = [...(await library.primitiveNames(families)), ...bundle.job.studPrimitives];
  const rails = await railBands(repoRoot);
  const pools = await trainPools(
    bundle,
    library,
    new PartReader(bundle, library, vocabulary),
    rails,
  );
  const pooled = performance.now();
  const generation = generateTrains(pools, rails, seed, perKind);
  const generated = performance.now();
  const directory = join(resultsDirectory, "trains");
  await mkdir(directory, { recursive: true });
  const encoder = new TextEncoder();
  const outcomes: TrainOutcome[] = [];
  for (const train of generation.trains) {
    await writeFile(join(directory, train.name), train.text);
    await writeFile(
      join(directory, train.name.replace(/\.ldr$/u, ".expected.json")),
      `${JSON.stringify({ kind: train.kind, seed, ...train.expected }, null, 1)}\n`,
    );
    const outcome = await importThroughWorkerPath(bundle, library.fetch, {
      name: train.name,
      format: "ldraw",
      bytes: encoder.encode(train.text),
    });
    outcomes.push({
      train,
      imported: describe(outcome),
      failures: importFailures(outcome),
      mismatches: importMismatches(train, outcome),
    });
  }
  return {
    outcomes,
    notBuilt: generation.notBuilt,
    pools: {
      plates: pools.plates.length,
      spacers: pools.spacers.length,
      bearings: pools.bearings.length,
      "pivot plates": pools.pivotPlates.length,
      axles: pools.axles.length,
      pins: pools.pins.length,
      wheels: pools.wheels.length,
      "running-gear parts": pools.running.length,
    },
    seconds: {
      pools: Math.round((pooled - started) / MS_PER_SECOND),
      generation: Math.round((generated - pooled) / MS_PER_SECOND),
      imports: Math.round((performance.now() - generated) / MS_PER_SECOND),
    },
  };
}

function cell(value: string | number): string {
  return String(value).replaceAll("|", "\\|");
}

export function trainsMarkdown(run: TrainRun, seed: number): string {
  const rows = run.outcomes.map(({ train, imported, failures, mismatches }) => {
    const importCell = [...failures, ...mismatches].join("; ") || imported;
    const { expected } = train;
    return `| ${cell(train.kind)} | ${cell(train.name)} | ${train.model.placements.length} | ${expected.wheelsets.length} | ${expected.notWheelsets.map((line) => line.reason).join(", ") || "none"} | ${expected.vehicles.length} | ${expected.couplingsInModel.length} | ${expected.unresolvedRunningGear.length} | ${cell(train.problems.length === 0 ? "sound" : train.problems.join("; "))} | ${cell(importCell)} |`;
  });
  return [
    `#### Generated trains, custom-train mode (seed ${seed})`,
    "",
    `Pools from the pinned library, by geometry and primitive references only: ${Object.entries(
      run.pools,
    )
      .map(([name, count]) => `${count} ${name}`)
      .join(
        ", ",
      )}. Pools took ${run.seconds.pools} s, generation ${run.seconds.generation} s, imports ${run.seconds.imports} s.${run.notBuilt.length > 0 ? ` Not built this run: ${run.notBuilt.join(", ")}.` : ""}`,
    "",
    "| Kind | File | Parts | Wheelsets | Not wheelsets | Vehicles | Couplings in model | Unresolved | Generator check | Import |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

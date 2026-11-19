import type { BakePhases, ImportTimings } from "@brr/import";
import { CHECKS, type CheckId, type Finding, type InputChecks } from "./checks.ts";
import type { ConnectorFamily, PartConnectors } from "./part-connectors.ts";

export const INPUT_SETS = [
  "corpus, LDraw",
  "corpus, Studio",
  "generated MILS-style modules",
  "generated modulars",
  "generated small MOCs",
  "generated copies with a doubled part",
] as const;
export type InputSet = (typeof INPUT_SETS)[number];

export interface CheckedInput {
  readonly set: InputSet;
  readonly checks: InputChecks;
  readonly importSeconds: number;
  readonly importFinished: boolean;
  readonly bakedFromRecords: number;
  readonly timings: ImportTimings | null;
  readonly compilerStartMs: number | null;
}

export interface PartCoverage {
  readonly distinct: number;
  readonly withConnectors: number;
  readonly bySource: ReadonlyMap<PartConnectors["source"], number>;
  readonly byFamily: ReadonlyMap<ConnectorFamily, number>;
  readonly byTier: ReadonlyMap<string, number>;
}

export function partCoverage(parts: Iterable<PartConnectors>): PartCoverage {
  let distinct = 0;
  let withConnectors = 0;
  const bySource = new Map<PartConnectors["source"], number>();
  const byFamily = new Map<ConnectorFamily, number>();
  const byTier = new Map<string, number>();
  for (const part of parts) {
    for (const tier of part.tiers.keys()) byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
    distinct++;
    if (part.total > 0) withConnectors++;
    bySource.set(part.source, (bySource.get(part.source) ?? 0) + 1);
    for (const family of part.counts.keys()) byFamily.set(family, (byFamily.get(family) ?? 0) + 1);
  }
  return { distinct, withConnectors, bySource, byFamily, byTier };
}

export interface RunContext {
  readonly coverage: PartCoverage;
  readonly revision: string;
  readonly bundleVersion: string;
  readonly ldraw: string;
  readonly seed: number;
  readonly corpusFiles: number;
  readonly elapsedSeconds: number;
  readonly importLimitSeconds: number;
  readonly recordsIndex: string | null;
  readonly threadStartsMs: ReadonlyArray<number>;
}

const EXAMPLE_PARTS = 8;
const BUDGET_INSTANCES = 10_000;
const RECORD_INDEX_DIGITS = 16;
const MAX_CLASS_ROWS = 25;

interface Tally {
  pass: number;
  fail: number;
  blocked: number;
  policy: number;
}

function tallyOf(inputs: ReadonlyArray<CheckedInput>, check: CheckId): Tally {
  const tally: Tally = { pass: 0, fail: 0, blocked: 0, policy: 0 };
  for (const input of inputs) {
    const outcome = input.checks.outcomes.get(check);
    if (!outcome || outcome.kind === "skipped") continue;
    tally[outcome.kind]++;
  }
  return tally;
}

function cell(tally: Tally): string {
  const judged = tally.pass + tally.fail;
  const parts: string[] = [];
  if (judged > 0) parts.push(`${tally.pass}/${judged} pass`);
  if (tally.blocked > 0)
    parts.push(judged > 0 ? `${tally.blocked} blocked` : `blocked (${tally.blocked})`);
  if (tally.policy > 0) parts.push(`${tally.policy} refused by policy`);
  return parts.length === 0 ? "n/a" : parts.join(", ");
}

interface ClassRow {
  readonly check: CheckId;
  readonly bugClass: string;
  inputs: number;
  readonly parts: Set<string>;
}

function classRows(
  inputs: ReadonlyArray<CheckedInput>,
  findingsOf: (input: CheckedInput) => ReadonlyArray<readonly [CheckId, Finding]>,
): ReadonlyArray<ClassRow> {
  const rows = new Map<string, ClassRow>();
  for (const input of inputs) {
    for (const [check, finding] of findingsOf(input)) {
      const key = `${check}\u0000${finding.bugClass}`;
      const row = rows.get(key) ?? {
        check,
        bugClass: finding.bugClass,
        inputs: 0,
        parts: new Set(),
      };
      row.inputs++;
      for (const part of finding.parts) if (part !== "") row.parts.add(part);
      rows.set(key, row);
    }
  }
  return [...rows.values()].toSorted(
    (a, b) => CHECKS.indexOf(a.check) - CHECKS.indexOf(b.check) || b.inputs - a.inputs,
  );
}

function failures(input: CheckedInput): Array<readonly [CheckId, Finding]> {
  const out: Array<readonly [CheckId, Finding]> = [];
  for (const [check, outcome] of input.checks.outcomes) {
    if (outcome.kind === "fail") for (const finding of outcome.findings) out.push([check, finding]);
    if (outcome.kind === "blocked") out.push([check, { bugClass: outcome.bugClass, parts: [] }]);
  }
  return out;
}

function policies(input: CheckedInput): Array<readonly [CheckId, Finding]> {
  const out: Array<readonly [CheckId, Finding]> = [];
  for (const [check, outcome] of input.checks.outcomes) {
    if (outcome.kind === "policy") out.push([check, { bugClass: outcome.bugClass, parts: [] }]);
  }
  return out;
}

function examples(parts: ReadonlySet<string>): string {
  if (parts.size === 0) return "";
  const shown = [...parts]
    .toSorted()
    .slice(0, EXAMPLE_PARTS)
    .map((part) => `\`${part}\``);
  return parts.size > EXAMPLE_PARTS ? `${shown.join(", ")}, …` : shown.join(", ");
}

function escaped(text: string): string {
  return text.replaceAll("|", "\\|");
}

function classTable(title: string, rows: ReadonlyArray<ClassRow>): string[] {
  if (rows.length === 0) return [];
  const shown = rows.slice(0, MAX_CLASS_ROWS);
  const rest = rows.slice(MAX_CLASS_ROWS);
  const restParts = new Set(rest.flatMap((row) => [...row.parts]));
  return [
    `#### ${title}`,
    "",
    "| Check | Bug class | Inputs | Parts | Example parts |",
    "|---|---|---|---|---|",
    ...shown.map(
      (row) =>
        `| ${row.check} | ${escaped(row.bugClass)} | ${row.inputs} | ${row.parts.size || ""} | ${examples(row.parts)} |`,
    ),
    ...(rest.length > 0
      ? [`| | ${rest.length} smaller classes | | ${restParts.size || ""} | |`]
      : []),
    "",
  ];
}

function listed(counts: ReadonlyMap<string, number>): string {
  return [...counts].map(([name, count]) => `${count} with ${name}`).join(", ") || "none";
}

function coverageLine({
  distinct,
  withConnectors,
  bySource,
  byFamily,
  byTier,
}: PartCoverage): string {
  const sources = [...bySource].map(([source, count]) => `${count} from ${source}`).join(", ");
  const tiers =
    byTier.size > 0 ? ` Parts with connectors from each source tier: ${listed(byTier)}.` : "";
  return `Distinct drawn parts: ${distinct}, of which ${withConnectors} yield at least one connector. Connector data: ${sources || "none"}. Parts carrying each connector kind: ${listed(byFamily)}.${tiers}`;
}

function seconds(value: number): string {
  return `${value.toFixed(1)} s`;
}

function timingRow(label: string, members: ReadonlyArray<CheckedInput>): string {
  const total = members.reduce((sum, input) => sum + input.importSeconds, 0);
  const drawing = members.filter((input) => input.checks.drawnInstances > 0);
  const drawn = drawing.reduce((sum, input) => sum + input.checks.drawnInstances, 0);
  const drawingSeconds = drawing.reduce((sum, input) => sum + input.importSeconds, 0);
  const perBudget = drawn > 0 ? seconds((drawingSeconds * BUDGET_INSTANCES) / drawn) : "n/a";
  const slowest = Math.max(...members.map((input) => input.importSeconds));
  const unfinished = members.filter((input) => !input.importFinished).length;
  return `| ${label} | ${members.length} | ${seconds(total)} | ${perBudget} | ${seconds(slowest)} | ${unfinished} |`;
}

function recordsLine(recordsIndex: string | null, inputs: ReadonlyArray<CheckedInput>): string {
  if (recordsIndex === null) {
    return "No precompiled bake records were available: every part compiled from LDraw at import.";
  }
  const using = inputs.filter((input) => input.bakedFromRecords > 0);
  const parts = using.reduce((sum, input) => sum + input.bakedFromRecords, 0);
  return `Precompiled bake records (index \`${recordsIndex.slice(0, RECORD_INDEX_DIGITS)}\`): ${using.length} of ${inputs.length} inputs baked ${parts} pinned parts from records instead of compiling them; the rest compiled from LDraw.`;
}

function importTimeTable(
  limitSeconds: number,
  recordsIndex: string | null,
  inputs: ReadonlyArray<CheckedInput>,
): string[] {
  const rows = INPUT_SETS.flatMap((set) => {
    const members = inputs.filter((input) => input.set === set);
    return members.length === 0 ? [] : [timingRow(set, members)];
  });
  return [
    "#### Import time",
    "",
    `Each input imports on its own thread. One that hasn't finished after ${limitSeconds} s is stopped and fails the import check. E0b's budget is ≤ 1 s per ${BUDGET_INSTANCES.toLocaleString("en-US")} instances.`,
    "",
    `| Inputs | Files | Import time | Per ${BUDGET_INSTANCES.toLocaleString("en-US")} drawn instances | Slowest input | Unfinished after ${limitSeconds} s |`,
    "|---|---|---|---|---|---|",
    ...rows,
    timingRow("**all**", inputs),
    "",
    recordsLine(recordsIndex, inputs),
    "",
  ];
}

const MS_PER_SECOND = 1000;

interface TimedInput {
  readonly set: InputSet;
  readonly drawn: number;
  readonly timings: ImportTimings;
  readonly compilerStartMs: number;
}

function timedInputs(inputs: ReadonlyArray<CheckedInput>): TimedInput[] {
  return inputs.flatMap((input) =>
    input.timings === null || input.compilerStartMs === null
      ? []
      : [
          {
            set: input.set,
            drawn: input.checks.drawnInstances,
            timings: input.timings,
            compilerStartMs: input.compilerStartMs,
          },
        ],
  );
}

function median(values: ReadonlyArray<number>): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function milliseconds(value: number): string {
  return value >= MS_PER_SECOND ? seconds(value / MS_PER_SECOND) : `${Math.round(value)} ms`;
}

function perBudgetOf(
  members: ReadonlyArray<TimedInput>,
  ms: (input: TimedInput) => number,
): string {
  const drawing = members.filter((input) => input.drawn > 0);
  const drawn = drawing.reduce((sum, input) => sum + input.drawn, 0);
  if (drawn === 0) return "n/a";
  const spent = drawing.reduce((sum, input) => sum + ms(input), 0);
  return seconds((spent * BUDGET_INSTANCES) / drawn / MS_PER_SECOND);
}

function readinessRow(label: string, members: ReadonlyArray<TimedInput>): string {
  const placement = (input: TimedInput): number => input.timings.placementMs;
  const full = (input: TimedInput): number => input.timings.totalMs;
  return `| ${label} | ${members.length} | ${perBudgetOf(members, placement)} | ${perBudgetOf(members, full)} | ${milliseconds(median(members.map(placement)))} | ${milliseconds(median(members.map(full)))} | ${milliseconds(Math.max(...members.map(placement)))} | ${milliseconds(Math.max(...members.map(full)))} |`;
}

function readinessTable(timed: ReadonlyArray<TimedInput>): string[] {
  if (timed.length === 0) return [];
  const rows = INPUT_SETS.flatMap((set) => {
    const members = timed.filter((input) => input.set === set);
    return members.length === 0 ? [] : [readinessRow(set, members)];
  });
  const budget = BUDGET_INSTANCES.toLocaleString("en-US");
  return [
    "#### Placement open and full ready",
    "",
    "On the import engine's own clock, from reading the file until the result is ready, without the thread hand-off. Placement open is when everything a placement reads is ready: the lattice, cells, vehicles and connectors. Full ready is when the stud cover is too.",
    "",
    `| Inputs | Files | Placement open per ${budget} drawn | Full ready per ${budget} drawn | Median placement open | Median full ready | Slowest placement open | Slowest full ready |`,
    "|---|---|---|---|---|---|---|---|",
    ...rows,
    readinessRow("**all**", timed),
    "",
  ];
}

type PhaseName = keyof BakePhases;

function bakeMs(input: TimedInput, phase: PhaseName): number {
  const { bakePhases, coverPhases } = input.timings;
  return (bakePhases?.[phase] ?? 0) + (coverPhases?.[phase] ?? 0);
}

const PHASES: ReadonlyArray<readonly [string, (input: TimedInput) => number]> = [
  ["Compiler start, per import", (input) => input.compilerStartMs],
  ["Read the file", (input) => input.timings.readMs],
  ["Record fetch", (input) => input.timings.recordFetchMs],
  ["Record decode", (input) => bakeMs(input, "decodeMs")],
  ["Compile", (input) => input.timings.compileMs + bakeMs(input, "compileMs")],
  ["LDraw fetch", (input) => input.timings.ldrawFetchMs],
  ["Lattice", (input) => bakeMs(input, "latticeMs")],
  ["Cells and cover", (input) => bakeMs(input, "coverMs")],
  ["Vehicles", (input) => bakeMs(input, "vehiclesMs")],
];

function otherMs(input: TimedInput): number {
  const named = PHASES.slice(1).reduce((sum, [, ms]) => sum + ms(input), 0);
  return Math.max(0, input.timings.totalMs - named);
}

function phaseRow(
  label: string,
  timed: ReadonlyArray<TimedInput>,
  ms: (input: TimedInput) => number,
  importMs: number,
): string {
  const values = timed.map(ms);
  const total = values.reduce((sum, value) => sum + value, 0);
  const share = importMs > 0 ? `${((total * 100) / importMs).toFixed(1)}%` : "n/a";
  return `| ${label} | ${milliseconds(total)} | ${share} | ${milliseconds(median(values))} | ${milliseconds(Math.max(...values))} |`;
}

function phaseTable(
  timed: ReadonlyArray<TimedInput>,
  threadStartsMs: ReadonlyArray<number>,
): string[] {
  if (timed.length === 0) return [];
  const importMs = timed.reduce((sum, input) => sum + input.timings.totalMs, 0);
  const threads = threadStartsMs.reduce((sum, ms) => sum + ms, 0);
  return [
    "#### Where the import time goes",
    "",
    `Summed over the ${timed.length} inputs that imported, ${milliseconds(importMs)} on the engine's clock; the compiler start is outside that clock. The bake phases are the primary's own clock inside the compiler: its placement call and its own slice of the stud cover. Bake helpers, when there are any, work in parallel and aren't counted. ${threadStartsMs.length} import ${threadStartsMs.length === 1 ? "thread" : "threads"} started in ${milliseconds(threads)} in all, opening the bundle once each.`,
    "",
    "| Phase | Total | Share of import time | Median per input | Slowest input |",
    "|---|---|---|---|---|",
    ...PHASES.map(([label, ms]) => phaseRow(label, timed, ms, importMs)),
    phaseRow("Everything else", timed, otherMs, importMs),
    "",
  ];
}

export function markdownReport(context: RunContext, inputs: ReadonlyArray<CheckedInput>): string {
  const header = `| Inputs | Files | ${CHECKS.map((check) => check[0]?.toUpperCase() + check.slice(1)).join(" | ")} |`;
  const rule = `|---|---|${CHECKS.map(() => "---").join("|")}|`;
  const rows = INPUT_SETS.flatMap((set) => {
    const members = inputs.filter((input) => input.set === set);
    if (members.length === 0) return [];
    return [
      `| ${set} | ${members.length} | ${CHECKS.map((check) => cell(tallyOf(members, check))).join(" | ")} |`,
    ];
  });
  const total = `| **all** | ${inputs.length} | ${CHECKS.map((check) => cell(tallyOf(inputs, check))).join(" | ")} |`;
  const drawn = inputs.reduce((sum, input) => sum + input.checks.drawnInstances, 0);
  const reported = classRows(inputs, (input) =>
    input.checks.skippedAndReported.map((finding) => ["import", finding] as const),
  );
  return [
    `### Held-out run, seed ${context.seed}`,
    "",
    `Revision \`${context.revision}\`, bundle \`${context.bundleVersion}\`, LDraw \`${context.ldraw}\`. ${context.corpusFiles} pinned corpus files plus freshly generated builds and trains; \`HELD_OUT_SEED=${context.seed}\` regenerates the same builds and trains. ${drawn} instances drawn in ${context.elapsedSeconds} s.`,
    "",
    header,
    rule,
    ...rows,
    total,
    "",
    coverageLine(context.coverage),
    "",
    ...importTimeTable(context.importLimitSeconds, context.recordsIndex, inputs),
    ...readinessTable(timedInputs(inputs)),
    ...phaseTable(timedInputs(inputs), context.threadStartsMs),
    ...classTable("Failures and blocks by bug class", classRows(inputs, failures)),
    ...classTable("Refused by policy (expected)", classRows(inputs, policies)),
    ...classTable("Skipped and reported by the importer (never drawn, by design)", reported),
  ].join("\n");
}

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
}

const EXAMPLE_PARTS = 8;
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
    ...classTable("Failures and blocks by bug class", classRows(inputs, failures)),
    ...classTable("Refused by policy (expected)", classRows(inputs, policies)),
    ...classTable("Skipped and reported by the importer (never drawn, by design)", reported),
  ].join("\n");
}

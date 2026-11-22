import type { FetchFunction, ImportResult } from "@brr/import";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Bundle } from "./bundle.ts";
import type { ModulePair } from "./generator.ts";
import { importThroughWorkerPath, type ImportOutcome } from "./import-path.ts";
import { scenarioProblems } from "./pair-scenario.ts";

export interface Criterion {
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface AcceptanceResult {
  readonly seed: number;
  readonly pins: number;
  readonly subjectSubmodels: number;
  readonly neighboursImported: string;
  readonly criteria: ReadonlyArray<Criterion>;
  readonly scenarioProblems: ReadonlyArray<string>;
}

export interface AcceptanceInputs {
  readonly bundle: Bundle;
  readonly fetchUrl: FetchFunction;
  readonly pair: ModulePair;
  readonly templateName: string;
  readonly templateText: string;
  readonly bareBaseplate: string;
  readonly repoRoot: string;
}

const CODE_ROOTS = ["packages", "apps"] as const;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", ".turbo", "coverage"]);
const LINTED_SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
const MILS_PATTERN = /mils/iu;
const NO_MILS_RULE = /"brr\/no-mils"\s*:\s*(?!"off")/u;
const OXLINT_CONFIG = ".oxlintrc.json";
const FILE_HEADER = /^0 FILE /gmu;
const PLACED_CRITERIA_NOTE =
  "The placed criteria (joins its neighbours only through stud/anti-stud and Technic pin/hole mates, refused one stud off, identical under a rename once placed) are checked through `IEditor` in the editor-path report in this workflow summary.";

function sameNumbers(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return sameNumbers(a, b);
}

function importDifferences(a: ImportResult, b: ImportResult): string[] {
  const differences: string[] = [];
  if (a.instanceCount !== b.instanceCount) differences.push("instance count");
  if (!sameJson(a.partIds, b.partIds)) differences.push("part ids");
  if (!sameNumbers(a.partIndex, b.partIndex)) differences.push("part order");
  if (!sameNumbers(a.ldrawColor, b.ldrawColor)) differences.push("colours");
  if (!sameNumbers(a.matrices, b.matrices)) differences.push("matrices");
  if (
    a.compiled.length !== b.compiled.length ||
    a.compiled.some((part, i) => {
      const other = b.compiled[i];
      return !other || other.partId !== part.partId || !sameBytes(other.glb, part.glb);
    })
  ) {
    differences.push("compiled parts");
  }
  if (!sameJson(a.report.parts, b.report.parts)) differences.push("part resolutions");
  if (!sameJson(a.report.unknownColors, b.report.unknownColors))
    differences.push("unknown colours");
  if (a.report.looseGeometry.length !== b.report.looseGeometry.length) {
    differences.push("loose geometry");
  }
  if (a.report.inlineParts.length !== b.report.inlineParts.length) differences.push("inline parts");
  if (a.report.sections.length !== b.report.sections.length) differences.push("section count");
  return differences;
}

function importedCleanly(outcome: ImportOutcome): ImportResult | null {
  if (outcome.kind !== "imported") return null;
  const failed = outcome.result.report.parts.some((part) => part.kind === "failed");
  return failed || outcome.result.instanceCount === 0 ? null : outcome.result;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...(await sourceFiles(path)));
    } else if (LINTED_SOURCE.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

async function noMilsCriterion(repoRoot: string): Promise<Criterion> {
  const config = await readFile(join(repoRoot, OXLINT_CONFIG), "utf8");
  const enabled = NO_MILS_RULE.test(config);
  let files = 0;
  let lines = 0;
  for (const root of CODE_ROOTS) {
    for (const path of await sourceFiles(join(repoRoot, root))) {
      const text = await readFile(path, "utf8");
      const matching = text.split("\n").filter((line) => MILS_PATTERN.test(line)).length;
      if (matching > 0 || MILS_PATTERN.test(relative(repoRoot, path))) {
        files++;
        lines += matching;
      }
    }
  }
  return {
    label: "`brr/no-mils` passes on the same commit",
    passed: enabled && files === 0,
    detail: `${enabled ? "the rule is enabled" : "the rule isn't enabled in `.oxlintrc.json`"}; ${files} JS/TS files under \`packages/\` and \`apps/\` still match \`/mils/i\` (${lines} lines)`,
  };
}

export async function runAcceptance(inputs: AcceptanceInputs): Promise<AcceptanceResult> {
  const { bundle, fetchUrl, pair } = inputs;
  const encoder = new TextEncoder();
  const importLdraw = (name: string, text: string): Promise<ImportOutcome> =>
    importThroughWorkerPath(bundle, fetchUrl, {
      name,
      format: "ldraw",
      bytes: encoder.encode(text),
    });
  const subject = importedCleanly(await importLdraw(pair.subject.names.file, pair.subject.text));
  const renamed = importedCleanly(
    await importLdraw(pair.renamedSubject.names.file, pair.renamedSubject.text),
  );
  const neighbours = [
    ["generated partner", await importLdraw(pair.partner.names.file, pair.partner.text)],
    ["palette template content", await importLdraw(inputs.templateName, inputs.templateText)],
    ["bare baseplate", await importLdraw("baseplate.ldr", inputs.bareBaseplate)],
  ] as const;
  const neighboursImported = neighbours
    .map(
      ([label, outcome]) => `${label} ${importedCleanly(outcome) ? "imports" : "fails to import"}`,
    )
    .join(", ");
  const problems = scenarioProblems(pair);
  if (!subject) problems.push("the subject fails to import");
  if (!renamed) problems.push("the renamed subject fails to import");
  if (!importedCleanly(neighbours[0][1])) problems.push("the partner fails to import");

  const differences = subject && renamed ? importDifferences(subject, renamed) : ["import failed"];
  const importStage =
    differences.length === 0
      ? `import stage identical: ${subject?.instanceCount ?? 0} instances, ${subject?.partIds.length ?? 0} part ids in the same order, matrices, colours and compiled parts`
      : `import stage differs in ${differences.join(", ")}`;
  return {
    seed: pair.seed,
    pins: pair.pins,
    subjectSubmodels: (pair.subject.text.match(FILE_HEADER)?.length ?? 1) - 1,
    neighboursImported,
    scenarioProblems: problems,
    criteria: [
      {
        label:
          "Identical at the import stage under a random rename of the file, model name and submodel names",
        passed: differences.length === 0,
        detail: importStage,
      },
      await noMilsCriterion(inputs.repoRoot),
    ],
  };
}

export function acceptanceMarkdown(result: AcceptanceResult): string {
  const rows = result.criteria.map(
    (criterion) =>
      `| ${criterion.label} | ${criterion.passed ? "pass" : "**fail**"} | ${criterion.detail.replaceAll("|", "\\|")} |`,
  );
  const passing = result.criteria.filter((criterion) => criterion.passed).length;
  return [
    `#### §4.1 acceptance: the engine doesn't know MILS exists (seed ${result.seed})`,
    "",
    `Subject: a freshly generated module with ${result.pins} Technic pins on one edge, in an MPD whose file, model and ${result.subjectSubmodels} submodel names all say "mils"; its rename uses random names. Neighbours: ${result.neighboursImported}. ${passing} of ${result.criteria.length} criteria pass.`,
    "",
    PLACED_CRITERIA_NOTE,
    "",
    "| Criterion | Result | Detail |",
    "|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

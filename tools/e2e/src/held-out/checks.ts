import type { ImportResult, PartResolution } from "@brr/import";
import { bundlePartGlb, type Bundle } from "./bundle.ts";
import type { LimitedOutcome } from "./import-limit.ts";
import { partConnectors, type PartConnectors } from "./part-connectors.ts";

export const CHECKS = [
  "import",
  "connectors",
  "seats on baseplate",
  "mates beside a module",
  "collision refused",
] as const;
export type CheckId = (typeof CHECKS)[number];

export interface Finding {
  readonly bugClass: string;
  readonly parts: ReadonlyArray<string>;
}

export type CheckOutcome =
  | { readonly kind: "pass" }
  | { readonly kind: "fail"; readonly findings: ReadonlyArray<Finding> }
  | { readonly kind: "blocked"; readonly bugClass: string }
  | { readonly kind: "policy"; readonly bugClass: string }
  | { readonly kind: "skipped" };

export interface InputChecks {
  readonly outcomes: ReadonlyMap<CheckId, CheckOutcome>;
  readonly skippedAndReported: ReadonlyArray<Finding>;
  readonly connectorSources: ReadonlyMap<PartConnectors["source"], number>;
  readonly drawnInstances: number;
}

const PLACEMENT_CHECKS = [
  "seats on baseplate",
  "mates beside a module",
  "collision refused",
] as const;

export const NO_IMPORTED_PLACEMENT =
  "the editor can't place an imported model: its catalog takes only baked bundle models, and the import worker returns no stud lattice or cells for `modelPlaceable`";

const NUMBERS = /\d+(\.\d+)?/gu;
const QUOTED = /"[^"]*"|'[^']*'|`[^`]*`/gu;
const TITLE_WORDS = /\s+/u;
const TITLE_MARKERS = /^[~_=|]+/u;
const MOVED_ALIAS = /^~Moved to /u;
const TWO_WORD_FAMILY = "Technic";
const MAX_CLASS_TEXT = 160;

function normalized(message: string): string {
  return message.replace(QUOTED, "…").replace(NUMBERS, "N").slice(0, MAX_CLASS_TEXT);
}

function partFamily(title: string): string {
  if (MOVED_ALIAS.test(title)) return "~Moved alias";
  const words = title.replace(TITLE_MARKERS, "").trim().split(TITLE_WORDS);
  const first = words[0] ?? "untitled";
  return first === TWO_WORD_FAMILY && words[1] ? `${first} ${words[1]}` : first;
}

function grouped(entries: ReadonlyArray<readonly [string, string]>): Finding[] {
  const byClass = new Map<string, Set<string>>();
  for (const [bugClass, part] of entries) {
    byClass.set(bugClass, (byClass.get(bugClass) ?? new Set()).add(part));
  }
  return [...byClass].map(([bugClass, parts]) => ({ bugClass, parts: [...parts].toSorted() }));
}

function importOutcome(outcome: LimitedOutcome): CheckOutcome {
  switch (outcome.kind) {
    case "unfinished":
      return {
        kind: "fail",
        findings: [
          {
            bugClass: `import does not finish within the harness's ${outcome.limitSeconds} s per-input limit`,
            parts: [],
          },
        ],
      };
    case "threw":
      return {
        kind: "fail",
        findings: [{ bugClass: `import throws: ${normalized(outcome.message)}`, parts: [] }],
      };
    case "rejected":
      if (
        outcome.rejection.kind === "encrypted" &&
        outcome.surfacedMessage === outcome.rejection.message
      ) {
        return {
          kind: "policy",
          bugClass: "legacy encrypted Studio file, rejected with the re-save message",
        };
      }
      return {
        kind: "fail",
        findings: [
          {
            bugClass: `Studio file rejected as ${outcome.rejection.kind}${outcome.surfacedMessage === outcome.rejection.message ? "" : " without its own message"}`,
            parts: [],
          },
        ],
      };
    case "imported": {
      const failed = outcome.result.report.parts.flatMap((part): Array<readonly [string, string]> =>
        part.kind === "failed"
          ? [[`part fails to compile: ${normalized(part.message)}`, part.official]]
          : [],
      );
      if (outcome.result.instanceCount === 0) {
        failed.push(["nothing drawn", ""]);
      }
      return failed.length === 0 ? { kind: "pass" } : { kind: "fail", findings: grouped(failed) };
    }
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled import outcome ${String(unhandled)}`);
    }
  }
}

function reportedReason(part: PartResolution): string | null {
  switch (part.kind) {
    case "bundle":
    case "compiled":
    case "custom":
    case "failed":
      return null;
    case "customRefused":
      return `custom part refused by the ${part.gate} gate (not drawn)`;
    case "notInLibrary":
      return part.definedInline
        ? "custom part defined inline in the file (not drawn)"
        : "part not in the pinned official LDraw library (not drawn)";
    case "missingSubfile":
      return "official part whose sub-file is missing from the pinned library (not drawn)";
    case "rejected":
      return `part refused by the ${part.gate} gate (not drawn)`;
    case "inlineDiffers":
      return "inline copy of an official part that differs from it (not drawn)";
    case "malformed":
      return "part with malformed geometry, refused before meshing (not drawn)";
    case "tooLarge":
      return part.cause === "memoryUnavailable"
        ? "part whose stud cover needs more memory than this machine could reserve (not drawn; depends on the machine)"
        : "part whose stud cover needs more memory than the 32-bit WASM compiler can address (not drawn)";
    default: {
      const unhandled: never = part;
      throw new Error(`unhandled part resolution ${String(unhandled)}`);
    }
  }
}

function skippedAndReported(result: ImportResult): Finding[] {
  const entries = result.report.parts.flatMap((part): Array<readonly [string, string]> => {
    const reason = reportedReason(part);
    return reason === null ? [] : [[reason, ""]];
  });
  for (const color of result.report.unknownColors) {
    entries.push(["colour not in LDConfig (instances not drawn)", `colour ${color.code}`]);
  }
  if (result.report.looseGeometry.length > 0) {
    entries.push(["loose geometry outside any part (not drawn)", ""]);
  }
  return grouped(entries);
}

export type ConnectorMemo = Map<string, PartConnectors>;

async function connectorsOf(
  bundle: Bundle,
  memo: ConnectorMemo,
  partId: string,
  compiled: ReadonlyMap<string, Uint8Array>,
): Promise<PartConnectors> {
  const known = memo.get(partId);
  if (known) return known;
  const manifestPart = bundle.parts.get(partId);
  const glb = manifestPart ? await bundlePartGlb(bundle, manifestPart) : compiled.get(partId);
  if (!glb) throw new Error(`${partId} is drawn but neither bundled nor compiled`);
  const connectors = partConnectors(glb, partId);
  memo.set(partId, connectors);
  return connectors;
}

async function connectorOutcome(
  result: ImportResult,
  bundle: Bundle,
  memo: ConnectorMemo,
  sources: Map<PartConnectors["source"], number>,
): Promise<CheckOutcome> {
  const compiled = new Map(result.compiled.map((part) => [part.partId, part.glb]));
  const missing: Array<readonly [string, string]> = [];
  for (const partId of result.partIds) {
    const connectors = await connectorsOf(bundle, memo, partId, compiled);
    sources.set(connectors.source, (sources.get(connectors.source) ?? 0) + 1);
    if (connectors.problem !== null) {
      missing.push([`connector table unreadable: ${normalized(connectors.problem)}`, partId]);
    } else if (connectors.total === 0) {
      missing.push([
        `no connectors (${connectors.source}): ${partFamily(connectors.title)}`,
        partId,
      ]);
    }
  }
  return missing.length === 0 ? { kind: "pass" } : { kind: "fail", findings: grouped(missing) };
}

export async function checkInput(
  outcome: LimitedOutcome,
  bundle: Bundle,
  memo: ConnectorMemo,
): Promise<InputChecks> {
  const outcomes = new Map<CheckId, CheckOutcome>([["import", importOutcome(outcome)]]);
  const sources = new Map<PartConnectors["source"], number>();
  if (outcome.kind !== "imported") {
    for (const check of CHECKS) if (check !== "import") outcomes.set(check, { kind: "skipped" });
    return { outcomes, skippedAndReported: [], connectorSources: sources, drawnInstances: 0 };
  }
  outcomes.set("connectors", await connectorOutcome(outcome.result, bundle, memo, sources));
  for (const check of PLACEMENT_CHECKS) {
    outcomes.set(check, { kind: "blocked", bugClass: NO_IMPORTED_PLACEMENT });
  }
  return {
    outcomes,
    skippedAndReported: skippedAndReported(outcome.result),
    connectorSources: sources,
    drawnInstances: outcome.result.instanceCount,
  };
}

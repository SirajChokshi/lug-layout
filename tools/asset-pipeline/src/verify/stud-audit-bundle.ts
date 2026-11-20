import { parseGlb } from "@brr/catalog/glb";
import { BundleIndex, PartTableFile } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type * as v from "valibot";
import type { LdrawLibrary } from "../ldraw/library.ts";
import { MANIFEST_FILE } from "../publish.ts";
import {
  auditPart,
  measurePart,
  studPrimitiveFiles,
  type CompiledPart,
  type StudAuditIssue,
} from "./stud-audit.ts";

export interface PrimitiveCount {
  readonly referenced: number;
  readonly extracted: number;
  readonly baked: number;
}

export interface StudAuditReport {
  readonly parts: number;
  readonly partsWithBakedStuds: number;
  readonly primitives: Readonly<Record<string, PrimitiveCount>>;
  readonly issues: ReadonlyArray<StudAuditIssue>;
}

async function readDecoded<const TSchema extends v.GenericSchema>(
  schema: TSchema,
  path: string,
): Promise<v.InferOutput<TSchema>> {
  return decodedOrThrow(decode(schema, JSON.parse(await readFile(path, "utf8"))), path);
}

async function compiledPart(path: string, id: string): Promise<CompiledPart> {
  const bytes = await readFile(path);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const { extras } = parseGlb(buffer as ArrayBuffer, path).document;
  return { id, studs: extras.studs, bounds: extras.bounds };
}

function listIssue(
  table: ReadonlyArray<string>,
  manifest: ReadonlyArray<string>,
): StudAuditIssue[] {
  if (table.join("\n") === manifest.join("\n")) return [];
  return [
    {
      kind: "stud-primitives",
      subject: MANIFEST_FILE,
      detail: `the manifest lists stud primitives ${manifest.join(", ")}, the primitive table ${table.join(", ")}`,
    },
  ];
}

export async function auditBundleStuds(
  bundleDirectory: string,
  library: LdrawLibrary,
  studPrimitives: ReadonlyArray<string>,
): Promise<StudAuditReport> {
  const index = await readDecoded(BundleIndex, join(bundleDirectory, MANIFEST_FILE));
  const { parts } = await readDecoded(PartTableFile, join(bundleDirectory, index.partTable.file));
  const studFiles = studPrimitiveFiles(library, studPrimitives);
  const issues = listIssue(
    studPrimitives,
    index.studPrimitives.map((primitive) => primitive.name),
  );
  const counts = new Map<string, { referenced: number; extracted: number; baked: number }>(
    studPrimitives.map((name) => [name, { referenced: 0, extracted: 0, baked: 0 }]),
  );
  let partsWithBakedStuds = 0;
  for (const part of parts) {
    const measured = measurePart(library, part.path, studFiles);
    const audit = auditPart(
      measured,
      await compiledPart(join(bundleDirectory, part.file), part.id),
    );
    for (const [primitive, count] of audit.extracted) {
      const tally = counts.get(primitive);
      if (tally !== undefined) {
        tally.referenced += count;
        tally.extracted += count;
      }
    }
    for (const [primitive, count] of audit.baked) {
      const tally = counts.get(primitive);
      if (tally !== undefined) {
        tally.referenced += count;
        tally.baked += count;
      }
    }
    if (audit.baked.size > 0) partsWithBakedStuds++;
    issues.push(...audit.issues);
  }
  return {
    parts: parts.length,
    partsWithBakedStuds,
    primitives: Object.fromEntries(counts),
    issues,
  };
}

export function summarizeStudAudit(report: StudAuditReport): string {
  const totals = Object.values(report.primitives).reduce(
    (sum, count) => ({
      referenced: sum.referenced + count.referenced,
      extracted: sum.extracted + count.extracted,
      baked: sum.baked + count.baked,
    }),
    { referenced: 0, extracted: 0, baked: 0 },
  );
  const byKind = new Map<string, number>();
  for (const issue of report.issues) byKind.set(issue.kind, (byKind.get(issue.kind) ?? 0) + 1);
  const lines = [
    `stud audit: ${report.parts} parts, ${totals.referenced} stud references, ${totals.extracted} extracted, ${totals.baked} left in the mesh of ${report.partsWithBakedStuds} parts`,
    ...Object.entries(report.primitives).map(
      ([primitive, count]) =>
        `stud audit: ${primitive} ${count.referenced} referenced, ${count.extracted} extracted, ${count.baked} left in the mesh`,
    ),
    `stud audit: ${report.issues.length} issues${[...byKind].map(([kind, count]) => `, ${kind} ${count}`).join("")}`,
    ...report.issues.map((issue) => `  ${issue.kind} ${issue.subject}: ${issue.detail}`),
  ];
  return `${lines.join("\n")}\n`;
}

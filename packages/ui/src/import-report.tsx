import type { ImportReport, PartResolution, StudioPart, StudioReport } from "@brr/client";
import type { ReactNode } from "react";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const SHORT_COMMIT = 7;
const KIBIBYTE = 1024;

function commitOf(report: ImportReport): string {
  return `${report.mirror.repo}@${report.mirror.commit.slice(0, SHORT_COMMIT)}`;
}

function notDrawnReason(part: PartResolution, report: ImportReport): string | null {
  switch (part.kind) {
    case "bundle":
    case "compiled":
      return null;
    case "notInLibrary":
      return `Not in the official LDraw library at ${commitOf(report)}: unofficial, custom or unknown part${part.definedInline ? ". The file defines it inline, and nothing inside it is drawn" : ""}.`;
    case "missingSubfile":
      return `LDraw part found, but its sub-file ${part.missing} (used by ${part.from}) is not in the library.`;
    case "rejected":
      return `Rejected by the ${part.gate === "license" ? "license" : "unofficial-part"} gate: ${part.path}.`;
    case "inlineDiffers":
      if (!part.colorsMatch) {
        return `The file's inline copy uses colours ${part.inlineColors.join(", ")} where official ${part.official} uses ${part.officialColors.join(", ")}.`;
      }
      if (part.maxMeasuredDistanceLdu > part.weldEpsilonLdu) {
        return `The file's inline copy differs from official ${part.official}: a point on one surface is ${part.maxMeasuredDistanceLdu.toFixed(3)} LDU from the other (weld tolerance ${part.weldEpsilonLdu} LDU).`;
      }
      return `The file's inline copy could not be proven to lie within the ${part.weldEpsilonLdu} LDU weld of official ${part.official}.`;
    case "malformed":
      return `Refused before drawing: ${part.message}.`;
    case "tooLarge":
      return `Not drawn: ${part.message}.`;
    case "failed":
      return part.message;
    default: {
      const unhandled: never = part;
      throw new Error(`unhandled part resolution ${String(unhandled)}`);
    }
  }
}

function studioReason(part: StudioPart): string {
  const id =
    part.bricklinkIdSource === "studioMetadata"
      ? `Studio's BrickLink id ${part.bricklinkId}`
      : `BrickLink id ${part.bricklinkId}, read from Studio's file name`;
  switch (part.outcome.kind) {
    case "kept":
      return `${id} has no LDraw part in the crosswalk.`;
    case "bricklinkCrosswalk":
      return `${id} maps to ldraw:${part.outcome.ldraw}.`;
    case "crosswalkTargetMissing":
      return `${id} maps only to ldraw:${part.outcome.ldraw}, which is not in the pinned library.`;
    case "ambiguous":
      return `${id} has ${part.outcome.candidates.length} LDraw candidates (${part.outcome.candidates.join(", ")}), so nothing is substituted.`;
    case "custom":
      return "A Studio CustomParts file: custom geometry stays in the user's file and is never drawn.";
    default: {
      const unhandled: never = part.outcome;
      throw new Error(`unhandled Studio outcome ${JSON.stringify(unhandled)}`);
    }
  }
}

function studioPartFor(official: string, studio: StudioReport): StudioPart | undefined {
  return studio.parts.find((part) =>
    part.outcome.kind === "bricklinkCrosswalk"
      ? `${part.outcome.ldraw}.dat` === official
      : part.studio === official,
  );
}

function StudioSummary({ studio }: { readonly studio: StudioReport }) {
  const sum = (kind: StudioPart["outcome"]["kind"]): number =>
    studio.parts
      .filter((part) => part.outcome.kind === kind)
      .reduce((total, part) => total + part.instances, 0);
  const rewritten = studio.parts.flatMap((part) =>
    part.outcome.kind === "bricklinkCrosswalk"
      ? [{ studio: part.studio, ldraw: part.outcome.ldraw, instances: part.instances }]
      : [],
  );
  return (
    <>
      <div>
        <dt>Studio file</dt>
        <dd>
          {studio.entry}
          {studio.studioVersion ? ` from Studio ${studio.studioVersion}` : ""},{" "}
          {integer.format(studio.convertedLines)} Studio part lines read as LDraw
        </dd>
      </div>
      <div>
        <dt>Mapped to LDraw</dt>
        <dd className="studio-mapping">
          {integer.format(sum("kept"))} instances kept under Studio&apos;s name,{" "}
          {integer.format(sum("bricklinkCrosswalk"))} renamed through the BrickLink crosswalk
          {rewritten.map((part) => (
            <span key={part.studio} className="studio-rewrite">
              {" "}
              <code>{part.studio}</code> → <code>ldraw:{part.ldraw}</code> ×{part.instances}
            </span>
          ))}
        </dd>
      </div>
    </>
  );
}

function uniqueText(values: ReadonlyArray<string | null>): string {
  return [...new Set(values.filter((v): v is string => v !== null && v !== ""))].join("; ");
}

export function ImportReportDetails({
  report,
  studio,
  children,
}: {
  readonly report: ImportReport;
  readonly studio: StudioReport | null;
  readonly children?: ReactNode;
}) {
  const bundled = report.parts.filter((p) => p.kind === "bundle");
  const compiled = report.parts.filter((p) => p.kind === "compiled");
  const notDrawn = report.parts.flatMap((part) => {
    const reason = notDrawnReason(part, report);
    if (reason === null) return [];
    const studioPart = studio && studioPartFor(part.official, studio);
    return [{ part, reason: studioPart ? `${reason} ${studioReason(studioPart)}` : reason }];
  });
  const notDrawnInstances = notDrawn.reduce((sum, { part }) => sum + part.instances, 0);
  const hasLooseGeometry = report.looseGeometry.length > 0;
  const title = report.sections[0]?.title ?? report.fileName;
  return (
    <section className="module-report" data-file={report.fileName}>
      <h2>{report.fileName}</h2>
      <p className="module-title">{title}</p>
      <dl>
        <div>
          <dt>Authors</dt>
          <dd>{uniqueText(report.sections.map((s) => s.author)) || "none given"}</dd>
        </div>
        <div>
          <dt>Section licenses</dt>
          <dd>{uniqueText(report.sections.map((s) => s.license)) || "none given"}</dd>
        </div>
        {children}
        {studio && <StudioSummary studio={studio} />}
        <div>
          <dt>Instances drawn</dt>
          <dd>
            {integer.format(report.drawnInstanceCount)} of {integer.format(report.instanceCount)}
          </dd>
        </div>
        <div>
          <dt>Unique parts</dt>
          <dd>
            {report.parts.length}: {bundled.length} from the bundle, {compiled.length} compiled from
            LDraw {commitOf(report)}, {notDrawn.length} not drawn
          </dd>
        </div>
        <div>
          <dt>Import</dt>
          <dd>
            {integer.format(report.timings.totalMs)} ms ({report.compileRounds} compile rounds,{" "}
            {report.bakeRounds} bake rounds, bake {integer.format(report.timings.bakeMs)} ms,{" "}
            {report.fetched.found} LDraw files, {integer.format(report.fetched.bytes / KIBIBYTE)}{" "}
            KiB fetched)
          </dd>
        </div>
      </dl>
      {(notDrawn.length > 0 || report.unknownColors.length > 0 || hasLooseGeometry) && (
        <>
          <h3>
            Not drawn: {integer.format(notDrawnInstances)} instances of {notDrawn.length} parts
            {report.unknownColors.length > 0 ? ", plus unknown colours" : ""}
            {hasLooseGeometry ? ", plus loose geometry" : ""}
          </h3>
          <ul className="not-drawn">
            {notDrawn.map(({ part, reason }) => (
              <li key={part.reference} data-kind={part.kind}>
                <code>{part.reference}</code> ×{part.instances}: {reason}
              </li>
            ))}
            {report.looseGeometry.map((loose) => (
              <li key={`loose-${loose.section}`} data-kind="looseGeometry">
                <code>{loose.section}</code> ×{loose.occurrences}: {loose.triangles} triangles and{" "}
                {loose.quads} quads drawn directly in a model section, outside any part.
              </li>
            ))}
            {report.unknownColors.map((color) => (
              <li key={`color-${color.code}`} data-kind="unknownColor">
                Colour <code>{color.code}</code> ×{color.instances}: not in LDConfig, so these
                instances are not drawn.
                {studio ? " It is a Studio colour code and the file carries no RGB for it." : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

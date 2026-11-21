import type { ImportReport, PartResolution, StudioPart, StudioReport } from "@brr/client";
import type { ReactNode } from "react";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const SHORT_COMMIT = 7;
const KIBIBYTE = 1024;

function commitOf(report: ImportReport): string {
  return `${report.mirror.repo}@${report.mirror.commit.slice(0, SHORT_COMMIT)}`;
}

type CustomPart = Extract<PartResolution, { kind: "custom" }>;
type InlineDifference = NonNullable<CustomPart["difference"]>;

function differenceText(difference: InlineDifference, official: string): string {
  if (!difference.colorsMatch) {
    return `The file's inline copy uses colours ${difference.inlineColors.join(", ")} where official ${official} uses ${difference.officialColors.join(", ")}.`;
  }
  if (difference.maxMeasuredDistanceLdu > difference.weldEpsilonLdu) {
    return `The file's inline copy differs from official ${official}: a point on one surface is ${difference.maxMeasuredDistanceLdu.toFixed(3)} LDU from the other (weld tolerance ${difference.weldEpsilonLdu} LDU).`;
  }
  return `The file's inline copy could not be proven to lie within the ${difference.weldEpsilonLdu} LDU weld of official ${official}.`;
}
type RefusedCustomPart = Extract<PartResolution, { kind: "customRefused" }>;

const CUSTOM_ORIGIN_TEXT: Readonly<Record<CustomPart["origin"], string>> = {
  mpd: "defined inside the file",
  inlineDiffers: "the file's own version of an official part number",
  studio: "a Studio CustomParts file",
};

function refusedCustomReason(part: RefusedCustomPart): string {
  const difference = part.difference ? `${differenceText(part.difference, part.official)} ` : "";
  return `${difference}${refusalText(part)}`;
}

function refusalText(part: RefusedCustomPart): string {
  const origin = `Custom part, ${CUSTOM_ORIGIN_TEXT[part.origin]}`;
  switch (part.gate) {
    case "license":
      return `${origin}: ${part.path} carries no CA licence header (CC BY 4.0, CC BY 2.0 or CCAL 2.0), so it is reported and not drawn.`;
    case "unofficial":
      return `${origin}: it reaches ${part.path} in the LDraw library, which declares an Unofficial LDraw org, and library parts that do are drawn only from the allowlist.`;
    case "malformed":
      return `${origin}: refused before drawing: ${part.message}.`;
    case "tooLarge":
      return `${origin}: not drawn: ${part.message}.`;
    case "unresolved":
    case "tooDeep":
    case "noStudRing":
      return `${origin}: it does not compile. ${part.message}`;
    default: {
      const unhandled: never = part.gate;
      throw new Error(`unhandled custom part gate ${String(unhandled)}`);
    }
  }
}

function notDrawnReason(part: PartResolution, report: ImportReport): string | null {
  switch (part.kind) {
    case "bundle":
    case "compiled":
    case "custom":
      return null;
    case "customRefused":
      return refusedCustomReason(part);
    case "notInLibrary":
      return `Not in the official LDraw library at ${commitOf(report)}: unofficial, custom or unknown part${part.definedInline ? ". The file defines it inline, and nothing inside it is drawn" : ""}.`;
    case "missingSubfile":
      return `LDraw part found, but its sub-file ${part.missing} (used by ${part.from}) is not in the library.`;
    case "rejected":
      return `Rejected by the ${part.gate === "license" ? "license" : "unofficial-part"} gate: ${part.path}.`;
    case "inlineDiffers":
      return differenceText(part, part.official);
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
      return "A Studio CustomParts file: drawn as a custom part only when it carries a CA licence header.";
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

type ConnectorCounts = NonNullable<CustomPart["connectors"]>;

const SOURCE_ORDER = ["shadow", "patch", "primitive", "inferred"] as const;

const SOURCE_TEXT: Readonly<Record<(typeof SOURCE_ORDER)[number], string>> = {
  shadow: "from the LDCad shadow library",
  patch: "from the project's shadow patches",
  primitive: "from LDraw primitives",
  inferred: "inferred from geometry",
};

function connectorText(connectors: ConnectorCounts | null): string {
  if (connectors === null) return "no connector table, for the reason listed above";
  if (connectors.total === 0) return "no connectors found at import";
  const tiers = SOURCE_ORDER.map(
    (source) => `${integer.format(connectors.bySource[source])} ${SOURCE_TEXT[source]}`,
  );
  return `${integer.format(connectors.total)} connectors read at import (${tiers.join(", ")}), ${integer.format(connectors.unverified)} unverified`;
}

function CustomParts({ parts }: { readonly parts: ReadonlyArray<CustomPart> }) {
  return (
    <>
      <h3 className="custom-heading">
        Custom parts: {integer.format(parts.reduce((sum, part) => sum + part.instances, 0))}{" "}
        instances of {parts.length} parts
      </h3>
      <ul className="custom-parts">
        {parts.map((part) => (
          <li key={part.partId} data-kind="custom" data-part={part.partId}>
            <span className="part-badge" data-badge="custom">
              custom
            </span>{" "}
            <code>{part.reference}</code> ×{part.instances}: {part.header.title || part.file}, by{" "}
            {part.header.author || "no author given"}, {part.header.license ?? "no licence"}
            {part.header.ldrawOrg ? `, ${part.header.ldrawOrg}` : ""};{" "}
            {CUSTOM_ORIGIN_TEXT[part.origin]}.{" "}
            {part.difference ? `${differenceText(part.difference, part.official)} ` : ""}Drawn on
            this device only; the parts list shows it as custom, never as a buyable part.{" "}
            <span
              data-kind="inferredConnectors"
              data-total={part.connectors?.total ?? 0}
              data-shadow={part.connectors?.bySource.shadow ?? 0}
              data-primitive={part.connectors?.bySource.primitive ?? 0}
              data-inferred={part.connectors?.bySource.inferred ?? 0}
              data-unverified={part.connectors?.unverified ?? 0}
            >
              {connectorText(part.connectors)}.
            </span>
          </li>
        ))}
      </ul>
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
  const custom = report.parts.filter((p): p is CustomPart => p.kind === "custom");
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
            LDraw {commitOf(report)}, {custom.length} custom, {notDrawn.length} not drawn
          </dd>
        </div>
        {report.refusedConnectorRecords.length > 0 && (
          <div data-kind="refusedConnectorRecords">
            <dt>Connector records refused or unreadable</dt>
            <dd>
              {report.refusedConnectorRecords.map(({ partId, reason }) => (
                <div key={partId}>
                  <code>{partId}</code>: {reason}
                </div>
              ))}
            </dd>
          </div>
        )}
        {report.withoutConnectorRecords.length > 0 && (
          <div data-kind="withoutConnectorRecords">
            <dt>Without connector records</dt>
            <dd>
              Drawn with no connectors, because the import found no connector record for{" "}
              {report.withoutConnectorRecords.map((partId, index) => (
                <span key={partId}>
                  {index > 0 ? ", " : ""}
                  <code>{partId}</code>
                </span>
              ))}
              .
            </dd>
          </div>
        )}
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
      {custom.length > 0 && <CustomParts parts={custom} />}
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

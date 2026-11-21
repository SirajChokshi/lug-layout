import {
  LOOK_FEATURES,
  type IBomService,
  type IBomSource,
  type IImportScene,
  type ImportedModule,
  type IViewerScene,
  type LookSettings,
  type SceneSummary,
  type TrackSummary,
} from "@brr/client";
import { CreditLinks, partsCreditText } from "@brr/ui";
import { useEffect, useRef, useState } from "react";
import { BomPanel } from "@brr/ui";
import { ImportPanel } from "./import-panel.tsx";
import { MIN_SCENE_COVERAGE } from "./viewer/frame-coverage.ts";
import type { ChunkTiers } from "./viewer/measure-frames.ts";
import type { MemoryReport } from "./viewer/memory-report.ts";
import { runViewer, type ViewerReport, type ViewerResult } from "./viewer/run-viewer.ts";
import { TRADEMARK_DISCLAIMER } from "./disclaimer.ts";
import type { ViewerParams } from "./viewer/viewer-params.ts";

const BYTES_PER_MEBIBYTE = 1024 * 1024;
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

interface AppProps {
  readonly scene: IViewerScene;
  readonly params: ViewerParams;
  readonly importScene: IImportScene | null;
  readonly bom: { readonly service: IBomService; readonly source: IBomSource } | null;
}

function mebibytes(bytes: number): string {
  return `${(bytes / BYTES_PER_MEBIBYTE).toFixed(1)} MiB`;
}

function tierText(tiers: ChunkTiers): string {
  return `${tiers.near} / ${tiers.mid} / ${tiers.far}`;
}

function memoryText(memory: MemoryReport): string {
  const heap = memory.jsHeapBytes === null ? "not reported" : mebibytes(memory.jsHeapBytes);
  return `vertex+index ${mebibytes(memory.vertexIndexBytes)}, other ${mebibytes(memory.otherBytes)}, JS heap ${heap}`;
}

function renderOriginText(report: ViewerReport): string {
  const { frame, rebases } = report;
  const last = rebases.at(-1);
  const lastText = last ? `, last at frame ${last.frame}` : "";
  return `(${frame.renderOriginChunkX}, ${frame.renderOriginChunkZ}); ${frame.rebaseCount} rebases${lastText}`;
}

function lookText(look: LookSettings): string {
  const enabled = LOOK_FEATURES.filter((feature) => look[feature]);
  return enabled.length > 0 ? enabled.join(", ") : "none (M0 lighting and material)";
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

function trackRows(track: TrackSummary | null): ReadonlyArray<readonly [string, string]> {
  if (!track) return [];
  const unverified =
    track.unverifiedPlacements > 0
      ? [["Unverified track poses", `${track.unverifiedPlacements} placements`] as const]
      : [];
  return [
    ["Track placements", integer.format(track.placements)],
    ["Exact joins", `${integer.format(track.joins)} of ${integer.format(track.ends)} ends paired`],
    ["Open ends", integer.format(track.openEnds)],
    ["Coincident ends not joined", integer.format(track.coincidentNotJoined)],
    ["Switches", integer.format(track.switches)],
    [
      "Directed edges (reachable from edge 0)",
      `${integer.format(track.directedEdges)} (${integer.format(track.reachableFromFirstEdge)})`,
    ],
    ...unverified,
  ];
}

const NO_FAR_MESH_TEXT = "none in the bake (no stud lattice), so far chunks draw shells";

function farModelText(report: ViewerReport, params: ViewerParams): string | null {
  const far = report.summary.farModel;
  if (!far) return params.mode === "model" ? NO_FAR_MESH_TEXT : null;
  return `${integer.format(far.voxels)} voxels of 20×8×20 LDU, ${integer.format(far.triangles)} triangles`;
}

function hudRows(
  report: ViewerReport,
  params: ViewerParams,
): ReadonlyArray<readonly [string, string]> {
  const { backend, summary, frame, timings, liveFps } = report;
  const api =
    backend.activeApi === backend.requestedApi
      ? backend.activeApi
      : `${backend.activeApi} (asked ${backend.requestedApi})`;
  const rows: Array<readonly [string, string]> = [
    ["API", api],
    ["Adapter", backend.adapter],
    ["Look", lookText(backend.look)],
    [
      "Drawing buffer",
      `${report.drawingBuffer.width}×${report.drawingBuffer.height} px (devicePixelRatio ${Number(report.drawingBuffer.devicePixelRatio.toFixed(2))})`,
    ],
    ["Bundle", summary.bundleVersion],
    ["Parts", integer.format(summary.parts)],
    ["Modules", integer.format(summary.modules)],
    [
      "Stud instances (drawn of total)",
      `${integer.format(summary.visibleStudInstances)} of ${integer.format(summary.studInstances)}`,
    ],
    ["Scene triangles", integer.format(summary.bodyTriangles + summary.studTriangles)],
    ["Load", `${integer.format(report.loadMs)} ms`],
    ["GPU buffers allocated so far, JS heap", memoryText(report.memory)],
    ["Render origin (chunks), rebases", renderOriginText(report)],
    ...trackRows(summary.track),
    ["Tier", params.tier ?? "auto (near ≥ 12 px stud pitch, mid ≥ 3 px, else far)"],
    ["Projected stud pitch, nearest chunk", `${report.frame.nearestStudPitchPx.toFixed(1)} px`],
  ];
  const farModel = farModelText(report, params);
  if (farModel !== null) rows.push(["Voxel far mesh", farModel]);
  if (timings) {
    rows.push(
      ["Chunk tiers near/mid/far (median)", tierText(timings.medianChunkTiers)],
      ["Draw calls (median)", integer.format(timings.medianDrawCalls)],
      ["Drawn triangles (median)", integer.format(timings.medianDrawnTriangles)],
      ["Scene coverage (sampled frames)", timings.sceneCoverage.map(percent).join(", ")],
    );
  } else {
    rows.push(
      [
        "Chunk tiers near/mid/far",
        tierText({ near: frame.nearChunks, mid: frame.midChunks, far: frame.farChunks }),
      ],
      ["Draw calls", integer.format(frame.drawCalls)],
      ["Drawn triangles", integer.format(frame.triangles)],
    );
  }
  if (report.liveSceneCoverage !== null) {
    const empty = report.liveSceneCoverage < MIN_SCENE_COVERAGE ? " (essentially empty frame)" : "";
    rows.push(["Scene coverage", `${percent(report.liveSceneCoverage)}${empty}`]);
  }
  if (liveFps !== null) rows.push(["Frame rate (rAF)", `${liveFps.toFixed(1)} fps`]);
  if (timings) {
    rows.push(
      ["Median frame (GPU-synced)", `${timings.medianFrameMs.toFixed(1)} ms`],
      ["p95 frame", `${timings.p95FrameMs.toFixed(1)} ms`],
      ["Median CPU submit", `${timings.medianCpuSubmitMs.toFixed(1)} ms`],
      ["Measured frames", String(timings.frames)],
    );
  }
  return rows;
}

function modelCredit(report: ViewerReport): string {
  const { model } = report.summary;
  if (!model) return "";
  const authors = [...new Set(model.sections.map((s) => s.author).filter((a) => a !== ""))];
  const licenses = [...new Set(model.sections.flatMap((s) => (s.license ? [s.license] : [])))];
  const by = authors.length > 0 ? ` by ${authors.join(", ")}` : "";
  const license = licenses.length > 0 ? `, ${licenses.join("; ")}` : "";
  return `Model ${model.name}${by}${license}. Source: ${model.source}. `;
}

export function App({ scene, params, importScene, bom }: AppProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const started = useRef(false);
  const [viewerReport, setReport] = useState<ViewerReport | null>(null);
  const [importedSummary, setImportedSummary] = useState<SceneSummary | null>(null);
  const report =
    viewerReport && importedSummary ? { ...viewerReport, summary: importedSummary } : viewerReport;
  const [result, setResult] = useState<ViewerResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || started.current) return;
    started.current = true;
    const showError = (e: unknown): void => setError(String(e));
    runViewer(scene, canvas, params, setReport, setResult, showError).catch(showError);
  }, [scene, params]);

  return (
    <>
      <canvas ref={canvasRef} className="scene" />
      <aside className="hud" hidden={!params.hud}>
        <h1>Brick Railroad</h1>
        {error && <p className="error">{error}</p>}
        {report && !error && (
          <dl>
            {hudRows(report, params).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {report && !error && bom && (
          <BomPanel
            service={bom.service}
            source={bom.source}
            region={params.region}
            selectionLabel={null}
            plans={null}
          />
        )}
        {result && !error && (
          <pre id="result" data-done="1">
            {JSON.stringify(result)}
          </pre>
        )}
      </aside>
      {importScene && (
        <ImportPanel
          scene={importScene}
          onImported={(module: ImportedModule) => setImportedSummary(module.summary)}
        />
      )}
      <footer>
        {report && modelCredit(report)}
        {report && partsCreditText(report.summary.creditedFiles, params.lod)}
        {TRADEMARK_DISCLAIMER} <CreditLinks />
      </footer>
    </>
  );
}

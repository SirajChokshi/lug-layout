import type {
  IBomService,
  IBomSource,
  IImportScene,
  IRunScene,
  IViewerScene,
  ImportedModule,
  PlacementDump,
  RunStatus,
  SceneSummary,
  SimBenchResult,
  TrackSummary,
} from "@brr/client";
import { BomPanel, CreditLinks, partsCreditText } from "@brr/ui";
import { useCallback, useEffect, useRef, useState } from "react";
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
  readonly placements: (() => PlacementDump) | null;
  readonly run: IRunScene | null;
  readonly importScene: IImportScene | null;
  readonly bom: { readonly service: IBomService; readonly source: IBomSource } | null;
}

const BENCH_AFTER_MS = 5_000;

function useSimBench(
  run: IRunScene | null,
  ticks: number,
  onError: (error: unknown) => void,
): SimBenchResult | null {
  const [result, setResult] = useState<SimBenchResult | null>(null);
  useEffect(() => {
    if (!run || ticks <= 0) return;
    const timer = setTimeout(() => {
      run.sim.bench(ticks).then(setResult, onError);
    }, BENCH_AFTER_MS);
    return () => clearTimeout(timer);
  }, [run, ticks, onError]);
  return result;
}

const MICROSECONDS_PER_MS = 1000;
const THROTTLE_STEP_LDU_PER_S = 50;

function runRows(status: RunStatus | null): ReadonlyArray<readonly [string, string]> {
  if (!status) return [];
  const { tickCost } = status;
  const perTick = tickCost.ticks > 0 ? (tickCost.stepMs / tickCost.ticks) * MICROSECONDS_PER_MS : 0;
  const speeds = status.trainSpeedLduPerS.map((speed) => speed.toFixed(0)).join(", ");
  const rows: Array<readonly [string, string]> = [
    ["Sim tick (60 Hz, worker)", integer.format(status.tick)],
    ["Sim state hash", status.stateHash.toString(16).padStart(8, "0")],
    [
      "Sim step cost (live, worker clock)",
      `${perTick.toFixed(2)} µs/tick over ${integer.format(tickCost.ticks)} ticks`,
    ],
    ["Trains (speed LDU/s)", `${status.trains} (${speeds})`],
    ["Train edges", status.trainEdge.join(", ")],
    ["Train routes", status.routeStates.join(", ")],
    ["Arrivals per train", status.arrivals.join(", ")],
    [
      "Ticks with two trains on one track piece",
      `${integer.format(status.sharedPieceTicks)} of ${integer.format(status.checkedTicks)}`,
    ],
    [
      "Closest bogies of different trains",
      Number.isFinite(status.minBogieSeparationLdu)
        ? `${integer.format(status.minBogieSeparationLdu)} LDU`
        : "none yet",
    ],
  ];
  status.vehicles.forEach((vehicle, v) => {
    const { lengthLdu, frontBogieLdu, rearBogieLdu } = vehicle.spec;
    rows.push([
      `Vehicle ${v + 1} (LDU)`,
      `${vehicle.model}${vehicle.reversed ? " reversed" : ""}: length ${lengthLdu.toFixed(2)}, guides at ${frontBogieLdu.toFixed(2)} and ${rearBogieLdu.toFixed(2)}, ${vehicle.wheelsets} wheelsets, ${vehicle.bogieBodies} pivoting bogies`,
    ]);
  });
  const spans: string[] = [];
  for (let p = 0; p + 3 < status.bogiePointsLdu.length; p += 4) {
    const [fx = 0, fz = 0, rx = 0, rz = 0] = status.bogiePointsLdu.slice(p, p + 4);
    spans.push(Math.hypot(fx - rx, fz - rz).toFixed(6));
  }
  rows.push(["Bogie centres apart (LDU, per vehicle)", spans.join(", ")]);
  rows.push([
    "Route path end vs exact end",
    `${status.maxEndResidualLdu.toExponential(1)} LDU, ${status.maxEndHeadingResidualRadians.toExponential(1)} rad`,
  ]);
  return rows;
}

function useTrainKeys(
  run: IRunScene | null,
  topSpeed: number,
  onError: (error: unknown) => void,
): void {
  useEffect(() => {
    if (!run) return;
    let speed = topSpeed;
    const switchStates = new Map<number, number>();
    const onKey = (event: KeyboardEvent): void => {
      const status = run.status();
      if (!status) return;
      const send = (command: Parameters<IRunScene["sim"]["command"]>[0]): void => {
        run.sim.command(command).catch(onError);
      };
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        const step = event.key === "ArrowUp" ? THROTTLE_STEP_LDU_PER_S : -THROTTLE_STEP_LDU_PER_S;
        speed = Math.min(Math.max(speed + step, 0), topSpeed);
        for (let train = 0; train < status.trains; train++) {
          send({ kind: "throttle", train, speedLduPerS: speed });
        }
      } else if (event.key === "r") {
        for (let train = 0; train < status.trains; train++) send({ kind: "reverse", train });
      } else if (/^[1-9]$/u.test(event.key)) {
        const switchIndex = Number(event.key) - 1;
        if (switchIndex >= status.switches) return;
        const state = switchStates.get(switchIndex) === 1 ? 0 : 1;
        switchStates.set(switchIndex, state);
        send({ kind: "switch", switchIndex, state });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run, topSpeed, onError]);
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

function hudRows(report: ViewerReport): ReadonlyArray<readonly [string, string]> {
  const { backend, summary, frame, timings, liveFps } = report;
  const api =
    backend.activeApi === backend.requestedApi
      ? backend.activeApi
      : `${backend.activeApi} (asked ${backend.requestedApi})`;
  const rows: Array<readonly [string, string]> = [
    ["API", api],
    ["Adapter", backend.adapter],
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
  ];
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

export function App({ scene, params, placements, run, importScene, bom }: AppProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const started = useRef(false);
  const [viewerReport, setReport] = useState<ViewerReport | null>(null);
  const [importedSummary, setImportedSummary] = useState<SceneSummary | null>(null);
  const report =
    viewerReport && importedSummary ? { ...viewerReport, summary: importedSummary } : viewerReport;
  const [result, setResult] = useState<ViewerResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const showRunError = useCallback((e: unknown): void => setError(String(e)), []);
  useTrainKeys(run, params.speedLduPerS, showRunError);
  const bench = useSimBench(run, params.simBenchTicks, showRunError);
  const runStatus = run?.status() ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || started.current) return;
    started.current = true;
    const showError = (e: unknown): void => setError(String(e));
    runViewer(scene, canvas, params, placements, setReport, setResult, showError).catch(showError);
  }, [scene, params, placements]);

  return (
    <>
      <canvas ref={canvasRef} className="scene" />
      <aside className="hud" hidden={!params.hud}>
        <h1>Brick Railroad</h1>
        {error && <p className="error">{error}</p>}
        {report && !error && (
          <dl>
            {[...hudRows(report), ...runRows(runStatus)].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {runStatus && !error && <pre id="sim">{JSON.stringify(runStatus)}</pre>}
        {bench && !error && (
          <pre id="sim-bench" data-done="1">
            {JSON.stringify(bench)}
          </pre>
        )}
        {report && !error && bom && (
          <BomPanel
            service={bom.service}
            source={bom.source}
            region={params.region}
            selectionLabel={null}
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

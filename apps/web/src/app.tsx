import type { IViewerScene } from "@brr/client";
import { useEffect, useRef, useState } from "react";
import { runViewer, type ViewerReport, type ViewerResult } from "./viewer/run-viewer.ts";
import type { ViewerParams } from "./viewer/viewer-params.ts";

const TRADEMARK_DISCLAIMER =
  "LEGO® is a trademark of the LEGO Group, which does not sponsor, authorize or endorse this site.";
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

interface AppProps {
  readonly scene: IViewerScene;
  readonly params: ViewerParams;
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
    ["Parts", integer.format(summary.parts)],
    ["Stud instances", integer.format(summary.studInstances)],
    ["Scene triangles", integer.format(summary.bodyTriangles + summary.studTriangles)],
    ["Load", `${integer.format(report.loadMs)} ms`],
    ["Draw calls", integer.format(frame.drawCalls)],
    ["Drawn triangles", integer.format(frame.triangles)],
  ];
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
  const [main] = report.summary.modelSections;
  if (!main) return "";
  const authors = [...new Set(report.summary.modelSections.map((s) => s.author))].join(", ");
  return `Model: ${main.name} by ${authors}, LDraw Official Model Repository (${main.license ?? "no license"}). `;
}

export function App({ scene, params }: AppProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const started = useRef(false);
  const [report, setReport] = useState<ViewerReport | null>(null);
  const [result, setResult] = useState<ViewerResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || started.current) return;
    started.current = true;
    runViewer(scene, canvas, params, setReport, setResult).catch((e: unknown) =>
      setError(String(e)),
    );
  }, [scene, params]);

  return (
    <>
      <canvas ref={canvasRef} className="scene" />
      <aside className="hud">
        <h1>Brick Railroad</h1>
        {error && <p className="error">{error}</p>}
        {report && (
          <dl>
            {hudRows(report).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {result && (
          <pre id="result" data-done="1">
            {JSON.stringify(result)}
          </pre>
        )}
      </aside>
      <footer>
        {report && modelCredit(report)}
        {report &&
          `Parts: LDraw parts library, ${report.summary.creditedFiles} files (${report.summary.creditedLicenses.join(", ")}), modified from LDraw: flattened, studs extracted. Colours: LDraw LDConfig.ldr. `}
        {TRADEMARK_DISCLAIMER}
      </footer>
    </>
  );
}

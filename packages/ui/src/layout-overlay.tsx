import {
  GRID_STEPS_STUDS,
  SCREEN_POINT_FLOATS,
  cmOf,
  studsOf,
  type EditorSnapshot,
  type IEditor,
} from "@brr/client";
import { useEffect, useRef } from "react";

interface OverlayProps {
  readonly editor: IEditor;
  readonly snapshot: EditorSnapshot;
}

function placeLabels(
  editor: IEditor,
  overlay: HTMLDivElement,
  count: number,
  points: Float64Array,
): void {
  editor.projectLabels(points);
  const width = overlay.clientWidth;
  const height = overlay.clientHeight;
  const nodes = overlay.children;
  for (let i = 0; i < count; i++) {
    const node = nodes[i];
    if (!(node instanceof HTMLElement)) continue;
    const o = i * SCREEN_POINT_FLOATS;
    const visible = points[o + 2] === 1;
    node.style.visibility = visible ? "visible" : "hidden";
    if (!visible) continue;
    const x = (((points[o] ?? 0) + 1) / 2) * width;
    const y = ((1 - (points[o + 1] ?? 0)) / 2) * height;
    node.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -130%)`;
  }
}

export function MeasureLabels({ editor, snapshot }: OverlayProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const { labels } = snapshot;
  const count = labels.length;
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || count === 0) return;
    const points = new Float64Array(count * SCREEN_POINT_FLOATS);
    let frame = 0;
    const tick = (): void => {
      placeLabels(editor, overlay, count, points);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [editor, count]);
  return (
    <div className="measure-labels" ref={overlayRef} aria-hidden="true">
      {labels.map((label) => (
        <span
          key={label.id}
          className={`measure-label measure-label-${label.kind}`}
          data-label={label.id}
        >
          {label.text}
        </span>
      ))}
    </div>
  );
}

function cursorText(snapshot: EditorSnapshot): string {
  const { hover } = snapshot;
  if (!hover) return "off the ground";
  return `x ${studsOf(hover.x)}, z ${studsOf(hover.z)} studs · ${cmOf(hover.x)}, ${cmOf(hover.z)} cm`;
}

function fillText(snapshot: EditorSnapshot): string | null {
  const { lastFill } = snapshot;
  if (!lastFill) return null;
  const skipped = lastFill.skipped > 0 ? `, skipped ${lastFill.skipped} occupied` : "";
  return `Filled ${lastFill.placed} ${lastFill.placed === 1 ? "plate" : "plates"}${skipped}`;
}

export function LayoutBar({ editor, snapshot }: OverlayProps) {
  const measuring = snapshot.mode === "measure";
  const filled = fillText(snapshot);
  return (
    <div className="layout-bar" role="toolbar" aria-label="Layout guides">
      <span className="layout-cursor" data-cursor-studs={snapshot.hover ? "on" : "off"}>
        {cursorText(snapshot)}
      </span>
      <label className="layout-toggle">
        <input
          type="checkbox"
          checked={snapshot.showGrid}
          onChange={(event) => editor.setShowGrid(event.target.checked)}
        />
        Grid {GRID_STEPS_STUDS.join(" · ")} studs (G)
      </label>
      <button
        type="button"
        data-action="measure"
        aria-pressed={measuring}
        onClick={() => editor.setMeasuring(!measuring)}
      >
        Measure (M)
      </button>
      {snapshot.rulers > 0 && (
        <button type="button" data-action="clear-rulers" onClick={() => editor.clearRulers()}>
          Clear {snapshot.rulers} {snapshot.rulers === 1 ? "ruler" : "rulers"}
        </button>
      )}
      {filled !== null && (
        <span className="layout-hint" data-last-fill={snapshot.lastFill?.placed ?? 0}>
          {filled}
        </span>
      )}
    </div>
  );
}

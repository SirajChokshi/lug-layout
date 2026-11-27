import {
  PROJECTED_IN_VIEW,
  PROJECTED_NDC_X,
  PROJECTED_NDC_Y,
  TEXT_ALONG_OFFSET,
  TEXT_LINE_HEIGHT_EM,
  TEXT_PROJECTION_FLOATS,
  TEXT_UP_OFFSET,
  type INoteEditSession,
  type LegendRowView,
  type NoteTextView,
} from "@brr/client";
import { useEffect, useRef, useSyncExternalStore } from "react";

const FONT_UNITS = 100;
const MIN_TEXT_PX = 3;
const LEGEND_PADDING_PX = 6;
const LEGEND_ROW_PX = 16;
const LEGEND_SWATCH_PX = 10;
const LEGEND_LABEL_X_PX = 16;

function useNoteSession(notes: INoteEditSession): number {
  return useSyncExternalStore(
    (listener) => notes.subscribe(listener),
    () => notes.version(),
  );
}

function screenX(points: Float64Array, at: number, width: number): number {
  return (((points[at + PROJECTED_NDC_X] ?? 0) + 1) / 2) * width;
}

function screenY(points: Float64Array, at: number, height: number): number {
  return ((1 - (points[at + PROJECTED_NDC_Y] ?? 0)) / 2) * height;
}

function transformOf(node: Element | undefined): SVGTransform | null {
  if (!(node instanceof SVGGElement)) return null;
  const list = node.transform.baseVal;
  return list.numberOfItems > 0 ? list.getItem(0) : null;
}

function placeTexts(
  notes: INoteEditSession,
  layer: SVGSVGElement,
  views: ReadonlyArray<NoteTextView>,
  points: Float64Array,
  matrix: DOMMatrix,
): void {
  notes.projectTexts(points);
  const width = layer.clientWidth;
  const height = layer.clientHeight;
  const nodes = layer.children;
  for (let i = 0; i < views.length; i++) {
    const node = nodes[i];
    const view = views[i];
    const transform = transformOf(node);
    if (!node || !view || !transform) continue;
    const at = i * TEXT_PROJECTION_FLOATS;
    const x = screenX(points, at, width);
    const y = screenY(points, at, height);
    let shown = points[at + PROJECTED_IN_VIEW] === 1;
    matrix.a = 1;
    matrix.b = 0;
    matrix.c = 0;
    matrix.d = 1;
    if (view.kind === "text") {
      const alongX = screenX(points, at + TEXT_ALONG_OFFSET, width) - x;
      const alongY = screenY(points, at + TEXT_ALONG_OFFSET, height) - y;
      const upX = screenX(points, at + TEXT_UP_OFFSET, width) - x;
      const upY = screenY(points, at + TEXT_UP_OFFSET, height) - y;
      shown &&= Math.hypot(upX, upY) >= MIN_TEXT_PX;
      matrix.a = alongX / FONT_UNITS;
      matrix.b = alongY / FONT_UNITS;
      matrix.c = -upX / FONT_UNITS;
      matrix.d = -upY / FONT_UNITS;
    }
    matrix.e = x;
    matrix.f = y;
    if ((node.getAttribute("visibility") === "visible") !== shown) {
      node.setAttribute("visibility", shown ? "visible" : "hidden");
    }
    if (shown) transform.setMatrix(matrix);
  }
}

function TextNote({
  lines,
  color,
}: {
  readonly lines: ReadonlyArray<string>;
  readonly color: string;
}) {
  const middle = (lines.length - 1) / 2;
  return (
    <text
      className="note-text"
      fontSize={FONT_UNITS}
      textAnchor="middle"
      dominantBaseline="central"
      fill={color}
    >
      {lines.map((line, i) => (
        <tspan key={i} x={0} y={(i - middle) * TEXT_LINE_HEIGHT_EM * FONT_UNITS}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

interface LegendNoteProps {
  readonly title: string | null;
  readonly rows: ReadonlyArray<LegendRowView>;
}

function LegendNote({ title, rows }: LegendNoteProps) {
  const top = title === null ? 0 : LEGEND_ROW_PX;
  return (
    <>
      <rect className="note-legend-box" />
      {title !== null && (
        <text className="note-legend-title" x={0} y={LEGEND_ROW_PX / 2} dominantBaseline="central">
          {title}
        </text>
      )}
      {rows.map((row, i) => (
        <g key={i} transform={`translate(0 ${top + i * LEGEND_ROW_PX})`}>
          <rect
            className="note-legend-swatch"
            x={0}
            y={(LEGEND_ROW_PX - LEGEND_SWATCH_PX) / 2}
            width={LEGEND_SWATCH_PX}
            height={LEGEND_SWATCH_PX}
            fill={row.color}
          />
          <text
            className="note-legend-label"
            x={LEGEND_LABEL_X_PX}
            y={LEGEND_ROW_PX / 2}
            dominantBaseline="central"
          >
            {row.label}
          </text>
        </g>
      ))}
    </>
  );
}

function fitLegendBoxes(layer: SVGSVGElement): void {
  for (const node of layer.children) {
    const box = node.querySelector(".note-legend-box");
    if (!(box instanceof SVGRectElement) || !(node instanceof SVGGElement)) continue;
    box.setAttribute("width", "0");
    box.setAttribute("height", "0");
    const content = node.getBBox();
    box.x.baseVal.value = content.x - LEGEND_PADDING_PX;
    box.y.baseVal.value = content.y - LEGEND_PADDING_PX;
    box.width.baseVal.value = content.width + 2 * LEGEND_PADDING_PX;
    box.height.baseVal.value = content.height + 2 * LEGEND_PADDING_PX;
  }
}

export function NoteTexts({ notes }: { readonly notes: INoteEditSession }) {
  useNoteSession(notes);
  const views = notes.texts();
  const layerRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || views.length === 0) return;
    fitLegendBoxes(layer);
    const points = new Float64Array(views.length * TEXT_PROJECTION_FLOATS);
    const matrix = layer.createSVGMatrix();
    let frame = 0;
    const tick = (): void => {
      placeTexts(notes, layer, views, points, matrix);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [notes, views]);
  return (
    <svg className="note-texts" ref={layerRef} aria-hidden="true">
      {views.map((view) => (
        <g
          key={view.id}
          className={view.kind === "text" ? "note-label" : "note-legend"}
          data-note={view.id}
          data-selected={view.kind === "text" && view.selected ? "1" : undefined}
          transform="matrix(1 0 0 1 0 0)"
          visibility="hidden"
        >
          {view.kind === "text" ? (
            <TextNote lines={view.lines} color={view.color} />
          ) : (
            <LegendNote title={view.title} rows={view.rows} />
          )}
        </g>
      ))}
    </svg>
  );
}

import {
  PROJECTED_IN_VIEW,
  PROJECTED_NDC_X,
  PROJECTED_NDC_Y,
  TEXT_ALONG_OFFSET,
  TEXT_LINE_HEIGHT_EM,
  TEXT_PROJECTION_FLOATS,
  TEXT_UP_OFFSET,
  type INoteEditSession,
} from "@brr/client";
import { useEffect, useRef, useSyncExternalStore } from "react";

const FONT_UNITS = 100;
const MIN_TEXT_PX = 3;

function screenX(points: Float64Array, at: number, width: number): number {
  return (((points[at + PROJECTED_NDC_X] ?? 0) + 1) / 2) * width;
}

function screenY(points: Float64Array, at: number, height: number): number {
  return ((1 - (points[at + PROJECTED_NDC_Y] ?? 0)) / 2) * height;
}

function placeTexts(
  notes: INoteEditSession,
  layer: SVGSVGElement,
  count: number,
  points: Float64Array,
  matrix: DOMMatrix,
): void {
  notes.projectTexts(points);
  const width = layer.clientWidth;
  const height = layer.clientHeight;
  for (let i = 0; i < count; i++) {
    const node = layer.children[i];
    if (!(node instanceof SVGGElement) || node.transform.baseVal.numberOfItems === 0) continue;
    const at = i * TEXT_PROJECTION_FLOATS;
    const x = screenX(points, at, width);
    const y = screenY(points, at, height);
    const upX = screenX(points, at + TEXT_UP_OFFSET, width) - x;
    const upY = screenY(points, at + TEXT_UP_OFFSET, height) - y;
    const shown = points[at + PROJECTED_IN_VIEW] === 1 && Math.hypot(upX, upY) >= MIN_TEXT_PX;
    if ((node.getAttribute("visibility") === "visible") !== shown) {
      node.setAttribute("visibility", shown ? "visible" : "hidden");
    }
    if (!shown) continue;
    matrix.a = (screenX(points, at + TEXT_ALONG_OFFSET, width) - x) / FONT_UNITS;
    matrix.b = (screenY(points, at + TEXT_ALONG_OFFSET, height) - y) / FONT_UNITS;
    matrix.c = -upX / FONT_UNITS;
    matrix.d = -upY / FONT_UNITS;
    matrix.e = x;
    matrix.f = y;
    node.transform.baseVal.getItem(0).setMatrix(matrix);
  }
}

export function NoteTexts({ notes }: { readonly notes: INoteEditSession }) {
  useSyncExternalStore(
    (listener) => notes.subscribe(listener),
    () => notes.version(),
  );
  const views = notes.texts();
  const layerRef = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || views.length === 0) return;
    const points = new Float64Array(views.length * TEXT_PROJECTION_FLOATS);
    const matrix = layer.createSVGMatrix();
    let frame = 0;
    const tick = (): void => {
      placeTexts(notes, layer, views.length, points, matrix);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [notes, views]);
  return (
    <svg className="note-texts" ref={layerRef} aria-hidden="true">
      {views.map(({ id, note }) => {
        const lines = note.text.split("\n");
        const middle = (lines.length - 1) / 2;
        return (
          <g key={id} data-note={id} transform="matrix(1 0 0 1 0 0)" visibility="hidden">
            <text
              className="note-text"
              fontSize={FONT_UNITS}
              textAnchor="middle"
              dominantBaseline="central"
              fill={note.color}
            >
              {lines.map((line, i) => (
                <tspan key={i} x={0} y={(i - middle) * TEXT_LINE_HEIGHT_EM * FONT_UNITS}>
                  {line}
                </tspan>
              ))}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

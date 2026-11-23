import {
  PROJECTED_IN_VIEW,
  PROJECTED_NDC_X,
  PROJECTED_NDC_Y,
  PROJECTION_FLOATS,
  type EditorSnapshot,
  type IEditor,
} from "@brr/client";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";

const LABEL_MOVE_PX = 0.25;
const LABEL_RISE_PX = 16;
const PILL_PADDING_X_PX = 7;
const PILL_PADDING_Y_PX = 3;
const PILL_RADIUS_PX = 10;
const SCREEN_FLOATS_PER_LABEL = 2;
const PILL_FLOATS_PER_LABEL = 4;
const PILL_GAP_PX = 2;

interface PlacedLabel {
  readonly node: SVGGElement;
  readonly translate: SVGTransform;
}

function placedLabel(node: Element | undefined): PlacedLabel | null {
  if (!(node instanceof SVGGElement)) return null;
  const translate =
    node.transform.baseVal.numberOfItems > 0 ? node.transform.baseVal.getItem(0) : null;
  return translate ? { node, translate } : null;
}

function overlapsShown(
  taken: Float64Array,
  takenCount: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  for (let t = 0; t < takenCount; t++) {
    const o = t * PILL_FLOATS_PER_LABEL;
    if (
      minX < (taken[o + 2] ?? 0) + PILL_GAP_PX &&
      (taken[o] ?? 0) < maxX + PILL_GAP_PX &&
      minY < (taken[o + 3] ?? 0) + PILL_GAP_PX &&
      (taken[o + 1] ?? 0) < maxY + PILL_GAP_PX
    ) {
      return true;
    }
  }
  return false;
}

function placeLabels(
  editor: IEditor,
  layer: SVGSVGElement,
  count: number,
  points: Float64Array,
  shown: Float64Array,
  pills: Float64Array,
  taken: Float64Array,
  placed: Array<PlacedLabel | null>,
): void {
  editor.projectLabels(points);
  const width = layer.clientWidth;
  const height = layer.clientHeight;
  const nodes = layer.children;
  let takenCount = 0;
  for (let i = 0; i < count; i++) {
    const node = nodes[i];
    let label = placed[i] ?? null;
    if (label?.node !== node) {
      label = placedLabel(node);
      placed[i] = label;
      shown[i * SCREEN_FLOATS_PER_LABEL] = Number.NaN;
    }
    if (!label) continue;
    const o = i * PROJECTION_FLOATS;
    const s = i * SCREEN_FLOATS_PER_LABEL;
    const p = i * PILL_FLOATS_PER_LABEL;
    const inView = points[o + PROJECTED_IN_VIEW] === 1;
    const x = (((points[o + PROJECTED_NDC_X] ?? 0) + 1) / 2) * width;
    const y = ((1 - (points[o + PROJECTED_NDC_Y] ?? 0)) / 2) * height;
    const minX = x + (pills[p] ?? 0);
    const minY = y + (pills[p + 1] ?? 0);
    const maxX = minX + (pills[p + 2] ?? 0);
    const maxY = minY + (pills[p + 3] ?? 0);
    const visible = inView && !overlapsShown(taken, takenCount, minX, minY, maxX, maxY);
    if ((label.node.getAttribute("visibility") === "visible") !== visible) {
      label.node.setAttribute("visibility", visible ? "visible" : "hidden");
    }
    if (!visible) continue;
    const t = takenCount * PILL_FLOATS_PER_LABEL;
    taken[t] = minX;
    taken[t + 1] = minY;
    taken[t + 2] = maxX;
    taken[t + 3] = maxY;
    takenCount++;
    if (
      Math.abs(x - (shown[s] ?? Number.NaN)) < LABEL_MOVE_PX &&
      Math.abs(y - (shown[s + 1] ?? Number.NaN)) < LABEL_MOVE_PX
    ) {
      continue;
    }
    shown[s] = x;
    shown[s + 1] = y;
    label.translate.setTranslate(x, y);
  }
}

function fitPills(layer: SVGSVGElement, pills: Float64Array): void {
  let i = 0;
  for (const node of layer.children) {
    const text = node.querySelector("text");
    const pill = node.querySelector("rect");
    const p = i * PILL_FLOATS_PER_LABEL;
    i++;
    if (!(text instanceof SVGTextElement) || !(pill instanceof SVGRectElement)) continue;
    const box = text.getBBox();
    pill.x.baseVal.value = box.x - PILL_PADDING_X_PX;
    pill.y.baseVal.value = box.y - PILL_PADDING_Y_PX;
    pill.width.baseVal.value = box.width + 2 * PILL_PADDING_X_PX;
    pill.height.baseVal.value = box.height + 2 * PILL_PADDING_Y_PX;
    if (p + PILL_FLOATS_PER_LABEL > pills.length) continue;
    pills[p] = pill.x.baseVal.value;
    pills[p + 1] = pill.y.baseVal.value;
    pills[p + 2] = pill.width.baseVal.value;
    pills[p + 3] = pill.height.baseVal.value;
  }
}

interface SceneLabelsProps {
  readonly editor: IEditor;
  readonly snapshot: EditorSnapshot;
}

export function SceneLabels({ editor, snapshot }: SceneLabelsProps) {
  const layerRef = useRef<SVGSVGElement>(null);
  const { labels } = snapshot;
  const count = labels.length;
  const pillContentKey = labels.map((label) => `${label.id}:${label.text}`).join("\n");
  const pills = useMemo(() => new Float64Array(count * PILL_FLOATS_PER_LABEL), [count]);
  useLayoutEffect(() => {
    if (layerRef.current && pillContentKey !== "") fitPills(layerRef.current, pills);
  }, [pillContentKey, pills]);
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || count === 0) return;
    const points = new Float64Array(count * PROJECTION_FLOATS);
    const shown = new Float64Array(count * SCREEN_FLOATS_PER_LABEL);
    const taken = new Float64Array(count * PILL_FLOATS_PER_LABEL);
    const placed: Array<PlacedLabel | null> = [];
    let frame = 0;
    const tick = (): void => {
      placeLabels(editor, layer, count, points, shown, pills, taken, placed);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [editor, count, pills]);
  return (
    <svg className="scene-labels" ref={layerRef} aria-hidden="true">
      {labels.map((label) => (
        <g
          key={label.id}
          className="scene-label"
          data-kind={label.kind}
          data-label={label.id}
          transform="translate(0 0)"
          visibility="hidden"
        >
          <rect className="scene-label-pill" rx={PILL_RADIUS_PX} />
          <text className="scene-label-text" y={-LABEL_RISE_PX} textAnchor="middle">
            {label.text}
          </text>
        </g>
      ))}
    </svg>
  );
}

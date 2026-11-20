import {
  PROJECTED_IN_VIEW,
  PROJECTED_NDC_X,
  PROJECTED_NDC_Y,
  PROJECTION_FLOATS,
  STUD_LDU,
  lengthText,
  scaleBarStuds,
  type EditorSnapshot,
  type IEditor,
  type IEditorCamera,
} from "@brr/client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useCameraSnapshot } from "./view-controls.tsx";

const SCALE_BAR_MAX_PX = 160;
const LABEL_MOVE_PX = 0.25;
const LABEL_RISE_PX = 16;
const PILL_PADDING_X_PX = 7;
const PILL_PADDING_Y_PX = 3;
const PILL_RADIUS_PX = 10;
const SCREEN_FLOATS_PER_LABEL = 2;

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

function placeLabels(
  editor: IEditor,
  layer: SVGSVGElement,
  count: number,
  points: Float64Array,
  shown: Float64Array,
  placed: Array<PlacedLabel | null>,
): void {
  editor.projectLabels(points);
  const width = layer.clientWidth;
  const height = layer.clientHeight;
  const nodes = layer.children;
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
    const visible = points[o + PROJECTED_IN_VIEW] === 1;
    if ((label.node.getAttribute("visibility") === "visible") !== visible) {
      label.node.setAttribute("visibility", visible ? "visible" : "hidden");
    }
    if (!visible) continue;
    const x = (((points[o + PROJECTED_NDC_X] ?? 0) + 1) / 2) * width;
    const y = ((1 - (points[o + PROJECTED_NDC_Y] ?? 0)) / 2) * height;
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

function fitPills(layer: SVGSVGElement): void {
  for (const node of layer.children) {
    const text = node.querySelector("text");
    const pill = node.querySelector("rect");
    if (!(text instanceof SVGTextElement) || !(pill instanceof SVGRectElement)) continue;
    const box = text.getBBox();
    pill.x.baseVal.value = box.x - PILL_PADDING_X_PX;
    pill.y.baseVal.value = box.y - PILL_PADDING_Y_PX;
    pill.width.baseVal.value = box.width + 2 * PILL_PADDING_X_PX;
    pill.height.baseVal.value = box.height + 2 * PILL_PADDING_Y_PX;
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
  useLayoutEffect(() => {
    if (layerRef.current && pillContentKey !== "") fitPills(layerRef.current);
  }, [pillContentKey]);
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || count === 0) return;
    const points = new Float64Array(count * PROJECTION_FLOATS);
    const shown = new Float64Array(count * SCREEN_FLOATS_PER_LABEL);
    const placed: Array<PlacedLabel | null> = [];
    let frame = 0;
    const tick = (): void => {
      placeLabels(editor, layer, count, points, shown, placed);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [editor, count]);
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

function LiveScaleBar({ camera }: { readonly camera: IEditorCamera }) {
  const barRef = useRef<HTMLDivElement>(null);
  const ruleRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const bar = barRef.current;
    const rule = ruleRef.current;
    const text = textRef.current;
    if (!bar || !rule || !text) return;
    let frame = 0;
    let shownStuds = 0;
    let shownWidthPx = -1;
    const tick = (): void => {
      const pixelsPerLdu = camera.planPixelsPerLdu();
      const ready = pixelsPerLdu !== null && pixelsPerLdu > 0 && Number.isFinite(pixelsPerLdu);
      if (bar.hidden === ready) bar.hidden = !ready;
      if (ready) {
        const studs = scaleBarStuds(pixelsPerLdu, SCALE_BAR_MAX_PX);
        const widthPx = Math.round(studs * STUD_LDU * pixelsPerLdu);
        if (widthPx !== shownWidthPx) {
          rule.style.width = `${widthPx}px`;
          shownWidthPx = widthPx;
        }
        if (studs !== shownStuds) {
          text.textContent = lengthText(studs * STUD_LDU);
          bar.dataset["studs"] = String(studs);
          shownStuds = studs;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [camera]);
  return (
    <div className="scale-bar" ref={barRef} title="Scale of the 2D plan" hidden>
      <span className="scale-bar-text" ref={textRef} />
      <span className="scale-bar-rule" ref={ruleRef} aria-hidden="true" />
    </div>
  );
}

export function ScaleBar({ camera }: { readonly camera: IEditorCamera }) {
  const view = useCameraSnapshot(camera);
  return view.mode === "plan" ? <LiveScaleBar camera={camera} /> : null;
}

import {
  PROJECTED_IN_VIEW,
  PROJECTED_NDC_X,
  PROJECTED_NDC_Y,
  PROJECTION_FLOATS,
  type ITrainPlay,
  type PlaySwitchView,
} from "@brr/client";
import { useEffect, useRef, type KeyboardEvent } from "react";
import { placedLabel, type PlacedLabel } from "./scene-labels.tsx";
import { usePlaySnapshot } from "./use-play.ts";

const LEVER_RISE_PX = 24;
const LEVER_ARM_PX = 15;
const LEVER_BASE_RADIUS_PX = 9;
const LEVER_KNOB_RADIUS_PX = 4;
const LEVER_TILT_DEGREES = 30;

function placeLevers(
  play: ITrainPlay,
  layer: SVGSVGElement,
  count: number,
  points: Float64Array,
  placed: Array<PlacedLabel | null>,
): void {
  play.projectSwitches(points);
  const width = layer.clientWidth;
  const height = layer.clientHeight;
  const nodes = layer.children;
  for (let i = 0; i < count; i++) {
    const node = nodes[i];
    let lever = placed[i] ?? null;
    if (lever?.node !== node) {
      lever = placedLabel(node);
      placed[i] = lever;
    }
    if (!lever) continue;
    const o = i * PROJECTION_FLOATS;
    const visible = points[o + PROJECTED_IN_VIEW] === 1;
    if ((lever.node.getAttribute("visibility") === "visible") !== visible) {
      lever.node.setAttribute("visibility", visible ? "visible" : "hidden");
    }
    if (!visible) continue;
    lever.translate.setTranslate(
      (((points[o + PROJECTED_NDC_X] ?? 0) + 1) / 2) * width,
      ((1 - (points[o + PROJECTED_NDC_Y] ?? 0)) / 2) * height,
    );
  }
}

function Lever({ play, view }: { readonly play: ITrainPlay; readonly view: PlaySwitchView }) {
  const state = view.diverging ? "diverging" : "straight";
  const throwIt = (): void => play.throwSwitch(view.index);
  const onKeyDown = (event: KeyboardEvent<SVGGElement>): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    throwIt();
  };
  return (
    <g
      className="switch-lever"
      data-switch={view.index}
      role="button"
      tabIndex={0}
      aria-pressed={view.diverging}
      aria-label={`${view.label}, set ${state}`}
      transform="translate(0 0)"
      visibility="hidden"
      onClick={throwIt}
      onKeyDown={onKeyDown}
    >
      <title>{`${view.label}: set ${state}. Click to throw it.`}</title>
      <line className="switch-lever-stem" y2={-LEVER_RISE_PX} />
      <g
        transform={`translate(0 ${-LEVER_RISE_PX}) rotate(${view.diverging ? LEVER_TILT_DEGREES : -LEVER_TILT_DEGREES})`}
      >
        <circle className="switch-lever-base" r={LEVER_BASE_RADIUS_PX} />
        <line className="switch-lever-arm" y2={-LEVER_ARM_PX} />
        <circle className="switch-lever-knob" cy={-LEVER_ARM_PX} r={LEVER_KNOB_RADIUS_PX} />
      </g>
    </g>
  );
}

export function SwitchLevers({ play }: { readonly play: ITrainPlay }) {
  const { status, switches } = usePlaySnapshot(play);
  const layerRef = useRef<SVGSVGElement>(null);
  const count = status === "running" ? switches.length : 0;
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || count === 0) return;
    const points = new Float64Array(count * PROJECTION_FLOATS);
    const placed: Array<PlacedLabel | null> = [];
    let frame = 0;
    const tick = (): void => {
      placeLevers(play, layer, count, points, placed);
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [play, count]);
  if (count === 0) return null;
  return (
    <svg className="switch-levers" ref={layerRef} role="group" aria-label="Switch levers">
      {switches.map((view) => (
        <Lever key={view.index} play={play} view={view} />
      ))}
    </svg>
  );
}

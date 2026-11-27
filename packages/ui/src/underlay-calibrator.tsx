import type { PixelPoint } from "@brr/schema/world";
import { useEffect, useRef, useState, type MouseEvent } from "react";

const MM_PER_UNIT = { m: 1000, cm: 10, mm: 1, ft: 304.8, in: 25.4 } as const;
type DistanceUnit = keyof typeof MM_PER_UNIT;
const DISTANCE_UNITS: ReadonlyArray<DistanceUnit> = ["m", "cm", "mm", "ft", "in"];
const MARKER_SHARE_OF_LONGER_SIDE = 0.008;

export interface UnderlayCalibration {
  readonly from: PixelPoint;
  readonly to: PixelPoint;
  readonly distanceMm: number;
}

interface PixelSize {
  readonly width: number;
  readonly height: number;
}

function naturalPixel(offset: number, shown: number, natural: number): number {
  return Math.min(natural, Math.max(0, Math.round((offset * natural) / shown)));
}

function pixelAt(event: MouseEvent<HTMLImageElement>): PixelPoint {
  const image = event.currentTarget;
  const box = image.getBoundingClientRect();
  return [
    naturalPixel(event.clientX - box.left, box.width, image.naturalWidth),
    naturalPixel(event.clientY - box.top, box.height, image.naturalHeight),
  ];
}

function calibration(
  points: ReadonlyArray<PixelPoint>,
  distance: string,
  unit: DistanceUnit,
): UnderlayCalibration | null {
  const [from, to] = points;
  const distanceMm = Number(distance) * MM_PER_UNIT[unit];
  if (!from || !to || (from[0] === to[0] && from[1] === to[1])) return null;
  return Number.isFinite(distanceMm) && distanceMm > 0 ? { from, to, distanceMm } : null;
}

function Markers({ points, size }: { points: ReadonlyArray<PixelPoint>; size: PixelSize }) {
  const radius = Math.max(size.width, size.height) * MARKER_SHARE_OF_LONGER_SIDE;
  const [from, to] = points;
  return (
    <svg
      className="underlay-markers"
      viewBox={`0 0 ${size.width} ${size.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {from && to && <line x1={from[0]} y1={from[1]} x2={to[0]} y2={to[1]} />}
      {points.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={radius} />
      ))}
    </svg>
  );
}

export function UnderlayCalibrator({
  imageUrl,
  initial,
  onApply,
  onCancel,
}: {
  readonly imageUrl: string;
  readonly initial: UnderlayCalibration | null;
  readonly onApply: (calibration: UnderlayCalibration) => void;
  readonly onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [size, setSize] = useState<PixelSize | null>(null);
  const [points, setPoints] = useState<ReadonlyArray<PixelPoint>>(
    initial ? [initial.from, initial.to] : [],
  );
  const [distance, setDistance] = useState(
    initial ? String(initial.distanceMm / MM_PER_UNIT.m) : "",
  );
  const [unit, setUnit] = useState<DistanceUnit>("m");
  useEffect(() => dialog.current?.showModal(), []);
  const ready = calibration(points, distance, unit);
  const [from, to] = points;
  const apply = (): void => {
    if (ready) onApply(ready);
  };
  return (
    <dialog
      ref={dialog}
      className="underlay-calibrator"
      aria-labelledby="underlay-calibrator-title"
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <header>
        <h2 id="underlay-calibrator-title">Scale the floor plan</h2>
        <button type="button" className="overlay-close" onClick={onCancel}>
          Cancel <kbd>Esc</kbd>
        </button>
      </header>
      <p>
        Click two points whose distance apart you know, such as the ends of the scale bar or of a
        wall, then type that distance. A third click starts again.
      </p>
      <div className="underlay-picture" data-points={points.map(([x, y]) => `${x},${y}`).join(" ")}>
        <img
          src={imageUrl}
          alt="The floor plan"
          draggable={false}
          onLoad={(event) =>
            setSize({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          onClick={(event) => {
            const point = pixelAt(event);
            setPoints((held) => {
              const [first] = held;
              return held.length === 1 && first ? [first, point] : [point];
            });
          }}
        />
        {size && <Markers points={points} size={size} />}
      </div>
      <div className="underlay-distance">
        <span>
          {from ? `First point ${from[0]}, ${from[1]} px` : "Click the first point"}
          {from && (to ? ` · second ${to[0]}, ${to[1]} px` : " · click the second point")}
        </span>
        <label>
          Distance between them
          <input
            type="number"
            min="0"
            step="any"
            name="underlay-distance"
            value={distance}
            onChange={(event) => setDistance(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && apply()}
          />
        </label>
        <select
          name="underlay-unit"
          aria-label="Distance unit"
          value={unit}
          onChange={(event) => {
            const picked = DISTANCE_UNITS.find((name) => name === event.target.value);
            if (picked) setUnit(picked);
          }}
        >
          {DISTANCE_UNITS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button type="button" data-action="apply-underlay-scale" disabled={!ready} onClick={apply}>
          Apply
        </button>
      </div>
    </dialog>
  );
}

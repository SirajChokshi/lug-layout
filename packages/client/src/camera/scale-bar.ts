import { MM_PER_STUD, STUD_LDU } from "@brr/math";
import { inject, injectable } from "inversify";
import { EDITOR_CAMERA } from "../tokens.ts";
import type { IEditorCamera } from "./editor-camera.ts";

export interface ScaleBarView {
  readonly studs: number;
  readonly widthPx: number;
  readonly label: string;
}

export interface IScaleBar {
  view(): ScaleBarView | null;
  subscribe(listener: () => void): () => void;
  refresh(): void;
}

export const SCALE_BAR_MAX_PX = 120;
const MM_PER_CM = 10;
const MM_PER_M = 1000;

function trimmed(value: number, places: number): string {
  return String(Number(value.toFixed(places)));
}

function studsText(studs: number): string {
  if (studs < 1) return `1/${1 / studs} stud`;
  return studs === 1 ? "1 stud" : `${studs} studs`;
}

function lengthText(mm: number): string {
  if (mm < MM_PER_CM) return `${trimmed(mm, 1)} mm`;
  if (mm < MM_PER_M) return `${trimmed(mm / MM_PER_CM, 1)} cm`;
  return `${trimmed(mm / MM_PER_M, 2)} m`;
}

export function scaleBarFor(lduPerPx: number, maxWidthPx = SCALE_BAR_MAX_PX): ScaleBarView {
  const studPx = STUD_LDU / lduPerPx;
  let studs = 1;
  while (studs * studPx > maxWidthPx) studs /= 2;
  while (2 * studs * studPx <= maxWidthPx) studs *= 2;
  return {
    studs,
    widthPx: Math.round((studs * STUD_LDU) / lduPerPx),
    label: `${studsText(studs)} · ${lengthText(studs * MM_PER_STUD)}`,
  };
}

@injectable()
export class ScaleBar implements IScaleBar {
  private readonly listeners = new Set<() => void>();
  private state: ScaleBarView | null = null;
  private measuredLduPerPx: number | null = null;

  constructor(
    @inject(EDITOR_CAMERA) private readonly camera: Pick<IEditorCamera, "planLduPerPx">,
  ) {}

  view(): ScaleBarView | null {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(): void {
    const lduPerPx = this.camera.planLduPerPx();
    if (lduPerPx === this.measuredLduPerPx) return;
    this.measuredLduPerPx = lduPerPx;
    const next = lduPerPx === null ? null : scaleBarFor(lduPerPx);
    if (next?.studs === this.state?.studs && next?.widthPx === this.state?.widthPx) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

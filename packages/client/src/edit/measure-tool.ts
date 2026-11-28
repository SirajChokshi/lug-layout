import { STUD_LDU, planeHypot } from "@brr/math";
import type { GuideKind, GuideSegment } from "@brr/render";
import { lengthText, studsText, type LabelKind, type LabelView } from "./size-labels.ts";

export interface Ruler {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
}

const TICK_HALF_LDU = STUD_LDU / 2;
const DRAFT_ID = "draft";

export function rulerLength(ruler: Ruler): number {
  return planeHypot(ruler.bx - ruler.ax, ruler.bz - ruler.az);
}

export function rulerText(ruler: Ruler): string {
  const dx = Math.abs(ruler.bx - ruler.ax);
  const dz = Math.abs(ruler.bz - ruler.az);
  if (dx === 0 || dz === 0) return lengthText(dx + dz);
  return `${lengthText(rulerLength(ruler))} (${studsText(dx)} × ${studsText(dz)})`;
}

export function rulerTicks(ruler: Ruler): readonly [Ruler, Ruler] | null {
  const { ax, az, bx, bz } = ruler;
  const length = rulerLength(ruler);
  if (length === 0) return null;
  const nx = (-(bz - az) / length) * TICK_HALF_LDU;
  const nz = ((bx - ax) / length) * TICK_HALF_LDU;
  return [
    { ax: ax - nx, az: az - nz, bx: ax + nx, bz: az + nz },
    { ax: bx - nx, az: bz - nz, bx: bx + nx, bz: bz + nz },
  ];
}

function guideOf(kind: GuideKind, y: number, { ax, az, bx, bz }: Ruler): GuideSegment {
  return { kind, ax, ay: y, az, bx, by: y, bz };
}

export function rulerGuides(ruler: Ruler, y: number, kind: GuideKind, out: GuideSegment[]): void {
  const { ax, az, bx, bz } = ruler;
  const ticks = rulerTicks(ruler);
  if (!ticks) return;
  out.push(guideOf(kind, y, ruler), guideOf(kind, y, ticks[0]), guideOf(kind, y, ticks[1]));
  if (ax === bx || az === bz) return;
  out.push(
    { kind: "axis", ax, ay: y, az, bx, by: y, bz: az },
    { kind: "axis", ax: bx, ay: y, az, bx, by: y, bz },
  );
}

function rulerLabel(id: string, kind: LabelKind, ruler: Ruler, y: number): LabelView {
  return {
    id,
    kind,
    text: rulerText(ruler),
    x: (ruler.ax + ruler.bx) / 2,
    y,
    z: (ruler.az + ruler.bz) / 2,
  };
}

export class MeasureTool {
  private rulers: ReadonlyArray<Ruler> = [];
  private draft: Ruler | null = null;
  private shownLabels: ReadonlyArray<LabelView> = [];

  constructor(private readonly y: number) {}

  get count(): number {
    return this.rulers.length;
  }

  get drafting(): boolean {
    return this.draft !== null;
  }

  begin(x: number, z: number): void {
    this.draft = { ax: x, az: z, bx: x, bz: z };
    this.relabel();
  }

  drag(x: number, z: number): boolean {
    const draft = this.draft;
    if (!draft || (draft.bx === x && draft.bz === z)) return false;
    this.draft = { ...draft, bx: x, bz: z };
    this.relabel();
    return true;
  }

  end(): void {
    const draft = this.draft;
    if (!draft) return;
    this.draft = null;
    if (rulerLength(draft) > 0) this.rulers = [...this.rulers, draft];
    this.relabel();
  }

  cancel(): void {
    if (!this.draft) return;
    this.draft = null;
    this.relabel();
  }

  removeLast(): void {
    if (this.rulers.length === 0) return;
    this.rulers = this.rulers.slice(0, -1);
    this.relabel();
  }

  clear(): void {
    this.rulers = [];
    this.draft = null;
    this.relabel();
  }

  labels(): ReadonlyArray<LabelView> {
    return this.shownLabels;
  }

  guides(): ReadonlyArray<GuideSegment> {
    const out: GuideSegment[] = [];
    for (const ruler of this.rulers) rulerGuides(ruler, this.y, "ruler", out);
    if (this.draft) rulerGuides(this.draft, this.y, "draft", out);
    return out;
  }

  private relabel(): void {
    const labels = this.rulers.map((ruler, i) => rulerLabel(`ruler-${i}`, "ruler", ruler, this.y));
    if (this.draft && rulerLength(this.draft) > 0) {
      labels.push(rulerLabel(DRAFT_ID, "draft", this.draft, this.y));
    }
    this.shownLabels = labels;
  }
}

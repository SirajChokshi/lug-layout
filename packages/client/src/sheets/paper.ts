export type PaperId = "a4" | "letter" | "a3";

export type Orientation = "portrait" | "landscape";

export type OrientationChoice = Orientation | "auto";

export interface PaperSize {
  readonly id: PaperId;
  readonly name: string;
  readonly shortMm: number;
  readonly longMm: number;
}

export interface PageSize {
  readonly widthMm: number;
  readonly heightMm: number;
}

const TENTH_MM_PER_INCH = 254;
const TENTHS_PER_MM = 10;

function inches(count: number): number {
  return (count * TENTH_MM_PER_INCH) / TENTHS_PER_MM;
}

export const PAPER_SIZES: ReadonlyArray<PaperSize> = [
  { id: "a4", name: "A4", shortMm: 210, longMm: 297 },
  { id: "letter", name: "Letter", shortMm: inches(8.5), longMm: inches(11) },
  { id: "a3", name: "A3", shortMm: 297, longMm: 420 },
];

export function paperSize(id: PaperId): PaperSize {
  const paper = PAPER_SIZES.find((candidate) => candidate.id === id);
  if (!paper) throw new Error(`no paper size ${id}`);
  return paper;
}

export function pageSize(paper: PaperSize, orientation: Orientation): PageSize {
  switch (orientation) {
    case "portrait":
      return { widthMm: paper.shortMm, heightMm: paper.longMm };
    case "landscape":
      return { widthMm: paper.longMm, heightMm: paper.shortMm };
    default: {
      const unhandled: never = orientation;
      throw new Error(`unhandled orientation ${String(unhandled)}`);
    }
  }
}

export function orientationsFor(choice: OrientationChoice): ReadonlyArray<Orientation> {
  return choice === "auto" ? ["portrait", "landscape"] : [choice];
}

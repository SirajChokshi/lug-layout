import { injectable } from "inversify";

export interface ISheetTypeface {
  readonly svgFontFamily: string;
  widthMm(text: string, sizeMm: number): number;
  capHeightMm(sizeMm: number): number;
  fitted(text: string, sizeMm: number, widthMm: number): string;
  wrapped(text: string, sizeMm: number, widthMm: number): ReadonlyArray<string>;
}

const COURIER_ADVANCE_EM = 0.6;
const COURIER_CAP_HEIGHT_EM = 0.562;
const ELLIPSIS = "…";

function characters(text: string): string[] {
  return [...text];
}

@injectable()
export class CourierTypeface implements ISheetTypeface {
  readonly svgFontFamily = "'Courier New', Courier, monospace";

  widthMm(text: string, sizeMm: number): number {
    return characters(text).length * COURIER_ADVANCE_EM * sizeMm;
  }

  capHeightMm(sizeMm: number): number {
    return COURIER_CAP_HEIGHT_EM * sizeMm;
  }

  fitted(text: string, sizeMm: number, widthMm: number): string {
    const fits = this.capacity(sizeMm, widthMm);
    const all = characters(text);
    if (all.length <= fits) return text;
    if (fits < 1) return "";
    return `${all.slice(0, fits - 1).join("")}${ELLIPSIS}`;
  }

  wrapped(text: string, sizeMm: number, widthMm: number): ReadonlyArray<string> {
    const fits = Math.max(1, this.capacity(sizeMm, widthMm));
    const lines: string[] = [];
    let line: string[] = [];
    for (const word of text.split(" ")) {
      const letters = characters(word);
      const joined = line.length === 0 ? letters : [...line, " ", ...letters];
      if (joined.length <= fits) {
        line = joined;
        continue;
      }
      if (line.length > 0) lines.push(line.join(""));
      line = letters;
      while (line.length > fits) {
        lines.push(line.slice(0, fits).join(""));
        line = line.slice(fits);
      }
    }
    if (line.length > 0 || lines.length === 0) lines.push(line.join(""));
    return lines;
  }

  private capacity(sizeMm: number, widthMm: number): number {
    const advance = COURIER_ADVANCE_EM * sizeMm;
    let count = Math.floor(widthMm / advance);
    while ((count + 1) * advance <= widthMm) count++;
    while (count > 0 && count * advance > widthMm) count--;
    return count;
  }
}

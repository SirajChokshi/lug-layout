import {
  DEFAULT_OVERLAP_MM,
  MAX_OVERLAP_MM,
  MIN_OVERLAP_MM,
  PAPER_SIZES,
  TILED_SCALE_DENOMINATORS,
  scaleText,
  sheetLayoutProblems,
  type IEditor,
  type IPlanSheetService,
  type OrientationChoice,
  type PaperId,
  type PlanRegion,
  type SheetFormat,
  type SheetLayout,
} from "@brr/client";
import { useState } from "react";
import { downloadBlob } from "./download.ts";

type SheetMode = SheetLayout["kind"];

const MODES: ReadonlyArray<{ readonly id: SheetMode; readonly label: string }> = [
  { id: "tiled", label: "Tiled" },
  { id: "fit", label: "Fit to a page" },
  { id: "whole", label: "One 1:1 sheet" },
];

const ORIENTATIONS: ReadonlyArray<{ readonly id: OrientationChoice; readonly label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "portrait", label: "Portrait" },
  { id: "landscape", label: "Landscape" },
];

const FORMATS: ReadonlyArray<{ readonly id: SheetFormat; readonly label: string }> = [
  { id: "svg", label: "SVG" },
];

function isMode(value: string): value is SheetMode {
  return MODES.some((mode) => mode.id === value);
}

function isPaper(value: string): value is PaperId {
  return PAPER_SIZES.some((paper) => paper.id === value);
}

function isOrientation(value: string): value is OrientationChoice {
  return ORIENTATIONS.some((orientation) => orientation.id === value);
}

function isFormat(value: string): value is SheetFormat {
  return FORMATS.some((format) => format.id === value);
}

function layoutOf(
  mode: SheetMode,
  paper: PaperId,
  orientation: OrientationChoice,
  denominator: number,
  overlapMm: number,
): SheetLayout {
  switch (mode) {
    case "whole":
      return { kind: "whole" };
    case "fit":
      return { kind: "fit", paper, orientation };
    case "tiled":
      return { kind: "tiled", paper, orientation, denominator, overlapMm };
    default: {
      const unhandled: never = mode;
      throw new Error(`unhandled sheet mode ${String(unhandled)}`);
    }
  }
}

export function PrintSheets({
  editor,
  sheets,
  plan,
}: {
  readonly editor: IEditor;
  readonly sheets: IPlanSheetService;
  readonly plan: PlanRegion;
}) {
  const [mode, setMode] = useState<SheetMode>("tiled");
  const [paper, setPaper] = useState<PaperId>("a4");
  const [orientation, setOrientation] = useState<OrientationChoice>("auto");
  const [denominator, setDenominator] = useState(1);
  const [overlapMm, setOverlapMm] = useState(DEFAULT_OVERLAP_MM);
  const [format, setFormat] = useState<SheetFormat>("svg");
  const [saved, setSaved] = useState<string | null>(null);
  const layout = layoutOf(mode, paper, orientation, denominator, overlapMm);
  const problems = sheetLayoutProblems(layout);
  const onPaper = mode !== "whole";
  const tiled = mode === "tiled";
  const download = (): void => {
    const file = sheets.download(editor, plan.id, { layout, format });
    downloadBlob(file.fileName, new Blob([file.bytes.slice()], { type: file.mimeType }));
    setSaved(
      `Saved ${file.pages === 1 ? "1 page" : `${file.pages} pages`} as ${file.fileName}. Print at 100% (actual size).`,
    );
  };
  return (
    <section className="print-sheets" aria-label="Print sheets">
      <h3>Print sheets</h3>
      <div className="plan-grid">
        <label className="mm-field">
          Layout
          <select
            name="sheet-layout"
            value={mode}
            onChange={(event) => {
              if (isMode(event.target.value)) setMode(event.target.value);
            }}
          >
            {MODES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="mm-field">
          Paper
          <select
            name="sheet-paper"
            value={paper}
            disabled={!onPaper}
            onChange={(event) => {
              if (isPaper(event.target.value)) setPaper(event.target.value);
            }}
          >
            {PAPER_SIZES.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mm-field">
          Orientation
          <select
            name="sheet-orientation"
            value={orientation}
            disabled={!onPaper}
            onChange={(event) => {
              if (isOrientation(event.target.value)) setOrientation(event.target.value);
            }}
          >
            {ORIENTATIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="mm-field">
          Scale
          <select
            name="sheet-scale"
            value={denominator}
            disabled={!tiled}
            onChange={(event) => setDenominator(Number(event.target.value))}
          >
            {TILED_SCALE_DENOMINATORS.map((option) => (
              <option key={option} value={option}>
                {scaleText(option)}
              </option>
            ))}
          </select>
        </label>
        <label className="mm-field">
          Overlap mm
          <input
            name="sheet-overlap"
            type="number"
            min={MIN_OVERLAP_MM}
            max={MAX_OVERLAP_MM}
            step={1}
            value={overlapMm}
            disabled={!tiled}
            onChange={(event) => setOverlapMm(Number(event.target.value))}
          />
        </label>
        <label className="mm-field">
          Format
          <select
            name="sheet-format"
            value={format}
            onChange={(event) => {
              if (isFormat(event.target.value)) setFormat(event.target.value);
            }}
          >
            {FORMATS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {problems.map((problem) => (
        <p key={problem} className="plan-errors">
          {problem}
        </p>
      ))}
      <div className="plan-actions">
        <button
          type="button"
          data-action="download-sheets"
          disabled={problems.length > 0}
          title="Download the plan as printable sheets with a title block, legend and key"
          onClick={download}
        >
          Download sheets
        </button>
      </div>
      {saved && <p className="plan-meta">{saved}</p>}
    </section>
  );
}

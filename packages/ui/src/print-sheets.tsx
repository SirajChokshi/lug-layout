import {
  DEFAULT_OVERLAP_MM,
  DEFAULT_PIXELS_PER_STUD,
  MAX_OVERLAP_MM,
  MAX_PIXELS_PER_STUD,
  MIN_OVERLAP_MM,
  MIN_PIXELS_PER_STUD,
  PAPER_SIZES,
  SHEET_LAYER_IDS,
  TILED_SCALE_DENOMINATORS,
  scaleText,
  sheetLayoutProblems,
  type IEditor,
  type IPlanSheetService,
  type ISheetSets,
  type OrientationChoice,
  type PaperId,
  type PlanRegion,
  type SheetContent,
  type SheetFile,
  type SheetFormat,
  type SheetLayerId,
  type SheetLayout,
  type SheetRequest,
  type SheetSet,
  type SheetSetPatch,
} from "@brr/client";
import { useState, useSyncExternalStore } from "react";
import { downloadBlob } from "./download.ts";

type SheetMode = SheetLayout["kind"];

const MODES: ReadonlyArray<{ readonly id: SheetMode; readonly label: string }> = [
  { id: "tiled", label: "Tiled" },
  { id: "fit", label: "Fit to a page" },
  { id: "whole", label: "One 1:1 sheet" },
  { id: "image", label: "Image" },
];

const ORIENTATIONS: ReadonlyArray<{ readonly id: OrientationChoice; readonly label: string }> = [
  { id: "auto", label: "Auto" },
  { id: "portrait", label: "Portrait" },
  { id: "landscape", label: "Landscape" },
];

const FORMATS: ReadonlyArray<{ readonly id: SheetFormat; readonly label: string }> = [
  { id: "pdf", label: "PDF" },
  { id: "svg", label: "SVG" },
  { id: "png", label: "PNG" },
];

const CONTENTS: ReadonlyArray<{ readonly id: SheetContent; readonly label: string }> = [
  { id: "placements", label: "Plan and key" },
  { id: "tables", label: "Table plan" },
];

const LAYER_LABELS: Readonly<Record<SheetLayerId, string>> = {
  room: "Room",
  aisles: "Aisles",
  tables: "Tables",
  obstacles: "Obstacles",
  roadway: "Roadway",
  models: "Models",
  track: "Track",
  ramps: "Suggested ramps",
  dimensions: "Dimensions",
  numbers: "Placement numbers",
  "table-numbers": "Table numbers",
};

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

function isContent(value: string): value is SheetContent {
  return CONTENTS.some((content) => content.id === value);
}

interface LayoutChoices {
  readonly mode: SheetMode;
  readonly paper: PaperId;
  readonly orientation: OrientationChoice;
  readonly denominator: number;
  readonly overlapMm: number;
  readonly pixelsPerStud: number;
}

const DEFAULT_CHOICES: Omit<LayoutChoices, "mode"> = {
  paper: "a4",
  orientation: "auto",
  denominator: 1,
  overlapMm: DEFAULT_OVERLAP_MM,
  pixelsPerStud: DEFAULT_PIXELS_PER_STUD,
};

function choicesOf(layout: SheetLayout): LayoutChoices {
  switch (layout.kind) {
    case "whole":
      return { ...DEFAULT_CHOICES, mode: "whole" };
    case "image":
      return { ...DEFAULT_CHOICES, mode: "image", pixelsPerStud: layout.pixelsPerStud };
    case "fit":
      return {
        ...DEFAULT_CHOICES,
        mode: "fit",
        paper: layout.paper,
        orientation: layout.orientation,
      };
    case "tiled":
      return {
        ...DEFAULT_CHOICES,
        mode: "tiled",
        paper: layout.paper,
        orientation: layout.orientation,
        denominator: layout.denominator,
        overlapMm: layout.overlapMm,
      };
    default: {
      const unhandled: never = layout;
      throw new Error(`unhandled sheet layout ${String(unhandled)}`);
    }
  }
}

function layoutOf(choices: LayoutChoices): SheetLayout {
  const { mode, paper, orientation, denominator, overlapMm, pixelsPerStud } = choices;
  switch (mode) {
    case "whole":
      return { kind: "whole" };
    case "image":
      return { kind: "image", pixelsPerStud };
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

function requestOf(set: SheetSet): SheetRequest {
  return {
    selection: { name: set.name, content: set.content, layers: set.layers },
    layout: set.layout,
    format: set.format,
  };
}

function savedLines(file: SheetFile, format: SheetFormat): ReadonlyArray<string> {
  const print = format === "png" ? "" : " Print at 100% (actual size).";
  return [
    `Saved ${file.pages === 1 ? "1 page" : `${file.pages} pages`} as ${file.fileName}.${print}`,
    ...file.notes,
  ];
}

function useSheetSetsVersion(sheetSets: ISheetSets): number {
  return useSyncExternalStore(
    (listener) => sheetSets.subscribe(listener),
    () => sheetSets.version(),
  );
}

export function PrintSheets({
  editor,
  sheets,
  sheetSets,
  plan,
}: {
  readonly editor: IEditor;
  readonly sheets: IPlanSheetService;
  readonly sheetSets: ISheetSets;
  readonly plan: PlanRegion;
}) {
  useSheetSetsVersion(sheetSets);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [saved, setSaved] = useState<ReadonlyArray<string>>([]);
  const sets = sheetSets.sets(plan.id);
  const chosen = sets.find((set) => set.id === chosenId) ?? sets[0] ?? null;
  const add = (): void => setChosenId(sheetSets.add(plan.id).id);
  if (!chosen) {
    return (
      <section className="print-sheets" aria-label="Print sheets">
        <h3>Print sheets</h3>
        <p className="plan-meta">This plan has no sheets.</p>
        <button type="button" data-action="add-sheet" onClick={add}>
          Add sheet
        </button>
      </section>
    );
  }
  const update = (patch: SheetSetPatch): void => sheetSets.update(plan.id, chosen.id, patch);
  const choices = choicesOf(chosen.layout);
  const choose = (patch: Partial<LayoutChoices>): void =>
    update({ layout: layoutOf({ ...choices, ...patch }) });
  const problems = sheetLayoutProblems(chosen.layout);
  const onPaper = choices.mode === "fit" || choices.mode === "tiled";
  const tiled = choices.mode === "tiled";
  const image = choices.mode === "image";
  const allValid = sets.every((set) => sheetLayoutProblems(set.layout).length === 0);
  const save = (file: SheetFile, format: SheetFormat): void => {
    downloadBlob(file.fileName, new Blob([file.bytes.slice()], { type: file.mimeType }));
    setSaved(savedLines(file, format));
  };
  return (
    <section className="print-sheets" aria-label="Print sheets">
      <h3>Print sheets</h3>
      <div className="plan-grid">
        <label className="mm-field">
          Sheet
          <select
            name="sheet-set"
            value={chosen.id}
            onChange={(event) => setChosenId(event.target.value)}
          >
            {sets.map((set) => (
              <option key={set.id} value={set.id}>
                {set.name || "Untitled"}
              </option>
            ))}
          </select>
        </label>
        <label className="mm-field">
          Name
          <input
            name="sheet-name"
            value={chosen.name}
            onChange={(event) => update({ name: event.target.value })}
          />
        </label>
        <label className="mm-field">
          Shows
          <select
            name="sheet-content"
            value={chosen.content}
            onChange={(event) => {
              if (isContent(event.target.value)) update({ content: event.target.value });
            }}
          >
            {CONTENTS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="mm-field">
          Layout
          <select
            name="sheet-layout"
            value={choices.mode}
            onChange={(event) => {
              const mode = event.target.value;
              if (!isMode(mode)) return;
              update({
                layout: layoutOf({ ...choices, mode }),
                ...(mode === "image" ? { format: "png" } : {}),
              });
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
            value={choices.paper}
            disabled={!onPaper}
            onChange={(event) => {
              if (isPaper(event.target.value)) choose({ paper: event.target.value });
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
            value={choices.orientation}
            disabled={!onPaper}
            onChange={(event) => {
              if (isOrientation(event.target.value)) choose({ orientation: event.target.value });
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
            value={choices.denominator}
            disabled={!tiled}
            onChange={(event) => choose({ denominator: Number(event.target.value) })}
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
            value={choices.overlapMm}
            disabled={!tiled}
            onChange={(event) => choose({ overlapMm: Number(event.target.value) })}
          />
        </label>
        <label className="mm-field">
          Pixels per stud
          <input
            name="sheet-pixels-per-stud"
            type="number"
            min={MIN_PIXELS_PER_STUD}
            max={MAX_PIXELS_PER_STUD}
            step={1}
            value={choices.pixelsPerStud}
            disabled={!image}
            onChange={(event) => choose({ pixelsPerStud: Number(event.target.value) })}
          />
        </label>
        <label className="mm-field">
          Format
          <select
            name="sheet-format"
            value={chosen.format}
            onChange={(event) => {
              if (isFormat(event.target.value)) update({ format: event.target.value });
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
      <fieldset className="sheet-layers">
        <legend>Layers on this sheet</legend>
        {SHEET_LAYER_IDS.map((layer) => (
          <label key={layer}>
            <input
              type="checkbox"
              name={`sheet-layer-${layer}`}
              checked={chosen.layers.includes(layer)}
              onChange={(event) =>
                update({
                  layers: event.target.checked
                    ? [...chosen.layers, layer]
                    : chosen.layers.filter((shown) => shown !== layer),
                })
              }
            />
            {LAYER_LABELS[layer]}
          </label>
        ))}
      </fieldset>
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
          title="Download this sheet with its title block, legend and key"
          onClick={() =>
            void sheets
              .download(editor, plan.id, requestOf(chosen))
              .then((file) => save(file, chosen.format))
          }
        >
          Download sheet
        </button>
        <button
          type="button"
          data-action="download-all-sheets"
          disabled={!allValid}
          title="Download every sheet of this plan in one file, in the format chosen above"
          onClick={() =>
            void sheets
              .downloadAll(editor, plan.id, sets.map(requestOf), chosen.format)
              .then((file) => save(file, chosen.format))
          }
        >
          Download all sheets
        </button>
      </div>
      <div className="plan-actions">
        <button type="button" data-action="add-sheet" onClick={add}>
          Add sheet
        </button>
        <button
          type="button"
          data-action="remove-sheet"
          onClick={() => {
            sheetSets.remove(plan.id, chosen.id);
            setChosenId(null);
          }}
        >
          Delete sheet
        </button>
      </div>
      {saved.map((line) => (
        <p key={line} className="plan-meta">
          {line}
        </p>
      ))}
    </section>
  );
}

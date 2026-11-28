import {
  EDITOR,
  mainThreadModules,
  SHEET_SETS,
  type IPlanSheetService,
  type PlanRegion,
  type SheetFile,
  type SheetFormat,
  type SheetRequest,
} from "@brr/client";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Container } from "inversify";
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { PrintSheets } from "./print-sheets.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PLAN: PlanRegion = {
  id: "plan-1",
  name: "Plan 1",
  originChunkX: 0,
  originChunkZ: 0,
  footprint: { roomWidthMm: 4000, roomDepthMm: 3000, tables: [], obstacles: [] },
  maxOverhangMm: 0,
  maxReachMm: 700,
};

function field(name: string): HTMLSelectElement | HTMLInputElement {
  const element = document.querySelector(`[name="${name}"]`);
  if (!(element instanceof HTMLSelectElement || element instanceof HTMLInputElement)) {
    throw new Error(`no ${name} field`);
  }
  return element;
}

function file(name: string, pages: number, format: SheetFormat): SheetFile {
  return {
    fileName: name,
    mimeType: "application/octet-stream",
    bytes: new Uint8Array(1),
    pages,
    notes: format === "pdf" ? ['1 character prints as "?": Ω.'] : [],
  };
}

function setUp() {
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: "unused",
      disclaimer: "unused",
      startSimWorker: () => new MessageChannel().port1,
    }),
  );
  const single: SheetRequest[] = [];
  const all: Array<{ requests: ReadonlyArray<SheetRequest>; format: SheetFormat }> = [];
  const sheets: IPlanSheetService = {
    printable: () => "",
    download: async (_source, _planId, request) => {
      single.push(request);
      return file(`${request.selection.name}.${request.format}`, 3, request.format);
    },
    downloadAll: async (_source, _planId, requests, format) => {
      all.push({ requests, format });
      return file(`all.${format}`, 9, format);
    },
  };
  const downloads: string[] = [];
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:sheet" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
  const sheetSets = container.get(SHEET_SETS);
  render(
    createElement(PrintSheets, { editor: container.get(EDITOR), sheets, sheetSets, plan: PLAN }),
  );
  return { single, all, downloads, sheetSets };
}

it("downloads the sheet chosen with its saved layers, layout and format, remembers edits to it, and downloads every sheet in one file", async () => {
  const { single, all, downloads, sheetSets } = setUp();
  const download = screen.getByRole("button", { name: "Download sheet" });

  fireEvent.click(download);
  const note = (await screen.findByText(/prints as "\?"/u)).textContent;
  fireEvent.change(field("sheet-set"), { target: { value: sheetSets.sets(PLAN.id)[1]?.id } });
  const tablePlanForm = {
    content: field("sheet-content").value,
    layout: field("sheet-layout").value,
    paper: field("sheet-paper").value,
    scaleDisabled: field("sheet-scale").disabled,
  };
  fireEvent.change(field("sheet-name"), { target: { value: "Setup crew" } });
  fireEvent.click(field("sheet-layer-obstacles"));
  fireEvent.change(field("sheet-format"), { target: { value: "svg" } });
  fireEvent.click(download);
  await screen.findByText(/^Saved 3 pages as Setup crew\.svg/u);
  fireEvent.click(screen.getByRole("button", { name: "Download all sheets" }));
  await screen.findByText(/^Saved 9 pages as all\.svg/u);

  expect(single.map(({ selection, layout, format }) => ({ selection, layout, format }))).toEqual([
    {
      selection: {
        name: "Main plan",
        content: "placements",
        layers: sheetSets.sets(PLAN.id)[0]?.layers,
      },
      layout: { kind: "tiled", paper: "a4", orientation: "auto", denominator: 1, overlapMm: 10 },
      format: "pdf",
    },
    {
      selection: {
        name: "Setup crew",
        content: "tables",
        layers: ["room", "tables", "dimensions", "table-numbers"],
      },
      layout: { kind: "fit", paper: "a3", orientation: "auto" },
      format: "svg",
    },
  ]);
  expect(note).toBe('1 character prints as "?": Ω.');
  expect(tablePlanForm).toEqual({
    content: "tables",
    layout: "fit",
    paper: "a3",
    scaleDisabled: true,
  });
  expect(all).toEqual([{ requests: single, format: "svg" }]);
  expect(downloads).toEqual(["Main plan.pdf", "Setup crew.svg", "all.svg"]);
});

it("downloads an image at the whole pixels per stud chosen as a PNG, and refuses a count past the one that draws at 1:1", async () => {
  const { single, downloads } = setUp();
  const download = screen.getByRole("button", { name: "Download sheet" });

  fireEvent.change(field("sheet-layout"), { target: { value: "image" } });
  const imageForm = {
    format: field("sheet-format").value,
    pixelsDisabled: field("sheet-pixels-per-stud").disabled,
    paperDisabled: field("sheet-paper").disabled,
  };
  fireEvent.change(field("sheet-pixels-per-stud"), { target: { value: "33" } });
  const refused = {
    single: download.hasAttribute("disabled"),
    message: screen.queryByText(/1 to 32 whole pixels per stud/u) !== null,
  };
  fireEvent.change(field("sheet-pixels-per-stud"), { target: { value: "16" } });
  fireEvent.click(download);
  const saved = await screen.findByText(/^Saved 3 pages as Main plan\.png/u);

  expect(imageForm).toEqual({ format: "png", pixelsDisabled: false, paperDisabled: true });
  expect(refused).toEqual({ single: true, message: true });
  expect(single.map(({ layout, format }) => ({ layout, format }))).toEqual([
    { layout: { kind: "image", pixelsPerStud: 16 }, format: "png" },
  ]);
  expect(saved.textContent).toBe("Saved 3 pages as Main plan.png.");
  expect(downloads).toEqual(["Main plan.png"]);
});

it("adds and deletes sheets, and refuses to download a tiling whose overlap the registration marks can't fit in", () => {
  const { sheetSets } = setUp();

  fireEvent.click(screen.getByRole("button", { name: "Add sheet" }));
  const added = { chosen: field("sheet-name").value, count: sheetSets.sets(PLAN.id).length };
  fireEvent.change(field("sheet-overlap"), { target: { value: "2" } });
  const refused = {
    single: screen.getByRole("button", { name: "Download sheet" }).hasAttribute("disabled"),
    all: screen.getByRole("button", { name: "Download all sheets" }).hasAttribute("disabled"),
    message: screen.queryByText(/registration marks fit inside it/u) !== null,
  };
  fireEvent.click(screen.getByRole("button", { name: "Delete sheet" }));

  expect(added).toEqual({ chosen: "Sheet 3", count: 3 });
  expect(refused).toEqual({ single: true, all: true, message: true });
  expect(sheetSets.sets(PLAN.id).map((set) => set.name)).toEqual(["Main plan", "Table plan"]);
  expect(field("sheet-name").value).toBe("Main plan");
});

import {
  EDITOR,
  mainThreadModules,
  type IPlanSheetService,
  type PlanRegion,
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

function select(name: string): HTMLSelectElement | HTMLInputElement {
  const element = document.querySelector(`[name="${name}"]`);
  if (!(element instanceof HTMLSelectElement || element instanceof HTMLInputElement)) {
    throw new Error(`no ${name} field`);
  }
  return element;
}

it("asks the sheets service for the layout and format the form describes, downloads the file it returns with its notes, and refuses an overlap the registration marks can't fit in", () => {
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: "unused",
      disclaimer: "unused",
      startSimWorker: () => new MessageChannel().port1,
    }),
  );
  const requests: SheetRequest[] = [];
  const sheets: IPlanSheetService = {
    printable: () => "",
    download: (_source, planId, request) => {
      requests.push(request);
      return {
        fileName: `${planId}.${request.layout.kind}.svg`,
        mimeType: "image/svg+xml",
        bytes: new TextEncoder().encode("<svg/>"),
        pages: request.layout.kind === "tiled" ? 7 : 1,
        notes: request.format === "pdf" ? ['1 character prints as "?": Ω.'] : [],
      };
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
  render(createElement(PrintSheets, { editor: container.get(EDITOR), sheets, plan: PLAN }));
  const button = screen.getByRole("button", { name: "Download sheets" });

  fireEvent.click(button);
  const tiledSaved = screen.getByText(/^Saved /u).textContent;
  const tiledNote = screen.getByText(/prints as "\?"/u).textContent;
  fireEvent.change(select("sheet-format"), { target: { value: "svg" } });
  fireEvent.change(select("sheet-layout"), { target: { value: "fit" } });
  fireEvent.change(select("sheet-paper"), { target: { value: "a3" } });
  fireEvent.change(select("sheet-orientation"), { target: { value: "landscape" } });
  const fitControls = {
    scale: select("sheet-scale").disabled,
    overlap: select("sheet-overlap").disabled,
  };
  fireEvent.click(button);
  fireEvent.change(select("sheet-layout"), { target: { value: "tiled" } });
  fireEvent.change(select("sheet-scale"), { target: { value: "5" } });
  fireEvent.change(select("sheet-overlap"), { target: { value: "2" } });

  expect(requests).toEqual([
    {
      format: "pdf",
      layout: { kind: "tiled", paper: "a4", orientation: "auto", denominator: 1, overlapMm: 10 },
    },
    { format: "svg", layout: { kind: "fit", paper: "a3", orientation: "landscape" } },
  ]);
  expect(downloads).toEqual(["plan-1.tiled.svg", "plan-1.fit.svg"]);
  expect(tiledSaved).toBe("Saved 7 pages as plan-1.tiled.svg. Print at 100% (actual size).");
  expect(tiledNote).toBe('1 character prints as "?": Ω.');
  expect(screen.queryByText(/prints as "\?"/u)).toBeNull();
  expect(fitControls).toEqual({ scale: true, overlap: true });
  expect(screen.getByText(/registration marks fit inside it/u)).toBeDefined();
  expect(button).toHaveProperty("disabled", true);
});

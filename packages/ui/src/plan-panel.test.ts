import {
  EDITOR,
  EDITOR_CAMERA,
  mainThreadModules,
  PLAN_SERVICE,
  PLAN_SHEET_SERVICE,
  SHEET_SETS,
  TABLE_LIBRARY,
} from "@brr/client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Container } from "inversify";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { PlanPanel } from "./plan-panel.tsx";

afterEach(cleanup);

function field(label: string): HTMLInputElement {
  const input = screen.getByLabelText(label);
  if (!(input instanceof HTMLInputElement)) throw new Error(`${label} is not an input`);
  return input;
}

function clientContainer(): Container {
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: "unused",
      disclaimer: "unused",
      startSimWorker: () => new MessageChannel().port1,
    }),
  );
  return container;
}

function namedField(name: string): HTMLInputElement {
  const input = document.querySelector(`input[name="${name}"]`);
  if (!(input instanceof HTMLInputElement)) throw new Error(`no field ${name}`);
  return input;
}

function addTableType(values: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(values)) {
    fireEvent.change(namedField(`new-table-type-${key}`), { target: { value } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Add table type" }));
}

function placedTexts(): Array<string | null> {
  return [...document.querySelectorAll("[data-placed]")].map((row) => row.textContent);
}

function renderPanel(container: Container): void {
  render(
    createElement(PlanPanel, {
      camera: container.get(EDITOR_CAMERA),
      editor: container.get(EDITOR),
      drawing: false,
      held: null,
      fillGridStuds: 8,
      plans: container.get(PLAN_SERVICE),
      sheets: container.get(PLAN_SHEET_SERVICE),
      sheetSets: container.get(SHEET_SETS),
      ready: true,
      readOnly: false,
      library: container.get(TABLE_LIBRARY),
      armedType: null,
    }),
  );
}

it("commits a typed table size on Enter or blur, keeps the typed text while the size changes underneath, and Escape puts it back", () => {
  const container = clientContainer();
  const plans = container.get(PLAN_SERVICE);
  const { planId, tableId } = plans.drawTable({ minX: 0, minZ: 0, maxX: 1280, maxZ: 640 });
  let edits = 0;
  plans.onEdit(() => edits++);
  renderPanel(container);
  const table = () => plans.plans()[0]?.footprint.tables[0];
  const seen = () => ({
    edits,
    widthMm: table()?.rect.width,
    depthMm: table()?.rect.depth,
    heightMm: table()?.heightMm,
    fields: ["Width in studs", "Width in cm", "Depth in cm", "Height in cm"].map(
      (label) => field(label).value,
    ),
  });
  const steps = [seen()];

  fireEvent.change(field("Width in studs"), { target: { value: "80" } });
  act(() => plans.placeTable(planId, tableId, { minX: 0, minZ: 0, maxX: 960, maxZ: 640 }));
  steps.push(seen());
  fireEvent.keyDown(field("Width in studs"), { key: "Enter" });
  steps.push(seen());
  fireEvent.change(field("Depth in cm"), { target: { value: "99" } });
  fireEvent.keyDown(field("Depth in cm"), { key: "Escape" });
  fireEvent.blur(field("Depth in cm"));
  steps.push(seen());
  fireEvent.change(field("Height in cm"), { target: { value: "90" } });
  fireEvent.blur(field("Height in cm"));
  fireEvent.blur(field("Width in cm"));
  steps.push(seen());

  expect(steps).toEqual([
    { edits: 0, widthMm: 512, depthMm: 256, heightMm: 750, fields: ["64", "51.2", "25.6", "75"] },
    { edits: 1, widthMm: 384, depthMm: 256, heightMm: 750, fields: ["80", "38.4", "25.6", "75"] },
    { edits: 2, widthMm: 640, depthMm: 256, heightMm: 750, fields: ["80", "64", "25.6", "75"] },
    { edits: 2, widthMm: 640, depthMm: 256, heightMm: 750, fields: ["80", "64", "25.6", "75"] },
    { edits: 3, widthMm: 640, depthMm: 256, heightMm: 900, fields: ["80", "64", "25.6", "90"] },
  ]);
});

it("adds a table type from its form, names the field it refuses, counts the active plan's tables of each type against those owned, and keeps a library table's size to its type", () => {
  const container = clientContainer();
  const plans = container.get(PLAN_SERVICE);
  const library = container.get(TABLE_LIBRARY);
  renderPanel(container);
  addTableType({ name: "Club 6ft", widthMm: "1830", depthMm: "760.5", owned: "2" });
  const refused = { alert: screen.getByRole("alert").textContent, types: library.types().length };
  addTableType({ depthMm: "760" });
  const added = library.types();
  const typeId = added[0]?.id ?? -1;
  act(() => {
    library.place(typeId, 0, 0, 0);
    library.place(typeId, 1, 4800, 0);
    library.place(typeId, 0, 0, 2400);
  });
  const placed = placedTexts();
  const shortClass = document.querySelector("[data-placed]")?.className;
  const sizes = [...document.querySelectorAll("[data-table-size]")].map((row) => row.textContent);
  const widthFields = screen.queryAllByLabelText("Width in studs").length;
  act(() => {
    library.updateType(typeId, { owned: 3 });
  });

  expect(refused).toEqual({
    alert: "Depth must be an integer",
    types: 0,
  });
  expect(added).toEqual([
    {
      id: 0,
      name: "Club 6ft",
      widthMm: 1830,
      depthMm: 760,
      heightMm: 750,
      color: "#b58b5a",
      owned: 2,
    },
  ]);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(placed).toEqual(["3 placed, 1 more than the 2 owned"]);
  expect(shortClass).toBe("plan-warnings");
  expect(sizes).toEqual([
    "1830 × 760 mm, 750 mm high, from its type Club 6ft",
    "760 × 1830 mm, 750 mm high, from its type Club 6ft",
    "1830 × 760 mm, 750 mm high, from its type Club 6ft",
  ]);
  expect(widthFields).toBe(0);
  expect(placedTexts()).toEqual(["3 of 3 owned placed in this plan"]);
  expect(plans.plans()[0]?.footprint.tables.map((table) => table.number)).toEqual([1, 2, 3]);
});

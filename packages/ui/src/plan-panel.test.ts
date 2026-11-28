import {
  EDITOR,
  EDITOR_CAMERA,
  mainThreadModules,
  PLAN_SERVICE,
  PLAN_SHEET_SERVICE,
  SHEET_SETS,
  UNDERLAY_SERVICE,
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
  fireEvent.submit(screen.getByRole("form", { name: "New table type" }));
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
      underlay: container.get(UNDERLAY_SERVICE),
      ready: true,
      readOnly: false,
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

it("names the field a new table type is refused for, and keeps a library table's size and height to its type while it still moves", () => {
  const container = clientContainer();
  const plans = container.get(PLAN_SERVICE);
  renderPanel(container);

  addTableType({ name: "Club 6ft", widthMm: "1830", depthMm: "760.5" });
  const refused = { alert: screen.getByRole("alert").textContent, types: plans.tableTypes() };
  addTableType({ depthMm: "760" });
  const typeId = plans.tableTypes()[0]?.id ?? -1;
  act(() => {
    plans.drawTable({ minX: 0, minZ: 0, maxX: 4575, maxZ: 1900 }, typeId);
  });

  expect(refused).toEqual({ alert: "Depth mm must be an integer", types: [] });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    ["Width in studs", "Depth in cm", "Height in cm", "From left wall in studs"].map(
      (label) => field(label).closest("fieldset[disabled]") !== null,
    ),
  ).toEqual([true, true, true, false]);
});

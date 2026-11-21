import {
  EDITOR,
  EDITOR_CAMERA,
  mainThreadModules,
  PLAN_SERVICE,
  PLAN_SHEET_SERVICE,
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

it("commits a typed table size on Enter or blur, keeps the typed text while the size changes underneath, and Escape puts it back", () => {
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: "unused",
      disclaimer: "unused",
      startSimWorker: () => new MessageChannel().port1,
    }),
  );
  const plans = container.get(PLAN_SERVICE);
  const { planId, tableId } = plans.drawTable({ minX: 0, minZ: 0, maxX: 1280, maxZ: 640 });
  let edits = 0;
  plans.onEdit(() => edits++);
  render(
    createElement(PlanPanel, {
      camera: container.get(EDITOR_CAMERA),
      editor: container.get(EDITOR),
      drawing: false,
      held: null,
      fillGridStuds: 8,
      plans,
      sheets: container.get(PLAN_SHEET_SERVICE),
      ready: true,
      readOnly: false,
    }),
  );
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

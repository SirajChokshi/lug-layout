import { EDITOR, LAYER_SERVICE, mainThreadModules } from "@brr/client";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Container } from "inversify";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { LayersPanel } from "./layers-panel.tsx";

afterEach(cleanup);

function services() {
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: "unused",
      disclaimer: "unused",
      startSimWorker: () => new MessageChannel().port1,
    }),
  );
  return { editor: container.get(EDITOR), layers: container.get(LAYER_SERVICE) };
}

function listed(): ReadonlyArray<string> {
  const list = screen.getByRole("list", { name: "Layers, top first" });
  return within(list)
    .getAllByRole("listitem")
    .map((row) => {
      const name = row.querySelector(".layer-name-text")?.textContent ?? "";
      const flags = [
        row.hasAttribute("data-active") ? "active" : null,
        row.hasAttribute("data-hidden") ? "hidden" : null,
        row.hasAttribute("data-locked") ? "locked" : null,
      ].filter((flag) => flag !== null);
      return [name, ...flags].join(" ");
    });
}

function press(name: string): void {
  fireEvent.click(screen.getByRole("button", { name }));
}

function disabled(name: string): boolean {
  return screen.getByRole("button", { name }).hasAttribute("disabled");
}

function typeOpacity(percent: string): void {
  const opacity = screen.getByRole("spinbutton", { name: /Opacity/u });
  fireEvent.change(opacity, { target: { value: percent } });
  fireEvent.keyDown(opacity, { key: "Enter" });
}

it("names a new layer as it's made, toggles, fades and reorders the layer it's on with the list drawn top first, puts new parts on a clicked layer, removes only an unlocked layer other than the base one, and edits no layer in a read-only tab", () => {
  const { editor, layers } = services();
  const panel = (readOnly: boolean) =>
    createElement(LayersPanel, { editor, layers, contents: new Map(), readOnly });
  const { rerender } = render(panel(false));
  const steps: Array<ReadonlyArray<string>> = [];

  press("New layer");
  const naming = screen.getByRole("textbox", { name: 'Rename layer "Layer 1"' });
  fireEvent.change(naming, { target: { value: "Track" } });
  fireEvent.keyDown(naming, { key: "Enter" });
  steps.push(listed());
  press('Show "Track"');
  press('Lock "Track"');
  typeOpacity("40");
  const faded = layers.table().layer(1)?.opacity;
  typeOpacity("150");
  const refusal = screen.getByRole("alert").textContent;
  press("Move layer down");
  steps.push(listed());
  const atBottom = { down: disabled("Move layer down"), remove: disabled("Remove") };
  fireEvent.click(within(screen.getByRole("list")).getByText("Parts"));
  steps.push(listed());
  const baseRemove = disabled("Remove");
  press('Lock "Track"');
  fireEvent.click(within(screen.getByRole("list")).getByText("Track"));
  press("Move layer up");
  steps.push(listed());
  press("Remove");
  steps.push(listed());
  press("New layer");
  fireEvent.keyDown(screen.getByRole("textbox", { name: /^Rename layer/u }), { key: "Escape" });
  rerender(panel(true));
  const readOnly = {
    edits: ['Show "Layer 1"', 'Lock "Layer 1"', "Move layer down", "Remove", "New layer"].map(
      disabled,
    ),
    opacity: screen.getByRole("spinbutton", { name: /Opacity/u }).hasAttribute("disabled"),
    selectAll: disabled("Select all"),
  };
  fireEvent.doubleClick(within(screen.getByRole("list")).getByText("Layer 1"));
  fireEvent.click(within(screen.getByRole("list")).getByText("Parts"));
  const pickedReadOnly = { renaming: screen.queryAllByRole("textbox").length, list: listed() };

  expect({ steps, faded, refusal, atBottom, baseRemove, readOnly, pickedReadOnly }).toEqual({
    steps: [
      ["Track active", "Parts"],
      ["Parts", "Track active hidden locked"],
      ["Parts active", "Track hidden locked"],
      ["Track active hidden", "Parts"],
      ["Parts active"],
    ],
    faded: 40,
    refusal: "Opacity must be a percentage 0-100.",
    atBottom: { down: true, remove: true },
    baseRemove: true,
    readOnly: { edits: [true, true, true, true, true], opacity: true, selectAll: false },
    pickedReadOnly: { renaming: 0, list: ["Layer 1", "Parts active"] },
  });
});

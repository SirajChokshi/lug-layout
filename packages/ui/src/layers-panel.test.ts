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

it("names a new layer as it's made, toggles, fades and reorders the layer it's on with the list drawn top first, puts new parts on a clicked layer, and says why a layer can't go", () => {
  const { editor, layers } = services();
  render(createElement(LayersPanel, { editor, layers, contents: new Map() }));
  const steps: Array<ReadonlyArray<string>> = [];

  press("New layer");
  const naming = screen.getByRole("textbox", { name: 'Rename layer "Layer 1"' });
  fireEvent.change(naming, { target: { value: "Track" } });
  fireEvent.keyDown(naming, { key: "Enter" });
  steps.push(listed());
  press('Show "Track"');
  press('Lock "Track"');
  const opacity = screen.getByRole("spinbutton", { name: /Opacity/u });
  fireEvent.change(opacity, { target: { value: "40" } });
  fireEvent.keyDown(opacity, { key: "Enter" });
  const faded = layers.table().layer(1)?.opacity;
  press("Move layer down");
  steps.push(listed());
  const downAtBottom = screen
    .getByRole("button", { name: "Move layer down" })
    .hasAttribute("disabled");
  press("Remove");
  const refusal = screen.getByRole("alert").textContent;
  fireEvent.click(within(screen.getByRole("list")).getByText("Parts"));
  steps.push(listed());
  press('Lock "Track"');
  fireEvent.click(within(screen.getByRole("list")).getByText("Track"));
  press("Move layer up");
  steps.push(listed());
  press("Remove");
  steps.push(listed());

  expect({ steps, downAtBottom, refusal, faded }).toEqual({
    steps: [
      ["Track active", "Parts"],
      ["Parts", "Track active hidden locked"],
      ["Parts active", "Track hidden locked"],
      ["Track active hidden", "Parts"],
      ["Parts active"],
    ],
    downAtBottom: true,
    refusal: '"Track" is locked; unlock it before removing it.',
    faded: 40,
  });
});

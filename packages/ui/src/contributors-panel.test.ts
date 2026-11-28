import { CONTRIBUTOR_SERVICE, EDITOR, mainThreadModules } from "@brr/client";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Container } from "inversify";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { ContributorsPanel } from "./contributors-panel.tsx";

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
  return { editor: container.get(EDITOR), contributors: container.get(CONTRIBUTOR_SERVICE) };
}

it("names a new contributor as it's made, records a colour once the picker commits it rather than while it moves, switches colouring by contributor, and removes the picked contributor", () => {
  const { editor, contributors } = services();
  const edits: string[] = [];
  contributors.onEdit((change) => edits.push(change.action));
  render(createElement(ContributorsPanel, { editor, contributors, contents: new Map() }));

  fireEvent.click(screen.getByRole("button", { name: "New contributor" }));
  const naming = screen.getByRole("textbox", { name: 'Rename contributor "Contributor 1"' });
  fireEvent.change(naming, { target: { value: "Ada" } });
  fireEvent.keyDown(naming, { key: "Enter" });
  const swatch = screen.getByLabelText('Colour of "Ada"');
  fireEvent.input(swatch, { target: { value: "#00ff00" } });
  const whileMoving = [...edits];
  fireEvent.change(swatch, { target: { value: "#00ff00" } });
  const committed = contributors.roster().map(({ name, color }) => [name, color]);
  fireEvent.click(screen.getByRole("checkbox", { name: "Colour by contributor" }));
  const coloured = contributors.coloured();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));

  expect({ whileMoving, committed, coloured, edits, roster: contributors.roster() }).toEqual({
    whileMoving: ["add", "rename"],
    committed: [["Ada", "#00ff00"]],
    coloured: true,
    edits: ["add", "rename", "recolour", "remove"],
    roster: [],
  });
});

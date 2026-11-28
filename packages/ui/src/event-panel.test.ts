import { EDITOR, EVENT_DETAILS, LAYOUT_SIZE, mainThreadModules } from "@brr/client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Container } from "inversify";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { EventPanel } from "./event-panel.tsx";

afterEach(cleanup);

function field(label: string): HTMLInputElement {
  const input = screen.getByLabelText(label);
  if (!(input instanceof HTMLInputElement)) throw new Error(`${label} is not an input`);
  return input;
}

function apply(): HTMLButtonElement {
  const button = screen.getByRole("button", { name: "Apply" });
  if (!(button instanceof HTMLButtonElement)) throw new Error("Apply is not a button");
  return button;
}

it("applies typed details as one undo step, holds Apply while a field has an issue, and shows the stored details again after undo", () => {
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: "unused",
      disclaimer: "unused",
      startSimWorker: () => new MessageChannel().port1,
    }),
  );
  const editor = container.get(EDITOR);
  const events = container.get(EVENT_DETAILS);
  const { container: root } = render(
    createElement(EventPanel, { events, size: container.get(LAYOUT_SIZE), editable: true }),
  );
  const details = root.querySelector("details");
  if (!details) throw new Error("the panel has no details element");
  details.open = true;
  fireEvent(details, new Event("toggle"));

  expect(screen.getByText("Nothing placed yet.")).toBeTruthy();
  fireEvent.change(field("Title"), { target: { value: "Brickworld 2027" } });
  fireEvent.change(field("Start date"), { target: { value: "2027-06-20" } });
  fireEvent.change(field("End date"), { target: { value: "2027-06-18" } });
  const blocked = {
    issue: screen.getByRole("alert").textContent,
    applyDisabled: apply().disabled,
    event: events.event(),
  };
  fireEvent.change(field("End date"), { target: { value: "2027-06-22" } });
  fireEvent.click(apply());
  const applied = {
    event: events.event(),
    undo: editor.snapshot().history.undo,
    glance: details.querySelector(".event-glance")?.textContent,
    applyDisabled: apply().disabled,
  };
  act(() => editor.undo(0));

  expect({ blocked, applied, title: field("Title").value, event: events.event() }).toEqual({
    blocked: {
      issue: "End date comes before the start date.",
      applyDisabled: true,
      event: null,
    },
    applied: {
      event: { title: "Brickworld 2027", startDate: "2027-06-20", endDate: "2027-06-22" },
      undo: "event",
      glance: "Brickworld 2027",
      applyDisabled: true,
    },
    title: "",
    event: null,
  });
});

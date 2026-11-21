import {
  EDITOR,
  mainThreadModules,
  TRACK_ITEM_ID,
  TRAIN_PLAY,
  type EditorActionId,
  type EditorSnapshot,
  type IEditor,
  type PlaySnapshot,
  type ModelSelectionView,
} from "@brr/client";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Container } from "inversify";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { PlacementToolbar, SelectionPanel } from "./editor-panels.tsx";

afterEach(cleanup);

const EDITING_BUTTONS = [/^Draw track/u, /^Draw road/u, /^Rotate/u, /^Delete/u, /^Undo/u, /^Redo/u];
const PLAY_SAFE_BUTTONS = [/^Select/u, /^Find/u, /^Shortcuts/u];

const SELECTED: ModelSelectionView = {
  kind: "model",
  item: "ldraw:3811",
  yPlates: 0,
  rot: 0,
  box: { minX: 0, minY: 0, minZ: 0, maxX: 640, maxY: 8, maxZ: 640 },
};

function services(): { readonly editor: IEditor; readonly play: PlaySnapshot } {
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: "unused",
      disclaimer: "unused",
      startSimWorker: () => new MessageChannel().port1,
    }),
  );
  return { editor: container.get(EDITOR), play: container.get(TRAIN_PLAY).snapshot() };
}

function editableSnapshot(editor: IEditor): EditorSnapshot {
  return {
    ...editor.snapshot(),
    status: "ready",
    readOnly: false,
    mode: "place",
    selection: {
      primary: SELECTED,
      members: [SELECTED],
      box: SELECTED.box,
      tally: { models: 1, pieces: 0, trains: 0 },
      movable: true,
      pivotStuds: { x: 0, z: 0 },
    },
    history: {
      undo: "place",
      redo: "place",
      undoLabel: "place",
      redoLabel: "place",
      undoDepth: 1,
      redoDepth: 1,
    },
    catalog: [
      {
        id: TRACK_ITEM_ID,
        label: "Track",
        group: "track",
        shortLabel: "Track",
        groupLabel: "Track",
        color: null,
        kind: "track",
        parts: 1,
        studsWide: 0,
        studsDeep: 0,
        thumbnail: null,
        aliases: [],
        elements: [],
        displayColor: false,
        draggable: false,
        toggleable: true,
        listedUnder: null,
        customParts: 0,
      },
    ],
    roadKit: "road",
  };
}

function disabledStates(names: ReadonlyArray<RegExp>): ReadonlyArray<boolean> {
  return names.map((name) => screen.getByRole("button", { name }).hasAttribute("disabled"));
}

it("disables the toolbar's editing buttons while a train runs, as the keys are", () => {
  const { editor, play } = services();
  const snapshot = editableSnapshot(editor);
  const toolbar = (status: PlaySnapshot["status"]) =>
    createElement(PlacementToolbar, {
      editor,
      snapshot,
      play: { ...play, status },
      onEditorAction: () => {},
      onShellCommand: () => {},
    });

  const { rerender } = render(toolbar("idle"));
  expect(disabledStates(EDITING_BUTTONS)).toEqual(EDITING_BUTTONS.map(() => false));

  rerender(toolbar("running"));
  expect(disabledStates(EDITING_BUTTONS)).toEqual(EDITING_BUTTONS.map(() => true));
  expect(disabledStates(PLAY_SAFE_BUTTONS)).toEqual(PLAY_SAFE_BUTTONS.map(() => false));
});

it("runs the client's draw-track and draw-road commands from the toolbar's draw buttons", () => {
  const { editor, play } = services();
  const ran: EditorActionId[] = [];
  render(
    createElement(PlacementToolbar, {
      editor,
      snapshot: editableSnapshot(editor),
      play,
      onEditorAction: (id) => ran.push(id),
      onShellCommand: () => {},
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: /^Draw track/u }));
  fireEvent.click(screen.getByRole("button", { name: /^Draw road/u }));
  expect(ran).toEqual(["draw-track", "draw-road"]);
});

function panelOffers() {
  return {
    fields: ["X studs", "Z studs"].map(
      (label) => !screen.getByLabelText(label).hasAttribute("disabled"),
    ),
    rotations: screen
      .getAllByRole("button", { name: /^(?:\d+°$|Turn)/u })
      .map((button) => !button.hasAttribute("disabled")),
    actions: [/^Copy/u, /^Frame/u, /^Delete/u].map(
      (name) => !screen.getByRole("button", { name }).hasAttribute("disabled"),
    ),
  };
}

it("offers the selection panel's position and rotation only when the arrows could move the selection, not while a train runs, the world is read-only or a drag is in hand", () => {
  const { editor, play } = services();
  const selecting = { ...editableSnapshot(editor), mode: "select" as const };
  const panel = (snapshot: EditorSnapshot, status: PlaySnapshot["status"]) =>
    createElement(SelectionPanel, {
      editor,
      snapshot,
      play: { ...play, status },
      onEditorAction: () => {},
    });

  const { rerender } = render(panel(selecting, "idle"));
  const editable = panelOffers();
  rerender(panel(selecting, "running"));
  const running = panelOffers();
  rerender(panel({ ...selecting, readOnly: true }, "idle"));
  const readOnly = panelOffers();
  rerender(
    panel(
      {
        ...selecting,
        gesture: { kind: "move", dx: 0, dz: 0, refusal: null, models: 1, pieces: 0, trains: 0 },
      },
      "idle",
    ),
  );
  const dragging = panelOffers();
  const grouped = {
    ...selecting,
    selection: {
      primary: SELECTED,
      members: [SELECTED, SELECTED],
      box: SELECTED.box,
      tally: { models: 2, pieces: 0, trains: 0 },
      movable: true,
      pivotStuds: { x: 0, z: 0 },
    },
  };
  rerender(panel(grouped, "idle"));
  const group = panelOffers();
  rerender(
    panel(
      {
        ...grouped,
        gesture: { kind: "move", dx: 0, dz: 0, refusal: null, models: 2, pieces: 0, trains: 0 },
      },
      "idle",
    ),
  );
  const groupDragging = panelOffers();

  expect({ editable, running, readOnly, dragging, group, groupDragging }).toEqual({
    editable: {
      fields: [true, true],
      rotations: [true, true, true, true],
      actions: [true, true, true],
    },
    running: {
      fields: [false, false],
      rotations: [false, false, false, false],
      actions: [false, true, false],
    },
    readOnly: {
      fields: [false, false],
      rotations: [false, false, false, false],
      actions: [true, true, false],
    },
    dragging: {
      fields: [false, false],
      rotations: [false, false, false, false],
      actions: [true, true, false],
    },
    group: { fields: [true, true], rotations: [true, true], actions: [true, true, true] },
    groupDragging: {
      fields: [false, false],
      rotations: [false, false],
      actions: [true, true, false],
    },
  });
});

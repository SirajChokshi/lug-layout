import {
  EDITOR,
  mainThreadModules,
  TRACK_ITEM_ID,
  TRAIN_PLAY,
  type EditorSnapshot,
  type IEditor,
  type PlaySnapshot,
} from "@brr/client";
import { cleanup, render, screen } from "@testing-library/react";
import { Container } from "inversify";
import { createElement } from "react";
import { afterEach, expect, it } from "vitest";
import { PlacementToolbar } from "./editor-panels.tsx";

afterEach(cleanup);

const EDITING_BUTTONS = [/^Draw track/u, /^Draw road/u, /^Rotate/u, /^Delete/u, /^Undo/u, /^Redo/u];
const PLAY_SAFE_BUTTONS = [/^Select/u, /^Find/u, /^Shortcuts/u];

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
      item: "ldraw:3811",
      x: 0,
      z: 0,
      yPlates: 0,
      rot: 0,
      chunkKey: 0,
      slot: 0,
      box: { minX: 0, minY: 0, minZ: 0, maxX: 640, maxY: 8, maxZ: 640 },
      baseplate: null,
    },
    history: { undo: "place", redo: "place", undoDepth: 1, redoDepth: 1 },
    catalog: [
      {
        id: TRACK_ITEM_ID,
        label: "Track",
        group: "track",
        groupLabel: "Track",
        color: null,
        kind: "track",
        parts: 1,
        studsWide: 0,
        studsDeep: 0,
        thumbnail: null,
        baseplate: null,
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
      onShellCommand: () => {},
    });

  const { rerender } = render(toolbar("idle"));
  expect(disabledStates(EDITING_BUTTONS)).toEqual(EDITING_BUTTONS.map(() => false));

  rerender(toolbar("running"));
  expect(disabledStates(EDITING_BUTTONS)).toEqual(EDITING_BUTTONS.map(() => true));
  expect(disabledStates(PLAY_SAFE_BUTTONS)).toEqual(PLAY_SAFE_BUTTONS.map(() => false));
});

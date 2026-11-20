import {
  EDITOR,
  EDITOR_CAMERA,
  mainThreadModules,
  PALETTE_DRAG,
  TRAIN_PLAY,
  type EditorOptions,
} from "@brr/client";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Container } from "inversify";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { ShellCommandId } from "@brr/client";
import { EditorCanvas } from "./editor-canvas.tsx";
import { RoadJoins } from "./editor-panels.tsx";
import { useEditorSnapshot } from "./use-editor.ts";
import { controlTakesKey, useEditorKeys } from "./use-editor-keys.ts";

afterEach(cleanup);

const CANVAS_OPTIONS: EditorOptions = {
  api: "webgl2",
  pixelRatio: 1,
  look: { plastic: false, gtao: false, outlines: false, bevel: false, shadows: false, oit: false },
  tier: null,
};

function services() {
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: "unused",
      disclaimer: "unused",
      startSimWorker: () => new MessageChannel().port1,
    }),
  );
  return {
    editor: container.get(EDITOR),
    camera: container.get(EDITOR_CAMERA),
    play: container.get(TRAIN_PLAY),
    paletteDrag: container.get(PALETTE_DRAG),
  };
}

function hold(key: string, held: KeyboardEventInit, repeats: number): void {
  for (let i = 0; i <= repeats; i++) {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        repeat: i > 0,
        ...held,
      }),
    );
  }
}

function element(html: string): Element {
  document.body.innerHTML = html;
  const first = document.body.firstElementChild;
  if (!first) throw new Error(`no element in ${html}`);
  return first;
}

function RoadJoinsWithKeys({
  onShellCommand = () => {},
}: {
  readonly onShellCommand?: (id: ShellCommandId) => void;
}) {
  const { editor, camera, play, paletteDrag } = services();
  function Panel() {
    const snapshot = useEditorSnapshot(editor);
    useEditorKeys(editor, camera, {
      play,
      onShellCommand,
      overlayOpen: false,
      closeOverlay: () => {},
    });
    return createElement(
      "div",
      null,
      createElement(EditorCanvas, { editor, camera, play, paletteDrag, options: CANVAS_OPTIONS }),
      createElement(RoadJoins, { editor, snapshot }),
    );
  }
  return createElement(Panel);
}

describe("editor keys and focused controls", () => {
  it("lets Space toggle the Road joins checkboxes while the editor canvas and keys are mounted", async () => {
    const user = userEvent.setup();
    render(createElement(RoadJoinsWithKeys));
    for (const name of [/show join markers/iu, /snap road pieces/iu]) {
      const box = screen.getByRole<HTMLInputElement>("checkbox", { name });
      const before = box.checked;
      box.focus();
      await user.keyboard(" ");
      expect(box.checked).toBe(!before);
    }
  });

  it("opens a dialog once for a held ? or Ctrl+K, however many times the key repeats", () => {
    const opened: ShellCommandId[] = [];
    render(createElement(RoadJoinsWithKeys, { onShellCommand: (id) => opened.push(id) }));
    hold("?", { shiftKey: true }, 5);
    hold("k", { ctrlKey: true }, 4);
    expect(opened).toEqual(["show-shortcuts", "open-palette"]);
  });

  it("leaves Space to buttons, checkboxes and summaries, and arrows to sliders", () => {
    expect(controlTakesKey(element('<input type="checkbox">'), " ")).toBe(true);
    expect(controlTakesKey(element("<button>Go</button>"), " ")).toBe(true);
    expect(controlTakesKey(element("<summary>Road joins</summary>"), " ")).toBe(true);
    expect(controlTakesKey(element('<input type="range">'), "ArrowLeft")).toBe(true);
    expect(controlTakesKey(element("<button>Go</button>"), "ArrowLeft")).toBe(false);
    expect(controlTakesKey(element("<canvas></canvas>"), " ")).toBe(false);
    expect(controlTakesKey(document.body, " ")).toBe(false);
  });
});

function KeysOnly() {
  const { editor, camera, play } = services();
  function Keys() {
    useEditorKeys(editor, camera, {
      play,
      onShellCommand: () => {},
      overlayOpen: false,
      closeOverlay: () => {},
    });
    return createElement("span", {
      "data-override": String(editor.snapshot().placementModeOverride),
    });
  }
  return { editor, keys: createElement(Keys) };
}

function send(type: string, init: KeyboardEventInit): void {
  document.body.dispatchEvent(
    new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }),
  );
}

function movePointer(init: MouseEventInit): void {
  document.body.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, ...init }));
}

describe("holding Alt for the other placement mode", () => {
  it("flips the mode while Alt is held, never for AltGr, keeps a held Alt through a pointer that lost it, and releases on keyup or blur", () => {
    const { editor, keys } = KeysOnly();
    render(keys);
    const held = (): boolean => editor.snapshot().placementModeOverride;
    send("keydown", { key: "Alt", altKey: true });
    const altDown = held();
    movePointer({ altKey: false });
    const pointerLostAlt = held();
    send("keyup", { key: "Alt" });
    const released = held();
    send("keydown", { key: "AltGraph", altKey: true, ctrlKey: true });
    movePointer({ altKey: true, ctrlKey: true });
    const altGraph = held();
    send("keyup", { key: "AltGraph" });
    movePointer({ altKey: true });
    const pointerWithAlt = held();
    window.dispatchEvent(new Event("blur"));

    expect({
      altDown,
      pointerLostAlt,
      released,
      altGraph,
      pointerWithAlt,
      blurred: held(),
    }).toEqual({
      altDown: true,
      pointerLostAlt: true,
      released: false,
      altGraph: false,
      pointerWithAlt: true,
      blurred: false,
    });
  });
});

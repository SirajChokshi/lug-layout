import {
  EDITOR,
  EDITOR_CAMERA,
  mainThreadModules,
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
  const { editor, camera, play } = services();
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
      createElement(EditorCanvas, { editor, camera, play, options: CANVAS_OPTIONS }),
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

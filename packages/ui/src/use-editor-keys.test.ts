import { EDITOR, mainThreadModules, TRAIN_PLAY } from "@brr/client";
import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { Container } from "inversify";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { RoadJoins } from "./editor-panels.tsx";
import { useEditorSnapshot } from "./use-editor.ts";
import { controlTakesKey, useEditorKeys } from "./use-editor-keys.ts";

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
  return { editor: container.get(EDITOR), play: container.get(TRAIN_PLAY) };
}

function element(html: string): Element {
  document.body.innerHTML = html;
  const first = document.body.firstElementChild;
  if (!first) throw new Error(`no element in ${html}`);
  return first;
}

function RoadJoinsWithKeys() {
  const { editor, play } = services();
  function Panel() {
    const snapshot = useEditorSnapshot(editor);
    useEditorKeys(editor, {
      play,
      onShellCommand: () => {},
      overlayOpen: false,
      closeOverlay: () => {},
    });
    return createElement(RoadJoins, { editor, snapshot });
  }
  return createElement(Panel);
}

describe("editor keys and focused controls", () => {
  it("lets Space toggle the Road joins checkboxes while the editor's keys are bound", async () => {
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

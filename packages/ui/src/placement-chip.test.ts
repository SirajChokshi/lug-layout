import {
  EDITOR,
  mainThreadModules,
  TRAIN_PLAY,
  type EditorSnapshot,
  type PlacementHover,
} from "@brr/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Container } from "inversify";
import { createElement, Fragment } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { PlacementChip } from "./placement-chip.tsx";
import { ToolHud } from "./tool-hud.tsx";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PENDING_CUE_MS = 150;

const REFUSED: Omit<PlacementHover, "settled"> = {
  pose: { x: 0, z: 0, yPlates: 0, rot: 0 },
  accepted: false,
  hit: {
    placed: {
      item: "custom:pinned",
      label: "custom-modular-pinned.ldr",
      pose: { x: -320, z: 0, yPlates: 0, rot: 0 },
    },
    part: "ldraw:3867",
    partLabel: "Baseplate 16 x 16",
    cellX: -11,
    cellZ: -8,
    placedBottomLdu: -4,
    placedTopLdu: 0,
    heldBottomLdu: -4,
    heldTopLdu: 0,
    byColumnOnly: false,
  },
  mates: [],
  lifted: false,
  restsOn: [],
  turnBlocksSnap: false,
  turnMates: [],
  mode: "assist",
  magnetised: false,
  magnet: { dxLdu: 0, dzLdu: 0, dyPlates: 0, distanceLdu: 0 },
  assistNeighbourhood: { ldu: 40, cells: 2, plates: 2 },
};

function holding(settled: boolean) {
  const container = new Container();
  container.load(
    ...mainThreadModules({
      bundleBaseUrl: "unused",
      disclaimer: "unused",
      startSimWorker: () => new MessageChannel().port1,
    }),
  );
  const editor = container.get(EDITOR);
  const play = container.get(TRAIN_PLAY).snapshot();
  const snapshot = (isSettled: boolean): EditorSnapshot => ({
    ...editor.snapshot(),
    status: "ready",
    mode: "place",
    hover: {
      x: 0,
      z: 0,
      yPlates: 0,
      refusal: "custom-modular-holes.ldr would hit Baseplate 16 x 16",
      placement: { ...REFUSED, settled: isSettled },
    },
  });
  const view = (isSettled: boolean) =>
    createElement(
      Fragment,
      null,
      createElement(ToolHud, { snapshot: snapshot(isSettled), play }),
      createElement(PlacementChip, { snapshot: snapshot(isSettled) }),
    );
  return { view, first: view(settled) };
}

it("holds the live hint and shows a searching cue only after a beat while an assist search is unsettled, then states the settled refusal", () => {
  vi.useFakeTimers();
  const { view, first } = holding(false);
  const { container, rerender } = render(first);
  const hud = screen.getByRole("status");
  const chip = (): HTMLElement | null => container.querySelector(".placement-chip");
  const shown = () => ({
    busy: hud.getAttribute("aria-busy"),
    tone: hud.getAttribute("data-tone"),
    hint: hud.textContent?.includes("Hits") ?? false,
    chip: chip()?.hidden === false ? chip()?.textContent : null,
  });
  const atOnce = shown();
  act(() => {
    vi.advanceTimersByTime(PENDING_CUE_MS);
  });
  const afterBeat = shown();
  rerender(view(true));

  expect({ atOnce, afterBeat, settled: shown() }).toEqual({
    atOnce: { busy: "true", tone: "place", hint: false, chip: null },
    afterBeat: { busy: "true", tone: "place", hint: false, chip: "Finding a fit…" },
    settled: {
      busy: "false",
      tone: "warn",
      hint: true,
      chip: "Hits Baseplate 16 x 16 in custom-modular-pinned.ldr at cell (-11, -8)",
    },
  });
});

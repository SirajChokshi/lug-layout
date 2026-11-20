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

const REFUSED: Omit<PlacementHover, "settled" | "turnSettled"> = {
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
      placement: { ...REFUSED, settled: isSettled, turnSettled: isSettled },
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

function turnScene() {
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
  const hovering = (x: number, turnSettled: boolean, turnBlocksSnap: boolean): EditorSnapshot => ({
    ...editor.snapshot(),
    status: "ready",
    mode: "place",
    hover: {
      x,
      z: 0,
      yPlates: 0,
      refusal: null,
      placement: {
        ...REFUSED,
        pose: { x, z: 0, yPlates: 0, rot: 0 },
        accepted: true,
        hit: null,
        settled: true,
        turnSettled,
        turnBlocksSnap,
        turnMates: [],
      },
    },
  });
  const view = (x: number, turnSettled: boolean, turnBlocksSnap: boolean) =>
    createElement(ToolHud, { snapshot: hovering(x, turnSettled, turnBlocksSnap), play });
  return { view };
}

function liveUpdates(region: Element): () => number {
  let updates = 0;
  const observer = new MutationObserver((records) => {
    updates += records.length;
  });
  observer.observe(region, { childList: true, subtree: true, characterData: true });
  return () => {
    const seen = updates + observer.takeRecords().length;
    updates = 0;
    return seen;
  };
}

const TURN_LINE = "Turn it to snap here";

it.each([
  {
    name: "announces a late turn hint for the same hover once, and never again while it holds",
    steps: [
      { x: 0, turnSettled: true, turnBlocksSnap: true },
      { x: 0, turnSettled: true, turnBlocksSnap: true },
    ],
    expected: [
      { said: true, updated: true },
      { said: true, updated: false },
    ],
  },
  {
    name: "never surfaces a moved-from hover's pending turn hint, and announces the new hover's own once",
    steps: [
      { x: 20, turnSettled: false, turnBlocksSnap: false },
      { x: 20, turnSettled: true, turnBlocksSnap: true },
    ],
    expected: [
      { said: false, updated: false },
      { said: true, updated: true },
    ],
  },
  {
    name: "says nothing when the turn probe settles without a snapping turn",
    steps: [{ x: 0, turnSettled: true, turnBlocksSnap: false }],
    expected: [{ said: false, updated: false }],
  },
])("$name", ({ steps, expected }) => {
  const { view } = turnScene();
  const { rerender } = render(view(0, false, false));
  const region = screen.getByRole("status");
  const updates = liveUpdates(region);
  const seen = steps.map(({ x, turnSettled, turnBlocksSnap }) => {
    rerender(view(x, turnSettled, turnBlocksSnap));
    return { said: region.textContent?.includes(TURN_LINE) ?? false, updated: updates() > 0 };
  });

  expect(seen).toEqual(expected);
});

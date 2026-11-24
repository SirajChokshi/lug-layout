import {
  EDITOR,
  HOTBAR,
  mainThreadModules,
  TRAIN_PLAY,
  type EditorActionId,
  type EditorSnapshot,
  type HoverRefusalHit,
  type IEditor,
  type PlacementHover,
  type PlaySnapshot,
} from "@brr/client";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Container } from "inversify";
import { createElement, Fragment } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlacementToolbar } from "./editor-panels.tsx";
import { PlacementChip } from "./placement-chip.tsx";
import { ToolHud } from "./tool-hud.tsx";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const PENDING_CUE_MS = 150;
const STEADY_SPEECH_MS = 400;
const SWEEP_STEP_MS = 100;
const FINDING_A_FIT = "Finding a fit…";
const TURN_LINE = "Turn it to snap here";

const HELD = "custom-modular-holes.ldr";

function refusalOf(hit: HoverRefusalHit | null): string {
  return hit
    ? `${HELD} would overlap ${hit.partLabel}'s bounds in ${hit.placed.label} at cell ${hit.cellX}, ${hit.cellZ}`
    : `${HELD} has nothing to rest on here: none of its connectors mate, and it isn't on the table`;
}

const REFUSED: PlacementHover = {
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
  },
  mates: [],
  joints: 0,
  lifted: false,
  restsOn: [],
  turnBlocksSnap: false,
  turnMates: [],
  turnJoints: 0,
  mode: "assist",
  magnetised: false,
  magnet: { dxLdu: 0, dzLdu: 0, dyPlates: 0, distanceLdu: 0 },
  assistNeighbourhood: { ldu: 40, cells: 2, plates: 2 },
  settled: true,
  turnSettled: true,
  waitingOn: null,
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
    play: container.get(TRAIN_PLAY).snapshot(),
    hotbar: container.get(HOTBAR),
  };
}

function placing(
  editor: IEditor,
  placement: Partial<PlacementHover>,
  held: Partial<EditorSnapshot> = {},
): EditorSnapshot {
  const hovered = { ...REFUSED, ...placement };
  return {
    ...editor.snapshot(),
    ...held,
    status: "ready",
    mode: "place",
    hover: {
      x: hovered.pose.x,
      z: hovered.pose.z,
      yPlates: 0,
      onRails: false,
      couples: null,
      refusal: hovered.accepted ? null : refusalOf(hovered.hit),
      waiting: null,
      placement: hovered,
    },
  };
}

function hintScene(first: Partial<PlacementHover> = { settled: false }) {
  const { editor, play, hotbar } = services();
  const view = (placement: Partial<PlacementHover>, held: Partial<EditorSnapshot> = {}) => {
    const snapshot = placing(editor, placement, held);
    return createElement(
      Fragment,
      null,
      createElement(ToolHud, { snapshot, play, hotbar }),
      createElement(PlacementChip, { snapshot }),
    );
  };
  const { container, rerender } = render(view(first));
  const hud = (): HTMLElement => {
    const found = container.querySelector<HTMLElement>(".tool-hud");
    if (!found) throw new Error("the tool hint is not mounted");
    return found;
  };
  const status = (): Element | null => hud().querySelector(".tool-status");
  const chip = (): HTMLElement | null => container.querySelector(".placement-chip");
  const spoken = (which: "verdict" | "turn"): HTMLElement => {
    const found = container.querySelector<HTMLElement>(`[data-speech="${which}"]`);
    if (!found) throw new Error(`the ${which} speech is not mounted`);
    return found;
  };
  const shown = () => ({
    region: `${status()?.getAttribute("role")} ${status()?.getAttribute("aria-live")}`,
    tone: hud().getAttribute("data-tone"),
    detail: hud().querySelector(".tool-detail")?.textContent ?? null,
    chip: chip()?.hidden === false ? (chip()?.textContent ?? null) : null,
    busy: spoken("verdict").getAttribute("aria-busy"),
    said: spoken("verdict").textContent,
  });
  const chipLines = (): string[] =>
    chip()?.hidden === false
      ? [...(chip()?.querySelectorAll(".placement-chip-line") ?? [])].map(
          (line) => line.textContent ?? "",
        )
      : [];
  const show = (placement: Partial<PlacementHover>, held: Partial<EditorSnapshot> = {}) =>
    rerender(view(placement, held));
  return { shown, show, spoken, chipLines };
}

function wait(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function changes(node: Element): () => number {
  const observer = new MutationObserver(() => {});
  observer.observe(node, { childList: true, subtree: true, characterData: true });
  return () => observer.takeRecords().length;
}

it("says nothing while an assist search is unsettled, shows the searching cue only after a beat, then speaks the settled refusal once it holds steady", () => {
  const { shown, show } = hintScene();
  const atOnce = shown();
  wait(PENDING_CUE_MS);
  const afterBeat = shown();
  show({ settled: true });
  const settled = shown();
  wait(STEADY_SPEECH_MS);

  expect({ atOnce, afterBeat, settled, steady: shown() }).toEqual({
    atOnce: {
      region: "status off",
      tone: "place",
      detail: "Magnetic · 0°",
      chip: null,
      busy: "true",
      said: "",
    },
    afterBeat: {
      region: "status off",
      tone: "place",
      detail: `Magnetic · 0° · ${FINDING_A_FIT}`,
      chip: FINDING_A_FIT,
      busy: "true",
      said: "",
    },
    settled: {
      region: "status off",
      tone: "warn",
      detail:
        "Magnetic · 0° · custom-modular-holes.ldr would overlap Baseplate 16 x 16's bounds in custom-modular-pinned.ldr at cell -11, -8",
      chip: "custom-modular-holes.ldr would overlap Baseplate 16 x 16's bounds in custom-modular-pinned.ldr at cell -11, -8",
      busy: "false",
      said: "",
    },
    steady: {
      region: "status off",
      tone: "warn",
      detail:
        "Magnetic · 0° · custom-modular-holes.ldr would overlap Baseplate 16 x 16's bounds in custom-modular-pinned.ldr at cell -11, -8",
      chip: "custom-modular-holes.ldr would overlap Baseplate 16 x 16's bounds in custom-modular-pinned.ldr at cell -11, -8",
      busy: "false",
      said: "Magnetic, 0°. Refused: custom-modular-holes.ldr would overlap Baseplate 16 x 16's bounds in custom-modular-pinned.ldr at cell -11, -8",
    },
  });
});

it("never shows the searching cue for a search that settles within the beat, nor at once when a search comes back to the same pose", () => {
  const { shown, show } = hintScene();
  const cues: Array<string | null> = [];
  wait(PENDING_CUE_MS - 1);
  show({ settled: true });
  wait(PENDING_CUE_MS);
  cues.push(shown().chip, shown().detail);
  show({ settled: false });
  wait(PENDING_CUE_MS);
  show({ settled: true });
  show({ settled: false });
  cues.push(shown().chip, shown().detail);

  expect(cues.filter((cue) => cue?.includes(FINDING_A_FIT))).toEqual([]);
});

it("speaks nothing while the pointer sweeps across cells and the verdict where it comes to rest, once", () => {
  const { show, spoken } = hintScene();
  const verdict = spoken("verdict");
  const heard: string[] = [];
  for (let cellX = -11; cellX <= -6; cellX++) {
    const hit = REFUSED.hit ? { ...REFUSED.hit, cellX } : null;
    show({ hit, pose: { x: cellX * 20, z: 0, yPlates: 0, rot: 0 } });
    wait(SWEEP_STEP_MS);
    heard.push(verdict.textContent ?? "");
  }
  wait(STEADY_SPEECH_MS);
  heard.push(verdict.textContent ?? "");

  expect(heard.filter((said) => said !== "")).toEqual([
    "Magnetic, 0°. Refused: custom-modular-holes.ldr would overlap Baseplate 16 x 16's bounds in custom-modular-pinned.ldr at cell -6, -8",
  ]);
});

const ROAD_WAIT: Partial<PlacementHover> = {
  accepted: false,
  hit: null,
  settled: false,
  turnSettled: false,
  waitingOn: {
    placed: {
      item: "ldraw:44336p04@72",
      label: "Baseplate 32 x 32 Road 6-Stud Straight",
      pose: { x: -320, z: 320, yPlates: 0, rot: 0 },
    },
    failed: false,
  },
};
const WAITING_LINE = "Waiting for Baseplate 32 x 32 Road 6-Stud Straight's connector data…";
const QUEUED_LINE = "Queued: placing at -320, 320 when ready";
const QUEUED = { queuedPlacement: { item: "ldraw:3811@2", x: -320, z: 320, rot: 0 } };

function waitingAt(cellX: number, rot: number): Partial<PlacementHover> {
  return { ...ROAD_WAIT, pose: { x: cellX * 20, z: 0, yPlates: 0, rot } };
}

it("shows a wait on a neighbour's connector data after a beat, with the ghost's search unspoken, and announces it once however the pointer sweeps or turns", () => {
  const { shown, show, spoken } = hintScene(ROAD_WAIT);
  const verdictChanges = changes(spoken("verdict"));
  const atOnce = shown();
  wait(PENDING_CUE_MS);
  const afterBeat = shown();
  wait(STEADY_SPEECH_MS);
  const announced = { said: shown().said, changed: verdictChanges() > 0 };
  for (let cellX = 1; cellX <= 5; cellX++) {
    show(waitingAt(cellX, cellX % 4), { ghostRot: cellX % 4 });
    wait(SWEEP_STEP_MS);
  }
  wait(STEADY_SPEECH_MS);

  expect({ atOnce, afterBeat, announced, changedAgain: verdictChanges() > 0 }).toEqual({
    atOnce: {
      region: "status off",
      tone: "place",
      detail: "Magnetic · 0°",
      chip: null,
      busy: "false",
      said: "",
    },
    afterBeat: {
      region: "status off",
      tone: "place",
      detail: `Magnetic · 0° · ${WAITING_LINE}`,
      chip: WAITING_LINE,
      busy: "false",
      said: "",
    },
    announced: { said: WAITING_LINE, changed: true },
    changedAgain: false,
  });
});

it("shows a queued click at once wherever the pointer goes, ahead of the wait once its beat passes, until the queue clears", () => {
  const { show, chipLines } = hintScene(ROAD_WAIT);
  wait(PENDING_CUE_MS);
  show(ROAD_WAIT, QUEUED);
  const clicked = chipLines();
  show(waitingAt(1, 0), QUEUED);
  const moved = chipLines();
  wait(PENDING_CUE_MS);
  const movedAfterBeat = chipLines();
  show(waitingAt(1, 0), { queuedPlacement: null });

  expect({ clicked, moved, movedAfterBeat, cleared: chipLines() }).toEqual({
    clicked: [QUEUED_LINE, WAITING_LINE],
    moved: [QUEUED_LINE],
    movedAfterBeat: [QUEUED_LINE, WAITING_LINE],
    cleared: [WAITING_LINE],
  });
});

it("says a click queued while the held item's own connector data loads in the same words in the tool hint and the chip", () => {
  const { show, shown, chipLines } = hintScene(ROAD_WAIT);
  show({}, { activeItem: "ldraw:3811@2", pendingItem: "ldraw:3811@2", ...QUEUED });

  expect({ detail: shown().detail, chip: chipLines() }).toEqual({
    detail: `loading connectors… · ${QUEUED_LINE}`,
    chip: [QUEUED_LINE],
  });
});

const FITS: Partial<PlacementHover> = { accepted: true, hit: null };

it.each([
  {
    name: "speaks a late turn hint once for the hover it belongs to, without reading the verdict again",
    steps: [
      { x: 0, turnSettled: false, turnBlocksSnap: false },
      { x: 0, turnSettled: true, turnBlocksSnap: true },
      { x: 0, turnSettled: true, turnBlocksSnap: true },
    ],
    expected: [
      { turn: "", turnChanged: false, verdictChanged: true },
      { turn: TURN_LINE, turnChanged: true, verdictChanged: false },
      { turn: TURN_LINE, turnChanged: false, verdictChanged: false },
    ],
  },
  {
    name: "never speaks the turn hint of a hover the pointer left before it held, and speaks the new hover's own once",
    steps: [
      { x: 0, turnSettled: true, turnBlocksSnap: true, leftAfterMs: SWEEP_STEP_MS },
      { x: 20, turnSettled: false, turnBlocksSnap: false },
      { x: 20, turnSettled: true, turnBlocksSnap: true },
    ],
    expected: [
      { turn: "", turnChanged: false, verdictChanged: false },
      { turn: "", turnChanged: false, verdictChanged: true },
      { turn: TURN_LINE, turnChanged: true, verdictChanged: false },
    ],
  },
  {
    name: "says nothing about turning when the turn probe settles without a snapping turn",
    steps: [
      { x: 0, turnSettled: false, turnBlocksSnap: false },
      { x: 0, turnSettled: true, turnBlocksSnap: false },
    ],
    expected: [
      { turn: "", turnChanged: false, verdictChanged: true },
      { turn: "", turnChanged: false, verdictChanged: false },
    ],
  },
])("$name", ({ steps, expected }) => {
  const { show, spoken } = hintScene();
  const turnChanges = changes(spoken("turn"));
  const verdictChanges = changes(spoken("verdict"));
  const heard = steps.map(({ x, turnSettled, turnBlocksSnap, ...step }) => {
    show({ ...FITS, pose: { x, z: 0, yPlates: 0, rot: 0 }, turnSettled, turnBlocksSnap });
    wait("leftAfterMs" in step ? step.leftAfterMs : STEADY_SPEECH_MS);
    return {
      turn: spoken("turn").textContent,
      turnChanged: turnChanges() > 0,
      verdictChanged: verdictChanges() > 0,
    };
  });

  expect(heard).toEqual(expected);
});

function switchScene(snapshot: (editor: IEditor) => EditorSnapshot, playing = false) {
  const { editor, play } = services();
  const asked: EditorActionId[] = [];
  const shownPlay: PlaySnapshot = playing ? { ...play, status: "running" } : play;
  render(
    createElement(PlacementToolbar, {
      editor,
      snapshot: snapshot(editor),
      play: shownPlay,
      onEditorAction: (id: EditorActionId) => asked.push(id),
      onShellCommand: () => {},
    }),
  );
  const control = screen.getByRole("switch", { name: "Precise placement" });
  return {
    asked,
    control,
    read: () => ({
      checked: control.getAttribute("aria-checked"),
      description: control.getAttribute("aria-describedby")
        ? (document.getElementById(control.getAttribute("aria-describedby") ?? "")?.textContent ??
          null)
        : null,
      shortcut: control.getAttribute("aria-keyshortcuts"),
      disabled: control.hasAttribute("disabled"),
    }),
  };
}

it("is a switch named Precise placement whose state is the chosen mode, describes a held Alt, toggles on click and rests while a train runs", () => {
  const magnetic = switchScene((editor) => placing(editor, FITS));
  const { asked, control, read } = magnetic;
  const chosen = read();
  act(() => control.click());
  cleanup();
  const held = switchScene((editor) => ({
    ...placing(editor, FITS),
    placementModeOverride: true,
  })).read();
  cleanup();
  const precise = switchScene((editor) => ({
    ...placing(editor, FITS),
    placementMode: "precise",
  })).read();
  cleanup();
  const playing = switchScene((editor) => placing(editor, FITS), true).read();

  expect({ chosen, asked, held, precise, playing }).toEqual({
    chosen: { checked: "false", description: null, shortcut: "a", disabled: false },
    asked: ["toggle-placement-mode"],
    held: {
      checked: "false",
      description: "Temporarily on while Alt is held",
      shortcut: "a",
      disabled: false,
    },
    precise: { checked: "true", description: null, shortcut: "a", disabled: false },
    playing: { checked: "false", description: null, shortcut: "a", disabled: true },
  });
});

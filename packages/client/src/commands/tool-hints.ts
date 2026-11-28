import { STUD_LDU } from "@brr/math";
import { MAX_FILL_TILES, type FillView } from "../edit/fill-tool.ts";
import type {
  CouplingView,
  EditorSnapshot,
  FillResult,
  GestureView,
  SelectionTally,
} from "../edit/editor.ts";
import type { TrackView } from "../edit/track-edit-session.ts";
import type { TrackLowClearanceView, TrackUnsupportedView } from "../edit/track-world.ts";
import { heldItem, type HeldItemView } from "../edit/held-item.ts";
import {
  lineText,
  placementFeedback,
  queuedText,
  showsLate,
  type PlacementFeedback,
  type PlacementLine,
  type PlacementTone,
} from "../edit/placement-feedback.ts";
import { effectivePlacementMode, otherPlacementMode } from "../edit/placement-mode.ts";
import { cmText, studsText } from "../edit/size-labels.ts";
import type {
  JoinWithheld,
  TrackBlockView,
  TrackDragView,
  TrackRefusal,
} from "../edit/track-drawing.ts";
import { trackBlockText } from "../edit/track-drag.ts";
import type {
  TrackChoicePiece,
  TrackChoiceView,
  TrackExtendView,
  UnjoinedEndView,
} from "../edit/track-extension.ts";
import type { PlaySnapshot } from "../play/train-play.ts";
import { commandEnabled, type CommandId } from "./editor-commands.ts";

export type ToolTone = "idle" | "select" | "place" | "erase" | "track" | "play" | "warn";

export type ToolHint =
  | { readonly kind: "key"; readonly command: CommandId; readonly text: string }
  | { readonly kind: "gesture"; readonly gesture: string; readonly text: string }
  | { readonly kind: "hold-alt"; readonly text: string; readonly held: boolean };

export interface ToolSpeech {
  readonly verdict: string | null;
  readonly turn: string | null;
}

interface PlaceSpeechView {
  readonly busy: boolean;
  readonly waiting: string | null;
  readonly speech: ToolSpeech | null;
}

interface HintBody {
  readonly tone: ToolTone;
  readonly title: string;
  readonly detail: string | null;
  readonly hints: ReadonlyArray<ToolHint>;
}

export interface ToolHintView extends HintBody, PlaceSpeechView {}

type HintView = HintBody & Partial<PlaceSpeechView>;

const UNSPOKEN: PlaceSpeechView = { busy: false, waiting: null, speech: null };

const DEGREES_PER_QUARTER_TURN = 90;

function key(command: CommandId, text: string): ToolHint {
  return { kind: "key", command, text };
}

function gesture(name: string, text: string): ToolHint {
  return { kind: "gesture", gesture: name, text };
}

function railDetail(couples: CouplingView | null): string {
  if (couples === null) return "it follows the rails under the cursor";
  return couples.end === "rear"
    ? `couples behind ${couples.train}`
    : `couples in front of ${couples.train}`;
}

function holdAlt(text: string, held: boolean): ToolHint {
  return { kind: "hold-alt", text, held };
}

const MODE_NAMES = { assist: "Magnetic", precise: "Precise" } as const;

function itemName(snapshot: EditorSnapshot, id: string | null): string {
  const label = snapshot.catalog.find((item) => item.id === id)?.label ?? id ?? "";
  return label.replaceAll("_", " ");
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function tallyText(tally: SelectionTally): string {
  const parts = [
    tally.models > 0 ? counted(tally.models, "model", "models") : null,
    tally.pieces > 0 ? counted(tally.pieces, "track piece", "track pieces") : null,
    tally.trains > 0 ? counted(tally.trains, "train", "trains") : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? counted(0, "model", "models") : parts.join(" and ");
}

function gestureView(drag: GestureView): HintView {
  switch (drag.kind) {
    case "box":
      return {
        tone: "select",
        title: "Box select",
        detail: `${tallyText(drag)} inside`,
        hints: [gesture("Release", "select them"), key("cancel", "cancel")],
      };
    case "move":
      return {
        tone: drag.refusal === null ? "select" : "warn",
        title: `Moving ${tallyText(drag)}`,
        detail: drag.refusal ?? `by ${drag.dx / STUD_LDU}, ${drag.dz / STUD_LDU} studs`,
        hints: [
          gesture("Release", drag.refusal === null ? "drop" : "leave it"),
          key("rotate", "rotate"),
          key("cancel", "cancel"),
        ],
      };
    case "paste":
      return {
        tone: drag.refusal === null ? "place" : "warn",
        title: `Pasting ${tallyText(drag)}`,
        detail: drag.refusal,
        hints: [gesture("Click", "drop"), key("rotate", "rotate"), key("cancel", "cancel")],
      };
    default: {
      const unhandled: never = drag;
      throw new Error(`unhandled gesture ${String(unhandled)}`);
    }
  }
}

const LAYOUT_CHANGED =
  "the layout changed while the run's piers were being built, so draw it again";

export const TOO_STEEP =
  "the run can't climb to that end's height: it has too few pieces at the ramp's rise per piece, a grade no source verifies";

function pieces(count: number): string {
  return counted(count, "piece", "pieces");
}

function blockedJoinText(block: TrackBlockView | null): string {
  return block === null
    ? "every exact join here is blocked"
    : `every exact join here would ${trackBlockText(block)}`;
}

function withheldJoinText(withheld: JoinWithheld, block: TrackBlockView | null): string {
  switch (withheld) {
    case "unsupported":
      return blockedJoinText(block);
    case "pending":
      return "a model under that join was still checking its studs";
    default: {
      const unhandled: never = withheld;
      throw new Error(`unhandled withheld join ${String(unhandled)}`);
    }
  }
}

function unsupportedText({ pieces: count, block, tilted }: TrackUnsupportedView): string {
  const flat = count - tilted;
  const ramps =
    tilted === 0
      ? ""
      : `${pieces(tilted)} on the ramp ${tilted === 1 ? "has an end" : "have ends"} resting on neither a pier's studs nor supported track`;
  if (flat === 0) return `${ramps}: ${tilted === 1 ? "it isn't" : "they aren't"} supported`;
  const rest = flat === 1 ? "rests" : "rest";
  const where = block?.kind === "model" ? ` on ${block.label}` : "";
  const level = `${pieces(flat)} ${rest}${where} where it has no studs, so ${flat === 1 ? "it isn't" : "they aren't"} supported`;
  return tilted === 0 ? level : `${level}; ${ramps}`;
}

export function lowClearanceText({ train, needPlates, hasPlates }: TrackLowClearanceView): string {
  return `too low for the tallest train: ${train} needs ${needPlates} plates, this bridge has ${hasPlates}`;
}

function dragView(drag: TrackDragView): Omit<HintView, "hints"> {
  const title = `Laying ${pieces(drag.pieces)}`;
  const refused = "Nothing to lay";
  switch (drag.closure) {
    case "exact":
      return { tone: "track", title, detail: "release to join the open end exactly" };
    case "impossible":
      return {
        tone: "warn",
        title: refused,
        detail: "no exact join reaches here, so release lays nothing",
      };
    case "blocked":
      if (drag.withheld) return withheldDragView(drag, drag.withheld, title, refused);
      return {
        tone: "warn",
        title: refused,
        detail: `${blockedJoinText(drag.blocked)}, so release lays nothing`,
      };
    case "limit":
      return { tone: "warn", title: refused, detail: "the join search ran out of time here" };
    case "too-steep":
      return { tone: "warn", title: refused, detail: `${TOO_STEEP}, so release lays nothing` };
    case "pending":
      return withheldDragView(drag, "pending", title, refused);
    case null:
      if (drag.blocked) {
        return {
          tone: "warn",
          title,
          detail: `stops short: the next piece would ${trackBlockText(drag.blocked)}`,
        };
      }
      return {
        tone: "track",
        title,
        detail: drag.pieces === 0 ? "drag away from the start" : "release to lay them",
      };
    default: {
      const unhandled: never = drag.closure;
      throw new Error(`unhandled closure ${String(unhandled)}`);
    }
  }
}

function withheldDragView(
  drag: TrackDragView,
  withheld: JoinWithheld,
  title: string,
  refused: string,
): Omit<HintView, "hints"> {
  const reason = withheldJoinText(withheld, drag.blocked);
  return drag.pieces === 0
    ? { tone: "warn", title: refused, detail: `${reason}, so release lays nothing` }
    : {
        tone: "warn",
        title,
        detail: `${reason}, so release lays the run and leaves that end open`,
      };
}

function releaseView(track: TrackView): Omit<HintView, "hints"> | null {
  const block = track.lastBlock;
  switch (track.lastCommit) {
    case "refused-impossible":
      return { tone: "warn", title: "Nothing laid", detail: "no exact join reaches that end" };
    case "refused-blocked":
      return { tone: "warn", title: "Nothing laid", detail: blockedJoinText(block) };
    case "refused-limit":
      return { tone: "warn", title: "Nothing laid", detail: "the join search ran out of time" };
    case "refused-too-steep":
      return { tone: "warn", title: "Nothing laid", detail: TOO_STEEP };
    case "refused-changed":
      return { tone: "warn", title: "Nothing laid", detail: LAYOUT_CHANGED };
    case "refused-layer":
      return {
        tone: "warn",
        title: "Nothing laid",
        detail: "the active layer is locked or hidden",
      };
    case "laid":
    case "joined":
    case null:
      return laidView(track, block);
    case "switch-straight":
    case "switch-branching":
      return null;
    default: {
      const unhandled: never = track.lastCommit;
      throw new Error(`unhandled commit ${String(unhandled)}`);
    }
  }
}

function joinRefusalText(refusal: TrackRefusal, blocked: TrackBlockView | null): string {
  switch (refusal) {
    case "impossible":
      return "no exact join reaches it";
    case "blocked":
      return blockedJoinText(blocked);
    case "limit":
      return "the join search ran out of time";
    case "too-steep":
      return TOO_STEEP;
    case "pending":
      return "a model under it is still checking its studs";
    default: {
      const unhandled: never = refusal;
      throw new Error(`unhandled refusal ${String(unhandled)}`);
    }
  }
}

export function unjoinedText(unjoined: UnjoinedEndView): string {
  const studs = Math.round(unjoined.studs);
  return `the open end ${studs} studs ahead can't be joined: ${joinRefusalText(unjoined.refusal, unjoined.blocked)}`;
}

function extendTitle(choice: TrackChoiceView): string {
  switch (choice.kind) {
    case "straight":
      return "Next piece: straight";
    case "left":
      return "Next piece: curve left";
    case "right":
      return "Next piece: curve right";
    case "piece":
      return `Next piece: ${choice.piece.label}`;
    case "join":
      return `Next: join, ${pieces(choice.straights + choice.curves)}`;
    default: {
      const unhandled: never = choice;
      throw new Error(`unhandled choice ${String(unhandled)}`);
    }
  }
}

export function libraryPieceEndText({ end, ends }: TrackChoicePiece): string {
  return `attaches by its end ${end + 1} of ${ends}`;
}

function extendDetail(choice: TrackChoiceView, extend: TrackExtendView): string | null {
  if (extend.unjoined) return unjoinedText(extend.unjoined);
  if (choice.blocked) return `the piece would ${trackBlockText(choice.blocked)}`;
  if (choice.joinsEnd) return "joins the open end exactly";
  return choice.kind === "piece" ? libraryPieceEndText(choice.piece) : null;
}

function extendView(extend: TrackExtendView, released: Omit<HintView, "hints"> | null): HintView {
  const choice = extend.choices[extend.index];
  const blocked = choice?.blocked ?? null;
  const shown: Omit<HintView, "hints"> = choice
    ? {
        tone: blocked ? "warn" : "track",
        title: `${extendTitle(choice)}${blocked ? " (blocked)" : ""}`,
        detail: extendDetail(choice, extend),
      }
    : { tone: "track", title: "Next piece", detail: null };
  return {
    ...(released ?? shown),
    hints: [
      gesture("Click", "lay it"),
      key("extend-straight", "straight"),
      key("extend-left", "left"),
      key("extend-right", "right"),
      key("extend-preview", choice?.joinsEnd ? "join" : "lay it"),
      key("next-connector", "next end"),
      key("next-track-choice", "other choices"),
      key("undo", "undo"),
      key("select-tool", extend.continuing ? "let go of the end" : "done"),
    ],
  };
}

function heldPieceView(track: TrackView): HintView | null {
  const held = track.held;
  if (!held) return null;
  const { blocked } = held;
  return {
    tone: blocked ? "warn" : "place",
    title: `Holding ${held.label}`,
    detail: blocked
      ? `would ${trackBlockText(blocked)}`
      : held.snapped
        ? "attaches to the open end exactly"
        : "free on the stud grid",
    hints: [
      gesture("Click", blocked ? "refused here" : "lay it"),
      key("next-connector", "next end"),
      key("flip-switch", "other hand"),
      key("rotate", "turn"),
      key("select-tool", "let go, keep drawing"),
    ],
  };
}

function fillingView(fill: FillView, name: string): Omit<HintView, "hints"> {
  if (fill.overLimit) {
    return {
      tone: "warn",
      title: `${fill.wanted} tiles is too many`,
      detail: `one fill places at most ${MAX_FILL_TILES}, so release places nothing`,
    };
  }
  const placing = fill.wanted - fill.refused - fill.alreadyThere;
  const skipped = [
    ...(fill.alreadyThere > 0 ? [`${fill.alreadyThere} already there`] : []),
    ...(fill.refused > 0 ? [`${fill.refused} refused and skipped`] : []),
  ];
  return {
    tone: placing > 0 || fill.refused === 0 ? "place" : "warn",
    title: `Filling ${fill.wanted} × ${name}`,
    detail:
      skipped.length > 0
        ? [`${placing} to place`, ...skipped].join(", ")
        : "release to place them all, one undo removes them",
  };
}

function filledView(fill: FillResult, name: string): Omit<HintView, "hints"> {
  const why = fill.reason === null ? "" : `: ${fill.reason}`;
  const skipped = fill.refused > 0 ? `skipped ${fill.refused} refused${why}` : null;
  const there = fill.alreadyThere > 0 ? `${fill.alreadyThere} already there` : null;
  if (fill.placed === 0) {
    if (skipped === null && there !== null) {
      return { tone: "place", title: "Nothing to fill", detail: "every tile is already there" };
    }
    return { tone: "warn", title: "Nothing filled", detail: skipped ?? fill.reason };
  }
  return {
    tone: skipped === null ? "place" : "warn",
    title: `Filled ${fill.placed} × ${name}`,
    detail:
      skipped ?? (there === null ? "one undo removes them" : `${there}; one undo removes the rest`),
  };
}

function laidView(track: TrackView, block: TrackBlockView | null): Omit<HintView, "hints"> | null {
  const unsupported = track.lastUnsupported ? unsupportedText(track.lastUnsupported) : null;
  if (track.lastWithheld) {
    const withheld = withheldJoinText(track.lastWithheld, block);
    return {
      tone: "warn",
      title: track.lastCommit === null ? "Nothing laid" : "Laid, end left open",
      detail: unsupported ? `${withheld}; ${unsupported}` : withheld,
    };
  }
  if (unsupported) return { tone: "warn", title: "Laid unsupported", detail: unsupported };
  if (track.lastLowClearance) {
    return {
      tone: "warn",
      title: "Laid too low",
      detail: lowClearanceText(track.lastLowClearance),
    };
  }
  if (block === null || track.lastCommit === "joined") return null;
  return {
    tone: "warn",
    title: track.lastCommit === "laid" ? "Stopped short" : "Nothing laid",
    detail: `the next piece would ${trackBlockText(block)}`,
  };
}

function loadingView(snapshot: EditorSnapshot, held: HeldItemView): HintView {
  const { queued } = held;
  return {
    tone: "place",
    title: `Loading ${itemName(snapshot, held.item)}`,
    detail:
      queued === null
        ? "loading connectors… a click places it once they load"
        : `loading connectors… · ${queuedText(queued)}`,
    hints: [
      gesture("Click", "place once loaded"),
      key("open-palette", "another part"),
      key("select-tool", "cancel"),
    ],
  };
}

function measureDetail(snapshot: EditorSnapshot): string {
  const { hover } = snapshot;
  const cursor = hover
    ? `cursor at ${studsText(hover.x)}, ${studsText(hover.z)} studs · ${cmText(hover.x)}, ${cmText(hover.z)} cm`
    : "in studs and cm";
  if (snapshot.rulers === 0) return cursor;
  return `${snapshot.rulers} ${snapshot.rulers === 1 ? "ruler" : "rulers"}, ${cursor}`;
}

function verdictSpeech(feedback: PlacementFeedback, heading: string): string | null {
  if (feedback.tone === "pending") return null;
  const said = feedback.lines.filter(unturned).map(lineText).join(" · ");
  if (feedback.tone === "waiting") return said || null;
  if (feedback.tone === "refused") return `${heading}. Refused: ${said}`;
  return `${heading}. ${said || "Fits here"}`;
}

function unhoveredSpeech(snapshot: EditorSnapshot, title: string, heading: string): string {
  if (snapshot.ghostSettled) return `Placed ${itemName(snapshot, snapshot.activeItem)}`;
  return `${title}. ${heading}`;
}

function unturned(placementLine: PlacementLine): boolean {
  return placementLine.kind !== "turn";
}

function clickText(tone: PlacementTone | undefined): string {
  if (tone === "refused") return "refused here";
  return tone === "waiting" ? "place when ready" : "place";
}

function placeHints(snapshot: EditorSnapshot, feedback: PlacementFeedback | null): ToolHint[] {
  const click = gesture("Click", clickText(feedback?.tone));
  const kept = MODE_NAMES[snapshot.placementMode].toLowerCase();
  if (snapshot.placementModeOverride) return [click, holdAlt(`${kept} again`, true)];
  const turning = feedback?.lines.some((placementLine) => !unturned(placementLine)) ?? false;
  const other = MODE_NAMES[otherPlacementMode(snapshot.placementMode)].toLowerCase();
  return [
    click,
    gesture("Drag", "fill an area"),
    key("cycle-fill-grid", `${snapshot.fillGridStuds}-stud grid`),
    key("rotate", turning ? "turn to snap" : "rotate"),
    key("toggle-placement-mode", other),
    holdAlt(`${other} while held`, false),
    key("open-palette", "another part"),
    key("select-tool", "done"),
  ];
}

function filledSpeech(filled: Omit<HintView, "hints">): ToolSpeech {
  return { verdict: [filled.title, filled.detail].filter(Boolean).join(". "), turn: null };
}

function placeView(snapshot: EditorSnapshot, name: string): HintView {
  const feedback = placementFeedback(snapshot);
  const hints = placeHints(snapshot, feedback);
  const { lastFill } = snapshot;
  if (feedback === null && lastFill?.item === snapshot.activeItem) {
    const filled = filledView(lastFill, name);
    return { ...filled, hints, speech: filledSpeech(filled) };
  }
  const pending = feedback?.tone === "pending";
  const mode =
    feedback?.mode ??
    effectivePlacementMode(snapshot.placementMode, snapshot.placementModeOverride);
  const degrees = `${snapshot.ghostRot * DEGREES_PER_QUARTER_TURN}°`;
  const title = `Placing ${name}`;
  const lines = feedback?.lines ?? [];
  const said = lines.filter((placementLine) => !showsLate(placementLine)).map(lineText);
  const turn = lines.find((placementLine) => !unturned(placementLine));
  return {
    tone: feedback?.tone === "refused" ? "warn" : "place",
    title,
    detail: [MODE_NAMES[mode], degrees, ...said].join(" · "),
    hints,
    busy: pending,
    waiting: lines.find(showsLate)?.text ?? null,
    speech: {
      verdict: feedback
        ? verdictSpeech(feedback, `${MODE_NAMES[mode]}, ${degrees}`)
        : unhoveredSpeech(snapshot, title, `${MODE_NAMES[mode]}, ${degrees}`),
      turn: turn ? lineText(turn) : null,
    },
  };
}

function view(snapshot: EditorSnapshot): HintView {
  if (snapshot.status === "loading") {
    return { tone: "idle", title: "Loading parts and sets…", detail: null, hints: [] };
  }
  if (snapshot.status === "error") {
    return { tone: "warn", title: "The editor couldn't start", detail: snapshot.error, hints: [] };
  }
  switch (snapshot.mode) {
    case "place": {
      const held = heldItem(snapshot);
      if (held?.tables === "loading") return loadingView(snapshot, held);
      const name = itemName(snapshot, snapshot.activeItem);
      if (snapshot.fillDraft) {
        return {
          ...fillingView(snapshot.fillDraft, name),
          hints: [
            key("cycle-fill-grid", `${snapshot.fillGridStuds}-stud grid`),
            key("rotate", "rotate"),
            key("cancel", "cancel"),
          ],
        };
      }
      const hover = snapshot.hover;
      if (hover?.onRails) {
        return {
          tone: hover.refusal === null ? "place" : "warn",
          title: `Setting ${name} on the rails`,
          detail: hover.refusal ?? railDetail(hover.couples),
          hints: [
            gesture("Click", "set it there"),
            key("rotate", "turn round"),
            key("open-palette", "another part"),
            key("select-tool", "done"),
          ],
        };
      }
      return placeView(snapshot, name);
    }
    case "track": {
      const track = snapshot.track;
      const drag = track?.drag ?? null;
      if (drag) return { ...dragView(drag), hints: [key("select-tool", "stop drawing")] };
      const holding = track ? heldPieceView(track) : null;
      if (holding) return holding;
      const released = track ? releaseView(track) : null;
      if (track?.extend) return extendView(track.extend, released);
      const closable = (track?.loops.closures.length ?? 0) > 0;
      const hints = [
        gesture("Drag", "lay track"),
        ...(closable ? [key("close-track-loop", "close the nearest gap")] : []),
        key("undo", "undo"),
        key("draw-track", "done"),
      ];
      if (released) return { ...released, hints };
      return {
        tone: "track",
        title: "Drawing track",
        detail: "point at an open end to add the next piece, or drag to lay a run",
        hints,
      };
    }
    case "road": {
      const kit = snapshot.roadKits.find((k) => k.id === snapshot.roadKit)?.label ?? "no kit";
      if (snapshot.roadErase) {
        return {
          tone: "erase",
          title: "Erasing road",
          detail: kit,
          hints: [
            gesture("Drag", "lift road"),
            key("undo", "undo"),
            key("draw-road", "done"),
            key("select-tool", "stop"),
          ],
        };
      }
      return {
        tone: "place",
        title: "Drawing road",
        detail: `${kit}, lone tiles at ${snapshot.ghostRot * DEGREES_PER_QUARTER_TURN}°`,
        hints: [
          gesture("Drag", "lay road"),
          key("rotate", "turn a lone tile"),
          key("undo", "undo"),
          key("draw-road", "done"),
          key("select-tool", "stop"),
        ],
      };
    }
    case "measure":
      return {
        tone: "select",
        title: "Measuring",
        detail: measureDetail(snapshot),
        hints: [
          gesture("Drag", "lay a ruler"),
          key("delete", "remove the last"),
          key("measure", "done"),
        ],
      };
    case "table":
      return {
        tone: "place",
        title: "Drawing tables",
        detail: "edges land on the 8-stud grid",
        hints: [
          gesture("Drag", "draw, or drag an edge to resize"),
          key("delete", "remove the table under the cursor"),
          key("undo", "undo"),
          key("draw-tables", "done"),
        ],
      };
    case "select": {
      const { selection } = snapshot;
      if (snapshot.gesture) return gestureView(snapshot.gesture);
      const primary = selection?.primary;
      if (primary?.kind === "train") {
        return {
          tone: snapshot.selectionRefusal === null ? "select" : "warn",
          title: itemName(snapshot, primary.item),
          detail: snapshot.selectionRefusal ?? "on the rails",
          hints: [
            key("delete", "delete"),
            key("duplicate", "place more"),
            key("focus", "frame"),
            key("select-tool", "deselect"),
          ],
        };
      }
      if (selection && selection.members.length > 1) {
        return {
          tone: snapshot.selectionRefusal === null ? "select" : "warn",
          title: `${tallyText(selection.tally)} selected`,
          detail: snapshot.selectionRefusal,
          hints: [
            gesture("Drag one", "move them all"),
            gesture("Shift-click", "add or take out"),
            key("nudge-forward", "nudge"),
            key("rotate", "rotate"),
            key("copy", "copy"),
            key("delete", "delete"),
            key("focus", "frame"),
            key("select-tool", "deselect"),
          ],
        };
      }
      if (primary) {
        return {
          tone: snapshot.selectionRefusal === null ? "select" : "warn",
          title: itemName(snapshot, primary.item),
          detail:
            snapshot.selectionRefusal ??
            (primary.kind === "track"
              ? "laid track"
              : `${primary.rot * DEGREES_PER_QUARTER_TURN}°`),
          hints: [
            gesture("Drag", "move"),
            gesture("Shift-click", "add more"),
            key("nudge-forward", "nudge"),
            key("rotate", "rotate"),
            key("delete", "delete"),
            key("copy", "copy"),
            key("duplicate", "place more"),
            key("focus", "frame"),
            key("select-tool", "deselect"),
          ],
        };
      }
      return {
        tone: snapshot.selectionRefusal === null ? "idle" : "warn",
        title: "Select",
        detail: snapshot.selectionRefusal,
        hints: [
          gesture("Click", "select a model or track piece"),
          gesture("Drag", "box-select"),
          key("paste", "paste"),
          key("open-palette", "find a part"),
          key("draw-track", "draw track"),
          key("draw-road", "draw road"),
          key("show-shortcuts", "all shortcuts"),
        ],
      };
    }
    default: {
      const unhandled: never = snapshot.mode;
      throw new Error(`unhandled mode ${String(unhandled)}`);
    }
  }
}

function playView(play: PlaySnapshot): HintView {
  const derailed = play.derailSpeedLduPerS > 0;
  return {
    tone: derailed ? "warn" : "play",
    title: derailed ? "Derailed" : "Playing",
    detail: derailed ? "the train ran off an open end" : null,
    hints: [
      key("throttle-up", "faster"),
      key("throttle-down", "slower, then back"),
      key("stop-train", "stop"),
      key("rerail", "rerail"),
      gesture("Click a switch", "throw it"),
      key("play", "leave play"),
    ],
  };
}

export function toolHints(snapshot: EditorSnapshot, play?: PlaySnapshot): ToolHintView {
  const hinted =
    play?.status === "running" && snapshot.status === "ready" ? playView(play) : view(snapshot);
  return {
    ...UNSPOKEN,
    ...hinted,
    hints: hinted.hints.filter(
      (hint) => hint.kind !== "key" || commandEnabled(hint.command, snapshot, play),
    ),
  };
}

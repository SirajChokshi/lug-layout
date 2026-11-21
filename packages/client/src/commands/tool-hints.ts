import type { EditorSnapshot, TrackView } from "../edit/editor.ts";
import { heldItem, type HeldItemView } from "../edit/held-item.ts";
import { cmText, studsText } from "../edit/size-labels.ts";
import type { TrackBlockView, TrackDragView, TrackRefusal } from "../edit/track-drawing.ts";
import type { TrackChoiceView, TrackExtendView, UnjoinedEndView } from "../edit/track-extension.ts";
import type { PlaySnapshot } from "../play/train-play.ts";
import { commandEnabled, type CommandId } from "./editor-commands.ts";

export type ToolTone = "idle" | "select" | "place" | "erase" | "track" | "play" | "warn";

export type ToolHint =
  | { readonly kind: "key"; readonly command: CommandId; readonly text: string }
  | { readonly kind: "gesture"; readonly gesture: string; readonly text: string };

export interface ToolHintView {
  readonly tone: ToolTone;
  readonly title: string;
  readonly detail: string | null;
  readonly hints: ReadonlyArray<ToolHint>;
}

const DEGREES_PER_QUARTER_TURN = 90;

function key(command: CommandId, text: string): ToolHint {
  return { kind: "key", command, text };
}

function gesture(name: string, text: string): ToolHint {
  return { kind: "gesture", gesture: name, text };
}

function itemName(snapshot: EditorSnapshot, id: string | null): string {
  const label = snapshot.catalog.find((item) => item.id === id)?.label ?? id ?? "";
  return label.replaceAll("_", " ");
}

function pieces(count: number): string {
  return `${count} ${count === 1 ? "piece" : "pieces"}`;
}

export function trackBlockText(block: TrackBlockView): string {
  switch (block.kind) {
    case "track":
      return "cross the track laid there";
    case "run":
      return "cross this run";
    case "model":
      return block.unseated
        ? `sit on ${block.label} where it has no studs`
        : `run into ${block.label}`;
    default: {
      const unhandled: never = block;
      throw new Error(`unhandled block ${String(unhandled)}`);
    }
  }
}

function blockedJoinText(block: TrackBlockView | null): string {
  return block === null
    ? "every exact join here is blocked"
    : `every exact join here would ${trackBlockText(block)}`;
}

function dragView(drag: TrackDragView): Omit<ToolHintView, "hints"> {
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
      return {
        tone: "warn",
        title: refused,
        detail: `${blockedJoinText(drag.blocked)}, so release lays nothing`,
      };
    case "limit":
      return { tone: "warn", title: refused, detail: "the join search ran out of time here" };
    case "pending":
      return {
        tone: "warn",
        title: "Waiting for the stud check",
        detail: "a model under this join is still checking its studs, so release lays nothing yet",
      };
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

function releaseView(track: TrackView): Omit<ToolHintView, "hints"> | null {
  const block = track.lastBlock;
  switch (track.lastCommit) {
    case "refused-impossible":
      return { tone: "warn", title: "Nothing laid", detail: "no exact join reaches that end" };
    case "refused-blocked":
      return { tone: "warn", title: "Nothing laid", detail: blockedJoinText(block) };
    case "refused-limit":
      return { tone: "warn", title: "Nothing laid", detail: "the join search ran out of time" };
    case "refused-pending":
      return {
        tone: "warn",
        title: "Nothing laid",
        detail: "a model under that join was still checking its studs",
      };
    case "laid":
    case null:
      if (block === null) return null;
      return {
        tone: "warn",
        title: track.lastCommit === "laid" ? "Stopped short" : "Nothing laid",
        detail: `the next piece would ${trackBlockText(block)}`,
      };
    case "joined":
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
    case "join":
      return `Next: join, ${pieces(choice.straights + choice.curves)}`;
    default: {
      const unhandled: never = choice.kind;
      throw new Error(`unhandled choice ${String(unhandled)}`);
    }
  }
}

function extendDetail(choice: TrackChoiceView, extend: TrackExtendView): string | null {
  if (extend.unjoined) return unjoinedText(extend.unjoined);
  if (choice.blocked) return `the piece would ${trackBlockText(choice.blocked)}`;
  return choice.joinsEnd ? "joins the open end exactly" : null;
}

function extendView(
  extend: TrackExtendView,
  released: Omit<ToolHintView, "hints"> | null,
): ToolHintView {
  const choice = extend.choices[extend.index];
  const blocked = choice?.blocked ?? null;
  const shown: Omit<ToolHintView, "hints"> = choice
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
      key("next-track-choice", "other choices"),
      key("undo", "undo"),
      key("select-tool", extend.continuing ? "let go of the end" : "done"),
    ],
  };
}

function heldPieceView(track: TrackView): ToolHintView | null {
  const held = track.held;
  if (!held) return null;
  return {
    tone: "place",
    title: `Holding ${held.label}`,
    detail: held.snapped ? "attaches to the open end exactly" : "free on the stud grid",
    hints: [
      gesture("Click", "lay it"),
      key("next-connector", "next end"),
      key("flip-switch", "other hand"),
      key("rotate", "turn"),
      key("select-tool", "done"),
    ],
  };
}

function loadingView(snapshot: EditorSnapshot, held: HeldItemView): ToolHintView {
  const { queued } = held;
  return {
    tone: "place",
    title: `Loading ${itemName(snapshot, held.item)}`,
    detail:
      queued === null
        ? "loading connectors… a click places it once they load"
        : `loading connectors… then it goes down at ${queued.x}, ${queued.z} if the pointer stays there`,
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

function view(snapshot: EditorSnapshot): ToolHintView {
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
      const hover = snapshot.hover;
      if (hover?.onRails) {
        return {
          tone: hover.refusal === null ? "place" : "warn",
          title: `Setting ${itemName(snapshot, snapshot.activeItem)} on the rails`,
          detail: hover.refusal ?? "it follows the rails under the cursor",
          hints: [
            gesture("Click", "set it there"),
            key("rotate", "turn round"),
            key("open-palette", "another part"),
            key("select-tool", "done"),
          ],
        };
      }
      return {
        tone: "place",
        title: `Placing ${itemName(snapshot, snapshot.activeItem)}`,
        detail: `${snapshot.ghostRot * DEGREES_PER_QUARTER_TURN}°`,
        hints: [
          gesture("Click", "place"),
          key("rotate", "rotate"),
          key("open-palette", "another part"),
          key("select-tool", "done"),
        ],
      };
    }
    case "track": {
      const track = snapshot.track;
      const drag = track?.drag ?? null;
      if (drag) return { ...dragView(drag), hints: [key("select-tool", "stop drawing")] };
      const holding = track ? heldPieceView(track) : null;
      if (holding) return holding;
      const released = track ? releaseView(track) : null;
      if (track?.extend) return extendView(track.extend, released);
      const hints = [gesture("Drag", "lay track"), key("undo", "undo"), key("draw-track", "done")];
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
    case "select": {
      const { selection } = snapshot;
      if (selection?.kind === "train") {
        return {
          tone: snapshot.selectionRefusal === null ? "select" : "warn",
          title: itemName(snapshot, selection.item),
          detail: snapshot.selectionRefusal ?? "on the rails",
          hints: [
            key("delete", "delete"),
            key("duplicate", "place more"),
            key("focus", "frame"),
            key("select-tool", "deselect"),
          ],
        };
      }
      if (selection) {
        return {
          tone: snapshot.selectionRefusal === null ? "select" : "warn",
          title: itemName(snapshot, selection.item),
          detail:
            snapshot.selectionRefusal ??
            (selection.kind === "track"
              ? "laid track"
              : `${selection.rot * DEGREES_PER_QUARTER_TURN}°`),
          hints: [
            key("rotate", "rotate"),
            key("delete", "delete"),
            key("duplicate", "place more"),
            key("focus", "frame"),
            key("select-tool", "deselect"),
          ],
        };
      }
      return {
        tone: "idle",
        title: "Select",
        detail: null,
        hints: [
          gesture("Click", "select a model"),
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

function playView(play: PlaySnapshot): ToolHintView {
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
    ...hinted,
    hints: hinted.hints.filter(
      (hint) => hint.kind === "gesture" || commandEnabled(hint.command, snapshot, play),
    ),
  };
}

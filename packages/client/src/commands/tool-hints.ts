import { STUD_LDU } from "@brr/math";
import { MAX_FILL_TILES, type FillView } from "../edit/fill-tool.ts";
import type {
  EditorSnapshot,
  FillResult,
  GestureView,
  SelectionTally,
  TrackView,
} from "../edit/editor.ts";
import { heldItem, type HeldItemView } from "../edit/held-item.ts";
import { cmText, studsText } from "../edit/size-labels.ts";
import type { TrackBlockView, TrackDragView, TrackRefusal } from "../edit/track-drawing.ts";
import { trackBlockText } from "../edit/track-drag.ts";
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

function gestureView(drag: GestureView): ToolHintView {
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

function pieces(count: number): string {
  return counted(count, "piece", "pieces");
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

function fillingView(fill: FillView, name: string): Omit<ToolHintView, "hints"> {
  if (fill.overLimit) {
    return {
      tone: "warn",
      title: `${fill.wanted} tiles is too many`,
      detail: `one fill places at most ${MAX_FILL_TILES}, so release places nothing`,
    };
  }
  const placing = fill.wanted - fill.refused;
  return {
    tone: placing > 0 ? "place" : "warn",
    title: `Filling ${fill.wanted} × ${name}`,
    detail:
      fill.refused > 0
        ? `${placing} to place, ${fill.refused} refused and skipped`
        : "release to place them all, one undo removes them",
  };
}

function filledView(fill: FillResult, name: string): Omit<ToolHintView, "hints"> {
  const why = fill.reason === null ? "" : `: ${fill.reason}`;
  const skipped = fill.refused > 0 ? `skipped ${fill.refused} refused${why}` : null;
  if (fill.placed === 0) {
    return { tone: "warn", title: "Nothing filled", detail: skipped ?? fill.reason };
  }
  return {
    tone: skipped === null ? "place" : "warn",
    title: `Filled ${fill.placed} × ${name}`,
    detail: skipped ?? "one undo removes them",
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
          detail: hover.refusal ?? "it follows the rails under the cursor",
          hints: [
            gesture("Click", "set it there"),
            key("rotate", "turn round"),
            key("open-palette", "another part"),
            key("select-tool", "done"),
          ],
        };
      }
      const hints = [
        gesture("Click", "place"),
        gesture("Drag", "fill an area"),
        key("cycle-fill-grid", `${snapshot.fillGridStuds}-stud grid`),
        key("rotate", "rotate"),
        key("open-palette", "another part"),
        key("select-tool", "done"),
      ];
      const { lastFill } = snapshot;
      if (lastFill?.item === snapshot.activeItem) return { ...filledView(lastFill, name), hints };
      return {
        tone: "place",
        title: `Placing ${name}`,
        detail: `${snapshot.ghostRot * DEGREES_PER_QUARTER_TURN}°`,
        hints,
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
        tone: "idle",
        title: "Select",
        detail: null,
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

import type { EditorSnapshot } from "../edit/editor.ts";
import { heldItem, type HeldItemView } from "../edit/held-item.ts";
import { lineText, placementFeedback } from "../edit/placement-feedback.ts";
import { effectivePlacementMode, otherPlacementMode } from "../edit/placement-mode.ts";
import type { TrackDragView } from "../edit/track-drawing.ts";
import type { PlaySnapshot } from "../play/train-play.ts";
import { commandEnabled, type CommandId } from "./editor-commands.ts";

export type ToolTone = "idle" | "select" | "place" | "erase" | "track" | "play" | "warn";

export type ToolHint =
  | { readonly kind: "key"; readonly command: CommandId; readonly text: string }
  | { readonly kind: "gesture"; readonly gesture: string; readonly text: string }
  | { readonly kind: "hold-alt"; readonly text: string };

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

function holdAlt(text: string): ToolHint {
  return { kind: "hold-alt", text };
}

const MODE_NAMES = { assist: "Magnetic", precise: "Precise" } as const;

function itemName(snapshot: EditorSnapshot, id: string | null): string {
  const label = snapshot.catalog.find((item) => item.id === id)?.label ?? id ?? "";
  return label.replaceAll("_", " ");
}

function pieces(count: number): string {
  return `${count} ${count === 1 ? "piece" : "pieces"}`;
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
        detail: "every exact join here is blocked, so release lays nothing",
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
      const feedback = placementFeedback(snapshot);
      const refused = feedback?.tone === "refused";
      const said = feedback?.lines.map(lineText) ?? [];
      const mode =
        feedback?.mode ??
        effectivePlacementMode(snapshot.placementMode, snapshot.placementModeOverride);
      const other = MODE_NAMES[otherPlacementMode(snapshot.placementMode)].toLowerCase();
      return {
        tone: refused ? "warn" : "place",
        title: `Placing ${itemName(snapshot, snapshot.activeItem)}`,
        detail: [
          MODE_NAMES[mode],
          `${snapshot.ghostRot * DEGREES_PER_QUARTER_TURN}°`,
          ...said,
        ].join(" · "),
        hints: [
          gesture("Click", refused ? "refused here" : "place"),
          key("rotate", feedback?.turnToSnap ? "turn to snap" : "rotate"),
          key("toggle-placement-mode", other),
          holdAlt(`${other} while held`),
          key("open-palette", "another part"),
          key("select-tool", "done"),
        ],
      };
    }
    case "track": {
      const drag = snapshot.track?.drag ?? null;
      if (drag) return { ...dragView(drag), hints: [key("select-tool", "stop drawing")] };
      return {
        tone: "track",
        title: "Drawing track",
        detail: "start on an open end to continue a line",
        hints: [gesture("Drag", "lay track"), key("undo", "undo"), key("draw-track", "done")],
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
    case "select": {
      const { selection } = snapshot;
      if (selection) {
        return {
          tone: snapshot.selectionRefusal === null ? "select" : "warn",
          title: itemName(snapshot, selection.item),
          detail: snapshot.selectionRefusal ?? `${selection.rot * DEGREES_PER_QUARTER_TURN}°`,
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
      (hint) => hint.kind !== "key" || commandEnabled(hint.command, snapshot, play),
    ),
  };
}

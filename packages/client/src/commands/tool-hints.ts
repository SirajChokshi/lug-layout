import { STUD_LDU } from "@brr/math";
import type { EditorSnapshot, GestureView } from "../edit/editor.ts";
import type { TrackDragView } from "../edit/track-drawing.ts";
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

function models(count: number): string {
  return `${count} ${count === 1 ? "model" : "models"}`;
}

function gestureView(drag: GestureView): ToolHintView {
  switch (drag.kind) {
    case "box":
      return {
        tone: "select",
        title: "Box select",
        detail: `${models(drag.inside)} inside`,
        hints: [gesture("Release", "select them"), key("cancel", "cancel")],
      };
    case "move":
      return {
        tone: drag.refusal === null ? "select" : "warn",
        title: `Moving ${models(drag.count)}`,
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
        title: `Pasting ${models(drag.count)}`,
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

function view(snapshot: EditorSnapshot): ToolHintView {
  if (snapshot.status === "loading") {
    return { tone: "idle", title: "Loading parts and sets…", detail: null, hints: [] };
  }
  if (snapshot.status === "error") {
    return { tone: "warn", title: "The editor couldn't start", detail: snapshot.error, hints: [] };
  }
  switch (snapshot.mode) {
    case "place":
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
      if (snapshot.gesture) return gestureView(snapshot.gesture);
      if (selection && selection.members.length > 1) {
        return {
          tone: snapshot.selectionRefusal === null ? "select" : "warn",
          title: `${models(selection.members.length)} selected`,
          detail: snapshot.selectionRefusal,
          hints: [
            gesture("Drag one", "move them all"),
            key("nudge-forward", "nudge"),
            key("rotate", "rotate"),
            key("copy", "copy"),
            key("delete", "delete"),
            key("focus", "frame"),
            key("select-tool", "deselect"),
          ],
        };
      }
      if (selection) {
        return {
          tone: snapshot.selectionRefusal === null ? "select" : "warn",
          title: itemName(snapshot, selection.primary.item),
          detail:
            snapshot.selectionRefusal ?? `${selection.primary.rot * DEGREES_PER_QUARTER_TURN}°`,
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
          gesture("Click", "select a model"),
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

import type { EditorSnapshot } from "../edit/editor.ts";
import type { TrackDragView } from "../edit/track-drawing.ts";
import { commandEnabled, type CommandId } from "./editor-commands.ts";

export type ToolTone = "idle" | "select" | "place" | "erase" | "track" | "warn";

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

function dragView(drag: TrackDragView): Omit<ToolHintView, "hints"> {
  const title = `Laying ${pieces(drag.pieces)}`;
  switch (drag.closure) {
    case "exact":
      return { tone: "track", title, detail: "release to join the open end exactly" };
    case "impossible":
      return { tone: "warn", title, detail: "no exact join reaches here, so release lays nothing" };
    case "limit":
      return { tone: "warn", title, detail: "the join search ran out of time here" };
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
      if (selection) {
        return {
          tone: "select",
          title: itemName(snapshot, selection.item),
          detail: `${selection.rot * DEGREES_PER_QUARTER_TURN}°`,
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

export function toolHints(snapshot: EditorSnapshot): ToolHintView {
  const hinted = view(snapshot);
  return {
    ...hinted,
    hints: hinted.hints.filter(
      (hint) => hint.kind === "gesture" || commandEnabled(hint.command, snapshot),
    ),
  };
}

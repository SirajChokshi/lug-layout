import type { EditorSnapshot, TrackCommitResult } from "../edit/editor.ts";
import type { TrackDragView } from "../edit/track-drawing.ts";
import type {
  TrackChoiceView,
  TrackExtendView,
  TrackRefusal,
  UnjoinedEndView,
} from "../edit/track-extension.ts";
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

export function refusalText(refusal: TrackRefusal): string {
  switch (refusal) {
    case "impossible":
      return "no run of 9V straights and R40 curves meets it exactly";
    case "blocked":
      return "every exact join would cross track, a plate, a model or itself";
    case "limit":
      return "the join search ran out of time";
    default: {
      const unhandled: never = refusal;
      throw new Error(`unhandled refusal ${String(unhandled)}`);
    }
  }
}

export function unjoinedText(unjoined: UnjoinedEndView): string {
  const studs = Math.round(unjoined.studs);
  return `the open end ${studs} studs ahead can't be joined: ${refusalText(unjoined.refusal)}`;
}

const CROSSING_TEXT = "it would cross track, a plate or a model";

function releaseRefusal(commit: TrackCommitResult | null): string | null {
  switch (commit) {
    case "refused-impossible":
      return refusalText("impossible");
    case "refused-blocked":
      return refusalText("blocked");
    case "refused-limit":
      return refusalText("limit");
    case "refused-crossing":
      return CROSSING_TEXT;
    case "laid":
    case "joined":
    case "switch-straight":
    case "switch-branching":
    case null:
      return null;
    default: {
      const unhandled: never = commit;
      throw new Error(`unhandled commit ${String(unhandled)}`);
    }
  }
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
  if (choice.blocked) return CROSSING_TEXT;
  if (extend.unjoined) return unjoinedText(extend.unjoined);
  return choice.joinsEnd ? "joins the open end exactly" : null;
}

function extendView(extend: TrackExtendView, refusal: string | null): ToolHintView {
  const choice = extend.choices[extend.index];
  const joins = choice?.joinsEnd ?? false;
  const warn = refusal !== null || (choice?.blocked ?? false);
  return {
    tone: warn ? "warn" : "track",
    title: refusal !== null ? "Nothing laid" : choice ? extendTitle(choice) : "Next piece",
    detail: refusal ?? (choice ? extendDetail(choice, extend) : null),
    hints: [
      gesture("Click", "lay it"),
      key("extend-straight", "straight"),
      key("extend-left", "left"),
      key("extend-right", "right"),
      key("extend-preview", joins ? "join" : "lay it"),
      key("next-track-choice", "other choices"),
      key("undo", "undo"),
      key("select-tool", extend.continuing ? "let go of the end" : "done"),
    ],
  };
}

function trackView(snapshot: EditorSnapshot): ToolHintView {
  const track = snapshot.track;
  const drag = track?.drag ?? null;
  if (drag) return { ...dragView(drag), hints: [key("select-tool", "stop drawing")] };
  const held = track?.held ?? null;
  if (held) {
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
  const refusal = releaseRefusal(track?.lastCommit ?? null);
  const extend = track?.extend ?? null;
  if (extend) return extendView(extend, refusal);
  return {
    tone: refusal !== null ? "warn" : "track",
    title: refusal !== null ? "Nothing laid" : "Drawing track",
    detail: refusal ?? "point at an open end to add the next piece",
    hints: [gesture("Drag", "lay track"), key("undo", "undo"), key("draw-track", "done")],
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
    case "track":
      return trackView(snapshot);
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
      (hint) => hint.kind === "gesture" || commandEnabled(hint.command, snapshot, play),
    ),
  };
}

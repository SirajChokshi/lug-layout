import { inject, injectable } from "inversify";
import type { EditorSnapshot, IEditor, RefusedEdit } from "../edit/editor.ts";
import { EDITOR, TOUR_MEMORY } from "../tokens.ts";
import type { ITourMemory } from "./tour-memory.ts";

export type TourStepId = "look" | "place" | "rotate" | "track" | "undo";

export interface TourStepView {
  readonly id: TourStepId;
  readonly title: string;
  readonly hint: string;
  readonly keys: ReadonlyArray<string>;
}

export type TourState = "off" | "running" | "finished";

export interface TourView {
  readonly state: TourState;
  readonly offered: boolean;
  readonly step: number;
  readonly steps: ReadonlyArray<TourStepView>;
}

export type ToastKind = "celebrate" | "info" | "warn";

export interface ToastView {
  readonly id: number;
  readonly kind: ToastKind;
  readonly title: string;
  readonly detail: string;
}

export interface CoachSnapshot {
  readonly tour: TourView;
  readonly toasts: ReadonlyArray<ToastView>;
}

export interface ICoach {
  subscribe(listener: () => void): () => void;
  snapshot(): CoachSnapshot;
  startTour(): void;
  endTour(): void;
  loadStarter(id: string, eventTimeMs: number): void;
  dismissToast(id: number): void;
}

interface TourStep extends TourStepView {
  done(from: EditorSnapshot, now: EditorSnapshot): boolean;
}

const MAX_TOASTS = 3;

function trackPieces(snapshot: EditorSnapshot): number {
  return snapshot.track?.pieces ?? 0;
}

const TOUR_STEPS: ReadonlyArray<TourStep> = [
  {
    id: "look",
    title: "Look around",
    hint: "Right-drag to orbit, Shift-drag to pan and scroll to zoom.",
    keys: ["Right-drag", "Wheel"],
    done: (from, now) => now.viewMoves > from.viewMoves,
  },
  {
    id: "place",
    title: "Put down a baseplate",
    hint: "Pick a colour under Baseplates in the palette, then click the ground. Pieces land on whole studs.",
    keys: ["Click"],
    done: (from, now) => now.placements > from.placements,
  },
  {
    id: "rotate",
    title: "Turn it",
    hint: "Press R to turn the piece in your hand, or click a placed piece and press R.",
    keys: ["R"],
    done: (from, now) => now.ghostRot !== from.ghostRot || now.history.undo === "rotate",
  },
  {
    id: "track",
    title: "Lay some track",
    hint: "Press T, then drag across the ground. Release on an open end and the run joins it exactly.",
    keys: ["T", "Drag"],
    done: (from, now) => trackPieces(now) > trackPieces(from),
  },
  {
    id: "undo",
    title: "Change your mind",
    hint: "Ctrl+Z undoes your last placement and Ctrl+Shift+Z brings it back.",
    keys: ["Ctrl+Z"],
    done: (from, now) => now.history.redoDepth > from.history.redoDepth,
  },
];

function stepView({ id, title, hint, keys }: TourStep): TourStepView {
  return { id, title, hint, keys };
}

function refusalTitle(refusal: RefusedEdit): string {
  switch (refusal.action) {
    case "place":
      return "That doesn't fit there";
    case "track":
      return "The track can't go there";
    case "rotate":
      return "It can't turn there";
    case "remove":
      return "That can't come away yet";
    default: {
      const unhandled: never = refusal.action;
      throw new Error(`unhandled refused action ${String(unhandled)}`);
    }
  }
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

@injectable()
export class Coach implements ICoach {
  private readonly listeners = new Set<() => void>();
  private state: CoachSnapshot = {
    tour: { state: "off", offered: false, step: 0, steps: TOUR_STEPS.map(stepView) },
    toasts: [],
  };
  private previous: EditorSnapshot;
  private stepFrom: EditorSnapshot;
  private nextToastId = 1;
  private loadingStarter = false;

  constructor(
    @inject(EDITOR) private readonly editor: IEditor,
    @inject(TOUR_MEMORY) private readonly memory: ITourMemory,
  ) {
    const offered = !memory.visited() && !memory.tourDone();
    memory.markVisited();
    this.state = { ...this.state, tour: { ...this.state.tour, offered } };
    this.previous = editor.snapshot();
    this.stepFrom = this.previous;
    editor.subscribe(() => this.observe(editor.snapshot()));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): CoachSnapshot {
    return this.state;
  }

  startTour(): void {
    this.stepFrom = this.editor.snapshot();
    this.setTour("running", 0);
  }

  endTour(): void {
    this.memory.rememberTourDone();
    this.setTour("off", 0);
  }

  loadStarter(id: string, eventTimeMs: number): void {
    const starter = this.editor.snapshot().starters.find((candidate) => candidate.id === id);
    this.loadingStarter = true;
    try {
      this.editor.loadStarter(id, eventTimeMs);
    } finally {
      this.loadingStarter = false;
    }
    const now = this.editor.snapshot();
    const refused = now.refusals > this.previous.refusals ? now.lastRefusal : null;
    this.previous = now;
    this.stepFrom = now;
    if (refused) {
      this.toastRefusal(refused);
      return;
    }
    if (!starter || now.placements + trackPieces(now) === 0) return;
    const track =
      now.track && now.track.pieces > 0
        ? `${plural(now.track.pieces, "track piece", "track pieces")}, ${plural(now.track.openEnds, "open end", "open ends")}. `
        : "";
    this.toast(
      "info",
      `${starter.title} is ready`,
      `${track}It's all yours: move things, add more, or press T to extend the line.`,
    );
  }

  dismissToast(id: number): void {
    this.commit({ toasts: this.state.toasts.filter((toast) => toast.id !== id) });
  }

  private setTour(state: TourState, step: number): void {
    this.commit({ tour: { ...this.state.tour, state, step, offered: false } });
  }

  private commit(patch: Partial<CoachSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private toast(kind: ToastKind, title: string, detail: string): void {
    const toast: ToastView = { id: this.nextToastId++, kind, title, detail };
    this.commit({ toasts: [...this.state.toasts, toast].slice(-MAX_TOASTS) });
  }

  private observe(now: EditorSnapshot): void {
    if (this.loadingStarter) return;
    const before = this.previous;
    this.previous = now;
    this.noticeTrack(before, now);
    this.noticeRefusal(before, now);
    this.advanceTour(now);
  }

  private noticeTrack(before: EditorSnapshot, now: EditorSnapshot): void {
    const released = before.track?.drag && !now.track?.drag;
    if (!released || !now.track) return;
    const laid = now.track.pieces - (before.track?.pieces ?? 0);
    switch (now.track.lastCommit) {
      case "joined":
        if (laid <= 0) return;
        this.toast(
          "celebrate",
          now.track.openEnds === 0 ? "Loop closed!" : "Joined!",
          `${plural(laid, "piece", "pieces")} laid, and the last one meets the open end exactly. No fudging, no gap.`,
        );
        return;
      case "refused-impossible":
        this.toast(
          "warn",
          "Those ends can't meet",
          "No run of 9V straights and R40 curves joins them exactly. Try another open end or come in from a different angle.",
        );
        return;
      case "refused-limit":
        this.toast(
          "warn",
          "That join is a long way round",
          "The search ran out of time before finding an exact join. Drag closer to the open end and try again.",
        );
        return;
      case "laid":
      case "refused-off-baseplate":
      case "refused-overlap":
      case "refused-crosses-track":
      case null:
        return;
      default: {
        const unhandled: never = now.track.lastCommit;
        throw new Error(`unhandled commit ${String(unhandled)}`);
      }
    }
  }

  private noticeRefusal(before: EditorSnapshot, now: EditorSnapshot): void {
    if (now.refusals <= before.refusals || !now.lastRefusal) return;
    this.toastRefusal(now.lastRefusal);
  }

  private toastRefusal(refusal: RefusedEdit): void {
    this.toast("warn", refusalTitle(refusal), refusal.message);
  }

  private advanceTour(now: EditorSnapshot): void {
    const { tour } = this.state;
    if (tour.state !== "running") return;
    const step = TOUR_STEPS[tour.step];
    if (!step || !step.done(this.stepFrom, now)) return;
    this.stepFrom = now;
    const next = tour.step + 1;
    if (next < TOUR_STEPS.length) {
      this.setTour("running", next);
      return;
    }
    this.memory.rememberTourDone();
    this.setTour("finished", next);
    this.toast(
      "celebrate",
      "You've got the basics",
      "Everything you place is a real part, and every track joint is exact. Have fun building!",
    );
  }
}

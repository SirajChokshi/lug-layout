import { decode, decodedOrThrow } from "@brr/schema/decode";
import {
  STARTER_SHELF_FILE,
  StarterShelfV1,
  starterFilePath,
  type StarterV1,
} from "@brr/schema/starters";
import { MANIFEST_FILE, decodeWorldManifest, parseJsonText } from "@brr/schema/world";
import { inject, injectable } from "inversify";
import type { IEditor } from "../edit/editor.ts";
import { errorText } from "../edit/error-text.ts";
import type { IWorldSession } from "../edit/world-session.ts";
import type { IPlanService } from "../plan/plan-service.ts";
import { EDITOR, PLAN_SERVICE, STARTER_FILES, WORLD_SESSION } from "../tokens.ts";
import type { IStarterFiles } from "./starter-files.ts";

export interface StarterWorldView {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly placements: number;
  readonly track: number;
}

export type StarterShelfStatus = "unread" | "reading" | "ready" | "failed";

export interface WelcomeView {
  readonly open: boolean;
  readonly shelf: StarterShelfStatus;
  readonly starters: ReadonlyArray<StarterWorldView>;
  readonly opening: string | null;
  readonly error: string | null;
}

export interface IStarterWorlds {
  view(): WelcomeView;
  subscribe(listener: () => void): () => void;
  show(): void;
  dismiss(): void;
  open(id: string): Promise<boolean>;
}

type Offer = "none" | "emptyWorld" | "asked";

const UNREAD: WelcomeView = {
  open: false,
  shelf: "unread",
  starters: [],
  opening: null,
  error: null,
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

function sameView(a: WelcomeView, b: WelcomeView): boolean {
  return (
    a.open === b.open &&
    a.shelf === b.shelf &&
    a.starters === b.starters &&
    a.opening === b.opening &&
    a.error === b.error
  );
}

@injectable()
export class StarterWorlds implements IStarterWorlds {
  private readonly listeners = new Set<() => void>();
  private state = UNREAD;
  private offer: Offer = "none";
  private ready = false;
  private seenWorld = false;
  private worldId: string | null = null;

  constructor(
    @inject(EDITOR) private readonly editor: Pick<IEditor, "snapshot" | "subscribe">,
    @inject(WORLD_SESSION) private readonly session: Pick<IWorldSession, "importWorldFiles">,
    @inject(STARTER_FILES) private readonly files: IStarterFiles,
    @inject(PLAN_SERVICE) private readonly plans: Pick<IPlanService, "plans">,
  ) {
    editor.subscribe(() => this.editorChanged());
    this.editorChanged();
  }

  view(): WelcomeView {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  show(): void {
    this.offer = "asked";
    this.publish({});
  }

  dismiss(): void {
    this.offer = "none";
    this.publish({ error: null });
  }

  async open(id: string): Promise<boolean> {
    if (this.state.opening !== null || !this.state.starters.some((s) => s.id === id)) return false;
    this.publish({ opening: id, error: null });
    let opened = false;
    let error: string | null = null;
    try {
      opened = await this.session.importWorldFiles(await this.filesOf(id));
      if (!opened) error = this.editor.snapshot().fileError ?? "the starter can't be opened";
    } catch (caught) {
      error = errorText(caught);
    }
    if (opened) this.offer = "none";
    this.publish({ opening: null, error });
    return opened;
  }

  private editorChanged(): void {
    const { status, world, readOnly, placements, track } = this.editor.snapshot();
    this.ready = status === "ready" && world !== null;
    if (this.ready && world !== null) {
      const empty =
        placements === 0 && (track?.pieces ?? 0) === 0 && this.plans.plans().length === 0;
      if (!this.seenWorld || world.id !== this.worldId) {
        this.seenWorld = true;
        this.worldId = world.id;
        this.offer = empty && !readOnly ? "emptyWorld" : "none";
      } else if (this.offer === "emptyWorld" && (!empty || readOnly)) {
        this.offer = "none";
      }
    }
    if (this.offered() !== this.state.open) this.publish({});
  }

  private offered(): boolean {
    return this.ready && this.offer !== "none";
  }

  private publish(patch: Partial<WelcomeView>): void {
    const next = { ...this.state, ...patch, open: this.offered() };
    if (sameView(next, this.state)) return;
    this.state = next;
    for (const listener of this.listeners) listener();
    if (next.open && next.shelf === "unread") void this.readShelf();
  }

  private async readShelf(): Promise<void> {
    this.publish({ shelf: "reading" });
    try {
      const shelf = decodedOrThrow(
        decode(StarterShelfV1, await this.json(STARTER_SHELF_FILE), STARTER_SHELF_FILE),
        "the starter list can't be read",
      );
      const starters = await Promise.all(
        shelf.starters.map((starter) => this.starterView(starter)),
      );
      this.publish({ shelf: "ready", starters });
    } catch (error) {
      this.publish({ shelf: "failed", error: errorText(error) });
    }
  }

  private async starterView(starter: StarterV1): Promise<StarterWorldView> {
    const path = starterFilePath(starter.world, MANIFEST_FILE);
    const manifest = decodedOrThrow(
      decodeWorldManifest(await this.json(path), path),
      `the starter ${starter.world} can't be read`,
    );
    return {
      id: starter.world,
      name: manifest.name,
      summary: starter.summary,
      placements: manifest.placements,
      track: manifest.track,
    };
  }

  private async json(path: string): Promise<unknown> {
    const text = utf8.decode(await this.files.read(path));
    return decodedOrThrow(parseJsonText(text, path), `${path} can't be read`);
  }

  private async filesOf(id: string): Promise<ReadonlyMap<string, Uint8Array>> {
    const directory = starterFilePath(id, "");
    const paths = this.files.paths().filter((path) => path.startsWith(directory));
    const read = await Promise.all(
      paths.map(
        async (path) => [path.slice(directory.length), await this.files.read(path)] as const,
      ),
    );
    return new Map(read);
  }
}

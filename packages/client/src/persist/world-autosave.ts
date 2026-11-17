import { PART_BUNDLE_LOADER, type IPartBundleLoader } from "@brr/catalog";
import { decode, type Issue } from "@brr/schema/decode";
import {
  MANIFEST_FILE,
  WorldManifestV1,
  WorldShardV1,
  readWorldArchive,
  shardEntry,
  worldArchiveFiles,
  worldManifest,
  worldShards,
  worldTrack,
} from "@brr/schema/world";
import { inject, injectable } from "inversify";
import type { ICredits } from "../credits/credits-service.ts";
import type { IEditor } from "../edit/editor.ts";
import { CREDITS, EDITOR, WORLD_STORE } from "../tokens.ts";
import type { IWorldStore, WorldFile } from "./world-store.ts";

export const AUTOSAVE_WORLD = "autosave";
const AUTOSAVE_NAME = "Autosave";
const SAVE_DELAY_MS = 300;
const ARCHIVE_LOD = "standard";

export type AutosaveState = "starting" | "saved" | "pending" | "saving" | "elsewhere" | "failed";

export interface RestoredWorldView {
  readonly placements: number;
  readonly track: number;
  readonly savedAt: number;
  readonly exact: boolean;
}

export interface SetAsideView {
  readonly as: string;
  readonly issues: ReadonlyArray<Issue>;
}

export interface AutosaveView {
  readonly state: AutosaveState;
  readonly savedAt: number | null;
  readonly restored: RestoredWorldView | null;
  readonly setAside: SetAsideView | null;
  readonly error: string | null;
}

export interface IWorldAutosave {
  start(disclaimer: string): Promise<void>;
  flush(): Promise<void>;
  subscribe(listener: () => void): () => void;
  snapshot(): AutosaveView;
}

function shardOrManifestIssues(file: WorldFile): ReadonlyArray<Issue> {
  if (!file.name.endsWith(".json")) return [];
  const schema = file.name === MANIFEST_FILE ? WorldManifestV1 : WorldShardV1;
  const decoded = decode(schema, JSON.parse(file.text), file.name);
  return decoded.ok ? [] : decoded.issues;
}

@injectable()
export class WorldAutosave implements IWorldAutosave {
  private readonly listeners = new Set<() => void>();
  private state: AutosaveView = {
    state: "starting",
    savedAt: null,
    restored: null,
    setAside: null,
    error: null,
  };
  private started = false;
  private disclaimer = "";
  private bundleVersion = "";
  private creditsText = "";
  private saved: ReadonlyMap<string, string> = new Map();
  private revision = -1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    @inject(EDITOR) private readonly editor: IEditor,
    @inject(WORLD_STORE) private readonly store: IWorldStore,
    @inject(CREDITS) private readonly credits: ICredits,
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): AutosaveView {
    return this.state;
  }

  private update(patch: Partial<AutosaveView>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  async start(disclaimer: string): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.disclaimer = disclaimer;
    try {
      await this.editorReady();
      const [manifest, credits] = await Promise.all([
        this.loader.loadManifest(ARCHIVE_LOD),
        this.credits.load(),
      ]);
      this.bundleVersion = manifest.bundleVersion;
      this.creditsText = this.credits.exportText(credits);
      if (!(await this.store.claim(AUTOSAVE_WORLD))) {
        this.update({ state: "elsewhere" });
        return;
      }
      await this.restore();
      this.revision = this.editor.snapshot().revision;
      this.editor.subscribe(() => this.editorChanged());
      if (this.state.state === "starting") this.update({ state: "saved" });
    } catch (error) {
      this.update({ state: "failed", error: String(error) });
    }
  }

  private editorReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        const { status, error } = this.editor.snapshot();
        if (status === "ready") resolve();
        else if (status === "error") reject(new Error(error ?? "the editor failed to start"));
        else return false;
        return true;
      };
      if (check()) return;
      const stop = this.editor.subscribe(() => {
        if (check()) stop();
      });
    });
  }

  private async restore(): Promise<void> {
    const stored = await this.store.read(AUTOSAVE_WORLD);
    if (!stored) return;
    const archive = readWorldArchive(stored.files);
    const issues = archive.ok
      ? this.editor.loadWorld({
          placements: archive.value.shards.flatMap((shard) => shard.placements),
          track: worldTrack(archive.value.shards),
          view: archive.value.manifest.view,
        })
      : archive.issues;
    if (issues.length > 0) {
      const as = `unreadable-${stored.savedAt}`;
      await this.store.move(AUTOSAVE_WORLD, as);
      this.update({ setAside: { as, issues } });
      return;
    }
    this.saved = stored.files;
    const reloaded = this.archiveFiles();
    const exact =
      reloaded.size === stored.files.size &&
      [...reloaded].every(([name, text]) => stored.files.get(name) === text);
    const { placements, track } = this.editor.worldRecords();
    this.update({
      savedAt: stored.savedAt,
      restored: {
        placements: placements.length,
        track: track.length,
        savedAt: stored.savedAt,
        exact,
      },
    });
  }

  private editorChanged(): void {
    const { revision } = this.editor.snapshot();
    if (revision === this.revision) return;
    this.revision = revision;
    if (this.state.state !== "pending") this.update({ state: "pending" });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), SAVE_DELAY_MS);
  }

  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.writing = this.writing.then(() => this.save());
    return this.writing;
  }

  private archiveFiles(): ReadonlyMap<string, string> {
    const { placements, track, view } = this.editor.worldRecords();
    const shards = worldShards(placements, track);
    const header = {
      name: AUTOSAVE_NAME,
      bundleVersion: this.bundleVersion,
      view,
      disclaimer: this.disclaimer,
    };
    const files = worldArchiveFiles({
      manifest: worldManifest(header, shards.map(shardEntry)),
      shards,
      credits: this.creditsText,
    });
    return new Map(files.map((file) => [file.name, file.text]));
  }

  private async save(): Promise<void> {
    if (this.state.state === "elsewhere" || this.state.state === "starting") return;
    try {
      const files = this.archiveFiles();
      const put: WorldFile[] = [];
      for (const [name, text] of files) {
        if (this.saved.get(name) !== text) put.push({ name, text });
      }
      const remove = [...this.saved.keys()].filter((name) => !files.has(name));
      if (put.length === 0 && remove.length === 0) {
        this.update({ state: "saved" });
        return;
      }
      const unreadable = put.flatMap(shardOrManifestIssues);
      if (unreadable.length > 0) {
        this.update({
          state: "failed",
          error: `not saved, the layout would not read back: ${unreadable
            .map((issue) => `${issue.path} ${issue.message}`)
            .join("; ")}`,
        });
        return;
      }
      this.update({ state: "saving" });
      const savedAt = Date.now();
      await this.store.write(AUTOSAVE_WORLD, { put, remove, savedAt });
      this.saved = files;
      this.update({
        state: this.timer === undefined ? "saved" : "pending",
        savedAt,
        error: null,
      });
    } catch (error) {
      this.update({ state: "failed", error: String(error) });
    }
  }
}

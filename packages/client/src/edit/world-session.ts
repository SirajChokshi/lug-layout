import {
  DirtyShards,
  worldPlacements,
  type AppliedEdit,
  type TrackPieceAt,
  type World,
} from "@brr/domain";
import { CAMERA_FOV_DEGREES } from "@brr/render";
import { decode, issueText, type Decoded, type Issue } from "@brr/schema/decode";
import {
  WORLD_NAME_MAX_LENGTH,
  WorldName,
  referencedImports,
  shardEntry,
  worldHeader,
  worldManifest,
  worldShards,
  type ConsistRecordV1,
  type ImportedFile,
  type SavedViewV1,
  type TrackRecordV1,
  type WorldFiles,
  type WorldHeader,
  type WorldIndexEntry,
  type WorldManifestV1,
  type WorldShardV1,
} from "@brr/schema/world";
import {
  WORLD_LOCKS,
  WORLD_REPOSITORY,
  contentSha256,
  type IWorldLocks,
  type IWorldRepository,
  type WorldLease,
} from "@brr/storage";
import { inject, injectable } from "inversify";
import type { IEditorCamera } from "../camera/editor-camera.ts";
import { ViewCamera } from "../camera/view-camera.ts";
import type { ICredits } from "../credits/credits-service.ts";
import type { CreditsView } from "../credits/credits-view.ts";
import type { ModelCredit } from "../scene/viewer-scene.ts";
import { CREDITS, EDITOR_CAMERA, TRADEMARK_DISCLAIMER } from "../tokens.ts";
import { errorText } from "./error-text.ts";
import { creditsForWorld, exportFileName } from "./world-credits.ts";

export type SaveState = "saved" | "saving" | "failed" | "off";

export interface WorldFileView {
  readonly id: string | null;
  readonly name: string;
  readonly placements: number;
  readonly track: number;
  readonly shards: number;
  readonly save: SaveState;
  readonly pinnedBundleVersion: string;
  readonly openMs: number;
}

export interface ExportedWorld {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export interface WorldSessionView {
  readonly world: WorldFileView | null;
  readonly worlds: ReadonlyArray<WorldIndexEntry>;
  readonly fileError: string | null;
  readonly storageError: string | null;
  readonly readOnly: boolean;
  readonly unsavedEdits: boolean;
}

export interface WorldContents {
  readonly world: World;
  readonly refs: ReadonlyArray<string>;
  readonly track: ReadonlyArray<TrackRecordV1>;
  readonly consists: ReadonlyArray<ConsistRecordV1>;
}

export interface StoredContents {
  readonly shards: ReadonlyArray<WorldShardV1>;
  readonly consists: ReadonlyArray<ConsistRecordV1>;
}

export interface IEditedWorld {
  contents(): WorldContents;
  placedCredits(): ReadonlyArray<ModelCredit>;
  validate(stored: StoredContents): ReadonlyArray<Issue>;
  load(stored: StoredContents): Promise<ReadonlyArray<Issue>>;
  addImportedModel(file: ImportedFile): Promise<string | null>;
}

export interface IWorldFiles {
  readonly worldNameMaxLength: number;
  worldNameIssue(name: string): string | null;
  newWorld(name: string): Promise<boolean>;
  openWorld(id: string): Promise<boolean>;
  deleteWorld(id: string): Promise<boolean>;
  retrySave(): Promise<void>;
  exportWorld(): Promise<ExportedWorld>;
  importWorld(bytes: Uint8Array): Promise<boolean>;
}

export interface IWorldSession extends IWorldFiles {
  view(): WorldSessionView;
  subscribe(listener: () => void): () => void;
  start(edited: IEditedWorld, bundleVersion: string): Promise<void>;
  placementsEdited(edit: AppliedEdit): void;
  trackEdited(lifted: ReadonlyArray<TrackPieceAt>): void;
  pollCamera(): void;
  addModelFile(file: ModelFileInput): Promise<string | null>;
  importWorldFiles(files: ReadonlyMap<string, Uint8Array>): Promise<boolean>;
}

export interface ModelFileInput {
  readonly name: string;
  readonly bytes: Uint8Array;
}

const CAMERA_SAVE_DELAY_MS = 500;
const UNSEEN = Number.NaN;
const FIRST_WORLD_NAME = "World 1";
const NOTHING_STORED: StoredContents = { shards: [], consists: [] };

function storedContents(manifest: WorldManifestV1, shards: ReadonlyArray<WorldShardV1>) {
  return { shards, consists: manifest.consists ?? [] };
}

interface OpenWorld {
  readonly id: string | null;
  readonly name: string;
  readonly pinnedBundleVersion: string;
  readonly openMs: number;
}

class ViewRecord implements SavedViewV1 {
  targetX = UNSEEN;
  targetY = UNSEEN;
  targetZ = UNSEEN;
  distance = UNSEEN;
  yaw = UNSEEN;
  pitch = UNSEEN;
}

@injectable()
export class WorldSession implements IWorldSession {
  readonly worldNameMaxLength = WORLD_NAME_MAX_LENGTH;
  private readonly listeners = new Set<() => void>();
  private state: WorldSessionView = {
    world: null,
    worlds: [],
    fileError: null,
    storageError: null,
    readOnly: false,
    unsavedEdits: false,
  };
  private edited: IEditedWorld | null = null;
  private bundleVersion = "";
  private readonly dirty = new DirtyShards();
  private current: OpenWorld | null = null;
  private cameraDirty = false;
  private consistsDirty = false;
  private readonly lastView = new ViewRecord();
  private saveScheduled = false;
  private cameraSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private cameraSaveDueMs = 0;
  private fileQueue: Promise<void> = Promise.resolve();
  private creditsView: Promise<CreditsView> | null = null;
  private lease: WorldLease | null = null;
  private saveFailed = false;
  private lastSaveError: string | null = null;
  private readonly importedFiles = new Map<string, ImportedFile>();

  constructor(
    @inject(WORLD_REPOSITORY) private readonly repository: IWorldRepository,
    @inject(WORLD_LOCKS) private readonly locks: IWorldLocks,
    @inject(EDITOR_CAMERA) private readonly camera: IEditorCamera,
    @inject(CREDITS) private readonly credits: ICredits,
    @inject(TRADEMARK_DISCLAIMER) private readonly disclaimer: string,
  ) {}

  view(): WorldSessionView {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<WorldSessionView>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  async start(edited: IEditedWorld, bundleVersion: string): Promise<void> {
    this.edited = edited;
    this.bundleVersion = bundleVersion;
    await this.openFirstWorld();
  }

  private editedWorld(): IEditedWorld {
    if (!this.edited) throw new Error("the world session has no edited world before it starts");
    return this.edited;
  }

  private header(current: OpenWorld): WorldHeader {
    const { consists } = this.editedWorld().contents();
    return {
      name: current.name,
      bundleVersion: this.bundleVersion,
      view: this.camera.savedView(),
      disclaimer: this.disclaimer,
      ...(consists.length > 0 ? { consists: [...consists] } : {}),
    };
  }

  private inFileQueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.fileQueue.then(task);
    this.fileQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  placementsEdited(edit: AppliedEdit): void {
    for (const change of edit.changes) {
      if (change.from) this.dirty.touch(change.from.x, change.from.z);
      if (change.to) this.dirty.touch(change.to.x, change.to.z);
    }
    if (edit.consists.length > 0) this.consistsDirty = true;
    this.scheduleSave();
  }

  trackEdited(lifted: ReadonlyArray<TrackPieceAt>): void {
    this.dirty.touchTrackPieces(lifted);
    this.dirty.touchTrack(this.editedWorld().contents().track);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    this.syncUnsaved();
    if (this.saveScheduled) return;
    this.saveScheduled = true;
    setTimeout(() => {
      this.saveScheduled = false;
      void this.inFileQueue(() => this.saveNow());
    }, 0);
  }

  pollCamera(): void {
    if (this.camera.matchesView(this.lastView)) return;
    this.camera.copyView(this.lastView);
    if (this.current !== null) this.cameraMoved();
  }

  private cameraMoved(): void {
    this.cameraDirty = true;
    this.cameraSaveDueMs = performance.now() + CAMERA_SAVE_DELAY_MS;
    if (this.cameraSaveTimer === null) {
      this.cameraSaveTimer = setTimeout(this.saveSettledCamera, CAMERA_SAVE_DELAY_MS);
    }
  }

  private readonly saveSettledCamera = (): void => {
    const remainingMs = this.cameraSaveDueMs - performance.now();
    if (remainingMs > 0) {
      this.cameraSaveTimer = setTimeout(this.saveSettledCamera, remainingMs);
      return;
    }
    this.cameraSaveTimer = null;
    void this.inFileQueue(() => this.saveNow());
  };

  private canSave(): boolean {
    return (
      this.current !== null &&
      this.current.id !== null &&
      this.state.storageError === null &&
      !this.state.readOnly
    );
  }

  private async saveNow(): Promise<void> {
    const current = this.current;
    if (!current || current.id === null || !this.canSave()) return;
    if (this.dirty.size === 0 && !this.cameraDirty && !this.consistsDirty) return;
    const contents = this.editedWorld().contents();
    const change = this.dirty.take(contents.world, contents.refs, contents.track);
    const cameraWasDirty = this.cameraDirty;
    const consistsWereDirty = this.consistsDirty;
    this.cameraDirty = false;
    this.consistsDirty = false;
    this.setWorldView(current, { save: "saving" });
    try {
      const summary = await this.repository.save(current.id, {
        header: this.header(current),
        put: change.put,
        drop: change.drop,
      });
      this.current = { ...current, pinnedBundleVersion: this.bundleVersion };
      const unsaved = this.dirty.size > 0 || this.cameraDirty || this.consistsDirty;
      this.setWorldView(this.current, {
        save: unsaved ? "saving" : "saved",
        placements: summary.placements,
        track: summary.track,
        shards: summary.shards,
      });
      this.update({
        worlds: this.state.worlds.map((item) => (item.id === summary.id ? summary : item)),
        ...(this.saveFailed ? { fileError: null } : {}),
      });
      this.saveFailed = false;
      this.lastSaveError = null;
      this.syncUnsaved();
    } catch (error) {
      this.dirty.restore(change);
      this.cameraDirty ||= cameraWasDirty;
      this.consistsDirty ||= consistsWereDirty;
      this.saveFailed = true;
      this.lastSaveError = errorText(error);
      this.syncUnsaved();
      this.setWorldView(current, { save: "failed" });
      this.update({
        fileError: `saving failed: ${errorText(error)}. The edits stay in this tab and are saved with the next change.`,
      });
    }
  }

  private syncUnsaved(): void {
    const unsavedEdits =
      this.dirty.size > 0 ||
      this.consistsDirty ||
      (this.state.storageError !== null && this.editedWorld().contents().world.size > 0);
    if (unsavedEdits !== this.state.unsavedEdits) this.update({ unsavedEdits });
  }

  retrySave(): Promise<void> {
    return this.inFileQueue(() => this.saveNow());
  }

  private setWorldView(current: OpenWorld, patch: Partial<WorldFileView>): void {
    const previous = this.state.world?.id === current.id ? this.state.world : null;
    this.update({
      world: {
        id: current.id,
        name: current.name,
        placements: previous?.placements ?? 0,
        track: previous?.track ?? 0,
        shards: previous?.shards ?? 0,
        save: previous?.save ?? "saved",
        pinnedBundleVersion: current.pinnedBundleVersion,
        openMs: current.openMs,
        ...patch,
      },
    });
  }

  private async refreshWorlds(): Promise<void> {
    if (this.state.storageError !== null) return;
    this.update({ worlds: await this.repository.list() });
  }

  private async openFirstWorld(): Promise<void> {
    let worlds: ReadonlyArray<WorldIndexEntry>;
    try {
      worlds = await this.repository.list();
    } catch (error) {
      await this.startWithoutStorage(errorText(error));
      return;
    }
    const [latest] = worlds;
    try {
      if (latest) await this.openStored(latest.id);
      else await this.createWorld(FIRST_WORLD_NAME);
    } catch (error) {
      try {
        await this.createWorld(`World ${worlds.length + 1}`);
      } catch (fallback) {
        await this.startWithoutStorage(errorText(fallback));
        return;
      }
      this.update({ fileError: `opening "${latest?.name ?? ""}" failed: ${errorText(error)}` });
    }
    await this.refreshWorlds();
  }

  private async startWithoutStorage(reason: string): Promise<void> {
    const current = {
      id: null,
      name: FIRST_WORLD_NAME,
      pinnedBundleVersion: this.bundleVersion,
      openMs: 0,
    };
    await this.loadEditedWorld(current.name, NOTHING_STORED);
    this.finishOpen(null, current);
    this.setWorldView(current, { placements: 0, shards: 0, save: "off" });
    this.update({ storageError: reason, worlds: [] });
  }

  private async takeLease(id: string): Promise<void> {
    this.lease?.release();
    const lease = await this.locks.hold(id);
    this.lease = lease;
    this.update({ readOnly: !lease.exclusive });
    if (lease.exclusive) return;
    void lease.whenExclusive.then(() =>
      this.fileAction("reopen", async () => {
        if (this.lease !== lease) return;
        try {
          await this.loadWorld(id);
          this.update({ readOnly: false });
        } catch (error) {
          const name = this.current?.name ?? "";
          lease.release();
          this.lease = null;
          this.update({ readOnly: false });
          await this.openLatestOrNew();
          this.update({
            fileError: `"${name}" can't be reopened after the other tab let it go: ${errorText(error)}`,
          });
        }
        await this.refreshWorlds();
      }),
    );
  }

  private async openLatestOrNew(): Promise<void> {
    const [next] = await this.repository.list();
    if (next) await this.openStored(next.id);
    else await this.createWorld(FIRST_WORLD_NAME);
  }

  private async openStored(id: string): Promise<void> {
    await this.takeLease(id);
    await this.loadWorld(id);
  }

  private finishOpen(savedView: SavedViewV1 | null, current: OpenWorld): void {
    this.camera.restoreView(savedView);
    this.camera.copyView(this.lastView);
    this.current = current;
    this.dirty.clear();
    this.cameraDirty = false;
    this.consistsDirty = false;
    this.saveFailed = false;
    this.lastSaveError = null;
    this.update({ fileError: null });
    this.syncUnsaved();
  }

  private async createWorld(name: string): Promise<void> {
    const started = performance.now();
    const summary = await this.repository.create(
      {
        name,
        bundleVersion: this.bundleVersion,
        view: new ViewCamera(CAMERA_FOV_DEGREES).savedView(),
        disclaimer: this.disclaimer,
      },
      [],
    );
    await this.takeLease(summary.id);
    const current = {
      id: summary.id,
      name,
      pinnedBundleVersion: this.bundleVersion,
      openMs: performance.now() - started,
    };
    await this.loadEditedWorld(name, NOTHING_STORED);
    this.finishOpen(null, current);
    this.setWorldView(current, { placements: 0, shards: 0, save: "saved" });
  }

  private async loadEditedWorld(name: string, stored: StoredContents): Promise<void> {
    const issues = await this.editedWorld().load(stored);
    if (issues.length > 0) {
      throw new Error(`world "${name}" can't be opened: ${issueText(issues)}`);
    }
  }

  private async loadShards(
    id: string | null,
    manifest: WorldManifestV1,
    shards: ReadonlyArray<WorldShardV1>,
    started: number,
  ): Promise<void> {
    await this.loadEditedWorld(manifest.name, storedContents(manifest, shards));
    const opened = {
      id,
      name: manifest.name,
      pinnedBundleVersion: manifest.bundleVersion,
      openMs: performance.now() - started,
    };
    this.finishOpen(manifest.view, opened);
    this.setWorldView(opened, {
      placements: manifest.placements,
      track: manifest.track,
      shards: manifest.shards.length,
      save: id === null ? "off" : "saved",
    });
  }

  private async loadWorld(id: string): Promise<void> {
    const started = performance.now();
    const stored = await this.repository.read(id);
    if (!stored.ok) throw new Error(`world ${id} can't be read: ${issueText(stored.issues)}`);
    await this.ensureImports(storedContents(stored.value.manifest, stored.value.shards), (sha256) =>
      this.repository.importedFile(sha256),
    );
    await this.loadShards(id, stored.value.manifest, stored.value.shards, started);
  }

  private async ensureImports(
    stored: StoredContents,
    fileOf: (sha256: string) => Promise<ImportedFile | undefined>,
  ): Promise<void> {
    for (const sha256 of referencedImports(stored.shards, stored.consists)) {
      const file = this.importedFiles.get(sha256) ?? (await fileOf(sha256));
      if (!file) {
        throw new Error(`it places an imported file (sha256 ${sha256}) that isn't stored here`);
      }
      if ((await this.editedWorld().addImportedModel(file)) === null) {
        throw new Error(`the imported file ${file.name} can't be placed any more`);
      }
      this.importedFiles.set(sha256, file);
    }
  }

  private unsavedRefusal(action: string): string | null {
    if (this.state.storageError !== null || this.dirty.size === 0) return null;
    const reason = this.lastSaveError === null ? "" : ` (saving failed: ${this.lastSaveError})`;
    return `${action} refused: "${this.current?.name ?? ""}" has unsaved edits${reason}. Retry the save, or export the world first.`;
  }

  private fileAction(
    action: string,
    task: () => Promise<void>,
    keepsCurrentEdits = false,
  ): Promise<boolean> {
    return this.inFileQueue(async () => {
      await this.saveNow();
      const refusal = keepsCurrentEdits ? null : this.unsavedRefusal(action);
      if (refusal !== null) {
        this.update({ fileError: refusal });
        return false;
      }
      try {
        await task();
        return true;
      } catch (error) {
        this.update({ fileError: `${action} failed: ${errorText(error)}` });
        return false;
      }
    });
  }

  worldNameIssue(name: string): string | null {
    const trimmed = name.trim();
    if (trimmed === "") return null;
    const checked = decode(WorldName, trimmed, "name");
    return checked.ok ? null : checked.issues.map((issue) => issue.message).join("; ");
  }

  newWorld(name: string): Promise<boolean> {
    return this.fileAction("new world", async () => {
      if (this.state.storageError !== null) throw new Error("storage is unavailable");
      const issue = this.worldNameIssue(name);
      if (issue !== null) throw new Error(`the name ${issue}`);
      const trimmed = name.trim();
      await this.createWorld(trimmed === "" ? `World ${this.state.worlds.length + 1}` : trimmed);
      await this.refreshWorlds();
    });
  }

  openWorld(id: string): Promise<boolean> {
    return this.fileAction("open", async () => {
      if (this.state.storageError !== null || this.current?.id === id) return;
      await this.openStored(id);
      await this.refreshWorlds();
    });
  }

  deleteWorld(id: string): Promise<boolean> {
    return this.fileAction(
      "delete",
      async () => {
        if (this.state.storageError !== null) throw new Error("storage is unavailable");
        const current = this.current?.id === id;
        if (current && this.state.readOnly) throw new Error("this world is open in another tab");
        const lease = current ? this.lease : await this.locks.hold(id);
        if (!lease?.exclusive) {
          lease?.release();
          throw new Error("this world is open in another tab");
        }
        await this.repository.remove(id);
        lease.release();
        if (current) {
          this.lease = null;
          await this.openLatestOrNew();
        }
        await this.refreshWorlds();
      },
      true,
    );
  }

  exportWorld(): Promise<ExportedWorld> {
    return this.inFileQueue(async () => {
      await this.saveNow();
      const current = this.current;
      if (!current) throw new Error("no world is open");
      this.creditsView ??= this.credits.load().catch((error: unknown) => {
        this.creditsView = null;
        throw error;
      });
      const edited = this.editedWorld();
      const credits = this.credits.exportText(
        creditsForWorld(await this.creditsView, edited.placedCredits()),
      );
      const contents = edited.contents();
      const shards = worldShards(worldPlacements(contents.world, contents.refs), contents.track);
      const manifest = worldManifest(this.header(current), shards.map(shardEntry));
      const imports = [...referencedImports(shards, contents.consists)].map((sha256) => {
        const file = this.importedFiles.get(sha256);
        if (!file) throw new Error(`the imported file with sha256 ${sha256} isn't loaded`);
        return file;
      });
      return {
        fileName: exportFileName(current.name),
        bytes: this.repository.packArchive({ manifest, shards, credits, imports }),
      };
    });
  }

  importWorld(bytes: Uint8Array): Promise<boolean> {
    return this.importArchive(() => this.repository.readArchive(bytes));
  }

  importWorldFiles(files: ReadonlyMap<string, Uint8Array>): Promise<boolean> {
    return this.importArchive(() => this.repository.readWorldFiles(files));
  }

  private importArchive(read: () => Promise<Decoded<WorldFiles>>): Promise<boolean> {
    return this.fileAction("import", async () => {
      const started = performance.now();
      const archive = await read();
      if (!archive.ok) throw new Error(issueText(archive.issues));
      const { manifest, shards, imports } = archive.value;
      const stored = storedContents(manifest, shards);
      const carried = new Map(imports.map((file) => [file.sha256, file]));
      await this.ensureImports(stored, async (sha256) => carried.get(sha256));
      if (this.state.storageError === null) {
        for (const file of imports) await this.repository.putImportedFile(file);
      }
      const issues = this.editedWorld().validate(stored);
      if (issues.length > 0) throw new Error(issueText(issues));
      if (this.state.storageError !== null) {
        await this.loadShards(null, manifest, shards, started);
        return;
      }
      const summary = await this.repository.create(worldHeader(manifest), shards);
      await this.openStored(summary.id);
      await this.refreshWorlds();
    });
  }

  async addModelFile(input: ModelFileInput): Promise<string | null> {
    let item: string | null = null;
    await this.fileAction(
      "model import",
      async () => {
        const sha256 = await contentSha256(input.bytes);
        const known = this.importedFiles.get(sha256);
        const file = known ?? { sha256, name: input.name, bytes: input.bytes.slice() };
        const placed = await this.editedWorld().addImportedModel(file);
        if (placed === null) return;
        if (!known) {
          this.importedFiles.set(sha256, file);
          if (this.state.storageError === null) await this.repository.putImportedFile(file);
        }
        item = placed;
      },
      true,
    );
    return item;
  }
}

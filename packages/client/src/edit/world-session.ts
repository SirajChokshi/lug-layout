import {
  DirtyShards,
  SavedNoteShards,
  GroupTable,
  LayerTable,
  worldPlacements,
  type AppliedEdit,
  type AppliedGroupChange,
  type PlanRegion,
  type PlanState,
  type TrackPieceAt,
  type World,
} from "@brr/domain";
import { CAMERA_FOV_DEGREES } from "@brr/render";
import { decode, issueText, type Decoded, type Issue } from "@brr/schema/decode";
import {
  BRICKLINK_XML_FILE,
  PARTS_CSV_FILE,
  PLAN_SHEET_FILE,
  REBRICKABLE_CSV_FILE,
  planManifest,
  type PlanOutputs,
  type PlanRecordV2,
} from "@brr/schema/plan";
import {
  DEFAULT_WORLD_DOCUMENT,
  WORLD_NAME_MAX_LENGTH,
  WorldName,
  migrateShardV1,
  noteShardEntry,
  noteShards,
  referencedImports,
  shardEntry,
  shardName,
  worldDocument,
  worldHeader,
  worldManifest,
  worldNotes,
  worldShards,
  worldShardsV1,
  type ConsistRecordV1,
  type EventRecordV2,
  type ImportedFile,
  type NoteRecordV2,
  type KitIndexEntry,
  type KitLibrary,
  type NoteShardV2,
  type PlacementRecordV1,
  type SavedViewV1,
  type TrackRecordV1,
  type TrackRecordV2,
  type WorldDocument,
  type WorldFiles,
  type WorldHeader,
  type WorldIndexEntry,
  type WorldManifestV2,
  type WorldShardV2,
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
import type {
  CreditsView,
  CustomPartCredit,
  ImportedModelCredit,
} from "../credits/credits-view.ts";
import type { IBomService } from "../bom/bom-service.ts";
import type { IEventDetails } from "../event/event-details.ts";
import { NO_PLANS, planRecord, planStateOf, withPlanState } from "../plan/plan-document.ts";
import type { IPlanSheetService, IPlanSheetSource } from "../plan/plan-sheet-service.ts";
import type { ILayerService } from "../layers/layer-service.ts";
import type { ModelCredit } from "../scene/viewer-scene.ts";
import {
  BOM_SERVICE,
  CREDITS,
  EDITOR_CAMERA,
  EVENT_DETAILS,
  LAYER_SERVICE,
  PLAN_SHEET_SERVICE,
  TRADEMARK_DISCLAIMER,
} from "../tokens.ts";
import { errorText } from "./error-text.ts";
import { creditsForPlan, creditsForWorld, exportFileName, planFileName } from "./world-credits.ts";

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
  readonly kits: ReadonlyArray<KitIndexEntry>;
  readonly fileError: string | null;
  readonly storageError: string | null;
  readonly readOnly: boolean;
  readonly unsavedEdits: boolean;
}

export interface WorldContents {
  readonly world: World;
  readonly refs: ReadonlyArray<string>;
  readonly track: ReadonlyArray<TrackRecordV2>;
  readonly consists: ReadonlyArray<ConsistRecordV1>;
  readonly notes: ReadonlyArray<NoteRecordV2>;
  readonly groups: GroupTable;
}

export interface StoredContents {
  readonly shards: ReadonlyArray<WorldShardV2>;
  readonly consists: ReadonlyArray<ConsistRecordV1>;
  readonly notes: ReadonlyArray<NoteRecordV2>;
  readonly document: WorldDocument;
  readonly plans: PlanState;
  readonly groups: GroupTable;
}

export interface PlanImport {
  readonly sha256: string;
  readonly credit: ModelCredit;
  readonly customParts: ReadonlyArray<CustomPartCredit>;
}

export interface MemberRecords {
  readonly placements: ReadonlyArray<PlacementRecordV1>;
  readonly track: ReadonlyArray<TrackRecordV1>;
  readonly placed: ReadonlyArray<ModelCredit>;
}

export interface PlanContents extends MemberRecords {
  readonly region: PlanRegion;
  readonly imported: ReadonlyArray<PlanImport>;
}

export interface StoredPlan {
  readonly plan: PlanRecordV2;
  readonly shards: ReadonlyArray<WorldShardV2>;
}

export interface IEditedWorld extends IPlanSheetSource {
  contents(): WorldContents;
  placedCredits(): ReadonlyArray<ModelCredit>;
  validate(stored: StoredContents): ReadonlyArray<Issue>;
  load(stored: StoredContents): Promise<ReadonlyArray<Issue>>;
  addImportedModel(file: ImportedFile, notice: ModelImportNotice): Promise<ModelFileOutcome>;
  planContents(planId: string): Decoded<PlanContents>;
  addPlan(plan: StoredPlan): Promise<ReadonlyArray<Issue>>;
  selectionContents(): Decoded<MemberRecords>;
  holdKit(name: string, shards: ReadonlyArray<WorldShardV2>): Promise<ReadonlyArray<Issue>>;
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
  exportPlan(planId: string): Promise<ExportedWorld | null>;
  openPlan(bytes: Uint8Array): Promise<boolean>;
  saveKit(name: string, library: KitLibrary): Promise<ExportedWorld | null>;
  placeKit(id: string): Promise<boolean>;
  addKitFile(bytes: Uint8Array): Promise<boolean>;
  exportKit(id: string): Promise<ExportedWorld | null>;
  removeKit(id: string): Promise<boolean>;
}

export interface IWorldSession extends IWorldFiles {
  view(): WorldSessionView;
  subscribe(listener: () => void): () => void;
  start(edited: IEditedWorld, bundleVersion: string): Promise<void>;
  placementsEdited(edit: AppliedEdit): void;
  trackEdited(lifted: ReadonlyArray<TrackPieceAt>): void;
  notesEdited(): void;
  documentEdited(): void;
  plansEdited(plans: PlanState): void;
  groupsEdited(change: AppliedGroupChange): void;
  pollCamera(): void;
  addModelFile(file: ModelFileInput, notice: ModelImportNotice): Promise<ModelFileOutcome>;
  importWorldFiles(files: ReadonlyMap<string, Uint8Array>): Promise<boolean>;
}

export interface ModelFileInput {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export type ModelImportNotice = "announce" | "quiet";

export type ModelFileOutcome =
  | { readonly kind: "added"; readonly item: string }
  | { readonly kind: "refused"; readonly reason: string };

const CAMERA_SAVE_DELAY_MS = 500;
const UNSEEN = Number.NaN;
const FIRST_WORLD_NAME = "World 1";
const NOTHING_STORED: StoredContents = {
  shards: [],
  consists: [],
  notes: [],
  document: DEFAULT_WORLD_DOCUMENT,
  plans: NO_PLANS,
  groups: GroupTable.empty,
};
const UNKEPT_TAGS = "is owned by a contributor, which this editor can't keep yet";

function groupTable(document: WorldDocument): GroupTable {
  const table = GroupTable.of(document.groups, "groups");
  if (!table.ok)
    throw new Error(`a decoded world's groups are refused: ${issueText(table.issues)}`);
  return table.value;
}

function storedContents(
  manifest: WorldManifestV2,
  shards: ReadonlyArray<WorldShardV2>,
  notes: ReadonlyArray<NoteShardV2>,
): Decoded<StoredContents> {
  const plans = planStateOf(manifest);
  if (!plans.ok) return plans;
  return {
    ok: true,
    value: {
      shards,
      consists: manifest.consists ?? [],
      notes: worldNotes(notes),
      document: worldDocument(manifest),
      plans: plans.value,
      groups: groupTable(manifest),
    },
  };
}

function documentTables({ event: _event, ...tables }: WorldDocument): WorldDocument {
  return tables;
}

function openable(
  manifest: WorldManifestV2,
  shards: ReadonlyArray<WorldShardV2>,
  notes: ReadonlyArray<NoteShardV2>,
): StoredContents {
  const stored = storedContents(manifest, shards, notes);
  if (!stored.ok) {
    throw new Error(`world "${manifest.name}" can't be opened: ${issueText(stored.issues)}`);
  }
  return stored.value;
}

function owned(record: { readonly owner?: number }): boolean {
  return record.owner !== undefined;
}

function layerTable(document: WorldDocument): LayerTable {
  const table = LayerTable.of(document.layers, "layers");
  if (!table.ok)
    throw new Error(`a decoded world's layers are refused: ${issueText(table.issues)}`);
  return table.value;
}

function unkeptTagIssues(shards: ReadonlyArray<WorldShardV2>): Issue[] {
  return shards.flatMap((shard) => {
    const path = `shard ${shardName(shard.superChunk)}`;
    return [
      ...shard.placements.flatMap((placement, i) =>
        owned(placement) ? [{ path: `${path}.placements.${i}`, message: UNKEPT_TAGS }] : [],
      ),
      ...shard.track.flatMap((piece, i) =>
        owned(piece) ? [{ path: `${path}.track.${i}`, message: UNKEPT_TAGS }] : [],
      ),
    ];
  });
}

function bySha256(models: ReadonlyArray<PlanImport>): PlanImport[] {
  const sorted = [...models];
  sorted.sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
  return sorted;
}

function byReference(parts: ReadonlyArray<CustomPartCredit>): CustomPartCredit[] {
  const sorted = [...parts];
  sorted.sort((a, b) => (a.reference < b.reference ? -1 : a.reference > b.reference ? 1 : 0));
  return sorted;
}

interface OpenWorld {
  readonly id: string | null;
  readonly name: string;
  readonly pinnedBundleVersion: string;
  readonly openMs: number;
  readonly document: WorldDocument;
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
    kits: [],
    fileError: null,
    storageError: null,
    readOnly: false,
    unsavedEdits: false,
  };
  private edited: IEditedWorld | null = null;
  private bundleVersion = "";
  private readonly dirty = new DirtyShards();
  private readonly savedNotes = new SavedNoteShards();
  private current: OpenWorld | null = null;
  private cameraDirty = false;
  private consistsDirty = false;
  private notesDirty = false;
  private documentDirty = false;
  private plans: PlanState = NO_PLANS;
  private plansDirty = false;
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
    @inject(PLAN_SHEET_SERVICE) private readonly sheets: IPlanSheetService,
    @inject(BOM_SERVICE) private readonly boms: IBomService,
    @inject(EVENT_DETAILS) private readonly events: Pick<IEventDetails, "event" | "restore">,
    @inject(LAYER_SERVICE) private readonly layers: Pick<ILayerService, "table" | "reset">,
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

  private freshHeader(name: string): WorldHeader {
    return {
      name,
      bundleVersion: this.bundleVersion,
      view: new ViewCamera(CAMERA_FOV_DEGREES).savedView(),
      disclaimer: this.disclaimer,
      ...DEFAULT_WORLD_DOCUMENT,
    };
  }

  private header(current: OpenWorld): WorldHeader {
    const { consists, groups } = this.editedWorld().contents();
    const event = this.events.event();
    const { groups: _opened, ...document } = worldDocument(current.document);
    return {
      name: current.name,
      bundleVersion: this.bundleVersion,
      view: this.camera.savedView(),
      disclaimer: this.disclaimer,
      ...(consists.length > 0 ? { consists: [...consists] } : {}),
      ...withPlanState({ ...document, layers: [...this.layers.table().layers] }, this.plans),
      ...(event === null ? {} : { event }),
      ...(groups.groups.length > 0 ? { groups: [...groups.groups] } : {}),
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

  notesEdited(): void {
    this.notesDirty = true;
    this.scheduleSave();
  }

  documentEdited(): void {
    if (this.state.readOnly) return;
    this.documentDirty = true;
    this.scheduleSave();
  }

  plansEdited(plans: PlanState): void {
    this.plans = plans;
    if (this.state.readOnly) return;
    this.plansDirty = true;
    this.scheduleSave();
  }

  groupsEdited(change: AppliedGroupChange): void {
    for (const { member } of change.placements) {
      const handle = member.handle;
      if (handle?.live) this.dirty.touch(handle.x, handle.z);
    }
    const track = this.editedWorld().contents().track;
    this.dirty.touchTrack(change.pieces.flatMap(({ member }) => track[member] ?? []));
    this.documentDirty = true;
    this.scheduleSave();
  }

  private unsavedContent(): boolean {
    return (
      this.dirty.size > 0 ||
      this.consistsDirty ||
      this.notesDirty ||
      this.documentDirty ||
      this.plansDirty
    );
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
    if (!this.unsavedContent() && !this.cameraDirty) return;
    const contents = this.editedWorld().contents();
    const change = this.dirty.take(contents.world, contents.refs, contents.track);
    const notesWereDirty = this.notesDirty;
    const noteChange = notesWereDirty
      ? this.savedNotes.change(contents.notes)
      : { put: [], drop: [] };
    const cameraWasDirty = this.cameraDirty;
    const consistsWereDirty = this.consistsDirty;
    const documentWasDirty = this.documentDirty;
    const plansWereDirty = this.plansDirty;
    this.cameraDirty = false;
    this.consistsDirty = false;
    this.notesDirty = false;
    this.documentDirty = false;
    this.plansDirty = false;
    this.setWorldView(current, { save: "saving" });
    try {
      const summary = await this.repository.save(current.id, {
        header: this.header(current),
        put: change.put,
        drop: change.drop,
        putNotes: noteChange.put,
        dropNotes: noteChange.drop,
      });
      this.savedNotes.accept(noteChange);
      this.current = { ...current, pinnedBundleVersion: this.bundleVersion };
      const unsaved = this.unsavedContent() || this.cameraDirty;
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
      this.notesDirty ||= notesWereDirty;
      this.documentDirty ||= documentWasDirty;
      this.plansDirty ||= plansWereDirty;
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
    const unsavedEdits = this.unsavedContent() || this.unstoredContent();
    if (unsavedEdits !== this.state.unsavedEdits) this.update({ unsavedEdits });
  }

  retrySave(): Promise<void> {
    return this.inFileQueue(() => this.saveNow());
  }

  private unstoredContent(): boolean {
    if (this.state.storageError === null) return false;
    const { world, notes } = this.editedWorld().contents();
    return world.size > 0 || notes.length > 0 || this.plans.regions.length > 0;
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
    this.update({ worlds: await this.repository.list(), kits: await this.repository.kits() });
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
    const current: OpenWorld = {
      id: null,
      name: FIRST_WORLD_NAME,
      pinnedBundleVersion: this.bundleVersion,
      openMs: 0,
      document: DEFAULT_WORLD_DOCUMENT,
    };
    await this.loadEditedWorld(current.name, NOTHING_STORED);
    this.finishOpen(null, current, [], null, NOTHING_STORED.plans);
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

  private finishOpen(
    savedView: SavedViewV1 | null,
    current: OpenWorld,
    notes: ReadonlyArray<NoteShardV2>,
    event: EventRecordV2 | null,
    plans: PlanState,
  ): void {
    this.camera.restoreView(savedView);
    this.camera.copyView(this.lastView);
    this.events.restore(event);
    this.current = current;
    this.plans = plans;
    this.dirty.clear();
    this.savedNotes.reset(notes);
    this.cameraDirty = false;
    this.consistsDirty = false;
    this.notesDirty = false;
    this.documentDirty = false;
    this.plansDirty = false;
    this.saveFailed = false;
    this.lastSaveError = null;
    this.update({ fileError: null });
    this.syncUnsaved();
  }

  private async createWorld(name: string): Promise<void> {
    const started = performance.now();
    const summary = await this.repository.create(this.freshHeader(name), [], []);
    await this.takeLease(summary.id);
    const current: OpenWorld = {
      id: summary.id,
      name,
      pinnedBundleVersion: this.bundleVersion,
      openMs: performance.now() - started,
      document: DEFAULT_WORLD_DOCUMENT,
    };
    await this.loadEditedWorld(name, NOTHING_STORED);
    this.finishOpen(null, current, [], null, NOTHING_STORED.plans);
    this.setWorldView(current, { placements: 0, shards: 0, save: "saved" });
  }

  private async loadEditedWorld(name: string, stored: StoredContents): Promise<void> {
    const unkept = unkeptTagIssues(stored.shards);
    if (unkept.length > 0) throw new Error(`world "${name}" can't be opened: ${issueText(unkept)}`);
    const issues = await this.editedWorld().load(stored);
    if (issues.length > 0) {
      throw new Error(`world "${name}" can't be opened: ${issueText(issues)}`);
    }
    this.layers.reset(layerTable(stored.document));
  }

  private async loadShards(
    id: string | null,
    stored: Omit<WorldFiles, "imports">,
    contents: StoredContents,
    started: number,
  ): Promise<void> {
    const { manifest, notes } = stored;
    await this.loadEditedWorld(manifest.name, contents);
    const opened: OpenWorld = {
      id,
      name: manifest.name,
      pinnedBundleVersion: manifest.bundleVersion,
      openMs: performance.now() - started,
      document: documentTables(worldDocument(manifest)),
    };
    this.finishOpen(manifest.view, opened, notes, manifest.event ?? null, contents.plans);
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
    const { manifest, shards, notes } = stored.value;
    const contents = openable(manifest, shards, notes);
    await this.ensureImports(contents, (sha256) => this.repository.importedFile(sha256));
    await this.loadShards(id, stored.value, contents, started);
  }

  private async ensureImports(
    stored: Pick<StoredContents, "shards" | "consists">,
    fileOf: (sha256: string) => Promise<ImportedFile | undefined>,
  ): Promise<void> {
    for (const sha256 of referencedImports(stored.shards, stored.consists)) {
      const file = this.importedFiles.get(sha256) ?? (await fileOf(sha256));
      if (!file) {
        throw new Error(`it places an imported file (sha256 ${sha256}) that isn't stored here`);
      }
      if ((await this.editedWorld().addImportedModel(file, "quiet")).kind === "refused") {
        throw new Error(`the imported file ${file.name} can't be placed any more`);
      }
      this.importedFiles.set(sha256, file);
    }
  }

  private unsavedRefusal(action: string): string | null {
    if (
      this.state.storageError !== null ||
      (this.dirty.size === 0 && !this.notesDirty && !this.documentDirty && !this.plansDirty)
    ) {
      return null;
    }
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
      const edited = this.editedWorld();
      const credits = this.credits.exportText(
        creditsForWorld(await this.loadCredits(), edited.placedCredits()),
      );
      const contents = edited.contents();
      const shards = worldShards(worldPlacements(contents.world, contents.refs), contents.track);
      const notes = noteShards(contents.notes);
      const manifest = worldManifest(
        this.header(current),
        shards.map(shardEntry),
        notes.map(noteShardEntry),
      );
      return {
        fileName: exportFileName(current.name),
        bytes: this.repository.packArchive({
          manifest,
          shards,
          notes,
          credits,
          imports: this.loadedImports(shards, contents.consists),
        }),
      };
    });
  }

  private loadedImports(
    shards: ReadonlyArray<WorldShardV2>,
    consists: ReadonlyArray<ConsistRecordV1>,
  ): ImportedFile[] {
    return [...referencedImports(shards, consists)].map((sha256) => {
      const file = this.importedFiles.get(sha256);
      if (!file) throw new Error(`the imported file with sha256 ${sha256} isn't loaded`);
      return file;
    });
  }

  importWorld(bytes: Uint8Array): Promise<boolean> {
    return this.importArchive(() => this.repository.readArchive(bytes));
  }

  importWorldFiles(files: ReadonlyMap<string, Uint8Array>): Promise<boolean> {
    return this.importArchive(() => this.repository.readWorldFiles(files));
  }

  async exportPlan(planId: string): Promise<ExportedWorld | null> {
    let exported: ExportedWorld | null = null;
    await this.fileAction(
      "saving the plan",
      async () => {
        exported = await this.packPlan(planId);
        this.update({ fileError: null });
      },
      true,
    );
    return exported;
  }

  private async planOutputs(planId: string): Promise<PlanOutputs> {
    const edited = this.editedWorld();
    const sheet = this.sheets.printable(edited, planId);
    const { files } = await this.boms.billOfMaterials(edited, { kind: "plan", planId });
    return {
      [PLAN_SHEET_FILE]: sheet,
      [PARTS_CSV_FILE]: files.plainCsv,
      [BRICKLINK_XML_FILE]: files.brickLinkXml,
      [REBRICKABLE_CSV_FILE]: files.rebrickableCsv,
    };
  }

  private async packPlan(planId: string): Promise<ExportedWorld> {
    const read = this.editedWorld().planContents(planId);
    if (!read.ok) throw new Error(issueText(read.issues));
    const { region, placements, track, placed, imported } = read.value;
    const files = bySha256(imported).map((model) => {
      const file = this.importedFiles.get(model.sha256);
      if (!file) throw new Error(`the imported file with sha256 ${model.sha256} isn't loaded`);
      return { model, file };
    });
    const credited: ImportedModelCredit[] = files.map(({ model, file }) => ({
      name: file.name,
      sha256: file.sha256,
      authors: [...new Set(model.credit.sections.map((section) => section.author))],
      licenses: [...new Set(model.credit.sections.flatMap((section) => section.license ?? []))],
      customParts: byReference(model.customParts),
    }));
    const credits = this.credits.exportText(
      creditsForPlan(await this.loadCredits(), placed, credited),
    );
    const shards = worldShardsV1(placements, track);
    const manifest = planManifest(
      {
        bundleVersion: this.bundleVersion,
        plan: planRecord(region),
        disclaimer: this.disclaimer,
      },
      shards.map(shardEntry),
    );
    const outputs = await this.planOutputs(planId);
    return {
      fileName: planFileName(region.name),
      bytes: this.repository.packPlanArchive({
        manifest,
        shards,
        credits,
        outputs,
        imports: files.map(({ file }) => file),
      }),
    };
  }

  openPlan(bytes: Uint8Array): Promise<boolean> {
    return this.fileAction(
      "opening the plan",
      async () => {
        const archive = await this.repository.readPlanArchive(bytes);
        if (!archive.ok) throw new Error(issueText(archive.issues));
        const { manifest, imports } = archive.value;
        const shards = archive.value.shards.map(migrateShardV1);
        await this.placeCarried(manifest.bundleVersion, shards, imports, "the plan opened", () =>
          this.editedWorld().addPlan({ plan: manifest.plan, shards }),
        );
      },
      true,
    );
  }

  private async placeCarried(
    bundleVersion: string,
    shards: ReadonlyArray<WorldShardV2>,
    imports: ReadonlyArray<ImportedFile>,
    opened: string,
    place: () => Promise<ReadonlyArray<Issue>>,
  ): Promise<void> {
    if (this.state.readOnly) {
      throw new Error("this world is open in another tab, so it's read-only here");
    }
    const carried = new Map(imports.map((file) => [file.sha256, file]));
    await this.ensureImports({ shards, consists: [] }, async (sha256) => carried.get(sha256));
    const issues = await place();
    if (issues.length > 0) {
      const pinned =
        bundleVersion === this.bundleVersion
          ? ""
          : ` (saved with bundle ${bundleVersion}; this app has bundle ${this.bundleVersion})`;
      throw new Error(`${issueText(issues)}${pinned}`);
    }
    this.update({ fileError: null });
    await this.storeOpenedImports(imports, opened);
  }

  private async storeOpenedImports(
    imports: ReadonlyArray<ImportedFile>,
    opened: string,
  ): Promise<void> {
    if (this.state.storageError !== null) return;
    try {
      for (const file of imports) await this.repository.putImportedFile(file);
    } catch (error) {
      this.update({
        fileError: `${opened}, but its model files couldn't be stored on this device (${errorText(error)}), so this world can't reopen with them after a reload. Export the world while this tab holds them.`,
      });
    }
  }

  async saveKit(name: string, library: KitLibrary): Promise<ExportedWorld | null> {
    let saved: ExportedWorld | null = null;
    await this.fileAction(
      "saving the kit",
      async () => {
        if (this.state.storageError !== null) throw new Error("storage is unavailable");
        const kitName = decode(WorldName, name.trim(), "kit name");
        if (!kitName.ok) throw new Error(issueText(kitName.issues));
        const read = this.editedWorld().selectionContents();
        if (!read.ok) throw new Error(issueText(read.issues));
        const { placements, track, placed } = read.value;
        const shards = worldShards(placements, track);
        const manifest = worldManifest(this.freshHeader(kitName.value), shards.map(shardEntry));
        const credits = this.credits.exportText(creditsForWorld(await this.loadCredits(), placed));
        const imports = this.loadedImports(shards, []);
        const bytes = this.repository.packArchive({
          manifest,
          shards,
          notes: [],
          credits,
          imports,
        });
        await this.storeKit(manifest, library, bytes);
        saved = { fileName: exportFileName(manifest.name), bytes };
      },
      true,
    );
    return saved;
  }

  placeKit(id: string): Promise<boolean> {
    return this.fileAction(
      "placing the kit",
      async () => {
        const archive = await this.repository.readArchive((await this.storedKit(id)).bytes);
        if (!archive.ok) throw new Error(issueText(archive.issues));
        const { manifest, shards, imports } = archive.value;
        await this.placeCarried(manifest.bundleVersion, shards, imports, "the kit is held", () =>
          this.editedWorld().holdKit(manifest.name, shards),
        );
      },
      true,
    );
  }

  addKitFile(bytes: Uint8Array): Promise<boolean> {
    return this.fileAction(
      "adding the kit",
      async () => {
        if (this.state.storageError !== null) throw new Error("storage is unavailable");
        const archive = await this.repository.readArchive(bytes);
        if (!archive.ok) throw new Error(issueText(archive.issues));
        const { manifest, notes } = archive.value;
        if (manifest.placements + manifest.track === 0) {
          throw new Error("the file holds no parts or track");
        }
        if ((manifest.consists ?? []).length > 0 || notes.length > 0) {
          throw new Error(
            "a kit holds parts and track only, and the file also holds trains or notes",
          );
        }
        await this.storeKit(manifest, "club", bytes);
      },
      true,
    );
  }

  async exportKit(id: string): Promise<ExportedWorld | null> {
    let exported: ExportedWorld | null = null;
    await this.fileAction(
      "downloading the kit",
      async () => {
        const { kit, bytes } = await this.storedKit(id);
        exported = { fileName: exportFileName(kit.name), bytes };
      },
      true,
    );
    return exported;
  }

  removeKit(id: string): Promise<boolean> {
    return this.fileAction(
      "removing the kit",
      async () => {
        await this.repository.removeKit(id);
        this.update({ kits: await this.repository.kits() });
      },
      true,
    );
  }

  private async storeKit(
    manifest: WorldManifestV2,
    library: KitLibrary,
    bytes: Uint8Array,
  ): Promise<void> {
    const { name, placements, track } = manifest;
    const id = await contentSha256(bytes);
    await this.repository.putKit({ id, name, library, placements, track }, bytes);
    this.update({ kits: await this.repository.kits(), fileError: null });
  }

  private async storedKit(id: string): Promise<{ kit: KitIndexEntry; bytes: Uint8Array }> {
    const kit = this.state.kits.find((entry) => entry.id === id);
    const bytes = kit && (await this.repository.kitArchive(id));
    if (!kit || !bytes) throw new Error("that kit is no longer stored here");
    return { kit, bytes };
  }

  private loadCredits(): Promise<CreditsView> {
    this.creditsView ??= this.credits.load().catch((error: unknown) => {
      this.creditsView = null;
      throw error;
    });
    return this.creditsView;
  }

  private importArchive(read: () => Promise<Decoded<WorldFiles>>): Promise<boolean> {
    return this.fileAction("import", async () => {
      const started = performance.now();
      const archive = await read();
      if (!archive.ok) throw new Error(issueText(archive.issues));
      const { manifest, shards, notes, imports } = archive.value;
      const decoded = storedContents(manifest, shards, notes);
      if (!decoded.ok) throw new Error(issueText(decoded.issues));
      const stored = decoded.value;
      const unkept = unkeptTagIssues(shards);
      if (unkept.length > 0) throw new Error(issueText(unkept));
      const carried = new Map(imports.map((file) => [file.sha256, file]));
      await this.ensureImports(stored, async (sha256) => carried.get(sha256));
      if (this.state.storageError === null) {
        for (const file of imports) await this.repository.putImportedFile(file);
      }
      const issues = this.editedWorld().validate(stored);
      if (issues.length > 0) throw new Error(issueText(issues));
      if (this.state.storageError !== null) {
        await this.loadShards(null, archive.value, stored, started);
        return;
      }
      const summary = await this.repository.create(worldHeader(manifest), shards, notes);
      await this.openStored(summary.id);
      await this.refreshWorlds();
    });
  }

  async addModelFile(input: ModelFileInput, notice: ModelImportNotice): Promise<ModelFileOutcome> {
    let outcome: ModelFileOutcome | null = null;
    await this.fileAction(
      "model import",
      async () => {
        const sha256 = await contentSha256(input.bytes);
        const known = this.importedFiles.get(sha256);
        const file = known ?? { sha256, name: input.name, bytes: input.bytes.slice() };
        const placed = await this.editedWorld().addImportedModel(file, notice);
        if (placed.kind === "added" && !known) {
          this.importedFiles.set(sha256, file);
          if (this.state.storageError === null) await this.repository.putImportedFile(file);
        }
        outcome = placed;
      },
      true,
    );
    return outcome ?? { kind: "refused", reason: this.state.fileError ?? "the import failed" };
  }
}

import {
  World,
  attachedEnds,
  followPlacements,
  noteAt,
  rulerSpan,
  withNote,
  withReplacedNote,
  withoutNote,
  type NoteBody,
  type NoteChange,
  type NoteEntry,
  type NoteSpan,
  type NoteState,
  type PlacementFollower,
  type PlacementMove,
  type PlacementPose,
  type PoseChange,
} from "@brr/domain";
import { decode, type Decoded, type Issue } from "@brr/schema/decode";
import {
  DEFAULT_WORLD_DOCUMENT,
  NoteRecordV2,
  WorldDocumentIndex,
  canonicalJson,
  canonicalOutline,
  type ModelEndV2,
  type PlacementRecordV1,
  type WorldDocument,
} from "@brr/schema/world";
import { inject, injectable } from "inversify";
import type { IPlaceableCatalog } from "../catalog/placeable-catalog.ts";
import type { IWorldSession } from "../edit/world-session.ts";
import type { ILayerService } from "../layers/layer-service.ts";
import { LAYER_SERVICE, PLACEABLE_CATALOG, WORLD_SESSION } from "../tokens.ts";

export type NoteDocument = Pick<WorldDocument, "layers" | "contributors">;

export interface NoteContents {
  readonly notes: ReadonlyArray<NoteRecordV2>;
  readonly document: NoteDocument;
  readonly world: World;
}

export interface IAnnotationService extends PlacementFollower {
  subscribe(listener: () => void): () => void;
  version(): number;
  notes(): NoteState;
  document(): NoteDocument;
  records(): ReadonlyArray<NoteRecordV2>;
  rulerSpan(id: string): NoteSpan | null;
  add(body: NoteBody): Decoded<string>;
  update(id: string, body: NoteBody): ReadonlyArray<Issue>;
  remove(id: string): ReadonlyArray<Issue>;
  onEdit(listener: (change: NoteChange) => void): () => void;
  restore(state: NoteState): void;
  check(contents: NoteContents): ReadonlyArray<Issue>;
  load(contents: NoteContents): ReadonlyArray<Issue>;
}

const NEW_NOTE_PATH = "note";
const READ_ONLY = "can't be edited: this world is open in another tab, so it's read-only here";
const UNKNOWN_NOTE = "is not a note in this world";

function canonicalBody(body: NoteBody): NoteBody {
  return body.kind === "zone" ? { ...body, outline: canonicalOutline(body.outline) } : body;
}

function attachedCount(state: NoteState): number {
  let count = 0;
  for (const { note } of state) count += attachedEnds(note).length;
  return count;
}

@injectable()
export class AnnotationService implements IAnnotationService {
  private readonly listeners = new Set<() => void>();
  private readonly editListeners = new Set<(change: NoteChange) => void>();
  private readonly deliver = (listener: () => void): void => listener();
  private entries: NoteState = [];
  private recordList: ReadonlyArray<NoteRecordV2> | null = null;
  private openDocument: NoteDocument = DEFAULT_WORLD_DOCUMENT;
  private world = new World();
  private attached = 0;
  private nextId = 1;
  private changes = 0;

  constructor(
    @inject(PLACEABLE_CATALOG) private readonly catalog: IPlaceableCatalog,
    @inject(WORLD_SESSION) private readonly session: IWorldSession,
    @inject(LAYER_SERVICE) private readonly layers: Pick<ILayerService, "table">,
  ) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  version(): number {
    return this.changes;
  }

  notes(): NoteState {
    return this.entries;
  }

  document(): NoteDocument {
    return this.openDocument;
  }

  records(): ReadonlyArray<NoteRecordV2> {
    this.recordList ??= this.entries.map((entry) => entry.note);
    return this.recordList;
  }

  rulerSpan(id: string): NoteSpan | null {
    const note = this.entryOf(id)?.note;
    return note?.kind === "ruler" ? rulerSpan(note) : null;
  }

  add(body: NoteBody): Decoded<string> {
    const checked = this.checkedBody(body);
    if (!checked.ok) return checked;
    const id = `note-${this.nextId++}`;
    this.edit(withNote(this.entries, id, checked.value));
    return { ok: true, value: id };
  }

  update(id: string, body: NoteBody): ReadonlyArray<Issue> {
    const entry = this.entryOf(id);
    if (!entry) return [{ path: id, message: UNKNOWN_NOTE }];
    const checked = this.checkedBody(body);
    if (!checked.ok) return checked.issues;
    const unchanged =
      canonicalJson(noteAt(checked.value, entry.note.index)) === canonicalJson(entry.note);
    if (!unchanged) this.edit(withReplacedNote(this.entries, id, checked.value));
    return [];
  }

  remove(id: string): ReadonlyArray<Issue> {
    if (!this.entryOf(id)) return [{ path: id, message: UNKNOWN_NOTE }];
    if (this.session.view().readOnly) return [{ path: id, message: READ_ONLY }];
    this.edit(withoutNote(this.entries, id));
    return [];
  }

  onEdit(listener: (change: NoteChange) => void): () => void {
    this.editListeners.add(listener);
    return () => this.editListeners.delete(listener);
  }

  restore(state: NoteState): void {
    if (state === this.entries) return;
    this.entries = state;
    this.changed();
  }

  follow(changes: ReadonlyArray<PoseChange>): NoteChange | null {
    if (this.attached === 0) return null;
    const refs = this.catalog.refs();
    const moves: PlacementMove[] = [];
    for (const { before, after } of changes) {
      if (before === null) continue;
      moves.push({
        before: this.placementRecord(before, refs),
        after: after === null ? null : this.placementRecord(after, refs),
      });
    }
    if (moves.length === 0) return null;
    const followed = followPlacements(this.entries, moves);
    return followed === this.entries ? null : { before: this.entries, after: followed };
  }

  check(contents: NoteContents): ReadonlyArray<Issue> {
    const index = new WorldDocumentIndex(contents.document);
    return contents.notes.flatMap((note, position) => {
      const path = `note ${position}`;
      const decoded = decode(NoteRecordV2, note, path);
      return decoded.ok
        ? this.referenceIssues(decoded.value, path, index, contents.world)
        : decoded.issues;
    });
  }

  load(contents: NoteContents): ReadonlyArray<Issue> {
    const issues = this.check(contents);
    if (issues.length > 0) return issues;
    this.openDocument = contents.document;
    this.world = contents.world;
    this.entries = contents.notes.map((note, index) => ({
      id: `note-${this.nextId++}`,
      note: note.index === index ? note : { ...note, index },
    }));
    this.changed();
    return [];
  }

  private entryOf(id: string): NoteEntry | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  private checkedBody(body: NoteBody): Decoded<NoteBody> {
    if (this.session.view().readOnly) {
      return { ok: false, issues: [{ path: NEW_NOTE_PATH, message: READ_ONLY }] };
    }
    const decoded = decode(NoteRecordV2, noteAt(body, 0), NEW_NOTE_PATH);
    if (!decoded.ok) return decoded;
    const index = new WorldDocumentIndex({
      ...this.openDocument,
      layers: [...this.layers.table().layers],
    });
    const issues = this.referenceIssues(decoded.value, NEW_NOTE_PATH, index, this.world);
    return issues.length > 0 ? { ok: false, issues } : { ok: true, value: canonicalBody(body) };
  }

  private referenceIssues(
    note: NoteRecordV2,
    path: string,
    index: WorldDocumentIndex,
    world: World,
  ): Issue[] {
    const issues: Issue[] = [];
    const layer = index.layerIssue(note.layer, "notes");
    if (layer !== null) issues.push({ path: `${path}.layer`, message: layer });
    const owner = note.owner === undefined ? null : index.ownerIssue(note.owner);
    if (owner !== null) issues.push({ path: `${path}.owner`, message: owner });
    if (note.kind === "ruler") {
      for (const [field, end] of [
        ["from", note.from],
        ["to", note.to],
      ] as const) {
        const unplaced = end.on === "model" ? this.unplacedEnd(end, world) : null;
        if (unplaced !== null) issues.push({ path: `${path}.${field}`, message: unplaced });
      }
    }
    return issues;
  }

  private unplacedEnd(end: ModelEndV2, world: World): string | null {
    const target = this.catalog.resolveRef(end.ref, end.color);
    if (!target) return `names "${end.ref}" in colour ${end.color}, which isn't in the catalog`;
    return world.has(target.refId, target.colorId, end.x, end.z, end.yPlates, end.rot)
      ? null
      : `names "${end.ref}" at (${end.x}, ${end.yPlates}, ${end.z}) turned ${end.rot}, which the world doesn't place`;
  }

  private placementRecord(pose: PlacementPose, refs: ReadonlyArray<string>): PlacementRecordV1 {
    const ref = refs[pose.refId];
    if (ref === undefined) throw new Error(`placement refId ${pose.refId} has no catalog id`);
    return { ref, color: pose.colorId, x: pose.x, z: pose.z, yPlates: pose.yPlates, rot: pose.rot };
  }

  private edit(next: NoteState): void {
    const before = this.entries;
    if (next === before) return;
    this.entries = next;
    this.changed();
    const change = { before, after: next };
    for (const listener of this.editListeners) listener(change);
  }

  private changed(): void {
    this.recordList = null;
    this.attached = attachedCount(this.entries);
    this.changes++;
    this.listeners.forEach(this.deliver);
  }
}

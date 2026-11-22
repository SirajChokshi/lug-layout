import type { FetchPriority, IPartBundleLoader, PartMesh } from "@brr/catalog";
import type { BundleLod } from "@brr/schema/bundle";
import type { ISceneBackend, NeededMeshListener, PaletteLevel, PartMeshUpdate } from "@brr/render";
import type { MergedParts } from "./merged-parts.ts";
import type { MeshCounts, MeshProgress, UndrawnPart, UndrawnReason } from "./mesh-progress.ts";

const FAR_LOD: BundleLod = "far";

const NOT_WANTED = 0;
const LOADING = 1;
const PENDING_FLUSH = 2;
const LOADED = 3;
const FAILED = 4;
const ABSENT = 5;
const PROVIDED = 6;
const HELD_STALL_MS = 2000;

type HoldStep = 1 | -1;

export type PartMeshProgress = Pick<
  MeshProgress,
  "detailedPartMeshes" | "farPartMeshes" | "undrawnParts"
>;

class LevelMeshes {
  status = new Uint8Array(0);
  holdCount = new Uint16Array(0);
  wanted = 0;
  loaded = 0;
  failed = 0;
  absent = 0;

  constructor(
    readonly level: PaletteLevel,
    readonly lod: BundleLod,
  ) {}

  ensure(size: number): void {
    if (size <= this.status.length) return;
    const capacity = Math.max(size, this.status.length * 2);
    const status = new Uint8Array(capacity);
    status.set(this.status);
    this.status = status;
    const holdCount = new Uint16Array(capacity);
    holdCount.set(this.holdCount);
    this.holdCount = holdCount;
  }

  priorityOf(index: number): FetchPriority {
    return (this.holdCount[index] ?? 0) > 0 ? "high" : "low";
  }

  counts(): MeshCounts {
    return { wanted: this.wanted, loaded: this.loaded, failed: this.failed, absent: this.absent };
  }
}

export class PartMeshStream implements NeededMeshListener {
  private readonly files = new Map<number, string>();
  private readonly detailed: LevelMeshes;
  private readonly far = new LevelMeshes("far", FAR_LOD);
  private readonly detailedFetches = new Map<number, Promise<void>>();
  private farFiles: ReadonlyMap<string, string> | null = null;
  private pending: PartMeshUpdate[] = [];
  private undrawn: ReadonlyArray<UndrawnPart> = [];
  private heldLoadingCount = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly loader: IPartBundleLoader,
    private readonly backend: ISceneBackend,
    private readonly palette: MergedParts,
    lod: BundleLod,
    private readonly onProgress: (progress: PartMeshProgress) => void,
  ) {
    this.detailed = new LevelMeshes("detailed", lod);
  }

  register(index: number, file: string): void {
    if (!this.files.has(index)) this.files.set(index, file);
    this.ensure(index + 1);
  }

  provide(index: number): void {
    this.ensure(index + 1);
    if (this.detailed.status[index] === NOT_WANTED) this.detailed.status[index] = PROVIDED;
  }

  private ensure(size: number): void {
    this.detailed.ensure(size);
    this.far.ensure(size);
  }

  progress(): PartMeshProgress {
    return {
      detailedPartMeshes: this.detailed.counts(),
      farPartMeshes: this.far.counts(),
      undrawnParts: this.undrawn,
    };
  }

  request(indices: Iterable<number>): void {
    let started = false;
    for (const index of indices) {
      if (this.want(this.detailed, index)) started = true;
      if (this.want(this.far, index)) started = true;
    }
    if (started) this.onProgress(this.progress());
  }

  async whenLoaded(indices: ReadonlySet<number>): Promise<void> {
    this.request(indices);
    await Promise.all([...indices].map((index) => this.detailedFetches.get(index)));
    this.flush();
  }

  useFarFiles(farFiles: ReadonlyMap<string, string>): void {
    this.farFiles = farFiles;
    let started = false;
    for (let index = 0; index < this.far.status.length; index++) {
      const detailed = this.detailed.status[index] ?? NOT_WANTED;
      const wanted =
        (detailed !== NOT_WANTED && detailed !== PROVIDED) || (this.far.holdCount[index] ?? 0) > 0;
      if (wanted && this.want(this.far, index)) started = true;
    }
    if (started) this.onProgress(this.progress());
  }

  hold(detailedIndices: Uint32Array, farIndices: Uint32Array): void {
    this.step(detailedIndices, farIndices, 1);
  }

  release(detailedIndices: Uint32Array, farIndices: Uint32Array): void {
    this.step(detailedIndices, farIndices, -1);
  }

  private step(detailedIndices: Uint32Array, farIndices: Uint32Array, step: HoldStep): void {
    let started = false;
    for (let i = 0; i < detailedIndices.length; i++) {
      if (this.stepHold(this.detailed, detailedIndices[i] ?? 0, step)) started = true;
    }
    for (let i = 0; i < farIndices.length; i++) {
      if (this.stepHold(this.far, farIndices[i] ?? 0, step)) started = true;
    }
    if (started) this.onProgress(this.progress());
  }

  private stepHold(meshes: LevelMeshes, index: number, step: HoldStep): boolean {
    this.ensure(index + 1);
    const held = meshes.holdCount[index] ?? 0;
    if (step < 0 && held === 0) return false;
    meshes.holdCount[index] = held + step;
    if (held !== 0 && held + step !== 0) return false;
    if (meshes.status[index] === LOADING) {
      this.heldLoadingCount += step;
      const file = this.fileOf(meshes, index);
      if (file !== undefined) {
        this.loader.setPartMeshPriority(meshes.lod, file, meshes.priorityOf(index));
      }
      if (this.heldLoadingCount === 0) this.scheduleFlush(false);
      return false;
    }
    return step > 0 && this.want(meshes, index);
  }

  private fileOf(meshes: LevelMeshes, index: number): string | undefined {
    if (meshes === this.detailed) return this.files.get(index);
    const id = this.palette.parts[index]?.id;
    return id === undefined ? undefined : this.farFiles?.get(id);
  }

  private want(meshes: LevelMeshes, index: number): boolean {
    if (meshes === this.far && this.farFiles === null) return false;
    this.ensure(index + 1);
    const status = meshes.status[index];
    if (status === PROVIDED) {
      meshes.status[index] = LOADED;
      meshes.wanted++;
      meshes.loaded++;
      return true;
    }
    if (status !== NOT_WANTED) return false;
    meshes.wanted++;
    const file = this.fileOf(meshes, index);
    if (file === undefined) {
      meshes.status[index] = ABSENT;
      meshes.absent++;
      this.leaveUndrawn(meshes, index, "absent");
      return true;
    }
    meshes.status[index] = LOADING;
    if ((meshes.holdCount[index] ?? 0) > 0) this.heldLoadingCount++;
    const fetch = this.fetch(meshes, index, file);
    if (meshes === this.detailed) this.detailedFetches.set(index, fetch);
    return true;
  }

  private async fetch(meshes: LevelMeshes, index: number, file: string): Promise<void> {
    let mesh: PartMesh;
    try {
      mesh = await this.loader.loadPartMesh(meshes.lod, file, meshes.priorityOf(index));
    } catch {
      this.fail(meshes, index);
      return;
    }
    const shape = this.palette.parts[index];
    if (!shape) {
      this.fail(meshes, index);
      return;
    }
    const part = { ...shape, mesh };
    if (meshes === this.detailed) this.palette.replace(index, part);
    const heldFinished = this.finishHeldLoading(meshes, index);
    meshes.status[index] = PENDING_FLUSH;
    this.pending.push({ index, level: meshes.level, part });
    this.scheduleFlush(heldFinished);
  }

  private finishHeldLoading(meshes: LevelMeshes, index: number): boolean {
    if ((meshes.holdCount[index] ?? 0) === 0) return false;
    this.heldLoadingCount--;
    return true;
  }

  private fail(meshes: LevelMeshes, index: number): void {
    const heldFinished = this.finishHeldLoading(meshes, index);
    meshes.status[index] = FAILED;
    meshes.failed++;
    this.leaveUndrawn(meshes, index, "failed");
    this.onProgress(this.progress());
    this.scheduleFlush(heldFinished);
  }

  private leaveUndrawn(meshes: LevelMeshes, index: number, reason: UndrawnReason): void {
    if (meshes !== this.detailed) return;
    const part = this.palette.parts[index]?.id ?? `palette slot ${index}`;
    this.undrawn = [...this.undrawn, { part, reason }];
  }

  private scheduleFlush(heldFinished: boolean): void {
    if (this.pending.length === 0) return;
    if (this.heldLoadingCount === 0) {
      if (this.flushTimer !== null) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(this.flush, 0);
      return;
    }
    if (this.flushTimer !== null) {
      if (!heldFinished) return;
      clearTimeout(this.flushTimer);
    }
    this.flushTimer = setTimeout(this.flush, HELD_STALL_MS);
  }

  private readonly flush = (): void => {
    if (this.flushTimer !== null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.pending.length === 0) return;
    const updates = this.pending;
    this.pending = [];
    for (let i = 0; i < updates.length; i++) {
      const update = updates[i];
      if (!update) continue;
      const meshes = update.level === "far" ? this.far : this.detailed;
      meshes.status[update.index] = LOADED;
      meshes.loaded++;
    }
    this.backend.setPartMeshes(updates);
    this.onProgress(this.progress());
  };
}

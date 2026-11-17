import type { FetchPriority, IPartBundleLoader, PartMesh } from "@brr/catalog";
import type { BundleLod } from "@brr/schema/bundle";
import type { ISceneBackend, PaletteLevel, PartMeshUpdate } from "@brr/render";
import type { MergedParts } from "./merged-parts.ts";

const FAR_LOD: BundleLod = "far";

export interface MeshProgress {
  readonly wanted: number;
  readonly loaded: number;
  readonly failed: number;
}

export class PartMeshStream {
  private readonly files = new Map<number, string>();
  private readonly wanted = new Set<number>();
  private readonly loaded = new Set<number>();
  private readonly failed = new Set<number>();
  private readonly farWanted = new Set<number>();
  private farFiles: ReadonlyMap<string, string> | null = null;
  private pending: PartMeshUpdate[] = [];
  private flushScheduled = false;

  constructor(
    private readonly loader: IPartBundleLoader,
    private readonly backend: ISceneBackend,
    private readonly palette: MergedParts,
    private readonly lod: BundleLod,
    private readonly onProgress: (progress: MeshProgress) => void,
  ) {}

  register(index: number, file: string): void {
    if (!this.files.has(index)) this.files.set(index, file);
  }

  progress(): MeshProgress {
    return { wanted: this.wanted.size, loaded: this.loaded.size, failed: this.failed.size };
  }

  request(indices: Iterable<number>, priority: FetchPriority): void {
    for (const index of indices) {
      if (this.wanted.has(index)) continue;
      const file = this.files.get(index);
      if (file === undefined) continue;
      this.wanted.add(index);
      void this.fetch(index, "detailed", this.lod, file, priority);
    }
    this.onProgress(this.progress());
  }

  useFarFiles(farFiles: ReadonlyMap<string, string>): void {
    this.farFiles = farFiles;
    for (const index of this.loaded) this.requestFar(index);
  }

  private requestFar(index: number): void {
    const id = this.palette.parts[index]?.id;
    const file = id === undefined ? undefined : this.farFiles?.get(id);
    if (file === undefined || this.farWanted.has(index)) return;
    this.farWanted.add(index);
    void this.fetch(index, "far", FAR_LOD, file, "low");
  }

  private async fetch(
    index: number,
    level: PaletteLevel,
    lod: BundleLod,
    file: string,
    priority: FetchPriority,
  ): Promise<void> {
    let mesh: PartMesh;
    try {
      mesh = await this.loader.loadPartMesh(lod, file, priority);
    } catch {
      if (level === "detailed") {
        this.failed.add(index);
        this.onProgress(this.progress());
      }
      return;
    }
    const shape = this.palette.parts[index];
    if (!shape) return;
    const part = { ...shape, mesh };
    if (level === "detailed") {
      this.palette.replace(index, part);
      this.loaded.add(index);
      this.requestFar(index);
    }
    this.pending.push({ index, level, part });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setTimeout(() => {
      this.flushScheduled = false;
      const updates = this.pending;
      this.pending = [];
      this.backend.setPartMeshes(updates);
      this.onProgress(this.progress());
    }, 0);
  }
}

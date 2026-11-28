import { CHUNK_LDU, lduFromMm } from "@brr/math";
import type { GroundUnderlay } from "@brr/render";
import { decode, type Issue } from "@brr/schema/decode";
import {
  OPACITY_PERCENT_MAX,
  UnderlayRecordV2,
  type ImportedFile,
  type PixelPoint,
} from "@brr/schema/world";
import { contentSha256 } from "@brr/storage";
import { inject, injectable } from "inversify";
import type { IEditorCamera } from "../camera/editor-camera.ts";
import { errorText } from "../edit/error-text.ts";
import type { IWorldSession, WorldUnderlay } from "../edit/world-session.ts";
import type { ITableGround } from "../ground/table-ground.ts";
import { EDITOR_CAMERA, TABLE_GROUND, WORLD_SESSION } from "../tokens.ts";
import { NOT_AN_UNDERLAY_IMAGE, underlayImageType } from "./underlay-image.ts";

export const UNDERLAY_DEFAULT_OPACITY_PERCENT = 50;

export interface UnderlayFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export type UnderlayPatch = Partial<Omit<UnderlayRecordV2, "image">>;

export interface UnderlayView {
  readonly record: UnderlayRecordV2;
  readonly name: string;
  readonly image: Blob;
  readonly mmPerPixel: number;
}

export interface IUnderlayService {
  subscribe(listener: () => void): () => void;
  view(): UnderlayView | null;
  edit(patch: UnderlayPatch, file?: UnderlayFile): Promise<ReadonlyArray<Issue>>;
  remove(): Promise<ReadonlyArray<Issue>>;
}

const PATH = "underlay";
const READ_ONLY = "can't be edited: this world is open in another tab, so it's read-only here";
const LOCKED = "is locked: unlock it to move, rescale, replace or remove it";
const NO_IMAGE = "has no image yet: choose a PNG or JPEG floor plan";
const EDITABLE_WHEN_LOCKED: ReadonlySet<string> = new Set(["opacity", "locked"]);

function pixelSpan(from: PixelPoint, to: PixelPoint): number {
  return Math.hypot(to[0] - from[0], to[1] - from[1]);
}

function imageBlob(file: ImportedFile): Blob {
  return new Blob([file.bytes.slice()], { type: underlayImageType(file.bytes) ?? "" });
}

function underlayView({ record, file }: WorldUnderlay, image: Blob): UnderlayView {
  return {
    record,
    name: file.name,
    image,
    mmPerPixel: record.distanceMm / pixelSpan(record.from, record.to),
  };
}

function groundUnderlay({ record, image, mmPerPixel }: UnderlayView): GroundUnderlay {
  const lduPerPixel = lduFromMm(mmPerPixel);
  return {
    image,
    cornerX: record.x - record.from[0] * lduPerPixel,
    cornerZ: record.z - record.from[1] * lduPerPixel,
    lduPerPixel,
    opacity: record.opacity / OPACITY_PERCENT_MAX,
  };
}

function touchesLockedFields(patch: UnderlayPatch, file: UnderlayFile | undefined): boolean {
  return file !== undefined || Object.keys(patch).some((key) => !EDITABLE_WHEN_LOCKED.has(key));
}

@injectable()
export class UnderlayService implements IUnderlayService {
  private readonly listeners = new Set<() => void>();
  private shown: WorldUnderlay | null = null;
  private current: UnderlayView | null = null;
  private turns: Promise<void> = Promise.resolve();

  constructor(
    @inject(WORLD_SESSION) private readonly session: IWorldSession,
    @inject(TABLE_GROUND) private readonly ground: Pick<ITableGround, "setUnderlay">,
    @inject(EDITOR_CAMERA) private readonly camera: Pick<IEditorCamera, "targetChunk">,
  ) {
    session.subscribe(() => this.sessionChanged());
    this.sessionChanged();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  view(): UnderlayView | null {
    return this.current;
  }

  edit(patch: UnderlayPatch, file?: UnderlayFile): Promise<ReadonlyArray<Issue>> {
    return this.inTurn(() => this.edited(patch, file));
  }

  remove(): Promise<ReadonlyArray<Issue>> {
    return this.inTurn(() => this.removed());
  }

  private inTurn(task: () => Promise<ReadonlyArray<Issue>>): Promise<ReadonlyArray<Issue>> {
    const run = this.turns.then(task);
    this.turns = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async edited(patch: UnderlayPatch, file?: UnderlayFile): Promise<ReadonlyArray<Issue>> {
    const before = this.session.view().underlay;
    const refusal = this.refusal(before, touchesLockedFields(patch, file));
    if (refusal !== null) return [{ path: PATH, message: refusal }];
    const image = file ? await this.imageFile(file) : before?.file;
    if (image === undefined) return [{ path: `${PATH}.image`, message: NO_IMAGE }];
    if (image === null) {
      return [{ path: `${PATH}.image`, message: `${file?.name ?? ""} ${NOT_AN_UNDERLAY_IMAGE}` }];
    }
    const record = decode(
      UnderlayRecordV2,
      {
        ...(before?.record ?? this.newRecord()),
        ...patch,
        image: image.sha256,
      },
      PATH,
    );
    return record.ok ? this.stored({ record: record.value, file: image }) : record.issues;
  }

  private async removed(): Promise<ReadonlyArray<Issue>> {
    const before = this.session.view().underlay;
    if (before === null) return [];
    const refusal = this.refusal(before, true);
    return refusal === null ? this.stored(null) : [{ path: PATH, message: refusal }];
  }

  private newRecord(): UnderlayPatch {
    const { chunkX, chunkZ } = this.camera.targetChunk();
    return {
      x: chunkX * CHUNK_LDU,
      z: chunkZ * CHUNK_LDU,
      opacity: UNDERLAY_DEFAULT_OPACITY_PERCENT,
      locked: false,
    };
  }

  private refusal(before: WorldUnderlay | null, touchesLocked: boolean): string | null {
    if (this.session.view().readOnly) return READ_ONLY;
    return before?.record.locked && touchesLocked ? LOCKED : null;
  }

  private async imageFile(file: UnderlayFile): Promise<ImportedFile | null> {
    if (underlayImageType(file.bytes) === null) return null;
    const bytes = file.bytes.slice();
    return { sha256: await contentSha256(bytes), name: file.name, bytes };
  }

  private async stored(underlay: WorldUnderlay | null): Promise<ReadonlyArray<Issue>> {
    try {
      await this.session.setUnderlay(underlay);
      return [];
    } catch (error) {
      return [{ path: PATH, message: `couldn't be stored on this device: ${errorText(error)}` }];
    }
  }

  private sessionChanged(): void {
    const { underlay } = this.session.view();
    if (underlay === this.shown) return;
    const sameImage = this.current !== null && underlay?.file === this.shown?.file;
    const image = sameImage ? this.current?.image : underlay && imageBlob(underlay.file);
    this.shown = underlay;
    this.current = underlay && image ? underlayView(underlay, image) : null;
    this.ground.setUnderlay(this.current && groundUnderlay(this.current));
    for (const listener of this.listeners) listener();
  }
}

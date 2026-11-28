import { contentSha256 } from "@brr/storage";
import { inject, injectable } from "inversify";
import type { IEditor } from "../edit/editor.ts";
import { errorText } from "../edit/error-text.ts";
import { EDITOR } from "../tokens.ts";
import { importRefusal } from "./library-part-placer.ts";
import type { OmrModelView, OmrSetView } from "./omr-set-index.ts";

export interface OmrPlacementView {
  readonly pending: string | null;
  readonly refused: { readonly file: string; readonly reason: string } | null;
}

export interface IOmrSetPlacer {
  view(): OmrPlacementView;
  subscribe(listener: () => void): () => void;
  place(set: OmrSetView, model: OmrModelView): Promise<boolean>;
}

export function omrModelFileName(set: OmrSetView, model: OmrModelView): string {
  const variant = model.variant === null ? "" : `, ${model.variant}`;
  return `${set.number} ${set.name}${variant}.mpd`;
}

async function pinnedBytes(model: OmrModelView): Promise<Uint8Array | string> {
  let response: Response;
  try {
    response = await fetch(model.url);
  } catch (error) {
    return `its LDraw model couldn't be downloaded: ${errorText(error)}`;
  }
  if (!response.ok) return `its LDraw model couldn't be downloaded (HTTP ${response.status})`;
  const bytes = new Uint8Array(await response.arrayBuffer());
  const pinned = bytes.length === model.bytes && (await contentSha256(bytes)) === model.sha256;
  return pinned ? bytes : `the downloaded ${model.file} isn't the file its SHA-256 pins`;
}

@injectable()
export class OmrSetPlacer implements IOmrSetPlacer {
  private readonly listeners = new Set<() => void>();
  private state: OmrPlacementView = { pending: null, refused: null };

  constructor(
    @inject(EDITOR)
    private readonly editor: Pick<IEditor, "importModelFile" | "snapshot" | "chooseItem">,
  ) {}

  view(): OmrPlacementView {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async place(set: OmrSetView, model: OmrModelView): Promise<boolean> {
    if (this.state.pending !== null) return false;
    if (this.editor.snapshot().catalog.some((item) => item.id === model.item)) {
      this.editor.chooseItem(model.item);
      return true;
    }
    this.set({ pending: model.file, refused: null });
    const bytes = await pinnedBytes(model);
    const name = omrModelFileName(set, model);
    const placed =
      typeof bytes !== "string" && (await this.editor.importModelFile({ name, bytes }));
    const reason = typeof bytes === "string" ? bytes : importRefusal(this.editor, name);
    this.set({ pending: null, refused: placed ? null : { file: model.file, reason } });
    return placed;
  }

  private set(next: OmrPlacementView): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

import { inject, injectable } from "inversify";
import { EDITOR } from "../tokens.ts";
import type { EditorSnapshot, IEditor, ModelImportView } from "./editor.ts";

export type NoticeTone = "progress" | "note" | "warn" | "error";

export interface Notice {
  readonly id: number;
  readonly tone: NoticeTone;
  readonly text: string;
}

type NoticeSource = "model-import" | "catalog" | "file";

interface SourcedNotice extends Notice {
  readonly source: NoticeSource;
}

export interface INotices {
  subscribe(listener: () => void): () => void;
  notices(): ReadonlyArray<Notice>;
  dismiss(id: number): void;
}

export function modelImportText(view: ModelImportView): string {
  switch (view.status) {
    case "importing":
      return `Importing ${view.file}: reading, compiling and baking its parts…`;
    case "checking":
      return `${view.file} is in the palette, checking studs. Click the layout to place it.`;
    case "placeable":
      return `${view.file} is in the palette. Click the layout to place it.`;
    case "check-failed":
      return `${view.file} is in the palette, but its ${view.reason ?? "stud check failed"}. Its studs stay unchecked.`;
    case "refused":
      return `${view.file} can't be placed: ${view.reason ?? "no stud lattice from the bake"}.`;
    case "held":
      return `${view.file} is held as laid out, one placement per submodel: click the layout to place it, R turns it, Esc lets go. Its submodels stay in the palette.${view.reason === null ? "" : ` ${view.reason}`}`;
    default: {
      const unhandled: never = view.status;
      throw new Error(`unhandled ${String(unhandled)}`);
    }
  }
}

export function modelImportWarns(view: ModelImportView): boolean {
  return (
    view.status === "refused" ||
    view.status === "check-failed" ||
    (view.status === "held" && view.reason !== null)
  );
}

function modelImportTone(view: ModelImportView): NoticeTone {
  if (modelImportWarns(view)) return "warn";
  return view.status === "importing" || view.status === "checking" ? "progress" : "note";
}

@injectable()
export class NoticeService implements INotices {
  private readonly listeners = new Set<() => void>();
  private shown: ReadonlyArray<SourcedNotice> = [];
  private serial = 0;
  private modelImport: ModelImportView | null = null;
  private catalogError: string | null = null;
  private fileError: string | null = null;

  constructor(@inject(EDITOR) editor: IEditor) {
    editor.subscribe(() => this.notice(editor.snapshot()));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notices(): ReadonlyArray<Notice> {
    return this.shown;
  }

  dismiss(id: number): void {
    if (!this.shown.some((notice) => notice.id === id)) return;
    this.shown = this.shown.filter((notice) => notice.id !== id);
    this.changed();
  }

  private notice({ modelImport, catalogError, fileError }: EditorSnapshot): void {
    const before = this.shown;
    if (modelImport !== this.modelImport) {
      this.modelImport = modelImport;
      this.show(
        "model-import",
        modelImport && { tone: modelImportTone(modelImport), text: modelImportText(modelImport) },
      );
    }
    if (catalogError !== this.catalogError) {
      this.catalogError = catalogError;
      this.show("catalog", catalogError === null ? null : { tone: "error", text: catalogError });
    }
    if (fileError !== this.fileError) {
      this.fileError = fileError;
      this.show("file", fileError === null ? null : { tone: "error", text: fileError });
    }
    if (this.shown !== before) this.changed();
  }

  private show(source: NoticeSource, notice: Omit<Notice, "id"> | null): void {
    const others = this.shown.filter((shown) => shown.source !== source);
    if (notice === null) {
      if (others.length < this.shown.length) this.shown = others;
      return;
    }
    this.serial += 1;
    this.shown = [...others, { ...notice, id: this.serial, source }];
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }
}

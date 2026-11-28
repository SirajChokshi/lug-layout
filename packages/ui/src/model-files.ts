import type { IEditor } from "@brr/client";

export const MODEL_FILE_ACCEPT = ".io,.ldr,.mpd";
export const LAYOUT_FILE_ACCEPT = ".ldr,.mpd";
const MODEL_FILE = /\.(?:io|ldr|mpd)$/iu;

export function modelFiles(files: Iterable<File>): File[] {
  return [...files].filter((file) => MODEL_FILE.test(file.name));
}

export async function importModelFiles(editor: IEditor, files: Iterable<File>): Promise<boolean> {
  let imported = false;
  for (const file of modelFiles(files)) {
    imported = await editor.importModelFile({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  }
  return imported;
}

export function carriesFiles(event: globalThis.DragEvent): boolean {
  return event.dataTransfer?.types.includes("Files") ?? false;
}

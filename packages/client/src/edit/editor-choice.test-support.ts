import type { IEditor } from "./editor.ts";

export async function settledChoice(editor: IEditor): Promise<void> {
  if (editor.snapshot().pendingItem === null) return;
  await new Promise<void>((resolve) => {
    const stop = editor.subscribe(() => {
      if (editor.snapshot().pendingItem !== null) return;
      stop();
      resolve();
    });
  });
}

export async function chosen(editor: IEditor, item: string | null): Promise<void> {
  editor.chooseItem(item);
  await settledChoice(editor);
}

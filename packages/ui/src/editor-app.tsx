import type { EditorOptions, IEditor } from "@brr/client";
import { EditorCanvas } from "./editor-canvas.tsx";
import {
  CatalogList,
  CreditsFooter,
  EditorHud,
  Inspector,
  PlacementToolbar,
} from "./editor-panels.tsx";
import { useEditorSnapshot } from "./use-editor.ts";

interface EditorAppProps {
  readonly editor: IEditor;
  readonly options: EditorOptions;
  readonly disclaimer: string;
  readonly showState: boolean;
}

function EditorState({ editor }: { readonly editor: IEditor }) {
  const snapshot = useEditorSnapshot(editor);
  return (
    <pre
      id="edit-state"
      data-placements={snapshot.placements}
      data-samples={snapshot.latencies.length}
    >
      {JSON.stringify({ latencies: snapshot.latencies, world: editor.dump() })}
    </pre>
  );
}

export function EditorApp({ editor, options, disclaimer, showState }: EditorAppProps) {
  const snapshot = useEditorSnapshot(editor);
  return (
    <div
      className="editor"
      data-status={snapshot.status}
      data-hover={snapshot.hover ? `${snapshot.hover.x},${snapshot.hover.z}` : ""}
      data-selection={snapshot.selection?.item ?? ""}
      data-ghost-rot={snapshot.ghostRot}
    >
      <EditorCanvas editor={editor} options={options} />
      <EditorHud snapshot={snapshot} />
      <div className="side-panel">
        <PlacementToolbar editor={editor} snapshot={snapshot} />
        <CatalogList editor={editor} snapshot={snapshot} />
        <Inspector snapshot={snapshot} />
      </div>
      {showState && <EditorState editor={editor} />}
      <CreditsFooter snapshot={snapshot} disclaimer={disclaimer} />
    </div>
  );
}

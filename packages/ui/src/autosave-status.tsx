import type { AutosaveView, IEditor, IWorldAutosave } from "@brr/client";
import { useEffect, useState, useSyncExternalStore } from "react";

const clock = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function stateText(view: AutosaveView): string {
  switch (view.state) {
    case "starting":
      return "Opening your autosaved layout…";
    case "pending":
    case "saving":
      return "Saving…";
    case "saved":
      return view.savedAt === null ? "Autosave on" : `Saved ${clock.format(view.savedAt)}`;
    case "elsewhere":
      return "Open in another tab: this tab won't autosave";
    case "failed":
      return `Autosave failed: ${view.error ?? "unknown error"}`;
    default: {
      const unhandled: never = view.state;
      throw new Error(`unhandled autosave state ${String(unhandled)}`);
    }
  }
}

function restoredText(view: AutosaveView): string | null {
  const restored = view.restored;
  if (!restored) return null;
  const exactness = restored.exact ? "exactly as saved" : "but it reloaded differently";
  return `Restored your layout from ${clock.format(restored.savedAt)} (${restored.placements} placements, ${restored.track} track pieces), ${exactness}.`;
}

interface AutosaveStatusProps {
  readonly autosave: IWorldAutosave;
  readonly editor: IEditor;
  readonly disclaimer: string;
}

export function AutosaveStatus({ autosave, editor, disclaimer }: AutosaveStatusProps) {
  const view = useSyncExternalStore(
    (listener) => autosave.subscribe(listener),
    () => autosave.snapshot(),
  );
  const [noticeShown, setNoticeShown] = useState(true);

  useEffect(() => {
    void autosave.start(disclaimer);
    const flush = (): void => void autosave.flush();
    const flushWhenHidden = (): void => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, [autosave, disclaimer]);

  const restored = restoredText(view);
  return (
    <div className="autosave" data-autosave={view.state}>
      <span className="autosave-state">{stateText(view)}</span>
      <button type="button" onClick={(event) => editor.clearWorld(event.timeStamp)}>
        New layout
      </button>
      {noticeShown && restored && (
        <p className="autosave-notice">
          {restored}{" "}
          <button type="button" onClick={() => setNoticeShown(false)}>
            OK
          </button>
        </p>
      )}
      {view.setAside && (
        <p className="autosave-notice warning">
          The autosaved layout could not be opened, so it was kept aside as "{view.setAside.as}" and
          this is a new layout.{" "}
          {view.setAside.issues
            .slice(0, 3)
            .map((i) => `${i.path} ${i.message}`)
            .join("; ")}
        </p>
      )}
    </div>
  );
}

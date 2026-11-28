import type { IPanelLayout } from "@brr/client";
import type { ReactNode } from "react";
import { Icon } from "./icons/icon.tsx";
import { usePanelLayout } from "./use-panel-layout.ts";

const LIBRARY_BODY_ID = "library-body";

export function LibraryColumn({
  panels,
  hidden,
  children,
}: {
  readonly panels: IPanelLayout;
  readonly hidden: boolean;
  readonly children: ReactNode;
}) {
  const { library: open } = usePanelLayout(panels);
  return (
    <aside className="library" data-open={open} hidden={hidden} aria-label="Library">
      <header className="library-bar">
        <button
          type="button"
          className="library-toggle"
          data-action="toggle-library"
          aria-expanded={open}
          aria-controls={LIBRARY_BODY_ID}
          title={open ? "Hide the library for a wider view" : "Show the library"}
          onClick={() => panels.setOpen("library", !open)}
        >
          <Icon name="sidebar" />
          <span className={open ? "visually-hidden" : undefined}>
            {open ? "Hide the library" : "Library"}
          </span>
        </button>
      </header>
      <div id={LIBRARY_BODY_ID} className="library-body" hidden={!open}>
        {children}
      </div>
    </aside>
  );
}

import type { IPanelLayout } from "@brr/client";
import type { ReactNode } from "react";
import { Icon } from "./icons/icon.tsx";
import { usePanelLayout } from "./use-panel-layout.ts";

const LIBRARY_BODY_ID = "library-body";

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d="M4 20 A16 16 0 0 1 20 4" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M8 20 A12 12 0 0 1 20 8" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M5.2 14.4 l3.6 1.2 M8 10.4 l3 2.2 M11.6 7 l2.2 3 M15.6 4.8 l1.2 3.6"
        stroke="currentColor"
        strokeWidth="1.6"
      />
    </svg>
  );
}

export function LibraryColumn({
  panels,
  children,
}: {
  readonly panels: IPanelLayout;
  readonly children: ReactNode;
}) {
  const { library: open } = usePanelLayout(panels);
  return (
    <aside className="library" data-open={open} aria-label="Library">
      <header className="library-bar">
        <h1 className="brand">
          <BrandMark />
          Brick Railroad
        </h1>
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

import { COMMAND_GROUPS, COMMANDS, POINTER_GESTURES } from "@brr/client";
import { useEffect, useRef } from "react";
import { CommandKeys, shortcutText } from "./keys.tsx";

export function ShortcutSheet({ onClose }: { readonly onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  return (
    <div
      className="overlay"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        className="shortcut-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-sheet-title"
      >
        <header>
          <h2 id="shortcut-sheet-title">Keyboard shortcuts</h2>
          <button ref={closeRef} type="button" className="overlay-close" onClick={onClose}>
            Close <kbd>Esc</kbd>
          </button>
        </header>
        <div className="shortcut-columns">
          {COMMAND_GROUPS.map((group) => (
            <section key={group} className="shortcut-group" data-group={group}>
              <h3>{group}</h3>
              <dl>
                {COMMANDS.filter((spec) => spec.group === group && spec.keys.length > 0).map(
                  (spec) => (
                    <div key={spec.id} data-command={spec.id}>
                      <dt>{spec.title}</dt>
                      <dd>
                        <CommandKeys id={spec.id} />
                      </dd>
                    </div>
                  ),
                )}
              </dl>
            </section>
          ))}
          <section className="shortcut-group" data-group="Mouse">
            <h3>Mouse</h3>
            <dl>
              {POINTER_GESTURES.map((gesture) => (
                <div key={gesture.gesture}>
                  <dt>{gesture.action}</dt>
                  <dd className="gesture">{gesture.gesture}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
        <p className="shortcut-footer">
          Press <kbd>{shortcutText("show-shortcuts")}</kbd> anywhere in the editor to open this
          sheet.
        </p>
      </section>
    </div>
  );
}

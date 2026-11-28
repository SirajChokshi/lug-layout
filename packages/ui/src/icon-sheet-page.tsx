import { ICON_NAMES, type IconName } from "./icons/glyphs.ts";
import { Icon } from "./icons/icon.tsx";
import { ICON_SIZES } from "./icons/shapes.ts";
import { SitePage } from "./site-chrome.tsx";

const PRESSED_SAMPLE: IconName = "select";
const DISABLED_SAMPLE: IconName = "redo";

export function IconSheetPage({ disclaimer }: { readonly disclaimer: string }) {
  return (
    <SitePage title="Icons" disclaimer={disclaimer}>
      <p className="lead">
        The editor's icons, drawn on a 16-unit grid and fitted to whole pixels at 16, 20 and 24 px.
        Each zoom shows the 16 px fit on its pixel grid.
      </p>
      <div className="icon-sheet-strip" role="toolbar" aria-label="Every icon in a toolbar">
        {ICON_NAMES.map((name) => (
          <button
            key={name}
            type="button"
            aria-label={name}
            title={name}
            aria-pressed={name === PRESSED_SAMPLE}
            disabled={name === DISABLED_SAMPLE}
          >
            <Icon name={name} />
          </button>
        ))}
      </div>
      <ul className="icon-sheet-grid">
        {ICON_NAMES.map((name) => (
          <li key={name}>
            <span className="icon-sheet-zoom">
              <Icon name={name} />
            </span>
            {ICON_SIZES.map((size) => (
              <Icon key={size} name={name} size={size} />
            ))}
            <code>{name}</code>
          </li>
        ))}
      </ul>
    </SitePage>
  );
}

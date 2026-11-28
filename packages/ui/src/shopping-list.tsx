import {
  SHOPPING_SECTION_LABEL,
  type IPaletteThumbnails,
  type ShoppingGroup,
  type ShoppingList,
} from "@brr/client";
import { useState } from "react";
import { Thumbnail, ThumbnailsContext } from "./thumbnail.tsx";

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function quantityOf(group: ShoppingGroup): number {
  return group.lines.reduce((sum, line) => sum + line.quantity, 0);
}

export function ShoppingLines({
  list,
  thumbnails,
}: {
  readonly list: ShoppingList;
  readonly thumbnails: IPaletteThumbnails | null;
}) {
  const [setsAsParts, showSetsAsParts] = useState(false);
  const groups = setsAsParts ? list.asParts : list.asSets;
  return (
    <ThumbnailsContext value={thumbnails}>
      <div className="shopping-list" data-sets-as-parts={setsAsParts}>
        {list.asSets.some((group) => group.section === "sets") && (
          <label className="shopping-toggle">
            <input
              type="checkbox"
              checked={setsAsParts}
              onChange={(event) => showSetsAsParts(event.target.checked)}
            />
            Show sets as parts
          </label>
        )}
        {groups.length === 0 && <p className="shopping-empty">Nothing is placed here.</p>}
        {groups.map((group) => (
          <section
            key={group.section}
            className="shopping-group"
            data-section={group.section}
            aria-label={SHOPPING_SECTION_LABEL[group.section]}
          >
            <h3>
              {SHOPPING_SECTION_LABEL[group.section]}
              <span className="shopping-count">{integer.format(quantityOf(group))}</span>
            </h3>
            <ul>
              {group.lines.map((line) => (
                <li key={line.key} className="shopping-line" data-line={line.key}>
                  <Thumbnail item={line} />
                  <span className="shopping-name">
                    {line.label}
                    {line.partsEach > 1 && (
                      <span className="shopping-meta">
                        {integer.format(line.partsEach)} parts each
                      </span>
                    )}
                  </span>
                  <span className="shopping-quantity">× {integer.format(line.quantity)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </ThumbnailsContext>
  );
}

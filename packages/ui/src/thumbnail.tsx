import type { CatalogItemView, IPaletteThumbnails } from "@brr/client";
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";

const THUMBNAIL_SLOT_PX = 52;
const THUMBNAIL_LOOKAHEAD = "200px";
const NO_THUMBNAILS: ReadonlyMap<string, string> = new Map();

type Thumbnailed = Pick<CatalogItemView, "id" | "thumbnail">;

export const ThumbnailsContext = createContext<IPaletteThumbnails | null>(null);

function useScrolledIntoView(node: HTMLElement | null): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setSeen(true);
        observer.disconnect();
      },
      { rootMargin: THUMBNAIL_LOOKAHEAD },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen, node]);
  return seen;
}

function RenderedThumbnail({ item }: { readonly item: Thumbnailed | undefined }) {
  const thumbnails = useContext(ThumbnailsContext);
  const [node, setNode] = useState<HTMLElement | null>(null);
  const seen = useScrolledIntoView(node);
  const urls = useSyncExternalStore(
    (listener) => thumbnails?.subscribe(listener) ?? (() => {}),
    () => thumbnails?.snapshot() ?? NO_THUMBNAILS,
  );
  const id = item?.id;
  useEffect(() => {
    if (seen && id !== undefined) thumbnails?.request(id);
  }, [thumbnails, id, seen]);
  const url = id === undefined ? undefined : urls.get(id);
  return url ? (
    <img ref={setNode} className="palette-thumb" src={url} alt="" data-thumb={id} />
  ) : (
    <span ref={setNode} className="palette-thumb palette-thumb-empty" aria-hidden="true" />
  );
}

export function Thumbnail({ item }: { readonly item: Thumbnailed | undefined }) {
  if (!item?.thumbnail) return <RenderedThumbnail item={item} />;
  return (
    <img
      className="palette-thumb"
      src={item.thumbnail}
      alt=""
      width={THUMBNAIL_SLOT_PX}
      height={THUMBNAIL_SLOT_PX}
      loading="lazy"
      decoding="async"
      data-thumb={item.id}
    />
  );
}

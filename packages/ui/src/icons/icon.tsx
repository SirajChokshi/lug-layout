import { ICON_GLYPHS, type IconName } from "./glyphs.ts";
import { fitGlyph, pathData } from "./hinting.ts";
import type { IconSize } from "./shapes.ts";

interface RenderedShape {
  readonly className: string;
  readonly d: string;
  readonly opacity: number | undefined;
}

const rendered = new Map<string, ReadonlyArray<RenderedShape>>();

function renderedShapes(name: IconName, size: IconSize): ReadonlyArray<RenderedShape> {
  const key = `${name}@${size}`;
  const cached = rendered.get(key);
  if (cached) return cached;
  const shapes = fitGlyph(ICON_GLYPHS[name], size).map((shape) => ({
    className: shape.halo ? `icon-${shape.tone} icon-halo` : `icon-${shape.tone}`,
    d: pathData(shape.segments),
    opacity: shape.opacity === 1 ? undefined : shape.opacity,
  }));
  rendered.set(key, shapes);
  return shapes;
}

export function Icon({ name, size = 16 }: { readonly name: IconName; readonly size?: IconSize }) {
  return (
    <svg
      className="icon"
      data-icon={name}
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      {renderedShapes(name, size).map((shape, index) => (
        <path key={index} className={shape.className} d={shape.d} opacity={shape.opacity} />
      ))}
    </svg>
  );
}

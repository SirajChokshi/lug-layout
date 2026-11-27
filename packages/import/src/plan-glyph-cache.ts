import type { BakeInputs } from "./brick-compiler.ts";
import { sha256Hex, type IByteCache } from "./verified-files.ts";

const KEY_PREFIX = "plan-glyph/";
const utf8 = new TextEncoder();

type GlyphBakeInputs = Pick<
  BakeInputs,
  "source" | "drawn" | "studPrimitives" | "unofficialAllowlist" | "translucentColors"
>;

export interface CachedGlyph {
  readonly glyph: Uint8Array | null;
  keep(glyph: Uint8Array): Promise<void>;
}

export class PlanGlyphCache {
  constructor(
    private readonly compiler: string,
    private readonly cache: IByteCache,
  ) {}

  async entry(library: string, bake: GlyphBakeInputs): Promise<CachedGlyph> {
    const named = utf8.encode(
      JSON.stringify([
        this.compiler,
        library,
        bake.studPrimitives,
        bake.unofficialAllowlist,
        bake.translucentColors,
        bake.source,
      ]),
    );
    const content = new Uint8Array(named.length + bake.drawn.length);
    content.set(named);
    content.set(bake.drawn, named.length);
    const key = `${KEY_PREFIX}${await sha256Hex(content)}`;
    return {
      glyph: (await this.cache.get(key)) ?? null,
      keep: (glyph) => this.cache.put(key, glyph),
    };
  }
}

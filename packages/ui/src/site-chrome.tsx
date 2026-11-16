import type { BundleLod } from "@brr/client";
import type { ReactNode } from "react";
import type { CreditsState } from "./use-credits.ts";

export const CREDITS_HREF = "?page=credits";
export const ABOUT_HREF = "?page=about";
export const EDITOR_HREF = "./";

export function partsCreditText(files: number, lod: BundleLod): string {
  return `Parts and colours: LDraw parts library, ${files} files credited for the ${lod}-detail bundle (every level of detail is on the Credits page), modified from LDraw: flattened, studs extracted. `;
}

export function CreditLinks() {
  return (
    <>
      <a href={CREDITS_HREF}>Credits</a> · <a href={ABOUT_HREF}>About</a>
    </>
  );
}

interface SitePageProps {
  readonly title: string;
  readonly disclaimer: string;
  readonly children: ReactNode;
}

export function SiteLinks() {
  return (
    <nav className="site-links">
      <a href={EDITOR_HREF}>Editor</a>
      <a href={CREDITS_HREF}>Credits</a>
      <a href={ABOUT_HREF}>About</a>
    </nav>
  );
}

export function SitePage({ title, disclaimer, children }: SitePageProps) {
  return (
    <div className="site-page">
      <header className="site-header">
        <h1>Brick Railroad · {title}</h1>
        <SiteLinks />
      </header>
      <main className="site-main">{children}</main>
      <footer className="site-footer">{disclaimer}</footer>
    </div>
  );
}

export function LoadingOrError({ state }: { readonly state: CreditsState }) {
  switch (state.kind) {
    case "loading":
      return <p>Loading the bundle manifests…</p>;
    case "failed":
      return <p className="error">{state.message}</p>;
    case "loaded":
      return null;
    default: {
      const unhandled: never = state;
      throw new Error(`unhandled ${String(unhandled)}`);
    }
  }
}

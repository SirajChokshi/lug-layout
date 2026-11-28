export type SitePage = "app" | "credits" | "about" | "icons";

const PAGES: ReadonlyArray<SitePage> = ["credits", "about", "icons"];

function isPage(page: string | null): page is SitePage {
  return PAGES.some((known) => known === page);
}

export function readSitePage(search: string): SitePage {
  const page = new URLSearchParams(search).get("page");
  return isPage(page) ? page : "app";
}

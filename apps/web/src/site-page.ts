export type SitePage = "app" | "credits" | "about";

export function readSitePage(search: string): SitePage {
  const page = new URLSearchParams(search).get("page");
  return page === "credits" || page === "about" ? page : "app";
}

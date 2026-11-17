import { expect, it } from "vitest";
import { LdrawMirror, type FetchFunction } from "./ldraw-mirror.ts";

const SOURCE = {
  repo: "kulits/ldraw-parts",
  commit: "c70360d1c588be894997b2168c61909bc8058c4d",
  root: "ldraw",
};
const LIBRARY_PATH = "kulits/ldraw-parts/c70360d1c588be894997b2168c61909bc8058c4d/ldraw";

it.each([
  {
    name: "below the configured library URL",
    baseUrl: "https://library.example.org/",
    path: "parts/3001.dat",
    expected: `https://library.example.org/${LIBRARY_PATH}/parts/3001.dat`,
  },
  {
    name: "from the GitHub raw mirror when no library URL is configured",
    baseUrl: undefined,
    path: "parts/3001.dat",
    expected: `https://raw.githubusercontent.com/${LIBRARY_PATH}/parts/3001.dat`,
  },
  {
    name: "whose names hold URL delimiters, such as box3#8p.dat",
    baseUrl: "https://library.example.org",
    path: "p/box3#8p.dat",
    expected: `https://library.example.org/${LIBRARY_PATH}/p/box3%238p.dat`,
  },
])("fetches library files $name", async ({ baseUrl, path, expected }) => {
  const requested: string[] = [];
  const fetchUrl: FetchFunction = async (url) => {
    requested.push(url);
    return new Response("0 Brick 2 x 4\n");
  };

  const text = await new LdrawMirror(SOURCE, fetchUrl, baseUrl).file(path);

  expect(requested).toEqual([expected]);
  expect(text).toBe("0 Brick 2 x 4\n");
});

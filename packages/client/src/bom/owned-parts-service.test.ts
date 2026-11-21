import { INDEXED_DB } from "@brr/storage";
import { IDBFactory } from "fake-indexeddb";
import { Container } from "inversify";
import { expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { OWNED_PARTS } from "../tokens.ts";
import type { IOwnedParts, TextFile } from "./owned-parts-service.ts";

const OWNED_CSV = "Part,Color,Quantity\n3001,4,6\nnot a row\n";

function csvFile(name: string, text: string): TextFile {
  return { name, text: async () => text };
}

async function openApp(browser: IDBFactory): Promise<IOwnedParts> {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(INDEXED_DB).toConstantValue(browser);
  const owned = container.get(OWNED_PARTS);
  await owned.load();
  return owned;
}

it("keeps imported parts across a reload, with the rows it couldn't read, and forgets them once cleared", async () => {
  const browser = new IDBFactory();
  const first = await openApp(browser);
  expect(first.view()).toEqual({ loaded: true, owned: null, problem: null });

  await first.importFile(csvFile("mine.csv", OWNED_CSV));
  const reloaded = await openApp(browser);

  expect(reloaded.view()).toEqual({
    loaded: true,
    problem: null,
    owned: {
      name: "mine.csv",
      parts: [{ part: "3001", color: 4, quantity: 6 }],
      total: 6,
      rejected: [{ line: 3, text: "not a row" }],
    },
  });

  await reloaded.clear();
  expect((await openApp(browser)).view().owned).toBeNull();
});

it("keeps the parts it has, saved and shown, when a file without the three columns is imported", async () => {
  const browser = new IDBFactory();
  const owned = await openApp(browser);
  await owned.importFile(csvFile("mine.csv", OWNED_CSV));

  await owned.importFile(csvFile("other.csv", "id,qty\n3001,1\n"));

  expect(owned.view()).toMatchObject({
    owned: { name: "mine.csv" },
    problem: "other.csv: the first row must name the columns Part, Color and Quantity",
  });
  expect((await openApp(browser)).view().owned?.name).toBe("mine.csv");
});

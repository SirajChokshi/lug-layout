import type { RosterChange } from "@brr/domain";
import { ContributorTableV2 } from "@brr/schema/world";
import { decode } from "@brr/schema/decode";
import { Container } from "inversify";
import { describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { CONTRIBUTOR_SERVICE } from "../tokens.ts";

function contributorService() {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  const contributors = container.get(CONTRIBUTOR_SERVICE);
  const changes: RosterChange[] = [];
  contributors.onEdit((change) => changes.push(change));
  return { contributors, changes };
}

function csv(name: string, text: string) {
  return { name, text: async () => text };
}

describe("ContributorService", () => {
  it("reports each roster edit once, with the rosters before and after it, and nothing for a no-op or a refusal", () => {
    const { contributors, changes } = contributorService();
    const ada = contributors.create("  Ada ");
    const grace = contributors.create("Grace");
    if (!ada.ok || !grace.ok) throw new Error("a contributor was refused");
    contributors.rename(ada.value, "Ada L.");
    contributors.rename(ada.value, "Ada L.");
    contributors.recolour(grace.value, "#AA3300");
    const refused = {
      blank: contributors.rename(ada.value, " "),
      colour: contributors.recolour(ada.value, "red"),
      unlisted: contributors.remove(9),
    };
    contributors.remove(grace.value);

    expect(changes.map(({ action, contributor }) => [action, contributor])).toEqual([
      ["add", ada.value],
      ["add", grace.value],
      ["rename", ada.value],
      ["recolour", grace.value],
      ["remove", grace.value],
    ]);
    expect(changes.every((change, i) => i === 0 || change.before === changes[i - 1]?.after)).toBe(
      true,
    );
    expect(changes[3]?.after.find((row) => row.id === grace.value)?.color).toBe("#aa3300");
    expect(contributors.roster().map(({ id, name }) => [id, name])).toEqual([
      [ada.value, "Ada L."],
    ]);
    expect(Object.values(refused).map((issues) => issues.length)).toEqual([1, 1, 1]);
  });

  it("gives new contributors distinct colours a saved roster accepts", () => {
    const { contributors } = contributorService();
    for (let n = 0; n < 12; n++) contributors.create(`Member ${n}`);
    const roster = contributors.roster();

    expect(decode(ContributorTableV2, roster, "contributors").ok).toBe(true);
    expect(new Set(roster.map((row) => row.color)).size).toBe(roster.length);
  });

  it("edits inventories as roster steps: a collection replaces only its Rebrickable lines, counts add LDraw lines and a 0 drops one, a rename keeps them, and a no-op or a refusal makes no step", async () => {
    const { contributors, changes } = contributorService();
    const ada = contributors.create("Ada");
    const linus = contributors.create("Linus");
    if (!ada.ok || !linus.ok) throw new Error("a contributor was refused");
    const steps = () => changes.map(({ action, contributor }) => [action, contributor]);

    contributors.countParts(ada.value, [
      { part: "ldraw:74746", ldrawColor: 0, quantity: 2 },
      { part: "custom:0f3a9c/my-brick.dat", ldrawColor: 1, quantity: 1 },
    ]);
    const read = await contributors.importCollection(
      ada.value,
      csv("ada.csv", "Part,Color,Quantity\n3001,4,6\nnot a row\n3001,4,2\n"),
    );
    contributors.setCount(ada.value, "ldraw:74746", 0, 40);
    contributors.rename(ada.value, "Ada L.");
    contributors.countParts(linus.value, [{ part: "ldraw:74746", ldrawColor: 0, quantity: 8 }]);
    const budget = contributors.eventBudget();
    const sameBudget = contributors.eventBudget() === budget;
    const edited = steps();
    const refused = {
      fraction: contributors.setCount(ada.value, "ldraw:3811", 2, 1.5),
      unlisted: contributors.setCount(9, "ldraw:3811", 2, 1),
      noOp: contributors.setCount(ada.value, "ldraw:74746", 0, 40),
      columns: await contributors.importCollection(ada.value, csv("x.csv", "Part,Colour\n")),
    };
    const afterRefusals = steps();
    contributors.setCount(linus.value, "ldraw:74746", 0, 0);

    expect(edited).toEqual([
      ["add", ada.value],
      ["add", linus.value],
      ["inventory", ada.value],
      ["inventory", ada.value],
      ["inventory", ada.value],
      ["rename", ada.value],
      ["inventory", linus.value],
    ]);
    expect(afterRefusals).toEqual(edited);
    expect(read.ok && [read.owned.total, read.owned.rejected.map((row) => row.line)]).toEqual([
      8,
      [3],
    ]);
    expect(refused).toEqual({
      fraction: [
        {
          path: `inventory of contributor ${ada.value}.ldraw.0.quantity`,
          message: "must be an integer",
        },
      ],
      unlisted: [{ path: "contributor 9", message: "isn't on the roster" }],
      noOp: [],
      columns: {
        ok: false,
        problem: "x.csv: the first row must name the columns Part, Color and Quantity",
      },
    });
    expect(budget).toEqual({
      rebrickable: [{ part: "3001", color: 4, quantity: 8 }],
      ldraw: [{ part: "ldraw:74746", color: 0, quantity: 48 }],
    });
    expect(sameBudget).toBe(true);
    expect(contributors.roster()).toEqual([
      {
        id: ada.value,
        name: "Ada L.",
        color: contributors.roster()[0]?.color,
        inventory: {
          rebrickable: [{ part: "3001", color: 4, quantity: 8 }],
          ldraw: [{ part: "ldraw:74746", color: 0, quantity: 40 }],
        },
      },
      { id: linus.value, name: "Linus", color: contributors.roster()[1]?.color },
    ]);
  });

  it("asks every removal guard first and keeps the contributor when one refuses", () => {
    const { contributors, changes } = contributorService();
    const ada = contributors.create("Ada");
    if (!ada.ok) throw new Error("the contributor was refused");
    contributors.guardRemoval((id) => (id === ada.value ? "owns 2 models" : null));

    expect(contributors.remove(ada.value)).toEqual([
      { path: `contributor ${ada.value}`, message: "owns 2 models" },
    ]);
    expect(contributors.roster()).toHaveLength(1);
    expect(changes).toHaveLength(1);
  });
});

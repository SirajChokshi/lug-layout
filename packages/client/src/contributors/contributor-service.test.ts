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

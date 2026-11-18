import { expect, test } from "@playwright/test";
import { EditorPage } from "./editor-page.ts";

const GROCER = "omr:10185-1";

test("a set whose far meshes streamed in at the near tier is rebuilt with them when the view switches to mid", async ({
  page,
}) => {
  const editor = await EditorPage.open(page, "&tier=near");
  await editor.placeAt(GROCER, { x: 0, z: 0 });
  await editor.escape();
  await editor.waitForFarTierAndMeshesSettled();

  await editor.press("l");
  expect(await editor.hud("Tier (L)")).toBe("mid");
  const switched = await editor.steadyTriangles();
  await editor.undo();
  await editor.redo();
  await editor.waitForFarTierAndMeshesSettled();
  const rebuiltAtMid = await editor.steadyTriangles();

  expect(switched).toBeGreaterThan(0);
  expect(switched).toBe(rebuiltAtMid);
});

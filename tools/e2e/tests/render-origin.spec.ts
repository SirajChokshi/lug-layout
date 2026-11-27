import { expect, test } from "@playwright/test";
import { EditorPage } from "./editor-page.ts";

const CHUNK_LDU = 640;
const CHUNKS_ALONG = 3;
const ORIGIN_ROW = "Render origin (chunks), rebases";
const ORIGIN_TEXT = /^\((-?\d+), (-?\d+)\); (\d+)$/u;

interface RenderOrigin {
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly rebases: number;
}

async function restingOrigin(editor: EditorPage): Promise<RenderOrigin> {
  const text = await editor.steadyHud(ORIGIN_ROW);
  const match = ORIGIN_TEXT.exec(text);
  if (!match) throw new Error(`unreadable render origin "${text}"`);
  return { chunkX: Number(match[1]), chunkZ: Number(match[2]), rebases: Number(match[3]) };
}

test("once the camera comes to rest three chunks along, the render origin follows the eye there with one rebase, and the ground under the cursor moves with it", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.goTo({ x: 0, z: 0 });
  const before = await restingOrigin(editor);
  const centre = await editor.canvasCentre();
  const groundBefore = await editor.hoverAt(centre);

  await editor.goTo({ x: CHUNKS_ALONG * CHUNK_LDU, z: 0 });
  const after = await restingOrigin(editor);
  const groundAfter = await editor.hoverAt(centre);

  expect({ after, groundAfter }).toEqual({
    after: {
      chunkX: before.chunkX + CHUNKS_ALONG,
      chunkZ: before.chunkZ,
      rebases: before.rebases + 1,
    },
    groundAfter: {
      x: (groundBefore?.x ?? Number.NaN) + CHUNKS_ALONG * CHUNK_LDU,
      z: groundBefore?.z,
    },
  });
});

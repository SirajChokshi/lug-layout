const lib = require('./s5-lib.cjs');
(async () => {
  const { browser, page } = await lib.openEditor({ api: 'webgl2', base: 'http://localhost:4173', width: 1280, height: 720 });
  await lib.zoom(page, 520);
  for (const [x, z] of [[-320, -320], [320, -320], [-320, 320], [320, 320]]) await lib.place(page, 'ldraw:3811', x, z, 0);
  await lib.place(page, 'omr:10185-1', -320, -320, 0);
  await lib.place(page, 'omr:10218-1', 320, -320, 1);
  await lib.place(page, 'omr:10190-1', -320, 320, 2);
  await lib.place(page, 'omr:10128-1', 640, 320, 3);
  for (const [x, z, id] of [[320, -320, 'omr:10218-1'], [-320, -320, 'omr:10185-1'], [640, 320, 'omr:10128-1'], [-320, 320, 'omr:10190-1']]) {
    await lib.selectAt(page, x, z, id);
    console.log('selected', id, 'by clicking its centre');
  }
  await page.screenshot({ path: '/tmp/s5/pick-check.png' });
  await browser.close();
})().catch((e) => { console.error(e.message.split('\n')[0]); process.exit(1); });

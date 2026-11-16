const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync, spawnSync } = require('node:child_process');

let playwright;
try {
  playwright = require('playwright-core');
} catch {
  playwright = null;
}
if (playwright) installShim();

function installShim() {
  const LOG = process.env.FOCUS_LOG || path.join(process.env.HOME, 'brr-s7', 'focus.log');
  const FLAGS = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];
  const FFMPEG = (() => {
    if (fs.existsSync('/opt/homebrew/bin/ffmpeg')) return '/opt/homebrew/bin/ffmpeg';
    const root = path.join(os.homedir(), 'Library/Caches/ms-playwright');
    const dir = fs.existsSync(root) ? fs.readdirSync(root).find((d) => d.startsWith('ffmpeg-')) : null;
    return dir ? path.join(root, dir, 'ffmpeg-mac') : 'ffmpeg';
  })();

  const frontmost = () => {
    try {
      return execSync(`osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`).toString().trim();
    } catch {
      return 'unknown';
    }
  };
  const log = (line) => fs.appendFileSync(LOG, `${new Date().toISOString()} ${path.basename(process.argv[1] || '')} ${process.argv.slice(2).join(' ')} :: ${line}\n`);

  async function backgroundTab(browser, base) {
    const session = await browser.newBrowserCDPSession();
    const pageEvent = base.waitForEvent('page', { timeout: 30000 });
    await session.send('Target.createTarget', { url: 'about:blank', background: true });
    const page = await pageEvent;
    await session.detach().catch(() => {});
    return page;
  }

  async function tabContext(browser, base, opts) {
    const viewport = opts.viewport ?? null;
    const dpr = opts.deviceScaleFactor ?? 1;
    const videoDir = opts.recordVideo?.dir ?? null;
    const tabs = [];
    return {
      async newPage() {
        const page = await backgroundTab(browser, base);
        const cdp = await base.newCDPSession(page);
        if (viewport) {
          await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: dpr, mobile: false });
        }
        page.viewportSize = () => viewport;
        page.screenshot = async (o = {}) => {
          const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
          const buffer = Buffer.from(data, 'base64');
          if (o.path) fs.writeFileSync(o.path, buffer);
          return buffer;
        };
        const tab = { page, cdp, frames: null };
        if (videoDir) {
          tab.frames = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'brr-cast-')), list: [] };
          cdp.on('Page.screencastFrame', async (e) => {
            const file = path.join(tab.frames.dir, `${String(tab.frames.list.length).padStart(6, '0')}.jpg`);
            fs.writeFileSync(file, Buffer.from(e.data, 'base64'));
            tab.frames.list.push({ file, t: e.metadata.timestamp });
            cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
          });
          await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: viewport?.width ?? 1800, maxHeight: viewport?.height ?? 1000, everyNthFrame: 1 });
        }
        tabs.push(tab);
        return page;
      },
      pages() {
        return tabs.map((t) => t.page);
      },
      async close() {
        for (const tab of tabs) {
          if (tab.frames) {
            await tab.cdp.send('Page.stopScreencast').catch(() => {});
            const frames = tab.frames.list;
            if (frames.length > 1) {
              const lines = [];
              for (let i = 0; i < frames.length; i++) {
                const duration = i + 1 < frames.length ? Math.max(0.001, frames[i + 1].t - frames[i].t) : 0.04;
                lines.push(`file '${frames[i].file}'`, `duration ${duration.toFixed(4)}`);
              }
              lines.push(`file '${frames[frames.length - 1].file}'`);
              const list = path.join(tab.frames.dir, 'list.txt');
              fs.writeFileSync(list, lines.join('\n'));
              const out = path.join(videoDir, `page@${crypto.randomBytes(16).toString('hex')}.webm`);
              const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vsync', 'vfr', '-c:v', 'vp8', '-b:v', '2M', out]);
              log(`video ${out} from ${frames.length} screencast frames, ffmpeg exit ${r.status}${r.status ? ` ${String(r.stderr).replace(/\s+/g, ' ').slice(0, 200)}; frames kept in ${tab.frames.dir}` : ''}`);
              if (r.status === 0) fs.rmSync(tab.frames.dir, { recursive: true, force: true });
            } else {
              fs.rmSync(tab.frames.dir, { recursive: true, force: true });
            }
          }
          await tab.page.close().catch(() => {});
        }
      },
    };
  }

  const port = 9400 + (process.pid % 500);
  playwright.chromium.launch = async function launch() {
    const previous = frontmost();
    log(`start: frontmost=${previous}`);
    const shared = process.env.BRR_CDP_URL;
    const profile = shared ? null : fs.mkdtempSync('/tmp/brr-bgwin-');
    if (!shared) {
      spawnSync('open', ['-g', '-n', '-a', 'Google Chrome', '--args', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--window-size=1800,1130', '--window-position=0,0', '--no-first-run', '--no-default-browser-check', ...FLAGS, 'about:blank']);
    }
    let browser;
    for (let t = 0; t < 60 && !browser; t++) {
      try {
        browser = await playwright.chromium.connectOverCDP(shared || `http://127.0.0.1:${port}`);
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!browser) throw new Error('background Chrome did not start');
    const base = browser.contexts()[0];
    browser.newContext = (opts = {}) => tabContext(browser, base, opts);
    const restore = previous && previous !== 'Google Chrome' ? previous : null;
    const watch = setInterval(() => {
      if (frontmost() === 'Google Chrome' && restore) {
        if (process.env.FOCUS_RESTORE === '0') {
          log('Chrome became frontmost (restore disabled)');
          return;
        }
        spawnSync('osascript', ['-e', `tell application "${restore}" to activate`]);
        log(`Chrome became frontmost; re-activated ${restore} (now ${frontmost()})`);
      }
    }, 250);
    watch.unref();
    const close = browser.close.bind(browser);
    browser.close = async () => {
      clearInterval(watch);
      try { await close(); } catch {}
      if (profile) spawnSync('pkill', ['-f', profile]);
      log(`end: frontmost=${frontmost()}`);
    };
    return browser;
  };
}

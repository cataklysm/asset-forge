import assert from 'node:assert/strict';
import { app, BrowserWindow, session } from 'electron';

app.setPath('userData', process.env.ASSETFORGE_SMOKE_USER_DATA);
process.on('uncaughtException', (error) => {
  console.error(error);
  app.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error(error);
  app.exit(1);
});
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
console.log('Starting isolated native Electron discovery smoke.');
// Finish ESM startup before awaiting Electron readiness.
app.whenReady().then(async () => {
  const { createElectronSiteSessions } = await import('../../src/main/site-sessions.ts');
  const isolated = session.fromPartition('gallery-native-smoke');
  const requested = [];
  // Every HTTPS response is synthetic. No remote website, login or existing asset data is accessed.
  isolated.protocol.handle('https', async (request) => {
    requested.push(request.url);
    const id = new URL(request.url).pathname.slice(1);
    return new Response(
      `<!doctype html><html><body><a id="download"></a><script>
    setTimeout(() => document.querySelector('a').href = '/${id}.jpg', 180);
  </script></body></html>`,
      { headers: { 'content-type': 'text/html' } },
    );
  });
  let opened = 0;
  let unexpectedlyGone = 0;
  const sessions = createElectronSiteSessions({
    fromPartition: () => isolated,
    createWindow: (options) => {
      opened++;
      return new BrowserWindow({ ...options, show: false });
    },
    resolve: async () => ['93.184.216.34'],
    timing: { pollMs: 40, settleMs: 2000, totalMs: 8000 },
  });
  const profile = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Native smoke',
    site: 'example.com',
    thumbnails: '//a/@href',
    pagination: '',
    file: '',
    kinds: ['image'],
    minBytes: 0,
    urlContains: '',
    maxPages: 10,
    maxFiles: 20,
    detailConcurrency: 3,
    requestGapMs: 0,
  };
  const page = sessions.openPage(profile, () => {
    unexpectedlyGone++;
  });
  try {
    const controller = new AbortController();
    const outcomes = await Promise.all(
      ['one', 'two', 'three'].map((id) =>
        page.loader.load(`https://example.com/${id}`, {
          queries: { file: '//a/@href' },
          waitFor: 'file',
          signal: controller.signal,
        }),
      ),
    );
    assert.equal(opened, 3, 'Concurrent navigation must use independent native windows');
    assert.equal(requested.length, 3, 'Each synthetic detail page must be requested once');
    for (const [i, id] of ['one', 'two', 'three'].entries()) {
      assert.equal(outcomes[i].ok, true);
      assert.deepEqual(
        outcomes[i].results.file.map((value) => new URL(value, outcomes[i].baseUrl).href),
        [`https://example.com/${id}.jpg`],
      );
    }
    assert.equal(unexpectedlyGone, 0);
    console.log(
      'PASS native Electron discovery: three independent browser pages, delayed usable URLs, isolated test session.',
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    page.close();
    sessions.shutdown();
    await isolated.clearStorageData();
    app.exit(process.exitCode ?? 0);
  }
});

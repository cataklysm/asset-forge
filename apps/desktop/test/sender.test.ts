import { describe, expect, it } from 'vitest';
import { isAppUrl as isRealAppUrl } from '../src/main/app-url.js';
import { ipcRefusal, isTrustedSender, type SenderEvent, type SenderWindow } from '../src/main/sender.js';

const APP_URL = 'http://localhost:5173/';
const isAppUrl = (url: string) => url === APP_URL;

function setup(frameUrl = APP_URL) {
  const mainFrame = { url: frameUrl };
  const webContents = { mainFrame };
  const window: SenderWindow = { webContents };
  const event: SenderEvent = { sender: webContents, senderFrame: mainFrame };
  return { mainFrame, webContents, window, event };
}

describe('isTrustedSender', () => {
  it('trusts the main frame of the main window at an app URL', () => {
    const { window, event } = setup();
    expect(isTrustedSender(event, window, isAppUrl)).toBe(true);
  });

  it('rejects when there is no window', () => {
    const { event } = setup();
    expect(isTrustedSender(event, null, isAppUrl)).toBe(false);
  });

  it('rejects a foreign webContents', () => {
    const { window, mainFrame } = setup();
    const event: SenderEvent = { sender: { mainFrame }, senderFrame: mainFrame };
    expect(isTrustedSender(event, window, isAppUrl)).toBe(false);
  });

  it('rejects a sub-frame', () => {
    const { window, webContents } = setup();
    const event: SenderEvent = { sender: webContents, senderFrame: { url: APP_URL } };
    expect(isTrustedSender(event, window, isAppUrl)).toBe(false);
  });

  it('rejects a null senderFrame', () => {
    const { window, webContents } = setup();
    const event: SenderEvent = { sender: webContents, senderFrame: null };
    expect(isTrustedSender(event, window, isAppUrl)).toBe(false);
  });

  it('rejects a foreign URL in the top frame', () => {
    const { window, event } = setup('https://example.com/');
    expect(isTrustedSender(event, window, isAppUrl)).toBe(false);
  });

  it('applies the real app-URL rule', () => {
    const rule = (url: string) => isRealAppUrl(url, APP_URL);
    const same = setup('http://localhost:5173/files#x');
    expect(isTrustedSender(same.event, same.window, rule)).toBe(true);
    const foreign = setup('http://localhost:5174/');
    expect(isTrustedSender(foreign.event, foreign.window, rule)).toBe(false);
  });
});

describe('ipcRefusal', () => {
  it('serves a trusted sender while running', () => {
    const { window, event } = setup();
    expect(ipcRefusal(event, window, isAppUrl, false)).toBeNull();
  });

  it('refuses a trusted sender while quitting', () => {
    const { window, event } = setup();
    expect(ipcRefusal(event, window, isAppUrl, true)).toEqual({
      ok: false,
      error: { code: 'shutting_down', message: 'The application is shutting down' },
    });
  });

  it('checks the sender before telling anyone that the app is quitting', () => {
    const { window } = setup();
    const foreignFrame = { url: APP_URL };
    const event: SenderEvent = { sender: { mainFrame: foreignFrame }, senderFrame: foreignFrame };
    for (const isShuttingDown of [false, true]) {
      expect(ipcRefusal(event, window, isAppUrl, isShuttingDown)).toEqual({
        ok: false,
        error: { code: 'forbidden_sender', message: 'IPC sender is not the main window' },
      });
    }
  });
});

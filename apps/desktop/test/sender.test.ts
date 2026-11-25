import { describe, expect, it } from 'vitest';
import { isAppUrl as isRealAppUrl } from '../src/main/app-url.js';
import { isTrustedSender, type SenderEvent, type SenderWindow } from '../src/main/sender.js';

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

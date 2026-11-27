import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { FileRecord } from '@assetforge/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ViewerList } from '../../src/renderer/src/components/FileBrowser';
import { FileDetailDialog } from '../../src/renderer/src/components/FileDetailDialog';
import { FileFrame } from '../../src/renderer/src/components/FileTile';
import { FilmStrip } from '../../src/renderer/src/components/FilmStrip';
import { resetVideoSession } from '../../src/renderer/src/components/VideoStage';
import { fileMenuItems, type FileActionContext } from '../../src/renderer/src/file-actions';
import { formatDuration } from '../../src/renderer/src/format';
import { previewUrl, videoUrl } from '../../src/renderer/src/media-url';
import { fakeError, installFakeApi, type FakeHandlers } from './fake-api';
import { fileRecord, trashedRecord, videoRecord } from './fixtures';

// jsdom has no media playback; the stage only needs play and pause to exist.
const realPlay = HTMLMediaElement.prototype.play;
const realPause = HTMLMediaElement.prototype.pause;
beforeEach(() => {
  HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve());
  HTMLMediaElement.prototype.pause = vi.fn();
});
afterEach(() => {
  // Unmount while the stubs are in place: leaving a video pauses it.
  cleanup();
  resetVideoSession();
  HTMLMediaElement.prototype.play = realPlay;
  HTMLMediaElement.prototype.pause = realPause;
});

const ACTIONS: FileActionContext = { cover: null, onDetails: () => {} };

function Harness(props: {
  file: FileRecord;
  actions?: FileActionContext;
  list?: ViewerList | null;
  onMeasured?(fileId: string, size: { width: number; height: number; durationMs?: number | null }): void;
}) {
  const [file, setFile] = useState(props.file);
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <FileDetailDialog
      file={file}
      asset={null}
      actions={props.actions ?? ACTIONS}
      roleControl={null}
      onFileChange={setFile}
      onMeasured={(id, size) => {
        props.onMeasured?.(id, size);
        setFile((current) => (current.id === id ? { ...current, ...size } : current));
      }}
      list={props.list ?? null}
      onClose={() => setOpen(false)}
    />
  );
}

function install(handlers: FakeHandlers = {}) {
  return installFakeApi({ 'tags:suggest': () => [], 'files:measure': () => videoRecord(), ...handlers });
}

function videoElement(): HTMLVideoElement {
  const video = screen.getByRole('region', { name: 'Video' }).querySelector('video');
  if (video === null) throw new Error('no video element');
  return video;
}

function detailValue(name: string): string | null | undefined {
  const details = screen.getByRole('region', { name: 'Details' });
  return within(details).queryByText(name)?.nextElementSibling?.textContent;
}

function listOf(files: FileRecord[], index: number): ViewerList {
  return {
    total: files.length,
    index,
    slot: (i) => (files[i] === undefined ? { kind: 'placeholder' } : { kind: 'loaded', item: files[i] }),
    show: vi.fn(),
    want: vi.fn(),
  };
}

/** Gives the element a duration, a settable position and a paused state jsdom does not have. */
function stubPlayback(video: HTMLVideoElement, duration = 20, start = 0) {
  let time = start;
  let paused = true;
  Object.defineProperty(video, 'duration', { configurable: true, get: () => duration });
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (value: number) => {
      time = value;
    },
  });
  Object.defineProperty(video, 'paused', { configurable: true, get: () => paused });
  const play = vi.fn(() => {
    paused = false;
    return Promise.resolve();
  });
  const pause = vi.fn(() => {
    paused = true;
  });
  video.play = play;
  video.pause = pause;
  return { play, pause, time: () => time };
}

function stubFullscreen() {
  let current: Element | null = null;
  const requestFullscreen = vi.fn(function (this: HTMLElement) {
    current = this;
    return Promise.resolve();
  });
  HTMLElement.prototype.requestFullscreen = requestFullscreen;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => current });
  document.exitFullscreen = vi.fn(() => {
    current = null;
    return Promise.resolve();
  });
  return {
    requestFullscreen,
    restore: () => {
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
      delete (document as { fullscreenElement?: unknown }).fullscreenElement;
      delete (document as { exitFullscreen?: unknown }).exitFullscreen;
    },
  };
}

it('formats a duration as m:ss, and as h:mm:ss from one hour', () => {
  expect(formatDuration(0)).toBe('0:00');
  expect(formatDuration(999)).toBe('0:00');
  expect(formatDuration(5_000)).toBe('0:05');
  expect(formatDuration(65_400)).toBe('1:05');
  expect(formatDuration(59 * 60_000 + 59_999)).toBe('59:59');
  expect(formatDuration(3_600_000)).toBe('1:00:00');
  expect(formatDuration(3_600_000 + 2 * 60_000 + 3_000)).toBe('1:02:03');
});

it('the video URL is the media protocol route of the file', () => {
  expect(videoUrl('00000000-0000-4000-8000-000000000001')).toBe('assetforge-media://video/00000000-0000-4000-8000-000000000001');
});

it('a video plays in the video stage instead of the image stage, with the poster and the fixed element options', () => {
  install();
  const file = videoRecord({ width: 1920, height: 1080 });
  render(<Harness file={file} />);
  expect(screen.queryByRole('region', { name: 'Image' })).toBeNull();
  const video = videoElement();
  expect(video.getAttribute('src')).toBe(videoUrl(file.id));
  expect(video.getAttribute('poster')).toBe(previewUrl(file.id, 'detail'));
  expect(video.getAttribute('preload')).toBe('metadata');
  expect(video.hasAttribute('controls')).toBe(true);
  expect(video.hasAttribute('autoplay')).toBe(false);
  expect(video.hasAttribute('loop')).toBe(false);
  expect(video.getAttribute('controlslist')).toBe('nofullscreen nodownload noremoteplayback');
  expect(video.hasAttribute('disablepictureinpicture')).toBe(true);
});

it('a video without a thumbnail has no poster', () => {
  install();
  render(<Harness file={videoRecord({ width: 640, height: 360, thumbnail: false })} />);
  expect(videoElement().hasAttribute('poster')).toBe(false);
});

it('the toolbar of a video has only the fullscreen button', () => {
  install();
  render(<Harness file={videoRecord({ width: 640, height: 360 })} />);
  const toolbar = screen.getByRole('toolbar', { name: 'Viewer' });
  expect(within(toolbar).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Fullscreen']);
});

it('a video the element cannot play shows the message and Open externally', async () => {
  const api = install({ 'files:openExternal': () => null });
  const file = videoRecord({ width: 640, height: 360 });
  render(<Harness file={file} />);
  fireEvent.error(videoElement());
  const stage = screen.getByRole('region', { name: 'Video' });
  expect(within(stage).getByText('This video cannot be played here')).toBeTruthy();
  expect(stage.querySelector('video')).toBeNull();
  await userEvent.setup().click(within(stage).getByRole('button', { name: 'Open externally' }));
  expect(api.calls.filter((c) => c.channel === 'files:openExternal').map((c) => c.request)).toEqual([{ fileId: file.id }]);
});

it('a failing Open externally shows its message in the dialog', async () => {
  install({
    'files:openExternal': () => {
      throw fakeError('invalid_operation', 'This file cannot be opened');
    },
  });
  render(<Harness file={videoRecord({ width: 640, height: 360 })} />);
  fireEvent.error(videoElement());
  await userEvent.setup().click(screen.getByRole('button', { name: 'Open externally' }));
  expect((await screen.findByRole('alert')).textContent).toBe('This file cannot be opened');
});

it('Open externally in the error state is disabled for a file that cannot be opened', () => {
  install();
  render(<Harness file={trashedRecord({ ...videoRecord({ width: 640, height: 360 }), deletedAt: '2026-11-27T00:00:00.000Z', openable: false })} />);
  fireEvent.error(videoElement());
  expect((screen.getByRole('button', { name: 'Open externally' }) as HTMLButtonElement).disabled).toBe(true);
});

it('the details show the dimensions and the duration when known', () => {
  install();
  const { unmount } = render(<Harness file={videoRecord({ width: 1920, height: 1080, durationMs: 65_400 })} />);
  expect(detailValue('Dimensions')).toBe('1920 × 1080 px');
  expect(detailValue('Duration')).toBe('1:05');
  const labels = [...screen.getByRole('region', { name: 'Details' }).querySelectorAll('dt')].map((dt) => dt.textContent);
  expect(labels).toEqual(['Filename', 'Format', 'Dimensions', 'Duration', 'Size', 'Imported']);
  unmount();

  render(<Harness file={videoRecord({ width: 1920, height: 1080, durationMs: null })} />);
  expect(detailValue('Duration')).toBeUndefined();
});

it('a video without dimensions is measured once and shows the measured size and duration', async () => {
  const file = videoRecord();
  const api = install({ 'files:measure': () => ({ ...file, width: 1280, height: 720, durationMs: 3_723_000 }) });
  const onMeasured = vi.fn();
  render(<Harness file={file} onMeasured={onMeasured} />);
  await waitFor(() => expect(detailValue('Duration')).toBe('1:02:03'));
  expect(detailValue('Dimensions')).toBe('1280 × 720 px');
  expect(onMeasured).toHaveBeenCalledWith(file.id, { width: 1280, height: 720, durationMs: 3_723_000 });
  expect(api.calls.filter((c) => c.channel === 'files:measure')).toHaveLength(1);
});

it('a video whose measurement fails or finds nothing is not measured again and shows no error', async () => {
  const file = videoRecord();
  const api = install({ 'files:measure': () => file });
  const { rerender } = render(<Harness file={file} />);
  await waitFor(() => expect(api.calls.filter((c) => c.channel === 'files:measure')).toHaveLength(1));
  rerender(<Harness file={{ ...file }} />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(api.calls.filter((c) => c.channel === 'files:measure')).toHaveLength(1);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(detailValue('Dimensions')).toBe('–');

  const other = videoRecord();
  const failing = install({
    'files:measure': () => {
      throw fakeError('internal_error');
    },
  });
  render(<Harness file={other} />);
  await waitFor(() => expect(failing.calls.filter((c) => c.channel === 'files:measure')).toHaveLength(1));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(failing.calls.filter((c) => c.channel === 'files:measure')).toHaveLength(1);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('Shift+arrows seek 5 s within the video, Space toggles playback, plain arrows still step on', () => {
  install();
  const files = [videoRecord({ width: 640, height: 360 }), videoRecord({ width: 640, height: 360 }), fileRecord()];
  const list = listOf(files, 1);
  render(<Harness file={files[1]!} list={list} />);
  const video = videoElement();
  const playback = stubPlayback(video, 12, 3);

  fireEvent.keyDown(video, { key: 'ArrowRight', shiftKey: true });
  expect(playback.time()).toBe(8);
  fireEvent.keyDown(video, { key: 'ArrowRight', shiftKey: true });
  expect(playback.time()).toBe(12);
  fireEvent.keyDown(video, { key: 'ArrowLeft', shiftKey: true });
  expect(playback.time()).toBe(7);
  fireEvent.keyDown(video, { key: 'ArrowLeft', shiftKey: true });
  fireEvent.keyDown(video, { key: 'ArrowLeft', shiftKey: true });
  expect(playback.time()).toBe(0);
  expect(list.show).not.toHaveBeenCalled();

  fireEvent.keyDown(video, { key: ' ' });
  expect(playback.play).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(video, { key: ' ' });
  expect(playback.pause).toHaveBeenCalledTimes(1);

  const step = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  video.dispatchEvent(step);
  expect(step.defaultPrevented).toBe(true);
  expect(list.show).toHaveBeenCalledWith(2);
  expect(playback.time()).toBe(0);
});

it('Space on a button is left to the button; image keys do nothing for a video', () => {
  install();
  render(<Harness file={videoRecord({ width: 640, height: 360 })} />);
  const video = videoElement();
  const playback = stubPlayback(video);
  fireEvent.keyDown(screen.getByRole('button', { name: 'Close' }), { key: ' ' });
  expect(playback.play).not.toHaveBeenCalled();
  for (const key of ['+', '-', '0', '1', 'r']) fireEvent.keyDown(video, { key });
  expect(playback.play).not.toHaveBeenCalled();
  expect(playback.time()).toBe(0);
  expect(screen.getByRole('region', { name: 'Video' }).querySelector('video')).toBe(video);
});

it('F and the toolbar button put the stage of a video in fullscreen', async () => {
  install();
  const fs = stubFullscreen();
  try {
    render(<Harness file={videoRecord({ width: 640, height: 360 })} />);
    fireEvent.keyDown(videoElement(), { key: 'f' });
    expect(fs.requestFullscreen).toHaveBeenCalledTimes(1);
    const target = fs.requestFullscreen.mock.contexts[0] as HTMLElement;
    expect(target.contains(screen.getByRole('region', { name: 'Video' }))).toBe(true);
    expect(target.contains(screen.getByRole('toolbar', { name: 'Viewer' }))).toBe(true);
  } finally {
    fs.restore();
  }
});

it('volume and mute carry over to the next video of the app session', () => {
  install();
  const first = render(<Harness file={videoRecord({ width: 640, height: 360 })} />);
  const video = videoElement();
  video.volume = 0.25;
  video.muted = true;
  fireEvent(video, new Event('volumechange'));
  first.unmount();

  render(<Harness file={videoRecord({ width: 640, height: 360 })} />);
  expect(videoElement().volume).toBe(0.25);
  expect(videoElement().muted).toBe(true);
});

it('leaving the video pauses it and releases the source', () => {
  install();
  const files = [videoRecord({ width: 640, height: 360 }), fileRecord()];
  const { unmount } = render(<Harness file={files[0]!} />);
  const video = videoElement();
  const playback = stubPlayback(video);
  const load = vi.fn();
  video.load = load;
  unmount();
  expect(playback.pause).toHaveBeenCalled();
  expect(video.hasAttribute('src')).toBe(false);
  expect(load).toHaveBeenCalledTimes(1);
  expect(load.mock.invocationCallOrder[0]!).toBeGreaterThan(playback.pause.mock.invocationCallOrder[0]!);
});

it('a trashed video that could otherwise be opened gets no Open externally', () => {
  install();
  render(<Harness file={trashedRecord({ ...videoRecord({ width: 640, height: 360 }), deletedAt: '2026-11-27T00:00:00.000Z', openable: true })} />);
  fireEvent.error(videoElement());
  expect((screen.getByRole('button', { name: 'Open externally' }) as HTMLButtonElement).disabled).toBe(true);
});

/** The dialog over a list whose `show` really steps, as the file browser does. */
function ListHarness({ files, start = 0 }: { files: FileRecord[]; start?: number }) {
  const [index, setIndex] = useState(start);
  const list: ViewerList = {
    total: files.length,
    index,
    slot: (i) => (files[i] === undefined ? { kind: 'placeholder' } : { kind: 'loaded', item: files[i] }),
    show: (i) => {
      if (i >= 0 && i < files.length) setIndex(i);
    },
    want: () => {},
  };
  return (
    <FileDetailDialog
      file={files[index]!}
      asset={null}
      actions={ACTIONS}
      roleControl={null}
      onFileChange={() => {}}
      onMeasured={() => {}}
      list={list}
      onClose={() => {}}
    />
  );
}


it('keys stay alive after stepping video to video by keyboard', () => {
  install();
  const files = [videoRecord({ width: 640, height: 360 }), videoRecord({ width: 640, height: 360 }), videoRecord({ width: 640, height: 360 })];
  render(<ListHarness files={files} />);
  const first = videoElement();
  // jsdom does not count a video with controls as focusable, as Chromium does.
  first.tabIndex = 0;
  first.focus();
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
  expect(videoElement()).not.toBe(first);
  expect(document.activeElement).not.toBe(document.body);
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
  expect(videoElement().getAttribute('src')).toBe(videoUrl(files[2]!.id));
  expect(document.activeElement).not.toBe(document.body);
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);

  const playback = stubPlayback(videoElement(), 20, 0);
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight', shiftKey: true });
  expect(playback.time()).toBe(5);
  fireEvent.keyDown(document.activeElement!, { key: ' ' });
  expect(playback.play).toHaveBeenCalledTimes(1);
});

it('keys stay alive after stepping image to video to image by keyboard', () => {
  install();
  const files = [fileRecord({ width: 100, height: 100 }), videoRecord({ width: 640, height: 360 }), fileRecord({ width: 100, height: 100 })];
  render(<ListHarness files={files} />);
  screen.getByRole('region', { name: 'Image' }).focus();
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
  expect(document.activeElement).not.toBe(document.body);
  const playback = stubPlayback(videoElement(), 20, 0);
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight', shiftKey: true });
  expect(playback.time()).toBe(5);
  fireEvent.keyDown(document.activeElement!, { key: ' ' });
  expect(playback.play).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
  expect(screen.getByRole('region', { name: 'Image' })).toBeTruthy();
  expect(document.activeElement).not.toBe(document.body);
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
  expect(screen.getByRole('region', { name: 'Video' })).toBeTruthy();
});

it('a file change does not take focus from an element outside the stage', () => {
  install();
  const files = [videoRecord({ width: 640, height: 360 }), videoRecord({ width: 640, height: 360 })];
  render(<ListHarness files={files} />);
  const current = videoElement();
  current.tabIndex = 0;
  current.focus();
  expect(document.activeElement).toBe(current);
  const close = screen.getByRole('button', { name: 'Close' });
  close.focus();
  fireEvent.click(screen.getByRole('button', { name: 'Next file' }));
  expect(videoElement().getAttribute('src')).toBe(videoUrl(files[1]!.id));
  expect(document.activeElement).toBe(close);
});

it('stepping on drops a failed state and the playback, video to video and video to image', () => {
  install();
  const files = [videoRecord({ width: 640, height: 360 }), videoRecord({ width: 640, height: 360 }), fileRecord({ width: 100, height: 100 })];
  render(<ListHarness files={files} />);
  fireEvent.error(videoElement());
  expect(screen.getByText('This video cannot be played here')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Next file' }));
  expect(screen.queryByText('This video cannot be played here')).toBeNull();
  const second = videoElement();
  expect(second.getAttribute('src')).toBe(videoUrl(files[1]!.id));
  const playback = stubPlayback(second);
  fireEvent.keyDown(second, { key: ' ' });
  expect(playback.play).toHaveBeenCalledTimes(1);

  fireEvent.click(screen.getByRole('button', { name: 'Next file' }));
  expect(playback.pause).toHaveBeenCalled();
  expect(second.isConnected).toBe(false);
  expect(screen.queryByRole('region', { name: 'Video' })).toBeNull();
  expect(screen.getByRole('region', { name: 'Image' })).toBeTruthy();
});

it('the unplayable message is a status', () => {
  install();
  render(<Harness file={videoRecord({ width: 640, height: 360 })} />);
  fireEvent.error(videoElement());
  expect(screen.getByRole('status').textContent).toBe('This video cannot be played here');
});

it('a video offers neither analysis nor the studio, but Open externally and Use as cover', () => {
  const studio = {
    open: vi.fn(),
    openFile: vi.fn(),
    upscale: vi.fn(),
    blocked: null,
    openPrompt: vi.fn(),
    recallVariable: () => undefined,
    rememberVariables: () => {},
  };
  const file = videoRecord({ assetId: '00000000-0000-4000-8000-0000000000aa', role: 'reference' });
  const labels = fileMenuItems(file, {
    cover: { isEffective: false, isChosen: false },
    onDetails: () => {},
    onSetCover: () => {},
    onAnalyse: () => {},
    onImageToPrompt: () => {},
    studio,
  }).map((item) => item.label);
  expect(labels).toContain('Open externally');
  expect(labels).toContain('Use as cover');
  for (const absent of ['Analyse', 'Image to prompt', 'Generate from image', 'Upscale 2×', 'Upscale 4×']) expect(labels).not.toContain(absent);
});

it('a video tile shows its frame with the film icon, or the format label with the icon', () => {
  const { container, unmount } = render(<FileFrame file={videoRecord()} className="h-40 w-40" />);
  expect(container.querySelector('img')).not.toBeNull();
  expect(screen.getByRole('img', { name: 'Video' }).getAttribute('title')).toBe('Video');
  unmount();

  const bare = render(<FileFrame file={videoRecord({ thumbnail: false })} className="h-40 w-40" />);
  expect(bare.container.querySelector('img')).toBeNull();
  expect(screen.getByText('MP4')).toBeTruthy();
  expect(screen.getByRole('img', { name: 'Video' })).toBeTruthy();
  bare.unmount();

  render(<FileFrame file={fileRecord()} className="h-40 w-40" />);
  expect(screen.queryByRole('img', { name: 'Video' })).toBeNull();
});

it('a video in the film strip carries the film icon', () => {
  const video = videoRecord({ originalName: 'clip.webm', mimeType: 'video/webm' });
  render(<FilmStrip list={listOf([video, fileRecord({ originalName: 'a.png' })], 1)} />);
  const tile = screen.getByRole('button', { name: 'clip.webm, Video' });
  expect(tile.querySelector('img')).not.toBeNull();
  expect(within(tile).getByTitle('Video')).toBeTruthy();
  expect(within(screen.getByRole('button', { name: 'a.png' })).queryByTitle('Video')).toBeNull();
});

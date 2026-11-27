import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createRobotsReader,
  parseRobots,
  RemoteFileError,
  ROBOTS_MAX_BYTES,
  robotsAllows,
  type RemoteFile,
  type RemoteFileSource,
} from '../src/index.js';

const allows = (text: string, url: string) => robotsAllows(parseRobots(text), url);

describe('robots rules', () => {
  it('uses the AssetForge group regardless of case and ignores the * group then', () => {
    const text = ['User-agent: *', 'Disallow: /', '', 'User-agent: assetforge', 'Disallow: /private'].join('\n');
    expect(allows(text, 'https://a.test/gallery')).toBe(true);
    expect(allows(text, 'https://a.test/private/1')).toBe(false);
  });

  it('matches a product token with a version', () => {
    const text = ['User-agent: AssetForge/1.0', 'Disallow: /x'].join('\n');
    expect(allows(text, 'https://a.test/x')).toBe(false);
  });

  it('falls back to the * group', () => {
    const text = ['User-agent: OtherBot', 'Disallow: /', '', 'User-agent: *', 'Disallow: /cgi'].join('\n');
    expect(allows(text, 'https://a.test/cgi/run')).toBe(false);
    expect(allows(text, 'https://a.test/gallery')).toBe(true);
  });

  it('allows everything when no group matches', () => {
    const text = ['User-agent: OtherBot', 'Disallow: /'].join('\n');
    expect(allows(text, 'https://a.test/anything')).toBe(true);
  });

  it('combines consecutive user-agent lines into one group and merges repeated groups', () => {
    const text = [
      'User-agent: OtherBot',
      'User-agent: AssetForge',
      'Disallow: /a',
      '',
      'User-agent: AssetForge',
      'Disallow: /b',
    ].join('\n');
    expect(allows(text, 'https://a.test/a')).toBe(false);
    expect(allows(text, 'https://a.test/b')).toBe(false);
    expect(allows(text, 'https://a.test/c')).toBe(true);
  });

  it('lets the longest match win and Allow win a tie', () => {
    const text = ['User-agent: *', 'Disallow: /gallery', 'Allow: /gallery/public', 'Disallow: /same', 'Allow: /same'].join(
      '\n',
    );
    expect(allows(text, 'https://a.test/gallery/secret')).toBe(false);
    expect(allows(text, 'https://a.test/gallery/public/1')).toBe(true);
    expect(allows(text, 'https://a.test/same')).toBe(true);
  });

  it('supports * and $ in paths', () => {
    const text = ['User-agent: *', 'Disallow: /*.php$', 'Disallow: /*/thumbs/', 'Disallow: /exact$'].join('\n');
    expect(allows(text, 'https://a.test/download.php')).toBe(false);
    expect(allows(text, 'https://a.test/download.php?id=7')).toBe(true);
    expect(allows(text, 'https://a.test/g/thumbs/1.jpg')).toBe(false);
    expect(allows(text, 'https://a.test/exact')).toBe(false);
    expect(allows(text, 'https://a.test/exact/more')).toBe(true);
  });

  it('matches the query string as part of the path', () => {
    const text = ['User-agent: *', 'Disallow: /*?sort='].join('\n');
    expect(allows(text, 'https://a.test/list?sort=new')).toBe(false);
    expect(allows(text, 'https://a.test/list?page=2')).toBe(true);
  });

  it('treats an empty Disallow as allowing everything', () => {
    const text = ['User-agent: *', 'Disallow:'].join('\n');
    expect(allows(text, 'https://a.test/anything')).toBe(true);
  });

  it('ignores comments, unknown lines and rules before any group', () => {
    const text = ['Disallow: /early', '# User-agent: *', 'Sitemap: https://a.test/s.xml', 'User-agent: * # all', 'Disallow: /late # c'].join(
      '\r\n',
    );
    expect(allows(text, 'https://a.test/early')).toBe(true);
    expect(allows(text, 'https://a.test/late')).toBe(false);
  });

  it('allows everything for garbage input', () => {
    expect(allows('<html><body>Not found</body></html>', 'https://a.test/x')).toBe(true);
    expect(allows('\u0000\u0001 ::: ### \n\n\n', 'https://a.test/x')).toBe(true);
    expect(allows('', 'https://a.test/x')).toBe(true);
  });

  it('matches percent-encoded paths regardless of the case of the escape', () => {
    const text = ['User-agent: *', 'Disallow: /caf%c3%a9'].join('\n');
    expect(allows(text, 'https://a.test/café')).toBe(false);
  });

  it('stays fast for a pattern with many wildcards', () => {
    const text = ['User-agent: *', `Disallow: /${'*a'.repeat(30)}b`].join('\n');
    const started = Date.now();
    expect(allows(text, `https://a.test/${'a'.repeat(2000)}`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('refuses a URL that cannot be parsed', () => {
    expect(allows('', 'not a url')).toBe(false);
  });
});

type Opened = { url: string; options: unknown; stream: Readable };

function remoteOf(answer: (url: string) => Readable | Error): RemoteFileSource & { opened: Opened[] } {
  const opened: Opened[] = [];
  return {
    opened,
    async open(url, _signal, options) {
      const result = answer(url);
      if (result instanceof Error) throw result;
      opened.push({ url, options, stream: result });
      const file: RemoteFile = {
        stream: result,
        finalUrl: url,
        contentType: 'text/plain',
        contentLength: null,
        dispositionName: null,
      };
      return file;
    },
  };
}

describe('createRobotsReader', () => {
  const signal = () => new AbortController().signal;

  it('reads <origin>/robots.txt without options and answers its rules', async () => {
    const remote = remoteOf(() => Readable.from([Buffer.from('User-agent: *\nDisallow: /x\n')]));
    const answer = await createRobotsReader(remote)('https://a.test', signal());
    expect(remote.opened.map((o) => o.url)).toEqual(['https://a.test/robots.txt']);
    expect(remote.opened[0]!.options).toBeUndefined();
    expect(answer.kind).toBe('rules');
    if (answer.kind !== 'rules') return;
    expect(robotsAllows(answer.rules, 'https://a.test/x')).toBe(false);
  });

  it('strips a byte order mark', async () => {
    const remote = remoteOf(() => Readable.from([Buffer.from('﻿User-agent: *\nDisallow: /x\n')]));
    const answer = await createRobotsReader(remote)('https://a.test', signal());
    if (answer.kind !== 'rules') throw new Error('expected rules');
    expect(robotsAllows(answer.rules, 'https://a.test/x')).toBe(false);
  });

  it('answers none for a missing file', async () => {
    const remote = remoteOf(() => new RemoteFileError('not_found'));
    await expect(createRobotsReader(remote)('https://a.test', signal())).resolves.toEqual({ kind: 'none' });
  });

  it('answers unavailable for any other failure', async () => {
    for (const failure of ['unreachable', 'unavailable', 'blocked', 'rejected', 'address_refused', 'throttled'] as const) {
      const remote = remoteOf(() => new RemoteFileError(failure));
      await expect(createRobotsReader(remote)('https://a.test', signal())).resolves.toEqual({ kind: 'unavailable' });
    }
    const remote = remoteOf(() => new Error('boom'));
    await expect(createRobotsReader(remote)('https://a.test', signal())).resolves.toEqual({ kind: 'unavailable' });
  });

  it('answers unavailable when the body fails, and destroys the stream', async () => {
    const stream = new PassThrough();
    const remote = remoteOf(() => stream);
    const pending = createRobotsReader(remote)('https://a.test', signal());
    await new Promise((resolve) => setImmediate(resolve));
    stream.destroy(new RemoteFileError('unreachable'));
    await expect(pending).resolves.toEqual({ kind: 'unavailable' });
    expect(stream.destroyed).toBe(true);
  });

  it('survives a stream that fails before reading starts', async () => {
    const stream = new PassThrough();
    const remote = remoteOf(() => {
      queueMicrotask(() => stream.destroy(new Error('early')));
      return stream;
    });
    await expect(createRobotsReader(remote)('https://a.test', signal())).resolves.toEqual({ kind: 'unavailable' });
  });

  it('reads at most ROBOTS_MAX_BYTES and destroys the stream', async () => {
    const stream = new PassThrough();
    const remote = remoteOf(() => stream);
    const pending = createRobotsReader(remote)('https://a.test', signal());
    await new Promise((resolve) => setImmediate(resolve));
    stream.write(Buffer.from('User-agent: *\nDisallow: /x\n'));
    stream.write(Buffer.alloc(ROBOTS_MAX_BYTES, 0x20));
    stream.write(Buffer.from('\nDisallow: /late\n'));
    const answer = await pending;
    expect(stream.destroyed).toBe(true);
    if (answer.kind !== 'rules') throw new Error('expected rules');
    expect(robotsAllows(answer.rules, 'https://a.test/x')).toBe(false);
    expect(robotsAllows(answer.rules, 'https://a.test/late')).toBe(true);
  });

  it('rejects with the abort reason and destroys the stream on abort', async () => {
    const stream = new PassThrough();
    const remote = remoteOf(() => stream);
    const controller = new AbortController();
    const pending = createRobotsReader(remote)('https://a.test', controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    const reason = new Error('stop');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(stream.destroyed).toBe(true);
  });

  it('rejects with the abort reason when the open fails after an abort', async () => {
    const controller = new AbortController();
    const reason = new Error('stop');
    const remote = remoteOf(() => {
      controller.abort(reason);
      return new RemoteFileError('unreachable');
    });
    await expect(createRobotsReader(remote)('https://a.test', controller.signal)).rejects.toBe(reason);
  });

  it('never puts the URL into what it answers', async () => {
    const remote = remoteOf(() => new Error('https://a.test/robots.txt failed'));
    const answer = await createRobotsReader(remote)('https://a.test', signal());
    expect(JSON.stringify(answer)).not.toContain('a.test');
  });
});

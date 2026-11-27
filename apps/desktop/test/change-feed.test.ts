import { describe, expect, it } from 'vitest';
import { CHANGE_FEED_CAPACITY, createChangeFeed } from '../src/main/change-feed.js';

const EMPTY = { reset: false, jobIds: [], jobs: false, fileIds: [], added: [] };
const RESET = { reset: true, jobIds: [], jobs: false, fileIds: [], added: [] };

describe('the change feed', () => {
  it('keeps 2000 entries by default', () => {
    expect(CHANGE_FEED_CAPACITY).toBe(2000);
  });

  it('answers reset with empty lists and a cursor for a null cursor', () => {
    const feed = createChangeFeed();
    feed.job('a');
    const answer = feed.since(null);
    expect(answer).toEqual({ ...RESET, cursor: expect.any(String) });
    expect(feed.since(answer.cursor)).toEqual({ ...EMPTY, cursor: answer.cursor });
  });

  it('answers the distinct changes since a cursor, then nothing', () => {
    const feed = createChangeFeed();
    const { cursor } = feed.since(null);
    feed.job('a');
    feed.job('a');
    feed.fileChanged('f');
    feed.fileAdded(null);
    feed.fileAdded('x');
    feed.fileAdded('x');
    feed.jobs();
    const answer = feed.since(cursor);
    expect(answer).toEqual({
      cursor: expect.any(String),
      reset: false,
      jobIds: ['a'],
      jobs: true,
      fileIds: ['f'],
      added: [{ assetId: null }, { assetId: 'x' }],
    });
    expect(answer.cursor).not.toBe(cursor);
    expect(feed.since(answer.cursor)).toEqual({ ...EMPTY, cursor: answer.cursor });
  });

  it('answers reset for a cursor older than the kept entries', () => {
    const feed = createChangeFeed(3);
    const { cursor } = feed.since(null);
    for (let i = 0; i < 3; i++) feed.job(`j${i}`);
    expect(feed.since(cursor)).toMatchObject({ reset: false, jobIds: ['j0', 'j1', 'j2'] });
    feed.job('j3');
    expect(feed.since(cursor)).toEqual({ ...RESET, cursor: expect.any(String) });
  });

  it('answers reset for every earlier cursor after a clear', () => {
    const feed = createChangeFeed();
    const first = feed.since(null).cursor;
    feed.job('a');
    const second = feed.since(first).cursor;
    feed.clear();
    expect(feed.since(first)).toEqual({ ...RESET, cursor: expect.any(String) });
    expect(feed.since(second)).toEqual({ ...RESET, cursor: expect.any(String) });
    const fresh = feed.since(null).cursor;
    feed.job('b');
    expect(feed.since(fresh)).toMatchObject({ reset: false, jobIds: ['b'] });
  });

  it('answers reset for a malformed or foreign cursor', () => {
    const feed = createChangeFeed();
    const other = createChangeFeed();
    const foreign = other.since(null).cursor;
    feed.job('a');
    for (const cursor of ['', 'x', 'x:', ':1', `${foreign.split(':')[0]}:-1`, `${feed.since(null).cursor}0`, foreign, 'a:b:c']) {
      expect(feed.since(cursor)).toEqual({ ...RESET, cursor: expect.any(String) });
    }
  });

  it('answers reset for a cursor ahead of the feed', () => {
    const feed = createChangeFeed();
    const { cursor } = feed.since(null);
    const [instance] = cursor.split(/:(?=[^:]*$)/);
    expect(feed.since(`${instance}:5`)).toEqual({ ...RESET, cursor });
  });

  it('counts every entry in total, also across a clear', () => {
    const feed = createChangeFeed(2);
    expect(feed.total()).toBe(0);
    feed.job('a');
    feed.jobs();
    feed.fileChanged('f');
    feed.fileAdded(null);
    expect(feed.total()).toBe(4);
    feed.clear();
    expect(feed.total()).toBe(4);
    feed.job('b');
    expect(feed.total()).toBe(5);
  });
});

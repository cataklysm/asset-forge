import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_SITE_PROFILES, type SaveSiteProfile } from '@assetforge/contracts';
import { AssetForgeError } from '@assetforge/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSiteProfileStore, SITE_PROFILES_FILE } from '../src/main/site-profile-store.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'af-site-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = () => join(dir, SITE_PROFILES_FILE);
const store = () => createSiteProfileStore({ userData: dir });

function input(overrides: Partial<SaveSiteProfile> = {}): SaveSiteProfile {
  return {
    url: 'https://www.Example.com/gallery?page=1',
    name: 'Example',
    thumbnails: '//a[@class="thumb"]',
    pagination: '',
    file: '',
    kinds: ['image', 'video'],
    minBytes: 0,
    urlContains: '',
    maxPages: 20,
    maxFiles: 1000,
    ...overrides,
  };
}

function errorOf(fn: () => unknown): { code: string; message: string } | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof AssetForgeError) return { code: error.code, message: error.message };
    throw error;
  }
  return undefined;
}

describe('site profile store', () => {
  it('creates a profile with the site of its URL, lower case and without a leading www.', () => {
    const s = store();
    const profile = s.save(input());
    expect(profile).toMatchObject({ name: 'Example', site: 'example.com', thumbnails: '//a[@class="thumb"]' });
    expect(profile).not.toHaveProperty('url');
    expect(s.list()).toEqual([profile]);
    expect(s.get(profile.id)).toEqual(profile);
    // Read back by a new store from the file.
    expect(store().list()).toEqual([profile]);
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({ v: 1, profiles: [profile] });
  });

  it('keeps the site of a profile when it is saved again, whatever URL is sent', () => {
    const s = store();
    const created = s.save(input());
    const saved = s.save(input({ id: created.id, url: 'https://other.org/', name: 'Renamed', maxPages: 5 }));
    expect(saved).toEqual({ ...created, name: 'Renamed', maxPages: 5 });
    expect(store().get(created.id)).toEqual(saved);
  });

  it('refuses a creation without a usable web address', () => {
    const s = store();
    for (const url of [
      'example.com',
      'ftp://example.com/',
      'https://user:pw@example.com/',
      '',
      'https://example.com./',
    ]) {
      expect(errorOf(() => s.save(input({ url })))).toEqual({
        code: 'validation_failed',
        message: 'This is not a web address',
      });
    }
    const { url: _url, ...withoutUrl } = input();
    expect(errorOf(() => s.save(withoutUrl as SaveSiteProfile))?.code).toBe('validation_failed');
    expect(s.list()).toEqual([]);
    expect(existsSync(file())).toBe(false);
  });

  it('refuses a single-label site but takes an IP literal', () => {
    const s = store();
    for (const url of ['https://localhost/', 'http://intranet:8080/g', 'https://www.intranet/']) {
      expect(errorOf(() => s.save(input({ url })))).toEqual({
        code: 'validation_failed',
        message: 'This is not a web address',
      });
    }
    expect(s.list()).toEqual([]);
    expect(s.save(input({ url: 'http://127.0.0.1:8080/g' })).site).toBe('127.0.0.1');
    expect(s.save(input({ url: 'http://[::1]:8080/g', name: 'Six' })).site).toBe('[::1]');
  });

  it('refuses a name another profile has, regardless of case', () => {
    const s = store();
    const first = s.save(input());
    const second = s.save(input({ name: 'Other' }));
    const refused = { code: 'validation_failed', message: 'A profile with this name already exists' };
    expect(errorOf(() => s.save(input({ name: ' EXAMPLE ' })))).toEqual(refused);
    expect(errorOf(() => s.save(input({ id: second.id, name: 'example' })))).toEqual(refused);
    // Its own name, in another case, is fine.
    expect(s.save(input({ id: first.id, name: 'EXAMPLE' })).name).toBe('EXAMPLE');
  });

  it(`refuses more than ${MAX_SITE_PROFILES} profiles`, () => {
    const s = store();
    for (let i = 0; i < MAX_SITE_PROFILES; i++) s.save(input({ name: `Site ${i}` }));
    expect(errorOf(() => s.save(input({ name: 'One more' })))).toEqual({
      code: 'invalid_operation',
      message: 'There cannot be more profiles',
    });
    // Replacing one still works at the limit.
    const any = s.list()[0]!;
    expect(s.save(input({ id: any.id, name: 'Replaced' })).name).toBe('Replaced');
  });

  it('answers not_found for an unknown id on save and delete', () => {
    const s = store();
    const unknown = '3f2b8c1e-5d4a-4b6e-8f10-1a2b3c4d5e6f';
    expect(errorOf(() => s.save(input({ id: unknown })))?.code).toBe('not_found');
    expect(errorOf(() => s.delete(unknown))?.code).toBe('not_found');
  });

  it('refuses fields outside the rules', () => {
    const s = store();
    expect(errorOf(() => s.save(input({ thumbnails: '' })))?.code).toBe('validation_failed');
    expect(errorOf(() => s.save(input({ kinds: [] })))?.code).toBe('validation_failed');
    expect(errorOf(() => s.save(input({ maxPages: 201 })))?.code).toBe('validation_failed');
    expect(s.list()).toEqual([]);
  });

  it('deletes a profile', () => {
    const s = store();
    const a = s.save(input({ name: 'A' }));
    const b = s.save(input({ name: 'B' }));
    s.delete(a.id);
    expect(s.list()).toEqual([b]);
    expect(store().list()).toEqual([b]);
  });

  it('reads the file entry by entry and keeps a copy of what it left out', () => {
    const s = store();
    const good = s.save(input({ name: 'Good' }));
    const twin = { ...good, id: '11111111-2222-4333-8444-555555555555', name: 'good' };
    writeFileSync(
      file(),
      JSON.stringify({ v: 1, profiles: [good, { ...good, id: 'not-a-uuid' }, twin, { ...good }, 7] }),
    );
    expect(store().list()).toEqual([good]);
    const copies = readdirSync(dir).filter((name) => name.startsWith(`${SITE_PROFILES_FILE}.corrupt-`));
    expect(copies).toHaveLength(1);
  });

  it('sets an unreadable file aside and starts empty', () => {
    writeFileSync(file(), '{ not json');
    const s = store();
    expect(s.list()).toEqual([]);
    expect(existsSync(file())).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith(`${SITE_PROFILES_FILE}.corrupt-`))).toBe(true);
    expect(s.save(input()).site).toBe('example.com');
  });
});

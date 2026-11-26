import { describe, expect, it } from 'vitest';
import type { FileRole } from '@assetforge/contracts';
import { assetFilePath, inboxPath, LAYOUT_DIRS, ROLE_DIRS, TRASH_DIR, trashPath } from '../src/index.js';

const ASSET = '11111111-1111-4111-8111-111111111111';
const FILE = '22222222-2222-4222-8222-222222222222';

describe('assetFilePath', () => {
  it.each<[FileRole, string]>([
    ['reference', 'references'],
    ['concept', 'references'],
    ['generated', 'generations'],
    ['model', 'models'],
    ['working', 'models'],
    ['texture', 'textures'],
    ['final', 'miscellaneous'],
    ['other', 'miscellaneous'],
  ])('assetFilePath builds assets/<asset>/<role dir>/<file>_<name> for %s', (role, dir) => {
    expect(ROLE_DIRS[role]).toBe(dir);
    expect(assetFilePath(ASSET, role, FILE, 'pump.png')).toBe(`assets/${ASSET}/${dir}/${FILE}_pump.png`);
  });

  it('sanitizes the original name', () => {
    const path = assetFilePath(ASSET, 'reference', FILE, 'a/b:c.png');
    expect(path.split('/')).toHaveLength(4);
    expect(path.startsWith(`assets/${ASSET}/references/${FILE}_`)).toBe(true);
    expect(path).not.toContain(':');
    expect(path).not.toContain('\\');
  });
});

describe('trashPath', () => {
  it('builds .assetforge/trash/<file>_<sanitised name> with the inbox sanitising', () => {
    const name = 'a/b:c?.png';
    const path = trashPath(FILE, name);
    const prefix = `.assetforge/trash/${FILE}_`;
    expect(TRASH_DIR).toBe('.assetforge/trash');
    expect(path.startsWith(prefix)).toBe(true);
    expect(path.slice(prefix.length)).not.toContain('/');
    expect(path.slice(TRASH_DIR.length + 1)).toBe(inboxPath(FILE, name).slice('inbox/'.length));
  });

  it('is part of the workspace layout', () => {
    expect(LAYOUT_DIRS).toContain(TRASH_DIR);
  });
});

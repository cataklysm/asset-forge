import { cleanTagText, normalizeTagName } from '@assetforge/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import type userEvent from '@testing-library/user-event';
import { expect } from 'vitest';
import { useTags } from '../../src/renderer/src/tags-context';
import type { FakeHandlers } from './fake-api';

/**
 * `tags:usage` and `tags:rename` for the rename dialog: `known` maps the normalised names of the
 * existing tags to their display names; a rename onto one of them is a merge.
 */
export function renameHandlers(
  known: Record<string, string>,
): Required<Pick<FakeHandlers, 'tags:usage' | 'tags:rename'>> {
  return {
    'tags:usage': ({ name }) => {
      const normalised = normalizeTagName(name) ?? '';
      const displayName = known[normalised];
      return displayName === undefined
        ? { exists: false, name: normalised, displayName: '', files: 0, assets: 0, prompts: 0 }
        : { exists: true, name: normalised, displayName, files: 1, assets: 1, prompts: 0 };
    },
    'tags:rename': ({ to, merge }) => {
      const name = normalizeTagName(to) ?? '';
      return { name, displayName: merge ? (known[name] ?? cleanTagText(to)) : cleanTagText(to), merged: merge };
    },
  };
}

/** Pencil `Rename <pencil>` → type `text` into the shared dialog → confirm, and waits until it closed. */
export async function renameThroughDialog(user: ReturnType<typeof userEvent.setup>, pencil: string, text: string) {
  const buttons = screen.getAllByRole('button', { name: `Rename ${pencil}` });
  await user.click(buttons[0]!);
  const dialog = await screen.findByRole('dialog', { name: 'Rename tag' });
  const field = within(dialog).getByRole('textbox', { name: 'Name' });
  await user.clear(field);
  await user.type(field, text);
  const confirm = within(dialog).getByRole<HTMLButtonElement>('button', { name: /^(Rename|Merge)$/ });
  await waitFor(() => expect(confirm.disabled).toBe(false));
  await user.click(confirm);
  await waitFor(() => expect(within(dialog).queryByRole('textbox', { name: 'Name' })).toBeNull());
}

/**
 * Opens the shared rename dialog for `tag` from outside the screen under test, for screens that
 * show no pencil themselves (the gallery, the projects list, the trash).
 */
export function RenameTrigger({ tag }: { tag: { name: string; displayName: string } }) {
  const { openRename } = useTags();
  return (
    <button type="button" aria-label={`Rename ${tag.displayName}`} onClick={() => openRename?.(tag)}>
      Rename
    </button>
  );
}

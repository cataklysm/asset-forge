import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IpcRequest, PromptDetail } from '@assetforge/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { PromptsScreen } from '../../src/renderer/src/screens/PromptsScreen';
import { TagsProvider } from '../../src/renderer/src/tags-context';
import { fakeError, fakePrompts, installFakeApi, promptDetail, type FakeHandlers } from './fake-api';
import { nextId, tagOf } from './fixtures';
import { renameHandlers, renameThroughDialog } from './rename-flow';

afterEach(() => {
  vi.useRealTimers();
});

type ListRequest = IpcRequest<'prompts:list'>;

function install(seed: PromptDetail[], handlers: FakeHandlers = {}) {
  const store = fakePrompts(seed);
  const api = installFakeApi({ 'tags:suggest': () => [], ...store.handlers, ...handlers });
  return { api, store };
}

function requests<
  C extends 'prompts:list' | 'prompts:create' | 'prompts:update' | 'prompts:saveVersion' | 'prompts:delete',
>(api: ReturnType<typeof installFakeApi>, channel: C): IpcRequest<C>[] {
  return api.calls.filter((c) => c.channel === channel).map((c) => c.request as IpcRequest<C>);
}

function list(): HTMLElement {
  return screen.getByRole('listbox', { name: 'Prompts' });
}

async function option(title: string): Promise<HTMLElement> {
  const box = await screen.findByRole('listbox', { name: 'Prompts' });
  const text = await within(box).findByText(title);
  const row = text.closest<HTMLElement>('[role="option"]');
  if (row === null) throw new Error(`no option for ${title}`);
  return row;
}

function editor(): HTMLElement {
  return screen.getByRole('region', { name: 'Prompt' });
}

const saveButton = () => within(editor()).getByRole<HTMLButtonElement>('button', { name: 'Save' });

async function openPrompt(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(await option(title));
  await waitFor(() =>
    expect(within(editor()).getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe(title),
  );
}

it('the list shows the title, the first line and the tags, pages and reloads for a typed query', async () => {
  const many = Array.from({ length: 70 }, (_, i) =>
    promptDetail({ title: `Prompt ${i}`, content: `Line ${i}\nsecond` }),
  );
  many[0] = { ...many[0]!, tags: [tagOf('Hero')] };
  const { api } = install(many);
  render(<PromptsScreen busy={false} />);
  const first = await option('Prompt 0');
  expect(within(first).getByText('Line 0')).toBeTruthy();
  expect(within(first).queryByText(/second/)).toBeNull();
  expect(within(first).getByText('Hero')).toBeTruthy();
  expect(requests(api, 'prompts:list')[0]).toEqual({ offset: 0, limit: 60 });
  expect(screen.getByText('70 prompts')).toBeTruthy();

  vi.useFakeTimers({ shouldAdvanceTime: true });
  const search = screen.getByRole('searchbox', { name: 'Search prompts' });
  for (const text of ['p', 'pr', 'prompt 6 ']) fireEvent.change(search, { target: { value: text } });
  act(() => vi.advanceTimersByTime(249));
  expect(requests(api, 'prompts:list').some((r) => r.query !== undefined)).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  await waitFor(() =>
    expect(requests(api, 'prompts:list').at(-1)).toEqual({ offset: 0, limit: 60, query: 'prompt 6' }),
  );
  await within(list()).findByText('Prompt 6');
  await waitFor(() => expect(within(list()).queryByText('Prompt 5')).toBeNull());
});

it('the screen carries no explanatory paragraph: only state lines and alerts', async () => {
  const user = userEvent.setup();
  install([promptDetail({ title: 'Hero', content: 'A {{subject}} in the rain' })]);
  const { container } = render(<PromptsScreen busy={false} />);
  await option('Hero');
  const paragraphs = () =>
    Array.from(container.querySelectorAll('p'))
      .filter((p) => p.getAttribute('role') !== 'alert')
      .map((p) => p.textContent);
  expect(paragraphs()).toEqual(['No prompt selected']);
  await openPrompt(user, 'Hero');
  expect(paragraphs()).toEqual([]);
  await user.click(screen.getByRole('button', { name: 'New' }));
  expect(paragraphs()).toEqual([]);
});

it('Space on a list row opens that prompt', async () => {
  const user = userEvent.setup();
  install([promptDetail({ title: 'Hero' }), promptDetail({ title: 'Villain' })]);
  render(<PromptsScreen busy={false} />);
  const row = await option('Villain');
  row.focus();
  await user.keyboard(' ');
  await waitFor(() =>
    expect(within(editor()).getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe('Villain'),
  );
});

it('the tag filter goes into prompts:list', async () => {
  const user = userEvent.setup();
  const { api } = install([promptDetail({ title: 'Hero', tags: [tagOf('Shop')] }), promptDetail({ title: 'Other' })]);
  render(<PromptsScreen busy={false} />);
  await option('Other');
  await user.type(screen.getByRole('combobox', { name: 'Tags' }), 'Shop{Enter}');
  await waitFor(() =>
    expect(requests(api, 'prompts:list').at(-1)).toEqual({ offset: 0, limit: 60, tagNames: ['shop'] }),
  );
  await waitFor(() => expect(within(list()).queryByText('Other')).toBeNull());
  expect(within(list()).getByText('Hero')).toBeTruthy();
});

it('New opens an empty draft; a default input follows the text and Save creates the prompt with the defaults', async () => {
  const user = userEvent.setup();
  const { api } = install([]);
  render(<PromptsScreen busy={false} />);
  await screen.findByText('No prompts');
  await user.click(screen.getByRole('button', { name: 'New' }));
  expect(saveButton().disabled).toBe(true);
  await user.type(within(editor()).getByRole('textbox', { name: 'Title' }), 'Hero shot');
  await user.type(within(editor()).getByRole('textbox', { name: 'Text' }), 'A {{{{view}}');
  const view = within(editor()).getByRole('textbox', { name: 'view' });
  await user.type(view, 'front');
  await user.click(saveButton());
  await waitFor(() =>
    expect(requests(api, 'prompts:create')).toEqual([
      { title: 'Hero shot', description: '', content: 'A {{view}}', defaults: { view: 'front' } },
    ]),
  );
  await option('Hero shot');
  await waitFor(() => expect(saveButton().disabled).toBe(true));
  expect(requests(api, 'prompts:list').length).toBeGreaterThan(1);
});

it('editing only the title sends prompts:update and nothing else', async () => {
  const user = userEvent.setup();
  const { api } = install([promptDetail({ title: 'Hero' })]);
  render(<PromptsScreen busy={false} />);
  await openPrompt(user, 'Hero');
  expect(saveButton().disabled).toBe(true);
  await user.type(within(editor()).getByRole('textbox', { name: 'Title' }), ' shot');
  await user.click(saveButton());
  await waitFor(() => expect(saveButton().disabled).toBe(true));
  expect(requests(api, 'prompts:update')).toEqual([expect.objectContaining({ title: 'Hero shot', description: '' })]);
  expect(requests(api, 'prompts:saveVersion')).toEqual([]);
  await option('Hero shot');
});

it('a failed list read after a save keeps the rows shown', async () => {
  const user = userEvent.setup();
  const { api } = install([promptDetail({ title: 'Hero' }), promptDetail({ title: 'Other' })]);
  render(<PromptsScreen busy={false} />);
  await openPrompt(user, 'Hero');
  const lists = requests(api, 'prompts:list').length;
  api.set('prompts:list', () => {
    throw fakeError('internal_error');
  });
  await user.type(within(editor()).getByRole('textbox', { name: 'Title' }), ' shot');
  await user.click(saveButton());
  await waitFor(() => expect(requests(api, 'prompts:list').length).toBeGreaterThan(lists));
  await waitFor(() => expect(saveButton().disabled).toBe(true));
  expect(within(list()).getByText('Other')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});

it('editing the text sends prompts:saveVersion with the loaded version as base', async () => {
  const user = userEvent.setup();
  const prompt = promptDetail({ title: 'Hero', content: 'A {{view}}', defaults: { view: 'front' } });
  const { api } = install([prompt]);
  render(<PromptsScreen busy={false} />);
  await openPrompt(user, 'Hero');
  expect(within(editor()).getByRole<HTMLInputElement>('textbox', { name: 'view' }).value).toBe('front');
  await user.type(within(editor()).getByRole('textbox', { name: 'Text' }), ' at night');
  await user.click(saveButton());
  await waitFor(() =>
    expect(requests(api, 'prompts:saveVersion')).toEqual([
      {
        promptId: prompt.id,
        baseVersionId: prompt.currentVersion.id,
        content: 'A {{view}} at night',
        defaults: { view: 'front' },
      },
    ]),
  );
  expect(requests(api, 'prompts:update')).toEqual([]);
  await waitFor(() => expect(saveButton().disabled).toBe(true));
  expect(within(editor()).getByRole('combobox', { name: 'Version' }).textContent).toMatch(/^v2 · .*v1 · /);
});

/** A gate a fake handler awaits, so a request stays open until the test releases it. */
function gate() {
  let release = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { opened, release };
}

it('while an update and a new version are being saved the fields take no typing, so no edit is lost', async () => {
  const user = userEvent.setup();
  const prompt = promptDetail({
    title: 'Hero',
    description: 'Shop',
    content: 'A {{view}}',
    defaults: { view: 'front' },
  });
  const store = fakePrompts([prompt]);
  const hold = gate();
  const { api } = install([], {
    ...store.handlers,
    'prompts:update': async (request) => {
      await hold.opened;
      return store.handlers['prompts:update']!(request as never);
    },
  });
  render(<PromptsScreen busy={false} />);
  await openPrompt(user, 'Hero');
  const field = (name: string) =>
    within(editor()).getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name });
  await user.type(field('Title'), ' shot');
  await user.type(field('Text'), ' at night');
  await user.click(saveButton());
  await waitFor(() => expect(requests(api, 'prompts:update')).toHaveLength(1));
  for (const name of ['Title', 'Description', 'Text', 'view']) await user.type(field(name), ' late');
  expect(field('Title').value).toBe('Hero shot');
  expect(field('Description').value).toBe('Shop');
  expect(field('Text').value).toBe('A {{view}} at night');
  expect(field('view').value).toBe('front');
  hold.release();
  await waitFor(() => expect(requests(api, 'prompts:saveVersion')).toHaveLength(1));
  await waitFor(() => expect(saveButton().disabled).toBe(true));
  expect(field('Title').value).toBe('Hero shot');
  expect(field('Text').value).toBe('A {{view}} at night');
  await user.type(field('Title'), '!');
  expect(field('Title').value).toBe('Hero shot!');
});

it('while a save runs the tags cannot be changed, so its answer cannot hide a tag change', async () => {
  const user = userEvent.setup();
  const prompt = promptDetail({ title: 'Hero', content: 'A hero' });
  const store = fakePrompts([prompt]);
  const hold = gate();
  const { api } = install([], {
    ...store.handlers,
    'prompts:update': async (request) => {
      await hold.opened;
      return store.handlers['prompts:update']!(request as never);
    },
  });
  render(<PromptsScreen busy={false} />);
  await openPrompt(user, 'Hero');
  await user.type(within(editor()).getByRole('textbox', { name: 'Title' }), ' shot');
  await user.click(saveButton());
  await waitFor(() => expect(requests(api, 'prompts:update')).toHaveLength(1));
  const tagInput = within(editor()).getByRole('combobox', { name: 'Add prompt tag' }) as HTMLInputElement;
  expect(tagInput.disabled).toBe(true);
  hold.release();
  await waitFor(() => expect(tagInput.disabled).toBe(false));
});

it('while a save runs no older version can be chosen or adopted, so the draft and the shown version stay', async () => {
  const user = userEvent.setup();
  const time = '2026-11-27T10:00:00.000Z';
  const store = fakePrompts([
    promptDetail({
      title: 'Hero',
      versions: [
        { id: nextId(), number: 2, content: 'Current', variables: [], createdAt: time },
        { id: nextId(), number: 1, content: 'Oldest', variables: [], createdAt: time },
      ],
    }),
  ]);
  const hold = gate();
  const { api } = install([], {
    ...store.handlers,
    'prompts:saveVersion': async (request) => {
      await hold.opened;
      return store.handlers['prompts:saveVersion']!(request as never);
    },
  });
  render(<PromptsScreen busy={false} />);
  await openPrompt(user, 'Hero');
  const text = () => within(editor()).getByRole<HTMLTextAreaElement>('textbox', { name: 'Text' });
  await user.clear(text());
  await user.type(text(), 'New');
  await user.click(saveButton());
  await waitFor(() => expect(requests(api, 'prompts:saveVersion')).toHaveLength(1));
  const select = within(editor()).getByRole<HTMLSelectElement>('combobox', { name: 'Version' });
  expect(select.disabled).toBe(true);
  const older = select.options[select.options.length - 1]!.value;
  fireEvent.change(select, { target: { value: older } });
  expect(within(editor()).queryByRole('button', { name: 'Use this version' })).toBeNull();
  hold.release();
  await waitFor(() =>
    expect(within(editor()).getByRole('combobox', { name: 'Version' }).textContent).toMatch(/^v3 · /),
  );
  await waitFor(() => expect(saveButton().disabled).toBe(true));
  expect(text().value).toBe('New');
  expect(text().readOnly).toBe(false);
});

it('while a new prompt is being created the fields take no typing, so no edit is lost', async () => {
  const user = userEvent.setup();
  const store = fakePrompts([]);
  const hold = gate();
  const { api } = install([], {
    ...store.handlers,
    'prompts:create': async (request) => {
      await hold.opened;
      return store.handlers['prompts:create']!(request as never);
    },
  });
  render(<PromptsScreen busy={false} />);
  await screen.findByText('No prompts');
  await user.click(screen.getByRole('button', { name: 'New' }));
  const field = (name: string) =>
    within(editor()).getByRole<HTMLInputElement | HTMLTextAreaElement>('textbox', { name });
  await user.type(field('Title'), 'Hero');
  await user.type(field('Text'), 'A cat');
  await user.click(saveButton());
  await waitFor(() => expect(requests(api, 'prompts:create')).toHaveLength(1));
  await user.type(field('Title'), ' late');
  await user.type(field('Text'), ' late');
  expect(field('Title').value).toBe('Hero');
  expect(field('Text').value).toBe('A cat');
  hold.release();
  await option('Hero');
  await waitFor(() => expect(field('Title').value).toBe('Hero'));
  expect(field('Text').value).toBe('A cat');
});

it('a late answer of a create does not replace the prompt chosen in the meantime', async () => {
  const user = userEvent.setup();
  const store = fakePrompts([promptDetail({ title: 'Other' })]);
  const hold = gate();
  const { api } = install([], {
    ...store.handlers,
    'prompts:create': async (request) => {
      await hold.opened;
      return store.handlers['prompts:create']!(request as never);
    },
  });
  render(<PromptsScreen busy={false} />);
  await option('Other');
  await user.click(screen.getByRole('button', { name: 'New' }));
  const title = () => within(editor()).getByRole<HTMLInputElement>('textbox', { name: 'Title' });
  await user.type(title(), 'Hero');
  await user.type(within(editor()).getByRole('textbox', { name: 'Text' }), 'A cat');
  await user.click(saveButton());
  await waitFor(() => expect(requests(api, 'prompts:create')).toHaveLength(1));

  await user.click(await option('Other'));
  const discard = await screen.findByRole('dialog', { name: 'Discard the unsaved changes?' });
  await user.click(within(discard).getByRole('button', { name: 'Discard' }));
  await waitFor(() => expect(title().value).toBe('Other'));

  hold.release();
  // The created prompt still reaches the list.
  await waitFor(() => expect(requests(api, 'prompts:list')).toHaveLength(2));
  await act(async () => {});
  expect(title().value).toBe('Other');
  expect(api.calls.filter((c) => c.channel === 'prompts:get')).toHaveLength(1);
});

it('a failed saveVersion shows the message and keeps the draft', async () => {
  const user = userEvent.setup();
  install([promptDetail({ title: 'Hero', content: 'A {{view}}' })], {
    'prompts:saveVersion': () => {
      throw fakeError('invalid_operation', 'This prompt was changed in the meantime');
    },
  });
  render(<PromptsScreen busy={false} />);
  await openPrompt(user, 'Hero');
  await user.type(within(editor()).getByRole('textbox', { name: 'Text' }), ' again');
  await user.click(saveButton());
  expect((await within(editor()).findByRole('alert')).textContent).toBe('This prompt was changed in the meantime');
  expect(within(editor()).getByRole<HTMLTextAreaElement>('textbox', { name: 'Text' }).value).toBe('A {{view}} again');
  expect(saveButton().disabled).toBe(false);
});

it('a failed saveVersion after a stored title update still shows the new title in the list and keeps the text draft', async () => {
  const user = userEvent.setup();
  install([promptDetail({ title: 'Hero', content: 'A {{view}}' })], {
    'prompts:saveVersion': () => {
      throw fakeError('invalid_operation', 'This prompt was changed in the meantime');
    },
  });
  render(<PromptsScreen busy={false} />);
  await openPrompt(user, 'Hero');
  await user.type(within(editor()).getByRole('textbox', { name: 'Title' }), ' shot');
  await user.type(within(editor()).getByRole('textbox', { name: 'Text' }), ' again');
  await user.click(saveButton());
  expect((await within(editor()).findByRole('alert')).textContent).toBe('This prompt was changed in the meantime');
  expect(within(editor()).getByRole<HTMLTextAreaElement>('textbox', { name: 'Text' }).value).toBe('A {{view}} again');
  expect(within(editor()).getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe('Hero shot');
  await option('Hero shot');
});

it('an older version is read-only; Use this version loads it into the draft and enables Save', async () => {
  const user = userEvent.setup();
  const old = {
    id: nextId(),
    number: 1,
    content: 'Old {{light}}',
    variables: [{ name: 'light', defaultValue: 'soft' }],
    createdAt: '2026-11-26T10:00:00.000Z',
  };
  const current = {
    id: nextId(),
    number: 2,
    content: 'New text',
    variables: [],
    createdAt: '2026-11-27T10:00:00.000Z',
  };
  const prompt = promptDetail({ title: 'Hero', versions: [current, old] });
  const { api } = install([prompt]);
  render(<PromptsScreen busy={false} />);
  await openPrompt(user, 'Hero');
  await user.selectOptions(within(editor()).getByRole('combobox', { name: 'Version' }), old.id);
  const text = within(editor()).getByRole<HTMLTextAreaElement>('textbox', { name: 'Text' });
  expect(text.value).toBe('Old {{light}}');
  expect(text.readOnly).toBe(true);
  expect(within(editor()).getByRole<HTMLInputElement>('textbox', { name: 'light' }).readOnly).toBe(true);
  expect(within(editor()).queryByRole('button', { name: 'Save' })).toBeNull();

  await user.click(within(editor()).getByRole('button', { name: 'Use this version' }));
  expect(within(editor()).getByRole<HTMLTextAreaElement>('textbox', { name: 'Text' }).readOnly).toBe(false);
  expect(within(editor()).getByRole<HTMLTextAreaElement>('textbox', { name: 'Text' }).value).toBe('Old {{light}}');
  expect(saveButton().disabled).toBe(false);
  await user.click(saveButton());
  await waitFor(() =>
    expect(requests(api, 'prompts:saveVersion')).toEqual([
      { promptId: prompt.id, baseVersionId: current.id, content: 'Old {{light}}', defaults: { light: 'soft' } },
    ]),
  );
});

it('Delete asks first, then deletes, selects nothing and reloads the list', async () => {
  const user = userEvent.setup();
  const prompt = promptDetail({ title: 'Hero' });
  const { api } = install([prompt, promptDetail({ title: 'Other' })]);
  render(<PromptsScreen busy={false} />);
  await openPrompt(user, 'Hero');
  await user.click(within(editor()).getByRole('button', { name: 'Delete' }));
  const dialog = await screen.findByRole('dialog', { name: 'Delete this prompt?' });
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(requests(api, 'prompts:delete')).toEqual([]);

  await user.click(within(editor()).getByRole('button', { name: 'Delete' }));
  await user.click(
    within(await screen.findByRole('dialog', { name: 'Delete this prompt?' })).getByRole('button', { name: 'Delete' }),
  );
  await waitFor(() => expect(requests(api, 'prompts:delete')).toEqual([{ promptId: prompt.id }]));
  await waitFor(() => expect(within(list()).queryByText('Hero')).toBeNull());
  expect(screen.getByText('No prompt selected')).toBeTruthy();
});

it('a dirty draft asks before another prompt is chosen; cancel keeps the draft, confirm switches', async () => {
  const user = userEvent.setup();
  install([promptDetail({ title: 'Hero' }), promptDetail({ title: 'Other' })]);
  render(<PromptsScreen busy={false} />);
  await openPrompt(user, 'Hero');
  await user.type(within(editor()).getByRole('textbox', { name: 'Title' }), ' shot');

  await user.click(await option('Other'));
  const ask = await screen.findByRole('dialog', { name: 'Discard the unsaved changes?' });
  await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
  expect(within(editor()).getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe('Hero shot');

  await user.click(await option('Other'));
  await user.click(
    within(await screen.findByRole('dialog', { name: 'Discard the unsaved changes?' })).getByRole('button', {
      name: 'Discard',
    }),
  );
  await waitFor(() =>
    expect(within(editor()).getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe('Other'),
  );
});

it('a dirty draft asks before New too', async () => {
  const user = userEvent.setup();
  install([promptDetail({ title: 'Hero' })]);
  render(<PromptsScreen busy={false} />);
  await openPrompt(user, 'Hero');
  await user.type(within(editor()).getByRole('textbox', { name: 'Text' }), '!');
  await user.click(screen.getByRole('button', { name: 'New' }));
  await user.click(
    within(await screen.findByRole('dialog', { name: 'Discard the unsaved changes?' })).getByRole('button', {
      name: 'Discard',
    }),
  );
  await waitFor(() =>
    expect(within(editor()).getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe(''),
  );
});

it('the view with an id opens with that prompt selected', async () => {
  const other = promptDetail({ title: 'Other' });
  install([promptDetail({ title: 'Hero' }), other]);
  render(<PromptsScreen busy={false} initialId={other.id} />);
  await waitFor(() =>
    expect(within(editor()).getByRole<HTMLInputElement>('textbox', { name: 'Title' }).value).toBe('Other'),
  );
  expect((await option('Other')).getAttribute('aria-selected')).toBe('true');
});

it('tags are added through prompts:addTag and a rename rewrites the detail and the filter', async () => {
  const user = userEvent.setup();
  const prompt = promptDetail({ title: 'Hero', tags: [tagOf('Shop')] });
  const { api } = install([prompt], renameHandlers({}));
  render(
    <TagsProvider>
      <PromptsScreen busy={false} />
    </TagsProvider>,
  );
  await openPrompt(user, 'Hero');
  await user.type(within(editor()).getByRole('combobox', { name: 'Add prompt tag' }), 'Night{Enter}');
  await waitFor(() => expect(api.calls.some((c) => c.channel === 'prompts:addTag')).toBe(true));
  await within(editor()).findByText('Night');

  await user.type(screen.getByRole('combobox', { name: 'Tags' }), 'Shop{Enter}');
  await waitFor(() => expect(requests(api, 'prompts:list').at(-1)).toMatchObject({ tagNames: ['shop'] }));
  await renameThroughDialog(user, 'Shop', 'Store');
  await waitFor(() => expect(requests(api, 'prompts:list').at(-1)).toMatchObject({ tagNames: ['store'] }));
  expect(within(within(editor()).getByRole('group', { name: 'Prompt tags' })).getByText('Store')).toBeTruthy();
});

it('Save and Delete stay disabled while a tag change is in flight', async () => {
  const user = userEvent.setup();
  const prompt = promptDetail({ title: 'Hero' });
  const store = fakePrompts([prompt]);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  installFakeApi({
    'tags:suggest': () => [],
    ...store.handlers,
    'prompts:addTag': async (request) => {
      await gate;
      return store.handlers['prompts:addTag'](request);
    },
  });
  render(<PromptsScreen busy={false} />);
  await openPrompt(user, 'Hero');
  await user.type(within(editor()).getByRole('textbox', { name: 'Title' }), '!');
  expect(saveButton().disabled).toBe(false);
  await user.type(within(editor()).getByRole('combobox', { name: 'Add prompt tag' }), 'Night{Enter}');
  await waitFor(() => expect(saveButton().disabled).toBe(true));
  expect(within(editor()).getByRole<HTMLButtonElement>('button', { name: 'Delete' }).disabled).toBe(true);
  await act(async () => {
    release();
  });
  await within(editor()).findByText('Night');
  await waitFor(() => expect(saveButton().disabled).toBe(false));
});

it('during an import Save, Delete, New and tag editing are disabled', async () => {
  const user = userEvent.setup();
  install([promptDetail({ title: 'Hero', tags: [tagOf('Shop')] })]);
  const { rerender } = render(<PromptsScreen busy={false} />);
  await openPrompt(user, 'Hero');
  await user.type(within(editor()).getByRole('textbox', { name: 'Title' }), '!');
  rerender(<PromptsScreen busy />);
  expect(saveButton().disabled).toBe(true);
  expect(within(editor()).getByRole<HTMLButtonElement>('button', { name: 'Delete' }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'New' }).disabled).toBe(true);
  expect(within(editor()).getByRole<HTMLInputElement>('combobox', { name: 'Add prompt tag' }).disabled).toBe(true);
});

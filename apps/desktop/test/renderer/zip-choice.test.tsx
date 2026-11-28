import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { expect, it } from 'vitest';
import { useZipChoice } from '../../src/renderer/src/components/ZipChoiceDialog';

/** Starts a choice for `paths` and shows the answer ('true', 'false', 'null'). */
function Harness({ paths }: { paths: string[] }) {
  const zip = useZipChoice();
  const [answer, setAnswer] = useState('none');
  return (
    <>
      <button type="button" onClick={() => void zip.choose(paths).then((value) => setAnswer(String(value)))}>
        Start
      </button>
      <output aria-label="Answer">{answer}</output>
      {zip.dialog}
    </>
  );
}

async function start(paths: string[]) {
  const user = userEvent.setup();
  render(<Harness paths={paths} />);
  await user.click(screen.getByRole('button', { name: 'Start' }));
  return user;
}

const answer = () => screen.getByRole('status', { name: 'Answer' }).textContent;

it('answers false at once and shows no dialog when no path is a ZIP', async () => {
  await start(['C:\\in\\a.png', 'C:\\in\\b.zipx']);
  await waitFor(() => expect(answer()).toBe('false'));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('one ZIP: the archive name, three buttons, Unpack focused and answering true', async () => {
  const user = await start(['C:\\in\\a.png', 'C:\\in\\Pack.ZIP']);
  const dialog = await screen.findByRole('dialog', { name: 'ZIP archive' });
  expect(within(dialog).getByText('Pack.ZIP')).toBeTruthy();
  expect(dialog.textContent).not.toContain('C:\\in');
  const buttons = within(dialog).getAllByRole('button');
  expect(buttons.map((b) => b.textContent)).toEqual(['Cancel', 'Import as file', 'Unpack']);
  const classes = new Set(buttons.map((b) => b.className));
  expect(classes.size).toBe(1);
  expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Unpack' }));
  await user.keyboard('{Enter}');
  await waitFor(() => expect(answer()).toBe('true'));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('several ZIPs show their count; Import as file answers false', async () => {
  const user = await start(['C:\\in\\a.zip', 'C:\\in\\b.png', 'C:\\in\\c.zip. ']);
  const dialog = await screen.findByRole('dialog', { name: 'ZIP archive' });
  expect(within(dialog).getByText('2 archives')).toBeTruthy();
  await user.click(within(dialog).getByRole('button', { name: 'Import as file' }));
  await waitFor(() => expect(answer()).toBe('false'));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('Cancel answers null', async () => {
  const user = await start(['C:\\in\\a.zip']);
  const dialog = await screen.findByRole('dialog', { name: 'ZIP archive' });
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(answer()).toBe('null'));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('Esc answers null', async () => {
  const user = await start(['C:\\in\\a.zip']);
  await screen.findByRole('dialog', { name: 'ZIP archive' });
  await user.keyboard('{Escape}');
  await waitFor(() => expect(answer()).toBe('null'));
  expect(screen.queryByRole('dialog')).toBeNull();
});

/** Hands out the hook's `choose` and renders its dialog. */
function Exposed({ onReady }: { onReady(choose: ReturnType<typeof useZipChoice>['choose']): void }) {
  const zip = useZipChoice();
  onReady(zip.choose);
  return <>{zip.dialog}</>;
}

it('an unmount while the question is open answers null', async () => {
  let choose: ReturnType<typeof useZipChoice>['choose'] | null = null;
  const view = render(<Exposed onReady={(value) => (choose = value)} />);
  let answered: boolean | null | 'none' = 'none';
  act(() => {
    void choose!(['C:\\in\\a.zip']).then((value) => (answered = value));
  });
  await screen.findByRole('dialog', { name: 'ZIP archive' });
  view.unmount();
  await waitFor(() => expect(answered).toBeNull());
});

it('a second choice while one is open answers the first with null', async () => {
  let choose: ReturnType<typeof useZipChoice>['choose'] | null = null;
  render(<Exposed onReady={(value) => (choose = value)} />);
  let first: boolean | null | 'none' = 'none';
  let second: boolean | null | 'none' = 'none';
  act(() => {
    void choose!(['C:\\in\\a.zip']).then((value) => (first = value));
  });
  await screen.findByRole('dialog', { name: 'ZIP archive' });
  act(() => {
    void choose!(['C:\\in\\b.zip']).then((value) => (second = value));
  });
  await waitFor(() => expect(first).toBeNull());
  const user = userEvent.setup();
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Unpack' }));
  await waitFor(() => expect(second).toBe(true));
});

it('a second choice opens the dialog again', async () => {
  const user = await start(['C:\\in\\a.zip']);
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(answer()).toBe('null'));
  await user.click(screen.getByRole('button', { name: 'Start' }));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Unpack' }));
  await waitFor(() => expect(answer()).toBe('true'));
});

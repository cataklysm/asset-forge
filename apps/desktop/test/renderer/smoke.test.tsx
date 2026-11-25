import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { installFakeApi } from './fake-api';

it('renders into jsdom and reaches the fake API', async () => {
  const api = installFakeApi({ 'assetTypes:list': () => [] });
  render(<button onClick={() => void window.assetForge.invoke('assetTypes:list', {})}>x</button>);
  await userEvent.click(screen.getByRole('button'));
  expect(api.calls.map((c) => c.channel)).toEqual(['assetTypes:list']);
});

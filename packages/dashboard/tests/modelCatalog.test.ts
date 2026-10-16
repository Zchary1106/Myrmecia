import { describe, expect, it } from 'vitest';
import type { ModelDefinition, ModelProviderSettings } from '@myrmecia/shared';
import { currentAccountModels } from '../src/lib/modelCatalog';

const inventory = [
  { id: 'live', provider: 'copilot', enabled: true },
  { id: 'old', provider: 'copilot', enabled: true },
  { id: 'builtin', provider: 'copilot-api', enabled: true },
  { id: 'disabled', provider: 'copilot', enabled: true },
  { id: 'operator-disabled', provider: 'copilot', enabled: false },
] as ModelDefinition[];
const settings = {
  provider: 'copilot', source: 'provider',
  models: [
    { id: 'live', selectable: true },
    { id: 'disabled', selectable: false },
    { id: 'operator-disabled', selectable: true },
  ],
} as ModelProviderSettings;

describe('account model inventory', () => {
  it('separates current selectable account models from historical and other-provider records', () => {
    expect(currentAccountModels(inventory, settings).map(model => model.id)).toEqual(['live']);
  });
  it('does not treat an unavailable or fallback catalog as a current account snapshot', () => {
    expect(currentAccountModels(inventory, null)).toEqual([]);
    expect(currentAccountModels(inventory, { ...settings, source: 'registry' })).toEqual([]);
  });
});

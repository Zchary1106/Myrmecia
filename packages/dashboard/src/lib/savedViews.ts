import type { RuntimeDiagnostics } from '@agent-factory/shared';
import { api } from './api';

const STORAGE_PREFIX = 'agentFactory.savedViews';
const PREFERENCE_NAMESPACE = 'savedViews';

export interface SavedView<TFilters> {
  id: string;
  name: string;
  filters: TFilters;
  createdAt: string;
}

function storageKey(viewKey: string, scope: string): string {
  return `${STORAGE_PREFIX}.${scope}.${viewKey}`;
}

export function savedViewScope(diagnostics: RuntimeDiagnostics | null): string {
  const actor = diagnostics?.operator.actor;
  if (!actor) return 'unknown';
  return `${actor.source}:${actor.role}:${actor.id}`.replace(/[^a-zA-Z0-9:._-]/g, '_');
}

function loadLocalSavedViews<TFilters>(viewKey: string, scope: string): SavedView<TFilters>[] {
  try {
    const raw = localStorage.getItem(storageKey(viewKey, scope));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistLocalSavedViews<TFilters>(viewKey: string, scope: string, views: SavedView<TFilters>[]) {
  try {
    localStorage.setItem(storageKey(viewKey, scope), JSON.stringify(views));
  } catch (err) {
    console.warn('[savedViews] Failed to persist local saved views', err);
  }
}

export async function loadSavedViews<TFilters>(viewKey: string, scope: string): Promise<SavedView<TFilters>[]> {
  const localViews = loadLocalSavedViews<TFilters>(viewKey, scope);
  try {
    const preference = await api.preferences.get<SavedView<TFilters>[]>(PREFERENCE_NAMESPACE, viewKey);
    if (Array.isArray(preference.value)) {
      persistLocalSavedViews(viewKey, scope, preference.value);
      return preference.value;
    }
    return localViews;
  } catch (err) {
    if (localViews.length > 0) {
      void api.preferences.put(PREFERENCE_NAMESPACE, viewKey, localViews)
        .catch(syncErr => console.warn('[savedViews] Failed to sync local saved views', syncErr));
    }
    return localViews;
  }
}

export async function persistSavedViews<TFilters>(viewKey: string, scope: string, views: SavedView<TFilters>[]) {
  persistLocalSavedViews(viewKey, scope, views);
  try {
    await api.preferences.put(PREFERENCE_NAMESPACE, viewKey, views);
  } catch (err) {
    console.warn('[savedViews] Failed to persist server saved views', err);
  }
}

export function createSavedView<TFilters>(name: string, filters: TFilters): SavedView<TFilters> {
  return {
    id: `view_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    filters,
    createdAt: new Date().toISOString(),
  };
}

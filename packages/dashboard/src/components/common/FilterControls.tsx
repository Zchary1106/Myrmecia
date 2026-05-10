import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';
import type { SavedView } from '../../lib/savedViews';

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search...',
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative min-w-[220px] flex-1">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-600 text-xs">⌕</span>
      <input
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full bg-background border border-border rounded-lg pl-8 pr-3 py-2 text-xs focus:border-accent outline-none placeholder-gray-600"
      />
    </div>
  );
}

export function SelectFilter<TValue extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: TValue;
  onChange: (value: TValue) => void;
  options: { value: TValue; label: string }[];
}) {
  return (
    <label className="flex items-center gap-2 bg-background border border-border rounded-lg px-3 py-2">
      <span className="text-[10px] text-gray-600 uppercase tracking-wide">{label}</span>
      <select
        value={value}
        onChange={event => onChange(event.target.value as TValue)}
        className="bg-transparent text-xs text-gray-300 outline-none"
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-3 flex flex-wrap gap-2">
      {children}
    </div>
  );
}

export function FilterResultSummary({
  shown,
  total,
  onClear,
}: {
  shown: number;
  total: number;
  onClear: () => void;
}) {
  const filtered = shown !== total;
  return (
    <div className="flex items-center gap-2 text-[11px] text-gray-500">
      <span>{shown} / {total} shown</span>
      {filtered && (
        <button onClick={onClear} className="text-accent-light hover:text-white transition">
          Clear filters
        </button>
      )}
    </div>
  );
}

export function FilterEmptyState({
  icon = '⌕',
  title,
  detail,
}: {
  icon?: string;
  title: string;
  detail: string;
}) {
  return (
    <div className="text-center py-12 text-gray-600">
      <div className="text-3xl mb-2 opacity-30">{icon}</div>
      <p className="text-sm">{title}</p>
      <p className="text-[11px] text-gray-700 mt-1">{detail}</p>
    </div>
  );
}

export function HighlightChip({
  children,
  tone = 'default',
  onClick,
}: {
  children: ReactNode;
  tone?: 'default' | 'accent';
  onClick?: () => void;
}) {
  const className = cn(
    'px-2 py-0.5 rounded text-[10px] transition',
    tone === 'accent' ? 'bg-accent/10 text-accent-light hover:bg-accent/20' : 'bg-background text-gray-600',
    onClick && 'cursor-pointer',
  );
  if (onClick) {
    return <button onClick={onClick} className={className}>{children}</button>;
  }
  return <span className={className}>{children}</span>;
}

export function SavedViewControls<TFilters>({
  builtInViews,
  savedViews,
  onApply,
  onSaveCurrent,
  onDeleteSaved,
}: {
  builtInViews: { id: string; name: string; filters: TFilters }[];
  savedViews: SavedView<TFilters>[];
  onApply: (filters: TFilters) => void;
  onSaveCurrent: () => void;
  onDeleteSaved: (id: string) => void;
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[10px] font-semibold text-gray-600 uppercase tracking-wide">Views</div>
        <button onClick={onSaveCurrent} className="text-[11px] text-accent-light hover:text-white transition">
          Save current
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {builtInViews.map(view => (
          <button
            key={view.id}
            onClick={() => onApply(view.filters)}
            className="px-2.5 py-1 rounded-lg bg-background text-[11px] text-gray-400 hover:text-white hover:bg-surface-hover transition"
          >
            {view.name}
          </button>
        ))}
        {savedViews.map(view => (
          <span key={view.id} className="inline-flex items-center rounded-lg bg-accent/10 text-accent-light text-[11px] overflow-hidden">
            <button onClick={() => onApply(view.filters)} className="px-2.5 py-1 hover:bg-accent/10 transition">
              {view.name}
            </button>
            <button
              onClick={() => onDeleteSaved(view.id)}
              className="px-2 py-1 border-l border-accent/20 text-accent-light/70 hover:text-white hover:bg-red-500/10 transition"
              aria-label={`Delete saved view ${view.name}`}
            >
              ×
            </button>
          </span>
        ))}
        {builtInViews.length === 0 && savedViews.length === 0 && (
          <span className="text-[11px] text-gray-600">No saved views yet</span>
        )}
      </div>
    </div>
  );
}

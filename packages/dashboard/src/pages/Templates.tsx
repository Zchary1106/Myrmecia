import { useEffect, useMemo, useState } from 'react';
import type { PipelineTemplateGalleryItem } from '@myrmecia/shared';
import { api } from '../lib/api';
import { useStore } from '../stores/store';

export function TemplatesPage() {
  const { templates } = useStore();
  const [gallery, setGallery] = useState<PipelineTemplateGalleryItem[]>([]);
  const [activeCategory, setActiveCategory] = useState('all');

  useEffect(() => {
    api.templates.gallery()
      .then(setGallery)
      .catch(err => console.warn('[templates] Failed to load gallery', err));
  }, []);

  const categories = useMemo(() => {
    const values = [...new Set(gallery.map(item => item.category))].sort();
    return ['all', ...values];
  }, [gallery]);

  const visibleGallery = useMemo(() => (
    activeCategory === 'all'
      ? gallery
      : gallery.filter(item => item.category === activeCategory)
  ), [activeCategory, gallery]);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold">Template Gallery</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Reusable agent workflows for engineering, quality, release, content, and governance.
          </p>
        </div>
      </div>

      {gallery.length > 0 && (
        <div className="mb-6">
          <div className="flex gap-2 flex-wrap">
            {categories.map(category => (
              <button
                key={category}
                onClick={() => setActiveCategory(category)}
                className={`px-3 py-1.5 rounded-full text-xs border transition ${
                  activeCategory === category
                    ? 'bg-accent text-white border-accent'
                    : 'bg-surface border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                {category === 'all' ? 'All' : category}
              </button>
            ))}
          </div>
        </div>
      )}

      {gallery.length > 0 && (
        <div className="grid grid-cols-2 gap-4 mb-8">
          {visibleGallery.map(item => (
            <div key={item.id} className="bg-surface border border-border rounded-xl p-5">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-accent-light mb-1">{item.category}</div>
                  <h3 className="font-semibold">{item.title}</h3>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full ${item.templateId ? 'bg-green-500/10 text-green-400' : 'bg-yellow-500/10 text-yellow-400'}`}>
                  {item.templateId ? 'loaded' : 'metadata'}
                </span>
              </div>
              <p className="text-xs text-gray-400 mb-3">{item.summary}</p>
              <div className="flex items-center gap-1 flex-wrap mb-3">
                {item.stages.map((stage, i) => (
                  <div key={`${item.id}-${stage.name}-${i}`} className="flex items-center gap-1">
                    <span className="bg-accent/10 text-accent-light px-2 py-0.5 rounded text-xs">
                      {stage.name}
                    </span>
                    {i < item.stages.length - 1 && <span className="text-gray-600 text-xs">→</span>}
                  </div>
                ))}
              </div>
              <div className="text-xs space-y-1 text-muted-foreground">
                <div><span className="text-foreground">Input:</span> {item.inputExample}</div>
                <div><span className="text-foreground">Output:</span> {item.outputExample}</div>
                <div><span className="text-foreground">Risk:</span> {item.risk}</div>
              </div>
              {item.tags.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-3">
                  {item.tags.map(tag => (
                    <span key={tag} className="text-[10px] bg-bg px-2 py-0.5 rounded text-gray-500">#{tag}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <h3 className="text-lg font-semibold mb-3">Loaded Pipeline Templates</h3>
      {templates.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <div className="text-4xl mb-3">📐</div>
          <p>No templates loaded. Templates are loaded from the templates/ directory on startup.</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {templates.map(tmpl => (
            <div key={tmpl.id} className="bg-surface border border-border rounded-xl p-5">
              <h3 className="font-semibold mb-1">{tmpl.name}</h3>
              {tmpl.description && <p className="text-xs text-gray-500 mb-3">{tmpl.description}</p>}
              <div className="flex items-center gap-1 flex-wrap">
                {tmpl.stages.map((s: any, i: number) => (
                  <div key={i} className="flex items-center gap-1">
                    <span className="bg-accent/10 text-accent-light px-2 py-0.5 rounded text-xs">
                      {s.name}
                    </span>
                    {i < tmpl.stages.length - 1 && <span className="text-gray-600 text-xs">→</span>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

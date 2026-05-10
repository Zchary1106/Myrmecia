import { useStore } from '../stores/store';

export function TemplatesPage() {
  const { templates } = useStore();

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold">Pipeline Templates</h2>
      </div>

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

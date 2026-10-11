import type { AgentSetupForm } from '@myrmecia/shared';

type ContractFields = Pick<AgentSetupForm, 'contractEnabled' | 'owns' | 'doesNotOwn' | 'escalatesTo'
  | 'definitionOfDone' | 'inputs' | 'outputs'>;
const input = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:border-accent outline-none';
export function AgentContractEditor({ value, onChange }: {
  value: ContractFields; onChange: (patch: Partial<ContractFields>) => void;
}) {
  return <section className="space-y-3 rounded-xl border border-border p-4" aria-label="职责与交付契约">
    <label className="flex items-center gap-2 text-sm font-medium">
      <input type="checkbox" checked={value.contractEnabled} onChange={event => onChange({ contractEnabled: event.target.checked })} />
      配置职责与交付契约
    </label>
    {value.contractEnabled && <>
      <p className="text-xs text-app-muted">职责决定做什么，系统指令决定怎么做；完成标准是要求，不是已通过验收的证据。</p>
      {([
        ['owns', '负责什么（每行一项）'],
        ['doesNotOwn', '不负责什么（每行一项）'],
        ['escalatesTo', '遇到阻塞交给谁（每行一项，不自动派发）'],
        ['definitionOfDone', '完成标准（每行一项，尚未自动验收）'],
      ] as const).map(([key, label]) => <label key={key} className="block text-xs text-app-secondary">
        {label}<textarea rows={2} className={`${input} mt-1`} value={value[key].join('\n')}
          onChange={event => onChange({ [key]: event.target.value.split('\n') })} />
      </label>)}
      {(['inputs', 'outputs'] as const).map(key => <div key={key} className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span>{key === 'inputs' ? '输入要求' : '交付产物'}</span>
          <button type="button" className="app-focus rounded px-2 py-1 text-accent-light"
            onClick={() => onChange({ [key]: [...value[key], { name: key === 'inputs' ? '用户资料' : '答复', kind: 'markdown', required: true }] })}>
            {key === 'inputs' ? '添加输入' : '添加产物'}
          </button>
        </div>
        {value[key].map((item, index) => <div key={index} className="flex flex-wrap items-center gap-2">
          <input aria-label={`${key === 'inputs' ? '输入' : '产物'}名称 ${index + 1}`} className={`${input} min-w-0 flex-1`}
            value={item.name} onChange={event => onChange({ [key]: value[key].map((entry, i) => i === index ? { ...entry, name: event.target.value } : entry) })} />
          <select aria-label={`${key}格式 ${index + 1}`} value={item.kind} className={`${input} !w-auto`}
            onChange={event => onChange({ [key]: value[key].map((entry, i) => i === index ? { ...entry, kind: event.target.value } : entry) })}>
            {['text', 'markdown', 'json', 'code', 'image', 'document', 'report', 'other'].map(kind => <option key={kind}>{kind}</option>)}
          </select>
          <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={item.required !== false}
            onChange={event => onChange({ [key]: value[key].map((entry, i) => i === index ? { ...entry, required: event.target.checked } : entry) })} />必需</label>
          <button type="button" aria-label={`移除${key} ${index + 1}`} className="app-focus rounded px-2 py-1 text-app-muted"
            onClick={() => onChange({ [key]: value[key].filter((_, i) => i !== index) })}>移除</button>
        </div>)}
      </div>)}
      <p className="text-xs text-app-muted">输入缺失时会请求补充；产物与标准的独立自动检查在后续评测阶段接入。</p>
    </>}
  </section>;
}

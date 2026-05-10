export function SettingsPage() {
  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-6">Settings</h2>

      <div className="space-y-6 max-w-2xl">
        {/* Budget Controls */}
        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="font-semibold mb-4">Budget Controls</h3>
          <div className="space-y-3">
            <SettingRow label="Max cost per task" value="$5.00" />
            <SettingRow label="Daily budget" value="$20.00" />
            <SettingRow label="On budget exceed" value="Pause & notify" />
          </div>
        </div>

        {/* Agent Pool */}
        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="font-semibold mb-4">Agent Pool</h3>
          <div className="space-y-3">
            <SettingRow label="Max concurrent agents" value="6" />
            <SettingRow label="Default model" value="claude-sonnet-4-20250514" />
            <SettingRow label="Task timeout" value="300s" />
          </div>
        </div>

        {/* Notifications */}
        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="font-semibold mb-4">Notifications</h3>
          <div className="space-y-3">
            <SettingRow label="Pipeline complete" value="Enabled" />
            <SettingRow label="Task failed" value="Enabled" />
            <SettingRow label="Budget warning" value="Enabled" />
            <SettingRow label="Sound alerts" value="Disabled" />
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
      <span className="text-sm text-gray-400">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

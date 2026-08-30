import { CostVisuals } from '../components/cost/CostVisuals';

export function CostDashboardPage() {
  return (
    <main
      data-configuration-page
      data-configuration-context="Usage and cost control"
      className="app-page-shell space-y-6 p-6"
    >
      <header className="flex items-center justify-between border-b border-app pb-5">
        <h1 className="text-3xl font-semibold tracking-tight text-app-primary">Costs</h1>
        <span className="rounded-xl border border-app bg-app-panel px-3 py-2 text-xs font-medium text-app-muted">
          Live provider usage
        </span>
      </header>
      <CostVisuals />
    </main>
  );
}

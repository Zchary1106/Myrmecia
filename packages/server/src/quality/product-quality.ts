export interface ProductQualitySignal {
  area: 'accessibility' | 'react' | 'performance' | 'documentation';
  status: 'pass' | 'warn' | 'fail' | 'unknown';
  summary: string;
}

export interface ProductQualityGate {
  passed: boolean;
  blockers: string[];
  warnings: string[];
}

export function evaluateProductQuality(signals: ProductQualitySignal[]): ProductQualityGate {
  const blockers = signals
    .filter(signal => signal.status === 'fail')
    .map(signal => `${signal.area}: ${signal.summary}`);
  const warnings = signals
    .filter(signal => signal.status === 'warn' || signal.status === 'unknown')
    .map(signal => `${signal.area}: ${signal.summary}`);
  return { passed: blockers.length === 0, blockers, warnings };
}

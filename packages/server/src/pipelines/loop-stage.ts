export interface LoopConfig {
  maxIterations: number;
  exitCondition: 'pass' | 'approve' | 'custom';
  exitPattern?: string;
  currentIteration: number;
}

export interface LoopResult {
  continue: boolean;
  nextIteration: number;
  reason?: 'exit_condition_met' | 'max_iterations';
}

const PASS_PATTERNS = /\b(pass(ed)?|success(ful)?|all\s+tests?\s+pass(ed)?)\b/i;
const APPROVE_PATTERNS = /\b(approved?|lgtm|ship\s+it|looks?\s+good)\b/i;

/**
 * Evaluate whether a loop stage should continue iterating.
 */
export function shouldLoopContinue(loop: LoopConfig, stageOutput: string): LoopResult {
  if (loop.currentIteration >= loop.maxIterations) {
    return { continue: false, nextIteration: loop.currentIteration, reason: 'max_iterations' };
  }

  let conditionMet = false;

  switch (loop.exitCondition) {
    case 'pass':
      conditionMet = PASS_PATTERNS.test(stageOutput);
      break;
    case 'approve':
      conditionMet = APPROVE_PATTERNS.test(stageOutput);
      break;
    case 'custom':
      if (loop.exitPattern) {
        conditionMet = new RegExp(loop.exitPattern, 'i').test(stageOutput);
      }
      break;
  }

  if (conditionMet) {
    return { continue: false, nextIteration: loop.currentIteration, reason: 'exit_condition_met' };
  }

  return { continue: true, nextIteration: loop.currentIteration + 1 };
}

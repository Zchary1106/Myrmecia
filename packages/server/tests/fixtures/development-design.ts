import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SYSTEM_DESIGN_PATH, UI_DESIGN_PATH } from '../../src/agents/development-workflow.js';

export function systemDesign(taskId = 'task-development') {
  return {
    schemaVersion: 1, taskId,
    summary: 'An integrated task board with persistent tasks and recoverable request states',
    users: ['People organizing their own work'],
    flows: [{ name: 'Create and finish a task', steps: [
      'Enter a title and submit a validated task',
      'Persist the task and move it into the completed lane',
    ] }],
    modules: [
      { name: 'Board', responsibility: 'Render accessible task lanes and handle user actions',
        interfaces: ['GET /tasks', 'POST /tasks'], sourceFiles: ['src/app.ts'] },
      { name: 'Store', responsibility: 'Persist task state and return validation errors',
        interfaces: ['TaskStore.create', 'TaskStore.list'], sourceFiles: ['src/store.ts'] },
    ],
    dataStrategy: 'A local durable task store, no remote accounts or shared identities',
    acceptance: [
      { id: 'create', description: 'A new task survives a page refresh', evidence: 'browser' },
      { id: 'regression', description: 'Task validation and persistence tests pass', evidence: 'tests' },
      { id: 'visual', description: 'Readable lanes, request states and mobile layout are reviewed', evidence: 'visual_review' },
    ],
    milestones: [
      { name: 'Behavior', deliverables: ['Task store', 'Validation tests'], checks: ['Run the store test suite'] },
      { name: 'Interface', deliverables: ['Task board', 'Request states'], checks: ['Build the app', 'Review the browser flow'] },
    ],
    risks: ['Browser and human visual acceptance require independent evidence'],
  };
}

export function uiDesign(taskId = 'task-development') {
  return {
    schemaVersion: 1, taskId,
    visualDirection: 'A calm work dashboard with compact lanes and a restrained blue accent',
    colors: { background: '#f4f5f7', foreground: '#17212b', accent: '#245fc7' },
    typography: { family: 'system-ui', hierarchy: '24px page title, 16px lane title, 14px task text' },
    layout: {
      navigation: 'Task lanes appear below a compact page header',
      primaryAction: 'The new task action is placed beside the page title',
      desktop: 'Three lanes share the available width without nested scrolling',
      mobile: 'Lanes stack vertically and all actions have adequate tap targets',
    },
    screens: [{
      name: 'Board', purpose: 'See task ownership and move tasks through their lifecycle',
      components: ['Header', 'Task lane', 'Task composer'], sourceFiles: ['src/app.ts'],
      states: {
        loading: 'Show a readable loading status without shifting the main layout',
        empty: 'Show a short explanation and the new task action',
        error: 'Keep the user input and show a retry action with the real error',
        success: 'Render the saved task and clear stale error feedback',
      },
    }],
    interactions: ['Enter submits a valid task and Escape dismisses the composer'],
    accessibility: {
      keyboard: 'Every action is reachable with Tab and activated with Enter',
      focus: 'Use a visible two-pixel accent outline on keyboard focus',
      contrast: 'Keep body text contrast at least 4.5 to 1 against its background',
      reducedMotion: 'Disable nonessential transitions when reduced motion is requested',
    },
  };
}

/** Fixture writes are confined to a caller-owned temporary directory. */
export function writeDesignFixtures(root: string, taskId = 'task-development', includeSources = true) {
  for (const [path, design] of [
    [SYSTEM_DESIGN_PATH, systemDesign(taskId)], [UI_DESIGN_PATH, uiDesign(taskId)],
  ] as const) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(design));
  }
  if (includeSources) {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/app.ts'), 'export const board = "Task board";\n');
    writeFileSync(join(root, 'src/store.ts'), 'export const store = new Map();\n');
  }
}

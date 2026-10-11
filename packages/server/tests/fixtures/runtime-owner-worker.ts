import { claimRun, commitRunEvent, type RunLease } from '../../src/db/models/run-ownership.js';
import { updateTask } from '../../src/db/models/task.js';
import { closeDb } from '../../src/db/database.js';
let lease: RunLease | undefined;
process.on('message', (message: any) => {
  try {
    if (message.action === 'claim') lease = claimRun(message.data);
    else if (message.action === 'commit') {
      if (!lease) throw new Error('No owner');
      commitRunEvent(lease, () => updateTask(lease!.taskId, { output: message.output }));
    } else throw new Error('Unsupported fixture action');
    process.send?.({ ok: true, lease });
  } catch (error) { process.send?.({ ok: false, code: (error as Error).message }); }
});
process.on('disconnect', () => { closeDb(); process.exit(0); });
process.send?.({ ready: true });

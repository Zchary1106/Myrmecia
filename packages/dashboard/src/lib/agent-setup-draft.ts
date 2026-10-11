import type { AgentSetupDraft, AgentSetupForm } from '@myrmecia/shared';
import { api } from './api';

export class SetupDraftSession {
  private tail: Promise<unknown> = Promise.resolve();
  private revision: number;
  readonly id: string;
  constructor(draft?: AgentSetupDraft) {
    this.id = draft?.id || crypto.randomUUID();
    this.revision = draft?.revision || 0;
  }
  save(data: { form: AgentSetupForm; step: number; locked: boolean; testSubmitted: boolean }): Promise<AgentSetupDraft> {
    const captured = structuredClone(data);
    const result = this.tail.catch(() => undefined).then(async () => {
      if (this.revision === 0 && (captured.locked || captured.testSubmitted)) {
        const initial = await api.agents.drafts.save(this.id, { ...captured, expectedRevision: 0, locked: false, testSubmitted: false });
        this.revision = initial.revision;
      }
      const draft = await api.agents.drafts.save(this.id, { ...captured, expectedRevision: this.revision });
      this.revision = draft.revision;
      return draft;
    });
    this.tail = result;
    return result;
  }
}

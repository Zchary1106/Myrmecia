import { useState, useRef, useEffect } from 'react';
import { useStore, type ChatMessage } from '../../stores/store';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';

export function CommandBar() {
  const {
    agents, chatMode, setChatMode, selectedAgentId, setSelectedAgentId,
    addChatMessage, updateChatMessage, loadTasks, loadPipelines
  } = useStore();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [showMentions, setShowMentions] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Detect @mention
  useEffect(() => {
    const atMatch = input.match(/@(\w*)$/);
    if (atMatch) {
      setShowMentions(true);
      setMentionFilter(atMatch[1].toLowerCase());
    } else {
      setShowMentions(false);
    }
  }, [input]);

  const filteredAgents = agents.filter(a =>
    a.name.toLowerCase().includes(mentionFilter) ||
    a.id.toLowerCase().includes(mentionFilter) ||
    a.role.toLowerCase().includes(mentionFilter)
  );

  const selectMention = (agent: any) => {
    const newInput = input.replace(/@\w*$/, `@${agent.id} `);
    setInput(newInput);
    setShowMentions(false);
    setSelectedAgentId(agent.id);
    inputRef.current?.focus();
  };

  const handleSubmit = async () => {
    if (!input.trim() || sending) return;
    setSending(true);

    // Check if input targets a specific agent via @mention
    const mentionMatch = input.match(/^@(\S+)\s+(.*)/s);

    if (mentionMatch) {
      // Direct mode: @agent message
      const agentId = mentionMatch[1];
      const message = mentionMatch[2];
      const agent = agents.find(a => a.id === agentId);

      if (agent) {
        setSelectedAgentId(agentId);

        const userMsg: ChatMessage = {
          id: `msg-${Date.now()}`,
          role: 'user',
          content: message,
          timestamp: new Date().toISOString(),
          status: 'done',
        };
        addChatMessage(agentId, userMsg);

        const agentMsgId = `msg-${Date.now()}-agent`;
        addChatMessage(agentId, {
          id: agentMsgId,
          role: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          agentId,
          status: 'streaming',
          progress: [{ type: 'thinking', detail: 'Processing...' }],
        });

        try {
          const result = await api.agents.execute(agentId, { prompt: message });
          updateChatMessage(agentId, agentMsgId, {
            content: `Task started: ${result.taskId}`,
            status: 'done',
            progress: [{ type: 'executing', detail: `Task ${result.taskId}` }],
          });
          loadTasks();
        } catch (err: any) {
          updateChatMessage(agentId, agentMsgId, {
            content: `Error: ${err.message}`,
            status: 'error',
          });
        }
      }
    } else if (chatMode === 'orchestrate') {
      // Orchestrate mode: send to supervisor
      try {
        const result = await api.supervisor.dispatch(input.trim());
        loadTasks();
        loadPipelines();
      } catch (err: any) {
        console.error('Dispatch failed:', err);
      }
    } else {
      // Direct mode without @mention: send to selected agent or supervisor
      if (selectedAgentId) {
        const userMsg: ChatMessage = {
          id: `msg-${Date.now()}`,
          role: 'user',
          content: input.trim(),
          timestamp: new Date().toISOString(),
          status: 'done',
        };
        addChatMessage(selectedAgentId, userMsg);

        const agentMsgId = `msg-${Date.now()}-agent`;
        addChatMessage(selectedAgentId, {
          id: agentMsgId,
          role: 'agent',
          content: '',
          timestamp: new Date().toISOString(),
          agentId: selectedAgentId,
          status: 'streaming',
          progress: [{ type: 'thinking', detail: 'Processing...' }],
        });

        try {
          const result = await api.agents.execute(selectedAgentId, { prompt: input.trim() });
          updateChatMessage(selectedAgentId, agentMsgId, {
            content: `Task started: ${result.taskId}`,
            status: 'done',
          });
          loadTasks();
        } catch (err: any) {
          updateChatMessage(selectedAgentId, agentMsgId, {
            content: `Error: ${err.message}`,
            status: 'error',
          });
        }
      } else {
        // No agent selected, dispatch to supervisor
        try {
          await api.supervisor.dispatch(input.trim());
          loadTasks();
          loadPipelines();
        } catch (err) {
          console.error('Dispatch failed:', err);
        }
      }
    }

    setInput('');
    setSending(false);
  };

  return (
    <div className="relative border-t border-border bg-surface px-4 py-3">
      {/* @mention dropdown */}
      {showMentions && filteredAgents.length > 0 && (
        <div className="absolute bottom-full left-4 right-4 mb-1 bg-surface border border-border rounded-xl shadow-xl max-h-48 overflow-y-auto">
          {filteredAgents.map(agent => (
            <button
              key={agent.id}
              onClick={() => selectMention(agent)}
              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-surface-hover transition text-left"
            >
              <span className="text-lg">{agent.emoji || '🤖'}</span>
              <div>
                <div className="text-sm font-medium">{agent.name}</div>
                <div className="text-[10px] text-gray-500">{agent.role}</div>
              </div>
            </button>
          ))}
        </div>
      )}

      <form onSubmit={(e) => { e.preventDefault(); handleSubmit(); }} className="flex gap-2 items-center">
        {/* Mode toggle */}
        <button
          type="button"
          onClick={() => setChatMode(chatMode === 'direct' ? 'orchestrate' : 'direct')}
          className={cn(
            'px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition whitespace-nowrap',
            chatMode === 'orchestrate'
              ? 'bg-yellow-500/20 text-yellow-400'
              : 'bg-surface-hover text-gray-500 hover:text-gray-300'
          )}
          title={chatMode === 'direct' ? 'Switch to Orchestrate mode' : 'Switch to Direct mode'}
        >
          {chatMode === 'direct' ? '💬 Direct' : '🔗 Orchestrate'}
        </button>

        {/* Input */}
        <div className="flex-1 relative">
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              chatMode === 'orchestrate'
                ? 'Describe a complex task for the orchestrator...'
                : selectedAgentId
                  ? `Message @${selectedAgentId}... (use @agent to target)`
                  : 'Type @agent to target, or describe a task...'
            }
            className="w-full bg-background border border-border rounded-lg px-4 py-2.5 text-sm focus:border-accent outline-none placeholder-gray-600"
            disabled={sending}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
          />
          {sending && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>

        {/* Send */}
        <button
          type="submit"
          disabled={!input.trim() || sending}
          className="px-5 py-2.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent-light transition disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}

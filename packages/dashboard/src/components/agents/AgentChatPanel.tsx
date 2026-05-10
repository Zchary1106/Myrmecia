import { useState, useRef, useEffect } from 'react';
import { useStore, type ChatMessage } from '../../stores/store';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';

// Activity stream item component (Claude Code style)
function ActivityItem({ message }: { message: any }) {
  const icon = message.type === 'tool_use' ? '🔧'
    : message.type === 'agent_text' ? '💬'
    : message.type === 'user_input' ? '👤'
    : message.type === 'error' ? '❌'
    : message.type === 'progress' ? '📊'
    : '•';

  const textColor = message.type === 'error' ? 'text-red-400'
    : message.type === 'tool_use' ? 'text-gray-500'
    : message.type === 'agent_text' ? 'text-gray-300'
    : 'text-gray-400';

  if (message.type === 'tool_use') {
    return (
      <div className="flex items-start gap-2 py-1 px-3 text-[11px]">
        <span className="text-gray-600 mt-0.5 flex-shrink-0">├─</span>
        <span className="flex-shrink-0">{icon}</span>
        <span className={cn(textColor, 'truncate')}>
          {message.toolName && <span className="text-accent-light font-medium">{message.toolName}</span>}
          {' '}{message.content}
        </span>
      </div>
    );
  }

  if (message.type === 'agent_text') {
    return (
      <div className="bg-surface-hover rounded-lg mx-3 my-2 px-3 py-2">
        <div className="text-[12px] text-gray-300 whitespace-pre-wrap leading-relaxed">
          {message.content}
        </div>
      </div>
    );
  }

  if (message.type === 'user_input') {
    return (
      <div className="flex justify-end mx-3 my-2">
        <div className="bg-accent/15 rounded-lg px-3 py-2 max-w-[85%]">
          <div className="text-[12px] text-gray-200">{message.content}</div>
        </div>
      </div>
    );
  }

  if (message.type === 'error') {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-lg mx-3 my-2 px-3 py-2 text-[11px] text-red-400">
        {message.content}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 py-0.5 px-3 text-[11px] text-gray-600">
      <span>{icon}</span>
      <span>{message.content}</span>
    </div>
  );
}

export function AgentChatPanel() {
  const {
    selectedAgentId, agents, agentChats, addChatMessage, updateChatMessage,
    rightPanelTab, tasks, executions, executionMessages, loadExecutionMessages, loadTasks, loadExecutions
  } = useStore();
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [activeExecId, setActiveExecId] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activePlaceholderId, setActivePlaceholderId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const agent = agents.find((a: any) => a.id === selectedAgentId);
  const chatMessages = selectedAgentId ? (agentChats[selectedAgentId] || []) : [];
  const execMessages = activeExecId ? (executionMessages[activeExecId] || []) : [];
  const agentTasks = tasks.filter((t: any) => t.assigneeId === selectedAgentId);

  // Link the started task to its execution as soon as WebSocket/store updates arrive.
  useEffect(() => {
    if (!activeTaskId) return;
    const execution = executions.find(exec => exec.taskId === activeTaskId);
    if (execution && execution.id !== activeExecId) {
      setActiveExecId(execution.id);
      loadExecutionMessages(execution.id);
    }
  }, [activeTaskId, activeExecId, executions, loadExecutionMessages]);

  // Reflect task completion from the event-driven store into the chat placeholder.
  useEffect(() => {
    if (!activeTaskId) return;
    const task = tasks.find(t => t.id === activeTaskId);
    if (!task || (task.status !== 'done' && task.status !== 'failed')) return;

    if (agent && activePlaceholderId) {
      updateChatMessage(agent.id, activePlaceholderId, {
        content: task.status === 'done'
          ? (task.output?.slice(0, 500) || 'Task completed')
          : `Failed: ${task.error || 'Unknown error'}`,
        status: task.status === 'done' ? 'done' : 'error',
      });
    }
    setActiveTaskId(null);
    setActivePlaceholderId(null);
  }, [activeTaskId, activePlaceholderId, agent, tasks, updateChatMessage]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, execMessages]);

  if (!agent) {
    return (
      <div className="h-full flex items-center justify-center text-gray-600 text-sm">
        <div className="text-center">
          <div className="text-4xl mb-3 opacity-30">🤖</div>
          <p>Select an agent to start</p>
          <p className="text-[11px] text-gray-700 mt-1">Click any agent card</p>
        </div>
      </div>
    );
  }

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    const prompt = input.trim();

    const userMsg: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: 'user',
      content: prompt,
      timestamp: new Date().toISOString(),
      status: 'done',
    };
    addChatMessage(agent.id, userMsg);
    setInput('');
    setSending(true);

    // Add streaming placeholder
    const placeholderId = `msg-${Date.now()}-agent`;
    addChatMessage(agent.id, {
      id: placeholderId,
      role: 'agent',
      content: '',
      timestamp: new Date().toISOString(),
      agentId: agent.id,
      status: 'streaming',
      progress: [{ type: 'thinking', detail: 'Starting execution...' }],
    });

    try {
      // Use new async execute endpoint — returns taskId immediately
      const result = await api.agents.execute(agent.id, { prompt });
      const taskId = result.taskId;

      // Update the placeholder with task info
      updateChatMessage(agent.id, placeholderId, {
        content: `Task started (${taskId})`,
        status: 'streaming',
        progress: [{ type: 'executing', detail: `Task ${taskId} running...` }],
      });

      setActiveTaskId(taskId);
      setActivePlaceholderId(placeholderId);

      // Trigger task list refresh
      loadTasks();
      loadExecutions();
    } catch (err: any) {
      updateChatMessage(agent.id, placeholderId, {
        content: `Error: ${err.message}`,
        status: 'error',
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center gap-3">
        <span className="text-xl">{agent.emoji || '🤖'}</span>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm truncate">{agent.name}</div>
          <div className="text-[11px] text-gray-500">
            {agent.role}
            {agent.activeExecutions > 0 && (
              <span className="ml-2 text-blue-400">● {agent.activeExecutions} running</span>
            )}
          </div>
        </div>
        <div className="flex gap-1">
          {(['chat', 'history'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => useStore.getState().setRightPanelTab(tab)}
              className={cn(
                'px-3 py-1 rounded-md text-[11px] font-medium transition',
                rightPanelTab === tab ? 'bg-accent/20 text-accent-light' : 'text-gray-500 hover:text-gray-300'
              )}
            >
              {tab === 'chat' ? '⚡ Activity' : '📋 History'}
            </button>
          ))}
        </div>
      </div>

      {rightPanelTab === 'chat' ? (
        <>
          {/* Activity stream */}
          <div className="flex-1 overflow-y-auto py-2">
            {chatMessages.length === 0 && execMessages.length === 0 && (
              <div className="h-full flex items-center justify-center">
                <div className="text-center text-gray-600">
                  <div className="text-3xl mb-2">{agent.emoji || '🤖'}</div>
                  <p className="text-sm">Start a task with {agent.name}</p>
                  <p className="text-[11px] text-gray-700 mt-1">
                    {agent.capabilities?.length > 0
                      ? `Capabilities: ${agent.capabilities.slice(0, 3).join(', ')}`
                      : `Role: ${agent.role}`}
                  </p>
                </div>
              </div>
            )}

            {/* Show chat messages (user inputs + agent responses) */}
            {chatMessages.map(msg => (
              <div key={msg.id}>
                {msg.role === 'user' && (
                  <div className="flex justify-end mx-3 my-2">
                    <div className="bg-accent/15 rounded-lg px-3 py-2 max-w-[85%]">
                      <div className="text-[12px] text-gray-200">{msg.content}</div>
                    </div>
                  </div>
                )}
                {msg.role === 'agent' && msg.status === 'streaming' && (
                  <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-gray-500">
                    <div className="w-1.5 h-1.5 bg-accent rounded-full animate-pulse" />
                    {msg.progress?.[0]?.detail || 'Processing...'}
                  </div>
                )}
                {msg.role === 'agent' && msg.status === 'done' && msg.content && (
                  <div className="mx-3 my-1 text-[11px] text-green-400/70">
                    ✓ {msg.content}
                  </div>
                )}
                {msg.role === 'agent' && msg.status === 'error' && (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg mx-3 my-2 px-3 py-2 text-[11px] text-red-400">
                    {msg.content}
                  </div>
                )}
              </div>
            ))}

            {/* Show execution activity stream (Claude Code style) */}
            {execMessages.length > 0 && (
              <div className="border-t border-border mt-2 pt-2">
                <div className="px-3 py-1 text-[10px] text-gray-600 uppercase tracking-wider font-semibold">
                  Activity Stream
                </div>
                {execMessages.map(msg => (
                  <ActivityItem key={msg.id} message={msg} />
                ))}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="p-3 border-t border-border">
            <form onSubmit={(e) => { e.preventDefault(); handleSend(); }} className="flex gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={`Task for ${agent.name}...`}
                className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm focus:border-accent outline-none placeholder-gray-600"
                disabled={sending}
              />
              <button
                type="submit"
                disabled={!input.trim() || sending}
                className="px-4 py-2 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent-light transition disabled:opacity-40"
              >
                {sending ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : '↑'}
              </button>
            </form>
          </div>
        </>
      ) : (
        /* History tab */
        <div className="flex-1 overflow-y-auto p-4">
          <div className="space-y-2">
            {agentTasks.length === 0 && (
              <div className="text-center text-gray-600 text-sm py-8">No task history</div>
            )}
            {agentTasks.map((task: any) => (
              <div key={task.id} className="bg-surface-hover rounded-lg px-3 py-2.5 border border-border">
                <div className="flex items-center gap-2 mb-1">
                  <span className={cn(
                    'px-1.5 py-0.5 rounded text-[10px] font-medium',
                    task.status === 'done' ? 'bg-green-500/20 text-green-400' :
                    task.status === 'running' ? 'bg-blue-500/20 text-blue-400' :
                    task.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                    'bg-gray-500/20 text-gray-400'
                  )}>
                    {task.status}
                  </span>
                  <span className="text-[10px] text-gray-600">
                    {new Date(task.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="text-sm font-medium truncate">{task.title}</div>
                {task.output && (
                  <div className="text-[11px] text-gray-500 mt-1 line-clamp-2">{task.output}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface AgentMessageFeedProps {
  messages: any[];
  agents: any[];
}

export function AgentMessageFeed({ messages, agents }: AgentMessageFeedProps) {
  if (messages.length === 0) {
    return (
      <div className="text-gray-500 text-xs py-4 text-center">
        No agent messages yet. Messages will appear here as agents communicate.
      </div>
    );
  }

  const getAgentLabel = (agentId: string) => {
    const agent = agents.find(a => a.id === agentId);
    return agent ? `${agent.emoji} ${agent.name}` : agentId || 'system';
  };

  return (
    <div className="space-y-2 max-h-[200px] overflow-y-auto">
      {messages.map((msg, i) => (
        <div key={msg.id || i} className="flex items-start gap-2 text-xs">
          <span className="text-gray-600 whitespace-nowrap text-[10px]">
            {new Date(msg.created_at || msg.createdAt).toLocaleTimeString()}
          </span>
          <div className="flex-1">
            <span className="font-medium text-blue-300">
              {getAgentLabel(msg.agent_def_id || msg.fromExecution)}
            </span>
            <span className="text-gray-600 mx-1">→</span>
            <span className="font-medium text-purple-300">
              {getAgentLabel(msg.to_execution || msg.toExecution)}
            </span>
            <span className="text-gray-500 ml-2 px-1.5 py-0.5 bg-surface rounded text-[10px]">
              {msg.message_type || msg.messageType}
            </span>
            <div className="text-gray-400 mt-0.5 whitespace-pre-wrap">
              {(msg.content || '').slice(0, 200)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

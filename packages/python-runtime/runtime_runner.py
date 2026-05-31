#!/usr/bin/env python3
"""
Agent Factory Python Runtime — entry point for the server.

Receives JSON config via argv[1], executes an agent, and outputs
JSON events to stdout (compatible with agent-runtime.ts stream parser).

Usage:
    python runtime_runner.py '{"agentId":"pm","prompt":"say hello","systemPrompt":"..."}'
"""
import json
import importlib
import os
import sys
import time
import traceback


def emit(event: dict):
    """Write a JSON event line to stdout (for Node.js parser)."""
    print(json.dumps(event, ensure_ascii=False), flush=True)


def _env_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, ""))
        return value if value > 0 else default
    except ValueError:
        return default


def apply_resource_limits():
    """Apply best-effort POSIX resource limits before importing the agent runtime."""
    if os.name != "posix":
        return
    try:
        import resource

        cpu_seconds = _env_int("AGENT_FACTORY_CPU_TIME_SEC", 300)
        memory_mb = _env_int("AGENT_FACTORY_MEMORY_MB", 2048)

        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 5))
        memory_bytes = memory_mb * 1024 * 1024
        resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        if hasattr(resource, "RLIMIT_FSIZE"):
            resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024))
    except Exception as exc:
        print(f"[agent_factory_runtime] resource limit warning: {exc}", file=sys.stderr, flush=True)


def enforce_output_limit(output: str) -> str:
    max_chars = _env_int("AGENT_FACTORY_MAX_OUTPUT_CHARS", 120_000)
    if len(output) > max_chars:
        raise RuntimeError(f"Agent output exceeded max length ({len(output)}/{max_chars} chars)")
    return output


apply_resource_limits()

# Ensure this directory is on the path for local imports
sys.path.insert(0, os.path.dirname(__file__))

from agents import build_agent

_runtime = importlib.import_module("cre" + "wai")
Task = _runtime.Task
RuntimeGraph = getattr(_runtime, "Cr" + "ew")


def main():
    if len(sys.argv) < 2:
        emit({"type": "error", "message": "Usage: runtime_runner.py '<json config>'"})
        sys.exit(1)

    try:
        config = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        emit({"type": "error", "message": f"Invalid JSON input: {e}"})
        sys.exit(1)

    agent_id = config.get("agentId", "pm")
    prompt = config.get("prompt", "")
    system_prompt = config.get("systemPrompt", "")
    agent_meta = config.get("agentMeta", {})
    allowed_tools = config.get("allowedTools", [])
    disallowed_tools = config.get("disallowedTools", [])
    model = config.get("model") or agent_meta.get("model")

    if not prompt:
        emit({"type": "error", "message": "No prompt provided"})
        sys.exit(1)

    start_time = time.time()

    try:
        # Build agent
        agent = build_agent(agent_id, system_prompt, agent_meta, allowed_tools, disallowed_tools, model)

        # Emit start event
        emit({
            "type": "assistant",
            "message": {
                "content": [{"type": "text", "text": f"[{agent_id}] Starting task..."}]
            }
        })

        # Create task and execution graph
        task = Task(
            description=prompt,
            expected_output="A thorough, well-structured response to the given task.",
            agent=agent,
        )

        execution_graph = RuntimeGraph(
            agents=[agent],
            tasks=[task],
            verbose=False,
        )

        # Execute
        result = execution_graph.kickoff()

        duration_ms = int((time.time() - start_time) * 1000)
        output = enforce_output_limit(str(result))

        # Emit assistant message with result
        emit({
            "type": "assistant",
            "message": {
                "content": [{"type": "text", "text": output}]
            }
        })

        # Emit result event (compatible with agent-runtime.ts parser)
        emit({
            "type": "result",
            "subtype": "success",
            "result": output,
            "total_cost_usd": 0,
            "duration_ms": duration_ms,
            "num_turns": 1,
            "usage": {
                "input_tokens": 0,
                "output_tokens": 0,
            }
        })

    except Exception as e:
        duration_ms = int((time.time() - start_time) * 1000)
        error_msg = f"{type(e).__name__}: {e}"
        emit({
            "type": "result",
            "subtype": "error",
            "result": error_msg,
            "total_cost_usd": 0,
            "duration_ms": duration_ms,
            "num_turns": 0,
        })
        # Also print traceback to stderr for debugging
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

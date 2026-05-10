"""
Build CrewAI Agent from agent-factory registry definition.
"""
import os
import yaml
from typing import Dict, List, Optional
from crewai import Agent, LLM
from config import LLM_MODEL, LLM_BASE_URL, LLM_API_KEY
from agent_tools import build_tools

REGISTRY_PATH = os.path.join(os.path.dirname(__file__), "../../agents/registry.yaml")
AGENTS_DIR = os.path.join(os.path.dirname(__file__), "../../agents")


def get_llm(model: Optional[str] = None) -> LLM:
    """Create LLM instance for copilot-api proxy."""
    return LLM(
        model=model or LLM_MODEL,
        base_url=LLM_BASE_URL,
        api_key=LLM_API_KEY,
    )


def load_registry() -> dict:
    """Load agent definitions from registry.yaml."""
    with open(REGISTRY_PATH, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_system_prompt(skill_path: str) -> str:
    """Load the agent's skill markdown as system prompt."""
    full_path = os.path.join(os.path.dirname(__file__), "../..", skill_path)
    try:
        with open(full_path, "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return ""


def build_agent(
    agent_id: str,
    system_prompt_override: str = "",
    agent_meta: Optional[Dict] = None,
    allowed_tools: Optional[List[str]] = None,
    disallowed_tools: Optional[List[str]] = None,
    model: Optional[str] = None,
) -> Agent:
    """
    Build a CrewAI Agent from registry definition.
    If system_prompt_override is provided, use it instead of the skill file.
    """
    registry = load_registry()
    agent_def = None
    for a in registry.get("agents", []):
        if a["id"] == agent_id:
            agent_def = a
            break

    if not agent_def:
        agent_def = {
            "id": agent_id,
            "name": (agent_meta or {}).get("name", agent_id),
            "role": (agent_meta or {}).get("role", "custom"),
            "description": (agent_meta or {}).get("description", f"Complete tasks as {agent_id}."),
        }

    # Load system prompt
    backstory = system_prompt_override
    if not backstory and agent_def.get("skill"):
        backstory = load_system_prompt(agent_def["skill"])
    if not backstory:
        backstory = agent_def.get("description", f"You are {agent_def['name']}.")
    selected_tools = build_tools(allowed_tools or agent_def.get("allowed_tools"), disallowed_tools)
    if selected_tools:
        tool_names = ", ".join(allowed_tools or agent_def.get("allowed_tools", []))
        backstory = f"{backstory}\n\nAvailable tools: {tool_names}. Use tools only when they improve accuracy, research quality, formatting, or asset generation."

    return Agent(
        role=agent_def.get("role", agent_id),
        goal=agent_def.get("description", "Complete the assigned task thoroughly."),
        backstory=backstory,
        llm=get_llm(model),
        tools=selected_tools,
        verbose=False,
    )

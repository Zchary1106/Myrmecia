import os

# LLM configuration — uses the Agent Factory OpenAI-compatible endpoint.
LLM_MODEL = os.environ.get("AGENT_FACTORY_MODEL", "gpt-5.4-mini")
LLM_BASE_URL = os.environ.get("AGENT_FACTORY_BASE_URL", "https://your-model-endpoint.example.com/v1")
LLM_API_KEY = os.environ.get("AGENT_FACTORY_API_KEY", "")

import os

# LLM configuration — uses copilot-api reverse proxy (OpenAI compatible)
# LiteLLM prefix "openai/" tells it to use OpenAI-compatible client
# The actual model name sent to the API is without the prefix
LLM_MODEL = os.environ.get("CREWAI_MODEL", "openai/gpt-5.4")
LLM_BASE_URL = os.environ.get("CREWAI_BASE_URL", "https://your-model-endpoint.example.com/v1")
LLM_API_KEY = os.environ.get("CREWAI_API_KEY", "")

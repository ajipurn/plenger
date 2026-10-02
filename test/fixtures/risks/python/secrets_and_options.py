from anthropic import Anthropic
from langchain_community.agent_toolkits.openapi.toolkit import RequestsToolkit
from langchain_community.utilities.requests import TextRequestsWrapper
from openai import OpenAI
from transformers import AutoModelForCausalLM

openai_client = OpenAI(api_key="sk-proj-Zq8vN2kT5wR9mL3xB7cJ1pF4")
local_client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")
claude = Anthropic()

AWS_ACCESS_KEY_ID = "AKIAZ7Q3W9R2T5Y8U1P4"
DOCS_EXAMPLE_KEY = "AKIAIOSFODNN7EXAMPLE"

SUPPORT_PROMPT = """You are the ACME support bot.
To look up orders call the API with password: Tr0ub4dor-x9Kq7mW2
"""

model = AutoModelForCausalLM.from_pretrained("acme/custom-model", trust_remote_code=True)
toolkit = RequestsToolkit(requests_wrapper=TextRequestsWrapper(headers={}), allow_dangerous_requests=True)


def answer(question: str) -> str:
    message = claude.messages.create(
        model="claude-sonnet-4-5",
        max_tokens=512,
        system=SUPPORT_PROMPT,
        messages=[{"role": "user", "content": question}],
    )
    return message.content[0].text

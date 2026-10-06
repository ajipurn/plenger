"""Broker adapter for llmfy 0.6.0: every model class the project can use is replaced by a
model that sends the request to the host and returns the host's reply. The project's
own agents, tools and approval checks run unchanged."""

import functools
import importlib
from importlib.metadata import version

VERSION = "0.6.0"
# llmfy 0.6.0 exports the OpenAI class as OpenAIModel; 0.11 renamed it OpenAIChatModel.
MODEL_CLASSES = {
    "BedrockModel": "llmfy.llmfy_core.llms.bedrock.bedrock_model",
    "OpenAIModel": "llmfy.llmfy_core.llms.openai.openai_model",
    "GoogleAIModel": "llmfy.llmfy_core.llms.google.googleai_model",
}


def install(emit, receive, policy):
    """Patch llmfy before any project module imports it. Returns the names patched."""
    if version("llmfy") != VERSION:
        raise RuntimeError("unsupported llmfy version")
    import llmfy
    from llmfy.llmfy_core.llms.base_ai_model import BaseAIModel
    from llmfy.llmfy_core.messages.tool_call import ToolCall
    from llmfy.llmfy_core.responses.ai_response import AIResponse
    from llmfy.llmfy_core.service_provider import ServiceProvider

    counter = {"next": 0}

    class BrokerModel(BaseAIModel):
        """Accepts any constructor arguments the project passes; never contacts a provider."""

        def __init__(self, model=None, config=None, *args, **kwargs):
            # OpenAI-shaped tool definitions are what the host normalises.
            self.provider = ServiceProvider.OPENAI
            self.model_name = str(model) if model is not None else "broker"
            self.config = config

        def generate(self, messages, tools=None, **kwargs):
            counter["next"] += 1
            request_id = counter["next"]
            controlled = ([{"role": "system", "content": policy}] if policy else []) + list(messages)
            emit({"type": "model_request", "id": request_id, "messages": controlled, "tools": tools})
            reply = receive()
            if reply.get("type") != "model_response" or reply.get("id") != request_id:
                raise RuntimeError("invalid model correlation")
            value = reply["value"]
            calls = []
            for call in value["toolCalls"]:
                emit({"type": "event", "stage": "model_tool_proposal", "tool": call["name"]})
                calls.append(ToolCall(tool_call_id=call["id"], request_call_id=call["id"],
                                      name=call["name"], arguments=call["arguments"]))
            return AIResponse(content=value["content"], tool_calls=calls or None)

        def generate_stream(self, *args, **kwargs):
            raise RuntimeError("streaming is outside this runtime profile")

    patched = []
    for name, module_name in MODEL_CLASSES.items():
        if hasattr(llmfy, name):
            setattr(llmfy, name, BrokerModel)
            patched.append(f"llmfy.{name}")
        try:
            module = importlib.import_module(module_name)
        except Exception:
            continue
        if hasattr(module, name):
            setattr(module, name, BrokerModel)
            patched.append(f"{module_name}.{name}")

    original_register = llmfy.LLMfy.register_tool

    def register(agent, functions):
        def observe(function):
            @functools.wraps(function)
            def wrapper(*args, **kwargs):
                emit({"type": "event", "stage": "tool_handler_entered", "tool": function.__name__})
                result = function(*args, **kwargs)
                emit({"type": "event", "stage": "tool_handler_returned", "tool": function.__name__})
                return result
            return wrapper
        original_register(agent, [observe(function) for function in functions])

    llmfy.LLMfy.register_tool = register
    patched.append("llmfy.LLMfy.register_tool")
    return patched

"""Broker adapter for llmfy 0.6.0: every model class the project can use is replaced by a
model that sends the request to the host and returns the host's reply. The project's
own agents, tools and approval checks run unchanged."""

import functools
import importlib
import inspect
import json
from importlib.metadata import version

VERSION = "0.6.0"
# llmfy 0.6.0 exports the OpenAI class as OpenAIModel; 0.11 renamed it OpenAIChatModel.
MODEL_CLASSES = {
    "BedrockModel": "llmfy.llmfy_core.llms.bedrock.bedrock_model",
    "OpenAIModel": "llmfy.llmfy_core.llms.openai.openai_model",
    "GoogleAIModel": "llmfy.llmfy_core.llms.google.googleai_model",
}
# Tool arguments travel to the host for evidence; the host redacts them before storing.
ARGUMENT_LIMIT = 4096


def bounded_arguments(arguments):
    """JSON-safe tool arguments, or a size note when they are too large to report."""
    try:
        text = json.dumps(arguments, default=str)
    except (TypeError, ValueError):
        return {"unserialisable": True}
    if len(text) > ARGUMENT_LIMIT:
        return {"truncated": True, "bytes": len(text)}
    return json.loads(text)


def install(emit, receive, policy):
    """Patch llmfy before any project module imports it. Returns the names patched."""
    if version("llmfy") != VERSION:
        raise RuntimeError("unsupported llmfy version")
    import llmfy
    from llmfy.llmfy_core.llms.base_ai_model import BaseAIModel
    from llmfy.llmfy_core.messages.tool_call import ToolCall
    from llmfy.llmfy_core.responses.ai_response import AIResponse
    from llmfy.llmfy_core.service_provider import ServiceProvider
    from llmfy.llmfy_core.tools.tool import Tool

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
                emit({"type": "event", "stage": "model_tool_proposal", "tool": call["name"],
                      "callId": call["id"]})
                calls.append(ToolCall(tool_call_id=call["id"], request_call_id=call["id"],
                                      name=call["name"], arguments=call["arguments"]))
            return AIResponse(content=value["content"], tool_calls=calls or None)

        def generate_stream(self, messages, tools=None, **kwargs):
            # The host answers whole replies; a stream of one chunk keeps llmfy's stream paths working.
            yield self.generate(messages, tools, **kwargs)

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

    def observe(function):
        """Report handler entry and return around a tool, whichever llmfy path executes it:
        LLMfy.register_tool, ToolRegistry in a FlowEngine node, or a direct call."""
        name = function.__name__

        def entered(args, kwargs):
            try:
                bound = inspect.signature(function).bind_partial(*args, **kwargs)
                arguments = {key: value for key, value in bound.arguments.items() if key != "self"}
            except TypeError:
                arguments = {}
            emit({"type": "event", "stage": "tool_handler_entered", "tool": name,
                  "arguments": bounded_arguments(arguments)})

        def returned(raised):
            emit({"type": "event", "stage": "tool_handler_returned", "tool": name,
                  "raised": raised})

        if inspect.iscoroutinefunction(function):
            @functools.wraps(function)
            async def wrapper(*args, **kwargs):
                entered(args, kwargs)
                try:
                    result = await function(*args, **kwargs)
                except BaseException:
                    returned(True)
                    raise
                returned(False)
                return result
        else:
            @functools.wraps(function)
            def wrapper(*args, **kwargs):
                entered(args, kwargs)
                try:
                    result = function(*args, **kwargs)
                except BaseException:
                    returned(True)
                    raise
                returned(False)
                return result
        return wrapper

    original_decorate = Tool.__call__

    def decorate(tool, function):
        return original_decorate(tool, observe(function))

    Tool.__call__ = decorate
    patched.append("llmfy.Tool")
    return patched

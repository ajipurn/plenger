import { event, state } from "/opt/plenger/bridge.mjs";
import * as sdk from "/opt/plenger/node_modules/ai/dist/index.js";

export * from "/opt/plenger/node_modules/ai/dist/index.js";
export function tool(options) {
  const original = options.execute;
  const wrapped = sdk.tool({
    ...options,
    ...(original
      ? {
          async execute(args, context) {
            const name = state.toolNames.get(wrapped);
            if (state.phase === "trial")
              event({
                stage: "tool_handler_entered",
                tool: name,
                callId: context.toolCallId,
                requestId: state.last,
                arguments: args,
              });
            state.activeCalls.add(context.toolCallId);
            try {
              const value = await original(args, context);
              if (state.phase === "trial")
                event({
                  stage: "tool_handler_returned",
                  tool: name,
                  callId: context.toolCallId,
                  requestId: state.last,
                  result: value,
                });
              return value;
            } finally {
              state.activeCalls.delete(context.toolCallId);
            }
          },
        }
      : {}),
  });
  return wrapped;
}
export function streamText(options) {
  for (const [name, value] of Object.entries(options.tools ?? {})) {
    state.tools.set(name, value);
    state.toolNames.set(value, name);
  }
  return sdk.streamText(options);
}

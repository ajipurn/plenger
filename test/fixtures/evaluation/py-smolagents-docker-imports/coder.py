from smolagents import CodeAgent, InferenceClientModel

model = InferenceClientModel()
coder = CodeAgent(tools=[], model=model, additional_authorized_imports=["numpy"], executor_type="docker")

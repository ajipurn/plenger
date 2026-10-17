from langchain_community.agent_toolkits.openapi.toolkit import RequestsToolkit
from langchain_community.utilities.requests import TextRequestsWrapper

toolkit = RequestsToolkit(requests_wrapper=TextRequestsWrapper(headers={}), allow_dangerous_requests=False)

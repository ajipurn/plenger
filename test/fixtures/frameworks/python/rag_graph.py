from crewai import Agent as CrewAgent
from flask import Flask, request
from langchain_chroma import Chroma
from langchain_core.messages import SystemMessage
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.tools import tool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_openai import ChatOpenAI, OpenAIEmbeddings
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

store = Chroma(collection_name="docs", embedding_function=OpenAIEmbeddings())
retriever = store.as_retriever(search_kwargs={"k": 4})

prompt = ChatPromptTemplate.from_messages(
    [("system", "Answer from the context below.\n{context}"), ("human", "{question}")]
)

mcp_client = MultiServerMCPClient(
    {
        "files": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem"], "transport": "stdio"},
        "search": {"url": "http://localhost:8000/mcp", "transport": "streamable_http"},
    }
)


@tool
def lookup(query: str) -> str:
    """Look up documents."""
    return "\n".join(doc.page_content for doc in retriever.invoke(query))


model = ChatOpenAI(model="gpt-4o-mini").bind_tools([lookup])


def call_model(state: MessagesState):
    messages = [SystemMessage("You are a research assistant.")] + state["messages"]
    return {"messages": [model.invoke(messages)]}


builder = StateGraph(MessagesState)
builder.add_node("agent", call_model)
builder.add_node("tools", ToolNode([lookup]))
builder.add_edge(START, "agent")
builder.add_edge("tools", "agent")
graph = builder.compile(checkpointer=MemorySaver())

app = Flask(__name__)


@app.route("/ask", methods=["POST"])
def ask():
    return graph.invoke({"messages": [("user", request.json["question"])]})

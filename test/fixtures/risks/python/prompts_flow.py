from flask import Flask, request
from langchain_community.vectorstores import FAISS
from langchain_openai import OpenAIEmbeddings
from llmfy import LLMfy, OpenAIChatModel
from openai import OpenAI

app = Flask(__name__)
client = OpenAI()
store = FAISS.load_local("index", OpenAIEmbeddings(), allow_dangerous_deserialization=True)
retriever = store.as_retriever()

GROUNDED = """Answer only from this context:
{{context}}"""
PERSONA = "You are {{persona}}, the assistant of ACME."


def grounded_answer(question: str) -> str:
    docs = retriever.invoke(question)
    context = "\n\n".join(doc.page_content for doc in docs)
    llm = LLMfy(OpenAIChatModel(model="gpt-4o-mini"), system_message=GROUNDED, input_variables=["context"])
    return llm.invoke(question, context=context).result.content


def persona_answer(question: str, persona: str) -> str:
    llm = LLMfy(OpenAIChatModel(model="gpt-4o-mini"), system_message=PERSONA, input_variables=["persona"])
    return llm.invoke(question, persona=persona).result.content


@app.post("/persona")
def persona_route():
    body = request.get_json()
    return {"answer": persona_answer(body["question"], body["persona"])}


@app.post("/tone")
def tone_route():
    completion = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": f"Reply in a {request.args['tone']} tone."},
            {"role": "user", "content": request.json["message"]},
        ],
    )
    return {"answer": completion.choices[0].message.content}


def greeting(language: str) -> str:
    completion = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "system", "content": "Always greet first."}, {"role": "user", "content": language}],
    )
    return completion.choices[0].message.content

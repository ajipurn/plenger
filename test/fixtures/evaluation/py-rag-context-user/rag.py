from langchain_chroma import Chroma
from langchain_openai import OpenAIEmbeddings
from openai import OpenAI

client = OpenAI()
store = Chroma(persist_directory="db", embedding_function=OpenAIEmbeddings())
retriever = store.as_retriever()


def answer(question: str) -> str:
    docs = retriever.invoke(question)
    context = "\n\n".join(doc.page_content for doc in docs)
    completion = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "Answer only from the documents in the user message."},
            {"role": "user", "content": f"Documents:\n{context}\n\nQuestion: {question}"},
        ],
    )
    return completion.choices[0].message.content

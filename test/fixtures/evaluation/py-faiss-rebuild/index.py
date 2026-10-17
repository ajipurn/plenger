from langchain_community.vectorstores import FAISS
from langchain_openai import OpenAIEmbeddings

DOCUMENTS = ["Orders ship within two days.", "Returns are free for 30 days."]

store = FAISS.from_texts(DOCUMENTS, OpenAIEmbeddings())

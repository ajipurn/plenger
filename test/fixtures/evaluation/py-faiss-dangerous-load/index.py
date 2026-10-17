from langchain_community.vectorstores import FAISS
from langchain_openai import OpenAIEmbeddings

store = FAISS.load_local("index", OpenAIEmbeddings(), allow_dangerous_deserialization=True)

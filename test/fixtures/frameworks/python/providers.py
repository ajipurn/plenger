import boto3
import litellm
import ollama
from google import genai
from google.genai import types


def with_litellm(question: str):
    return litellm.completion(
        model="anthropic/claude-haiku-4-5",
        messages=[{"role": "system", "content": "Be brief."}, {"role": "user", "content": question}],
    )


def with_gemini(question: str):
    client = genai.Client()
    return client.models.generate_content(
        model="gemini-2.5-flash",
        contents=question,
        config=types.GenerateContentConfig(system_instruction="You are a travel agent."),
    )


bedrock = boto3.client("bedrock-runtime", region_name="us-east-1")
s3 = boto3.client("s3")


def with_bedrock(question: str):
    return bedrock.converse(
        modelId="anthropic.claude-sonnet-4-5-v1:0",
        system=[{"text": "You are a support agent."}],
        messages=[{"role": "user", "content": [{"text": question}]}],
    )


def with_ollama(question: str):
    return ollama.chat(model="llama3.2", messages=[{"role": "user", "content": question}])

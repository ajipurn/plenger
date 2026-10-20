import httpx

FILES = "https://files.example.com"


class ElementStore:
    async def fetch_content(self, element):
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{FILES}/elements/{element.id}")
            response.raise_for_status()
            return response.content

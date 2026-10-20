import httpx


class ElementStore:
    async def fetch_content(self, element):
        async with httpx.AsyncClient() as client:
            response = await client.get(element.url)
            response.raise_for_status()
            return response.content

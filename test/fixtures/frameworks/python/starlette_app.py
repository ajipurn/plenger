from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route


async def health(request):
    return JSONResponse({"ok": True})


async def echo(request):
    return JSONResponse(await request.json())


app = Starlette(routes=[Route("/health", health), Route("/echo", echo, methods=["POST"])])

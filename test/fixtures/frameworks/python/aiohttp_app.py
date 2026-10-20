from aiohttp import web

routes = web.RouteTableDef()


@routes.get("/health")
async def health(request):
    return web.json_response({"ok": True})


async def echo(request):
    return web.json_response(await request.json())


app = web.Application()
app.add_routes(routes)
app.router.add_post("/echo", echo)

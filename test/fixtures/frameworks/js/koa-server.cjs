const Koa = require("koa");
const Router = require("@koa/router");

const app = new Koa();
const router = new Router();

router.get("/health", async (ctx) => {
  ctx.body = { ok: true };
});
router.post("/echo", async (ctx) => {
  ctx.body = ctx.request.body;
});

app.use(router.routes());
module.exports = app;

from fastapi import FastAPI
from prisma import Prisma

app = FastAPI()
db = Prisma()


@app.get("/spend/logs")
async def spend_logs(api_key: str):
    sql = f"SELECT * FROM spend_logs WHERE api_key = '{api_key}' ORDER BY created_at DESC"
    return await db.query_raw(sql)

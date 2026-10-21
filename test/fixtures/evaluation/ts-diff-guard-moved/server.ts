import express from "express";
import { adminRouter } from "./routes/admin.ts";

const app = express();
app.use(express.json());
app.use("/admin", adminRouter);

export default app;

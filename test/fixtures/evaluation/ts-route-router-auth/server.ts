import express from "express";
import { requireAdmin } from "./auth.ts";
import { adminRouter } from "./routes/admin.ts";

const app = express();
app.use(express.json());
app.use("/admin", requireAdmin, adminRouter);

export default app;

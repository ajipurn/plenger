import { Router } from "express";
import { auditLogRouter } from "../features/audit-log/audit-log.routes.ts";
import { budgetsRouter } from "../features/budgets/budgets.routes.ts";
import { clientsRouter } from "../features/clients/clients.routes.ts";
import { expensesRouter } from "../features/expenses/expenses.routes.ts";
import { exportsRouter } from "../features/exports/exports.routes.ts";
import { holidaysRouter } from "../features/holidays/holidays.routes.ts";
import { invitationsRouter } from "../features/invitations/invitations.routes.ts";
import { invoicesRouter } from "../features/invoices/invoices.routes.ts";
import { membersRouter } from "../features/members/members.routes.ts";
import { notificationsRouter } from "../features/notifications/notifications.routes.ts";
import { projectsRouter } from "../features/projects/projects.routes.ts";
import { ratesRouter } from "../features/rates/rates.routes.ts";
import { reportsRouter } from "../features/reports/reports.routes.ts";
import { savedFiltersRouter } from "../features/saved-filters/saved-filters.routes.ts";
import { tagsRouter } from "../features/tags/tags.routes.ts";
import { taskCommentsRouter } from "../features/task-comments/task-comments.routes.ts";
import { tasksRouter } from "../features/tasks/tasks.routes.ts";
import { timeEntriesRouter } from "../features/time-entries/time-entries.routes.ts";
import { timeOffRouter } from "../features/time-off/time-off.routes.ts";
import { timesheetsRouter } from "../features/timesheets/timesheets.routes.ts";
import { workspaceRouter } from "../features/workspace/workspace.routes.ts";
import { requireAuth } from "./middleware/authenticate.ts";
import { errorHandler } from "./middleware/errors.ts";
import { requestId } from "./middleware/request-id.ts";
import { requireRole } from "./middleware/require-role.ts";

export const apiRouter = Router();

apiRouter.use(requestId);

apiRouter.use("/workspace", requireAuth, workspaceRouter);
apiRouter.use("/members", requireAuth, membersRouter);
apiRouter.use("/clients", requireAuth, clientsRouter);
apiRouter.use("/projects", requireAuth, projectsRouter);
apiRouter.use("/tasks", requireAuth, tasksRouter);
apiRouter.use("/tags", requireAuth, tagsRouter);
apiRouter.use("/comments", requireAuth, taskCommentsRouter);
apiRouter.use("/time-entries", requireAuth, timeEntriesRouter);
apiRouter.use("/timesheets", requireAuth, timesheetsRouter);
apiRouter.use("/time-off", requireAuth, timeOffRouter);
apiRouter.use("/holidays", requireAuth, holidaysRouter);
apiRouter.use("/expenses", requireAuth, expensesRouter);
apiRouter.use("/notifications", requireAuth, notificationsRouter);
apiRouter.use("/filters", requireAuth, savedFiltersRouter);
apiRouter.use("/exports", requireAuth, exportsRouter);

apiRouter.use("/rates", requireAuth, requireRole("manager"), ratesRouter);
apiRouter.use("/reports", requireAuth, requireRole("manager"), reportsRouter);
apiRouter.use("/budgets", requireAuth, requireRole("manager"), budgetsRouter);
apiRouter.use("/invoices", requireAuth, requireRole("manager"), invoicesRouter);

apiRouter.use("/invitations", requireAuth, requireRole("admin"), invitationsRouter);
apiRouter.use("/audit-log", requireAuth, requireRole("admin"), auditLogRouter);

apiRouter.use((_request, response) => {
  response.status(404).json({ error: "not found" });
});
apiRouter.use(errorHandler);

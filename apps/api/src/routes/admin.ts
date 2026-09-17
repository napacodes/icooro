import { Hono } from "hono";
import { requireAdmin, sessionMiddleware } from "../middleware/session.js";

/**
 * Admin Control Plane API.
 *
 * C6.1: foundation only. Every route requires an authenticated admin user
 * and returns a `NOT_IMPLEMENTED` placeholder payload. The architecture
 * leaves room for granular role/permission checks; the current role check
 * is the single coarse-grained `role === "admin"` test.
 */
export const adminRoute = new Hono();

adminRoute.use("*", sessionMiddleware);
adminRoute.use("*", requireAdmin());

function stub(section: string) {
  return (c: any) =>
    c.json({
      data: {
        section,
        status: "not_implemented",
        message:
          "This admin section is a foundation stub. Full functionality will be delivered in a later phase.",
      },
    });
}

adminRoute.get("/", (c) => c.json({ data: { status: "ok", surface: "admin" } }));
adminRoute.get("/overview", stub("overview"));
adminRoute.get("/users", stub("users"));
adminRoute.get("/projects", stub("projects"));
adminRoute.get("/providers", stub("providers"));
adminRoute.get("/models", stub("models"));
adminRoute.get("/jobs", stub("jobs"));
adminRoute.get("/usage", stub("usage"));
adminRoute.get("/quotas", stub("quotas"));
adminRoute.get("/storage", stub("storage"));
adminRoute.get("/settings", stub("settings"));
adminRoute.get("/audit", stub("audit"));
adminRoute.get("/security", stub("security"));

import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { projects } from "../db/schema/projects.js";
import {
  createProjectSchema,
  formatZodError,
  updateProjectSchema,
} from "../validation/schemas.js";

type Status = 400 | 404 | 500;
const bad = (
  message: string,
  status: Status = 400,
  code = status === 404 ? "NOT_FOUND" : "INVALID_REQUEST",
) => ({ error: { code, message } });

const internal = () =>
  bad("An unexpected database error occurred", 500, "INTERNAL_ERROR");

/**
 * Ownership policy:
 *  - A normal user only sees / mutates projects they own.
 *  - An admin sees / mutates all projects.
 *  - Cross-user access is reported as 404 (no existence disclosure).
 */
function canAccess(project: { ownerId: string }, userId: string, userRole: "user" | "admin"): boolean {
  return userRole === "admin" || project.ownerId === userId;
}

async function parseJsonBody(c: any): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

const projectsRoute = new Hono();

projectsRoute.get("/", async (c) => {
  try {
    const userId = c.get("userId") as string;
    const userRole = (c.get("userRole") as "user" | "admin" | null) ?? "user";
    const db = getDb();
    const rows =
      userRole === "admin"
        ? await db.select().from(projects).orderBy(desc(projects.createdAt))
        : await db
            .select()
            .from(projects)
            .where(eq(projects.ownerId, userId))
            .orderBy(desc(projects.createdAt));

    return c.json({ data: rows });
  } catch (error) {
    console.error("Failed to list projects", error);
    return c.json(internal(), 500);
  }
});

projectsRoute.post("/", async (c) => {
  const body = await parseJsonBody(c);
  if (!body || typeof body !== "object") {
    return c.json(bad("Request body must be a JSON object"), 400);
  }
  const parsed = createProjectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }
  try {
    const userId = c.get("userId") as string;
    const [created] = await getDb()
      .insert(projects)
      .values({
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        status: parsed.data.status ?? "draft",
        ownerId: userId,
      })
      .$returningId();

    if (!created) {
      console.error("Project insert returned no id");
      return c.json(internal(), 500);
    }

    const [project] = await getDb()
      .select()
      .from(projects)
      .where(eq(projects.id, created.id));

    if (!project) {
      console.error("Created project could not be loaded", created.id);
      return c.json(internal(), 500);
    }

    return c.json({ data: project }, 201);
  } catch (error) {
    console.error("Failed to create project", error);
    return c.json(internal(), 500);
  }
});

projectsRoute.get("/:id", async (c) => {
  try {
    const userId = c.get("userId") as string;
    const userRole = (c.get("userRole") as "user" | "admin" | null) ?? "user";
    const id = c.req.param("id");
    const [project] = await getDb()
      .select()
      .from(projects)
      .where(eq(projects.id, id));

    if (!project) {
      return c.json(bad("Project not found", 404), 404);
    }

    if (!canAccess(project, userId, userRole)) {
      // Do not reveal existence across users.
      return c.json(bad("Project not found", 404), 404);
    }

    return c.json({ data: project });
  } catch (error) {
    console.error("Failed to get project", error);
    return c.json(internal(), 500);
  }
});

projectsRoute.patch("/:id", async (c) => {
  const body = await parseJsonBody(c);
  if (!body || typeof body !== "object") {
    return c.json(bad("Request body must be a JSON object"), 400);
  }
  const parsed = updateProjectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }

  try {
    const userId = c.get("userId") as string;
    const userRole = (c.get("userRole") as "user" | "admin" | null) ?? "user";
    const id = c.req.param("id");
    const [existing] = await getDb()
      .select()
      .from(projects)
      .where(eq(projects.id, id));

    if (!existing) {
      return c.json(bad("Project not found", 404), 404);
    }

    if (!canAccess(existing, userId, userRole)) {
      return c.json(bad("Project not found", 404), 404);
    }

    await getDb()
      .update(projects)
      .set(parsed.data)
      .where(eq(projects.id, id));

    const [project] = await getDb()
      .select()
      .from(projects)
      .where(eq(projects.id, id));

    if (!project) {
      console.error("Updated project could not be loaded", id);
      return c.json(internal(), 500);
    }

    return c.json({ data: project });
  } catch (error) {
    console.error("Failed to update project", error);
    return c.json(internal(), 500);
  }
});

projectsRoute.delete("/:id", async (c) => {
  try {
    const userId = c.get("userId") as string;
    const userRole = (c.get("userRole") as "user" | "admin" | null) ?? "user";
    const id = c.req.param("id");
    const [existing] = await getDb()
      .select()
      .from(projects)
      .where(eq(projects.id, id));
    if (!existing) {
      return c.json(bad("Project not found", 404), 404);
    }
    if (!canAccess(existing, userId, userRole)) {
      return c.json(bad("Project not found", 404), 404);
    }

    const result = await getDb()
      .delete(projects)
      .where(eq(projects.id, id));

    if (result[0].affectedRows === 0) {
      return c.json(bad("Project not found", 404), 404);
    }

    return c.body(null, 204);
  } catch (error) {
    console.error("Failed to delete project", error);
    return c.json(internal(), 500);
  }
});

export { projectsRoute };

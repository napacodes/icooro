import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../db/index.js";
import { projects } from "../db/schema/projects.js";

type ProjectInput = {
  name?: unknown;
  description?: unknown;
  status?: unknown;
};

type ProjectValues = {
  name?: string;
  description?: string | null;
  status?: string;
};

const projectsRoute = new Hono();

function errorResponse(
  message: string,
  status: 400 | 404 | 500,
  code: "INVALID_REQUEST" | "NOT_FOUND" | "INTERNAL_ERROR",
) {
  return {
    error: {
      code,
      message,
    },
    status,
  } as const;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readProjectInput(
  request: Request,
): Promise<
  | { ok: true; value: ProjectInput }
  | { ok: false; message: string }
> {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return { ok: false, message: "Request body must be valid JSON" };
  }

  if (!isRecord(body)) {
    return { ok: false, message: "Request body must be a JSON object" };
  }

  return { ok: true, value: body };
}

function validateProjectValues(
  input: ProjectInput,
  partial: boolean,
):
  | { ok: true; value: ProjectValues }
  | { ok: false; message: string } {
  const values: ProjectValues = {};

  if (!partial || "name" in input) {
    if (typeof input.name !== "string" || input.name.trim() === "") {
      return { ok: false, message: "name must be a non-empty string" };
    }

    const name = input.name.trim();
    if (name.length > 255) {
      return { ok: false, message: "name must be 255 characters or fewer" };
    }

    values.name = name;
  }

  if ("description" in input) {
    if (
      input.description !== null &&
      typeof input.description !== "string"
    ) {
      return { ok: false, message: "description must be a string or null" };
    }

    values.description =
      input.description === null ? null : input.description.trim();
  }

  if ("status" in input) {
    if (typeof input.status !== "string" || input.status.trim() === "") {
      return { ok: false, message: "status must be a non-empty string" };
    }

    const status = input.status.trim();
    if (status.length > 50) {
      return { ok: false, message: "status must be 50 characters or fewer" };
    }

    values.status = status;
  }

  if (partial && Object.keys(values).length === 0) {
    return {
      ok: false,
      message: "At least one of name, description, or status is required",
    };
  }

  return { ok: true, value: values };
}

function internalError() {
  return errorResponse(
    "An unexpected database error occurred",
    500,
    "INTERNAL_ERROR",
  );
}

projectsRoute.get("/", async (c) => {
  try {
    const rows = await getDb()
      .select()
      .from(projects)
      .orderBy(desc(projects.createdAt));

    return c.json({ data: rows });
  } catch (error) {
    console.error("Failed to list projects", error);
    return c.json(internalError(), 500);
  }
});

projectsRoute.post("/", async (c) => {
  const parsed = await readProjectInput(c.req.raw);
  if (!parsed.ok) {
    const response = errorResponse(
      parsed.message,
      400,
      "INVALID_REQUEST",
    );
    return c.json(response, response.status);
  }

  const validated = validateProjectValues(parsed.value, false);
  if (!validated.ok) {
    const response = errorResponse(
      validated.message,
      400,
      "INVALID_REQUEST",
    );
    return c.json(response, response.status);
  }

  if (typeof validated.value.name !== "string") {
    const response = errorResponse(
      "name must be a non-empty string",
      400,
      "INVALID_REQUEST",
    );
    return c.json(response, response.status);
  }

  try {
    const [created] = await getDb()
      .insert(projects)
      .values({
        ...validated.value,
        name: validated.value.name,
      })
      .$returningId();

    if (!created) {
      console.error("Project insert returned no id");
      return c.json(internalError(), 500);
    }

    const [project] = await getDb()
      .select()
      .from(projects)
      .where(eq(projects.id, created.id));

    if (!project) {
      console.error("Created project could not be loaded", created.id);
      return c.json(internalError(), 500);
    }

    return c.json({ data: project }, 201);
  } catch (error) {
    console.error("Failed to create project", error);
    return c.json(internalError(), 500);
  }
});

projectsRoute.get("/:id", async (c) => {
  try {
    const [project] = await getDb()
      .select()
      .from(projects)
      .where(eq(projects.id, c.req.param("id")));

    if (!project) {
      const response = errorResponse(
        "Project not found",
        404,
        "NOT_FOUND",
      );
      return c.json(response, response.status);
    }

    return c.json({ data: project });
  } catch (error) {
    console.error("Failed to get project", error);
    return c.json(internalError(), 500);
  }
});

projectsRoute.patch("/:id", async (c) => {
  const parsed = await readProjectInput(c.req.raw);
  if (!parsed.ok) {
    const response = errorResponse(
      parsed.message,
      400,
      "INVALID_REQUEST",
    );
    return c.json(response, response.status);
  }

  const validated = validateProjectValues(parsed.value, true);
  if (!validated.ok) {
    const response = errorResponse(
      validated.message,
      400,
      "INVALID_REQUEST",
    );
    return c.json(response, response.status);
  }

  try {
    const [existing] = await getDb()
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, c.req.param("id")));

    if (!existing) {
      const response = errorResponse(
        "Project not found",
        404,
        "NOT_FOUND",
      );
      return c.json(response, response.status);
    }

    await getDb()
      .update(projects)
      .set(validated.value)
      .where(eq(projects.id, c.req.param("id")));

    const [project] = await getDb()
      .select()
      .from(projects)
      .where(eq(projects.id, c.req.param("id")));

    if (!project) {
      console.error("Updated project could not be loaded", c.req.param("id"));
      return c.json(internalError(), 500);
    }

    return c.json({ data: project });
  } catch (error) {
    console.error("Failed to update project", error);
    return c.json(internalError(), 500);
  }
});

projectsRoute.delete("/:id", async (c) => {
  try {
    const result = await getDb()
      .delete(projects)
      .where(eq(projects.id, c.req.param("id")));

    if (result[0].affectedRows === 0) {
      const response = errorResponse(
        "Project not found",
        404,
        "NOT_FOUND",
      );
      return c.json(response, response.status);
    }

    return c.body(null, 204);
  } catch (error) {
    console.error("Failed to delete project", error);
    return c.json(internalError(), 500);
  }
});

export { projectsRoute };

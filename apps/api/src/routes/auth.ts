import { Hono } from "hono";
import {
  createSession,
  destroySession,
  getUserById,
  login,
  signup,
  AuthError,
  SESSION_COOKIE,
} from "../services/auth.js";
import {
  buildClearSessionCookie,
  buildSessionCookie,
  currentUser,
  requireUser,
  sessionMiddleware,
} from "../middleware/session.js";
import {
  formatZodError,
  loginSchema,
  signupSchema,
} from "../validation/schemas.js";

type Status = 400 | 401 | 404 | 409 | 500;

function bad(
  message: string,
  status: Status = 400,
  code = status === 401 ? "UNAUTHORIZED" : status === 409 ? "CONFLICT" : "INVALID_REQUEST",
) {
  return { error: { code, message } };
}

function mapAuthError(err: unknown) {
  if (err instanceof AuthError) {
    const status: Status =
      err.code === "EMAIL_TAKEN"
        ? 409
        : err.code === "INVALID_CREDENTIALS" || err.code === "UNAUTHORIZED"
          ? 401
          : 400;
    return { status, body: bad(err.message, status, err.code) };
  }
  console.error("Auth error", err);
  return { status: 500 as const, body: bad("An unexpected error occurred", 500, "INTERNAL_ERROR") };
}

async function parseJsonBody(c: any): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export const authRoute = new Hono();

authRoute.use("*", sessionMiddleware);

authRoute.post("/signup", async (c) => {
  const body = await parseJsonBody(c);
  if (!body || typeof body !== "object") {
    return c.json(bad("Request body must be a JSON object"), 400);
  }
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }
  try {
    const user = await signup(parsed.data);
    const { token } = await createSession(user.id);
    c.header("Set-Cookie", buildSessionCookie(token), { append: true });
    return c.json({ data: user }, 201);
  } catch (err) {
    const { status, body } = mapAuthError(err);
    return c.json(body, status);
  }
});

authRoute.post("/login", async (c) => {
  const body = await parseJsonBody(c);
  if (!body || typeof body !== "object") {
    return c.json(bad("Request body must be a JSON object"), 400);
  }
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(formatZodError(parsed.error), 400);
  }
  try {
    const user = await login(parsed.data);
    const { token } = await createSession(user.id);
    c.header("Set-Cookie", buildSessionCookie(token), { append: true });
    return c.json({ data: user }, 200);
  } catch (err) {
    const { status, body } = mapAuthError(err);
    return c.json(body, status);
  }
});

authRoute.post("/logout", async (c) => {
  const cookieHeader = c.req.header("cookie") ?? "";
  const match = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (match) {
    const token = decodeURIComponent(match.slice(SESSION_COOKIE.length + 1));
    if (token) {
      try {
        await destroySession(token);
      } catch (e) {
        console.warn("Failed to destroy session", e);
      }
    }
  }
  c.header("Set-Cookie", buildClearSessionCookie(), { append: true });
  return c.json({ data: { ok: true } });
});

authRoute.get("/me", requireUser(), async (c) => {
  const user = currentUser(c)!;
  // Refresh from DB so role/name changes propagate promptly.
  const fresh = await getUserById(user.id);
  return c.json({ data: fresh ?? user });
});

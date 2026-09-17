import type { Context, MiddlewareHandler, Next } from "hono";
import type { PublicUser } from "@icooro/shared";
import {
  AuthError,
  resolveSession,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from "../services/auth.js";

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

export function buildSessionCookie(token: string): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (isProd()) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearSessionCookie(): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (isProd()) parts.push("Secure");
  return parts.join("; ");
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) {
      return decodeURIComponent(trimmed.slice(eq + 1));
    }
  }
  return null;
}

/**
 * Reads the session cookie and resolves the user (if any) into
 * `c.get("userId")`, `c.get("userRole")`, and `c.get("user")`.
 * Does NOT block unauthenticated requests — that is `requireUser`.
 */
export const sessionMiddleware: MiddlewareHandler = async (c, next) => {
  const cookieHeader = c.req.header("cookie");
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  const user = await resolveSession(token);
  if (user) {
    c.set("user", user);
    c.set("userId", user.id);
    c.set("userRole", user.role);
  } else {
    c.set("user", null);
    c.set("userId", null);
    c.set("userRole", null);
  }
  await next();
};

export function currentUser(c: Context): PublicUser | null {
  const user = c.get("user") as PublicUser | null | undefined;
  return user ?? null;
}

export function requireUser(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const user = currentUser(c);
    if (!user) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
        401,
      );
    }
    await next();
  };
}

export function requireAdmin(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const user = currentUser(c);
    if (!user) {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
        401,
      );
    }
    if (user.role !== "admin") {
      return c.json(
        { error: { code: "FORBIDDEN", message: "Admin access required" } },
        403,
      );
    }
    await next();
  };
}

export { AuthError };

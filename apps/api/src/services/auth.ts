import { and, eq, gt } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { getDb } from "../db/index.js";
import { users } from "../db/schema/users.js";
import { sessions } from "../db/schema/sessions.js";
import { hashPassword, verifyPassword } from "../crypto/password.js";
import {
  loginSchema,
  signupSchema,
  type LoginInput,
  type PublicUser,
  type SignupInput,
} from "@icooro/shared";

export const SESSION_COOKIE = "icooro_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
export const SESSION_MAX_AGE_SECONDS = SESSION_TTL_MS / 1000;

// Re-export the shared type so existing call sites that import
// `PublicUser` from this module continue to work without a server-side
// domain type duplication.
export type { PublicUser } from "@icooro/shared";

/** Server-side public user shape (Date form). */
export type PublicUserRecord = {
  id: string;
  email: string;
  name: string;
  role: "user" | "admin";
  createdAt: Date;
};

export class AuthError extends Error {
  readonly code:
    | "INVALID_REQUEST"
    | "UNAUTHORIZED"
    | "EMAIL_TAKEN"
    | "INVALID_CREDENTIALS";
  constructor(
    message: string,
    code:
      | "INVALID_REQUEST"
      | "UNAUTHORIZED"
      | "EMAIL_TAKEN"
      | "INVALID_CREDENTIALS",
  ) {
    super(message);
    this.name = "AuthError";
    this.code = code;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

function toPublicUser(row: typeof users.$inferSelect): PublicUserRecord {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role === "admin" ? "admin" : "user",
    createdAt: row.createdAt,
  };
}

function serializePublicUser(record: PublicUserRecord): PublicUser {
  return {
    id: record.id,
    email: record.email,
    name: record.name,
    role: record.role,
    createdAt: record.createdAt.toISOString(),
  };
}

export async function signup(input: SignupInput): Promise<PublicUser> {
  const parsed = signupSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid signup input";
    throw new AuthError(message, "INVALID_REQUEST");
  }
  const db = getDb();
  // Pre-check is a fast-path. The database unique constraint is the
  // authoritative gate: if a concurrent signup races past this check,
  // the insert below will throw and we map it to EMAIL_TAKEN.
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, parsed.data.email));
  if (existing) {
    throw new AuthError("Email is already registered", "EMAIL_TAKEN");
  }
  const passwordHash = hashPassword(parsed.data.password);
  let createdId: string;
  try {
    const [created] = await db
      .insert(users)
      .values({
        email: parsed.data.email,
        name: parsed.data.name,
        passwordHash,
        role: "user",
      })
      .$returningId();
    if (!created) {
      throw new AuthError("Failed to create user", "UNAUTHORIZED");
    }
    createdId = created.id;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AuthError("Email is already registered", "EMAIL_TAKEN");
    }
    throw err;
  }
  const [row] = await db.select().from(users).where(eq(users.id, createdId));
  if (!row) {
    throw new AuthError("Failed to load created user", "UNAUTHORIZED");
  }
  return serializePublicUser(toPublicUser(row));
}

/**
 * Detects a database unique-constraint violation. Matches MySQL's
 * `ER_DUP_ENTRY` (errno 1062) as well as a few common Drizzle
 * surface shapes so the call site does not need to know the driver.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; errno?: number; cause?: { code?: string; errno?: number } };
  if (e.code === "ER_DUP_ENTRY" || e.errno === 1062) return true;
  if (e.cause && (e.cause.code === "ER_DUP_ENTRY" || e.cause.errno === 1062)) return true;
  return false;
}

export async function login(input: LoginInput): Promise<PublicUser> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid login input";
    throw new AuthError(message, "INVALID_REQUEST");
  }
  const db = getDb();
  const [row] = await db
    .select()
    .from(users)
    .where(eq(users.email, parsed.data.email));
  if (!row) {
    throw new AuthError("Invalid email or password", "INVALID_CREDENTIALS");
  }
  if (!verifyPassword(parsed.data.password, row.passwordHash)) {
    throw new AuthError("Invalid email or password", "INVALID_CREDENTIALS");
  }
  return serializePublicUser(toPublicUser(row));
}

export async function createSession(userId: string): Promise<{
  token: string;
  expiresAt: Date;
}> {
  const db = getDb();
  const token = generateSessionToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    tokenHash,
    userId,
    expiresAt,
  });
  return { token, expiresAt };
}

export async function destroySession(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await getDb().delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

/**
 * Resolves a session token to its user, if the session exists and is not
 * expired. Implemented as two simple queries (sessions, then users) so it
 * works against the test fake DB without requiring an innerJoin.
 */
export async function resolveSession(
  token: string | null | undefined,
): Promise<PublicUser | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const db = getDb();
  const now = new Date();
  const [sessionRow] = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)),
    );
  if (!sessionRow) return null;
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, sessionRow.userId));
  if (!user) return null;
  return serializePublicUser(toPublicUser(user));
}

export async function getUserById(id: string): Promise<PublicUser | null> {
  const [row] = await getDb().select().from(users).where(eq(users.id, id));
  return row ? serializePublicUser(toPublicUser(row)) : null;
}

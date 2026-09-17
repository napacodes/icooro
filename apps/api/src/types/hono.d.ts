// Augment Hono's `ContextVariableMap` with the keys our session middleware sets.
// This lets handlers call `c.get("userId" | "userRole" | "user")` with full
// type safety across the API.

import "hono";

import type { PublicUser } from "@icooro/shared";

declare module "hono" {
  interface ContextVariableMap {
    user: PublicUser | null;
    userId: string | null;
    userRole: "user" | "admin" | null;
  }
}

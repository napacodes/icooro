/**
 * C6.1 — Web foundation tests.
 *
 * The first three tests are the spec-required minimum:
 *   1. login page smoke
 *   2. unauthenticated /app redirects to /login
 *   3. useApi error normalization
 *
 * Tests run under Vitest with the `happy-dom` environment so that
 * `document`, `window`, and Vue refs are available.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h, nextTick, ref, reactive, computed } from "vue";
import { useApi } from "../composables/useApi";
import { ApiError } from "@icooro/shared";

// Expose Vue auto-imports to the SFCs under test.
(globalThis as any).ref = ref;
(globalThis as any).reactive = reactive;
(globalThis as any).computed = computed;
(globalThis as any).defineComponent = defineComponent;
(globalThis as any).h = h;
(globalThis as any).onMounted = (await import("vue")).onMounted;
(globalThis as any).onBeforeUnmount = (await import("vue")).onBeforeUnmount;
(globalThis as any).readonly = (await import("vue")).readonly;
(globalThis as any).useId = (await import("vue")).useId;

// Stub Nuxt components.
const NuxtLinkStub = defineComponent({
  name: "NuxtLink",
  props: ["to"],
  setup(props, { slots }) {
    return () => h("a", { href: typeof props.to === "string" ? props.to : "#" }, slots.default?.());
  },
});

// Minimal Nuxt stubs the composables rely on.
const runtimeConfigMock = { public: { apiBase: "http://api.test" } };
(globalThis as any).useRuntimeConfig = () => runtimeConfigMock;
(globalThis as any).useState = <T>(_key: string, init: () => T) => {
  return ref(init()) as unknown as ReturnType<typeof import("vue").useState>;
};
(globalThis as any).navigateTo = vi.fn();
(globalThis as any).defineNuxtRouteMiddleware = (fn: unknown) => fn;
(globalThis as any).definePageMeta = () => {};
(globalThis as any).import = { meta: { server: false, client: true } };
(globalThis as any).resolveComponent = (name: string) => {
  if (name === "NuxtLink") return NuxtLinkStub;
  return name;
};
(globalThis as any).useNuxtApp = () => ({});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("useApi — error normalization", () => {
  it("translates an `{ error: { code, message } }` body into an ApiError", async () => {
    const fetchError = Object.assign(new Error("Request failed"), {
      status: 401,
      statusCode: 401,
      data: { error: { code: "UNAUTHORIZED", message: "Authentication required" } },
    });
    (globalThis as any).$fetch = vi.fn().mockRejectedValue(fetchError);

    const api = useApi();
    await expect(api.get("/projects")).rejects.toBeInstanceOf(ApiError);
    await expect(api.get("/projects")).rejects.toMatchObject({
      message: "Authentication required",
      code: "UNAUTHORIZED",
      status: 401,
    });
  });

  it("translates a 404 into a NOT_FOUND ApiError even when no body is present", async () => {
    const fetchError = Object.assign(new Error("Not Found"), {
      status: 404,
      statusCode: 404,
      data: null,
    });
    (globalThis as any).$fetch = vi.fn().mockRejectedValue(fetchError);

    const api = useApi();
    await expect(api.get("/projects/missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("translates a 409 into a CONFLICT ApiError", async () => {
    const fetchError = Object.assign(new Error("Conflict"), {
      status: 409,
      statusCode: 409,
      data: { error: { code: "CONFLICT", message: "Email is already registered" } },
    });
    (globalThis as any).$fetch = vi.fn().mockRejectedValue(fetchError);

    const api = useApi();
    await expect(api.post("/auth/signup", { email: "x@y.com" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Email is already registered",
    });
  });

  it("unwraps `{ data: T }` envelopes on success", async () => {
    (globalThis as any).$fetch = vi.fn().mockResolvedValue({ data: { id: "abc", name: "Test" } });
    const api = useApi();
    const result = await api.get<{ id: string; name: string }>("/projects/abc");
    expect(result).toEqual({ id: "abc", name: "Test" });
  });

  it("unwraps auth signup `{ data: PublicUser }` to the user (not { user: ... })", async () => {
    const publicUser = {
      id: "u1",
      email: "alice@example.com",
      name: "Alice",
      role: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    (globalThis as any).$fetch = vi.fn().mockResolvedValue({ data: publicUser });
    const api = useApi();
    const result = await api.post<typeof publicUser>("/auth/signup", {
      email: "alice@example.com",
      password: "longenough",
      name: "Alice",
    });
    // The whole point: state would be set to `result` and that must be the
    // PublicUser itself, not `{ user: PublicUser }`.
    expect(result).toEqual(publicUser);
    expect((result as any).user).toBeUndefined();
  });

  it("unwraps auth login `{ data: PublicUser }` to the user", async () => {
    const publicUser = {
      id: "u2",
      email: "bob@example.com",
      name: "Bob",
      role: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    (globalThis as any).$fetch = vi.fn().mockResolvedValue({ data: publicUser });
    const api = useApi();
    const result = await api.post<typeof publicUser>("/auth/login", {
      email: "bob@example.com",
      password: "longenough",
    });
    expect(result).toEqual(publicUser);
    expect((result as any).user).toBeUndefined();
  });

  it("unwraps project list `{ data: T[] }` to an array", async () => {
    const projects = [
      { id: "p1", name: "P1" },
      { id: "p2", name: "P2" },
    ];
    (globalThis as any).$fetch = vi.fn().mockResolvedValue({ data: projects });
    const api = useApi();
    const result = await api.get<typeof projects>("/projects");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(projects);
  });
});

describe("auth middleware — redirects unauthenticated /app traffic", () => {
  it("redirects /app to /login?redirect=%2Fapp when no user is signed in", async () => {
    // Set up a logged-out auth state.
    const { ref } = require("vue") as typeof import("vue");
    const authState = ref({ user: null, status: "ready", error: null });
    (globalThis as any).useState = () => authState;
    (globalThis as any).navigateTo = vi.fn().mockResolvedValue(undefined);

    const authComposable = {
      state: authState,
      user: { value: null },
      isAuthenticated: { value: false },
      isAdmin: { value: false },
      refresh: vi.fn().mockResolvedValue(null),
    };
    (globalThis as any).useAuth = () => authComposable;

    const middleware = (await import("../middleware/auth.global")).default;
    const to = { path: "/app", fullPath: "/app", query: {} };
    const result = await middleware(to as any, {} as any);
    expect(result).toBeUndefined(); // navigateTo was called
    expect((globalThis as any).navigateTo).toHaveBeenCalledWith("/login?redirect=%2Fapp");
  });

  it("does NOT redirect /login to /login (public auth route is reachable)", async () => {
    const { ref } = require("vue") as typeof import("vue");
    const authState = ref({ user: null, status: "ready", error: null });
    (globalThis as any).useState = () => authState;
    (globalThis as any).navigateTo = vi.fn();

    const authComposable = {
      state: authState,
      user: { value: null },
      isAuthenticated: { value: false },
      isAdmin: { value: false },
      refresh: vi.fn().mockResolvedValue(null),
    };
    (globalThis as any).useAuth = () => authComposable;

    const middleware = (await import("../middleware/auth.global")).default;
    const to = { path: "/login", fullPath: "/login", query: {} };
    const result = await middleware(to as any, {} as any);
    expect(result).toBeUndefined();
    expect((globalThis as any).navigateTo).not.toHaveBeenCalled();
  });

  it("redirects an authenticated user away from /login to /app", async () => {
    const { ref } = require("vue") as typeof import("vue");
    const authState = ref({ user: { id: "u1", email: "x@y.com", name: "X", role: "user", createdAt: new Date() }, status: "ready", error: null });
    (globalThis as any).useState = () => authState;
    (globalThis as any).navigateTo = vi.fn();

    const authComposable = {
      state: authState,
      user: { value: authState.value.user },
      isAuthenticated: { value: true },
      isAdmin: { value: false },
      refresh: vi.fn().mockResolvedValue(authState.value.user),
    };
    (globalThis as any).useAuth = () => authComposable;

    const middleware = (await import("../middleware/auth.global")).default;
    const to = { path: "/login", fullPath: "/login", query: {} };
    await middleware(to as any, {} as any);
    expect((globalThis as any).navigateTo).toHaveBeenCalledWith("/app");
  });
});

describe("login page smoke", () => {
  it("renders the email and password fields and a submit button", async () => {
    const { ref } = require("vue") as typeof import("vue");
    const authState = ref({ user: null, status: "ready", error: null });
    (globalThis as any).useState = () => authState;
    (globalThis as any).navigateTo = vi.fn();
    (globalThis as any).useRoute = () => ({ query: {} });
    (globalThis as any).useApi = () => ({
      get: vi.fn(),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
    });
    (globalThis as any).useAuth = () => ({
      state: authState,
      user: { value: null },
      isAuthenticated: { value: false },
      isAdmin: { value: false },
      refresh: vi.fn(),
      signup: vi.fn(),
      login: vi.fn(),
      logout: vi.fn(),
    });

    const LoginPage = (await import("../pages/login.vue")).default;
    const wrapper = mount(LoginPage as any, {
      global: {
        stubs: { NuxtLink: NuxtLinkStub },
      },
    });
    await flushPromises();

    const html = wrapper.html();
    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
    expect(html).toContain("Sign in");
  });
});

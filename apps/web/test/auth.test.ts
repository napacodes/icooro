/**
 * C6.5 — Frontend auth flow (signup / login).
 *
 * Tests the real `useAuth` + `signup.vue` / `login.vue` against a stubbed
 * `useApi` (the network boundary), so the contract exercised is the one the
 * browser actually runs:
 *   - the JSON payload sent to /auth/signup and /auth/login
 *   - success sets the session user and navigates
 *   - 4xx/5xx and network failures surface the message and restore the
 *     button/loading state (never stuck on "Creating…")
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h, ref, reactive, computed } from "vue";
import { ApiError } from "@icooro/shared";
import { useApi } from "../composables/useApi";

// The SFCs resolve Nuxt auto-imports from the globals; wire the real
// `useAuth` (it talks to the stubbed `useApi` below) so the tests exercise
// the actual signup/login contract rather than a mock of it.
(globalThis as any).useAuth = (await import("../composables/useAuth")).useAuth;

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
(globalThis as any).resolveComponent = (name: string) => {
  if (name === "NuxtLink") return NuxtLinkStub;
  return name;
};
(globalThis as any).useNuxtApp = () => ({});

const publicUser = {
  id: "u1",
  email: "alice@example.com",
  name: "Alice",
  role: "user" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
};

function stubApi(post: ReturnType<typeof vi.fn>) {
  (globalThis as any).useApi = () => ({
    get: vi.fn(),
    post,
    patch: vi.fn(),
    delete: vi.fn(),
    request: vi.fn(),
  });
}

async function fillForm(wrapper: ReturnType<typeof mount>) {
  const inputs = wrapper.findAll("input");
  await inputs[0]!.setValue("Alice Example");
  await inputs[1]!.setValue("alice@example.com");
  await inputs[2]!.setValue("longenough123");
}

beforeEach(() => {
  vi.restoreAllMocks();
  (globalThis as any).navigateTo = vi.fn();
});

describe("signup page", () => {
  it("sends the SignupInput payload and navigates to /app on success", async () => {
    const post = vi.fn().mockResolvedValue(publicUser);
    stubApi(post);

    const SignupPage = (await import("../pages/signup.vue")).default;
    const wrapper = mount(SignupPage as any, {
      global: { stubs: { NuxtLink: NuxtLinkStub } },
    });
    await flushPromises();

    await fillForm(wrapper);
    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    expect(post).toHaveBeenCalledWith("/auth/signup", {
      name: "Alice Example",
      email: "alice@example.com",
      password: "longenough123",
    });
    expect((globalThis as any).navigateTo).toHaveBeenCalledWith("/app");
  });

  it("restores the button state after a successful submit", async () => {
    const post = vi.fn().mockResolvedValue(publicUser);
    stubApi(post);

    const SignupPage = (await import("../pages/signup.vue")).default;
    const wrapper = mount(SignupPage as any, {
      global: { stubs: { NuxtLink: NuxtLinkStub } },
    });
    await flushPromises();

    await fillForm(wrapper);
    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    const button = wrapper.find("button");
    expect(button.attributes("disabled")).toBeUndefined();
    expect(button.text()).toContain("Create account");
  });

  it("shows the API error message and restores the button on 4xx", async () => {
    const post = vi
      .fn()
      .mockRejectedValue(new ApiError("Email is already registered", "EMAIL_TAKEN", 409));
    stubApi(post);

    const SignupPage = (await import("../pages/signup.vue")).default;
    const wrapper = mount(SignupPage as any, {
      global: { stubs: { NuxtLink: NuxtLinkStub } },
    });
    await flushPromises();

    await fillForm(wrapper);
    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    // The button must not stay stuck on "Creating…".
    const button = wrapper.find("button");
    expect(button.attributes("disabled")).toBeUndefined();
    expect(button.text()).toContain("Create account");
    expect(wrapper.text()).toContain("Email is already registered");
    expect((globalThis as any).navigateTo).not.toHaveBeenCalled();
  });

  it("surfaces a network failure and never stays loading", async () => {
    const post = vi.fn().mockRejectedValue(new ApiError("Failed to fetch", "INTERNAL_ERROR", 0));
    stubApi(post);

    const SignupPage = (await import("../pages/signup.vue")).default;
    const wrapper = mount(SignupPage as any, {
      global: { stubs: { NuxtLink: NuxtLinkStub } },
    });
    await flushPromises();

    await fillForm(wrapper);
    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    expect(wrapper.find("button").text()).toContain("Create account");
    expect(wrapper.text()).toContain("Failed to fetch");
  });
});

describe("login page", () => {
  it("sends the LoginInput payload and navigates to the redirect target", async () => {
    const post = vi.fn().mockResolvedValue(publicUser);
    stubApi(post);
    (globalThis as any).useRoute = () => ({ query: {} });

    const LoginPage = (await import("../pages/login.vue")).default;
    const wrapper = mount(LoginPage as any, {
      global: { stubs: { NuxtLink: NuxtLinkStub } },
    });
    await flushPromises();

    const inputs = wrapper.findAll("input");
    await inputs[0]!.setValue("alice@example.com");
    await inputs[1]!.setValue("longenough123");
    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    expect(post).toHaveBeenCalledWith("/auth/login", {
      email: "alice@example.com",
      password: "longenough123",
    });
    expect((globalThis as any).navigateTo).toHaveBeenCalledWith("/app");
  });

  it("honours the ?redirect query on success", async () => {
    const post = vi.fn().mockResolvedValue(publicUser);
    stubApi(post);
    (globalThis as any).useRoute = () => ({ query: { redirect: "/app/projects" } });

    const LoginPage = (await import("../pages/login.vue")).default;
    const wrapper = mount(LoginPage as any, {
      global: { stubs: { NuxtLink: NuxtLinkStub } },
    });
    await flushPromises();

    const inputs = wrapper.findAll("input");
    await inputs[0]!.setValue("alice@example.com");
    await inputs[1]!.setValue("longenough123");
    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    expect((globalThis as any).navigateTo).toHaveBeenCalledWith("/app/projects");
  });

  it("shows the API error message and restores the button on bad credentials", async () => {
    const post = vi
      .fn()
      .mockRejectedValue(new ApiError("Invalid email or password", "INVALID_CREDENTIALS", 401));
    stubApi(post);
    (globalThis as any).useRoute = () => ({ query: {} });

    const LoginPage = (await import("../pages/login.vue")).default;
    const wrapper = mount(LoginPage as any, {
      global: { stubs: { NuxtLink: NuxtLinkStub } },
    });
    await flushPromises();

    const inputs = wrapper.findAll("input");
    await inputs[0]!.setValue("alice@example.com");
    await inputs[1]!.setValue("wrongpassword");
    await wrapper.find("form").trigger("submit.prevent");
    await flushPromises();

    const button = wrapper.find("button");
    expect(button.attributes("disabled")).toBeUndefined();
    expect(button.text()).toContain("Sign in");
    expect(wrapper.text()).toContain("Invalid email or password");
  });
});

describe("useApi — envelope and failure normalization", () => {
  it("forwards a request timeout so a hung backend cannot spin a form forever", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ data: publicUser });
    (globalThis as any).$fetch = fetchMock;

    await useApi().post("/auth/signup", publicUser, { timeout: 5 });

    const options = fetchMock.mock.calls[0]![1] as { timeout?: number };
    expect(typeof options.timeout).toBe("number");
    expect(options.timeout).toBe(5);
  });

  it("applies a default timeout to every request", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ data: publicUser });
    (globalThis as any).$fetch = fetchMock;

    await useApi().get("/auth/me");

    const options = fetchMock.mock.calls[0]![1] as { timeout?: number };
    expect(typeof options.timeout).toBe("number");
    expect(options.timeout).toBeGreaterThan(0);
  });

  it("treats a body with both data and error as a non-success payload", async () => {
    // The envelope is one-level: success is `data` without `error`. A body
    // carrying both must not be silently unwrapped as a success.
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ data: {}, error: { code: "INTERNAL_ERROR", message: "partial" } });
    (globalThis as any).$fetch = fetchMock;

    const result = await useApi().get<{ ok: boolean }>("/projects");
    expect((result as { error: { code: string } }).error.code).toBe("INTERNAL_ERROR");
  });

  it("normalizes a network failure without a status into an ApiError", async () => {
    const fetchError = Object.assign(new Error("Failed to fetch"), {});
    (globalThis as any).$fetch = vi.fn().mockRejectedValue(fetchError);

    await expect(useApi().post("/auth/login", { email: "a@b.com", password: "x" })).rejects.toMatchObject(
      { code: "INTERNAL_ERROR", status: 0 },
    );
  });
});

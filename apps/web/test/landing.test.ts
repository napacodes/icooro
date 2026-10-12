/**
 * F1 — Landing page tests.
 *
 * Covers the three things that must not regress:
 *   1. The typed content payload only points at destinations that exist
 *      (`/login`, `/signup`, `/app`, in-page anchors) and carries the
 *      required structure (headline, six workflow steps, four features).
 *   2. The composed page renders every section with the real destinations,
 *      the skip link, and no invented routes.
 *   3. `useTheme` resolves `system` against the OS preference, applies
 *      `data-theme` to the document root and persists explicit choices.
 *
 * Runs under Vitest + happy-dom in the same style as the other web suites:
 * Nuxt auto-imports are exposed on `globalThis`, `NuxtLink` is stubbed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { defineComponent, h, ref, computed, reactive, nextTick } from "vue";
import { landingContent } from "../landing/content";
import type { LandingIconKey } from "../landing/types";
import { useTheme, THEME_STORAGE_KEY, resolveTheme } from "../composables/useTheme";

// Expose Vue auto-imports to the SFCs under test.
(globalThis as any).ref = ref;
(globalThis as any).reactive = reactive;
(globalThis as any).computed = computed;
(globalThis as any).defineComponent = defineComponent;
(globalThis as any).h = h;
(globalThis as any).onMounted = (await import("vue")).onMounted;
(globalThis as any).onBeforeUnmount = (await import("vue")).onBeforeUnmount;
(globalThis as any).watch = (await import("vue")).watch;
(globalThis as any).readonly = (await import("vue")).readonly;
(globalThis as any).useId = (await import("vue")).useId;

const NuxtLinkStub = defineComponent({
  name: "NuxtLink",
  props: ["to"],
  setup(props, { slots }) {
    return () => h("a", { href: typeof props.to === "string" ? props.to : "#" }, slots.default?.());
  },
});

// `useState` must return the same ref per key within an app instance.
const stateMap = new Map<string, any>();
(globalThis as any).useState = <T>(key: string, init: () => T) => {
  if (!stateMap.has(key)) stateMap.set(key, ref(init()));
  return stateMap.get(key);
};
(globalThis as any).useSeoMeta = vi.fn();
(globalThis as any).definePageMeta = vi.fn();
(globalThis as any).useRoute = () => ({ query: {}, path: "/" });
(globalThis as any).navigateTo = vi.fn();
(globalThis as any).useRuntimeConfig = () => ({ public: { apiBase: "http://api.test" } });

/** Destinations the landing page is allowed to link to today. */
const ALLOWED_ROUTES = ["/login", "/signup", "/app"];

/**
 * Every link the page emits, read from the DOM. The NuxtLink stub renders a
 * real `<a href>`, so both `to` and in-page `href` targets land here.
 */
function renderedHrefs(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll("a").map((a) => a.attributes("href") ?? "");
}

beforeEach(() => {
  stateMap.clear();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  vi.clearAllMocks();
});

afterEach(() => {
  restoreMatchMedia();
});

// ---------------------------------------------------------------------------
// matchMedia control (used by the theme tests)
// ---------------------------------------------------------------------------

const originalMatchMedia = window.matchMedia;
let matchMediaResult = false;

function stubMatchMedia(prefersDark: boolean) {
  matchMediaResult = prefersDark;
  (window as any).matchMedia = (query: string) => ({
    matches: query.includes("prefers-color-scheme: dark") ? matchMediaResult : false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
}

function restoreMatchMedia() {
  (window as any).matchMedia = originalMatchMedia;
}

function mountThemeHost() {
  let api!: ReturnType<typeof useTheme>;
  const Host = defineComponent({
    setup() {
      api = useTheme();
      return () => h("div");
    },
  });
  const wrapper = mount(Host);
  return { wrapper, api };
}

// ---------------------------------------------------------------------------
// 1. Content payload
// ---------------------------------------------------------------------------

describe("landing content — structure and destinations", () => {
  it("keeps the required hero headline", () => {
    expect(landingContent.hero.headline).toBe("From idea to production-ready video.");
    expect(landingContent.hero.supporting.length).toBeGreaterThan(20);
  });

  it("lists the six workflow stages in order", () => {
    expect(landingContent.workflow.steps.map((s) => s.label)).toEqual([
      "Story",
      "Script",
      "Scenes",
      "Shots",
      "Generation",
      "Tracking",
    ]);
  });

  it("ships the four required feature cards", () => {
    expect(landingContent.features.items.map((f) => f.title)).toEqual([
      "Structured planning",
      "AI-powered generation",
      "Execution tracking",
      "Project management",
    ]);
  });

  it("only links to routes that exist today", () => {
    const links: string[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (value && typeof value === "object") {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          if ((key === "to" || key === "href") && typeof child === "string") links.push(child);
          else visit(child);
        }
      }
    };
    visit(landingContent);

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      if (link.startsWith("#")) {
        expect(link.length).toBeGreaterThan(1);
        continue;
      }
      expect(ALLOWED_ROUTES).toContain(link);
    }
    // No invented marketing pages.
    expect(links.some((l) => /pricing|contact|docs|blog|customers/i.test(l))).toBe(false);
  });

  it("uses icon keys the icon set actually implements", async () => {
    const LandingIcon = (await import("../components/landing/LandingIcon.vue")).default;
    const used: LandingIconKey[] = [
      ...landingContent.workflow.steps.map((s) => s.icon),
      ...landingContent.features.items.map((f) => f.icon),
    ];
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
      const wrapper = mount(LandingIcon, { props: { name } });
      expect(wrapper.findAll("path").length, `icon "${name}" should draw paths`).toBeGreaterThan(0);
    }
  });

  it("flags the product preview and showcase as illustrative", () => {
    expect(landingContent.hero.preview.note.toLowerCase()).toContain("illustrative");
    expect(landingContent.showcase.note.toLowerCase()).toContain("illustrative");
  });
});

// ---------------------------------------------------------------------------
// 2. Composed page
// ---------------------------------------------------------------------------

describe("landing page — rendered sections and destinations", () => {
  async function mountPage() {
    const IndexPage = (await import("../pages/index.vue")).default;
    const wrapper = mount(IndexPage as any, {
      global: { stubs: { NuxtLink: NuxtLinkStub } },
    });
    await flushPromises();
    return wrapper;
  }

  it("renders outside the default public layout (it owns its header/footer)", async () => {
    await mountPage();
    const meta = (globalThis as any).definePageMeta.mock.calls.at(-1)?.[0];
    expect(meta?.layout).toBe(false);
  });

  it("sets SEO metadata from the content payload", async () => {
    await mountPage();
    const arg = (globalThis as any).useSeoMeta.mock.calls.at(-1)?.[0];
    expect(arg?.title).toBe(landingContent.seo.title);
    expect(arg?.description).toBe(landingContent.seo.description);
  });

  it("renders the headline, supporting copy and both account CTAs", async () => {
    const wrapper = await mountPage();
    expect(wrapper.text()).toContain("From idea to production-ready video.");
    expect(wrapper.text()).toContain(landingContent.hero.supporting);

    const hrefs = renderedHrefs(wrapper);
    expect(hrefs).toContain("/signup");
    expect(hrefs).toContain("/login");
  });

  it("renders the six workflow steps in order", async () => {
    const wrapper = await mountPage();
    const steps = wrapper.findAll(".step h3").map((el) => el.text());
    expect(steps).toEqual(["Story", "Script", "Scenes", "Shots", "Generation", "Tracking"]);
  });

  it("renders the four feature cards", async () => {
    const wrapper = await mountPage();
    const cards = wrapper.findAll(".card h3").map((el) => el.text());
    expect(cards).toEqual([
      "Structured planning",
      "AI-powered generation",
      "Execution tracking",
      "Project management",
    ]);
  });

  it("renders header navigation anchors and a theme control", async () => {
    const wrapper = await mountPage();
    const nav = wrapper.find('nav[aria-label="Primary"]');
    expect(nav.exists()).toBe(true);
    const hrefs = nav.findAll("a").map((a) => a.attributes("href"));
    expect(hrefs).toEqual(["#workflow", "#features", "#showcase"]);

    const toggle = wrapper.find('button[aria-pressed]');
    expect(toggle.exists()).toBe(true);
    expect(toggle.attributes("aria-label")).toMatch(/Switch colour theme/);
  });

  it("exposes semantic landmarks, a skip link and the product-preview note", async () => {
    const wrapper = await mountPage();
    expect(wrapper.find("header.site-header").exists()).toBe(true);
    expect(wrapper.find("main#main-content").exists()).toBe(true);
    expect(wrapper.find("footer.site-footer").exists()).toBe(true);
    expect(wrapper.find("a.skip-link").attributes("href")).toBe("#main-content");
    expect(wrapper.text()).toContain("Product preview — illustrative content, not live project data.");
  });

  it("only emits link destinations that exist", async () => {
    const wrapper = await mountPage();
    const hrefs = renderedHrefs(wrapper);
    expect(hrefs.length).toBeGreaterThan(5);
    for (const href of hrefs) {
      if (href.startsWith("#")) {
        expect(href.length).toBeGreaterThan(1);
      } else {
        expect(ALLOWED_ROUTES).toContain(href);
      }
    }
  });

  it("renders the footer account links, including /app", async () => {
    const wrapper = await mountPage();
    expect(renderedHrefs(wrapper)).toContain("/app");
    expect(wrapper.text()).toContain("©");
  });
});

// ---------------------------------------------------------------------------
// 3. Theme
// ---------------------------------------------------------------------------

describe("useTheme — light/dark preference", () => {
  it("defaults to `system` and resolves the OS preference", async () => {
    stubMatchMedia(true);
    const { api } = mountThemeHost();
    await nextTick();

    expect(api.mode.value).toBe("system");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(api.resolved.value).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("applies the light theme when the OS does not ask for dark", async () => {
    stubMatchMedia(false);
    const { api } = mountThemeHost();
    await nextTick();

    expect(api.resolved.value).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("toggling pins an explicit choice, applies it and persists it", async () => {
    stubMatchMedia(false);
    const { api } = mountThemeHost();
    await nextTick();

    api.toggle();
    await nextTick();
    expect(api.mode.value).toBe("dark");
    expect(api.resolved.value).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    api.toggle();
    await nextTick();
    expect(api.mode.value).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("restores the persisted mode on mount", async () => {
    stubMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, "dark");

    const { api } = mountThemeHost();
    await nextTick();

    expect(api.mode.value).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("ignores an invalid stored value and falls back to `system`", async () => {
    stubMatchMedia(true);
    localStorage.setItem(THEME_STORAGE_KEY, "banana");

    const { api } = mountThemeHost();
    await nextTick();

    expect(api.mode.value).toBe("system");
    expect(api.resolved.value).toBe("dark");
  });

  it("the theme toggle flips the resolved theme", async () => {
    stubMatchMedia(false);
    const ThemeToggle = (await import("../components/landing/ThemeToggle.vue")).default;
    const wrapper = mount(ThemeToggle, { props: { label: "Switch colour theme" } });
    await nextTick();

    expect(wrapper.attributes("aria-label")).toContain("Light theme active");
    await wrapper.find("button").trigger("click");
    await nextTick();

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(wrapper.attributes("aria-label")).toContain("Dark theme active");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });
});

/**
 * Landing page content model (F1).
 *
 * Every editable string, link and visual accent on the public landing page
 * lives behind these types in `./content.ts`, never inside the presentation
 * components. That is the CMS seam for a later phase: swapping the local
 * constant for a CMS-backed payload should not require touching a component.
 *
 * Presentation-only concerns (icon rendering, layout, CSS) stay in the
 * components; `LandingIconKey` is the single bridge between content and the
 * local icon set.
 */

/** Simple link with a label and an internal route. */
export interface LandingLink {
  label: string;
  to: string;
}

/** An in-page navigation item (hash anchor within the landing page). */
export interface LandingAnchor {
  label: string;
  href: string;
}

/** Icon keys understood by `LandingIcon.vue`. Content may only use these. */
export type LandingIconKey =
  | "story"
  | "script"
  | "scenes"
  | "shots"
  | "generation"
  | "tracking"
  | "planning"
  | "ai"
  | "execution"
  | "projects";

export interface LandingSeo {
  title: string;
  description: string;
}

export interface LandingBrand {
  /** Wordmark text rendered in the header and footer. */
  name: string;
}

export interface LandingHeaderContent {
  nav: LandingAnchor[];
  signIn: LandingLink;
  signUp: LandingLink;
  /** Accessible label for the theme switch. */
  themeToggleLabel: string;
}

export interface ProductPreviewStage {
  label: string;
  state: "done" | "active" | "pending";
}

export interface ProductPreviewRow {
  label: string;
  status: string;
  tone: "success" | "pending";
}

export interface LandingProductPreviewContent {
  /** Window title shown in the preview chrome. */
  title: string;
  stagesLabel: string;
  stages: ProductPreviewStage[];
  listLabel: string;
  rows: ProductPreviewRow[];
  /** Caption making clear the preview is illustrative, not live data. */
  note: string;
}

export interface LandingHeroContent {
  eyebrow: string;
  headline: string;
  supporting: string;
  primaryCta: LandingLink;
  secondaryCta: LandingLink;
  preview: LandingProductPreviewContent;
}

export interface LandingWorkflowStep {
  id: string;
  label: string;
  description: string;
  icon: LandingIconKey;
}

export interface LandingWorkflowContent {
  eyebrow: string;
  title: string;
  description: string;
  steps: LandingWorkflowStep[];
}

export interface LandingFeature {
  id: string;
  title: string;
  description: string;
  icon: LandingIconKey;
}

export interface LandingFeaturesContent {
  eyebrow: string;
  title: string;
  description: string;
  items: LandingFeature[];
}

export interface LandingShowcaseItem {
  id: string;
  title: string;
  caption: string;
  /** Decorative gradient pair used by the illustrative artwork. */
  accent: string;
  accentSoft: string;
}

export interface LandingShowcaseContent {
  eyebrow: string;
  title: string;
  description: string;
  items: LandingShowcaseItem[];
  /** Disclaimer shown under the artwork. */
  note: string;
}

export interface LandingClosingCtaContent {
  title: string;
  description: string;
  primaryCta: LandingLink;
  secondaryCta: LandingLink;
}

export interface LandingFooterColumn {
  title: string;
  links: (LandingLink | LandingAnchor)[];
}

export interface LandingFooterContent {
  tagline: string;
  columns: LandingFooterColumn[];
}

/** The whole landing page payload. This is the shape a CMS would return. */
export interface LandingContent {
  seo: LandingSeo;
  brand: LandingBrand;
  header: LandingHeaderContent;
  hero: LandingHeroContent;
  workflow: LandingWorkflowContent;
  features: LandingFeaturesContent;
  showcase: LandingShowcaseContent;
  closingCta: LandingClosingCtaContent;
  footer: LandingFooterContent;
}

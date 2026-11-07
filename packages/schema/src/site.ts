import { z } from 'zod';

export const TEMPLATE_IDS = ['tpl-gioi-thieu', 'tpl-thu-lead', 'tpl-ban-hang'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const SECTION_TYPES = [
  'about', 'products', 'certs', 'gallery', 'map', 'contact', 'offer',
  'benefits', 'lead_form', 'testimonials', 'faq', 'countdown', 'order_zalo',
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

// Per-type fields are template-specific; keep extra keys (passthrough).
export const SectionSchema = z.object({ type: z.enum(SECTION_TYPES) }).passthrough();

export const SiteSchema = z.object({
  schemaVersion: z.literal(1),
  template: z.enum(TEMPLATE_IDS),
  siteId: z.string().min(1),
  brand: z.object({
    name: z.string(),
    logo: z.string().optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    slogan: z.string().optional(),
  }),
  contact: z.object({
    phone: z.string(),
    zalo: z.string().optional(),
    email: z.string().optional(),
    address: z.string().optional(),
    mapEmbed: z.string().optional(),
  }),
  seo: z.object({ title: z.string(), description: z.string() }),
  hero: z.object({
    title: z.string(),
    subtitle: z.string(),
    image: z.string().optional(),
    cta: z.string(),
  }),
  sections: z.array(SectionSchema),
  demo: z.object({
    badge: z.boolean(),
    expires: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    checkoutUrl: z.string(),
  }),
});
export type SiteJson = z.infer<typeof SiteSchema>;

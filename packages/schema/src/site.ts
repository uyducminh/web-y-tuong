import { z } from 'zod';

export const TEMPLATE_IDS = ['tpl-gioi-thieu', 'tpl-thu-lead', 'tpl-ban-hang'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

export const SECTION_TYPES = [
  'about', 'products', 'certs', 'gallery', 'map', 'contact', 'offer',
  'benefits', 'lead_form', 'testimonials', 'faq', 'countdown', 'order_zalo',
] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

// Per-type section shapes: exactly the fields templates/_shared/render.js reads (strict: an unknown key fails validation, so a wrong field-name guess is retried instead of rendering empty).
// These flow into the AI tool's JSON schema, so the field names here are the contract with the model.
const title = z.string().describe('Tiêu đề mục');
const img = z.string().describe('Đường dẫn ảnh đã tải lên (assets/...); không dùng URL ảnh bên ngoài');

export const SectionSchemas = {
  about: z.object({ type: z.literal('about'), title, body: z.string(), image: img.optional() }).strict(),
  products: z.object({ type: z.literal('products'), title, items: z.array(z.object({
    name: z.string(), desc: z.string().optional(),
    price: z.number().describe('Giá VND (số nguyên, 0 = không hiện giá)').optional(), image: img.optional(),
  }).strict()) }).strict(),
  certs: z.object({ type: z.literal('certs'), title, items: z.array(z.object({ name: z.string(), image: img.optional() }).strict()) }).strict(),
  gallery: z.object({ type: z.literal('gallery'), title, images: z.array(img) }).strict(),
  map: z.object({ type: z.literal('map'), title }).strict(),
  contact: z.object({ type: z.literal('contact'), title }).strict(),
  offer: z.object({ type: z.literal('offer'), title, body: z.string() }).strict(),
  benefits: z.object({ type: z.literal('benefits'), title, items: z.array(z.object({ title: z.string(), desc: z.string().optional() }).strict()) }).strict(),
  lead_form: z.object({ type: z.literal('lead_form'), title, button: z.string().optional() }).strict(),
  testimonials: z.object({ type: z.literal('testimonials'), title, items: z.array(z.object({ text: z.string(), name: z.string().optional() }).strict()) }).strict(),
  faq: z.object({ type: z.literal('faq'), title, items: z.array(z.object({ q: z.string(), a: z.string() }).strict()) }).strict(),
  countdown: z.object({ type: z.literal('countdown'), title, endsAt: z.string().describe('Thời điểm kết thúc ISO 8601, ví dụ 2026-12-31T23:59:00+07:00') }).strict(),
  order_zalo: z.object({ type: z.literal('order_zalo'), title, button: z.string().optional() }).strict(),
} satisfies { [K in SectionType]: z.ZodObject<{ type: z.ZodLiteral<K> } & z.ZodRawShape> };

const S = SectionSchemas;
export const SectionSchema = z.discriminatedUnion('type', [
  S.about, S.products, S.certs, S.gallery, S.map, S.contact, S.offer,
  S.benefits, S.lead_form, S.testimonials, S.faq, S.countdown, S.order_zalo,
]);
export type Section = z.infer<typeof SectionSchema>;

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

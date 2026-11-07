// @vitest-environment jsdom
// Contract between @sme/schema's per-type section schemas (what the AI is told), defaultSite (the skeleton the AI fills)
// and _shared/render.js (what is actually displayed): every field must be read by the renderer.
import { describe, it, expect, beforeEach } from 'vitest';
import { defaultSite, SECTION_TYPES, SectionSchemas, TEMPLATE_IDS, type SectionType } from '@sme/schema';
// @ts-ignore plain JS module
import { renderSite } from '../_shared/render.js';

const brief: any = { ten_don_vi: 'HTX Test', san_pham_chinh: 'Cà phê', diem_manh: 'Ngon', muc_tieu_web: 'Bán',
  lien_he: { phone: '0912345678', zalo: '0912345678', address: 'Đà Lạt' } };
let root: HTMLElement;
beforeEach(() => { document.body.innerHTML = '<div id="r"></div>'; root = document.getElementById('r')!; });

// Introspect zod schemas by _def.typeName (templates does not depend on zod directly).
type Zt = { _def: any; shape?: any; element?: any; value?: any };
const kind = (t: Zt): string => t._def.typeName;
const unwrap = (t: Zt): Zt => (['ZodOptional', 'ZodNullable', 'ZodDefault'].includes(kind(t)) ? unwrap(t._def.innerType) : t);

/** All field paths of a schema object ("items[].name"), and a sample value with every field filled. */
function sample(shape: Record<string, Zt>, prefix = ''): { paths: string[]; value: Record<string, unknown> } {
  const paths: string[] = []; const value: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(shape)) {
    const t = unwrap(raw);
    if (k === 'type') { value[k] = t._def.value; continue; }
    paths.push(prefix + k);
    if (kind(t) === 'ZodArray') {
      const el = unwrap(t._def.type);
      if (kind(el) === 'ZodObject') {
        const inner = sample(el._def.shape(), `${prefix}${k}[].`);
        paths.push(...inner.paths); value[k] = [inner.value];
      } else value[k] = ['https://img.example/a.jpg'];
    } else if (kind(t) === 'ZodNumber') value[k] = 150000;
    else if (k === 'endsAt') value[k] = '2099-01-01T00:00:00Z';
    else if (k === 'image') value[k] = 'https://img.example/a.jpg';
    else value[k] = `giá trị ${k}`;
  }
  return { paths, value };
}

/** Paths of the keys present in a plain object ("items[].name"). */
function keysOf(o: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (k === 'type') continue;
    out.push(prefix + k);
    if (Array.isArray(v)) for (const x of v) if (x && typeof x === 'object') out.push(...keysOf(x as any, `${prefix}${k}[].`));
  }
  return [...new Set(out)];
}

/** Renders one section through a Proxy and returns the field paths the renderer read. */
function readPaths(type: SectionType, data: Record<string, unknown>): Set<string> {
  const read = new Set<string>();
  const track = (o: Record<string, unknown>, prefix: string): any => new Proxy(o, {
    get(t, k) {
      const v = (t as any)[k];
      if (typeof k !== 'string') return v;
      read.add(prefix + k);
      if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? track(x, `${prefix}${k}[].`) : x));
      return v;
    },
  });
  const site: any = defaultSite(type === 'order_zalo' ? 'tpl-ban-hang' : 'tpl-gioi-thieu', brief, 's', new Date('2026-11-08'));
  site.sections = [track(data, '')];
  renderSite(site, root);
  return read;
}

describe('section contract: schema ⇄ defaultSite ⇄ renderer', () => {
  for (const type of SECTION_TYPES) {
    it(`${type}: every schema field is read by the renderer`, () => {
      const { paths, value } = sample(SectionSchemas[type].shape as any);
      expect(SectionSchemas[type].safeParse(value).success).toBe(true);
      const read = readPaths(type, value);
      expect(paths.filter((p) => !read.has(p))).toEqual([]);
      expect(root.querySelector(`.sec-${type}`)).not.toBeNull();
    });
  }

  it('every key defaultSite emits per section type is in the schema (and so read by the renderer)', () => {
    for (const t of TEMPLATE_IDS) {
      for (const sec of defaultSite(t, brief, 's', new Date('2026-11-08')).sections) {
        const schemaPaths = new Set(sample(SectionSchemas[sec.type].shape as any).paths);
        expect(keysOf(sec as any).filter((p) => !schemaPaths.has(p)), `${t}/${sec.type}`).toEqual([]);
        expect(SectionSchemas[sec.type].safeParse(sec).success, `${t}/${sec.type}`).toBe(true);
      }
    }
  });
});

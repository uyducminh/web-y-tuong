// Shared safe renderer for SME templates. Plain browser ESM, no dependencies, no build.
// SECURITY: all customer data goes through textContent / setAttribute (never innerHTML).

/** @typedef {{leadEndpoint?: string, platformName?: string}} RenderOpts */

const SAFE_SCHEMES = ['http:', 'https:', 'tel:', 'mailto:'];

/** Returns the url if safe (http/https/tel/mailto or relative), else null. */
export function safeUrl(u) {
  if (typeof u !== 'string') return null;
  const t = u.trim();
  if (!t) return null;
  const probe = t.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
  if (probe.startsWith('//')) return null;
  const m = /^([a-z][a-z0-9+.-]*:)/.exec(probe);
  if (m) return SAFE_SCHEMES.includes(m[1]) ? t : null;
  return t;
}

/** Same output as formatVnd in @sme/schema. */
export function formatVnd(n) {
  return Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.') + 'đ';
}

function el(tag, props, ...children) {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = String(v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c) e.append(c);
  return e;
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

function img(src, alt, cls) {
  const url = safeUrl(src);
  if (!url) return null;
  const i = el('img', { src: url, alt: str(alt), loading: 'lazy', class: cls });
  i.addEventListener('error', () => { i.hidden = true; });
  return i;
}

function wrap(type, title, ...children) {
  const kids = children.filter(Boolean);
  if (!kids.length) return null;
  const s = el('section', { class: `sec sec-${type}` });
  if (str(title)) s.append(el('h2', { text: title }));
  s.append(...kids);
  return s;
}

function productItems(data) {
  return arr(data.items).filter((p) => str(p.name).trim());
}

function orderText(site, lines) {
  const out = [`Xin chào ${site.brand.name}, tôi muốn đặt hàng:`];
  out.push(...lines);
  return out.join('\n');
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall through */ }
  try {
    const ta = el('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text; document.body.append(ta); ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    ta.remove(); return !!ok;
  } catch { return false; }
}

function leadEndpointDefault() {
  return (typeof globalThis !== 'undefined' && globalThis.SME_LEAD_ENDPOINT) || '';
}

export const sections = {
  about(d) {
    const body = str(d.body).trim();
    return wrap('about', d.title, body && el('p', { class: 'lead', text: body }), img(d.image, d.title, 'about-img'));
  },

  products(d) {
    const items = productItems(d);
    if (!items.length) return null;
    const grid = el('div', { class: 'grid' });
    for (const p of items) {
      const card = el('article', { class: 'card product' });
      const im = img(p.image, p.name, 'card-img');
      if (im) card.append(im);
      card.append(el('h3', { text: p.name }));
      if (str(p.desc)) card.append(el('p', { text: p.desc }));
      if (Number(p.price) > 0) card.append(el('p', { class: 'price', text: formatVnd(p.price) }));
      grid.append(card);
    }
    return wrap('products', d.title, grid);
  },

  certs(d) {
    const items = arr(d.items).filter((c) => str(c.name).trim());
    if (!items.length) return null;
    const ul = el('ul', { class: 'chips' });
    for (const c of items) {
      const li = el('li', { class: 'chip' });
      const im = img(c.image, c.name, 'chip-img');
      if (im) li.append(im);
      li.append(el('span', { text: c.name }));
      ul.append(li);
    }
    return wrap('certs', d.title, ul);
  },

  gallery(d) {
    const imgs = (Array.isArray(d.images) ? d.images : []).map((s) => img(typeof s === 'string' ? s : s && s.src, '', 'gallery-img')).filter(Boolean);
    if (!imgs.length) return null;
    return wrap('gallery', d.title, el('div', { class: 'gallery' }, ...imgs));
  },

  map(d, site) {
    const embed = safeUrl(site.contact.mapEmbed);
    const addr = str(site.contact.address).trim();
    let frame = null;
    if (embed && /^https:/i.test(embed)) {
      frame = el('iframe', { src: embed, title: 'Bản đồ', loading: 'lazy', referrerpolicy: 'no-referrer', class: 'map-frame', allowfullscreen: true });
    }
    const addrP = addr ? el('p', { class: 'addr', text: addr }) : null;
    return wrap('map', d.title, frame, addrP);
  },

  contact(d, site) {
    const c = site.contact;
    const list = el('ul', { class: 'contact-list' });
    const add = (label, text, href) => {
      if (!str(text).trim()) return;
      const li = el('li', null, el('strong', { text: label + ': ' }));
      const safe = href && safeUrl(href);
      li.append(safe ? el('a', { href: safe, text }) : document.createTextNode(text));
      list.append(li);
    };
    add('Điện thoại', c.phone, c.phone && `tel:${str(c.phone).replace(/\s/g, '')}`);
    add('Zalo', c.zalo, c.zalo && `https://zalo.me/${encodeURIComponent(str(c.zalo))}`);
    add('Email', c.email, c.email && `mailto:${c.email}`);
    add('Địa chỉ', c.address);
    return list.children.length ? wrap('contact', d.title, list) : null;
  },

  offer(d) {
    const body = str(d.body).trim();
    return wrap('offer', d.title, body && el('p', { class: 'lead', text: body }));
  },

  benefits(d) {
    const items = arr(d.items).filter((b) => str(b.title).trim() || str(b.desc).trim());
    if (!items.length) return null;
    const grid = el('div', { class: 'grid' });
    for (const b of items) {
      const card = el('article', { class: 'card' });
      if (str(b.title)) card.append(el('h3', { text: b.title }));
      if (str(b.desc)) card.append(el('p', { text: b.desc }));
      grid.append(card);
    }
    return wrap('benefits', d.title, grid);
  },

  lead_form(d, site, opts) {
    const endpoint = (opts && opts.leadEndpoint) || leadEndpointDefault();
    const form = el('form', { 'data-lead': true, class: 'lead-form' });
    const field = (label, name, type, required) => el('label', null, document.createTextNode(label),
      el('input', { name, type, required, autocomplete: name === 'name' ? 'name' : name === 'phone' ? 'tel' : 'off' }));
    form.append(field('Họ và tên', 'name', 'text', true), field('Số điện thoại', 'phone', 'tel', true));
    form.append(el('label', null, document.createTextNode('Ghi chú'), el('textarea', { name: 'note', rows: 3 })));
    // honeypot: hidden from humans, bots fill it
    const hp = el('div', { class: 'hp', 'aria-hidden': 'true' },
      el('input', { name: 'website', type: 'text', tabindex: '-1', autocomplete: 'off' }));
    form.append(hp);
    const btn = el('button', { type: 'submit', class: 'btn', text: str(d.button) || 'Gửi thông tin' });
    const msg = el('p', { class: 'form-msg', role: 'status' });
    form.append(btn, msg);
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const v = (n) => form.querySelector(`[name=${n}]`).value;
      const payload = { name: v('name').trim(), phone: v('phone').trim(), note: v('note').trim(), website: v('website') };
      btn.disabled = true; msg.textContent = '';
      try {
        const res = await fetch(`${endpoint}/lead/${encodeURIComponent(site.siteId)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(String(res.status));
        form.reset();
        msg.textContent = 'Đã gửi, chúng tôi sẽ liên hệ sớm';
        msg.className = 'form-msg ok';
      } catch {
        msg.textContent = 'Chưa gửi được, vui lòng thử lại hoặc gọi điện cho chúng tôi.';
        msg.className = 'form-msg err';
        btn.disabled = false;
      }
    });
    return wrap('lead_form', d.title, form);
  },

  testimonials(d) {
    const items = arr(d.items).filter((t) => str(t.text).trim());
    if (!items.length) return null;
    const grid = el('div', { class: 'grid' });
    for (const t of items) {
      const q = el('blockquote', { class: 'card' }, el('p', { text: t.text }));
      if (str(t.name)) q.append(el('footer', { text: `— ${t.name}` }));
      grid.append(q);
    }
    return wrap('testimonials', d.title, grid);
  },

  faq(d) {
    const items = arr(d.items).filter((f) => str(f.q).trim() && str(f.a).trim());
    if (!items.length) return null;
    const box = el('div', { class: 'faq' });
    for (const f of items) box.append(el('details', null, el('summary', { text: f.q }), el('p', { text: f.a })));
    return wrap('faq', d.title, box);
  },

  countdown(d) {
    const end = Date.parse(str(d.endsAt));
    if (!Number.isFinite(end)) return null;
    const out = el('div', { class: 'cd', role: 'timer' });
    const tick = () => {
      const ms = end - Date.now();
      if (ms <= 0) { out.textContent = 'Ưu đãi đã kết thúc'; return false; }
      const s = Math.floor(ms / 1000);
      const dd = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
      out.textContent = `${dd} ngày ${hh} giờ ${mm} phút ${ss} giây`;
      return true;
    };
    if (tick()) {
      const id = setInterval(() => { if (!out.isConnected || !tick()) clearInterval(id); }, 1000);
    }
    return wrap('countdown', d.title, out);
  },

  order_zalo(d, site) {
    const zalo = str(site.contact.zalo || site.contact.phone).replace(/[^\d]/g, '');
    if (!zalo) return null;
    const products = [];
    for (const s of Array.isArray(site.sections) ? site.sections : []) {
      if (s && s.type === 'products') products.push(...productItems(s));
    }
    const box = el('div', { class: 'order' });
    const qtys = [];
    if (products.length) {
      const list = el('ul', { class: 'order-list' });
      for (const p of products) {
        const q = el('input', { type: 'number', min: 0, max: 999, value: 0, 'aria-label': `Số lượng ${p.name}` });
        qtys.push([p, q]);
        list.append(el('li', null, el('span', { text: Number(p.price) > 0 ? `${p.name} (${formatVnd(p.price)})` : p.name }), q));
      }
      box.append(list);
    }
    const note = el('textarea', { rows: 2, placeholder: 'Ghi chú (địa chỉ nhận hàng, ...)' });
    const status = el('p', { class: 'form-msg', role: 'status' });
    const buy = el('button', { type: 'button', class: 'btn', text: str(d.button) || 'Đặt qua Zalo' });
    const copy = el('button', { type: 'button', class: 'btn btn-ghost', text: 'Sao chép đơn hàng' });
    const build = () => {
      const lines = [];
      for (const [p, q] of qtys) { const n = parseInt(q.value, 10); if (n > 0) lines.push(`- ${p.name} x ${n}`); }
      if (!lines.length && products.length) lines.push(...products.map((p) => `- ${p.name} x 1`));
      if (note.value.trim()) lines.push(`Ghi chú: ${note.value.trim()}`);
      return orderText(site, lines);
    };
    buy.addEventListener('click', async () => {
      const ok = await copyText(build());
      status.textContent = ok ? 'Đã sao chép đơn hàng, hãy dán vào Zalo.' : '';
      window.open(`https://zalo.me/${zalo}`, '_blank', 'noopener');
    });
    copy.addEventListener('click', async () => {
      status.textContent = (await copyText(build())) ? 'Đã sao chép đơn hàng.' : 'Không sao chép được.';
    });
    box.append(note, el('div', { class: 'btn-row' }, buy, copy), status);
    return wrap('order_zalo', d.title, box);
  },
};

function setMeta(doc, attr, key, content) {
  let m = doc.head.querySelector(`meta[${attr}="${key}"]`);
  if (!m) { m = doc.createElement('meta'); m.setAttribute(attr, key); doc.head.append(m); }
  m.setAttribute('content', content);
}

function applySeo(doc, site) {
  const title = str(site.seo && site.seo.title) || str(site.brand.name);
  const desc = str(site.seo && site.seo.description);
  doc.title = title;
  setMeta(doc, 'name', 'description', desc);
  setMeta(doc, 'property', 'og:title', title);
  setMeta(doc, 'property', 'og:description', desc);
  setMeta(doc, 'property', 'og:type', 'website');
  const image = safeUrl(site.hero && site.hero.image);
  if (image) setMeta(doc, 'property', 'og:image', image);
}

function renderHero(site) {
  const h = site.hero || {};
  const hero = el('header', { class: 'hero' });
  const inner = el('div', { class: 'hero-inner' });
  const logo = img(site.brand.logo, site.brand.name, 'logo');
  if (logo) inner.append(logo);
  inner.append(el('p', { class: 'brand', text: site.brand.name }));
  inner.append(el('h1', { text: h.title }));
  if (str(h.subtitle)) inner.append(el('p', { class: 'subtitle', text: h.subtitle }));
  if (str(site.brand.slogan)) inner.append(el('p', { class: 'slogan', text: site.brand.slogan }));
  if (str(h.cta)) {
    const first = (site.sections || []).find((s) => s && sections[s.type] && s.type !== 'countdown');
    inner.append(el('a', { class: 'btn', href: first ? `#sec-${first.type}` : '#', text: h.cta }));
  }
  hero.append(inner);
  const bg = img(h.image, h.title, 'hero-img');
  if (bg) hero.append(bg);
  return hero;
}

function renderBadge(site, opts) {
  const platform = (opts && opts.platformName) || 'SME Builder';
  const b = el('div', { class: 'demo-badge', role: 'note' }, el('span', { text: `Bản dùng thử – tạo bởi ${platform}` }));
  const url = safeUrl(site.demo && site.demo.checkoutUrl);
  if (url) b.append(el('a', { class: 'btn btn-sm', href: url, text: 'Triển khai chính thức' }));
  return b;
}

/**
 * Render a validated-or-not site.json into root. Never throws on bad section data.
 * @param {any} site @param {HTMLElement} root @param {RenderOpts} [opts]
 */
export function renderSite(site, root, opts = {}) {
  const doc = root.ownerDocument;
  site = site && typeof site === 'object' ? site : {};
  site.brand = site.brand && typeof site.brand === 'object' ? site.brand : { name: '' };
  site.contact = site.contact && typeof site.contact === 'object' ? site.contact : {};
  const o = { leadEndpoint: leadEndpointDefault(), ...opts };

  if (/^#[0-9A-Fa-f]{6}$/.test(str(site.brand.color))) {
    doc.documentElement.style.setProperty('--brand', site.brand.color);
  }
  applySeo(doc, site);

  root.replaceChildren();
  if (site.demo && site.demo.badge) root.append(renderBadge(site, o));
  root.append(renderHero(site));
  const main = el('main');
  for (const data of Array.isArray(site.sections) ? site.sections : []) {
    if (!data || typeof data !== 'object') continue;
    const fn = Object.prototype.hasOwnProperty.call(sections, data.type) ? sections[data.type] : null;
    if (!fn) continue;
    try {
      const node = fn(data, site, o);
      if (node) { node.id = `sec-${data.type}`; main.append(node); }
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('section failed', data.type, e);
    }
  }
  root.append(main);
  root.append(el('footer', { class: 'foot' }, el('p', { text: `© ${site.brand.name}` })));
}

/** Fetch site.json next to the page and render it. */
export async function boot(root = document.body) {
  try {
    const res = await fetch('site.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(String(res.status));
    const meta = document.querySelector('meta[name=lead-endpoint]');
    const leadEndpoint = (meta && meta.getAttribute('content')) || undefined;
    renderSite(await res.json(), root, leadEndpoint ? { leadEndpoint } : {});
  } catch (e) {
    root.replaceChildren(el('p', { class: 'boot-error', text: 'Không tải được nội dung trang. Vui lòng thử lại sau.' }));
  }
}

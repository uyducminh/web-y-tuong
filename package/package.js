// Trang "Bộ hồ sơ dùng thử" (/package/:siteId), do Worker phục vụ cùng tên miền với /d/:siteId.
// AN TOÀN: mọi dữ liệu hiển thị bằng textContent / setAttribute — không bao giờ dùng HTML thô.
// html2canvas và docx chỉ được tải khi cần (lúc bắt đầu chụp ảnh / khi bấm "Tải Word").

// SRI = sha384 của đúng file npm (html2canvas@1.4.1 dist/html2canvas.min.js, docx@9.15.3 dist/index.iife.js);
// scripts/sri.test.ts tính lại từ node_modules. Đổi phiên bản thì đổi cả URL, mã SRI và CSP trong routes/package.ts.
const HTML2CANVAS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
const HTML2CANVAS_SRI = 'sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H';
const DOCX_URL = 'https://cdn.jsdelivr.net/npm/docx@9.15.3/dist/index.iife.js';
const DOCX_SRI = 'sha384-7RQr7shIQxpY5MCxz+1WEr7c87/32cetAdWsetOYnb6IYz/H/6OcuJGOiv+L3nCj';
const WATERMARK = 'BẢN DÙNG THỬ';
const SVG_NS = 'http://www.w3.org/2000/svg';

const app = document.getElementById('app');
const stage = document.getElementById('capture-stage');
const siteId = (/^([a-z0-9-]{1,64})$/.exec(new URLSearchParams(location.search).get('site') || '') || [])[1] || '';
const platform = (document.querySelector('meta[name="platform-name"]')?.getAttribute('content') || '').trim() || 'Web Làng';
const MAX_REVISIONS = 3;

/**
 * Mã chủ phiên (sessionId) do trang trạng thái gắn vào #s=… khi chuyển sang đây. Đọc MỘT lần, cất vào sessionStorage
 * của tab này rồi xoá khỏi thanh địa chỉ (để khách có chia sẻ link cũng không lộ). Có mã thì mới hiện ô "Sửa".
 */
function ownerToken() {
  const key = `pkg.s.${siteId}`;
  const m = /^#s=([A-Za-z0-9_-]{1,128})$/.exec(location.hash);
  if (m) {
    try { sessionStorage.setItem(key, m[1]); } catch { /* bị chặn: vẫn dùng được trong lần mở này */ }
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* bỏ qua */ }
    return m[1];
  }
  try { return sessionStorage.getItem(key) || ''; } catch { return ''; }
}
const owner = siteId ? ownerToken() : '';

// ---------- tiện ích DOM ----------

/** h('p', { class, text, ...attrs }, ...children) — chữ luôn qua textContent. */
function h(tag, props, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'text') e.textContent = String(v);
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c);
  return e;
}
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const arr = (v) => (Array.isArray(v) ? v : []);
const strs = (v) => arr(v).map(str).filter(Boolean);

function safeUrl(u) {
  const t = str(u);
  if (!t) return '';
  try {
    const url = new URL(t, location.href);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch { return ''; }
}
const formatVnd = (n) => Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.') + 'đ';
function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try { return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Ho_Chi_Minh' }); }
  catch { return d.toISOString().slice(0, 10); }
}

function icon(name) {
  const paths = {
    lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5z',
    phone: 'M8 2h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2',
    desktop: 'M3 4h18v12H3zM8 20h8M12 16v4',
    down: 'M12 3v12M7 10l5 5 5-5M5 20h14',
    open: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  };
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ico');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', paths[name]);
  svg.append(p);
  return svg;
}

function loadScript(src, globalName, integrity) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.integrity = integrity;
    s.crossOrigin = 'anonymous';
    s.async = true;
    s.onload = () => (window[globalName] ? resolve(window[globalName]) : reject(new Error(`${globalName} missing`)));
    s.onerror = () => reject(new Error(`load ${src}`));
    document.head.append(s);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('timeout'); })]);

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------- dữ liệu ----------

async function loadPackage() {
  try {
    const res = await fetch(`/api/package/${siteId}`, { cache: 'no-store' });
    let data = null;
    try { data = await res.json(); } catch { /* không phải JSON */ }
    if (!res.ok || !data || typeof data !== 'object') {
      return { error: str(data?.error) || 'Hệ thống đang gặp sự cố. Vui lòng thử lại sau.' };
    }
    return { data };
  } catch {
    return { error: 'Không kết nối được máy chủ. Vui lòng kiểm tra mạng và thử lại.' };
  }
}

// ---------- ảnh giao diện ----------

const SHOTS = [
  { kind: 'mobile', label: 'Điện thoại', button: 'Tải ảnh điện thoại', width: 390, height: 844, maxHeight: 1700, scale: 2 },
  { kind: 'desktop', label: 'Máy tính', button: 'Tải ảnh máy tính', width: 1280, height: 800, maxHeight: 1900, scale: 1 },
];
/** kind → { blob, url, width, height } khi chụp xong. */
const captured = {};

function watermark(canvas, scale) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const hgt = canvas.height;
  const size = Math.round(Math.max(26, Math.min(w, 1280 * scale) / 13));
  ctx.save();
  ctx.font = `800 ${size}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const stepX = ctx.measureText(WATERMARK).width + size * 2;
  const stepY = size * 5;
  ctx.translate(w / 2, hgt / 2);
  ctx.rotate(-Math.PI / 6);
  const reach = Math.hypot(w, hgt);
  let row = 0;
  for (let y = -reach; y < reach; y += stepY, row++) {
    for (let x = -reach + (row % 2) * (stepX / 2); x < reach; x += stepX) {
      ctx.lineWidth = Math.max(2, size / 14);
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.strokeText(WATERMARK, x, y);
      ctx.fillStyle = 'rgba(35,58,115,0.20)';
      ctx.fillText(WATERMARK, x, y);
    }
  }
  ctx.restore();
}

async function waitForDemo(frame) {
  await new Promise((resolve, reject) => {
    frame.addEventListener('load', resolve, { once: true });
    frame.addEventListener('error', reject, { once: true });
  });
  const doc = frame.contentDocument;
  if (!doc) throw new Error('frame not same-origin');
  const t0 = Date.now();
  while (!doc.querySelector('main section, .boot-error')) {
    if (Date.now() - t0 > 12_000) throw new Error('demo did not render');
    await sleep(100);
  }
  if (doc.querySelector('.boot-error')) throw new Error('demo boot error');
  const imgs = [...doc.images];
  // html2canvas dựng lại trang trong một khung about:blank, nơi đường dẫn tương đối (assets/...) sẽ trỏ sai
  // về /package/... — đổi mọi ảnh sang đường dẫn đầy đủ trước khi chụp.
  for (const img of imgs) {
    img.loading = 'eager';
    const abs = img.currentSrc || img.src;
    if (abs) { img.removeAttribute('srcset'); img.setAttribute('src', abs); }
  }
  await withTimeout(Promise.all(imgs.map((img) => (img.complete ? null : new Promise((r) => { img.onload = img.onerror = r; })))), 5000).catch(() => {});
  if (doc.fonts?.ready) await withTimeout(doc.fonts.ready, 3000).catch(() => {});
  return doc;
}

async function captureOne(spec, html2canvas) {
  const frame = h('iframe', { src: `../demo/tpl-${siteId.replace(/^demo-/, '')}/index.html`, title: `Ảnh chụp ${spec.label}`, tabindex: '-1', 'aria-hidden': 'true' });
  frame.style.width = `${spec.width}px`;
  frame.style.height = `${spec.height}px`;
  stage.append(frame);
  try {
    const doc = await withTimeout(waitForDemo(frame), 20_000);
    const full = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0, spec.height);
    const height = Math.min(full, spec.maxHeight);
    frame.style.height = `${height}px`;
    await frames();
    const canvas = await withTimeout(html2canvas(doc.documentElement, {
      width: spec.width, height, windowWidth: spec.width, windowHeight: height,
      x: 0, y: 0, scrollX: 0, scrollY: 0, scale: spec.scale, backgroundColor: '#ffffff', logging: false, useCORS: false,
    }), 25_000);
    watermark(canvas, spec.scale);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('toBlob failed');
    return { blob, url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height, scale: spec.scale };
  } finally {
    frame.remove();
  }
}

/** Chụp lần lượt điện thoại rồi máy tính; mỗi ảnh xong thì cập nhật khung tương ứng. */
async function captureAll(slots) {
  let html2canvas;
  try { html2canvas = await loadScript(HTML2CANVAS_URL, 'html2canvas', HTML2CANVAS_SRI); }
  catch (e) { console.warn('html2canvas', e); for (const s of SHOTS) slots[s.kind].fail(); return; }
  for (const s of SHOTS) {
    try {
      captured[s.kind] = await captureOne(s, html2canvas);
      slots[s.kind].done(captured[s.kind]);
    } catch (e) {
      console.warn('capture', s.kind, e);
      slots[s.kind].fail();
    }
  }
}

function shotSlot(spec, demo) {
  const filename = `giao-dien-${siteId}-${spec.kind}.png`;
  const screen = h('div', { class: 'shot-screen' }, h('div', { class: 'loom loom-sm', 'aria-hidden': 'true' }), h('p', { class: 'shot-wait', text: 'Đang chụp giao diện…' }));
  const chrome = spec.kind === 'desktop'
    ? h('div', { class: 'shot-bar', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('em', { text: demo.replace(/^https?:\/\//, '') }))
    : h('div', { class: 'shot-notch', 'aria-hidden': 'true' });
  const actions = h('div', { class: 'shot-actions no-print' });
  const fig = h('figure', { class: `shot shot-${spec.kind}`, 'aria-busy': 'true' },
    h('div', { class: 'shot-frame' }, chrome, screen),
    h('figcaption', {}, h('span', { class: 'shot-label' }, icon(spec.kind === 'mobile' ? 'phone' : 'desktop'), h('span', { text: `Trên ${spec.label.toLowerCase()}` })), actions));
  const waitScreen = () => [h('div', { class: 'loom loom-sm', 'aria-hidden': 'true' }), h('p', { class: 'shot-wait', text: 'Đang chụp lại giao diện…' })];
  return {
    el: fig,
    reset() {
      fig.setAttribute('aria-busy', 'true');
      fig.classList.remove('is-failed');
      screen.replaceChildren(...waitScreen());
      actions.replaceChildren();
    },
    done(shot) {
      fig.removeAttribute('aria-busy');
      screen.replaceChildren(h('img', { src: shot.url, alt: `Giao diện website mẫu trên ${spec.label.toLowerCase()}`, width: String(Math.round(shot.width / shot.scale)), height: String(Math.round(shot.height / shot.scale)) }));
      actions.replaceChildren(h('a', { class: 'btn btn-small', href: shot.url, download: filename }, icon('down'), h('span', { text: spec.button })));
    },
    fail() {
      fig.removeAttribute('aria-busy');
      fig.classList.add('is-failed');
      screen.replaceChildren(h('p', { class: 'shot-fail' }, h('span', { text: 'Chưa chụp được ảnh giao diện. ' }),
        demo ? h('a', { href: demo, target: '_blank', rel: 'noopener', text: 'Mở website mẫu để xem' }) : h('span', { text: 'Mở website mẫu để xem' })));
      actions.replaceChildren();
    },
  };
}

// ---------- nội dung ----------

const LOCKED_PARTS = [
  'Nội dung chi tiết cho từng trang',
  'Kế hoạch triển khai từng bước',
  'Gợi ý bài đăng cho Fanpage',
  'Danh sách việc bạn cần chuẩn bị',
];
const SHORT_ROADMAP = [
  { buoc: 'Chọn gói và thanh toán', viec: ['Thanh toán qua mã VietQR (PayOS) ngay trên trang này.'] },
  { buoc: 'Chốt nội dung', viec: ['Đội ngũ liên hệ trong 24 giờ, cùng bạn rà lại chữ và ảnh thật.'] },
  { buoc: 'Hoàn thiện và gắn tên miền', viec: ['Chỉnh giao diện theo góp ý, đưa website lên tên miền riêng.'] },
  { buoc: 'Bàn giao', viec: ['Gửi bạn đường dẫn quản lý và hướng dẫn sử dụng.'] },
];
const HEX = /^#[0-9a-f]{3}([0-9a-f]{3})?$/i;

/** Mô hình nội dung dùng chung cho trang, bản in và file Word. */
function buildModel(data) {
  const free = data.analysis?.free || null;
  const full = data.analysis?.full || null;
  const f = free || {};
  const analysis = free ? [
    { title: 'Tóm tắt doanh nghiệp', text: str(f.tom_tat_doanh_nghiep) },
    { title: 'Nhu cầu của bạn', text: str(f.phan_tich_nhu_cau) },
    { title: 'Khách hàng mục tiêu', text: str(f.khach_hang_muc_tieu) },
    { title: 'Mục tiêu của website', list: strs(f.muc_tieu_website) },
    { title: 'Phong cách', text: str(f.phong_cach?.mo_ta), colors: strs(f.phong_cach?.bang_mau).filter((c) => HEX.test(c)) },
    { title: 'Nhận xét website tham khảo', pairs: arr(f.nhan_xet_web_tham_khao).map((w) => [str(w?.nguon), str(w?.diem_hoc_hoi)]).filter(([a, b]) => a || b) },
    { title: 'Sơ đồ trang', pairs: arr(f.so_do_trang).map((p) => [str(p?.trang), str(p?.muc_dich)]).filter(([a, b]) => a || b) },
  ].filter((b) => b.text || b.list?.length || b.pairs?.length || b.colors?.length) : [];
  const detail = full ? [
    ...arr(full.noi_dung_tung_trang).map((p) => ({
      title: `Nội dung trang: ${str(p?.trang) || 'Trang'}`,
      pairs: arr(p?.cac_khoi).map((k) => [str(k?.tieu_de), str(k?.noi_dung)]).filter(([a, b]) => a || b),
    })),
    { title: 'Gợi ý cho Fanpage', list: strs(full.goi_y_fanpage) },
    { title: 'Việc bạn cần chuẩn bị', list: strs(full.viec_khach_can_chuan_bi) },
  ].filter((b) => b.pairs?.length || b.list?.length) : null;
  const plan = full ? arr(full.ke_hoach_trien_khai).map((s) => ({ buoc: str(s?.buoc), viec: strs(s?.viec) })).filter((s) => s.buoc) : [];
  return {
    name: str(data.site?.name) || 'Website của bạn',
    expires: formatDate(data.site?.expires),
    paid: data.site?.paid === true,
    demo: safeUrl(data.demoUrl),
    analysis, detail,
    roadmap: plan.length ? plan : SHORT_ROADMAP,
    packages: arr(data.packages).filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string'),
  };
}

const SECTIONS = [
  { id: 'giao-dien', title: 'Ảnh giao diện' },
  { id: 'phan-tich', title: 'Bản phân tích' },
  { id: 'goi-trien-khai', title: 'Các gói triển khai' },
  { id: 'lo-trinh', title: 'Lộ trình triển khai' },
];

function block(b) {
  return h('article', { class: 'a-block' },
    h('h3', { text: b.title }),
    b.text ? h('p', { text: b.text }) : null,
    b.list?.length ? h('ul', { class: 'ticks' }, b.list.map((t) => h('li', { text: t }))) : null,
    b.colors?.length ? h('ul', { class: 'swatches', 'aria-label': 'Bảng màu' }, b.colors.map((c) => {
      const chip = h('span', { class: 'swatch-chip', 'aria-hidden': 'true' });
      chip.style.backgroundColor = c;
      return h('li', {}, chip, h('span', { text: c.toUpperCase() }));
    })) : null,
    b.pairs?.length ? h('dl', { class: 'pairs' }, b.pairs.map(([k, v]) => h('div', {}, h('dt', { text: k }), h('dd', { text: v })))) : null);
}

function lockedPanel() {
  const ghost = h('div', { class: 'locked-ghost', 'aria-hidden': 'true' },
    LOCKED_PARTS.map(() => h('div', { class: 'ghost-block' }, h('i', { class: 'g-title' }), h('i'), h('i'), h('i', { class: 'g-short' }))));
  return h('section', { class: 'locked', 'aria-labelledby': 'locked-title' },
    ghost,
    h('div', { class: 'locked-card' },
      h('span', { class: 'locked-ico' }, icon('lock')),
      h('h3', { id: 'locked-title', text: 'Phần chi tiết của bản phân tích' }),
      h('p', { class: 'locked-note', text: 'Mở khoá sau khi triển khai chính thức' }),
      h('ul', { class: 'locked-list' }, LOCKED_PARTS.map((t) => h('li', { text: t }))),
      h('a', { class: 'btn btn-primary no-print', href: '#goi-trien-khai', text: 'Xem các gói triển khai' })));
}

function packageSection(m) {
  const err = h('p', { class: 'form-error no-print', role: 'alert', hidden: true });
  const buttons = [];
  const cards = m.packages.map((p, i) => {
    const btn = m.paid ? null : h('button', { type: 'button', class: `btn ${i === m.packages.length - 1 && m.packages.length > 1 ? 'btn-nghe' : 'btn-primary'} no-print`, 'aria-label': `Chọn gói ${p.name}`, text: 'Chọn gói này' });
    if (btn) {
      buttons.push(btn);
      btn.addEventListener('click', async () => {
        for (const b of buttons) b.disabled = true;
        btn.textContent = 'Đang mở trang thanh toán…';
        err.hidden = true;
        let message = 'Chưa tạo được liên kết thanh toán. Vui lòng thử lại.';
        try {
          const res = await fetch('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ siteId, packageId: p.id }) });
          const data = await res.json().catch(() => ({}));
          const url = res.ok ? safeUrl(data?.checkoutUrl) : '';
          if (url) { location.href = url; return; }
          if (!res.ok && str(data?.error)) message = str(data.error);
        } catch {
          message = 'Không kết nối được máy chủ. Vui lòng kiểm tra mạng và thử lại.';
        }
        for (const b of buttons) b.disabled = false;
        btn.textContent = 'Chọn gói này';
        err.textContent = message;
        err.hidden = false;
      });
    }
    return h('article', { class: 'pkg' },
      h('h3', { text: p.name }),
      h('p', { class: 'price', text: formatVnd(p.priceVnd) }),
      h('ul', { class: 'ticks' }, strs(p.items).map((t) => h('li', { text: t }))),
      btn);
  });
  return [
    m.paid
      ? h('p', { class: 'notice', text: 'Bạn đã thanh toán. Đội ngũ sẽ liên hệ trong 24 giờ để triển khai chính thức.' })
      : h('p', { class: 'sec-lead', text: 'Giá đã gồm thiết kế theo bản mẫu này. Thanh toán qua mã VietQR (PayOS); đội ngũ liên hệ trong 24 giờ sau khi nhận thanh toán.' }),
    cards.length ? h('div', { class: 'pkgs' }, cards) : h('p', { class: 'muted', text: 'Hiện chưa có gói triển khai mở bán. Vui lòng liên hệ đội ngũ để được tư vấn.' }),
    err,
  ];
}

function section(n, s, ...children) {
  return h('section', { class: 'doc-sec', id: s.id, 'aria-labelledby': `${s.id}-h` },
    h('header', { class: 'sec-head' }, h('span', { class: 'sec-num', 'aria-hidden': 'true', text: String(n) }), h('h2', { id: `${s.id}-h`, text: s.title })),
    ...children);
}

// ---------- file Word ----------

async function dataUrlBytes(blob) { return new Uint8Array(await blob.arrayBuffer()); }

async function buildDocx(m) {
  const d = await loadScript(DOCX_URL, 'docx', DOCX_SRI);
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, AlignmentType } = d;
  const P = (text, o = {}) => new Paragraph({ children: [new TextRun({ text, ...o.run })], spacing: { after: 120 }, ...o.para });
  const H = (text, level) => new Paragraph({ text, heading: level, spacing: { before: 240, after: 120 } });
  const bullets = (items) => items.map((t) => new Paragraph({ text: t, bullet: { level: 0 } }));
  const blocks = (list) => list.flatMap((b) => [
    H(b.title, HeadingLevel.HEADING_2),
    ...(b.text ? [P(b.text)] : []),
    ...(b.list?.length ? bullets(b.list) : []),
    ...(b.colors?.length ? [P(`Bảng màu: ${b.colors.join(', ')}`)] : []),
    ...(b.pairs?.length ? b.pairs.map(([k, v]) => new Paragraph({ children: [new TextRun({ text: k ? `${k}: ` : '', bold: true }), new TextRun(v)], spacing: { after: 80 } })) : []),
  ]);

  const images = [];
  for (const s of SHOTS) {
    const shot = captured[s.kind];
    if (!shot) continue;
    const w0 = shot.width / shot.scale;
    const h0 = shot.height / shot.scale;
    const k = Math.min((s.kind === 'mobile' ? 300 : 600) / w0, 820 / h0);
    images.push(new Paragraph({ text: `Bản ${s.label.toLowerCase()}`, heading: HeadingLevel.HEADING_3 }));
    images.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: 'png', data: await dataUrlBytes(shot.blob), transformation: { width: Math.round(w0 * k), height: Math.round(h0 * k) } })] }));
  }
  if (!images.length) images.push(P(m.demo ? `Chưa chụp được ảnh giao diện. Mở website mẫu để xem: ${m.demo}` : 'Chưa chụp được ảnh giao diện.'));

  const children = [
    new Paragraph({ children: [new TextRun({ text: 'Bộ hồ sơ website dùng thử', color: '233A73', bold: true })], spacing: { after: 120 } }),
    new Paragraph({ text: m.name, heading: HeadingLevel.TITLE }),
    ...(m.expires ? [P(`Dùng thử đến ngày ${m.expires}`)] : []),
    ...(m.demo ? [P(`Website mẫu: ${m.demo}`)] : []),
    P(`Thực hiện bởi ${platform}`, { run: { italics: true, color: '4A5263' } }),
    H('Mục lục', HeadingLevel.HEADING_1),
    ...SECTIONS.map((s, i) => P(`${i + 1}. ${s.title}`)),
    H(`1. ${SECTIONS[0].title}`, HeadingLevel.HEADING_1),
    P('Ảnh chụp có đóng dấu "BẢN DÙNG THỬ".', { run: { italics: true, color: '4A5263' } }),
    ...images,
    H(`2. ${SECTIONS[1].title}`, HeadingLevel.HEADING_1),
    ...(m.analysis.length ? blocks(m.analysis) : [P('Bản phân tích đang được chuẩn bị.')]),
    ...(m.detail
      ? blocks(m.detail)
      : [H('Phần chi tiết của bản phân tích', HeadingLevel.HEADING_2), P('Mở khoá sau khi triển khai chính thức', { run: { bold: true } }), ...bullets(LOCKED_PARTS)]),
    H(`3. ${SECTIONS[2].title}`, HeadingLevel.HEADING_1),
    ...(m.packages.length ? m.packages.flatMap((p) => [
      new Paragraph({ children: [new TextRun({ text: p.name, bold: true }), new TextRun({ text: ` – ${formatVnd(p.priceVnd)}`, bold: true, color: '233A73' })], spacing: { before: 160, after: 80 } }),
      ...bullets(strs(p.items)),
    ]) : [P('Hiện chưa có gói triển khai mở bán.')]),
    H(`4. ${SECTIONS[3].title}`, HeadingLevel.HEADING_1),
    ...m.roadmap.flatMap((s, i) => [
      new Paragraph({ children: [new TextRun({ text: `Bước ${i + 1}: ${s.buoc}`, bold: true })], spacing: { before: 120, after: 60 } }),
      ...bullets(s.viec),
    ]),
  ];
  const doc = new Document({
    creator: platform, title: `Bộ hồ sơ – ${m.name}`, description: 'Bộ hồ sơ website dùng thử',
    styles: { default: { document: { run: { font: 'Arial', size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBlob(doc);
}

// ---------- sửa website mẫu (chỉ chủ phiên) ----------

const REVISE_ERRORS = {
  403: 'Bạn không có quyền sửa bản dùng thử này. Hãy mở lại link từ trang trò chuyện trên máy đã tạo bản dùng thử.',
  409: `Bạn đã dùng hết ${MAX_REVISIONS} lượt sửa bản dùng thử.`,
  410: 'Bản dùng thử đã hết hạn nên không sửa được nữa.',
  422: 'Chưa áp dụng được yêu cầu sửa này. Bạn hãy diễn đạt lại ngắn gọn hơn; lượt sửa chưa bị tính.',
};

/** onRevised(): gọi sau khi sửa xong để chụp lại ảnh giao diện. */
function reviseBox(onRevised) {
  const area = h('textarea', { id: 'revise-text', rows: '3', maxlength: '2000', placeholder: 'Ví dụ: đổi màu chủ đạo sang xanh lá, thêm giờ mở cửa 7h–17h' });
  const left = h('p', { class: 'revise-left', text: `Mỗi bản dùng thử được sửa tối đa ${MAX_REVISIONS} lượt.` });
  const msg = h('p', { class: 'revise-msg', role: 'status' });
  const btn = h('button', { type: 'submit', class: 'btn btn-primary', text: 'Gửi yêu cầu sửa' });
  const form = h('form', { class: 'revise', id: 'sua-website', novalidate: true, 'aria-labelledby': 'revise-title' },
    h('h3', { id: 'revise-title', text: 'Sửa website mẫu' }),
    left,
    h('label', { for: 'revise-text', text: 'Bạn muốn sửa gì trên website mẫu?' }),
    area, msg, btn);
  let done = false;
  const say = (text, bad) => { msg.textContent = text; msg.classList.toggle('is-error', !!bad); };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (done || btn.disabled) return;
    const request = area.value.trim();
    if (!request) { say('Vui lòng nhập nội dung bạn muốn sửa.', true); area.focus(); return; }
    btn.disabled = true;
    btn.textContent = 'Đang sửa… (khoảng 1 phút)';
    say('');
    let res = null; let data = {};
    try {
      res = await fetch('/api/revise', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ siteId, sessionId: owner, request }) });
      data = await res.json().catch(() => ({}));
    } catch { res = null; }
    btn.textContent = 'Gửi yêu cầu sửa';
    if (res && res.ok) {
      const n = Number.isInteger(data?.revisionsLeft) ? Math.max(0, data.revisionsLeft) : null;
      area.value = '';
      if (n !== null) left.textContent = n > 0 ? `Còn ${n} lượt sửa` : 'Đã dùng hết lượt sửa';
      say('Đã sửa xong website mẫu. Ảnh giao diện đang được chụp lại.');
      if (n === 0) { done = true; area.disabled = true; } else btn.disabled = false;
      onRevised();
      return;
    }
    const status = res ? res.status : 0;
    const text = str(data?.error) || REVISE_ERRORS[status]
      || (status ? 'Chưa sửa được bản dùng thử lúc này. Vui lòng thử lại sau ít phút.' : 'Không kết nối được máy chủ. Vui lòng kiểm tra mạng và thử lại.');
    say(text, true);
    if (status === 409 && /hết/.test(text)) { done = true; area.disabled = true; left.textContent = 'Đã dùng hết lượt sửa'; return; }
    if (status === 403 || status === 410) { done = true; area.disabled = true; return; }
    btn.disabled = false;
  });
  return form;
}

// ---------- dựng trang ----------

function fail(text) {
  app.removeAttribute('aria-busy');
  app.replaceChildren(h('div', { class: 'boot' }, h('h1', { text: 'Không mở được bộ hồ sơ' }), h('p', { text })));
}

function render(data) {
  const m = buildModel(data);
  document.title = `Bộ hồ sơ – ${m.name}`;
  app.removeAttribute('aria-busy');

  const slots = {};
  const capturePromise = { p: null };
  const status = h('p', { class: 'action-status no-print', role: 'status' });
  const busy = async (btn, label, fn) => {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try { await fn(); } finally { btn.disabled = false; btn.textContent = old; }
  };
  // Ảnh đang chụp thì đợi (tối đa 25 giây) để PDF/Word có ảnh.
  const waitShots = () => withTimeout(capturePromise.p || Promise.resolve(), 25_000).catch(() => {});

  const pdfBtn = h('button', { type: 'button', class: 'btn btn-ghost-dark', text: 'Tải PDF' });
  pdfBtn.addEventListener('click', () => busy(pdfBtn, 'Đang chuẩn bị…', async () => {
    status.textContent = '';
    await waitShots();
    window.print();
  }));
  const docxBtn = h('button', { type: 'button', class: 'btn btn-ghost-dark', text: 'Tải Word (DOCX)' });
  docxBtn.addEventListener('click', () => busy(docxBtn, 'Đang tạo file Word…', async () => {
    status.textContent = '';
    try {
      await waitShots();
      download(await buildDocx(m), `phan-tich-${siteId}.docx`);
    } catch (e) {
      console.warn('docx', e);
      status.textContent = 'Chưa tạo được file Word. Vui lòng thử lại, hoặc dùng "Tải PDF".';
    }
  }));

  const openDemo = m.demo
    ? h('a', { class: 'btn btn-nghe', href: m.demo, target: '_blank', rel: 'noopener' }, h('span', { text: 'Mở website mẫu' }), icon('open'))
    : null;

  const cover = h('section', { class: 'cover no-print' },
    h('div', { class: 'cover-in' },
      h('div', { class: 'cover-text' },
        h('p', { class: 'cover-kicker', text: 'Bộ hồ sơ website dùng thử' }),
        h('h1', { text: m.name }),
        h('p', { class: 'cover-lead', text: m.paid
          ? 'Bạn đã thanh toán. Toàn bộ bản phân tích đã được mở khoá bên dưới.'
          : `Website mẫu, ảnh giao diện và bản phân tích được dựng từ cuộc trò chuyện của bạn${m.expires ? `. Bản dùng thử mở đến ngày ${m.expires}.` : '.'}` }),
        h('div', { class: 'cover-actions' }, openDemo, pdfBtn, docxBtn),
        status),
      h('nav', { class: 'tabs', 'aria-label': 'Mục lục' },
        h('p', { class: 'tabs-title', text: 'Trong bộ hồ sơ' }),
        h('ol', {}, SECTIONS.map((s, i) => h('li', {}, h('a', { href: `#${s.id}` }, h('b', { text: String(i + 1) }), h('span', { text: s.title }))))))));

  // Bìa và mục lục chỉ dành cho bản in (PDF).
  const printCover = h('section', { class: 'print-only print-cover' },
    h('div', { class: 'weave' }),
    h('p', { class: 'pc-kicker', text: 'Bộ hồ sơ website dùng thử' }),
    h('h1', { text: m.name }),
    m.expires ? h('p', { text: `Dùng thử đến ngày ${m.expires}` }) : null,
    m.demo ? h('p', { class: 'pc-url', text: `Website mẫu: ${m.demo}` }) : null,
    h('p', { class: 'pc-by', text: `Thực hiện bởi ${platform}` }));
  const printToc = h('section', { class: 'print-only print-toc' },
    h('h2', { text: 'Mục lục' }),
    h('ol', {}, SECTIONS.map((s) => h('li', { text: s.title }))));

  for (const s of SHOTS) slots[s.kind] = shotSlot(s, m.demo);

  const doc = h('div', { class: 'doc' },
    section(1, SECTIONS[0],
      h('p', { class: 'sec-lead' }, h('span', { text: 'Ảnh chụp trực tiếp từ website mẫu, có đóng dấu "BẢN DÙNG THỬ". ' }),
        h('span', { class: 'no-print', text: 'Bấm nút dưới mỗi ảnh để tải về máy.' })),
      h('div', { class: 'shots' }, slots.mobile.el, slots.desktop.el),
      owner && !m.paid ? reviseBox(recapture) : null),
    section(2, SECTIONS[1],
      m.analysis.length ? h('div', { class: 'a-grid' }, m.analysis.map(block)) : h('p', { class: 'muted', text: 'Bản phân tích đang được chuẩn bị. Vui lòng quay lại sau ít phút.' }),
      m.detail ? h('div', { class: 'a-grid a-detail' }, h('h3', { class: 'a-detail-title', text: 'Phần chi tiết' }), m.detail.map(block)) : lockedPanel()),
    section(3, SECTIONS[2], ...packageSection(m)),
    section(4, SECTIONS[3],
      h('ol', { class: 'steps' }, m.roadmap.map((s) => h('li', {}, h('strong', { text: s.buoc }), s.viec.length ? h('span', { text: s.viec.join(' ') }) : null)))));

  app.replaceChildren(printCover, printToc, cover, doc);
  capturePromise.p = captureAll(slots);

  /** Sau khi sửa: chụp lại cả hai ảnh từ /d/<id>/ (đợi lượt chụp trước xong). */
  function recapture() {
    const prev = capturePromise.p || Promise.resolve();
    capturePromise.p = prev.catch(() => {}).then(() => {
      for (const s of SHOTS) {
        if (captured[s.kind]) URL.revokeObjectURL(captured[s.kind].url);
        delete captured[s.kind];
        slots[s.kind].reset();
      }
      return captureAll(slots);
    });
  }
}

if (!siteId) fail('Đường dẫn không đúng. Vui lòng mở lại link bộ hồ sơ.');
else {
  const r = await loadPackage();
  if (r.data) render(r.data);
  else fail(r.error);
}

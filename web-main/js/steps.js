// Thanh 8 bước, thẻ chọn và bản tóm tắt phiếu yêu cầu. Chỉ dựng DOM bằng textContent (dữ liệu từ AI/khách).
import { h, formatVnd } from './api.js';

export const STEPS = [
  ['don_vi', 'Đơn vị và ngành nghề'],
  ['san_pham', 'Sản phẩm và dịch vụ'],
  ['khach_hang', 'Khách hàng'],
  ['muc_tieu', 'Mục tiêu website'],
  ['phong_cach', 'Phong cách'],
  ['tham_khao', 'Website tham khảo'],
  ['tai_lieu', 'Tài liệu và hình ảnh'],
  ['xac_nhan', 'Liên hệ và xác nhận'],
];
export const STEP_LABEL = Object.fromEntries(STEPS);

const LOAI = { htx: 'Hợp tác xã', 'cong-ty': 'Công ty', 'ho-kd': 'Hộ kinh doanh', khac: 'Khác' };
const GOAL = {
  'gioi-thieu': 'Giới thiệu đơn vị và sản phẩm', 'ban-hang': 'Bán hàng',
  'thu-lead': 'Thu thông tin khách quan tâm', 'tim-dai-ly': 'Tìm đại lý, nhà phân phối', 'tuyen-dung': 'Tuyển dụng',
};
const ACTION = { goi: 'Gọi điện', zalo: 'Nhắn Zalo', 'dat-hang': 'Đặt hàng', 'dang-ky': 'Đăng ký thông tin' };

/** Mỗi cảm giác thiết kế = một "mẫu vải" 4 sọc màu (nền, chủ đạo, nhấn, chữ). */
export const STYLES = {
  'moc-mac': { label: 'Mộc mạc, gần gũi', colors: ['#efe4cf', '#8a5a2b', '#5f7a3a', '#3b2a1a'] },
  'truyen-thong': { label: 'Truyền thống, đáng tin cậy', colors: ['#f6efe0', '#9b1c1c', '#c99a2e', '#2b1d12'] },
  'hien-dai': { label: 'Hiện đại, gọn gàng', colors: ['#f3f6f8', '#1f6feb', '#14b8a6', '#111827'] },
  'sang-trong': { label: 'Sang trọng, tinh tế', colors: ['#f4f1ec', '#1d2b3a', '#b8925a', '#0f1720'] },
  'tre-trung': { label: 'Trẻ trung, năng động', colors: ['#fff7ec', '#ff6b3d', '#ffc531', '#2a2140'] },
};

function swatch(colors, cls = 'swatch') {
  const el = h('span', { class: cls, 'aria-hidden': 'true' });
  for (const c of colors) {
    const s = h('i');
    s.style.background = c;
    el.append(s);
  }
  return el;
}

/** state: { step: {id, index, label}, done: string[], turnsLeft?: number } → <details> thanh bước. */
export function renderStepBar(state) {
  const step = state?.step || { id: 'don_vi', index: 1, label: STEP_LABEL.don_vi };
  const done = new Set(state?.done || []);
  const index = Math.min(8, Math.max(1, Number(step.index) || 1));
  const label = step.label || STEP_LABEL[step.id] || '';
  const segs = h('span', { class: 'step-segs', 'aria-hidden': 'true' },
    STEPS.map(([id], i) => h('i', { class: done.has(id) ? 'is-done' : i + 1 === index ? 'is-now' : '' })));
  const list = h('ol', { class: 'step-list' }, STEPS.map(([id, name], i) => {
    const isDone = done.has(id);
    const now = i + 1 === index;
    return h('li', { class: isDone ? 'is-done' : now ? 'is-now' : '', 'aria-current': now ? 'step' : null },
      h('span', { class: 'tick', 'aria-hidden': 'true', text: isDone ? '✓' : String(i + 1) }),
      h('span', { text: name }),
      isDone ? h('span', { class: 'visually-hidden', text: ' (đã xong)' }) : null);
  }));
  return h('details', { class: 'stepbar', id: 'stepbar' },
    h('summary', {},
      h('span', { class: 'step-now', id: 'step-now', text: `Bước ${index}/8 · ${label}` }),
      segs),
    list);
}

/**
 * choices: { kind: 'single'|'multi', options: [{value, label, hint?}] } → khối thẻ chọn.
 * onPick(text) nhận đúng label (multi: các label nối bằng ", " khi bấm "Xong").
 */
export function renderChoices(choices, onPick) {
  const options = Array.isArray(choices?.options) ? choices.options.filter((o) => o && o.label) : [];
  if (!options.length) return null;
  const multi = choices.kind === 'multi';
  const isStyle = options.every((o) => STYLES[o.value]);
  const picked = new Set();
  const doneBtn = multi
    ? h('button', { type: 'button', class: 'btn btn-primary choice-done', disabled: true, text: 'Xong' })
    : null;
  const cards = options.map((o) => {
    const style = isStyle ? STYLES[o.value] : null;
    const btn = h('button', {
      type: 'button', class: 'choice', 'aria-pressed': multi ? 'false' : null,
    },
    style ? swatch(style.colors) : null,
    h('span', { class: 'choice-text' },
      h('b', { text: o.label }),
      o.hint ? h('small', { text: o.hint }) : null),
    multi ? h('span', { class: 'choice-box', 'aria-hidden': 'true' }) : null);
    btn.addEventListener('click', () => {
      if (!multi) { onPick(o.label); return; }
      if (picked.has(o.label)) picked.delete(o.label); else picked.add(o.label);
      btn.setAttribute('aria-pressed', String(picked.has(o.label)));
      doneBtn.disabled = picked.size === 0;
      doneBtn.textContent = picked.size ? `Xong (${picked.size})` : 'Xong';
    });
    return btn;
  });
  if (doneBtn) {
    doneBtn.addEventListener('click', () => {
      const labels = options.map((o) => o.label).filter((l) => picked.has(l));
      if (labels.length) onPick(labels.join(', '));
    });
  }
  return h('div', { class: `choices${isStyle ? ' choices-style' : ''}`, role: 'group', 'aria-label': multi ? 'Chọn một hoặc nhiều' : 'Chọn một' },
    multi ? h('p', { class: 'choices-hint', text: 'Chọn được nhiều, rồi bấm “Xong”.' }) : null,
    h('div', { class: 'choice-grid' }, cards),
    doneBtn);
}

const has = (v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v != null);

function rows(pairs) {
  const items = pairs.filter(([, v]) => has(v));
  if (!items.length) return h('p', { class: 'muted', text: 'Chưa có thông tin.' });
  return h('dl', { class: 'sum-rows' }, items.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', {}, v instanceof Node ? v : String(v))]));
}

function products(list) {
  const items = (list || []).filter((p) => p && p.ten);
  if (!items.length) return null;
  const shown = items.slice(0, 8);
  const ul = h('ul', { class: 'sum-products' }, shown.map((p) =>
    h('li', {}, h('span', { text: p.ten }), typeof p.gia === 'number' ? h('b', { text: formatVnd(p.gia) }) : null)));
  if (items.length > shown.length) ul.append(h('li', { class: 'muted', text: `và ${items.length - shown.length} sản phẩm khác` }));
  return ul;
}

function stepBody(id, b, extra) {
  switch (id) {
    case 'don_vi': return rows([['Tên đơn vị', b.ten_don_vi], ['Loại hình', LOAI[b.loai_hinh]], ['Ngành nghề', b.nganh],
      ['Địa phương', b.dia_phuong], ['Quy mô', b.quy_mo], ['Năm thành lập', b.nam_thanh_lap]]);
    case 'san_pham': return h('div', {}, products(b.san_pham),
      rows([['Điểm khác biệt', b.diem_khac_biet], ['Chứng nhận', (b.chung_nhan || []).join(', ')]]));
    case 'khach_hang': return rows([['Khách hàng chính', b.khach_hang_muc_tieu], ['Khu vực khách', b.khu_vuc_khach],
      ['Đang bán qua', (b.kenh_ban_hien_tai || []).join(', ')]]);
    case 'muc_tieu': return rows([['Mục tiêu chính', GOAL[b.muc_tieu_chinh]], ['Khách nên làm gì', ACTION[b.hanh_dong_mong_muon]],
      ['Thành công là', b.thanh_cong_la_gi]]);
    case 'phong_cach': {
      const feel = STYLES[b.cam_giac];
      const color = /^#[0-9a-f]{6}$/i.test(b.mau_chu_dao || '') ? b.mau_chu_dao : '';
      return rows([
        ['Cảm giác', feel ? h('span', { class: 'sum-feel' }, swatch(feel.colors, 'swatch swatch-sm'), h('span', { text: feel.label })) : null],
        ['Màu chủ đạo', color ? h('span', { class: 'sum-feel' }, swatch([color], 'swatch swatch-sm'), h('span', { text: color })) : null],
        ['Logo', typeof b.co_logo === 'boolean' ? (b.co_logo ? 'Đã có logo' : 'Chưa có logo') : null],
      ]);
    }
    case 'tham_khao': {
      const refs = (b.web_tham_khao || []).filter((r) => r && (r.thich_diem_gi || r.url));
      if (!refs.length) return h('p', { class: 'muted', text: 'Không có website tham khảo.' });
      return h('ul', { class: 'sum-list' }, refs.map((r) => h('li', { text: [r.url, r.thich_diem_gi].filter(Boolean).join(': ') })));
    }
    case 'tai_lieu': {
      const parts = [];
      if (extra?.images) parts.push(`${extra.images} ảnh`);
      if (extra?.docs) parts.push(`${extra.docs} tài liệu`);
      return h('p', { class: parts.length ? '' : 'muted', text: parts.length ? `Đã gửi ${parts.join(' và ')}.` : 'Chưa gửi ảnh hay tài liệu.' });
    }
    case 'xac_nhan': {
      const lh = b.lien_he || {};
      return rows([['Số điện thoại', lh.phone], ['Zalo', lh.zalo], ['Địa chỉ', lh.address], ['Giờ mở cửa', lh.gio_mo_cua], ['Fanpage', lh.fanpage]]);
    }
    default: return null;
  }
}

/** Bản tóm tắt theo 8 bước. onEdit(stepId, label); onConfirm(). extra: { images, docs } đã gửi trong phiên này. */
export function renderSummary(brief, onEdit, onConfirm, extra = {}) {
  const b = brief || {};
  return h('section', { class: 'summary', id: 'summary', 'aria-labelledby': 'summary-title' },
    h('h2', { id: 'summary-title', text: 'Kiểm tra lại thông tin' }),
    h('p', { class: 'muted', text: 'Website dùng thử sẽ làm theo đúng các thông tin này. Chỗ nào chưa đúng, bấm “Sửa”.' }),
    h('ol', { class: 'sum-steps' }, STEPS.map(([id, label], i) => h('li', { class: 'sum-step' },
      h('div', { class: 'sum-head' },
        h('h3', {}, h('span', { class: 'sum-num', text: String(i + 1) }), h('span', { text: label })),
        h('button', { type: 'button', class: 'btn btn-ghost btn-edit', 'aria-label': `Sửa bước ${i + 1}: ${label}`, text: 'Sửa',
          onclick: () => onEdit(id, label) })),
      stepBody(id, b, extra)))),
    h('button', { type: 'button', class: 'btn btn-nghe sum-confirm', id: 'sum-confirm', text: 'Đúng rồi, tạo bản dùng thử', onclick: () => onConfirm() }));
}

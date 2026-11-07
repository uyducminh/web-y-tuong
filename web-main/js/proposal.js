import { api, formatVnd, h, qs, safeUrl } from './api.js';

const $ = (id) => document.getElementById(id);
const root = $('proposal');
const siteId = qs('site');

function fail(text) {
  root.removeAttribute('aria-busy');
  root.replaceChildren(h('h1', { text: 'Không mở được bản đề xuất' }), h('p', { class: 'lead', text }),
    h('a', { class: 'btn btn-ghost', href: 'index.html', text: 'Về trang chủ' }));
}

const list = (items, cls) => h('ul', { class: cls }, (items || []).map((t) => h('li', { text: String(t) })));

function packageCard(p, err, buttons) {
  const btn = p.id
    ? h('button', { type: 'button', class: 'btn btn-primary no-print', 'aria-label': `Chọn gói ${p.name}`, text: 'Chọn gói này' })
    : null;
  if (btn) {
    buttons.push(btn);
    btn.addEventListener('click', async () => {
      for (const b of buttons) b.disabled = true;
      btn.textContent = 'Đang mở trang thanh toán…';
      err.hidden = true;
      const r = await api('/api/checkout', { json: { siteId, packageId: p.id } });
      const url = r.ok ? safeUrl(r.data.checkoutUrl) : '';
      if (url) { location.href = url; return; }
      for (const b of buttons) b.disabled = false;
      btn.textContent = 'Chọn gói này';
      err.textContent = r.ok ? 'Chưa tạo được liên kết thanh toán. Vui lòng thử lại.' : r.data.error;
      err.hidden = false;
    });
  }
  return h('article', { class: 'pkg' },
    h('h3', { text: p.name }),
    h('p', { class: 'price', text: formatVnd(p.priceVnd) }),
    list(p.items, 'ticks'),
    btn);
}

function render({ proposal, site, packages }) {
  root.removeAttribute('aria-busy');
  document.title = `Đề xuất website – ${site.name}`;
  const demo = safeUrl(site.url);
  // Gói có id (từ cấu hình Worker) là gói thanh toán được, đúng giá sẽ thu; nếu không có thì hiện gói trong đề xuất.
  const pkgs = Array.isArray(packages) && packages.length ? packages : (proposal.packages || []);
  const err = h('p', { class: 'form-error no-print', role: 'alert', hidden: true });
  const buttons = [];

  root.replaceChildren(
    h('header', { class: 'doc-head' },
      h('p', { class: 'muted', text: 'Đề xuất triển khai website' }),
      h('h1', { text: site.name }),
      h('p', { class: 'lead', text: proposal.summary }),
      h('div', { class: 'actions no-print' },
        demo ? h('a', { class: 'btn btn-ghost', href: demo, target: '_blank', rel: 'noopener', text: 'Xem bản dùng thử' }) : null,
        h('button', { type: 'button', class: 'btn btn-ghost', id: 'print', text: 'In / Lưu PDF', onclick: () => window.print() })),
      demo ? h('p', { class: 'url print-only', text: `Bản dùng thử: ${demo}` }) : null),
    proposal.problems?.length ? h('section', {}, h('h2', { text: 'Điều đang cản trở' }), list(proposal.problems, 'dots')) : null,
    h('section', {}, h('h2', { text: 'Giải pháp' }), h('p', { text: proposal.solution })),
    pkgs.length ? h('section', { class: 'pkgs-wrap' },
      h('h2', { text: 'Các gói triển khai' }),
      h('div', { class: 'pkgs' }, pkgs.map((p) => packageCard(p, err, buttons))),
      err,
      h('p', { class: 'muted no-print', text: 'Thanh toán qua mã VietQR (PayOS). Đội ngũ liên hệ trong 24h sau khi nhận thanh toán.' })) : null,
    proposal.roadmap?.length ? h('section', {},
      h('h2', { text: 'Các bước thực hiện' }),
      h('ol', { class: 'steps' }, proposal.roadmap.map((r) => h('li', {}, h('strong', { text: r.step }), h('span', { text: r.desc }))))) : null,
  );
}

if (!/^[a-z0-9-]{1,64}$/.test(siteId)) fail('Đường dẫn không đúng. Vui lòng mở lại link từ trang trạng thái.');
else {
  const r = await api(`/api/proposal/${siteId}`, { timeoutMs: 20000 });
  if (r.ok && r.data.proposal && r.data.site) render(r.data);
  else fail(r.data.error || 'Không tìm thấy bản đề xuất này.');
}

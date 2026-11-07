import { api, h, loadSession, saveSession, qs, safeUrl } from './api.js';

const FIRST_DELAY = 3000;
const MAX_DELAY = 10000;
const MAX_REVISIONS = 3;

const $ = (id) => document.getElementById(id);
const box = $('status');
const jobId = qs('job');

function render(...children) { box.replaceChildren(...children); }

function waiting(queued) {
  render(
    h('div', { class: 'loom', 'aria-hidden': 'true' }),
    h('h1', { text: queued ? 'Đã nhận yêu cầu của bạn' : 'Đang tạo bản dùng thử…' }),
    h('p', { class: 'lead', text: queued
      ? 'Hôm nay hệ thống đông khách. Chúng tôi sẽ gửi link bản dùng thử cho bạn qua số điện thoại/Zalo trong 24h. Bạn có thể đóng trang này.'
      : 'Thường mất khoảng 1–3 phút. Bạn cứ để trang này mở, trang sẽ tự cập nhật.' }),
  );
  box.setAttribute('aria-busy', 'true');
}

function failed(text) {
  box.removeAttribute('aria-busy');
  render(
    h('h1', { text: 'Chưa tạo được bản dùng thử' }),
    h('p', { class: 'lead', text }),
    h('a', { class: 'btn btn-ghost', href: 'index.html', text: 'Về trang chủ' }),
  );
}

function reviseBox(siteId, sessionId, left) {
  if (left <= 0) {
    return h('section', { class: 'card revise' },
      h('h2', { text: 'Sửa bản dùng thử' }),
      h('p', { text: `Bạn đã dùng hết ${MAX_REVISIONS} lượt sửa. Cần chỉnh thêm, đội ngũ sẽ hỗ trợ khi triển khai chính thức.` }));
  }
  const area = h('textarea', { id: 'revise-text', rows: 3, maxlength: 2000, placeholder: 'Ví dụ: đổi màu chủ đạo sang xanh lá, thêm giờ mở cửa 7h–17h' });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true });
  const btn = h('button', { type: 'submit', class: 'btn btn-primary', text: 'Gửi yêu cầu sửa' });
  const form = h('form', { class: 'card revise', novalidate: true },
    h('h2', { text: 'Sửa bản dùng thử' }),
    h('p', { class: 'muted', text: `Còn ${left} lượt sửa` }),
    h('label', { for: 'revise-text', text: 'Bạn muốn sửa gì?' }),
    area, err, btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const request = area.value.trim();
    if (!request) { err.textContent = 'Vui lòng nhập nội dung bạn muốn sửa.'; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = 'Đang gửi…'; err.hidden = true;
    const r = await api('/api/revise', { json: { siteId, sessionId, request }, timeoutMs: 120000 });
    if (r.ok && r.data.jobId) {
      saveSession({ jobId: r.data.jobId, siteId, revisionsLeft: r.data.revisionsLeft });
      location.href = `status.html?job=${encodeURIComponent(r.data.jobId)}`;
      return;
    }
    if (r.status === 409 && /hết/.test(r.data.error)) saveSession({ revisionsLeft: 0 });
    btn.disabled = false; btn.textContent = 'Gửi yêu cầu sửa';
    err.textContent = r.data.error; err.hidden = false;
  });
  return form;
}

function ready(job) {
  box.removeAttribute('aria-busy');
  const url = safeUrl(job.url);
  const s = loadSession();
  const owner = !!s.sessionId && s.jobId === jobId;
  if (owner) saveSession({ siteId: job.siteId });
  const left = typeof s.revisionsLeft === 'number' ? s.revisionsLeft : MAX_REVISIONS;
  render(
    h('h1', { text: 'Bản dùng thử đã sẵn sàng' }),
    h('p', { class: 'lead', text: 'Bạn mở xem trên điện thoại, gửi cho người thân góp ý. Nếu trang chưa hiện đúng, đợi 1–2 phút rồi tải lại.' }),
    h('div', { class: 'actions' },
      url ? h('a', { class: 'btn btn-primary', href: url, target: '_blank', rel: 'noopener', text: 'Mở bản dùng thử' }) : null,
      h('a', { class: 'btn btn-ghost', href: `proposal.html?site=${encodeURIComponent(job.siteId)}`, text: 'Xem đề xuất và báo giá' })),
    url ? h('p', { class: 'url' }, h('span', { text: 'Địa chỉ: ' }), h('a', { href: url, target: '_blank', rel: 'noopener', text: url })) : null,
    h('p', { class: 'notice', text: 'Bản dùng thử là công khai và tự gỡ sau 30 ngày nếu chưa triển khai chính thức.' }),
    owner ? reviseBox(job.siteId, s.sessionId, left) : null,
  );
}

async function poll(delay) {
  const r = await api(`/api/status/${encodeURIComponent(jobId)}`, { timeoutMs: 20000 });
  if (r.ok) {
    const job = r.data;
    if (job.state === 'ready') { ready(job); return; }
    if (job.state === 'failed') { failed(job.error || 'Đội ngũ đã được thông báo và sẽ liên hệ với bạn sớm.'); return; }
    waiting(job.state === 'queued');
  } else if (r.status >= 400 && r.status < 500) {
    failed(r.data.error); return;
  }
  // pending / queued / lỗi mạng: hỏi lại, giãn dần 3s → 10s
  setTimeout(() => poll(Math.min(Math.round(delay * 1.5), MAX_DELAY)), delay);
}

if (!/^[A-Za-z0-9]{1,64}$/.test(jobId)) failed('Đường dẫn không đúng. Vui lòng mở lại link từ trang trò chuyện.');
else { waiting(false); poll(FIRST_DELAY); }

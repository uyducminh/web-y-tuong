import { api, h, loadSession, saveSession, qs, safeUrl, API_BASE } from './api.js';

const FIRST_DELAY = 3000;
const MAX_DELAY = 10000;
// Mỗi lần gọi /run chạy MỘT bước (AI có thể mất 1–3 phút) ngay trong yêu cầu đó → chờ lâu.
const RUN_TIMEOUT = 180000;
const RUN_GAP = 300;      // next: 'run' → gọi tiếp gần như ngay
const WAIT_DELAY = 2500;  // next: 'wait' → bước khác đang chạy
const DEFAULT_FAIL = 'Đội ngũ đã được thông báo và sẽ liên hệ với bạn sớm.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 4 bước chờ. `at` = giây đã trôi qua thì coi như bước đó xong (job chỉ báo pending → ready). */
export const WAIT_STEPS = [
  { text: 'Đang phân tích ngành nghề và khách hàng', at: 20 },
  { text: 'Đang viết nội dung website', at: 45 },
  { text: 'Đang dựng giao diện', at: 70 },
  { text: 'Đang soạn bản phân tích', at: Infinity },
];
const EXPECTED_S = 100;

const $ = (id) => document.getElementById(id);
const box = $('status');
const jobId = qs('job');

function render(...children) { box.replaceChildren(...children); }

/** Thời điểm bắt đầu chờ, lưu theo job để mở lại link vẫn chạy tiếp từ bước đang dở. */
function startedAt() {
  const s = loadSession();
  if (s.waitJob === jobId && typeof s.waitStart === 'number') return s.waitStart;
  const now = Date.now();
  saveSession({ waitJob: jobId, waitStart: now });
  return now;
}

let ticker = null;
let stepEls = null;
let bar = null;

function paint() {
  if (!stepEls) return;
  const sec = (Date.now() - startedAt()) / 1000;
  let current = WAIT_STEPS.findIndex((s) => sec < s.at);
  if (current < 0) current = WAIT_STEPS.length - 1;
  stepEls.forEach((li, i) => {
    li.className = i < current ? 'is-done' : i === current ? 'is-now' : '';
    li.querySelector('.tick').textContent = i < current ? '✓' : String(i + 1);
    if (i === current) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  const p = Math.min(0.95, sec / EXPECTED_S);
  bar.style.setProperty('--p', String(p));
  bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
}

function waiting(queued) {
  box.setAttribute('aria-busy', 'true');
  if (queued) {
    stopTicker();
    render(
      h('div', { class: 'loom', 'aria-hidden': 'true' }),
      h('h1', { text: 'Đã nhận yêu cầu của bạn' }),
      h('p', { class: 'lead', text: 'Hôm nay hệ thống đông khách. Chúng tôi sẽ gửi link bộ hồ sơ dùng thử cho bạn qua số điện thoại/Zalo trong 24h. Bạn có thể đóng trang này.' }),
    );
    return;
  }
  if (stepEls) return; // đã hiện, chỉ cập nhật theo thời gian
  stepEls = WAIT_STEPS.map((s, i) => h('li', {}, h('span', { class: 'tick', 'aria-hidden': 'true', text: String(i + 1) }), h('span', { text: s.text })));
  bar = h('div', { class: 'progress progress-wait', role: 'progressbar', 'aria-label': 'Tiến độ tạo bản dùng thử', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' });
  render(
    h('h1', { text: 'Đang tạo bản dùng thử…' }),
    bar,
    h('p', { class: 'lead', text: 'Khoảng 1–2 phút, vui lòng giữ trang này mở' }),
    h('ol', { class: 'wait-steps' }, stepEls),
    h('p', { class: 'muted', text: 'Xong, trang sẽ tự mở bộ hồ sơ dùng thử: website mẫu, ảnh, bản phân tích PDF và Word.' }),
  );
  paint();
  ticker = setInterval(paint, 1000);
}
function stopTicker() {
  if (ticker) clearInterval(ticker);
  ticker = null; stepEls = null; bar = null;
}

function failed(text) {
  stopTicker();
  box.removeAttribute('aria-busy');
  render(
    h('h1', { text: 'Chưa tạo được bản dùng thử' }),
    h('p', { class: 'lead', text }),
    h('a', { class: 'btn btn-ghost', href: 'index.html', text: 'Về trang chủ' }),
  );
}

function ready(job) {
  if (stepEls) {
    for (const li of stepEls) { li.className = 'is-done'; li.querySelector('.tick').textContent = '✓'; li.removeAttribute('aria-current'); }
    bar.style.setProperty('--p', '1');
  }
  if (ticker) clearInterval(ticker);
  const s = loadSession();
  if (s.sessionId && s.jobId === jobId) saveSession({ siteId: job.siteId });
  const fallback = /^[a-z0-9-]{1,64}$/.test(job.siteId || '') ? `${API_BASE}/package/${job.siteId}` : 'index.html';
  location.href = safeUrl(job.url) || fallback;
}

/** Kết thúc nếu job đã xong; trả true khi đã xử lý. */
function finish(job) {
  if (job.state === 'ready') { ready(job); return true; }
  if (job.state === 'failed') { failed(job.error || DEFAULT_FAIL); return true; }
  return false;
}

/** Chờ hàng đợi / runner khác: hỏi /api/status, giãn dần 3s → 10s. */
async function poll(delay) {
  const r = await api(`/api/status/${encodeURIComponent(jobId)}`, { timeoutMs: 20000 });
  if (r.ok) {
    if (finish(r.data)) return;
    waiting(r.data.state === 'queued');
  } else if (r.status >= 400 && r.status < 500) {
    failed(r.data.error); return;
  }
  setTimeout(() => poll(Math.min(Math.round(delay * 1.5), MAX_DELAY)), delay);
}

/**
 * Trang này chạy việc tạo demo: gọi POST /api/jobs/:id/run lặp lại, mỗi lần máy chủ chạy một bước rồi trả
 * `next`: run (gọi tiếp) · wait (đợi rồi gọi tiếp) · poll (đang xếp hàng → hỏi /api/status) · done.
 */
async function drive() {
  let errors = 0;
  for (;;) {
    const r = await api(`/api/jobs/${encodeURIComponent(jobId)}/run`, { json: {}, timeoutMs: RUN_TIMEOUT });
    if (r.ok) {
      errors = 0;
      const job = r.data;
      if (finish(job)) return;
      if (job.next === 'poll' || job.state === 'queued') { waiting(job.state === 'queued'); poll(FIRST_DELAY); return; }
      waiting(false);
      await sleep(job.next === 'wait' ? WAIT_DELAY : RUN_GAP);
      continue;
    }
    if (r.status >= 400 && r.status < 500) { failed(r.data.error); return; }
    // Mất mạng / hết giờ / lỗi máy chủ: xem trạng thái rồi thử chạy lại, giãn dần.
    errors++;
    const st = await api(`/api/status/${encodeURIComponent(jobId)}`, { timeoutMs: 20000 });
    if (st.ok && finish(st.data)) return;
    await sleep(Math.min(FIRST_DELAY * errors, MAX_DELAY));
  }
}

if (!/^[A-Za-z0-9]{1,64}$/.test(jobId)) failed('Đường dẫn không đúng. Vui lòng mở lại link từ trang trò chuyện.');
else { waiting(false); drive(); }

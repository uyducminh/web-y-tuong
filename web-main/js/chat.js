import { api, h, loadSession, saveSession, normalizePhone, qs, safeUrl, TURNSTILE_SITEKEY } from './api.js';
import { checkFiles, sendFiles, MAX_IMAGES } from './upload.js';
import { renderStepBar, renderChoices, renderSummary } from './steps.js';

const NEEDS = {
  'gioi-thieu': 'Tôi cần website giới thiệu đơn vị và sản phẩm.',
  'thu-lead': 'Tôi cần trang thu thông tin khách hàng quan tâm.',
  'ban-hang': 'Tôi cần website bán hàng, khách đặt qua Zalo.',
};
const TOTAL_TURNS = 30;
/** Tên dễ hiểu của các mục còn thiếu (missing[] từ Worker). */
const MISSING = {
  ten_don_vi: 'tên đơn vị', loai_hinh: 'loại hình', nganh: 'ngành nghề', dia_phuong: 'địa phương',
  san_pham: 'sản phẩm', diem_khac_biet: 'điểm khác biệt', khach_hang_muc_tieu: 'khách hàng chính',
  muc_tieu_chinh: 'mục tiêu website', hanh_dong_mong_muon: 'việc khách nên làm', cam_giac: 'phong cách',
  'lien_he.phone|zalo': 'số điện thoại hoặc Zalo',
};

const $ = (id) => document.getElementById(id);
const log = $('log');
const quick = $('quick');
const choicesBox = $('choices');
const stepsBox = $('steps');
const msg = $('msg');
const send = $('send');
const fileInput = $('file');
const fileBtn = $('file-btn');
const chatError = $('chat-error');
const genOpen = $('gen-open');
const genPanel = $('gen-panel');
const genForm = $('gen-form');
const genSubmit = $('gen-submit');
const genError = $('gen-error');

let locked = false;      // hết lượt / bắt buộc xác nhận
let busy = false;        // đang chờ trả lời
let uploading = false;   // đang gửi ảnh/tài liệu
let submitting = false;  // đang xác nhận + tạo bản dùng thử
let imagesSent = 0;
let docsSent = 0;
let lastBrief = null;    // phiếu yêu cầu mới nhất từ GET /api/brief (để điền sẵn SĐT)
const view = { step: { id: 'don_vi', index: 1, label: 'Đơn vị và ngành nghề' }, done: [], canConfirm: false, mustConfirm: false };

// ---------- phiên + Turnstile ----------
function turnstileToken() {
  if (!TURNSTILE_SITEKEY) return Promise.resolve('dev'); // chạy local không có site key
  return new Promise((resolve, reject) => {
    const render = () => {
      try {
        const slot = document.createElement('div');
        document.getElementById('ts').replaceChildren(slot);
        window.turnstile.render(slot, {
          sitekey: TURNSTILE_SITEKEY, appearance: 'interaction-only', language: 'vi',
          callback: resolve, 'error-callback': () => reject(new Error('turnstile')),
        });
      } catch (e) { reject(e); }
    };
    if (window.turnstile) { render(); return; }
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = render;
    s.onerror = () => reject(new Error('turnstile'));
    document.head.append(s);
  });
}

let sessionPromise = null;
function ensureSession() {
  const saved = loadSession().sessionId;
  if (saved) return Promise.resolve(saved);
  if (!sessionPromise) {
    sessionPromise = (async () => {
      let token;
      try { token = await turnstileToken(); } catch {
        throw new Error('Không xác minh được trình duyệt. Vui lòng tải lại trang và thử lại.');
      }
      const r = await api('/api/session', { json: { turnstileToken: token } });
      if (!r.ok || typeof r.data.sessionId !== 'string') throw new Error(r.data.error);
      saveSession({ sessionId: r.data.sessionId });
      return r.data.sessionId;
    })();
    sessionPromise.catch(() => { sessionPromise = null; });
  }
  return sessionPromise;
}

const EXPIRED = 'Phiên trò chuyện đã hết hạn nên trợ lý không còn nhớ các câu trước.';
const EXPIRED_CONFIRM = `${EXPIRED} Bạn trả lời lại vài câu (gõ vào ô bên dưới) để làm bản dùng thử nhé.`;

/** Phiên ở Worker không còn (404): bỏ id đã lưu VÀ promise đã cache, để lần gửi sau tạo phiên mới. */
function dropSession() {
  saveSession({ sessionId: undefined });
  sessionPromise = null;
  locked = false;
  imagesSent = 0; docsSent = 0; lastBrief = null;
  setView({ step: { id: 'don_vi', index: 1, label: 'Đơn vị và ngành nghề' }, done: [], canConfirm: false, mustConfirm: false });
  setTurns(TOTAL_TURNS);
  syncComposer();
}

// ---------- hiển thị ----------
function showError(text) {
  chatError.textContent = text || '';
  chatError.hidden = !text;
}
function scrollDown() {
  log.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' });
}
function bubble(who, text, extra) {
  const el = h('div', { class: `msg msg-${who}` }, h('p', { text }), extra);
  log.append(el);
  scrollDown();
  return el;
}
function setQuickReplies(list) {
  quick.replaceChildren(...(list || []).slice(0, 4).map((t) =>
    h('button', { type: 'button', class: 'chip', text: t, onclick: () => sendText(t) })));
  quick.hidden = !quick.children.length;
  if (!quick.hidden) quick.scrollIntoView({ block: 'end', behavior: 'smooth' });
}
function setChoices(choices) {
  const el = choices ? renderChoices(choices, (t) => sendText(t)) : null;
  choicesBox.replaceChildren(...(el ? [el] : []));
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
const genAllowed = () => view.mustConfirm || (view.canConfirm && view.step.id === 'xac_nhan');
function setView(v) {
  if (v.step && typeof v.step.index === 'number') view.step = v.step;
  if (Array.isArray(v.done)) view.done = v.done;
  if (typeof v.canConfirm === 'boolean') view.canConfirm = v.canConfirm;
  if (typeof v.mustConfirm === 'boolean') view.mustConfirm = v.mustConfirm;
  const open = $('stepbar')?.open;
  const bar = renderStepBar(view);
  bar.open = !!open;
  stepsBox.replaceChildren(bar);
  genOpen.hidden = !genAllowed();
  if (genOpen.hidden) { genPanel.hidden = true; genOpen.setAttribute('aria-expanded', 'false'); }
}
function setTurns(left) {
  if (typeof left !== 'number') return;
  $('turns').textContent = left > 0 ? `Còn ${left}/${TOTAL_TURNS} lượt` : 'Đã hết lượt hỏi đáp';
}
function syncComposer() {
  const off = locked || busy;
  msg.disabled = locked;
  send.disabled = off;
  for (const b of document.querySelectorAll('[data-need], .chip, .choice, .btn-edit')) b.disabled = off;
  // Không gửi tệp / xác nhận khi trợ lý đang trả lời: hai yêu cầu cùng sửa một phiên.
  fileBtn.disabled = busy || uploading;
  genSubmit.disabled = busy || submitting;
  msg.placeholder = locked ? 'Đã hết lượt hỏi đáp — bấm “Tạo bản dùng thử”' : 'Nhập trả lời…';
}
function lock(reason) {
  locked = true;
  if (genAllowed()) genOpen.classList.add('is-ready');
  setQuickReplies([]);
  setChoices(null);
  if (reason) bubble('bot', reason);
  syncComposer();
}

// ---------- tóm tắt ----------
async function fetchBrief({ quiet = false } = {}) {
  const sessionId = loadSession().sessionId;
  if (!sessionId) return null;
  const r = await api(`/api/brief/${encodeURIComponent(sessionId)}`, { timeoutMs: 20000 });
  if (r.ok && r.data.brief) { lastBrief = r.data.brief; return r.data; }
  if (r.status === 404 && !quiet) dropSession();
  return null;
}
async function showSummary() {
  const data = await fetchBrief({ quiet: true });
  if (!data || !(data.canConfirm && data.step?.id === 'xac_nhan')) return;
  $('summary')?.remove();
  const el = renderSummary(data.brief, (_id, label) => sendText(`Mình muốn sửa phần “${label}”.`), openGen,
    { images: imagesSent, docs: docsSent });
  log.append(el);
  syncComposer();
  el.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// ---------- gửi tin ----------
async function sendText(raw) {
  const text = String(raw || '').trim();
  if (!text || busy || locked) return;
  showError('');
  busy = true;
  document.querySelector('.needs')?.remove();
  $('summary')?.remove();
  setQuickReplies([]);
  setChoices(null);
  syncComposer();
  const mine = bubble('me', text);
  const typing = h('div', { class: 'msg msg-bot is-typing', 'aria-label': 'Trợ lý đang trả lời' }, h('p', { text: 'Đang trả lời…' }));
  log.append(typing); scrollDown();

  let r;
  try {
    const sessionId = await ensureSession();
    r = await api('/api/chat', { json: { sessionId, text } });
  } catch (e) {
    r = { ok: false, status: 0, data: { error: e.message } };
  }
  typing.remove();
  busy = false;

  if (r.ok && r.data.capped) {
    msg.value = '';
    lock(view.canConfirm
      ? 'Hôm nay trợ lý đã hết lượt tư vấn. Thông tin của bạn đã đủ: bấm “Tạo bản dùng thử” để nhận bản dùng thử.'
      : 'Hôm nay trợ lý đã hết lượt tư vấn. Bạn vui lòng quay lại sau ít giờ để trả lời tiếp, thông tin đã trả lời vẫn được giữ.');
  } else if (r.ok) {
    msg.value = '';
    bubble('bot', String(r.data.reply || ''));
    setView(r.data);
    setTurns(r.data.turnsLeft);
    if (r.data.mustConfirm || r.data.turnsLeft <= 0) {
      lock('Đã hết lượt hỏi đáp. Bạn bấm “Tạo bản dùng thử” ở dưới, để lại số điện thoại để xác nhận nhé.');
    } else {
      setChoices(r.data.choices);
      setQuickReplies(r.data.quickReplies);
    }
    if (r.data.canConfirm && r.data.step?.id === 'xac_nhan') await showSummary();
  } else if (r.status === 409) {
    msg.value = '';
    mine.remove();
    setView({ mustConfirm: true });
    setTurns(0);
    lock(r.data.error);
  } else {
    mine.remove();
    if (!msg.value) msg.value = text; // giữ lại để khách bấm Gửi lại
    if (r.status === 404) { dropSession(); showError(`${EXPIRED} Bấm “Gửi” để bắt đầu phiên mới.`); }
    else showError(r.data.error);
  }
  syncComposer();
}

$('composer').addEventListener('submit', (e) => { e.preventDefault(); sendText(msg.value); });
msg.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendText(msg.value); }
});
for (const b of document.querySelectorAll('[data-need]')) {
  b.addEventListener('click', () => sendText(NEEDS[b.dataset.need]));
}

// ---------- file ----------
fileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  fileInput.value = '';
  if (!files.length) return;
  const checked = checkFiles(files, imagesSent);
  showError(checked.errors.join(' '));
  if (!checked.images.length && !checked.docs.length && !checked.sheets.length) return;

  let sessionId;
  try { sessionId = await ensureSession(); } catch (e) { showError(e.message); return; }
  uploading = true;
  syncComposer();
  const errors = [...checked.errors];
  const thumbs = h('div', { class: 'thumbs' });
  const docNames = [];
  const sheetNames = [];
  const progress = $('upload-progress');
  let lost = false;
  const sent = await sendFiles(checked, sessionId, {
    onImage: (f) => {
      const url = URL.createObjectURL(f);
      thumbs.append(h('img', { src: url, alt: f.name, width: 64, height: 64, onload: () => URL.revokeObjectURL(url) }));
    },
    onDoc: (f, chars) => docNames.push(`${f.name} (${chars.toLocaleString('vi-VN')} ký tự)`),
    onSheet: (f, { products }) => sheetNames.push(products ? `${f.name} (${products} sản phẩm)` : f.name),
    onError: (m) => { errors.push(m); showError(errors.join(' ')); },
    onProgress: (t) => { progress.textContent = t; progress.hidden = !t; },
    onSessionLost: () => { lost = true; dropSession(); errors.push(`${EXPIRED} Bạn chọn lại ảnh/tài liệu để gửi vào phiên mới.`); showError(errors.join(' ')); },
  });
  uploading = false;
  syncComposer();
  if (lost) return; // ảnh đã gửi thuộc phiên cũ, không tính
  imagesSent += sent;
  docsSent += docNames.length + sheetNames.length;
  if (sent) bubble('me', `Đã nhận ${sent} ảnh. Bạn còn gửi được ${MAX_IMAGES - imagesSent} ảnh.`, thumbs);
  if (docNames.length) bubble('me', `Đã đọc tài liệu: ${docNames.join(', ')}.`);
  if (sheetNames.length) bubble('me', `Đã đọc bảng tính: ${sheetNames.join(', ')}.`);
});

// ---------- xác nhận + tạo bản dùng thử ----------
function prefill() {
  const lh = lastBrief?.lien_he || {};
  const phone = $('phone');
  if (!phone.value) phone.value = lh.phone || lh.zalo || '';
}
function openGen() {
  genPanel.hidden = false;
  genOpen.setAttribute('aria-expanded', 'true');
  prefill();
  if (!lastBrief) fetchBrief({ quiet: true }).then(prefill).catch(() => {});
  genPanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('name').focus({ preventScroll: true });
}
genOpen.addEventListener('click', openGen);
$('gen-close').addEventListener('click', () => {
  genPanel.hidden = true;
  genOpen.setAttribute('aria-expanded', 'false');
  if (!genOpen.hidden) genOpen.focus();
});

function genFail(text, link) {
  genError.replaceChildren(h('span', { text }));
  if (link) genError.append(' ', h('a', { href: link, target: '_blank', rel: 'noopener', text: 'Mở bộ hồ sơ dùng thử của bạn' }));
  genError.hidden = false;
}
function resetSubmit() {
  submitting = false;
  genSubmit.disabled = busy;
  genSubmit.textContent = 'Gửi và tạo bản dùng thử';
}

genForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submitting || busy) return;
  genError.hidden = true;
  const name = $('name').value.trim();
  const rawPhone = $('phone').value.trim();
  if (!name) { genFail('Vui lòng nhập tên của bạn.'); $('name').focus(); return; }
  if (!rawPhone) { genFail('Vui lòng nhập số điện thoại hoặc Zalo để nhận bản dùng thử.'); $('phone').focus(); return; }
  const phone = normalizePhone(rawPhone);
  if (!phone) { genFail('Số điện thoại chưa đúng. Vui lòng nhập số di động 10 chữ số, ví dụ 0912 345 678.'); $('phone').focus(); return; }

  submitting = true;
  genSubmit.disabled = true; // chặn bấm 2 lần ngay lập tức
  genSubmit.textContent = 'Đang gửi…';
  let sessionId;
  try { sessionId = await ensureSession(); } catch (err) { resetSubmit(); genFail(err.message); return; }

  const c = await api('/api/brief/confirm', { json: { sessionId, lien_he: { phone }, name } });
  if (!c.ok) {
    resetSubmit();
    if (c.status === 404) {
      dropSession(); // ẩn cả khung này: phiên mới phải trả lời lại trước khi xác nhận
      showError(EXPIRED_CONFIRM);
      return;
    }
    const miss = Array.isArray(c.data.missing) ? c.data.missing.map((m) => MISSING[m] || m) : [];
    genFail(miss.length ? `${c.data.error} Còn thiếu: ${miss.join(', ')}.` : c.data.error);
    return;
  }

  const r = await api('/api/generate', { json: { sessionId, phone, name } });
  if (r.ok && r.data.jobId) {
    saveSession({ jobId: r.data.jobId });
    location.href = `status.html?job=${encodeURIComponent(r.data.jobId)}`;
    return;
  }
  resetSubmit();
  if (r.status === 404) {
    dropSession();
    showError(EXPIRED_CONFIRM);
    return;
  }
  genFail(r.data.error, r.status === 409 ? safeUrl(r.data.url) : '');
});

// ---------- khởi động ----------
setView({});
setTurns(TOTAL_TURNS);
const prev = loadSession();
if (prev.jobId) {
  bubble('bot', 'Bạn đã gửi yêu cầu tạo bản dùng thử trước đó.',
    h('a', { class: 'btn btn-ghost', href: `status.html?job=${encodeURIComponent(prev.jobId)}`, text: 'Xem trạng thái bản dùng thử' }));
}
syncComposer();
ensureSession().catch((e) => {
  showError(e.message);
  locked = true; syncComposer();
  genOpen.disabled = true;
});
// Quay lại trang giữa chừng: lấy bước hiện tại từ Worker.
if (prev.sessionId) {
  fetchBrief().then((d) => {
    if (!d) return;
    setView(d);
    if (d.canConfirm && d.step?.id === 'xac_nhan') showSummary();
  }).catch(() => {});
}
const need = qs('need');
if (NEEDS[need]) sendText(NEEDS[need]);

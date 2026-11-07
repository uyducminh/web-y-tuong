import { api, h, loadSession, saveSession, normalizePhone, qs, safeUrl, TURNSTILE_SITEKEY } from './api.js';
import { checkFiles, sendFiles, MAX_IMAGES } from './upload.js';

const NEEDS = {
  'gioi-thieu': 'Tôi cần website giới thiệu đơn vị và sản phẩm.',
  'thu-lead': 'Tôi cần trang thu thông tin khách hàng quan tâm.',
  'ban-hang': 'Tôi cần website bán hàng, khách đặt qua Zalo.',
};
const TOTAL_TURNS = 12;

const $ = (id) => document.getElementById(id);
const log = $('log');
const quick = $('quick');
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

let locked = false;      // hết lượt / bắt buộc tạo demo
let busy = false;        // đang chờ trả lời
let imagesSent = 0;

// ---------- phiên + Turnstile ----------
function turnstileToken() {
  if (!TURNSTILE_SITEKEY) return Promise.resolve('dev'); // chạy local không có site key
  return new Promise((resolve, reject) => {
    const render = () => {
      try {
        window.turnstile.render('#ts', {
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
function setProgress(p) {
  if (!p || typeof p.filled !== 'number') return;
  const total = p.total || 10;
  const filled = Math.max(0, Math.min(total, p.filled));
  $('progress-text').textContent = `Đã đủ ${filled}/${total} thông tin`;
  const bar = $('progress');
  bar.setAttribute('aria-valuenow', String(filled));
  bar.style.setProperty('--p', String(filled / total));
}
function setTurns(left) {
  if (typeof left !== 'number') return;
  $('turns').textContent = left > 0 ? `Còn ${left}/${TOTAL_TURNS} lượt hỏi đáp` : 'Đã hết lượt hỏi đáp';
  if (left <= 3) genOpen.classList.add('is-ready');
}
function syncComposer() {
  const off = locked || busy;
  msg.disabled = locked;
  send.disabled = off;
  for (const b of document.querySelectorAll('[data-need], .chip')) b.disabled = off;
  msg.placeholder = locked ? 'Đã đủ lượt hỏi đáp — bấm “Tạo bản dùng thử”' : 'Nhập trả lời…';
}
function lock(reason) {
  locked = true;
  genOpen.classList.add('is-ready');
  setQuickReplies([]);
  if (reason) bubble('bot', reason);
  syncComposer();
}

// ---------- gửi tin ----------
async function sendText(raw) {
  const text = String(raw || '').trim();
  if (!text || busy || locked) return;
  showError('');
  busy = true;
  document.querySelector('.needs')?.remove();
  setQuickReplies([]);
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
    lock('Hôm nay trợ lý đã hết lượt tư vấn. Bạn bấm “Tạo bản dùng thử” và để lại tên, số điện thoại — chúng tôi sẽ gửi bản dùng thử cho bạn trong 24h.');
  } else if (r.ok) {
    msg.value = '';
    bubble('bot', String(r.data.reply || ''));
    setProgress(r.data.progress);
    setTurns(r.data.turnsLeft);
    if (r.data.mustGenerate || r.data.turnsLeft <= 0) lock('Mình đã có đủ thông tin để làm bản dùng thử. Bạn bấm “Tạo bản dùng thử” ở dưới nhé.');
    else setQuickReplies(r.data.quickReplies);
  } else if (r.status === 409) {
    msg.value = '';
    mine.remove();
    setTurns(0);
    lock(r.data.error);
  } else {
    mine.remove();
    if (!msg.value) msg.value = text; // giữ lại để khách bấm Gửi lại
    if (r.status === 404) saveSession({ sessionId: undefined });
    showError(r.data.error);
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
  if (!checked.images.length && !checked.docs.length) return;

  let sessionId;
  try { sessionId = await ensureSession(); } catch (e) { showError(e.message); return; }
  fileBtn.disabled = true;
  const errors = [...checked.errors];
  const thumbs = h('div', { class: 'thumbs' });
  const docNames = [];
  const progress = $('upload-progress');
  const sent = await sendFiles(checked, sessionId, {
    onImage: (f) => {
      const url = URL.createObjectURL(f);
      thumbs.append(h('img', { src: url, alt: f.name, width: 64, height: 64, onload: () => URL.revokeObjectURL(url) }));
    },
    onDoc: (f, chars) => docNames.push(`${f.name} (${chars.toLocaleString('vi-VN')} ký tự)`),
    onError: (m) => { errors.push(m); showError(errors.join(' ')); },
    onProgress: (t) => { progress.textContent = t; progress.hidden = !t; },
  });
  imagesSent += sent;
  fileBtn.disabled = false;
  if (sent) bubble('me', `Đã nhận ${sent} ảnh. Bạn còn gửi được ${MAX_IMAGES - imagesSent} ảnh.`, thumbs);
  if (docNames.length) bubble('me', `Đã đọc tài liệu: ${docNames.join(', ')}.`);
});

// ---------- tạo bản dùng thử ----------
genOpen.addEventListener('click', () => {
  genPanel.hidden = false;
  genOpen.setAttribute('aria-expanded', 'true');
  genPanel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  $('name').focus({ preventScroll: true });
});
$('gen-close').addEventListener('click', () => {
  genPanel.hidden = true;
  genOpen.setAttribute('aria-expanded', 'false');
  genOpen.focus();
});

function genFail(text, link) {
  genError.replaceChildren(h('span', { text }));
  if (link) genError.append(' ', h('a', { href: link, target: '_blank', rel: 'noopener', text: 'Mở bản dùng thử của bạn' }));
  genError.hidden = false;
}

genForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (genSubmit.disabled) return;
  genError.hidden = true;
  const name = $('name').value.trim();
  const rawPhone = $('phone').value.trim();
  if (!name) { genFail('Vui lòng nhập tên của bạn.'); $('name').focus(); return; }
  if (!rawPhone) { genFail('Vui lòng nhập số điện thoại hoặc Zalo để nhận bản dùng thử.'); $('phone').focus(); return; }
  const phone = normalizePhone(rawPhone);
  if (!phone) { genFail('Số điện thoại chưa đúng. Vui lòng nhập số di động 10 chữ số, ví dụ 0912 345 678.'); $('phone').focus(); return; }

  genSubmit.disabled = true; // chặn bấm 2 lần ngay lập tức
  genSubmit.textContent = 'Đang gửi…';
  let r;
  try {
    const sessionId = await ensureSession();
    r = await api('/api/generate', { json: { sessionId, phone, name } });
  } catch (err) {
    r = { ok: false, status: 0, data: { error: err.message } };
  }
  if (r.ok && r.data.jobId) {
    saveSession({ jobId: r.data.jobId, revisionsLeft: 3 });
    location.href = `status.html?job=${encodeURIComponent(r.data.jobId)}`;
    return;
  }
  genSubmit.disabled = false;
  genSubmit.textContent = 'Gửi và tạo bản dùng thử';
  genFail(r.data.error, r.status === 409 ? safeUrl(r.data.url) : '');
});

// ---------- khởi động ----------
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
const need = qs('need');
if (NEEDS[need]) sendText(NEEDS[need]);

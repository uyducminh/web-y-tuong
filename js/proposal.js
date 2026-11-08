// Trang đề xuất cũ: nay nội dung nằm ở trang "Bộ hồ sơ dùng thử" do Worker phục vụ. Giữ link cũ (PayOS cancelUrl, tin nhắn đã gửi).
import { API_BASE, qs } from './api.js';

const siteId = qs('site');
if (/^[a-z0-9-]{1,64}$/.test(siteId)) {
  location.replace(`${API_BASE}/package/${encodeURIComponent(siteId)}`);
} else {
  const root = document.getElementById('proposal');
  root.removeAttribute('aria-busy');
  root.querySelector('p').textContent = 'Đường dẫn không đúng. Vui lòng mở lại link bộ hồ sơ dùng thử đã nhận.';
}

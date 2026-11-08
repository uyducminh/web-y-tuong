import type { TemplateId } from '@sme/schema';
import { SHARED, TEMPLATE_FILES } from './templates.gen';

export const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Prevents an embedded file from closing its own <style>/<script> element early. */
const safeInline = (s: string, tag: 'style' | 'script') => s.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');

const LEAD = '\u0000LEAD\u0000';
const PLATFORM = '\u0000PLATFORM\u0000';
const shells = new Map<TemplateId, string>();

/** index.html with base.css/theme.css inlined as <style> and render.js inlined as one module script; built once per template. */
function shell(template: TemplateId): string {
  const cached = shells.get(template);
  if (cached) return cached;
  const t = TEMPLATE_FILES[template];
  if (!t) throw new Error(`unknown template ${template}`);
  let html = t.html;
  const swap = (re: RegExp, to: string) => {
    if (!re.test(html)) throw new Error(`template ${template}: ${re} not found`);
    html = html.replace(re, () => to);
  };
  // No /favicon.ico on the Worker: an empty inline icon avoids a 404 on every demo view.
  swap(/<meta charset="utf-8">/, '<meta charset="utf-8">\n  <link rel="icon" href="data:,">');
  swap(/<meta name="lead-endpoint" content="[^"]*">/, `<meta name="lead-endpoint" content="${LEAD}">`);
  swap(/<meta name="platform-name" content="[^"]*">/, `<meta name="platform-name" content="${PLATFORM}">`);
  swap(/<link rel="stylesheet" href="\.\/base\.css">/, `<style>\n${safeInline(SHARED.baseCss, 'style')}</style>`);
  swap(/<link rel="stylesheet" href="\.\/theme\.css">/, `<style>\n${safeInline(t.theme, 'style')}</style>`);
  swap(/<script type="module">\s*import\s*\{\s*boot\s*\}\s*from\s*'\.\/render\.js';?\s*boot\(\);?\s*<\/script>/,
    `<script type="module">\n${safeInline(SHARED.renderJs, 'script')}\nboot();\n</script>`);
  shells.set(template, html);
  return html;
}

/**
 * The demo page for `template`: its index.html with CSS/JS inlined (the `import {boot} from './render.js'` replaced by
 * the file itself) and the lead-endpoint / platform-name metas filled in (escaped). Throws if the template markup
 * changed shape, so drift is caught by the tests rather than shipping a page that loads nothing.
 */
export function demoHtml(template: TemplateId, o: { leadEndpoint: string; platformName: string }): string {
  return shell(template).split(LEAD).join(escapeHtml(o.leadEndpoint)).split(PLATFORM).join(escapeHtml(o.platformName));
}

/** 410 page: the trial is over. `phone` is config, still escaped. */
export function goneHtml(o: { platformName: string; contactPhone: string }): string {
  const phone = o.contactPhone.trim();
  const tel = phone.replace(/[^\d+]/g, '');
  const contact = phone
    ? `<p>Để tiếp tục dùng website, vui lòng liên hệ SĐT/Zalo: <a href="tel:${escapeHtml(tel)}">${escapeHtml(phone)}</a>${tel ? ` · <a href="https://zalo.me/${escapeHtml(tel)}">Nhắn Zalo</a>` : ''}</p>`
    : '<p>Để tiếp tục dùng website, vui lòng liên hệ đội ngũ hỗ trợ.</p>';
  return `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bản dùng thử đã hết hạn</title>
  <style>body{margin:0;font:16px/1.6 system-ui,sans-serif;color:#1f2933;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:1rem;text-align:center}main{max-width:480px}a{color:#2E7D32}</style>
</head>
<body>
  <main>
    <h1>Bản dùng thử đã hết hạn</h1>
    <p>Website mẫu này do ${escapeHtml(o.platformName)} tạo đã hết thời gian dùng thử.</p>
    ${contact}
  </main>
</body>
</html>
`;
}

/** 404 page for /d/ (plain Vietnamese). */
export const notFoundHtml = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Không tìm thấy</title></head>
<body><main style="font:16px/1.6 system-ui,sans-serif;text-align:center;padding:3rem 1rem"><h1>Không tìm thấy website mẫu</h1><p>Đường dẫn không đúng hoặc website đã bị xoá.</p></main></body></html>
`;

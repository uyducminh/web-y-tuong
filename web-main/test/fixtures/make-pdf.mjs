// One-off generator for test/fixtures/hop-tac-xa.pdf (committed). Run: node test/fixtures/make-pdf.mjs
// Uses the system Chrome so the PDF has real embedded fonts + ToUnicode maps (like PDFs customers export).
import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('./hop-tac-xa.pdf', import.meta.url));
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.setContent(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif">
<h1>Hợp tác xã Nông nghiệp Cầu Đất</h1>
<p>Chuyên trồng và chế biến cà phê Arabica, chè Ô long tại Lâm Đồng.</p>
<p>Bảng giá: Cà phê rang xay 250g — 180.000đ; Chè Ô long 200g — 220.000đ.</p>
</body>`);
await page.pdf({ path: out, format: 'A5' });
await browser.close();
console.log('wrote', out);

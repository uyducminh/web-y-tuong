# SME MVP Builder (Nhóm A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khách SME/HTX chat với AI, gửi tài liệu/ảnh, tự nhận link web demo trên GitHub Pages trong khoảng 1–2 phút, rồi thanh toán VietQR (từ 10.000.000đ). Toàn bộ không cần người can thiệp và không có database.

**Architecture:** Gồm 4 phần:
- Web chính: trang tĩnh, không có bước build, chạy trên Cloudflare Pages.
- Một Cloudflare Worker: giữ mọi bí mật; điều phối Claude API, GitHub App, PayOS, Google Sheet; dùng KV để lưu trạng thái.
- 3 repo template: HTML/JS thuần, render nội dung từ `site.json`.
- Phần dùng chung: schema `site.json` (zod), dùng cho cả Worker lẫn test.

Mọi dịch vụ bên ngoài được bọc trong interface và truyền vào handler qua `Deps`, để test dùng bản giả (fake) thay vì mock mạng.

**Tech Stack:** TypeScript 5, pnpm workspaces, Cloudflare Workers + KV + Turnstile + Cron, wrangler 3, zod 3, vitest + `@cloudflare/vitest-pool-workers`, jsdom, Playwright, Claude Messages API, GitHub REST API (GitHub App), PayOS API v2, Google Apps Script. Thư viện chạy trên trình duyệt: pdf.js, mammoth.js (CDN jsdelivr).

**Spec:** `docs/superpowers/specs/2026-11-08-sme-mvp-builder-design.md`

## Global Constraints

- Không database, không đăng nhập, không OTP. Toàn bộ trạng thái nằm trong Cloudflare KV và một Google Sheet.
- Template và web chính viết bằng HTML/CSS/JS thuần, **không có bước build**.
- Toàn bộ chữ hiển thị cho khách bằng **tiếng Việt có dấu**.
- Chat: tối đa **12 lượt**; từ **lượt 9** AI tóm tắt và đề nghị tạo demo; mỗi lượt AI hỏi tối đa 2 câu và gợi ý 2–4 câu trả lời nhanh.
- Brief có đúng 10 mục: `nhu_cau, ten_don_vi, nganh, san_pham_chinh, khach_hang_muc_tieu, diem_manh, lien_he, mau_sac, muc_tieu_web, tham_khao`.
- Upload: tối đa **10 file**, mỗi file **≤ 5MB**, chỉ nhận **jpg/png/webp**. Chữ tách từ PDF/Word tối đa **8.000 ký tự**.
- Mỗi IP tối đa **3 phiên/ngày**; mỗi SĐT **1 demo**; tối đa **3 lượt sửa**; demo bị gỡ sau **30 ngày** nếu chưa thanh toán; cron chạy lúc `0 3 * * *`.
- Repo demo đặt tên `demo-<slug>-<4 ký tự ngẫu nhiên>`, để **public**, nằm trong GitHub Org dành riêng cho demo; xác thực bằng **GitHub App**, không dùng PAT cá nhân.
- Khoá xem lead dài **32 ký tự ngẫu nhiên**. Gói triển khai **từ 10.000.000đ**.
- Giao diện ưu tiên điện thoại; kiểm tra ở chiều rộng **375px và 1280px**.
- Model đọc từ biến môi trường: `CHAT_MODEL` (mặc định `claude-haiku-5-5`), `GEN_MODEL` (mặc định `claude-sonnet-5-5`). Đơn giá token cũng đọc từ biến môi trường, không hard-code.
- `PUBLISHER=github|cloudflare` chọn nơi xuất bản; MVP chỉ làm `github`, nhưng giữ sẵn interface.
- Màn hình chat luôn có dòng nhắc: "Bản dùng thử là công khai, vui lòng không gửi thông tin nhạy cảm."

## Review Focus

1. **Nội dung AI chứa HTML/script hoặc URL `javascript:`.** Template không được thực thi những nội dung này. Renderer chỉ dùng `textContent`, và URL chỉ chấp nhận `https:`, `http:`, `tel:`, `mailto:`, `https://zalo.me/` (test ở Task 2).
2. **SĐT nhập theo nhiều kiểu** (`0912 345 678`, `+84912345678`, `84912345678`, `0912.345.678`). Tất cả phải chuẩn hoá về cùng một số, để luật "1 SĐT 1 demo" không bị lách (test ở Task 1).
3. **Tên có dấu tiếng Việt** (`HTX Cà phê Cầu Đất`). Slug phải ra `htx-ca-phe-cau-dat` (đ chuyển thành d), không rỗng, tối đa 30 ký tự (test ở Task 1).
4. **Khách bấm "Tạo demo" hai lần hoặc mở hai tab.** Không được tạo 2 repo; lần gọi thứ hai trả lại `jobId` cũ (test ở Task 8).
5. **`site.json` trỏ tới ảnh không tồn tại**, do AI bịa đường dẫn hoặc khách không gửi ảnh. Generator phải loại các đường dẫn `assets/*` không có trong danh sách upload; renderer ẩn ảnh lỗi thay vì hiện icon vỡ (test ở Task 2 và Task 7).

---

## File Structure

```
package.json, pnpm-workspace.yaml, tsconfig.base.json
packages/schema/src/
  site.ts          # SiteSchema (zod), type SiteJson, TEMPLATE_IDS
  brief.ts         # BriefSchema, BRIEF_KEYS, briefProgress()
  proposal.ts      # ProposalSchema
  normalize.ts     # slugify(), normalizePhone(), formatVnd()
  defaults.ts      # defaultSite(template, brief) -> SiteJson
packages/schema/test/*.test.ts
templates/_shared/render.js, base.css     # renderer dùng chung (ES module, không build)
templates/tpl-gioi-thieu|tpl-thu-lead|tpl-ban-hang/
  index.html, theme.css, site.json        # site.json mẫu để xem thử
templates/fixtures/*.json                 # 5 fixture cho Playwright
templates/test/render.test.ts, visual.spec.ts
scripts/sync-templates.ts                 # copy _shared vào từng template rồi đẩy lên repo template trên GitHub
worker/
  wrangler.toml
  src/index.ts           # router + scheduled()
  src/deps.ts            # interface Deps, makeDeps(env)
  src/kv.ts              # helper key/TTL
  src/http.ts            # json(), error(), getIp()
  src/clients/claude.ts, github.ts, payos.ts, sheet.ts, notify.ts, turnstile.ts
  src/publisher/types.ts, github-publisher.ts
  src/ai/prompts.ts, chat.ts, generate.ts, cost.ts
  src/routes/session.ts, chat.ts, upload.ts, generate.ts, status.ts, revise.ts,
             checkout.ts, payos-webhook.ts, leads.ts
  src/cron.ts
  test/fakes.ts, test/*.test.ts
web-main/
  index.html, chat.html, status.html, proposal.html, thanks.html
  js/api.js, chat.js, upload.js, extract.js, status.js, proposal.js
  css/main.css
sheet-bridge/Code.gs
docs/SETUP.md
```

---

### Task 1: Monorepo + package schema

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `packages/schema/{package.json,src/*.ts,test/*.test.ts}`
- Move: spec vào `docs/superpowers/specs/` (đã có sẵn)

**Interfaces:**
- Produces:
  - `TEMPLATE_IDS = ['tpl-gioi-thieu','tpl-thu-lead','tpl-ban-hang'] as const`
  - `SiteSchema`, `type SiteJson`, `SECTION_TYPES` (13 type theo spec §4.2)
  - `BriefSchema` (10 mục, tất cả optional; `lien_he: {phone?, zalo?, email?, address?}`; mỗi mục có thể kèm cờ `auto?: boolean` trong `meta.auto: string[]`)
  - `BRIEF_KEYS: readonly string[]`, `briefProgress(b: Brief): { filled: number; total: 10; missing: string[] }`
  - `ProposalSchema`: `{ summary, problems: string[], solution, packages: {name, priceVnd, items: string[]}[], roadmap: {step, desc}[] }`, trong đó `priceVnd >= 10_000_000`
  - `slugify(s: string): string`, `normalizePhone(s: string): string | null` (trả về dạng `0xxxxxxxxx`), `formatVnd(n: number): string`
  - `defaultSite(template: TemplateId, brief: Brief, siteId: string): SiteJson`

- [ ] **Step 1: `git init`, tạo workspace, cài `zod vitest typescript`; commit spec.**
- [ ] **Step 2: Viết test thất bại** trong `packages/schema/test/normalize.test.ts`:
```ts
expect(slugify('HTX Cà phê Cầu Đất')).toBe('htx-ca-phe-cau-dat');
expect(slugify('!!!')).toBe('site');                 // không bao giờ rỗng
expect(slugify('a'.repeat(80)).length).toBeLessThanOrEqual(30);
for (const p of ['0912 345 678','+84912345678','84912345678','0912.345.678'])
  expect(normalizePhone(p)).toBe('0912345678');
expect(normalizePhone('12345')).toBeNull();
expect(formatVnd(180000)).toBe('180.000đ');
```
  Trong `site.test.ts`: `defaultSite(t, {}, 'x')` phải pass `SiteSchema` với cả 3 template; một site có `color: 'red'` phải fail (yêu cầu `#RRGGBB`); `section.type: 'video'` phải fail.
  Trong `brief.test.ts`: `briefProgress({ten_don_vi:'A', nganh:'B'})` trả `{filled:2,total:10}`, và `missing` có `san_pham_chinh`. Với `ProposalSchema`, gói `priceVnd: 5_000_000` phải fail.
- [ ] **Step 3: Chạy `pnpm -F schema test`.** Kỳ vọng: FAIL.
- [ ] **Step 4: Cài đặt.** `slugify`: `normalize('NFD')`, bỏ dấu kết hợp, đổi `đ/Đ` thành `d`, chuyển chữ thường, thay ký tự ngoài `[a-z0-9]` bằng `-`, gộp các dấu `-` liên tiếp, cắt còn 30 ký tự, nếu rỗng thì trả `'site'`. `normalizePhone`: bỏ ký tự không phải số, đổi tiền tố `84` thành `0`, chỉ chấp nhận đúng 10 số bắt đầu bằng `0`. `defaultSite` tạo hero và các section mặc định theo từng template (bảng ở spec §4.1), đặt `demo.badge = true`.
- [ ] **Step 5: Chạy lại test.** Kỳ vọng: PASS.
- [ ] **Step 6: Commit** `feat(schema): site/brief/proposal schemas and VN normalizers`

### Task 2: Renderer dùng chung cho template

**Files:**
- Create: `templates/_shared/render.js`, `templates/_shared/base.css`, `templates/test/render.test.ts` (vitest + jsdom)

**Interfaces:**
- Consumes: kiểu dữ liệu `SiteJson` (Task 1). Chỉ dùng khi viết test; renderer là JS thuần.
- Produces (ES module):
  - `export async function boot(root = document.body)`: `fetch('site.json')` → `renderSite`
  - `export function renderSite(site, root, opts = { leadEndpoint })`
  - `export function safeUrl(u): string | null`
  - Mỗi section là một hàm `sections[type](data, site) => HTMLElement`. Type không biết thì bỏ qua.

- [ ] **Step 1: Viết test thất bại:**
```ts
renderSite({...base, hero:{title:'<img src=x onerror=alert(1)>',subtitle:'',cta:'Liên hệ'}}, root);
expect(root.querySelector('img[onerror]')).toBeNull();
expect(root.textContent).toContain('<img src=x');            // hiện dưới dạng chữ
expect(safeUrl('javascript:alert(1)')).toBeNull();
expect(safeUrl('https://zalo.me/0912345678')).toBe('https://zalo.me/0912345678');
expect(safeUrl('tel:0912345678')).toBe('tel:0912345678');
// ảnh lỗi bị ẩn
const img = root.querySelector('.hero img'); img.dispatchEvent(new Event('error'));
expect(img.hidden).toBe(true);
// giá hiển thị đúng
renderSite(siteWithProducts([{name:'Cà phê',price:180000}]), root);
expect(root.textContent).toContain('180.000đ');
// băng rôn demo
expect(root.querySelector('.demo-badge')).not.toBeNull();
// section type lạ không làm hỏng trang
expect(() => renderSite({...base, sections:[{type:'unknown'}]}, root)).not.toThrow();
// form lead gửi tới leadEndpoint, có trường honeypot ẩn tên "website"
expect(root.querySelector('form[data-lead] input[name=website]')).not.toBeNull();
```
- [ ] **Step 2: Chạy test.** Kỳ vọng: FAIL.
- [ ] **Step 3: Cài `render.js`.** Chỉ dùng `textContent`/`createElement`, không dùng `innerHTML` với dữ liệu khách. Màu thương hiệu gán vào CSS var `--brand`. Ảnh dùng `loading="lazy"` và ẩn đi khi `onerror`. Form lead `POST` JSON tới `${leadEndpoint}/lead/${site.siteId}`, rồi hiện thông báo "Đã gửi, chúng tôi sẽ liên hệ sớm". Nút đặt hàng mở `https://zalo.me/<zalo>` và chép nội dung đơn hàng vào clipboard. Cập nhật `<title>` và thẻ `og:` từ `site.seo`.
- [ ] **Step 4: Chạy test.** Kỳ vọng: PASS.
- [ ] **Step 5: Commit** `feat(templates): shared safe renderer`

### Task 3: Ba template + kiểm tra giao diện

**Files:**
- Create: `templates/tpl-*/index.html|theme.css|site.json`, `templates/fixtures/{htx-ca-phe,landing-hoi-thao,shop-dac-san,minimal,long-content}.json`, `templates/test/visual.spec.ts`, `scripts/sync-templates.ts`

**Interfaces:**
- Consumes: `boot` (Task 2), `SiteSchema`, `defaultSite` (Task 1)
- Produces:
  - Mỗi template là thư mục tự chạy được: `index.html` có `<script type="module">import {boot} from './render.js'; boot()</script>`.
  - `LEAD_ENDPOINT` đọc từ `<meta name="lead-endpoint">`.
  - `scripts/sync-templates.ts <org>`: copy `_shared/*` vào từng template rồi đẩy lên repo template trên GitHub (đánh dấu `is_template: true`).

- [ ] **Step 1: Viết `visual.spec.ts`.** Với mỗi cặp (template × fixture), trong đó `minimal` là site có 0 section và không có ảnh, mở bằng `npx serve`, chạy ở 375px và 1280px, rồi khẳng định:
  - Không có lỗi console.
  - `document.body.scrollWidth <= viewport + 1` (không tràn ngang).
  - Không có section nào rỗng (`section:empty` = 0).
  - Lưu ảnh chụp màn hình vào `templates/test/__shots__/`.
  - Thêm một test: mọi fixture phải pass `SiteSchema.parse`.
- [ ] **Step 2: Chạy `pnpm -F templates test:visual`.** Kỳ vọng: FAIL (chưa có template).
- [ ] **Step 3: Tạo 3 template** đúng danh sách section ở spec §4.1, dùng `theme.css` riêng cho mỗi template. Fixture `long-content` có tên dài 120 ký tự và 40 sản phẩm.
- [ ] **Step 4: Chạy test.** Kỳ vọng: PASS. Mở ảnh chụp màn hình kiểm tra bằng mắt.
- [ ] **Step 5: Commit** `feat(templates): gioi-thieu, thu-lead, ban-hang + visual tests`

### Task 4: Khung Worker, Deps, KV, endpoint tạo phiên

**Files:**
- Create: `worker/wrangler.toml`, `worker/src/{index.ts,deps.ts,kv.ts,http.ts}`, `worker/src/clients/turnstile.ts`, `worker/src/routes/session.ts`, `worker/test/{fakes.ts,session.test.ts}`

**Interfaces:**
- Produces:
```ts
interface Deps {
  kv: KVNamespace; now(): Date; rand(n: number): string;  // rand: chuỗi [a-z0-9] dài n
  turnstile: { verify(token: string, ip: string): Promise<boolean> };
  claude: ClaudeClient; publisher: Publisher; payos: PayosClient;
  sheet: SheetClient; notify: Notifier; config: Config;
}
type Session = { id: string; ip: string; createdAt: string; turns: number;
  brief: Brief; messages: {role:'user'|'assistant'; content: string}[];
  uploads: string[]; docsText: string; jobId?: string; siteId?: string };
```
  - `kv.ts`: `getJson<T>(kv,key)`, `putJson(kv,key,val,ttlSec?)`, `incr(kv,key,ttlSec): Promise<number>`
  - Tiền tố key: `sess:`, `ip:<ip>:<yyyymmdd>`, `phone:`, `cost:<yyyymmdd>`, `job:`, `site:`, `leads:`, `order:`, `queue:`, `up:<sessionId>:<n>`
  - `POST /api/session {turnstileToken}` → `{sessionId}`. Phiên có TTL 7 ngày.
  - `test/fakes.ts`: `makeTestDeps(overrides?)` dùng KV của miniflare và fake cho mọi client.
- [ ] **Step 1: Test thất bại:**
  - Token Turnstile sai thì trả 403.
  - Từ phiên thứ 4 của cùng một IP trong cùng ngày thì trả 429, kèm thông báo tiếng Việt.
  - Phiên hợp lệ được lưu trong KV với `turns: 0`.
  - Route không tồn tại trả 404 JSON.
  - CORS chỉ cho phép `config.webOrigin`.
- [ ] **Step 2: Chạy `pnpm -F worker test`.** Kỳ vọng: FAIL.
- [ ] **Step 3: Cài đặt.** Router viết tay theo method + path. `getIp` đọc header `CF-Connecting-IP`.
- [ ] **Step 4: Chạy test.** Kỳ vọng: PASS.
- [ ] **Step 5: Commit** `feat(worker): scaffold, deps, session endpoint`

### Task 5: Claude client, đếm chi phí, chat có khung

**Files:**
- Create: `worker/src/clients/claude.ts`, `worker/src/ai/{prompts.ts,chat.ts,cost.ts}`, `worker/src/routes/chat.ts`, `worker/test/chat.test.ts`

**Interfaces:**
- Consumes: `Deps`, `Session`, `getJson/putJson/incr` (Task 4); `BriefSchema`, `briefProgress` (Task 1)
- Produces:
```ts
interface ClaudeClient { callTool<T>(o: { model: string; system: string;
  messages: Msg[]; tool: { name: string; input_schema: object }; maxTokens: number })
  : Promise<{ input: T; usage: { input_tokens: number; output_tokens: number } }> }
// cost.ts
function costMicroUsd(model: string, usage, config): number
async function addCost(deps, microUsd): Promise<number>   // tổng chi phí trong ngày
async function overDailyCap(deps): Promise<boolean>
// chat.ts
type ChatReply = { reply: string; briefPatch: Partial<Brief>; quickReplies: string[]; readyToGenerate: boolean }
async function chatTurn(deps, s: Session, userText: string): Promise<ChatReply>
```
  - `POST /api/chat {sessionId, text}` → `{reply, quickReplies, progress, turnsLeft, mustGenerate}`
  - `callTool` dùng `tool_choice: {type:'tool', name}` để bắt AI trả về JSON có cấu trúc.
- [ ] **Step 1: Test thất bại** (fake Claude trả `ChatReply` theo kịch bản dựng sẵn):
  - `briefPatch` được gộp vào `session.brief`, và `progress.filled` tăng tương ứng.
  - Mỗi lượt `turns` tăng 1. Sau lượt 12 thì trả `mustGenerate: true`, và lượt thứ 13 bị từ chối với 409 mà không gọi Claude.
  - Từ lượt 9, system prompt phải có chỉ dẫn "tóm tắt và đề nghị tạo demo" (kiểm tra qua tham số mà fake nhận được).
  - Phần `missing` từ `briefProgress` được đưa vào system prompt.
  - `quickReplies` luôn bị cắt còn tối đa 4 mục.
  - `text` dài hơn 2.000 ký tự thì bị cắt bớt.
  - Khi `overDailyCap` là true, trả `{capped: true}` và không gọi Claude.
  - `costMicroUsd` tính đúng theo đơn giá trong config.
  - Claude lỗi 2 lần rồi mới thành công thì kết quả vẫn trả về; lỗi 3 lần thì trả 503 kèm thông báo tiếng Việt và phiên giữ nguyên `turns`.
- [ ] **Step 2: Chạy test.** Kỳ vọng: FAIL.
- [ ] **Step 3: Cài đặt.**
  - `prompts.ts`: system prompt tiếng Việt gồm vai trò tư vấn viên số hoá cho SME/HTX tỉnh, quy tắc tối đa 2 câu hỏi mỗi lượt, mời khách gửi logo/ảnh/bảng giá/link mẫu, và chèn `docsText` (≤ 8.000 ký tự) khi có.
  - `claude.ts`: gọi `POST https://api.anthropic.com/v1/messages` với các header `x-api-key`, `anthropic-version: 2023-06-01`; thử lại 2 lần với backoff 500ms rồi 1500ms.
- [ ] **Step 4: Chạy test.** Kỳ vọng: PASS.
- [ ] **Step 5: Commit** `feat(worker): guided chat with turn limit and daily cost cap`

### Task 6: Upload ảnh và chữ từ tài liệu

**Files:**
- Create: `worker/src/routes/upload.ts`, `worker/test/upload.test.ts`

**Interfaces:**
- Consumes: `Deps`, `Session` (Task 4)
- Produces:
  - `POST /api/upload` (multipart: `sessionId`, `file`) → `{path: 'assets/<n>-<slug>.<ext>'}`. Nội dung lưu ở key `up:<sessionId>:<n>`, TTL 7 ngày.
  - `POST /api/docs {sessionId, text}`: nối vào `session.docsText`, cắt tổng còn 8.000 ký tự.
- [ ] **Step 1: Test thất bại:**
  - File thứ 11 bị từ chối với 413.
  - File 5MB + 1 byte bị từ chối với 413.
  - File `image/gif` bị từ chối với 415.
  - File có đuôi `.png` nhưng magic bytes không phải PNG bị từ chối với 415. Phải kiểm tra magic bytes của jpg, png và webp.
  - Đường dẫn trả về được thêm vào `session.uploads`.
  - Hai lần gọi `/api/docs` với tổng 9.000 ký tự thì `docsText.length === 8000`.
- [ ] **Step 2: Chạy test.** Kỳ vọng: FAIL. **Step 3: Cài đặt.** **Step 4: Chạy test.** Kỳ vọng: PASS.
- [ ] **Step 5: Commit** `feat(worker): validated uploads and document text`

### Task 7: Sinh nội dung (site.json + proposal)

**Files:**
- Create: `worker/src/ai/generate.ts`, `worker/test/generate.test.ts`

**Interfaces:**
- Consumes: `ClaudeClient.callTool`, `addCost` (Task 5); `SiteSchema`, `ProposalSchema`, `defaultSite` (Task 1)
- Produces:
```ts
async function generateContent(deps, s: Session, siteId: string)
  : Promise<{ site: SiteJson; proposal: Proposal; usedFallback: boolean }>
async function reviseContent(deps, site: SiteJson, request: string, uploads: string[]): Promise<SiteJson>
function sanitizeAssets(site: SiteJson, uploads: string[]): SiteJson
```
- [ ] **Step 1: Test thất bại:**
  - Lần đầu fake trả JSON sai schema, lần hai trả JSON đúng: kết quả dùng JSON đúng, `usedFallback: false`, Claude được gọi đúng 2 lần.
  - Cả hai lần sai: `usedFallback: true`, các trường đúng của AI được gộp vào `defaultSite`, và kết quả vẫn pass `SiteSchema`.
  - `sanitizeAssets`: `hero.image: 'assets/9-khong-co.jpg'` không nằm trong `uploads` thì bị bỏ; URL `https://` được giữ lại.
  - `template` được chọn theo `brief.nhu_cau`.
  - Mục brief còn trống thì bị đánh dấu trong `brief.meta.auto`.
  - `demo.expires = now + 30 ngày`.
  - `reviseContent` giữ nguyên `siteId` và `demo`.
- [ ] **Step 2: Chạy test.** Kỳ vọng: FAIL.
- [ ] **Step 3: Cài đặt.** Dùng `GEN_MODEL`, một lần gọi tool trả về `{site, proposal}`; `input_schema` lấy từ `zod-to-json-schema`.
- [ ] **Step 4: Chạy test.** Kỳ vọng: PASS. **Step 5: Commit** `feat(worker): content generation with validation and fallback`

### Task 8: Publisher GitHub + endpoint tạo demo, xem trạng thái, sửa demo

**Files:**
- Create: `worker/src/publisher/{types.ts,github-publisher.ts}`, `worker/src/clients/github.ts`, `worker/src/routes/{generate.ts,status.ts,revise.ts}`, `worker/test/{github-publisher.test.ts,generate-route.test.ts}`

**Interfaces:**
- Consumes: `generateContent`, `reviseContent` (Task 7); `normalizePhone`, `slugify` (Task 1); `overDailyCap` (Task 5)
- Produces:
```ts
interface Publisher {
  create(o: { repoName: string; template: TemplateId; files: { path: string; base64: string }[] }): Promise<{ repo: string }>;
  update(repo: string, files: { path: string; base64: string }[], message: string): Promise<void>;
  status(repo: string): Promise<{ state: 'pending' | 'ready'; url?: string }>;
  remove(repo: string): Promise<void>;
}
type SiteMeta = { siteId: string; repo: string; phone: string; leadKey: string; url?: string;
  expires: string; paid: boolean; revisions: number; createdAt: string; name: string }
type Job = { id: string; siteId: string; state: 'pending'|'ready'|'failed'|'queued'; url?: string; error?: string }
```
  - `github.ts`:
    - Xác thực: ký JWT RS256 bằng WebCrypto từ `GH_APP_PRIVATE_KEY` (PKCS#8), gọi `POST /app/installations/{GH_INSTALLATION_ID}/access_tokens`, cache token trong bộ nhớ đến 1 phút trước khi hết hạn.
    - Tạo repo: `POST /repos/{org}/{template}/generate {owner, name, private:false}`.
    - Commit nhiều file trong **một commit**: dùng Git Data API (tạo blob, tạo tree với `base_tree`, tạo commit, rồi `PATCH refs/heads/main`). Nếu gặp 404/409 vì repo vừa tạo chưa sẵn sàng thì thử lại mỗi 2 giây, tối đa 5 lần.
    - Bật Pages: `POST /repos/{org}/{repo}/pages {source:{branch:'main',path:'/'}}`.
    - Trạng thái: `GET /repos/{org}/{repo}/pages`; `status === 'built'` nghĩa là `ready`.
  - `POST /api/generate {sessionId, phone, name}` → `{jobId}`. Việc nặng chạy trong `ctx.waitUntil`.
  - `GET /api/status/:jobId` → `Job`. Khi gọi mà state vẫn `pending`, kiểm tra `publisher.status`; quá 3 phút chưa sẵn sàng thì đặt `failed` và gửi thông báo cho đội.
  - `POST /api/revise {siteId, sessionId, request}` → `{jobId}`
- [ ] **Step 1: Test thất bại** (fake HTTP cho GitHub; fake Publisher cho các route):
  - **github-publisher:**
    - `create` gửi đúng các request theo thứ tự `generate`, blobs, tree, commit, ref, pages.
    - Lần đầu gọi blob nhận 404, lần hai thành công thì vẫn hoàn tất.
    - Toàn bộ file đi vào đúng một commit.
  - **generate route:**
    - SĐT sai định dạng trả 400.
    - SĐT `0912 345 678` đã có demo trả 409 với thông báo "Số điện thoại này đã có bản dùng thử", kèm link cũ.
    - Gọi `/api/generate` hai lần cùng phiên trả cùng `jobId`, và `publisher.create` chỉ được gọi 1 lần.
    - Tên repo khớp `/^demo-[a-z0-9-]{1,30}-[a-z0-9]{4}$/`.
    - Các file đẩy lên gồm `site.json` và các ảnh trong `uploads`, đọc từ key `up:`.
    - `SiteMeta.leadKey` có độ dài 32.
    - Khi `overDailyCap` thì job ở trạng thái `queued`, có key `queue:<jobId>`, và không gọi Claude.
    - Khi thành công, `sheet.append` và `notify.send` mỗi hàm được gọi 1 lần.
  - **revise route:**
    - Lượt sửa thứ 4 trả 409.
    - `publisher.update` được gọi với `site.json` mới.
- [ ] **Step 2: Chạy test.** Kỳ vọng: FAIL. **Step 3: Cài đặt.** **Step 4: Chạy test.** Kỳ vọng: PASS.
- [ ] **Step 5: Commit** `feat(worker): GitHub publisher, generate/status/revise`

### Task 9: Thu lead từ web demo

**Files:**
- Create: `worker/src/routes/leads.ts`, `worker/test/leads.test.ts`

**Interfaces:**
- Consumes: `SiteMeta` (Task 8)
- Produces:
  - `POST /lead/:siteId {fields: Record<string,string>, website?: string}` → `{ok:true}`. CORS cho phép `https://<org>.github.io`.
  - `GET /leads/:siteId?key=` → trang HTML bảng lead; thêm `&format=csv` thì trả file CSV UTF-8 có BOM để mở đúng tiếng Việt trong Excel.
  - Lead được lưu trong `leads:<siteId>` dưới dạng mảng, giữ tối đa 500 mục mới nhất.
- [ ] **Step 1: Test thất bại:**
  - Có trường honeypot `website` khác rỗng thì trả `{ok:true}` nhưng không lưu.
  - Một IP gửi quá 10 lần/giờ cho cùng site thì trả 429.
  - `siteId` không tồn tại trả 404.
  - Giá trị dài hơn 500 ký tự bị cắt.
  - Sai `key` trả 403.
  - CSV bắt đầu bằng `﻿` và escape đúng dấu phẩy và ngoặc kép.
  - Trang HTML hiển thị `<script>` dưới dạng chữ (đã escape).
- [ ] **Step 2: Chạy test.** Kỳ vọng: FAIL. **Step 3: Cài đặt.** **Step 4: Chạy test.** Kỳ vọng: PASS. **Step 5: Commit** `feat(worker): demo lead capture + secret CSV view`

### Task 10: Thanh toán PayOS + Sheet bridge + thông báo cho đội

**Files:**
- Create: `worker/src/clients/{payos.ts,sheet.ts,notify.ts}`, `worker/src/routes/{checkout.ts,payos-webhook.ts}`, `sheet-bridge/Code.gs`, `worker/test/payos.test.ts`

**Interfaces:**
- Consumes: `SiteMeta` (Task 8)
- Produces:
```ts
interface PayosClient { createLink(o: { orderCode: number; amount: number; description: string;
  returnUrl: string; cancelUrl: string }): Promise<{ checkoutUrl: string }>;
  verifyWebhook(body: unknown): boolean }
interface SheetClient { append(row: Record<string, string | number>): Promise<void>;
  update(siteId: string, patch: Record<string, string>): Promise<void> }
interface Notifier { send(text: string): Promise<void> }   // Telegram Bot API sendMessage
```
  - Ký PayOS: HMAC-SHA256 với `PAYOS_CHECKSUM_KEY`.
    - Khi tạo link: ký chuỗi `amount=..&cancelUrl=..&description=..&orderCode=..&returnUrl=..`.
    - Khi nhận webhook: ký các trường trong `data` sắp theo thứ tự alphabet, nối thành `k=v&...`, so sánh với `signature`.
    - Gọi `POST https://api-merchant.payos.vn/v2/payment-requests` với header `x-client-id`, `x-api-key`.
    - `description` tối đa 25 ký tự.
  - Bảng giá gói nằm trong config `PACKAGES` (JSON). Mọi giá phải `>= 10_000_000`, server kiểm tra lại khi chạy.
  - `POST /api/checkout {siteId, packageId}` → `{checkoutUrl}`. `orderCode` lấy từ `Date.now() % 1e9` cộng số ngẫu nhiên, map vào key `order:<orderCode> → siteId`.
  - `POST /webhook/payos`: chữ ký đúng và `code === '00'` thì đặt `SiteMeta.paid = true`, cập nhật Sheet `trang_thai=da_thanh_toan`, gửi thông báo cho đội. Luôn trả 200 để PayOS không gửi lại.
  - `Code.gs`: `doPost(e)` kiểm tra `token` bí mật, rồi `appendRow` hoặc cập nhật dòng theo `siteId`.
- [ ] **Step 1: Test thất bại:**
  - Chữ ký tạo link khớp với một vector tính sẵn (tính bằng `node:crypto` trong test).
  - Webhook sai chữ ký: không thay đổi gì.
  - Gửi cùng `orderCode` hai lần: chỉ một lần `sheet.update` và một lần `notify.send`.
  - `packageId` không tồn tại trả 400.
  - Site đã `paid` thì checkout trả 409.
  - `description` dài 40 ký tự bị cắt còn 25.
- [ ] **Step 2: Chạy test.** Kỳ vọng: FAIL. **Step 3: Cài đặt.** **Step 4: Chạy test.** Kỳ vọng: PASS. **Step 5: Commit** `feat(worker): PayOS checkout/webhook, sheet bridge, notifier`

### Task 11: Cron (gỡ demo hết hạn, xử lý hàng đợi)

**Files:**
- Create: `worker/src/cron.ts`, `worker/test/cron.test.ts`; Modify: `worker/src/index.ts` (thêm `scheduled`), `worker/wrangler.toml` (`crons = ["0 3 * * *"]`)

**Interfaces:**
- Consumes: `Publisher.remove`, `SiteMeta`, `Job`, logic generate (Task 8), `overDailyCap` (Task 5)
- Produces: `async function runDaily(deps): Promise<{ removed: number; processed: number }>`
- [ ] **Step 1: Test thất bại:**
  - Site có `expires < now` và `paid: false` thì bị `remove`, và Sheet cập nhật `trang_thai=da_go`.
  - Site đã `paid` thì không bị gỡ.
  - Các key `queue:` được xử lý tuần tự cho đến khi `overDailyCap` thì dừng; job đã xử lý chuyển sang `ready` hoặc `failed`.
  - Lỗi ở một site không làm dừng các site khác.
- [ ] **Step 2: Chạy test.** Kỳ vọng: FAIL. **Step 3: Cài đặt** (dùng `kv.list({prefix})` có phân trang). **Step 4: Chạy test.** Kỳ vọng: PASS. **Step 5: Commit** `feat(worker): daily cron for expiry and queue`

### Task 12: Web chính (giao diện chat, upload, trạng thái, đề xuất, thanh toán)

**Files:**
- Create: `web-main/*` theo cấu trúc file ở trên, `web-main/test/{extract.test.ts,flow.spec.ts}`

**Interfaces:**
- Consumes: mọi endpoint ở Task 4–10. `API_BASE` đọc từ `<meta name="api-base">`.
- Produces:
  - `extract.js`: `extractText(file: File): Promise<string>`. PDF dùng pdf.js, DOCX dùng mammoth; trả về tối đa 8.000 ký tự.
  - Các trang `index` (3 gói), `chat`, `status?job=`, `proposal?site=`, `thanks`.
- [ ] **Step 1: Test thất bại:**
  - `extract.test.ts` (vitest + jsdom, với file mẫu PDF/DOCX tiếng Việt): kết quả chứa "Hợp tác xã", và độ dài không quá 8.000.
  - `flow.spec.ts` (Playwright, Worker giả dựng bằng route mock):
    - Có 3 nút chọn nhu cầu.
    - Gửi tin nhắn thì hiện câu trả lời, gợi ý nhanh và thanh tiến độ dạng "Đã đủ 2/10 thông tin".
    - Dòng nhắc về thông tin nhạy cảm luôn hiển thị.
    - Chọn file `.gif` thì hiện lỗi tiếng Việt ngay, không gọi API.
    - `turnsLeft: 0` thì ô nhập bị khoá và nút "Tạo bản dùng thử" được tô nổi.
    - Nút "Tạo bản dùng thử" bị vô hiệu ngay sau lần bấm đầu tiên.
    - Thiếu SĐT thì không gửi được form.
    - Trang trạng thái gọi lại API cho đến khi `ready`, rồi hiện link demo và link đề xuất.
    - Trang đề xuất hiển thị các gói với giá dạng `10.000.000đ` và có nút "In / Lưu PDF".
    - Bố cục không tràn ngang ở 375px.
- [ ] **Step 2: Chạy test.** Kỳ vọng: FAIL. **Step 3: Cài đặt** (vanilla JS module; widget Turnstile ở trang chat; lưu `sessionId` trong `sessionStorage`, bọc trong try/catch). **Step 4: Chạy test.** Kỳ vọng: PASS.
- [ ] **Step 5: Commit** `feat(web): chat, upload, status, proposal, checkout pages`

### Task 13: Hướng dẫn cài đặt, staging, chạy thử toàn bộ

**Files:**
- Create: `docs/SETUP.md`, `worker/wrangler.toml` (thêm `[env.staging]`), `scripts/smoke.ts`

**Interfaces:**
- Consumes: toàn bộ.
- Produces:
  - `SETUP.md` hướng dẫn từng bước:
    1. Tạo GitHub Org demo và GitHub App với quyền Administration RW, Contents RW, Pages RW; cài App vào org.
    2. Chạy `scripts/sync-templates.ts`.
    3. Tạo KV namespace và Turnstile site key.
    4. Deploy Apps Script.
    5. Lấy khoá PayOS, đăng ký webhook URL.
    6. Tạo Telegram bot.
    7. Khai báo `wrangler secret put` cho `ANTHROPIC_API_KEY`, `GH_APP_ID`, `GH_APP_PRIVATE_KEY`, `GH_INSTALLATION_ID`, `GH_ORG`, `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY`, `SHEET_URL`, `SHEET_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TURNSTILE_SECRET`.
    8. Khai báo biến thường `CHAT_MODEL`, `GEN_MODEL`, `PRICE_*`, `DAILY_CAP_USD`, `PACKAGES`, `WEB_ORIGIN`, `PUBLISHER`.
  - `scripts/smoke.ts <apiBase>` chạy với staging: tạo phiên (dùng test key của Turnstile), chat 3 lượt, upload 1 ảnh, tạo demo, chờ `ready`, `fetch` URL demo và kiểm tra có tên đơn vị, gửi 1 lead, đọc CSV, gọi `/api/revise` một lần.
- [ ] **Step 1: Deploy staging** bằng org GitHub test riêng.
- [ ] **Step 2: Chạy `pnpm smoke https://<staging-worker>`.** Kỳ vọng: in ra `SMOKE OK` kèm link demo.
- [ ] **Step 3: Thanh toán thật một đơn nhỏ** (đặt `PACKAGES` staging là 2.000đ và tạm bỏ kiểm tra `>= 10_000_000` chỉ ở staging bằng `ALLOW_TEST_PRICE=1`). Kỳ vọng: Sheet chuyển sang `da_thanh_toan` và Telegram nhận thông báo.
- [ ] **Step 4: Chạy `pnpm -r test`.** Kỳ vọng: toàn bộ PASS.
- [ ] **Step 5: Commit** `docs: setup guide, staging env, smoke test`

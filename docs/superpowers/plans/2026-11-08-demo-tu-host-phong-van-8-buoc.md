# Demo tự host + Phỏng vấn 8 bước + Bộ hồ sơ dùng thử — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chuyển bước dùng thử sang hướng "chỉ xem", không giao mã nguồn. Cụ thể:
- Worker tự hiển thị demo tại `/d/<siteId>`.
- Phỏng vấn khách theo 8 bước, có bước xác nhận cuối.
- Giao cho khách bộ hồ sơ gồm link web, ảnh PNG, bản phân tích PDF và DOCX (bản miễn phí rút gọn).
- Sau thanh toán, đội nhận một link bàn giao bí mật để tải trọn dữ liệu.

**Architecture:**
- Không còn tạo repo GitHub ở bước dùng thử. AI trả về `{site, analysis}`; Worker lưu vào KV rồi tự phục vụ template, nhúng dưới dạng text module.
- Trang bộ hồ sơ `/package/:siteId` do Worker phục vụ (cùng tên miền với `/d/`). PNG, PDF và DOCX được tạo trên trình duyệt.
- Phỏng vấn dùng `BriefV2` chia 8 bước. Code tính bước hiện tại, AI chỉ hỏi và điền thông tin.

**Tech Stack:**
- Nền tảng sẵn có: TypeScript, Cloudflare Workers + KV, zod, vitest (`@cloudflare/vitest-pool-workers`), Playwright với `channel: 'chrome'`.
- Thư viện mới, tải từ CDN trên trình duyệt: html2canvas (cdnjs), `docx` (jsdelivr), SheetJS/xlsx (cdnjs).
- Bản npm của các thư viện này chỉ dùng trong test.

**Spec:** `docs/superpowers/specs/2026-11-08-demo-tu-host-phong-van-8-buoc-design.md`. Spec gốc `2026-11-08-sme-mvp-builder-design.md` vẫn áp dụng cho những phần không bị thay thế.

## Global Constraints

- Không database, không đăng nhập. Trạng thái chỉ nằm ở KV và Google Sheet. Không có bước build cho web/template.
- Mọi chữ hiển thị cho khách bằng **tiếng Việt có dấu**.
- **Không tạo repo GitHub ở bước dùng thử.** Code `Publisher` và GitHub vẫn giữ trong repo, nhưng luồng demo không gọi tới.
- Chat tối đa **30 lượt**. Từ **lượt 26**, AI tóm tắt và đề nghị sang bước 8. Mỗi lượt AI hỏi tối đa 2 câu, 2–4 gợi ý trả lời nhanh.
- 8 bước theo thứ tự: `don_vi, san_pham, khach_hang, muc_tieu, phong_cach, tham_khao, tai_lieu, xac_nhan`.
- Mục bắt buộc (dấu * ở spec §2.1):
  - `ten_don_vi, loai_hinh, nganh, dia_phuong`;
  - `san_pham` có ít nhất 1 mục, `diem_khac_biet`;
  - `khach_hang_muc_tieu`;
  - `muc_tieu_chinh, hanh_dong_mong_muon`;
  - `cam_giac`;
  - `lien_he.phone` hoặc `lien_he.zalo`.
- Bước tuỳ chọn `tham_khao` và `tai_lieu`: AI phải hỏi mỗi bước một lần (ghi vào `meta.askedOptional`).
- Tài liệu:
  - `docsText` tổng tối đa **20.000 ký tự**.
  - Excel đọc tối đa **3 sheet, mỗi sheet 200 dòng**; tối đa **60 sản phẩm**.
  - Ảnh: tối đa 10 ảnh, ≤ 5MB, jpg/png/webp (giữ như cũ).
- Template chọn theo `muc_tieu_chinh`:
  - `ban-hang` → `tpl-ban-hang`;
  - `thu-lead`, `tim-dai-ly`, `tuyen-dung` → `tpl-thu-lead`;
  - còn lại → `tpl-gioi-thieu`.
- `siteId` = `<slug>-<6 ký tự [a-z0-9]>`, khớp `^[a-z0-9-]{1,64}$`.
- `analysis.full` **không bao giờ** được gửi cho site chưa thanh toán (kiểm tra theo `paid:<siteId>`).
- Header của trang `/d/`:
  - `X-Robots-Tag: noindex, nofollow`;
  - `Cache-Control: no-store`;
  - `Referrer-Policy: no-referrer`.
- Demo hết hạn và chưa thanh toán (hoặc `removed`) trả **410**, kèm trang "Bản dùng thử đã hết hạn" có `CONTACT_PHONE`.
- Khoá bàn giao `handoffKey` = `deps.rand(32)`, so sánh constant-time.
- Biến môi trường mới: `CONTACT_PHONE`, `PLATFORM_NAME` (mặc định "Web Làng"). Các biến `GH_*` không còn bắt buộc.
- Giữ nguyên: giá gói chỉ lấy từ `config.packages` (≥ 10.000.000 trừ khi `allowTestPrice`); khoá chống chạy chồng (lease); `POST /api/jobs/:id/run`; cách ghi chi phí; `paid:<siteId>` là nguồn duy nhất cho biết site đã thanh toán.

## Review Focus

1. **Khách trả lời gộp nhiều bước trong một câu, hoặc quay lại sửa bước đã xong.** Bước hiện tại phải tính theo dữ liệu đang có, không theo thứ tự đã hỏi. Sửa một mục sau khi đã xác nhận thì cờ `da_xac_nhan` phải bị huỷ (test ở Task 2).
2. **Excel tiếng Việt "bẩn".** Gồm: tiêu đề nằm ở dòng 2–3, cột tên "Giá (VNĐ)" hoặc "Đơn giá", giá dạng chữ "180.000đ" hay "1,2 triệu", có dòng trống và dòng tổng cộng. Kết quả phải ra đúng `{ten, gia: 180000}`, bỏ qua dòng tổng (test ở Task 7).
3. **Người chưa thanh toán tìm cách lấy phần `full`**: qua `/api/package`, `/d/:id/site.json`, trang bàn giao không có key, hay tham số `?tier=full`. Tất cả đều không được lộ phần này (test ở Task 5 và Task 6).
4. **Demo hết hạn trong lúc khách đang mở trang bộ hồ sơ hoặc gửi yêu cầu sửa.** Trả 410 hoặc 409 kèm thông báo tiếng Việt, không lỗi 500 (test ở Task 4 và Task 5).
5. **Chụp PNG khi web-main nằm ở tên miền khác Worker.** Trang trạng thái phải chuyển sang `${API_BASE}/package/<siteId>`. Mọi ảnh trong iframe là cùng tên miền, nên canvas không bị "tainted" (test ở Task 6 và Task 7).

---

## File Structure

```
packages/schema/src/
  brief-v2.ts      # BriefV2Schema, STEPS, REQUIRED, stepState(), mergeBriefV2()
  analysis.ts      # AnalysisSchema, defaultAnalysis(brief, packages)
  brief.ts         # (xoá ở Task 2 sau khi chuyển hết sang v2)
worker/src/
  ai/prompts.ts, ai/chat.ts       # chat 8 bước (sửa)
  ai/generate.ts                  # emit_package {site, analysis} (sửa)
  routes/brief.ts                 # GET /api/brief/:sessionId, POST /api/brief/confirm, POST /api/products (mới)
  routes/upload.ts                # docs 20.000 (sửa)
  jobs/pipeline.ts, jobs/record.ts# queued→ai→ready, assets (sửa)
  sites.ts                        # assetKey, analysisKey, siteIdFor (sửa)
  routes/demo.ts                  # GET /d/:id, /d/:id/site.json, /d/:id/assets/:file (mới)
  static/templates.ts             # import text các file template (mới)
  routes/package.ts               # GET /package/:id, GET /api/package/:id (mới)
  static/package/{package.html,package.js,package.css}  # trang bộ hồ sơ (mới)
  routes/handoff.ts               # GET /handoff/:id?key= (mới)
  routes/revise.ts, routes/status.ts, routes/payos-webhook.ts, cron.ts, deps.ts, types.ts (sửa)
web-main/
  js/chat.js, js/steps.js (mới: thanh bước, thẻ chọn, bản tóm tắt), js/excel.js (mới), js/upload.js, js/status.js
  chat.html, status.html, css/main.css
docs/SETUP.md, scripts/smoke.ts
```

---

### Task 1: Schema BriefV2 và Analysis

**Files:**
- Create: `packages/schema/src/brief-v2.ts`, `packages/schema/src/analysis.ts`, `packages/schema/test/brief-v2.test.ts`, `packages/schema/test/analysis.test.ts`
- Modify: `packages/schema/src/index.ts` (export thêm)

**Interfaces:**
- Produces:
```ts
export const STEPS = ['don_vi','san_pham','khach_hang','muc_tieu','phong_cach','tham_khao','tai_lieu','xac_nhan'] as const;
export type StepId = typeof STEPS[number];
export const STEP_LABELS: Record<StepId, string>; // "Đơn vị và ngành nghề", "Sản phẩm và dịch vụ", "Khách hàng", "Mục tiêu website", "Phong cách", "Website tham khảo", "Tài liệu và hình ảnh", "Liên hệ và xác nhận"
export const BriefV2Schema: z.ZodType<BriefV2>;  // đúng các field ở spec §2.1, tất cả optional; san_pham: {ten, gia?:number, mo_ta?, anh?}[] max 60; meta: {auto?: string[]; askedOptional?: StepId[]}
export type BriefV2;
export function stepState(b: BriefV2): { step: StepId; index: number /*1..8*/; done: StepId[]; missing: string[] /*đường dẫn mục bắt buộc còn thiếu, vd 'lien_he.phone|zalo'*/; canConfirm: boolean };
export function mergeBriefV2(b: BriefV2, patch: unknown): BriefV2; // gộp nông; lien_he gộp sâu 1 cấp; san_pham patch thay thế cả mảng; bỏ key sai schema; mọi thay đổi khác meta làm da_xac_nhan=false
export const AnalysisSchema; export type Analysis; // đúng spec §3.1 {free:{...}, full:{...}}
export function defaultAnalysis(b: BriefV2): Analysis; // dựng từ brief, luôn hợp lệ, chữ tiếng Việt
export function templateFor(b: BriefV2): TemplateId; // theo bảng ở Global Constraints
```
- [ ] **Step 1: Viết test thất bại:**
```ts
expect(stepState({}).step).toBe('don_vi');
const s1 = { ten_don_vi:'HTX A', loai_hinh:'htx', nganh:'nông sản', dia_phuong:'Lâm Đồng' };
expect(stepState(s1).step).toBe('san_pham');
// gộp nhiều bước + bỏ cách quãng: thiếu bước 3 thì vẫn ở bước 3 dù bước 4,5 đã đủ
const s2 = { ...s1, san_pham:[{ten:'Cà phê'}], diem_khac_biet:'OCOP', muc_tieu_chinh:'ban-hang', hanh_dong_mong_muon:'zalo', cam_giac:'moc-mac' };
expect(stepState(s2).step).toBe('khach_hang');
// bước tuỳ chọn chỉ được hỏi một lần
const s3 = { ...s2, khach_hang_muc_tieu:'quán cà phê' };
expect(stepState(s3).step).toBe('tham_khao');
expect(stepState({ ...s3, meta:{askedOptional:['tham_khao','tai_lieu']} }).step).toBe('xac_nhan');
expect(stepState({ ...s3, meta:{askedOptional:['tham_khao','tai_lieu']} }).canConfirm).toBe(false); // thiếu liên hệ
expect(stepState({ ...s3, lien_he:{zalo:'0912345678'}, meta:{askedOptional:['tham_khao','tai_lieu']} }).canConfirm).toBe(true);
expect(mergeBriefV2({ ...s3, da_xac_nhan:true }, { nganh:'thực phẩm' }).da_xac_nhan).toBe(false);
expect(mergeBriefV2({ ...s3, da_xac_nhan:true }, { meta:{askedOptional:['tham_khao']} }).da_xac_nhan).toBe(true);
expect(mergeBriefV2(s1, { cam_giac:'kiểu-lạ', bogus:1 })).toEqual(s1);
expect(mergeBriefV2({ lien_he:{phone:'1'} }, { lien_he:{zalo:'2'} }).lien_he).toEqual({ phone:'1', zalo:'2' });
expect(templateFor({ muc_tieu_chinh:'tim-dai-ly' })).toBe('tpl-thu-lead');
expect(templateFor({})).toBe('tpl-gioi-thieu');
expect(AnalysisSchema.safeParse(defaultAnalysis(s3)).success).toBe(true);
expect(defaultAnalysis(s3).free.tom_tat_doanh_nghiep).toContain('HTX A');
```
- [ ] **Step 2: Chạy `pnpm -F @sme/schema test`.** Kỳ vọng: FAIL.
- [ ] **Step 3: Cài đặt** đúng các signature ở trên. Mục bắt buộc lấy từ Global Constraints. Một bước "xong" khi các mục bắt buộc của bước đó đã có, hoặc (với bước tuỳ chọn) đã nằm trong `askedOptional`.
- [ ] **Step 4: Chạy test.** Kỳ vọng: PASS. Chạy thêm `tsc`.
- [ ] **Step 5: Commit** `feat(schema): BriefV2 8 bước, stepState, AnalysisSchema`

### Task 2: Chat 8 bước, xác nhận, tài liệu 20.000, sản phẩm từ Excel

**Files:**
- Modify: `worker/src/ai/prompts.ts`, `worker/src/ai/chat.ts`, `worker/src/routes/chat.ts`, `worker/src/routes/upload.ts`, `worker/src/routes/generate.ts` (chặn khi chưa xác nhận), `worker/src/types.ts` (`Session.brief: BriefV2`), `worker/src/index.ts`
- Create: `worker/src/routes/brief.ts`, `worker/test/brief.test.ts`
- Delete: `packages/schema/src/brief.ts` (v1) cùng test của nó, và mọi chỗ còn import v1
- Test: `worker/test/chat.test.ts` (sửa)

**Interfaces:**
- Consumes: `BriefV2`, `stepState`, `mergeBriefV2`, `STEPS`, `STEP_LABELS` (Task 1)
- Produces:
  - `POST /api/chat` → `{ reply, quickReplies, choices?, step:{id, index, label}, done: StepId[], missing, canConfirm, turnsLeft, mustConfirm }`, trong đó `mustConfirm = turns >= 30`.
  - `choices` = `{ kind:'single'|'multi', options:{value,label,hint?}[] }`, tối đa 8 lựa chọn.
  - `GET /api/brief/:sessionId` → `{ brief, step, done, missing, canConfirm }`.
  - `POST /api/brief/confirm {sessionId}` → `{ ok:true }` hoặc 409 kèm `{error, missing}`.
  - `POST /api/products {sessionId, items:{ten, gia?}[]}` → `{ count }`. Tối đa 60 mục, ghi vào `brief.san_pham` qua `mergeBriefV2`.
  - `POST /api/generate` trả 409 với "Vui lòng xác nhận thông tin trước khi tạo bản dùng thử." khi `!brief.da_xac_nhan`.
  - `AI ChatReply` = `{ reply, briefPatch, quickReplies, choices?, askedOptional?: StepId }`. Code ghi `askedOptional` vào `brief.meta`.
- [ ] **Step 1: Viết test thất bại** (dùng Claude giả lập):
  - System prompt có `STEP_LABELS[step]` và danh sách `missing` của bước hiện tại.
  - `choices` dài hơn 8 lựa chọn thì bị cắt còn 8.
  - Lượt 31 trả 409 và không gọi Claude. Từ lượt 26, prompt có chỉ dẫn "tóm tắt và chuyển sang bước 8".
  - Một câu điền đủ cả bước 1 và bước 2 thì `step.id === 'khach_hang'`.
  - Gọi confirm khi thiếu `lien_he` thì trả 409, kèm `missing` chứa `'lien_he.phone|zalo'`. Gọi khi đủ thì trả `{ok:true}`.
  - Chat thêm sau khi đã xác nhận và AI sửa `nganh` thì `GET /api/brief` trả `brief.da_xac_nhan` là false.
  - Gọi generate khi chưa xác nhận thì trả 409.
  - Hai lần `/api/docs`, tổng 25.000 ký tự, cho ra `docsText.length === 20000`.
  - `/api/products` với 70 mục thì lưu 60. Mục có `gia` âm hoặc không phải số thì bỏ trường `gia`.
- [ ] **Step 2: Chạy `pnpm -F @sme/worker test`.** Kỳ vọng: FAIL.
- [ ] **Step 3: Cài đặt.**
  - Prompt tiếng Việt: vai trò tư vấn viên; bước hiện tại và các mục còn thiếu; hướng dẫn hỏi lại khi câu trả lời mơ hồ; khi nào trả `choices` (ngành, loại hình, mục tiêu, hành động, cảm giác, kênh bán); bước `tham_khao` thì hỏi link hoặc ảnh web mẫu và "thích điểm gì"; bước `tai_lieu` thì mời gửi logo, ảnh, PDF, Word, Excel.
  - Xoá v1 và chuyển `generate.ts` cũ sang dùng `BriefV2` (vẫn chạy được; Task 3 viết lại).
- [ ] **Step 4: Chạy toàn bộ suite Worker và schema, cùng `tsc`.** Kỳ vọng: PASS.
- [ ] **Step 5: Commit** `feat(worker): phỏng vấn 8 bước, xác nhận, sản phẩm từ Excel, tài liệu 20.000`

### Task 3: AI tạo `{site, analysis}` và sửa lỗi dự phòng

**Files:**
- Modify: `worker/src/ai/generate.ts`, `worker/test/generate.test.ts`

**Interfaces:**
- Consumes: `templateFor`, `AnalysisSchema`, `defaultAnalysis` (Task 1); `defaultSite`, `SiteSchema`; `recordUsage` / `addCost` hiện có
- Produces:
  - `generatePackage(deps, s: Session, siteId: string): Promise<{ site: SiteJson; analysis: Analysis; usedFallback: boolean }>` thay cho `generateContent`. Tool là `emit_package`, `input_schema` sinh từ zod.
  - `reviseContent` giữ nguyên signature.
- [ ] **Step 1: Viết test thất bại:**
  - Template lấy theo `templateFor(brief)`, dù AI trả template khác.
  - `analysis` sai và `site` đúng: kết quả dùng `site` của AI và `defaultAnalysis`.
  - **Lần 1 sai schema, lần 2 ném `ClaudeError` (timeout):** kết quả giữ `brand` và các section hợp lệ của lần 1 (qua `mergeFallback`), `usedFallback` là true, chi phí của cả hai lần đều được ghi.
  - Hai lần đều ném lỗi: kết quả là `defaultSite` cộng `defaultAnalysis`, không ném lỗi ra ngoài.
  - `brief.san_pham` (từ Excel) có trong prompt dưới dạng danh sách.
  - Prompt có khung `defaultSite(template)`.
  - `docsText` (≤ 20.000 ký tự) có trong prompt.
- [ ] **Step 2: Chạy test.** Kỳ vọng: FAIL.
- [ ] **Step 3: Cài đặt.** Giữ `sanitizeAssets`. Ghi `brief.meta.auto` gồm các mục bắt buộc mà AI tự điền.
- [ ] **Step 4: Chạy test.** Kỳ vọng: PASS.
- [ ] **Step 5: Commit** `feat(worker): emit_package site+analysis, giữ nội dung lần 1 khi lần 2 lỗi`

### Task 4: Pipeline `queued → ai → ready`, lưu ảnh demo, sửa demo, trạng thái

**Files:**
- Modify: `worker/src/jobs/pipeline.ts`, `worker/src/jobs/record.ts`, `worker/src/sites.ts`, `worker/src/types.ts` (SiteMeta), `worker/src/routes/generate.ts`, `worker/src/routes/revise.ts`, `worker/src/routes/status.ts`, `worker/src/deps.ts` (publisher không bắt buộc)
- Test: `worker/test/generate-route.test.ts`, `worker/test/revise.test.ts` (sửa hoặc thêm)

**Interfaces:**
- Consumes: `generatePackage` (Task 3)
- Produces:
  - `JobStage = 'queued' | 'ai' | 'ready'`. Bỏ `ai_done`, `publishing`, `published`, `PAGES_TIMEOUT_MS`, `LEASE_PUBLISH_MS`.
  - `SiteMeta = { siteId; phone; leadKey; handoffKey; template: TemplateId; expires; revisions; createdAt; name; analysisReady: boolean; removed?: boolean }`. Trường `paid` cũ chỉ để tương thích; nguồn chính vẫn là `paid:<siteId>`.
  - KV:
    - `sitejson:<id>`, `analysis:<id>` (Analysis đầy đủ);
    - `asset:<id>:<path>` = `{mime, base64}`, TTL tính đến `expires`;
    - `site:<id>`.
  - `sites.ts`:
    - `siteIdFor(name: string, rand: (n:number)=>string): string`;
    - `assetKey(siteId, path)`, `analysisKey(siteId)`;
    - `demoUrl(config, siteId) = ${config.apiBase}/d/${siteId}`;
    - `packageUrl(config, siteId) = ${config.apiBase}/package/${siteId}`.
  - Public `Job.url` = `packageUrl`. Dòng Sheet: `link_demo = demoUrl`.
- [ ] **Step 1: Viết test thất bại:**
  - Gọi `/run` hai lần: job đi từ `ai` sang `ready`, với `url === ${apiBase}/package/<siteId>`.
  - Có `sitejson:`, `analysis:`, mỗi ảnh có `asset:<id>:assets/1-x.jpg`, và `publisher.create` không bao giờ được gọi.
  - `siteId` khớp `/^[a-z0-9-]+-[a-z0-9]{6}$/`.
  - Dòng Sheet có `link_demo`, kết thúc bằng `/d/<siteId>`.
  - Gửi `revise` thì `sitejson:` được cập nhật và trả về `Job` `ready` ngay; lượt thứ 4 trả 409.
  - **Revise khi demo đã hết hạn, hoặc `removed`, thì trả 410** kèm "Bản dùng thử đã hết hạn".
  - Status của job `ready` trả `url` trỏ tới trang bộ hồ sơ; không còn nhánh chờ Pages.
  - Các test về lease và việc huỷ job quá 10 phút vẫn qua.
- [ ] **Step 2: Chạy test.** Kỳ vọng: FAIL.
- [ ] **Step 3: Cài đặt.** Xoá các nhánh liên quan publish. Lease chỉ còn dùng `LEASE_AI_MS`.
- [ ] **Step 4: Chạy toàn bộ suite Worker.** Kỳ vọng: PASS.
- [ ] **Step 5: Commit** `feat(worker): pipeline không còn GitHub, lưu demo và ảnh vào KV`

### Task 5: Trang demo tự host `/d/:siteId`

**Files:**
- Create: `worker/src/static/templates.ts`, `worker/src/routes/demo.ts`, `worker/test/demo.test.ts`
- Modify: `worker/wrangler.toml` (thêm `[[rules]] type = "Text"`, globs `["**/*.html", "**/*.css", "**/*.txt.js"]`), `worker/vitest.config.ts` (nếu cần cho text import), `worker/src/index.ts`, `worker/src/deps.ts` (`CONTACT_PHONE`, `PLATFORM_NAME` vào Config)
- Note: render.js là file `.js` nên được nhúng dưới dạng text. Cách làm: thêm script đồng bộ `scripts/embed-templates.ts`, sinh ra `worker/src/static/templates.gen.ts` (export chuỗi) từ `templates/`. Script chạy trong `pretest` và `predeploy` của worker. File sinh ra được commit, kèm test đối chiếu nó với nguồn để không bị lệch.

**Interfaces:**
- Consumes: `SiteMeta`, `sitejson:`, `asset:`, `isPaid` (Task 4)
- Produces:
  - `GET /d/:siteId` → HTML của template theo `meta.template`, đã chèn sẵn `base.css`, `theme.css` và `render.js` (inline `<style>` và `<script type="module">`). Meta `lead-endpoint` = `apiBase`, meta `platform-name` = `config.platformName`.
  - `GET /d/:siteId/site.json` → `site.json`. Riêng `demo.checkoutUrl` = `packageUrl`.
  - `GET /d/:siteId/assets/:file` → bytes, kèm `Content-Type` = mime đã lưu.
  - `templates.gen.ts` export `TEMPLATE_FILES: Record<TemplateId, { html: string; theme: string }>`, `SHARED: { renderJs: string; baseCss: string }`.
- [ ] **Step 1: Viết test thất bại:**
  - Trả 200, `content-type` html, có đủ ba header ở Global Constraints, và chứa `<meta name="lead-endpoint" content="<apiBase>">`.
  - `site.json` trả 200 và có `brand.name`.
  - Asset trả 200 với `image/jpeg`; asset không tồn tại trả 404.
  - Site hết hạn (`expires < now`) chưa thanh toán trả **410**, HTML chứa "Bản dùng thử đã hết hạn" và `CONTACT_PHONE`. Đã thanh toán và quá hạn thì vẫn 200.
  - `removed` trả 410. `siteId` = `ABC..` (sai định dạng) trả 404.
  - **`site.json` và HTML không chứa bất kỳ chuỗi nào lấy từ `analysis.full`** (seed một chuỗi đánh dấu trong `full` rồi kiểm tra là không có).
  - Test đối chiếu: `templates.gen.ts` khớp nội dung các file nguồn hiện tại.
- [ ] **Step 2: Chạy test.** Kỳ vọng: FAIL.
- [ ] **Step 3: Cài đặt.** HTML trả về được ghép từ `index.html` của template, thay các thẻ `<link>`/`<script src>` bằng nội dung inline. Thêm header CSP: `default-src 'self'; img-src 'self' data: blob:; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'`.
- [ ] **Step 4: Chạy test.** Kỳ vọng: PASS. Thêm một test Playwright ngắn trong `worker/test/demo.e2e.ts`: khởi động `wrangler dev --local` (cổng cố định), seed KV qua một route test chỉ bật khi `ALLOW_TEST_SEED=1`; ở 375px và 1280px phải có ít nhất 3 `section.sec` và không có lỗi console. Nếu `wrangler dev` không chạy được trong sandbox, thay bằng cách render HTML vào Playwright qua `page.setContent` với các route giả, và ghi lại thay đổi này.
- [ ] **Step 5: Commit** `feat(worker): demo tự host /d/:siteId, 410 khi hết hạn`

### Task 6: Trang bộ hồ sơ `/package/:siteId` (PNG, PDF, DOCX, bản rút gọn)

**Files:**
- Create: `worker/src/static/package/package.html`, `package.js`, `package.css` (được nhúng bằng cùng script embed của Task 5), `worker/src/routes/package.ts`, `worker/test/package.test.ts`, `worker/test/package.e2e.ts`
- Modify: `worker/src/index.ts`, `scripts/embed-templates.ts` (thêm các file package)

**Interfaces:**
- Consumes: `analysis:`, `isPaid`, `config.packages` (lọc như checkout), `demoUrl`, `packageUrl`
- Produces:
  - `GET /api/package/:siteId` → `{ site:{name, expires, paid}, demoUrl, analysis:{ free, full? }, packages }`. Có `full` **chỉ khi** `isPaid`. Tham số truy vấn bị bỏ qua.
  - `GET /package/:siteId` → HTML trang bộ hồ sơ, cùng header noindex/no-store; 410 hoặc 404 như trang `/d/`.
  - `package.js` (trình duyệt): tải `/api/package/:id`, rồi hiển thị:
    1. Nút `<a>` "Mở website mẫu".
    2. Hai iframe ẩn `/d/:id` ở khổ 390 và 1280. html2canvas (cdnjs, tải lười) chụp lại, vẽ watermark chéo "BẢN DÙNG THỬ", cho tải `giao-dien-<id>-mobile.png` và `giao-dien-<id>-desktop.png`. Chụp lỗi thì ẩn nút và hiện "Mở website mẫu để xem".
    3. Phần `free` hiển thị đầy đủ; phần `full` hiện khung mờ "Mở khoá sau khi triển khai chính thức" (đã thanh toán thì hiện nội dung thật).
    4. Nút "Tải PDF" gọi `window.print()`, CSS in gồm bìa, mục lục, ảnh, phân tích, gói giá, lộ trình rút gọn.
    5. Nút "Tải Word (DOCX)" dùng `docx` (jsdelivr, tải lười), cùng nội dung với PDF và có ảnh nếu đã chụp được. File tên `phan-tich-<id>.docx`.
    6. Gói giá và nút thanh toán (`POST /api/checkout`, chuyển tới `checkoutUrl`).
  - Mọi chữ được hiển thị bằng `textContent`.
- [ ] **Step 1: Viết test thất bại** (unit):
  - Site chưa thanh toán: `/api/package` không có key `full`, và JSON không chứa chuỗi đánh dấu của `full`; thêm `?tier=full` vẫn không có.
  - Có `paid:<id>`: có `full`.
  - Gói dưới mức tối thiểu bị lọc như checkout.
  - `/package/:id` hết hạn trả 410.
- [ ] **Step 2: Viết e2e thất bại** (`package.e2e.ts`, cùng cách chạy như Task 5): bấm "Tải ảnh" thì có sự kiện download với tên `giao-dien-<id>-mobile.png`, file bắt đầu bằng magic bytes PNG; bấm "Tải Word" thì download `.docx`, file bắt đầu bằng `PK`; trang hiện khung khoá khi chưa thanh toán. Trong test, các thư viện CDN được thay bằng bản npm qua `page.route`.
- [ ] **Step 3: Chạy test.** Kỳ vọng: FAIL. **Step 4: Cài đặt.** **Step 5: Chạy test.** Kỳ vọng: PASS. Tự chụp màn hình trang ở 375px và 1280px, xem lại ảnh và sửa nếu giao diện có vấn đề.
- [ ] **Step 6: Commit** `feat(worker): trang bộ hồ sơ dùng thử — PNG, PDF, DOCX, bản rút gọn`

### Task 7: Web-main — giao diện 8 bước, Excel, màn hình chờ

**Files:**
- Create: `web-main/js/steps.js`, `web-main/js/excel.js`, `web-main/test/excel.test.ts`, fixture Excel tiếng Việt (sinh bằng xlsx npm trong helper của test)
- Modify: `web-main/js/chat.js`, `web-main/js/upload.js`, `web-main/js/status.js`, `web-main/chat.html`, `web-main/status.html`, `web-main/css/main.css`, `web-main/test/flow.spec.ts`; `web-main/proposal.html` chuyển hướng sang `${API_BASE}/package/<site>`

**Interfaces:**
- Consumes: các API của Task 2, `Job.url` (= trang bộ hồ sơ) của Task 4
- Produces:
  - `excel.js`: `parseSheet(rows: unknown[][]): { text: string; products: {ten:string; gia?:number}[] }` và `extractExcel(file, XLSX): Promise<{text, products}>`.
    - Tìm dòng tiêu đề trong 5 dòng đầu, theo từ khoá "tên", "sản phẩm", "mặt hàng" cho cột tên và "giá", "đơn giá" cho cột giá.
    - Đọc giá dạng "180.000đ", "180,000", "1,2 triệu" (= 1.200.000).
    - Bỏ dòng trống và dòng có tên bắt đầu bằng "tổng".
    - Giới hạn 3 sheet, 200 dòng mỗi sheet, 60 sản phẩm.
  - `steps.js`:
    - `renderStepBar(state)` hiện "Bước X/8 · nhãn" và 8 bước có dấu tích;
    - `renderChoices(choices, onPick)` hiện thẻ chọn (multi có nút "Xong"); thẻ phong cách có khối màu minh hoạ;
    - `renderSummary(brief, onEdit, onConfirm)` hiện bản tóm tắt theo bước, nút "Sửa" và nút "Đúng rồi, tạo bản dùng thử".
  - Chat:
    - nút tạo demo chỉ hiện khi `canConfirm` và đang ở bước `xac_nhan` hoặc `mustConfirm`;
    - bấm confirm thì mở form tên và SĐT (điền sẵn từ brief) rồi gọi generate;
    - chọn file: ảnh qua upload (nén như cũ); PDF/DOCX qua extract rồi `/api/docs`; `.xlsx/.xls/.csv` qua `extractExcel`, rồi `/api/docs` cùng `/api/products`.
  - Status:
    - 4 bước chờ có dấu tích (theo stage và thời gian), thanh tiến độ, câu "Khoảng 1–2 phút, vui lòng giữ trang này mở";
    - khi `ready` thì `location.href = job.url` (trang bộ hồ sơ trên Worker).
- [ ] **Step 1: Viết test thất bại:**
  - `excel.test.ts`: tiêu đề ở dòng 3, cột "Tên sản phẩm" và "Đơn giá (VNĐ)"; giá "180.000đ" → 180000; "1,2 triệu" → 1200000; dòng "Tổng cộng" bị bỏ; 70 dòng → 60 sản phẩm; sheet không có cột giá → `products` rỗng và `text` khác rỗng.
  - `flow.spec.ts` (API giả lập):
    - thanh bước đổi từ "Bước 1/8" sang "Bước 3/8" khi API trả `step.index` 3;
    - bấm thẻ chọn gửi đúng `label`;
    - nút tạo demo ẩn khi `canConfirm` là false;
    - bản tóm tắt hiện khi ở bước 8 và `canConfirm`; bấm "Sửa" ở bước 2 thì gửi một tin chat yêu cầu sửa;
    - tải Excel lên gọi cả `/api/docs` và `/api/products`;
    - trang trạng thái hiện đủ 4 bước chờ, rồi chuyển tới `http://api.test/package/x` khi job `ready` với `url` đó;
    - không tràn ngang ở 375px.
- [ ] **Step 2: Chạy `pnpm -F @sme/web-main test` và `test:e2e`.** Kỳ vọng: FAIL. **Step 3: Cài đặt.** **Step 4: Chạy test.** Kỳ vọng: PASS. Chụp màn hình chat ở bước 5 (thẻ phong cách) và bản tóm tắt ở 375px, xem lại ảnh.
- [ ] **Step 5: Commit** `feat(web): phỏng vấn 8 bước, thẻ chọn, Excel, màn hình chờ`

### Task 8: Cron, thanh toán, trang bàn giao

**Files:**
- Create: `worker/src/routes/handoff.ts`, `worker/test/handoff.test.ts`
- Modify: `worker/src/cron.ts`, `worker/src/routes/payos-webhook.ts`, `worker/src/index.ts`, `sheet-bridge/Code.gs` (thêm cột `link_ban_giao`), các test cron và payos

**Interfaces:**
- Consumes: `SiteMeta.handoffKey`, các key KV của Task 4
- Produces:
  - `GET /handoff/:siteId?key=` → trang HTML, escape toàn bộ, header noindex/no-store. Hiện brief dễ đọc, `site.json`, `analysis` đầy đủ, `docsText`, link từng ảnh (`/d/:id/assets/...`), và nút tải `handoff-<id>.json` (trả về `?key=…&format=json`, gồm brief, site, analysis, docsText và ảnh base64).
  - Webhook khi thanh toán (bổ sung vào bản hiện có):
    - ghi lại mọi key `asset:<id>:*` **không TTL**;
    - tin Telegram và Sheet có `link_ban_giao = ${apiBase}/handoff/<id>?key=<handoffKey>`.
  - Cron, với site hết hạn chưa thanh toán:
    - xoá `sitejson:`, `analysis:`, `asset:<id>:*` (list theo prefix), `proposal:`;
    - đặt `removed: true`;
    - không gọi `publisher.remove`.
- [ ] **Step 1: Viết test thất bại:**
  - Bàn giao không có key hoặc sai key trả 403; `meta.handoffKey` rỗng cũng trả 403.
  - Key đúng: HTML có tên đơn vị, và một chuỗi `<script>` trong brief được hiển thị dưới dạng chữ (đã escape); `format=json` có đủ các phần.
  - Webhook thanh toán: các key `asset:` không còn hạn (đọc metadata `expiration` bằng `kv.getWithMetadata` hoặc spy `put`); tin notify chứa `/handoff/`.
  - Cron: site hết hạn chưa thanh toán thì các key trên bị xoá và `/d/` trả 410; site đã thanh toán thì giữ nguyên; `publisher.remove` không được gọi.
- [ ] **Step 2: Chạy test.** Kỳ vọng: FAIL. **Step 3: Cài đặt.** **Step 4: Chạy test.** Kỳ vọng: PASS.
- [ ] **Step 5: Commit** `feat(worker): bàn giao sau thanh toán, cron dọn dữ liệu demo trong KV`

### Task 9: SETUP, smoke test, kiểm tra toàn bộ

**Files:**
- Modify: `docs/SETUP.md`, `scripts/smoke.ts`, `worker/wrangler.toml` (`[vars]` thêm `CONTACT_PHONE`, `PLATFORM_NAME`; bỏ việc bắt buộc `GH_*`), `README` (nếu có)

**Interfaces:**
- Consumes: toàn bộ.
- Produces:
  - `SETUP.md`:
    - bỏ các bước GitHub Org/App và `sync-templates` khỏi đường cài bắt buộc, chuyển sang mục "Tuỳ chọn – bàn giao tự động sau này";
    - thêm `CONTACT_PHONE`, `PLATFORM_NAME`;
    - giải thích `/d/`, `/package/` và `/handoff/`;
    - nhắc web-main phải đặt `api-base` trỏ tới Worker.
  - `smoke.ts`:
    - phiên → chat 8+ lượt (in ra bước) → `/api/products` → confirm → generate → chạy `/run` tới `ready`;
    - kiểm tra `/d/<id>` 200 và `site.json` có `brand.name`;
    - `/api/package/<id>` không có `full`;
    - lead gửi 200; `/handoff/<id>` không key trả 403.
- [ ] **Step 1: Cập nhật tài liệu và smoke test.** Chạy `tsc` cho `scripts/smoke.ts` và `pnpm test:scripts`. Kỳ vọng: PASS.
- [ ] **Step 2: Chạy toàn bộ:** `pnpm -r test`, `pnpm -F @sme/templates test:visual`, `pnpm -F @sme/web-main test:e2e`, cùng các e2e của Worker. Kỳ vọng: tất cả PASS, output sạch.
- [ ] **Step 3: Commit** `docs: SETUP và smoke cho demo tự host`

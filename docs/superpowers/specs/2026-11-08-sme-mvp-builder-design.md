# Spec: Nền tảng tư vấn & tạo web demo tự động cho SME/HTX (MVP – Nhóm A)

- Ngày: 2026-11-08
- Trạng thái: Chờ duyệt
- Phạm vi: MVP giai đoạn 1 – chỉ nhóm A (website tĩnh)

## 1. Mục tiêu & bối cảnh

### 1.1 Vấn đề
SME, hợp tác xã (HTX) ở các tỉnh cần số hoá (website, thu thông tin khách, bán hàng online) nhưng thiếu người hiểu công nghệ và ngại chi phí. Chủ dự án muốn một hệ thống **tự động tư vấn và tạo bản demo chạy được**, dùng demo đó để bán gói triển khai chính thức **từ 10.000.000đ**.

### 1.2 Mục tiêu MVP
1. Khách tự chat với AI tư vấn, gửi tài liệu/ảnh, và nhận **link web demo chạy được trong khoảng 1–2 phút**.
2. Từ lúc khách vào web đến khi khách trả tiền, **không cần người can thiệp**.
3. Chi phí vận hành gần 0đ, chỉ tốn tiền AI theo từng khách.
4. Thanh toán VietQR được tự xác nhận. Đội ngũ chỉ nhận việc sau khi khách đã trả tiền.

### 1.3 Tiêu chí thành công
- Hơn 90% phiên tư vấn hoàn chỉnh tạo được demo không lỗi (không trắng trang, hiển thị đúng trên điện thoại).
- Chi phí AI trung bình dưới 2.000đ/khách.
- Không có thao tác thủ công nào trước bước thanh toán.
- Đo được tỉ lệ chuyển đổi: phiên chat → demo → thanh toán.

### 1.4 Ngoài phạm vi
- Database, đăng nhập/tài khoản khách, xác minh OTP.
- Nhóm B (webtool từ Excel, quản lý công việc, báo cáo MISA) và nhóm C (dịch vụ fanpage/thiết kế): làm ở các giai đoạn sau.
- Tên miền riêng, đa ngôn ngữ, AI tạo ảnh, dashboard quản trị.

## 2. Kiến trúc tổng thể

```
[Khách] ──> Web chính (Cloudflare Pages, tĩnh)
               │  chat, upload, xem đề xuất, thanh toán
               ▼
         Cloudflare Worker (API)
          ├─ Claude API (chat: Haiku; tạo nội dung: model mạnh hơn)
          ├─ GitHub App ──> GitHub Org "demo" ──> repo từ template ──> GitHub Pages
          ├─ PayOS (tạo link VietQR, nhận webhook)
          ├─ Cloudflare KV (phiên, đếm lượt, lead, chống spam, trần chi phí)
          ├─ Google Sheet qua Apps Script (sổ lead/đơn)
          └─ Cron hằng ngày (gỡ demo hết hạn)
```

### 2.1 Các khối
| Khối | Trách nhiệm | Nền tảng |
|---|---|---|
| `web-main` | Trang chủ, giao diện chat, trang đề xuất, trang thanh toán, trang trạng thái | HTML/CSS/JS tĩnh trên Cloudflare Pages |
| `worker-api` | Toàn bộ logic phía server, giữ các bí mật | Cloudflare Worker (TypeScript) |
| `templates/*` | 3 mẫu web, chỉ đọc `site.json` | Repo template trong GitHub Org |
| `sheet-bridge` | Nhận POST từ Worker, ghi một dòng vào Sheet | Google Apps Script Web App |

Mỗi khối chỉ giao tiếp với nhau qua HTTP/JSON với schema rõ ràng, nên có thể kiểm thử độc lập.

### 2.2 Các endpoint của Worker
| Method & path | Chức năng |
|---|---|
| `POST /api/session` | Tạo phiên chat (kiểm tra Turnstile, giới hạn theo IP) và trả về `sessionId` |
| `POST /api/chat` | Gửi một lượt chat, nhận câu trả lời, phiếu yêu cầu đã cập nhật và số lượt còn lại |
| `POST /api/upload` | Tải ảnh lên (tối đa 10 file, mỗi file ≤ 5MB, chỉ nhận jpg/png/webp), lưu tạm trong KV |
| `POST /api/generate` | Sinh `site.json` và bản đề xuất, tạo repo, bật Pages, trả về `jobId` |
| `GET /api/status/:jobId` | Trạng thái: `pending` / `ready` / `failed`, kèm link demo |
| `POST /api/revise` | Một lượt sửa demo (tối đa 3 lượt) |
| `POST /api/checkout` | Tạo link thanh toán PayOS |
| `POST /webhook/payos` | Nhận kết quả thanh toán (xác thực chữ ký, xử lý idempotent) |
| `POST /lead/:siteId` | Nhận dữ liệu form từ web demo của khách |
| `GET /leads/:siteId?key=` | Trang xem lead bằng link bí mật, có nút tải CSV |
| Cron `0 3 * * *` | Gỡ demo quá 30 ngày chưa thanh toán (xoá repo hoặc tắt Pages) |

## 3. Luồng tư vấn (chat có khung)

### 3.1 Phiếu yêu cầu (brief), gồm 10 mục
`nhu_cau` (gioi-thieu / thu-lead / ban-hang), `ten_don_vi`, `nganh`, `san_pham_chinh`, `khach_hang_muc_tieu`, `diem_manh`, `lien_he` (SĐT, Zalo, địa chỉ), `mau_sac`, `muc_tieu_web`, `tham_khao` (link hoặc ảnh mẫu).

### 3.2 Quy tắc hội thoại
- Mở đầu bằng 3 nút chọn nhu cầu, khách cũng có thể tự gõ.
- Mỗi lượt, AI trả về **JSON có cấu trúc** gồm: câu trả lời (tiếng Việt, ngắn, dễ hiểu), các mục brief vừa cập nhật, và 2–4 gợi ý trả lời nhanh. Worker gộp phần brief này vào phiên đang lưu trong KV.
- AI chỉ hỏi những mục còn thiếu, mỗi lượt hỏi tối đa 2 câu.
- Giao diện hiển thị thanh tiến độ "Đã đủ X/10 thông tin".
- AI chủ động mời khách gửi logo, ảnh sản phẩm, bảng giá/hồ sơ (PDF/Word), link web mẫu.
- **Giới hạn 12 lượt.** Từ lượt 9 trở đi, AI tóm tắt và đề nghị tạo demo. Đến lượt 12 thì bắt buộc chuyển sang bước tạo demo; AI tự điền nội dung hợp lý cho các mục còn trống và đánh dấu `"auto": true`.
- Khi khách gửi file PDF/Word, trình duyệt tự tách chữ (pdf.js, mammoth.js) và chỉ gửi đi tối đa 8.000 ký tự. AI không nhận file gốc.
- Màn hình chat có dòng nhắc: "Bản dùng thử là công khai, vui lòng không gửi thông tin nhạy cảm."

### 3.3 Định danh và chống lạm dụng
- Mỗi phiên phải qua Cloudflare Turnstile. Mỗi IP tối đa 3 phiên/ngày.
- Bắt buộc nhập SĐT/Zalo trước khi tạo demo. Mỗi SĐT chỉ được 1 demo (lưu trong KV), không có OTP.
- Có **trần chi phí AI theo ngày** (cấu hình được, đếm token trong KV). Khi vượt trần, hệ thống chỉ ghi nhận lead và báo khách "sẽ gửi demo trong 24h"; các yêu cầu này được xếp hàng và cron xử lý vào ngày hôm sau.

## 4. Tạo demo

### 4.1 Các mẫu web (nhóm A)
| Mẫu | Dùng cho | Các section |
|---|---|---|
| `tpl-gioi-thieu` | Website HTX/doanh nghiệp | hero, about, products, certs, gallery, map, contact |
| `tpl-thu-lead` | Landing page thu thông tin khách | hero, offer, benefits, lead_form, testimonials, faq, countdown |
| `tpl-ban-hang` | Catalog bán hàng | hero, products (có giá), order_zalo, contact |

- Viết bằng HTML/CSS/JS thuần, **không có bước build**. `index.html` gọi `fetch('site.json')` rồi render các section theo `type`.
- Ưu tiên giao diện điện thoại, ảnh tải lười (lazy-load), có thẻ SEO/OG lấy từ `site.json`.
- Nút "Đặt qua Zalo" mở `https://zalo.me/<sdt>`, kèm nút sao chép nội dung đơn hàng soạn sẵn.
- Form lead gửi `POST /lead/:siteId`.
- Khi `demo.badge = true`, hiển thị băng rôn "Bản dùng thử – tạo bởi [thương hiệu]" kèm nút "Triển khai chính thức".

### 4.2 Schema `site.json`
```json
{
  "schemaVersion": 1,
  "template": "tpl-gioi-thieu | tpl-thu-lead | tpl-ban-hang",
  "siteId": "string",
  "brand": { "name": "string", "logo": "assets/logo.png?", "color": "#RRGGBB", "slogan": "string?" },
  "contact": { "phone": "string", "zalo": "string?", "email": "string?", "address": "string?", "mapEmbed": "string?" },
  "seo": { "title": "string", "description": "string" },
  "hero": { "title": "string", "subtitle": "string", "image": "string?", "cta": "string" },
  "sections": [ { "type": "about|products|certs|gallery|map|contact|offer|benefits|lead_form|testimonials|faq|countdown|order_zalo", "...": "theo type" } ],
  "demo": { "badge": true, "expires": "YYYY-MM-DD", "checkoutUrl": "string" }
}
```
Worker dùng một schema validator (zod) để kiểm tra JSON. Nếu sai, AI được yêu cầu sửa lại 1 lần; vẫn sai thì gộp JSON của AI với **nội dung mặc định của mẫu** để demo không bao giờ trắng trang.

### 4.3 Quy trình `generate`
1. Model mạnh hơn nhận brief và phần chữ tách từ tài liệu, sinh ra `site.json` và `proposal.json` (vấn đề, giải pháp, các gói giá, lộ trình).
2. Kiểm tra JSON theo schema (mục 4.2).
3. GitHub App tạo repo `demo-<slug>-<4 ký tự ngẫu nhiên>` từ repo template (`POST /repos/{template}/generate`), đặt là public.
4. Commit `site.json` và ảnh vào `assets/`, sau đó bật Pages trên nhánh `main`.
5. Ghi một dòng vào Sheet (thời gian, tên, SĐT, nhu cầu, link demo, link lead, trạng thái `demo`) và gửi thông báo cho đội.
6. Cập nhật trạng thái job thành `ready`. Khách thấy link demo và link trang đề xuất.

### 4.4 Sửa demo
Mỗi lượt sửa, AI nhận `site.json` hiện tại cùng yêu cầu của khách và trả về JSON mới. JSON mới được kiểm tra schema rồi commit lại. Tối đa 3 lượt.

### 4.5 Trang đề xuất
Trang `web-main/proposal.html?id=` render `proposal.json`. Nội dung gồm: tóm tắt nhu cầu, giải pháp, ảnh demo, bảng các gói giá (từ 10 triệu), lộ trình và nút thanh toán. Có nút in/lưu PDF bằng chức năng in của trình duyệt.

## 5. Thanh toán
- `POST /api/checkout` tạo link PayOS cho gói khách chọn (từ 10.000.000đ). `orderCode` được gắn với `siteId`.
- Webhook PayOS: xác thực chữ ký checksum, bỏ qua nếu `orderCode` đã được xử lý. Khi thanh toán thành công thì cập nhật Sheet sang trạng thái `da_thanh_toan`, tắt cron gỡ demo cho site đó, và báo cho đội (Telegram hoặc email nội bộ).
- Trang cảm ơn: "Đội ngũ sẽ liên hệ trong 24h."

## 6. Bảo mật
- Dùng **GitHub Organization riêng cho demo** và **GitHub App** chỉ cài trên org đó, với các quyền: Administration (tạo repo), Contents (ghi), Pages (ghi). Không dùng tài khoản cá nhân hay PAT cá nhân.
- Các bí mật (khoá riêng GitHub App, khoá Claude API, khoá PayOS, URL Apps Script) chỉ nằm trong Worker Secrets.
- Repo demo để public, vì gói GitHub Free chỉ cho bật Pages trên repo public. Nội dung khách gửi vì thế là công khai, và giao diện có cảnh báo điều này. Khi khách trả tiền, bản chính thức chuyển sang repo private hoặc hosting khác.
- Điều khoản GitHub Pages không cho dùng Pages chủ yếu cho mục đích thương mại. Code tách riêng lớp `Publisher` để có thể đổi sang Cloudflare Pages bằng cấu hình `PUBLISHER=github|cloudflare`.
- `/lead/:siteId` chống spam bằng honeypot field và giới hạn tần suất theo IP. `/leads/:siteId` dùng khoá ngẫu nhiên 32 ký tự.
- File upload: kiểm tra MIME và kích thước ngay trong Worker; bỏ siêu dữ liệu EXIF nếu làm được.

## 7. Xử lý lỗi
| Lỗi | Cách xử lý |
|---|---|
| AI trả JSON sai | Sửa lại 1 lần, sau đó dùng nội dung mặc định |
| Gọi Claude API lỗi hoặc timeout | Thử lại 2 lần với backoff; vẫn lỗi thì báo khách thử lại sau, phiên chat được giữ nguyên |
| GitHub API lỗi hoặc rate limit | Thử lại 3 lần; trạng thái job giữ `pending`; khách thấy trang trạng thái tự cập nhật |
| Pages chưa sẵn sàng | Gọi API Pages để kiểm tra mỗi 10 giây, tối đa 3 phút |
| Vượt trần chi phí AI | Ghi nhận lead và xếp hàng, cron xử lý ngày hôm sau |
| Webhook trùng lặp | Idempotent theo `orderCode` |
| Upload sai định dạng hoặc quá lớn | Chặn ở trình duyệt và trong Worker, báo lỗi bằng tiếng Việt |

## 8. Chi phí ước tính (cần kiểm tra lại trước khi chạy thật)
- Cloudflare Pages, Workers, KV, Turnstile (gói miễn phí), GitHub Free, Google Sheet: **0đ** ở quy mô MVP.
- AI: khoảng 30–50 nghìn token cho mỗi khách. Theo các trang tổng hợp giá bên thứ ba, Claude Haiku 5.5 có giá khoảng 0,10 USD/1 triệu token đầu vào và 0,50 USD/1 triệu token đầu ra. Nếu đúng như vậy, chi phí chat chỉ khoảng vài trăm đồng mỗi khách; phần tạo nội dung dùng model mạnh hơn sẽ đắt hơn. Mục tiêu dưới 2.000đ/khách. Cần đối chiếu với trang giá chính thức của Anthropic.
- PayOS: tính phí theo giao dịch. Cần xem biểu phí hiện hành trên payos.vn.

## 9. Kiểm thử
- **Schema:** unit test zod với JSON đúng, sai, và thiếu trường.
- **Mẫu web:** Playwright render từng mẫu với 5 file `site.json` mẫu, chụp màn hình ở kích thước 375px và 1280px; kiểm tra không có lỗi console và không có section rỗng.
- **Worker:** Vitest với `@cloudflare/vitest-pool-workers`; giả lập Claude, GitHub, PayOS, Apps Script.
- **Giới hạn:** test giới hạn lượt chat, mỗi SĐT 1 demo, trần chi phí, idempotent webhook.
- **Chạy thử toàn bộ:** dùng GitHub Org riêng để test và Worker môi trường staging. Thanh toán thử bằng đơn số tiền nhỏ, vì PayOS có thể không có sandbox.

## 10. Lộ trình sau MVP (chỉ để định hướng, không làm trong spec này)
- **Giai đoạn 2, nhóm B:** webtool một file HTML chạy trên trình duyệt (SheetJS đọc Excel/MISA, biểu đồ, lưu localStorage), dùng chung luồng chat và tạo demo.
- **Giai đoạn 3, nhóm C:** gói marketing mẫu (lịch đăng bài, bài nháp, mockup standee) kèm báo giá.
- Đẩy lead về Zalo/Google Sheet của khách, tên miền riêng (dành cho gói trả tiền).

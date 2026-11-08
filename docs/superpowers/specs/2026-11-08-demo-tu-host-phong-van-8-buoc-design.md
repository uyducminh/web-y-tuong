# Spec bổ sung: Demo tự host, phỏng vấn 8 bước, bộ hồ sơ dùng thử

- Ngày: 2026-11-08
- Trạng thái: Chờ duyệt
- Thay thế một phần spec gốc `2026-11-08-sme-mvp-builder-design.md`: §3 (luồng tư vấn), §4 (tạo demo), §6 (phần GitHub). Các phần còn lại của spec gốc vẫn giữ nguyên.

## 1. Mục tiêu

1. Ở bước dùng thử, khách **chỉ được xem**: không giao mã nguồn, không tạo repo hay website riêng cho khách. Khách trả tiền (từ 10.000.000đ) mới nhận bản chính thức, do đội ngũ làm.
2. Khách nhận một **bộ hồ sơ dùng thử có nội dung thật**:
   - link web mẫu;
   - ảnh giao diện (PNG);
   - bản phân tích và đề xuất (PDF);
   - cùng bản phân tích đó dạng Word (DOCX).
3. Phỏng vấn **kỹ theo 8 bước**. Nút "Tạo bản dùng thử" chỉ hiện khi đủ thông tin bắt buộc và khách đã xác nhận bản tóm tắt.
4. Khách tải lên được **ảnh, PDF, Word, Excel**.
5. Trong lúc tạo, màn hình chờ báo rõ từng bước và nhắc khách giữ trang mở.

### Tiêu chí thành công

- Không còn bất kỳ repo GitHub nào được tạo ở bước dùng thử.
- Hơn 90% phiên đi hết 8 bước tạo được bộ hồ sơ đủ 4 thứ, trong đó web mẫu có ít nhất 3 section có nội dung.
- Bản PDF/DOCX miễn phí không chứa phần nội dung chỉ dành cho bản trả phí.
- Chi phí AI dưới 2.000đ/khách.

## 2. Phỏng vấn 8 bước

### 2.1 Phiếu yêu cầu v2 (`BriefV2`)

Phiếu chia theo bước. Dấu * là mục bắt buộc trước khi được tạo demo.

| Bước | Mã bước | Các mục |
|---|---|---|
| 1. Đơn vị và ngành nghề | `don_vi` | `ten_don_vi`*, `loai_hinh` (htx/cong-ty/ho-kd/khac)*, `nganh`*, `dia_phuong`*, `quy_mo`, `nam_thanh_lap` |
| 2. Sản phẩm và dịch vụ | `san_pham` | `san_pham`* (danh sách `{ten, gia?, mo_ta?, anh?}`, ít nhất 1), `chung_nhan[]`, `diem_khac_biet`* |
| 3. Khách hàng | `khach_hang` | `khach_hang_muc_tieu`*, `khu_vuc_khach`, `kenh_ban_hien_tai[]` |
| 4. Mục tiêu website | `muc_tieu` | `muc_tieu_chinh`* (gioi-thieu/ban-hang/thu-lead/tim-dai-ly/tuyen-dung), `hanh_dong_mong_muon`* (goi/zalo/dat-hang/dang-ky), `thanh_cong_la_gi` |
| 5. Phong cách | `phong_cach` | `cam_giac`* (moc-mac/truyen-thong/hien-dai/sang-trong/tre-trung), `mau_chu_dao` (#RRGGBB), `co_logo` (bool) |
| 6. Website tham khảo | `tham_khao` | `web_tham_khao[]` (`{url?, anh?, thich_diem_gi}`) — không bắt buộc, nhưng AI phải hỏi |
| 7. Tài liệu và hình ảnh | `tai_lieu` | `uploads[]`, `docsText` (cả hai đã có ở phiên) — không bắt buộc, nhưng AI phải mời khách gửi |
| 8. Liên hệ và xác nhận | `xac_nhan` | `lien_he`* (`phone`* hoặc `zalo`*, `address`, `gio_mo_cua`, `fanpage`), `da_xac_nhan` (bool, chỉ đặt qua endpoint xác nhận) |

Phiếu có thêm `meta: { auto?: string[]; step: StepId; askedOptional: StepId[] }`.

### 2.2 Quy tắc chat

- Tối đa **30 lượt**. Từ lượt 26, AI tóm tắt và đề nghị chuyển sang bước 8.
- Mỗi lượt AI trả về các trường sau:

  | Trường | Ý nghĩa |
  |---|---|
  | `reply` | Câu trả lời cho khách |
  | `briefPatch` | Phần phiếu yêu cầu vừa cập nhật |
  | `quickReplies` | 2–4 gợi ý trả lời nhanh |
  | `choices?` | Thẻ chọn: `{kind:'single'\|'multi', options:[{value,label,hint?}]}` cho ngành, mục tiêu, cảm giác, kênh bán |
  | `step` | Bước hiện tại |
  | `stepDone` | Bước hiện tại đã xong chưa |

- Code chịu trách nhiệm, không phải AI:
  - tính **bước hiện tại** = bước đầu tiên còn thiếu mục bắt buộc, hoặc bước tuỳ chọn chưa được hỏi (`askedOptional`);
  - quyết định nút tạo demo.
- Câu trả lời mơ hồ ("bán đồ ăn", "đẹp là được") thì AI phải hỏi lại cụ thể. Mỗi lượt AI hỏi tối đa 2 câu.
- Giao diện hiển thị:
  - thanh **"Bước X/8 · <tên bước>"** và danh sách 8 bước có dấu tích;
  - thẻ chọn phong cách, mỗi thẻ có một khối màu minh hoạ (không dùng ảnh bên ngoài);
  - dòng nhắc thông tin nhạy cảm (giữ như cũ).

### 2.3 Xác nhận trước khi tạo

- **`GET /api/brief/:sessionId`** trả về `{ brief, step, missing[], canConfirm }`. `canConfirm` là true khi mọi mục bắt buộc đã có.
- Đến bước 8 và `canConfirm` là true, giao diện hiện **bản tóm tắt dễ đọc** của phiếu yêu cầu, chia theo bước, có nút "Sửa" ở từng bước (bấm vào thì gửi một câu chat yêu cầu sửa).
- **`POST /api/brief/confirm {sessionId}`** đặt `da_xac_nhan = true`. Trả 409 nếu thiếu mục bắt buộc. Gửi thêm tin chat sửa phiếu sau khi đã xác nhận thì cờ này tự bị huỷ.
- **`POST /api/generate`** trả 409 nếu `da_xac_nhan` khác true.

### 2.4 Tài liệu tải lên

- **Ảnh:** giữ như hiện tại (tối đa 10 ảnh, nén trên trình duyệt).
- **PDF, DOCX:** tách chữ trên trình duyệt, gửi lên `/api/docs`. **Tổng `docsText` tối đa 20.000 ký tự** (trước đây 8.000).
- **Excel (.xlsx, .xls, .csv):** đọc trên trình duyệt bằng SheetJS (cdnjs), lấy tối đa 3 sheet, mỗi sheet 200 dòng.
  - Chuyển thành bảng chữ dạng `cột | cột` và gửi lên `/api/docs`.
  - Nếu nhận ra cột tên sản phẩm và cột giá (theo tiêu đề cột như "tên", "sản phẩm", "giá", "đơn giá"), gửi thêm `POST /api/products {sessionId, items:[{ten, gia}]}`, tối đa 60 sản phẩm. Danh sách này được gộp vào `brief.san_pham` và đánh dấu bước 2 đã có sản phẩm.
- Không đọc được file thì báo lỗi bằng tiếng Việt và mời khách nhập tay.

## 3. Tạo bộ hồ sơ

### 3.1 Đầu ra của AI

Một lần gọi `GEN_MODEL` (tool `emit_package`) trả về `{ site, analysis }`:

- `site`: `site.json` theo schema từng loại section đã có. Prompt kèm khung `defaultSite` của mẫu được chọn.
- `analysis` (`AnalysisSchema`) gồm hai phần:

  ```
  {
    free: {
      tom_tat_doanh_nghiep: string,
      phan_tich_nhu_cau: string,
      khach_hang_muc_tieu: string,
      muc_tieu_website: string[],
      phong_cach: { mo_ta: string, bang_mau: string[] },
      nhan_xet_web_tham_khao: { nguon: string, diem_hoc_hoi: string }[],
      so_do_trang: { trang: string, muc_dich: string }[]
    },
    full: {
      noi_dung_tung_trang: { trang: string, cac_khoi: { tieu_de: string, noi_dung: string }[] }[],
      ke_hoach_trien_khai: { buoc: string, viec: string[] }[],
      goi_y_fanpage: string[],
      viec_khach_can_chuan_bi: string[]
    }
  }
  ```

- Template được chọn bằng code, theo `muc_tieu_chinh`: `ban-hang` → `tpl-ban-hang`; `thu-lead`/`tim-dai-ly`/`tuyen-dung` → `tpl-thu-lead`; còn lại → `tpl-gioi-thieu`.
- **Kiểm tra và dự phòng:**
  - Sai schema thì thử lại 1 lần.
  - Lần thử lại lỗi hoặc quá thời gian thì **dùng `mergeFallback` với kết quả đúng một phần của lần đầu**, không vứt bỏ.
  - `analysis` lỗi thì dùng bản phân tích mặc định dựng từ phiếu yêu cầu.
  - Chi phí luôn được ghi nhận.

### 3.2 Pipeline job

- Các giai đoạn: `queued → ai → ready` (bỏ `ai_done`, `publishing`, `published` và toàn bộ phần chờ GitHub Pages).
- Giữ nguyên `POST /api/jobs/:id/run`, cơ chế khoá chống chạy chồng (lease), việc huỷ job quá 10 phút và trả lại SĐT.
- Khi `ready`:
  - lưu KV: `sitejson:<siteId>`, `analysis:<siteId>` (cả `free` lẫn `full`), `site:<siteId>` (SiteMeta);
  - **sao chép ảnh từ `up:<sessionId>:<n>` sang `asset:<siteId>:<path>`**, TTL bằng hạn của demo (30 ngày), vì key `up:` chỉ sống 7 ngày;
  - ghi một dòng vào Sheet và gửi thông báo cho đội (giữ như cũ, với `link_demo = <API_BASE>/d/<siteId>`).
- `SiteMeta` bỏ `repo`, thêm `template`, `analysisReady: true`.
- `siteId` = `<slug>-<6 ký tự ngẫu nhiên>`.

### 3.3 Trang demo tự host

- **`GET /d/:siteId`** trả về HTML của template, ghép từ các file `templates/tpl-*/index.html`, `theme.css`, `templates/_shared/{render.js,base.css}`. Các file này được nhúng vào Worker dưới dạng text (wrangler `[[rules]] type = "Text"`), không cần bước build web.
  - Trang tải `site.json` từ `GET /d/:siteId/site.json`, ảnh từ `GET /d/:siteId/assets/:file`.
  - Header: `X-Robots-Tag: noindex, nofollow`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `Content-Security-Policy` chỉ cho phép script/style của chính Worker và các CDN đã liệt kê.
  - Thêm băng rôn "Bản dùng thử – <platform-name>", có nút "Xem bộ hồ sơ" dẫn về `/package/<siteId>`.
  - Form thu lead trên demo vẫn gửi về `/lead/:siteId` như cũ.
- Đã hết hạn (`now > expires` và chưa thanh toán), hoặc `removed`: trả 410 kèm trang tiếng Việt "Bản dùng thử đã hết hạn", có SĐT/Zalo liên hệ lấy từ config `CONTACT_PHONE`.
- Không tồn tại: trả 404.
- `siteId` sai định dạng (`^[a-z0-9-]{1,64}$`): trả 404.

### 3.4 Trang "Bộ hồ sơ dùng thử" (`GET /package/:siteId`, do Worker phục vụ)

- Dữ liệu lấy từ `GET /api/package/:siteId`, trả về `{ site:{name, url, expires, paid}, analysis: free | (free+full nếu paid), packages, demoUrl }`.
- Khi chưa thanh toán, phần `full` **không bao giờ** được gửi về trình duyệt.
- Trang hiển thị:
  1. Nút **"Mở website mẫu"** → `demoUrl` (mở tab mới, dùng `<a>` thật).
  2. **Ảnh giao diện.**
     - Trang nhúng web mẫu trong một iframe cùng tên miền với Worker, ở khổ 390px và 1280px.
     - html2canvas (cdnjs) chụp lại, thêm watermark chéo "BẢN DÙNG THỬ", rồi cho tải xuống `giao-dien-<siteId>-mobile.png` và `giao-dien-<siteId>-desktop.png`.
     - Chụp lỗi thì ẩn nút và hiện "Mở website mẫu để xem".
  3. **Bản phân tích** hiển thị ngay trên trang (phần free). Phần full hiện dạng khung mờ khoá, ghi "Mở khoá sau khi triển khai chính thức".
  4. **"Tải PDF":** trang in có định dạng sẵn (bìa, mục lục, ảnh giao diện, phân tích, gói giá, lộ trình rút gọn) qua `window.print()`.
  5. **"Tải Word (DOCX)":** thư viện `docx` (jsdelivr) tạo file cùng nội dung với PDF, gồm cả ảnh giao diện nếu đã chụp được.
  6. Các gói giá lấy từ `config.packages` và nút thanh toán (giữ như cũ).
- **Ràng buộc với web-main:** trang `/d/` chạy trên tên miền Worker, còn web-main có thể ở tên miền khác. Để chụp ảnh qua iframe được, `package.html` phải được phục vụ **từ chính Worker**, tại `GET /package/:siteId`, cùng tên miền với `/d/`. Web-main chỉ chuyển hướng tới trang này. Như vậy không cần CORS cho ảnh và canvas không bị "tainted".

### 3.5 Màn hình chờ (trang trạng thái)

- 4 bước có dấu tích, chạy theo giai đoạn của job và thời gian đã trôi qua:
  1. "Đang phân tích ngành nghề và khách hàng"
  2. "Đang viết nội dung website"
  3. "Đang dựng giao diện"
  4. "Đang soạn bản phân tích"
- Có thanh tiến độ và câu "Khoảng 1–2 phút, vui lòng giữ trang này mở".
- Xong thì tự chuyển sang `/package/:siteId`.
- Mở lại link trạng thái thì chạy tiếp từ bước đang dở (cơ chế hiện có).

### 3.6 Sửa demo (3 lượt)

`POST /api/revise` chỉ cập nhật `sitejson:<siteId>`, áp dụng ngay, không còn chờ build. Không đổi `analysis`.

## 4. Sau khi thanh toán và bàn giao

- Webhook đã có: thêm việc đặt `paid:<siteId>`. Sau đó `GET /api/package/:siteId` trả cả phần `full`.
- **`GET /handoff/:siteId?key=<handoffKey>`**:
  - `handoffKey` = `rand(32)`, lưu trong SiteMeta, so sánh constant-time. Thiếu key hoặc sai key thì trả 403.
  - Trả về trang HTML liệt kê đầy đủ dữ liệu: phiếu yêu cầu (dễ đọc), `site.json`, `analysis` đầy đủ, `docsText`, link từng ảnh gốc. Có nút tải `handoff-<siteId>.json`, file này chứa tất cả các phần trên, ảnh để dạng base64.
  - Link này được gửi trong tin Telegram báo thanh toán và ghi vào cột `link_ban_giao` của Sheet.
- **Dữ liệu của site đã thanh toán không bao giờ bị cron xoá.** Khi thanh toán, key `asset:` được ghi lại không có TTL.

## 5. Cron và dọn dẹp

- Site hết hạn mà chưa thanh toán: xoá `sitejson:`, `analysis:`, `asset:<siteId>:*`, `proposal:`; giữ `site:` với cờ `removed: true` để trang `/d/` trả 410.
- Phần xoá repo qua Publisher không còn chạy cho demo.

## 6. Bỏ và giữ lại

- **Bỏ khỏi luồng demo:** GitHub App, GitHub Organization dùng cho demo, `sync-templates`, các biến `GH_*` (chuyển thành không bắt buộc), lời nhắc điều khoản GitHub Pages.
- **Giữ lại:** interface `Publisher` và code GitHub publisher (không ai gọi tới) để sau này có thể bàn giao tự động. SETUP.md cập nhật lại.
- **Thêm biến:** `CONTACT_PHONE`, `PLATFORM_NAME` (mặc định "Web Làng").

## 7. Bảo mật

- Trang demo chỉ nhận dữ liệu đã qua schema. Renderer giữ nguyên quy tắc chỉ dùng `textContent` và `safeUrl`. Trang bộ hồ sơ và trang bàn giao escape toàn bộ chữ.
- Không bao giờ gửi `analysis.full` cho người chưa thanh toán. Có test riêng cho điều này.
- Link bàn giao chỉ đi qua Telegram và Sheet nội bộ.

## 8. Kiểm thử

- **Schema:** BriefV2, các mục bắt buộc theo bước, AnalysisSchema.
- **Chat:**
  - tính đúng bước hiện tại;
  - bước tuỳ chọn được hỏi đúng một lần;
  - giới hạn 30 lượt, nhắc tóm tắt từ lượt 26;
  - thẻ chọn bị giới hạn số lựa chọn;
  - confirm trả 409 khi thiếu mục bắt buộc;
  - chat sau khi xác nhận làm huỷ cờ xác nhận;
  - generate trả 409 khi chưa xác nhận.
- **Excel:** file mẫu tiếng Việt (có cột "Tên sản phẩm", "Đơn giá") cho ra đúng danh sách sản phẩm; file không có cột giá chỉ gửi chữ; giới hạn 60 sản phẩm.
- **Pipeline:**
  - giai đoạn `ai → ready`;
  - ảnh được sao chép sang `asset:`;
  - lần thử lại bị quá thời gian vẫn giữ nội dung của lần đầu.
- **Trang `/d/`:**
  - 200 với đủ header;
  - 410 khi hết hạn, 404 khi sai định dạng;
  - ảnh phục vụ đúng MIME;
  - Playwright ở 375px và 1280px: có ít nhất 3 section, không có lỗi console.
- **Bộ hồ sơ:** chưa thanh toán thì không có trường `full` trong JSON; đã thanh toán thì có; nút PNG, PDF, DOCX tạo được file (Playwright, kiểm tra sự kiện download hoặc chuỗi byte của file).
- **Bàn giao:** 403 khi không có key; JSON đủ các phần.
- **Cron:** xoá đúng các key của site hết hạn, không đụng site đã thanh toán.

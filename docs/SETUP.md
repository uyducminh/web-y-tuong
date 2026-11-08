# Hướng dẫn cài đặt SME MVP (từng bước)

Tài liệu này dành cho người không rành kỹ thuật. Lệnh và tên biến giữ nguyên tiếng Anh, copy–dán đúng như trong khung code.

**Bạn cần có sẵn:** máy tính cài Node 22, `pnpm` 10, `git`, `openssl`; tài khoản Cloudflare (**gói Workers Paid**, xem Bước 0), Google, PayOS, Telegram và Anthropic (có API key). **Không cần tài khoản GitHub** để chạy bản dùng thử: Worker tự phục vụ trang demo.

Cài thư viện một lần ở thư mục gốc dự án:

```bash
pnpm install
```

> Nên làm xong **staging** (môi trường thử, dùng KV và khoá riêng) rồi mới làm **production**. Mỗi bước dưới đây làm cho staging trước; production lặp lại với tên/khoá khác.

---

## Bước 0. Cloudflare: bắt buộc gói Workers Paid ($5/tháng)

Hệ thống **không chạy ổn trên gói Workers Free**. Trước khi deploy, vào Cloudflare → **Workers & Pages → Plans** và nâng tài khoản lên **Workers Paid** (tối thiểu 5 USD/tháng cho cả tài khoản, dùng chung cho staging và production). Lý do:

- **CPU:** gói Free chỉ cho khoảng 10ms CPU mỗi yêu cầu. Tải ảnh lên (tới 5MB/ảnh: đọc, kiểm tra định dạng, mã hoá base64 để lưu) cần nhiều hơn thế, nên ảnh lớn sẽ bị lỗi giữa chừng. Gói Paid cho thời gian CPU dài hơn nhiều.
- **Số lượt ghi KV:** gói Free chỉ có **1.000 lượt ghi KV/ngày** cho cả tài khoản (đếm lại lúc 00:00 UTC; vượt là mọi lượt ghi sau đó báo lỗi). Mỗi khách đi hết luồng (tạo phiên, tối đa 30 lượt chat, vài ảnh, tạo demo qua từng bước) tốn khoảng **30–40 lượt ghi**, nhiều hơn nếu gửi nhiều ảnh → chỉ khoảng **25–30 khách/ngày** là hết hạn mức. Gói Paid có sẵn 1 triệu lượt ghi/tháng (vượt thì tính thêm 5 USD/triệu lượt).
- **Giới hạn vẫn còn ở cả gói Paid** (hệ thống đã được thiết kế để không vượt):
  - Mỗi **khoá KV chỉ ghi được khoảng 1 lần/giây** → bộ đếm chi phí AI trong ngày được chia thành nhiều khoá (`cost:<ngày>:<n>`); nếu ghi chi phí vẫn lỗi thì chỉ ghi log, không làm hỏng lượt chat của khách (trần chi phí ngày khi đó có thể tính thiếu một chút).
  - Mỗi lần chạy Worker (kể cả cron hằng ngày) tối đa **1.000 thao tác KV** → cron chỉ đọc chỉ mục `exp:<ngày>:<siteId>` của những ngày đã đến hạn và `jobidx:<jobId>` của các yêu cầu tạo demo chưa xong, không quét toàn bộ dữ liệu.
  - KV **không đảm bảo đọc được ngay giá trị vừa ghi ở nơi khác** (có thể trễ tới khoảng 60 giây giữa các khu vực). Cơ chế "khoá" (lease) của một yêu cầu tạo demo dựa trên ghi rồi đọc lại, nên chỉ là cố gắng tốt nhất chứ không tuyệt đối.
- **Thời gian chạy:** mỗi yêu cầu tạo demo có bước gọi AI mất 1–3 phút. Hệ thống **không** dùng `ctx.waitUntil` cho việc này (Cloudflare dừng việc chạy nền khoảng 30 giây sau khi trả lời); thay vào đó trang trạng thái gọi `POST /api/jobs/<id>/run` lần lượt từng bước, và cron hằng ngày chạy nốt các yêu cầu khách bỏ dở.

Xem thêm: https://developers.cloudflare.com/workers/platform/pricing/ và https://developers.cloudflare.com/kv/platform/limits/

---

## Bước 1. Tạo KV namespace và Turnstile

**KV (nơi lưu trạng thái):**

```bash
pnpm --filter @sme/worker exec wrangler login
pnpm --filter @sme/worker exec wrangler kv namespace create KV --env staging
```

Lệnh in ra `id = "..."`. Dán id đó vào `worker/wrangler.toml`, mục `[[env.staging.kv_namespaces]]` (thay `REPLACE_WITH_STAGING_KV_NAMESPACE_ID`). Với production, chạy lại không có `--env staging` và điền vào `[[kv_namespaces]]`.

**Turnstile (chống bot):** Cloudflare Dashboard → *Turnstile* → *Add site*. Lấy **Site key** (công khai, đặt vào trang web) và **Secret key** (giữ kín, là `TURNSTILE_SECRET`).

*Chạy thử trên máy / staging:* dùng khoá thử "luôn qua" của Cloudflare:

- Site key: `1x00000000000000000000AA`
- Secret key: `1x0000000000000000000000000000000AA`

Lưu ý: nếu `turnstile-sitekey` trong web để trống, web-main gửi token `dev`; token này **chỉ** được chấp nhận khi Worker dùng secret thử ở trên. Production phải dùng khoá thật.

---

## Bước 2. Deploy Google Apps Script (ghi lead vào Google Sheet)

1. Tạo Google Sheet mới (tên tuỳ ý).
2. **Extensions → Apps Script**, xoá code mẫu, dán toàn bộ nội dung file `sheet-bridge/Code.gs`.
3. **Project Settings → Script properties → Add**: `SHEET_TOKEN` = một chuỗi bí mật dài ngẫu nhiên (tạo bằng `openssl rand -hex 24`). Ghi lại, đây cũng là `SHEET_TOKEN` của Worker.
4. **Deploy → New deployment → Web app**: *Execute as: Me*, *Who has access: Anyone*. Cấp quyền khi được hỏi.
5. Copy URL kết thúc bằng `/exec` → đây là `SHEET_URL`.

Sheet có tab `leads`, cột `trang_thai` sẽ chuyển `demo` → `da_thanh_toan` sau khi khách trả tiền.

---

## Bước 3. PayOS: lấy khoá và đăng ký webhook

1. Đăng ký/đăng nhập https://payos.vn, tạo **Kênh thanh toán**. Lấy ba khoá: `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY`.
2. Trong cài đặt kênh, đặt **Webhook URL** là:

   ```
   https://<địa-chỉ-worker>/webhook/payos
   ```

   Ví dụ `https://sme-mvp-worker-staging.<tài-khoản>.workers.dev/webhook/payos`. Làm bước này sau khi deploy Worker (biết được địa chỉ).
3. PayOS có thể **không có môi trường sandbox**. Khi đó staging được thử bằng **một đơn thật giá rất nhỏ** (xem Bước 7).
4. Khi một thông báo thanh toán **đã xác thực chữ ký** mà Worker xử lý lỗi (ví dụ KV quá tải), Worker trả mã 500 (để PayOS có thể gửi lại) và nhắn Telegram **"CẢNH BÁO THANH TOÁN"** kèm mã đơn, số tiền, mã tham chiếu; số tiền không khớp cũng có cảnh báo tương tự. Gặp tin này hãy đối chiếu trong trang PayOS và liên hệ khách thủ công. Có thể nhận **2 tin "ĐÃ THANH TOÁN"** cho cùng một đơn khi PayOS gửi lại — đó là bình thường.

---

## Bước 4. Tạo Telegram bot

1. Mở Telegram, nhắn `@BotFather` → `/newbot` → đặt tên → nhận **token** = `TELEGRAM_BOT_TOKEN`.
2. Tạo một nhóm (hoặc dùng chat riêng), thêm bot vào, gửi một tin nhắn bất kỳ.
3. Mở `https://api.telegram.org/bot<TOKEN>/getUpdates`, tìm `"chat":{"id":...}` → số đó là `TELEGRAM_CHAT_ID` (nhóm thường là số âm).

---

## Bước 5. Khai báo secret cho Worker (`wrangler secret put`)

Chạy trong thư mục `worker/`. Mỗi lệnh sẽ hỏi giá trị, dán vào rồi Enter. Bản dùng thử **không** cần secret `GH_*` nào (chỉ cần khi bật bàn giao tự động, xem mục "Tuỳ chọn" cuối tài liệu).

**Staging:**

```bash
cd worker
for s in ANTHROPIC_API_KEY \
         PAYOS_CLIENT_ID PAYOS_API_KEY PAYOS_CHECKSUM_KEY \
         SHEET_URL SHEET_TOKEN TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TURNSTILE_SECRET; do
  echo "== $s"; pnpm exec wrangler secret put $s --env staging
done
```

**Production** (không có `--env`):

```bash
cd worker
for s in ANTHROPIC_API_KEY \
         PAYOS_CLIENT_ID PAYOS_API_KEY PAYOS_CHECKSUM_KEY \
         SHEET_URL SHEET_TOKEN TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TURNSTILE_SECRET; do
  echo "== $s"; pnpm exec wrangler secret put $s
done
```

Ý nghĩa nhanh: `TURNSTILE_SECRET` = secret key Turnstile (staging: khoá thử ở Bước 1); `SHEET_URL`/`SHEET_TOKEN` từ Bước 2; `PAYOS_*` từ Bước 3; `TELEGRAM_*` từ Bước 4.

---

## Bước 6. Khai báo biến thường (`[vars]`)

Sửa `worker/wrangler.toml`, mục `[vars]` (production) hoặc `[env.staging.vars]` (staging). Các biến:

| Biến | Ý nghĩa | Ví dụ |
|---|---|---|
| `CHAT_MODEL` | Model chat (mặc định `claude-haiku-5-5`) | `claude-haiku-5-5` |
| `GEN_MODEL` | Model sinh website (mặc định `claude-sonnet-5-5`) | `claude-sonnet-5-5` |
| `PRICE_IN_PER_MTOK` | Giá USD / 1 triệu token **vào**, theo model (JSON) | `{"claude-haiku-5-5":1,"claude-sonnet-5-5":3}` |
| `PRICE_OUT_PER_MTOK` | Giá USD / 1 triệu token **ra**, theo model (JSON) | `{"claude-haiku-5-5":5,"claude-sonnet-5-5":15}` |
| `DAILY_CAP_USD` | Trần chi phí AI mỗi ngày; vượt thì xếp hàng, cron xử lý hôm sau | `10` |
| `PACKAGES` | Các gói triển khai (JSON, chuỗi một dòng) | xem dưới |
| `WEB_ORIGIN` | Địa chỉ web chính (Cloudflare Pages), dùng cho CORS | `https://sme-mvp.pages.dev` |
| `API_BASE` | Địa chỉ chính Worker, không có `/` ở cuối. **Phải là đúng địa chỉ (origin) đang phục vụ trang demo `/d/`**: link demo, link bộ hồ sơ, nơi form gửi lead và CORS của `/lead/*` đều lấy từ đây | `https://sme-mvp-worker.<tài-khoản>.workers.dev` |
| `PLATFORM_NAME` | Tên nền tảng trên băng rôn demo `/d/` và trang bộ hồ sơ (mặc định `Web Làng`) | `Web Làng` |
| `CONTACT_PHONE` | SĐT/Zalo hiện trên trang "Bản dùng thử đã hết hạn" | `0912345678` |
| `ALLOW_TEST_PRICE` | `1` = bỏ kiểm tra giá tối thiểu. **Chỉ staging** | `1` |

Giá trên chỉ là ví dụ: **tự kiểm tra bảng giá Claude hiện hành** rồi điền. Đơn giá không được hard-code trong code.

**Ví dụ `PACKAGES`** (mọi gói phải ≥ 10.000.000đ ở production):

```toml
PACKAGES = '[{"id":"co-ban","name":"Cơ bản","priceVnd":10000000,"items":["Website 1 trang","Tên miền .vn 1 năm","Hướng dẫn sử dụng"]},{"id":"nang-cao","name":"Nâng cao","priceVnd":18000000,"items":["Website nhiều trang","Form nhận khách + Google Sheet","Hỗ trợ 3 tháng"]}]'
```

Với staging, để thử thanh toán thật đặt `ALLOW_TEST_PRICE = "1"` và gói `"priceVnd":2000`. **Không bao giờ đặt `ALLOW_TEST_PRICE` ở production.**

**`GH_ORG` và `PUBLISHER`** chỉ dùng cho bàn giao tự động (mục "Tuỳ chọn" cuối tài liệu); bản dùng thử bình thường không cần, để nguyên giá trị trong `wrangler.toml`.

**`CONTACT_PHONE`** nên điền số thật trước khi mở bán: khi bản dùng thử hết hạn, trang `/d/` và `/package/` trả mã 410 với dòng "liên hệ <số này>". Để trống thì trang hết hạn không có số liên hệ.

> **Cảnh báo:** `ALLOW_TEST_SEED` là cờ chỉ dành cho test e2e chạy trên máy (cho phép ghi dữ liệu giả thẳng vào KV). **Không bao giờ** đặt nó trong `wrangler.toml` hay secret của staging/production, và không đặt khi `wrangler deploy`.

---

## Bước 7. Deploy Worker, web chính, chạy thử

### 7.1 Deploy Worker

```bash
pnpm -F @sme/worker run deploy --env staging
```

Dùng `run deploy` (không gọi thẳng `wrangler deploy`) để bước `predeploy` chạy `scripts/embed-templates.ts`, nhúng bản template mới nhất vào Worker.

In ra địa chỉ Worker, ví dụ `https://sme-mvp-worker-staging.<tài-khoản>.workers.dev`. Điền địa chỉ này vào `API_BASE` (Bước 6) và vào webhook PayOS (Bước 3), rồi deploy lại. `API_BASE` **phải đúng** địa chỉ này: link demo `/d/`, link bộ hồ sơ `/package/` và form gửi lead đều lấy từ đó.

### 7.2 Cấu hình và deploy web chính (Cloudflare Pages)

Đặt thẻ meta **trước khi deploy**. `api-base` có ở `web-main/chat.html`, `status.html`, `proposal.html` (phải điền cả ba); `turnstile-sitekey` chỉ có ở `web-main/chat.html` (nơi tạo phiên). `index.html` và `thanks.html` không gọi API.

```html
<meta name="api-base" content="https://sme-mvp-worker-staging.<tài-khoản>.workers.dev">
<meta name="turnstile-sitekey" content="1x00000000000000000000AA">
```

- `api-base`: địa chỉ Worker (không có dấu `/` cuối), **cùng giá trị với `API_BASE` của Worker**. **Bắt buộc phải đặt**: web chính (Pages) và Worker khác tên miền, nên nếu để trống thì trang chat, trang trạng thái và trang đề xuất không gọi được Worker. Để trống = cùng tên miền với trang (sẽ hỏng vì web và Worker khác tên miền).
- `turnstile-sitekey`: site key Turnstile (production dùng khoá thật; để trống thì web gửi token `dev`).

Deploy thư mục `web-main` (HTML/CSS/JS thuần, không có bước build):

```bash
pnpm dlx wrangler pages deploy web-main --project-name sme-mvp-staging
```

Địa chỉ Pages nhận được phải khớp `WEB_ORIGIN` (Bước 6), nếu không trình duyệt sẽ chặn CORS.

### 7.3 Chạy `smoke` (kiểm tra toàn bộ luồng)

```bash
pnpm smoke https://sme-mvp-worker-staging.<tài-khoản>.workers.dev
```

Script lần lượt: tạo phiên (token Turnstile thử) → phỏng vấn (trả lời theo kịch bản cho tới khi hồ sơ đủ điều kiện xác nhận, tối đa 30 lượt; mỗi lượt in ra bước hiện tại, ví dụ `step=san_pham done=2/8 canConfirm=false`) → gửi danh sách sản phẩm (`/api/products`) → xác nhận (`/api/brief/confirm`, kèm SĐT liên hệ) → upload 1 ảnh → tạo bản dùng thử → chạy từng bước qua `POST /api/jobs/<id>/run` (như trang trạng thái) tới `ready` → mở `/d/<id>/` (phải 200) và đọc `/d/<id>/site.json` để kiểm tra `siteId` đúng và `brand.name` không rỗng (chỉ cảnh báo nếu khác tên trong kịch bản) → kiểm tra `/api/package/<id>` **không có** `full` → gửi 1 lead (200) → `/handoff/<id>` không kèm khoá phải trả 403 → CSV lead không khoá phải trả 403. Thành công in `SMOKE OK <link demo>`; thất bại thoát mã khác 0 và nêu bước lỗi.

Nếu AI chưa gom đủ thông tin sau 30 lượt, script vẫn xác nhận bằng SĐT liên hệ; khi đó Worker tự điền giá trị mặc định cho các mục còn thiếu (chỉ từ lượt thứ 30 trở đi).

- Staging phải dùng secret Turnstile thử (Bước 1).
- Mỗi lần chạy dùng một số điện thoại ngẫu nhiên (1 demo / SĐT) và tính 1 phiên cho IP của bạn (tối đa 3 phiên/IP/ngày).
- Muốn kiểm tra cả nội dung CSV: lấy khoá lead (32 ký tự) trong Google Sheet hoặc tin Telegram "Demo mới", rồi chạy lại với `SMOKE_LEAD_KEY=<khoá> SMOKE_PHONE=<số khác>`.
- Script gọi Claude thật nên tốn chi phí nhỏ (vài chục lượt chat + một lần sinh website). Dữ liệu demo nằm trong KV và tự dọn sau 30 ngày; không tạo repo hay tài nguyên nào bên ngoài.

### 7.4 Thanh toán thật một đơn nhỏ (staging)

1. Staging đặt `ALLOW_TEST_PRICE = "1"` và `PACKAGES` có gói `"priceVnd":2000`; deploy lại.
2. Dùng web staging tạo demo, vào trang đề xuất, chọn gói 2.000đ, thanh toán bằng tài khoản ngân hàng thật.
3. Kỳ vọng: Google Sheet chuyển `trang_thai` sang `da_thanh_toan`, và Telegram nhận thông báo.
4. Xong, đặt lại `PACKAGES` đúng giá và bỏ `ALLOW_TEST_PRICE` trước khi lên production.

---

## Bản dùng thử hoạt động thế nào (`/d/`, `/package/`, `/handoff/`)

Worker tự phục vụ mọi thứ từ KV, không cần GitHub hay hosting riêng:

- **`/d/<siteId>/`** là **website mẫu** của khách. Dữ liệu lấy từ KV (`site.json` và ảnh khách tải lên), trang dựng phía trình duyệt. Có băng rôn "Bản dùng thử" kèm tên nền tảng (`PLATFORM_NAME`). Hết 30 ngày (và chưa thanh toán) trang trả mã **410** "Bản dùng thử đã hết hạn" kèm số `CONTACT_PHONE`. Đây là link công khai nên khách được nhắc không gửi thông tin nhạy cảm.
- **`/package/<siteId>`** là **bộ hồ sơ dùng thử** khách nhận khi tạo xong: link demo, ảnh chụp giao diện (điện thoại và máy tính, PNG có đóng dấu "BẢN DÙNG THỬ"), bản phân tích (tải PDF hoặc Word DOCX), các gói triển khai và nút thanh toán. Khách **chưa thanh toán chỉ thấy bản rút gọn** (`analysis.free`); phần chi tiết (`analysis.full`) không bao giờ được gửi cho khách chưa trả tiền, chỉ mở sau khi PayOS xác nhận. Ảnh và PDF/DOCX được tạo ngay trên trình duyệt của khách (tải thư viện html2canvas và docx từ CDN khi cần).
- **Sửa bản dùng thử:** ô "Sửa website mẫu" (tối đa 3 lượt) chỉ hiện ở trình duyệt đã tạo demo. Khi chuyển từ trang trạng thái sang bộ hồ sơ, link có dạng `/package/<siteId>#s=<mã chủ phiên>`; trang đọc mã `#s=` một lần, cất trong `sessionStorage` rồi xoá khỏi thanh địa chỉ. Mã này chính là chứng nhận quyền sửa, nên **đừng chia sẻ link có `#s=`**; link không kèm `#s=` vẫn xem được nhưng không sửa được.
- **`/handoff/<siteId>?key=<khoá>`** dành cho **đội ngũ sau khi khách thanh toán**: gom brief, `site.json`, phân tích đầy đủ, tài liệu khách gửi và ảnh (thêm `&format=json` để tải 1 file). Khoá `handoffKey` (32 ký tự) nằm trong link "Bàn giao" của tin Telegram "ĐÃ THANH TOÁN" và cột `link_ban_giao` của Google Sheet; không có hoặc sai khoá thì trả 403.
- Trạng thái đã thanh toán chỉ dựa vào khoá `paid:<siteId>` trong KV (do webhook PayOS ghi).

---

## Chạy thử cục bộ (tuỳ chọn)

```bash
pnpm --filter @sme/worker dev          # Worker tại http://localhost:8787
pnpm --filter @sme/web-main serve      # web chính
```

Khi chạy cục bộ dùng khoá Turnstile thử ở Bước 1 và `api-base` = `http://localhost:8787`.

## Chi phí và rủi ro cần kiểm tra trước khi mở bán

- **Giá Claude:** xem bảng giá Anthropic hiện hành, cập nhật `PRICE_IN_PER_MTOK` / `PRICE_OUT_PER_MTOK`, đặt `DAILY_CAP_USD` hợp lý. Mỗi demo gọi chat nhiều lượt + một lần sinh website.
- **Phí PayOS:** kiểm tra phí giao dịch/phí kênh hiện hành, tính vào giá gói.
- **Cloudflare Workers/KV/Pages:** bắt buộc gói Workers Paid (Bước 0). Theo dõi số lượt ghi KV trong Cloudflare dashboard; số liệu phễu khách hằng ngày nằm ở các khoá `stat:sessions:<yyyymmdd>`, `stat:demos:<yyyymmdd>`, `stat:paid:<yyyymmdd>` (giữ khoảng 400 ngày), xem bằng `wrangler kv key get --binding KV "stat:demos:20261108"`.
- **Telegram, Google Apps Script:** có hạn mức; nếu lượng lớn cần kiểm tra lại.
- Bản dùng thử tự hết hạn sau 30 ngày nếu chưa thanh toán; cron `0 3 * * *` xoá dữ liệu demo trong KV của các bản đã quá hạn (khách đã thanh toán thì giữ lại).

## Chạy toàn bộ test

```bash
pnpm -r test                                   # unit/integration
pnpm --filter @sme/templates test:visual       # ảnh chụp 375px / 1280px
pnpm --filter @sme/web-main test:e2e           # trình duyệt thật
```

---

## Tuỳ chọn – bàn giao tự động sau này

**Không bắt buộc** để chạy bản dùng thử và nhận thanh toán. Chỉ làm khi sau này muốn tự động đẩy website đã thanh toán lên một repo GitHub của khách/đội ngũ. Hiện bàn giao vẫn làm thủ công qua `/handoff/`.

### A. Tạo GitHub Org và GitHub App

1. Vào https://github.com/organizations/plan → tạo một **Organization** miễn phí, ví dụ `sme-demos-staging` (staging) và `sme-demos` (production). Mọi trang demo sẽ nằm ở đây.
2. Trong org: **Settings → Developer settings → GitHub Apps → New GitHub App**.
   - Tên: `sme-mvp-bot-staging` (tuỳ ý). Homepage URL: điền bất kỳ.
   - Bỏ chọn **Webhook → Active**.
   - **Repository permissions** (đúng ba quyền này):
     - **Administration: Read and write**
     - **Contents: Read and write**
     - **Pages: Read and write**
   - **Where can this GitHub App be installed?** → *Only on this account*.
3. Sau khi tạo, ghi lại **App ID** (số) → đây là `GH_APP_ID`.
4. Cuộn xuống **Private keys → Generate a private key**. GitHub tải về một file `.pem`.
5. **Install App** (menu bên trái) → cài vào org demo, chọn *All repositories*. Sau khi cài, URL có dạng `.../settings/installations/12345678` → số cuối là `GH_INSTALLATION_ID`.

#### Đổi khoá sang PKCS#8 (bắt buộc)

File GitHub tải về có dòng đầu `-----BEGIN RSA PRIVATE KEY-----` (định dạng PKCS#1). Worker cần PKCS#8 (`-----BEGIN PRIVATE KEY-----`). Đổi bằng lệnh:

```bash
openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem
head -1 key-pkcs8.pem   # phải thấy: -----BEGIN PRIVATE KEY-----
```

Dùng nội dung file `key-pkcs8.pem` ở mục C bên dưới. **Không commit file .pem lên git.**

---

### B. Đẩy template lên GitHub (`sync-templates`)

Script copy phần dùng chung vào từng template rồi đẩy mỗi template thành repo "template" trong org demo.

Thử không cần mạng (chỉ copy file):

```bash
pnpm sync-templates --dry-run
```

Đẩy thật lên org (script gọi `gh` và `git push`, dùng **thông tin đăng nhập GitHub có sẵn trên máy bạn**, không dùng GitHub App). Chuẩn bị một trong hai cách:

```bash
# Cách A: đăng nhập gh rồi để git dùng chung thông tin đó
gh auth login
gh auth setup-git

# Cách B: dùng token cá nhân (quyền repo) cho lần chạy này
export GH_TOKEN=ghp_xxx   # token của người có quyền tạo repo trong org
gh auth setup-git
```

Rồi chạy (thay bằng tên org của bạn):

```bash
pnpm sync-templates sme-demos-staging
```

Kết quả: các repo `tpl-ban-hang`, `tpl-gioi-thieu`, `tpl-thu-lead` trong org, đã bật *Template repository*. Mỗi lần sửa template, chạy lại lệnh này.

### C. Khai báo secret và biến cho bàn giao tự động

```bash
cd worker
for s in GH_APP_ID GH_APP_PRIVATE_KEY GH_INSTALLATION_ID; do
  echo "== $s"; pnpm exec wrangler secret put $s --env staging   # production: bỏ --env staging
done
```

Dán khoá nhiều dòng: `pnpm exec wrangler secret put GH_APP_PRIVATE_KEY --env staging < key-pkcs8.pem`. `GH_ORG` (tên org) là biến thường trong `[vars]`/`[env.staging.vars]` của `worker/wrangler.toml`, **không** chạy `wrangler secret put GH_ORG`. Đặt `PUBLISHER = "github"`; thiếu một trong ba secret thì Worker tự bỏ qua phần này. Repo demo trên GitHub Pages là public; hãy đọc điều khoản GitHub Pages (https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#github-pages), chỉ dùng cho bản dùng thử, website thật của khách nên chuyển sang hosting riêng.

# Hướng dẫn cài đặt SME MVP (từng bước)

Tài liệu này dành cho người không rành kỹ thuật. Lệnh và tên biến giữ nguyên tiếng Anh, copy–dán đúng như trong khung code.

**Bạn cần có sẵn:** máy tính cài Node 22, `pnpm` 10, `git`, GitHub CLI `gh`, `openssl`; tài khoản GitHub, Cloudflare, Google, PayOS, Telegram và Anthropic (có API key).

Cài thư viện một lần ở thư mục gốc dự án:

```bash
pnpm install
```

> Nên làm xong **staging** (môi trường thử, dùng org GitHub test riêng) rồi mới làm **production**. Mỗi bước dưới đây làm cho staging trước; production lặp lại với tên/khoá khác.

---

## Bước 1. Tạo GitHub Org demo và GitHub App

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

### Đổi khoá sang PKCS#8 (bắt buộc)

File GitHub tải về có dòng đầu `-----BEGIN RSA PRIVATE KEY-----` (định dạng PKCS#1). Worker cần PKCS#8 (`-----BEGIN PRIVATE KEY-----`). Đổi bằng lệnh:

```bash
openssl pkcs8 -topk8 -nocrypt -in key.pem -out key-pkcs8.pem
head -1 key-pkcs8.pem   # phải thấy: -----BEGIN PRIVATE KEY-----
```

Dùng nội dung file `key-pkcs8.pem` ở Bước 7. **Không commit file .pem lên git.**

---

## Bước 2. Đẩy template lên GitHub (`sync-templates`)

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

---

## Bước 3. Tạo KV namespace và Turnstile

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

## Bước 4. Deploy Google Apps Script (ghi lead vào Google Sheet)

1. Tạo Google Sheet mới (tên tuỳ ý).
2. **Extensions → Apps Script**, xoá code mẫu, dán toàn bộ nội dung file `sheet-bridge/Code.gs`.
3. **Project Settings → Script properties → Add**: `SHEET_TOKEN` = một chuỗi bí mật dài ngẫu nhiên (tạo bằng `openssl rand -hex 24`). Ghi lại, đây cũng là `SHEET_TOKEN` của Worker.
4. **Deploy → New deployment → Web app**: *Execute as: Me*, *Who has access: Anyone*. Cấp quyền khi được hỏi.
5. Copy URL kết thúc bằng `/exec` → đây là `SHEET_URL`.

Sheet có tab `leads`, cột `trang_thai` sẽ chuyển `demo` → `da_thanh_toan` sau khi khách trả tiền.

---

## Bước 5. PayOS: lấy khoá và đăng ký webhook

1. Đăng ký/đăng nhập https://payos.vn, tạo **Kênh thanh toán**. Lấy ba khoá: `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY`.
2. Trong cài đặt kênh, đặt **Webhook URL** là:

   ```
   https://<địa-chỉ-worker>/webhook/payos
   ```

   Ví dụ `https://sme-mvp-worker-staging.<tài-khoản>.workers.dev/webhook/payos`. Làm bước này sau khi deploy Worker (biết được địa chỉ).
3. PayOS có thể **không có môi trường sandbox**. Khi đó staging được thử bằng **một đơn thật giá rất nhỏ** (xem Bước 9).

---

## Bước 6. Tạo Telegram bot

1. Mở Telegram, nhắn `@BotFather` → `/newbot` → đặt tên → nhận **token** = `TELEGRAM_BOT_TOKEN`.
2. Tạo một nhóm (hoặc dùng chat riêng), thêm bot vào, gửi một tin nhắn bất kỳ.
3. Mở `https://api.telegram.org/bot<TOKEN>/getUpdates`, tìm `"chat":{"id":...}` → số đó là `TELEGRAM_CHAT_ID` (nhóm thường là số âm).

---

## Bước 7. Khai báo secret cho Worker (`wrangler secret put`)

Chạy trong thư mục `worker/`. Mỗi lệnh sẽ hỏi giá trị, dán vào rồi Enter. Danh sách secret **không** gồm `GH_ORG` (xem lưu ý bên dưới).

**Staging:**

```bash
cd worker
for s in ANTHROPIC_API_KEY GH_APP_ID GH_APP_PRIVATE_KEY GH_INSTALLATION_ID \
         PAYOS_CLIENT_ID PAYOS_API_KEY PAYOS_CHECKSUM_KEY \
         SHEET_URL SHEET_TOKEN TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TURNSTILE_SECRET; do
  echo "== $s"; pnpm exec wrangler secret put $s --env staging
done
```

**Production** (không có `--env`):

```bash
cd worker
for s in ANTHROPIC_API_KEY GH_APP_ID GH_APP_PRIVATE_KEY GH_INSTALLATION_ID \
         PAYOS_CLIENT_ID PAYOS_API_KEY PAYOS_CHECKSUM_KEY \
         SHEET_URL SHEET_TOKEN TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TURNSTILE_SECRET; do
  echo "== $s"; pnpm exec wrangler secret put $s
done
```

Ý nghĩa nhanh: `GH_APP_PRIVATE_KEY` = toàn bộ nội dung `key-pkcs8.pem` (cả dòng BEGIN/END); `TURNSTILE_SECRET` = secret key Turnstile (staging: khoá thử ở Bước 3).

Dán khoá nhiều dòng: dùng `pnpm exec wrangler secret put GH_APP_PRIVATE_KEY --env staging < key-pkcs8.pem`.

> `GH_ORG` (tên org demo) là **biến thường, không phải secret**. Sửa trực tiếp trong `worker/wrangler.toml`: `[vars]` (production) hoặc `[env.staging.vars]` (staging). Không chạy `wrangler secret put GH_ORG`, vì secret trùng tên với var sẽ gây xung đột.

---

## Bước 8. Khai báo biến thường (`[vars]`)

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
| `API_BASE` | Địa chỉ chính Worker (để demo gửi lead về) | `https://sme-mvp-worker.<tài-khoản>.workers.dev` |
| `PUBLISHER` | `github` hoặc `cloudflare` | `github` |
| `ALLOW_TEST_PRICE` | `1` = bỏ kiểm tra giá tối thiểu. **Chỉ staging** | `1` |

Giá trên chỉ là ví dụ: **tự kiểm tra bảng giá Claude hiện hành** rồi điền. Đơn giá không được hard-code trong code.

**Ví dụ `PACKAGES`** (mọi gói phải ≥ 10.000.000đ ở production):

```toml
PACKAGES = '[{"id":"co-ban","name":"Cơ bản","priceVnd":10000000,"items":["Website 1 trang","Tên miền .vn 1 năm","Hướng dẫn sử dụng"]},{"id":"nang-cao","name":"Nâng cao","priceVnd":18000000,"items":["Website nhiều trang","Form nhận khách + Google Sheet","Hỗ trợ 3 tháng"]}]'
```

Với staging, để thử thanh toán thật đặt `ALLOW_TEST_PRICE = "1"` và gói `"priceVnd":2000`. **Không bao giờ đặt `ALLOW_TEST_PRICE` ở production.**

**`PUBLISHER`:** mặc định `github` (demo đăng lên GitHub Pages của org). Giá trị `cloudflare` đã có chỗ trong giao diện nhưng **MVP chưa cài đặt**: đặt `cloudflare` thì chưa tạo được demo. Chỉ dùng `github`.

**Lưu ý GitHub Pages:** các repo demo là **public** (GitHub Pages miễn phí yêu cầu repo public). Hãy đọc điều khoản GitHub Pages (https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#github-pages): Pages không dành cho kinh doanh thương mại/bán hàng trực tiếp. Ở đây chỉ dùng cho **bản demo dùng thử**; website thật của khách nên chuyển sang hosting riêng sau khi thanh toán. Vì repo public, đã có dòng nhắc khách "Bản dùng thử là công khai, vui lòng không gửi thông tin nhạy cảm."

---

## Bước 9. Deploy Worker, web chính, chạy thử

### 9.1 Deploy Worker

```bash
pnpm --filter @sme/worker exec wrangler deploy --env staging
```

In ra địa chỉ Worker, ví dụ `https://sme-mvp-worker-staging.<tài-khoản>.workers.dev`. Điền địa chỉ này vào `API_BASE` (Bước 8) và vào webhook PayOS (Bước 5), rồi deploy lại.

### 9.2 Cấu hình và deploy web chính (Cloudflare Pages)

Đặt thẻ meta **trước khi deploy**. `api-base` có ở `web-main/chat.html`, `status.html`, `proposal.html` (phải điền cả ba); `turnstile-sitekey` chỉ có ở `web-main/chat.html` (nơi tạo phiên). `index.html` và `thanks.html` không gọi API.

```html
<meta name="api-base" content="https://sme-mvp-worker-staging.<tài-khoản>.workers.dev">
<meta name="turnstile-sitekey" content="1x00000000000000000000AA">
```

- `api-base`: địa chỉ Worker (không có dấu `/` cuối). Để trống = cùng tên miền với trang (sẽ hỏng vì web và Worker khác tên miền).
- `turnstile-sitekey`: site key Turnstile (production dùng khoá thật; để trống thì web gửi token `dev`).

Deploy thư mục `web-main` (HTML/CSS/JS thuần, không có bước build):

```bash
pnpm dlx wrangler pages deploy web-main --project-name sme-mvp-staging
```

Địa chỉ Pages nhận được phải khớp `WEB_ORIGIN` (Bước 8), nếu không trình duyệt sẽ chặn CORS.

### 9.3 Chạy `smoke` (kiểm tra toàn bộ luồng)

```bash
pnpm smoke https://sme-mvp-worker-staging.<tài-khoản>.workers.dev
```

Script: tạo phiên (token Turnstile thử), chat 3 lượt, upload 1 ảnh, tạo demo, chờ `ready`, mở URL demo (phải trả về 200) và đọc `site.json` của demo (trang demo dựng phía trình duyệt từ file này) để kiểm tra `siteId` đúng và `brand.name` không rỗng (chỉ cảnh báo nếu khác tên trong kịch bản), gửi 1 lead, kiểm tra CSV (thiếu khoá phải bị từ chối 403), gọi `/api/revise` một lần. Thành công in `SMOKE OK <link demo>`; thất bại thoát mã khác 0 và nêu bước lỗi.

- Staging phải dùng secret Turnstile thử (Bước 3).
- Mỗi lần chạy dùng một số điện thoại ngẫu nhiên (1 demo / SĐT) và tính 1 phiên cho IP của bạn (tối đa 3 phiên/IP/ngày).
- Muốn kiểm tra cả nội dung CSV: lấy khoá lead (32 ký tự) trong Google Sheet hoặc tin Telegram "Demo mới", rồi chạy lại với `SMOKE_LEAD_KEY=<khoá> SMOKE_PHONE=<số khác>`.
- Script gọi Claude và GitHub thật nên tốn chi phí nhỏ; mỗi lần chạy tạo một repo demo mới trong org staging (dọn thủ công nếu muốn).

### 9.4 Thanh toán thật một đơn nhỏ (staging)

1. Staging đặt `ALLOW_TEST_PRICE = "1"` và `PACKAGES` có gói `"priceVnd":2000`; deploy lại.
2. Dùng web staging tạo demo, vào trang đề xuất, chọn gói 2.000đ, thanh toán bằng tài khoản ngân hàng thật.
3. Kỳ vọng: Google Sheet chuyển `trang_thai` sang `da_thanh_toan`, và Telegram nhận thông báo.
4. Xong, đặt lại `PACKAGES` đúng giá và bỏ `ALLOW_TEST_PRICE` trước khi lên production.

---

## Chạy thử cục bộ (tuỳ chọn)

```bash
pnpm --filter @sme/worker dev          # Worker tại http://localhost:8787
pnpm --filter @sme/web-main serve      # web chính
```

Khi chạy cục bộ dùng khoá Turnstile thử ở Bước 3 và `api-base` = `http://localhost:8787`.

## Chi phí và rủi ro cần kiểm tra trước khi mở bán

- **Giá Claude:** xem bảng giá Anthropic hiện hành, cập nhật `PRICE_IN_PER_MTOK` / `PRICE_OUT_PER_MTOK`, đặt `DAILY_CAP_USD` hợp lý. Mỗi demo gọi chat nhiều lượt + một lần sinh website.
- **Phí PayOS:** kiểm tra phí giao dịch/phí kênh hiện hành, tính vào giá gói.
- **Cloudflare Workers/KV/Pages:** kiểm tra giới hạn gói miễn phí so với lượng khách dự kiến.
- **Telegram, GitHub, Google Apps Script:** có hạn mức; nếu lượng lớn cần kiểm tra lại.
- Demo tự gỡ sau 30 ngày nếu chưa thanh toán (cron `0 3 * * *`).

## Chạy toàn bộ test

```bash
pnpm -r test                                   # unit/integration
pnpm --filter @sme/templates test:visual       # ảnh chụp 375px / 1280px
pnpm --filter @sme/web-main test:e2e           # trình duyệt thật
```

// Bản xem thử v2: giả lập API bằng dữ liệu mẫu (không gọi AI, PayOS thật).
(function () {
  var STEPS = [
    ['don_vi', 'Đơn vị và ngành nghề'], ['san_pham', 'Sản phẩm và dịch vụ'], ['khach_hang', 'Khách hàng'],
    ['muc_tieu', 'Mục tiêu website'], ['phong_cach', 'Phong cách'], ['tham_khao', 'Website tham khảo'],
    ['tai_lieu', 'Tài liệu và hình ảnh'], ['xac_nhan', 'Liên hệ và xác nhận']
  ];
  var TPL = { 'gioi-thieu': 'tpl-gioi-thieu', 'ban-hang': 'tpl-ban-hang', 'thu-lead': 'tpl-thu-lead' };
  var NAMES = { 'gioi-thieu': 'HTX Cà phê Cầu Đất', 'ban-hang': 'Đặc sản Tây Nguyên', 'thu-lead': 'Hội thảo Nông nghiệp số' };
  var mem = {};
  function store(k, v) {
    try { if (v === undefined) return sessionStorage.getItem('mock2:' + k) || mem[k]; sessionStorage.setItem('mock2:' + k, v); }
    catch (e) { if (v === undefined) return mem[k]; }
    mem[k] = v;
  }
  function abs(p) { return new URL(p, location.href).href; }
  function root() { var m = /^(.*?\/)(package|demo)\//.exec(location.pathname); return m ? location.origin + m[1] : new URL('./', location.href).href; }
  function fromRoot(p) { return root() + p; }
  function json(d, s) { return Promise.resolve(new Response(JSON.stringify(d), { status: s || 200, headers: { 'content-type': 'application/json' } })); }
  function later(ms, f) { return new Promise(function (r) { setTimeout(r, ms); }).then(f); }

  var SCRIPT = [
    { reply: 'Chào anh/chị! Đơn vị mình là hợp tác xã, công ty hay hộ kinh doanh, tên gì và ở tỉnh nào ạ?',
      q: ['HTX Cà phê Cầu Đất, Lâm Đồng'], choices: { kind: 'single', options: [
        { value: 'htx', label: 'Hợp tác xã' }, { value: 'cong-ty', label: 'Công ty' }, { value: 'ho-kd', label: 'Hộ kinh doanh' }] } },
    { reply: 'Sản phẩm chính của mình là gì, giá khoảng bao nhiêu? Có thể bấm "+ Tệp" gửi bảng giá Excel. Điểm khác biệt so với nơi khác là gì?',
      q: ['Cà phê Arabica rang mộc 185.000đ/500g', 'Có chứng nhận OCOP 4 sao'] },
    { reply: 'Khách hàng chính của mình là ai, hiện đang bán qua kênh nào?',
      q: ['Quán cà phê ở Đà Lạt'], choices: { kind: 'multi', options: [
        { value: 'cho', label: 'Chợ, cửa hàng' }, { value: 'dai-ly', label: 'Đại lý' }, { value: 'facebook', label: 'Facebook' }, { value: 'zalo', label: 'Zalo' }] } },
    { reply: 'Website này chủ yếu để làm gì, và mình muốn khách bấm gì nhất?',
      q: ['Khách bấm Zalo để đặt hàng'], choices: { kind: 'single', options: [
        { value: 'gioi-thieu', label: 'Giới thiệu đơn vị' }, { value: 'ban-hang', label: 'Bán hàng, nhận đơn' }, { value: 'thu-lead', label: 'Thu thông tin khách' }, { value: 'tim-dai-ly', label: 'Tìm đại lý' }] } },
    { reply: 'Anh/chị thích website mang cảm giác nào?', q: ['Chưa biết, gợi ý giúp tôi'], choices: { kind: 'single', options: [
        { value: 'moc-mac', label: 'Mộc mạc', hint: 'Gần gũi, màu đất' }, { value: 'truyen-thong', label: 'Truyền thống', hint: 'Đỏ son, vàng đồng' },
        { value: 'hien-dai', label: 'Hiện đại', hint: 'Gọn, sáng' }, { value: 'sang-trong', label: 'Sang trọng', hint: 'Xanh đêm, vàng' }, { value: 'tre-trung', label: 'Trẻ trung', hint: 'Tươi, năng động' }] } },
    { reply: 'Có website nào anh/chị thấy đẹp muốn giống không? Dán link hoặc gửi ảnh chụp, và nói thích điểm gì.', q: ['Không có, bỏ qua'] },
    { reply: 'Anh/chị gửi giúp logo, ảnh sản phẩm, hồ sơ năng lực (ảnh, PDF, Word, Excel đều được) bằng nút "+ Tệp" nhé.', q: ['Gửi sau'] },
    { reply: 'Cuối cùng, số điện thoại hoặc Zalo để khách liên hệ là gì ạ?', q: ['0912 345 678'] }
  ];
  var BRIEF = {
    ten_don_vi: 'HTX Cà phê Cầu Đất', loai_hinh: 'htx', nganh: 'Nông sản – cà phê', dia_phuong: 'Đà Lạt, Lâm Đồng',
    san_pham: [{ ten: 'Arabica rang mộc 500g', gia: 185000 }, { ten: 'Culi rang xay 500g', gia: 150000 }],
    chung_nhan: ['OCOP 4 sao'], diem_khac_biet: 'Trồng ở độ cao 1.500m, sơ chế tỉ mỉ',
    khach_hang_muc_tieu: 'Quán cà phê và người mua online', kenh_ban_hien_tai: ['zalo', 'facebook'],
    muc_tieu_chinh: 'gioi-thieu', hanh_dong_mong_muon: 'zalo', cam_giac: 'moc-mac',
    lien_he: { phone: '0912345678', zalo: '0912345678', address: 'Thôn Cầu Đất, Đà Lạt' }
  };
  function stepView(i) {
    var idx = Math.min(i, 7);
    return { step: { id: STEPS[idx][0], index: idx + 1, label: STEPS[idx][1] }, done: STEPS.slice(0, idx).map(function (s) { return s[0]; }),
      missing: [], canConfirm: idx >= 7 && i >= 8, mustConfirm: false };
  }
  function kindOf(text) {
    var t = (text || '').toLowerCase();
    if (/bán hàng|nhận đơn|đặc sản/.test(t)) return 'ban-hang';
    if (/thu thông tin|tìm đại lý|hội thảo/.test(t)) return 'thu-lead';
    return null;
  }
  function jid(k) { return 'job' + k.replace(/-/g, ''); }
  function kindFromJid(id) { return { gioithieu: 'gioi-thieu', banhang: 'ban-hang', thulead: 'thu-lead' }[id] || 'gioi-thieu'; }
  function pkgUrl(k) { return fromRoot('package/index.html?site=demo-' + k); }

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url;
    var path = new URL(url, location.href).pathname;
    var body = {}; try { body = init && typeof init.body === 'string' ? JSON.parse(init.body) : {}; } catch (e) {}
    var m;
    if (/\/api\/session$/.test(path)) { store('turn', '0'); return json({ sessionId: 'sessdemo' }); }
    if (/\/api\/chat$/.test(path)) {
      var turn = Number(store('turn') || 0);
      var k = kindOf(body.text); if (k) store('kind', k);
      var s = SCRIPT[Math.min(turn, SCRIPT.length - 1)];
      store('turn', String(turn + 1));
      var v = stepView(turn + 1);
      var reply = turn + 1 >= 8 ? 'Cảm ơn anh/chị, tôi đã đủ thông tin. Anh/chị xem lại bản tóm tắt bên dưới, đúng thì bấm "Đúng rồi, tạo bản dùng thử".' : s.reply;
      return later(700, function () {
        return json(Object.assign({ reply: reply, quickReplies: turn + 1 >= 8 ? [] : s.q, choices: turn + 1 >= 8 ? undefined : s.choices, turnsLeft: 30 - (turn + 1) }, v));
      });
    }
    if ((m = /\/api\/brief\/[^/]+$/.exec(path)) && !/confirm$/.test(path)) {
      var b = JSON.parse(JSON.stringify(BRIEF)); var kk = store('kind') || 'gioi-thieu';
      b.muc_tieu_chinh = kk; b.ten_don_vi = NAMES[kk];
      return json(Object.assign({ brief: b }, stepView(Number(store('turn') || 0))));
    }
    if (/\/api\/brief\/confirm$/.test(path)) return json({ ok: true });
    if (/\/api\/products$/.test(path)) return json({ count: (body.items || []).length });
    if (/\/api\/upload$/.test(path)) return later(500, function () { return json({ path: 'assets/1-anh.jpg' }); });
    if (/\/api\/docs$/.test(path)) return json({ length: (body.text || '').length });
    if (/\/api\/generate$/.test(path)) return json({ jobId: jid(store('kind') || 'gioi-thieu') });
    if ((m = /\/api\/jobs\/job([a-z]+)\/run$/.exec(path))) {
      var kd = kindFromJid(m[1]); var step = Number(store('step:' + kd) || 0); store('step:' + kd, String(step + 1));
      return later(2500, function () {
        var ready = step >= 2;
        return json({ id: jid(kd), siteId: 'demo-' + kd, state: ready ? 'ready' : 'pending', url: ready ? pkgUrl(kd) : undefined, next: ready ? 'done' : 'run' });
      });
    }
    if ((m = /\/api\/status\/job([a-z]+)$/.exec(path))) { var k2 = kindFromJid(m[1]); return json({ id: jid(k2), siteId: 'demo-' + k2, state: 'ready', url: pkgUrl(k2) }); }
    if ((m = /\/api\/package\/demo-([a-z-]+)$/.exec(path))) {
      var k3 = TPL[m[1]] ? m[1] : 'gioi-thieu';
      var exp = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
      return json({
        site: { name: NAMES[k3], expires: exp, paid: false },
        demoUrl: fromRoot('demo/' + TPL[k3] + '/index.html'),
        analysis: { free: {
          tom_tat_doanh_nghiep: NAMES[k3] + ' là đơn vị sản xuất nông sản ở Lâm Đồng, có sản phẩm đạt OCOP 4 sao, đang bán chủ yếu qua người quen và Zalo.',
          phan_tich_nhu_cau: 'Khách ở xa chưa biết đến sản phẩm; thông tin giá và nguồn gốc rời rạc; đơn hàng phụ thuộc vào việc giới thiệu miệng.',
          khach_hang_muc_tieu: 'Quán cà phê tại Đà Lạt và TP.HCM, người mua online 25–45 tuổi quan tâm hàng sạch có nguồn gốc rõ.',
          muc_tieu_website: ['Giới thiệu câu chuyện vùng trồng và chứng nhận', 'Nhận đơn qua Zalo trong 1 chạm', 'Thu thông tin quán cà phê muốn hợp tác'],
          phong_cach: { mo_ta: 'Mộc mạc, gần gũi: nền kem, nâu cà phê, xanh lá; ảnh thật vườn và sản phẩm.', bang_mau: ['#efe4cf', '#8a5a2b', '#5f7a3a', '#3b2a1a'] },
          nhan_xet_web_tham_khao: [{ nguon: 'Không có website tham khảo', diem_hoc_hoi: 'Đề xuất bố cục kể chuyện vùng trồng + danh sách sản phẩm có giá' }],
          so_do_trang: [{ trang: 'Trang chủ', muc_dich: 'Ấn tượng vùng trồng, sản phẩm nổi bật, nút Zalo' }, { trang: 'Sản phẩm', muc_dich: 'Giá, quy cách, đặt hàng' }, { trang: 'Liên hệ', muc_dich: 'Bản đồ, giờ mở cửa, form hợp tác' }]
        } },
        packages: [
          { id: 'co-ban', name: 'Gói Cơ bản', priceVnd: 10000000, items: ['Website 5 trang, tên miền riêng 1 năm', 'Nút đặt hàng Zalo, form khách hàng', 'Hỗ trợ 3 tháng'] },
          { id: 'tang-truong', name: 'Gói Tăng trưởng', priceVnd: 18000000, items: ['Mọi thứ trong gói Cơ bản', 'Lead đổ về Zalo/Google Sheet', 'Quản lý fanpage 1 tháng (8 bài)'] }
        ]
      });
    }
    if (/\/api\/revise$/.test(path)) { var left = Number(store('revleft') || 3) - 1; store('revleft', String(left)); return later(1500, function () { return json({ id: 'jobrev', siteId: body.siteId, state: 'ready', revisionsLeft: left }); }); }
    if (/\/api\/checkout$/.test(path)) return json({ checkoutUrl: fromRoot('thanks.html?site=' + encodeURIComponent(body.siteId || '')) });
    if (/\/lead\//.test(path)) return json({ ok: true });
    return realFetch(input, init);
  };
  document.addEventListener('DOMContentLoaded', function () {
    if (window.top !== window.self) return; // không chèn vào iframe chụp ảnh
    var bar = document.createElement('div');
    bar.textContent = 'Bản xem thử với dữ liệu mẫu — chưa nối AI, thanh toán thật.';
    bar.setAttribute('style', 'background:#222;color:#fff;font:12px/1.4 system-ui,sans-serif;text-align:center;padding:4px 10px');
    document.body.prepend(bar);
  });
})();

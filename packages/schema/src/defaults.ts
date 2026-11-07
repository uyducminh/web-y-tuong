import type { Brief } from './brief';
import { normalizePhone } from './normalize';
import type { SectionType, SiteJson, TemplateId } from './site';

const SECTIONS: Record<TemplateId, SectionType[]> = {
  'tpl-gioi-thieu': ['about', 'products', 'certs', 'gallery', 'map', 'contact'],
  'tpl-thu-lead': ['offer', 'benefits', 'lead_form', 'testimonials', 'faq', 'countdown'],
  'tpl-ban-hang': ['products', 'order_zalo', 'contact'],
};

function section(type: SectionType, name: string, brief: Brief): Record<string, unknown> & { type: SectionType } {
  const prod = brief.san_pham_chinh || 'Sản phẩm chính';
  switch (type) {
    case 'about': return { type, title: `Về ${name}`, body: brief.diem_manh || 'Giới thiệu ngắn về đơn vị của bạn.' };
    case 'products': return { type, title: 'Sản phẩm', items: [{ name: prod, desc: 'Mô tả sản phẩm', price: 0, image: '' }] };
    case 'certs': return { type, title: 'Chứng nhận', items: [{ name: 'Chứng nhận chất lượng' }] };
    case 'gallery': return { type, title: 'Hình ảnh', images: [] };
    case 'map': return { type, title: 'Bản đồ' };
    case 'contact': return { type, title: 'Liên hệ' };
    case 'offer': return { type, title: 'Ưu đãi', body: brief.muc_tieu_web || 'Để lại thông tin để nhận ưu đãi.' };
    case 'benefits': return { type, title: 'Lợi ích', items: [{ title: 'Chất lượng', desc: brief.diem_manh || 'Cam kết chất lượng' }] };
    case 'lead_form': return { type, title: 'Đăng ký nhận tư vấn', button: 'Gửi thông tin' };
    case 'testimonials': return { type, title: 'Khách hàng nói gì', items: [] };
    case 'faq': return { type, title: 'Câu hỏi thường gặp', items: [{ q: 'Làm sao để đặt hàng?', a: 'Liên hệ với chúng tôi qua điện thoại hoặc Zalo.' }] };
    case 'countdown': return { type, title: 'Ưu đãi kết thúc sau', endsAt: '' };
    case 'order_zalo': return { type, title: 'Đặt hàng qua Zalo', button: 'Đặt qua Zalo' };
  }
}

export function defaultSite(template: TemplateId, brief: Brief, siteId: string, now: Date = new Date()): SiteJson {
  const name = brief.ten_don_vi?.trim() || 'Đơn vị của bạn';
  const rawPhone = brief.lien_he?.phone ?? '';
  const phone = normalizePhone(rawPhone) ?? rawPhone;
  const zaloRaw = brief.lien_he?.zalo;
  const zalo = zaloRaw ? normalizePhone(zaloRaw) ?? zaloRaw : undefined;
  const color = /^#[0-9A-Fa-f]{6}$/.test(brief.mau_sac ?? '') ? brief.mau_sac! : '#2E7D32';
  const expires = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  const contact: SiteJson['contact'] = { phone };
  if (zalo) contact.zalo = zalo;
  if (brief.lien_he?.email) contact.email = brief.lien_he.email;
  if (brief.lien_he?.address) contact.address = brief.lien_he.address;
  return {
    schemaVersion: 1,
    template,
    siteId,
    brand: { name, color },
    contact,
    seo: { title: name, description: brief.san_pham_chinh || `Website của ${name}` },
    hero: {
      title: name,
      subtitle: brief.san_pham_chinh || brief.nganh || 'Chào mừng bạn đến với chúng tôi',
      cta: template === 'tpl-ban-hang' ? 'Xem sản phẩm' : template === 'tpl-thu-lead' ? 'Đăng ký ngay' : 'Liên hệ',
    },
    sections: SECTIONS[template].map((t) => section(t, name, brief)),
    demo: { badge: true, expires, checkoutUrl: '' },
  };
}

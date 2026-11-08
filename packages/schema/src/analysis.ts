import { z } from 'zod';
import type { BriefV2 } from './brief-v2';

const str = z.string();

export const AnalysisSchema = z.object({
  free: z.object({
    tom_tat_doanh_nghiep: str,
    phan_tich_nhu_cau: str,
    khach_hang_muc_tieu: str,
    muc_tieu_website: z.array(str),
    phong_cach: z.object({ mo_ta: str, bang_mau: z.array(str) }),
    nhan_xet_web_tham_khao: z.array(z.object({ nguon: str, diem_hoc_hoi: str })),
    so_do_trang: z.array(z.object({ trang: str, muc_dich: str })),
  }),
  full: z.object({
    noi_dung_tung_trang: z.array(z.object({
      trang: str,
      cac_khoi: z.array(z.object({ tieu_de: str, noi_dung: str })),
    })),
    ke_hoach_trien_khai: z.array(z.object({ buoc: str, viec: z.array(str) })),
    goi_y_fanpage: z.array(str),
    viec_khach_can_chuan_bi: z.array(str),
  }),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

const LOAI: Record<string, string> = { htx: 'hợp tác xã', 'cong-ty': 'công ty', 'ho-kd': 'hộ kinh doanh', khac: 'đơn vị' };
const GOAL: Record<string, string> = {
  'gioi-thieu': 'Giới thiệu đơn vị và tạo uy tín', 'ban-hang': 'Bán hàng trực tiếp trên website',
  'thu-lead': 'Thu thông tin khách hàng quan tâm', 'tim-dai-ly': 'Tìm đại lý, nhà phân phối', 'tuyen-dung': 'Tuyển dụng nhân sự',
};
const ACTION: Record<string, string> = { goi: 'gọi điện', zalo: 'nhắn Zalo', 'dat-hang': 'đặt hàng', 'dang-ky': 'đăng ký' };
const FEEL: Record<string, string> = {
  'moc-mac': 'Mộc mạc, gần gũi', 'truyen-thong': 'Truyền thống, đáng tin cậy', 'hien-dai': 'Hiện đại, gọn gàng',
  'sang-trong': 'Sang trọng, tinh tế', 'tre-trung': 'Trẻ trung, năng động',
};

export function defaultAnalysis(b: BriefV2): Analysis {
  const ten = b.ten_don_vi || 'Đơn vị của bạn';
  const nganh = b.nganh || 'kinh doanh';
  const dp = b.dia_phuong ? ` tại ${b.dia_phuong}` : '';
  const sp = (b.san_pham ?? []).map((p) => p.ten).filter(Boolean);
  const khach = b.khach_hang_muc_tieu || 'khách hàng quan tâm đến sản phẩm của đơn vị';
  const goal = GOAL[b.muc_tieu_chinh ?? 'gioi-thieu'] ?? GOAL['gioi-thieu']!;
  const action = ACTION[b.hanh_dong_mong_muon ?? ''] ?? 'liên hệ';
  const mau = b.mau_chu_dao ? [b.mau_chu_dao] : [];
  const lh = b.lien_he?.zalo || b.lien_he?.phone;
  const pages = [
    { trang: 'Trang chủ', muc_dich: `Giới thiệu nhanh ${ten} và mời khách ${action}` },
    ...(sp.length ? [{ trang: 'Sản phẩm', muc_dich: 'Trình bày sản phẩm và dịch vụ chính' }] : []),
    { trang: 'Liên hệ', muc_dich: 'Cho khách cách liên lạc nhanh nhất' },
  ];
  return {
    free: {
      tom_tat_doanh_nghiep: `${ten} là ${LOAI[b.loai_hinh ?? 'khac']} hoạt động trong lĩnh vực ${nganh}${dp}.` +
        (b.diem_khac_biet ? ` Điểm khác biệt: ${b.diem_khac_biet}.` : '') + (sp.length ? ` Sản phẩm chính: ${sp.slice(0, 5).join(', ')}.` : ''),
      phan_tich_nhu_cau: `${ten} cần một website rõ ràng để khách hàng hiểu nhanh đơn vị làm gì và dễ ${action}.`,
      khach_hang_muc_tieu: khach,
      muc_tieu_website: [goal, ...(b.thanh_cong_la_gi ? [b.thanh_cong_la_gi] : [])],
      phong_cach: { mo_ta: FEEL[b.cam_giac ?? ''] ?? 'Rõ ràng, dễ đọc', bang_mau: mau },
      nhan_xet_web_tham_khao: (b.web_tham_khao ?? []).map((w) => ({ nguon: w.url || w.anh || 'Website tham khảo', diem_hoc_hoi: w.thich_diem_gi })),
      so_do_trang: pages,
    },
    full: {
      noi_dung_tung_trang: pages.map((p) => ({ trang: p.trang, cac_khoi: [{ tieu_de: p.trang, noi_dung: p.muc_dich }] })),
      ke_hoach_trien_khai: [
        { buoc: 'Chốt nội dung', viec: ['Rà soát thông tin đơn vị và sản phẩm', 'Bổ sung hình ảnh thật'] },
        { buoc: 'Hoàn thiện và đưa lên mạng', viec: ['Chỉnh giao diện theo góp ý', 'Gắn tên miền và đưa website vào hoạt động'] },
      ],
      goi_y_fanpage: [`Đăng giới thiệu ${ten} kèm đường dẫn website`, 'Đăng ảnh sản phẩm thật mỗi tuần'],
      viec_khach_can_chuan_bi: ['Ảnh sản phẩm rõ nét', 'Logo của đơn vị (nếu có)', lh ? `Xác nhận số liên hệ ${lh}` : 'Số điện thoại hoặc Zalo liên hệ'],
    },
  };
}

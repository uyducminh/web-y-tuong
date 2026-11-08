import { describe, it, expect } from 'vitest';
import { AnalysisSchema, defaultAnalysis } from '../src';
import type { BriefV2 } from '../src';

const s3: BriefV2 = { ten_don_vi: 'HTX A', loai_hinh: 'htx', nganh: 'nông sản', dia_phuong: 'Lâm Đồng', san_pham: [{ ten: 'Cà phê' }], diem_khac_biet: 'OCOP', muc_tieu_chinh: 'ban-hang', hanh_dong_mong_muon: 'zalo', cam_giac: 'moc-mac', khach_hang_muc_tieu: 'quán cà phê' };

describe('Analysis', () => {
  it('default is valid and mentions the unit', () => {
    expect(AnalysisSchema.safeParse(defaultAnalysis(s3)).success).toBe(true);
    expect(defaultAnalysis(s3).free.tom_tat_doanh_nghiep).toContain('HTX A');
  });
  it('default from empty brief is valid', () => {
    expect(AnalysisSchema.safeParse(defaultAnalysis({})).success).toBe(true);
  });
  it('rejects missing full', () => {
    const { free } = defaultAnalysis(s3);
    expect(AnalysisSchema.safeParse({ free }).success).toBe(false);
  });
  it('uses brief color and web_tham_khao', () => {
    const a = defaultAnalysis({ ...s3, mau_chu_dao: '#112233', web_tham_khao: [{ url: 'https://x.vn', thich_diem_gi: 'gọn' }] });
    expect(a.free.phong_cach.bang_mau).toContain('#112233');
    expect(a.free.nhan_xet_web_tham_khao[0]).toEqual({ nguon: 'https://x.vn', diem_hoc_hoi: 'gọn' });
  });
});

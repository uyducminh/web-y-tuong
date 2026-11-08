import { describe, it, expect } from 'vitest';
import { stepState, mergeBriefV2, templateFor, STEPS, STEP_LABELS, BriefV2Schema } from '../src';
import type { BriefV2 } from '../src';

const s1: BriefV2 = { ten_don_vi: 'HTX A', loai_hinh: 'htx', nganh: 'nông sản', dia_phuong: 'Lâm Đồng' };
const s2: BriefV2 = { ...s1, san_pham: [{ ten: 'Cà phê' }], diem_khac_biet: 'OCOP', muc_tieu_chinh: 'ban-hang', hanh_dong_mong_muon: 'zalo', cam_giac: 'moc-mac' };
const s3: BriefV2 = { ...s2, khach_hang_muc_tieu: 'quán cà phê' };
const asked: BriefV2['meta'] = { askedOptional: ['tham_khao', 'tai_lieu'] };

describe('stepState', () => {
  it('walks the steps', () => {
    expect(stepState({}).step).toBe('don_vi');
    expect(stepState({}).index).toBe(1);
    expect(stepState({}).missing).toContain('lien_he.phone|zalo');
    expect(stepState(s1).step).toBe('san_pham');
    expect(stepState(s2).step).toBe('khach_hang');
    expect(stepState(s2).done).toEqual(['don_vi', 'san_pham', 'muc_tieu', 'phong_cach']);
    expect(stepState(s3).step).toBe('tham_khao');
    expect(stepState({ ...s3, meta: asked }).step).toBe('xac_nhan');
    expect(stepState({ ...s3, meta: asked }).index).toBe(8);
  });
  it('canConfirm needs contact', () => {
    expect(stepState({ ...s3, meta: asked }).canConfirm).toBe(false);
    expect(stepState({ ...s3, lien_he: { zalo: '0912345678' }, meta: asked }).canConfirm).toBe(true);
    expect(stepState({ ...s3, lien_he: { zalo: '0912345678' }, meta: asked }).missing).toEqual([]);
  });
  it('labels and steps', () => {
    expect(STEPS).toHaveLength(8);
    expect(STEP_LABELS.xac_nhan).toBe('Liên hệ và xác nhận');
  });
});

describe('mergeBriefV2', () => {
  it('resets confirmation on content change only', () => {
    expect(mergeBriefV2({ ...s3, da_xac_nhan: true }, { nganh: 'thực phẩm' }).da_xac_nhan).toBe(false);
    expect(mergeBriefV2({ ...s3, da_xac_nhan: true }, { meta: { askedOptional: ['tham_khao'] } }).da_xac_nhan).toBe(true);
  });
  it('drops invalid keys', () => {
    expect(mergeBriefV2(s1, { cam_giac: 'kiểu-lạ', bogus: 1 })).toEqual(s1);
    expect(mergeBriefV2(s1, 'x')).toEqual(s1);
  });
  it('cannot set da_xac_nhan via patch', () => {
    expect(mergeBriefV2(s1, { da_xac_nhan: true }).da_xac_nhan).toBeUndefined();
  });
  it('deep merges lien_he, replaces san_pham, unions meta', () => {
    expect(mergeBriefV2({ lien_he: { phone: '1' } }, { lien_he: { zalo: '2' } }).lien_he).toEqual({ phone: '1', zalo: '2' });
    expect(mergeBriefV2({ san_pham: [{ ten: 'a' }] }, { san_pham: [{ ten: 'b' }] }).san_pham).toEqual([{ ten: 'b' }]);
    expect(mergeBriefV2({ meta: { askedOptional: ['tham_khao'] } }, { meta: { askedOptional: ['tai_lieu'] } }).meta?.askedOptional).toEqual(['tham_khao', 'tai_lieu']);
  });
  it('san_pham max 60', () => {
    const many = Array.from({ length: 61 }, (_, i) => ({ ten: 'p' + i }));
    expect(BriefV2Schema.safeParse({ san_pham: many }).success).toBe(false);
    expect(mergeBriefV2(s1, { san_pham: many })).toEqual(s1);
  });
});

describe('templateFor', () => {
  it('maps goals', () => {
    expect(templateFor({ muc_tieu_chinh: 'tim-dai-ly' })).toBe('tpl-thu-lead');
    expect(templateFor({ muc_tieu_chinh: 'tuyen-dung' })).toBe('tpl-thu-lead');
    expect(templateFor({ muc_tieu_chinh: 'thu-lead' })).toBe('tpl-thu-lead');
    expect(templateFor({ muc_tieu_chinh: 'ban-hang' })).toBe('tpl-ban-hang');
    expect(templateFor({ muc_tieu_chinh: 'gioi-thieu' })).toBe('tpl-gioi-thieu');
    expect(templateFor({})).toBe('tpl-gioi-thieu');
  });
});

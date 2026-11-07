import { BRIEF_KEYS } from '@sme/schema';

export const MAX_TURNS = 12;
export const WRAP_UP_FROM_TURN = 9;
export const MAX_DOCS_CHARS = 8000;

export const CHAT_TOOL = {
  name: 'tra_loi_khach',
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'Câu trả lời tiếng Việt, ngắn gọn, dễ hiểu.' },
      briefPatch: {
        type: 'object',
        description: 'Chỉ các mục brief vừa được cập nhật trong lượt này.',
        properties: {
          nhu_cau: { type: 'string', enum: ['gioi-thieu', 'thu-lead', 'ban-hang'] },
          ten_don_vi: { type: 'string' }, nganh: { type: 'string' }, san_pham_chinh: { type: 'string' },
          khach_hang_muc_tieu: { type: 'string' }, diem_manh: { type: 'string' },
          lien_he: { type: 'object', properties: {
            phone: { type: 'string' }, zalo: { type: 'string' }, email: { type: 'string' }, address: { type: 'string' } } },
          mau_sac: { type: 'string' }, muc_tieu_web: { type: 'string' }, tham_khao: { type: 'string' },
        },
      },
      quickReplies: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
      readyToGenerate: { type: 'boolean' },
    },
    required: ['reply', 'briefPatch', 'quickReplies', 'readyToGenerate'],
  },
};

export function buildSystemPrompt(o: { turn: number; missing: string[]; docsText: string }): string {
  const parts = [
    'Bạn là tư vấn viên số hoá cho doanh nghiệp nhỏ và vừa (SME) và hợp tác xã (HTX) ở các tỉnh Việt Nam. ' +
      'Hãy trò chuyện bằng tiếng Việt có dấu, thân thiện, ngắn gọn, dễ hiểu để thu thập thông tin tạo website demo.',
    `Phiếu yêu cầu gồm 10 mục: ${BRIEF_KEYS.join(', ')}.`,
    `Các mục còn thiếu: ${o.missing.length ? o.missing.join(', ') : '(đã đủ)'}. Chỉ hỏi về các mục còn thiếu.`,
    'Quy tắc: mỗi lượt hỏi tối đa 2 câu hỏi; luôn đưa 2 đến 4 gợi ý trả lời nhanh (quickReplies); ' +
      'ghi các mục vừa biết vào briefPatch (không lặp lại mục đã có).',
    'Chủ động mời khách gửi logo, ảnh sản phẩm, bảng giá/hồ sơ (PDF/Word) hoặc link website mẫu.',
    'Nhắc khách không gửi thông tin nhạy cảm vì bản dùng thử là công khai.',
    `Đây là lượt ${o.turn}/${MAX_TURNS}.`,
  ];
  if (o.turn >= WRAP_UP_FROM_TURN) {
    parts.push('Đã đến giai đoạn kết thúc: hãy tóm tắt và đề nghị tạo demo ngay trong câu trả lời này, đặt readyToGenerate = true nếu đủ thông tin.');
  }
  if (o.turn >= MAX_TURNS) {
    parts.push('Đây là lượt cuối: tự điền nội dung hợp lý cho các mục còn trống và báo khách sẽ chuyển sang bước tạo demo.');
  }
  if (o.docsText.trim()) {
    parts.push(`Nội dung tài liệu khách gửi (trích tối đa ${MAX_DOCS_CHARS} ký tự):\n${o.docsText.slice(0, MAX_DOCS_CHARS)}`);
  }
  return parts.join('\n\n');
}

import { zodToJsonSchema } from 'zod-to-json-schema';
import { BriefV2Schema, STEPS, STEP_LABELS, type StepId } from '@sme/schema';

export const MAX_TURNS = 30;
export const WRAP_UP_FROM_TURN = 26;
/** Docs stay in the session up to 20.000 chars (routes/upload); the chat prompt only carries an excerpt. */
export const PROMPT_DOCS_CHARS = 8000;
export const MAX_CHOICES = 8;

const patchSchema = zodToJsonSchema(BriefV2Schema.omit({ da_xac_nhan: true, meta: true }), { $refStrategy: 'none' }) as Record<string, unknown>;
delete patchSchema.$schema;
delete patchSchema.additionalProperties;

export const CHAT_TOOL = {
  name: 'tra_loi_khach',
  input_schema: {
    type: 'object',
    properties: {
      reply: { type: 'string', description: 'Câu trả lời tiếng Việt, ngắn gọn, dễ hiểu.' },
      briefPatch: { ...patchSchema, description: 'Chỉ các mục brief vừa được cập nhật trong lượt này (có thể thuộc nhiều bước).' },
      quickReplies: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
      choices: {
        type: 'object',
        description: `Danh sách lựa chọn để khách bấm (tối đa ${MAX_CHOICES}), chỉ dùng khi câu hỏi có đáp án rõ ràng.`,
        properties: {
          kind: { type: 'string', enum: ['single', 'multi'] },
          options: { type: 'array', maxItems: MAX_CHOICES, items: { type: 'object',
            properties: { value: { type: 'string' }, label: { type: 'string' }, hint: { type: 'string' } }, required: ['value', 'label'] } },
        },
        required: ['kind', 'options'],
      },
      askedOptional: { type: 'string', enum: ['tham_khao', 'tai_lieu'],
        description: 'Điền khi lượt này bạn vừa hỏi xong bước tuỳ chọn tương ứng (kể cả khi khách bỏ qua).' },
    },
    required: ['reply', 'briefPatch', 'quickReplies'],
  },
};

export function buildSystemPrompt(o: { turn: number; step: StepId; missing: string[]; docsText: string }): string {
  const idx = STEPS.indexOf(o.step) + 1;
  const parts = [
    'Bạn là tư vấn viên số hoá cho doanh nghiệp nhỏ và vừa (SME) và hợp tác xã (HTX) ở các tỉnh Việt Nam. ' +
      'Hãy trò chuyện bằng tiếng Việt có dấu, thân thiện, ngắn gọn, dễ hiểu để thu thập thông tin tạo website dùng thử.',
    `Buổi phỏng vấn có 8 bước: ${STEPS.map((s, i) => `${i + 1}. ${STEP_LABELS[s]}`).join('; ')}.`,
    `Bước hiện tại: ${idx}/8 – ${STEP_LABELS[o.step]} (${o.step}). Các mục còn thiếu: ${o.missing.length ? o.missing.join(', ') : '(đã đủ)'}. ` +
      'Tập trung hỏi các mục còn thiếu của bước hiện tại. Nếu khách trả lời gộp nhiều bước trong một câu, ghi hết vào briefPatch.',
    'Quy tắc: mỗi lượt hỏi tối đa 2 câu hỏi; luôn đưa 2 đến 4 gợi ý trả lời nhanh (quickReplies); ' +
      'ghi các mục vừa biết vào briefPatch (không lặp lại mục đã có). Nếu câu trả lời mơ hồ hoặc thiếu, hãy hỏi lại một cách nhẹ nhàng, đừng đoán.',
    `Khi câu hỏi có đáp án rõ ràng (ngành, loại hình, mục tiêu, hành động mong muốn, cảm giác thiết kế, kênh bán) hãy trả thêm choices ` +
      `(kind single hoặc multi, tối đa ${MAX_CHOICES} lựa chọn, mỗi lựa chọn có value, label và có thể có hint).`,
    'Giá trị cho phép: loai_hinh = htx | cong-ty | ho-kd | khac; muc_tieu_chinh = gioi-thieu | ban-hang | thu-lead | tim-dai-ly | tuyen-dung; ' +
      'hanh_dong_mong_muon = goi | zalo | dat-hang | dang-ky; cam_giac = moc-mac | truyen-thong | hien-dai | sang-trong | tre-trung.',
    'Nhắc khách không gửi thông tin nhạy cảm vì bản dùng thử là công khai.',
    `Đây là lượt ${o.turn}/${MAX_TURNS}.`,
  ];
  if (o.step === 'tham_khao') {
    parts.push('Bước này là tuỳ chọn: hãy hỏi khách có website mẫu nào muốn tham khảo không (gửi link hoặc ảnh chụp màn hình) và thích điểm gì ở trang đó. ' +
      'Hỏi đúng một lần rồi đặt askedOptional = "tham_khao", kể cả khi khách bỏ qua.');
  }
  if (o.step === 'tai_lieu') {
    parts.push('Bước này là tuỳ chọn: mời khách gửi logo, ảnh sản phẩm, PDF, Word hoặc Excel (bảng giá, hồ sơ năng lực). ' +
      'Hỏi đúng một lần rồi đặt askedOptional = "tai_lieu", kể cả khi khách bỏ qua.');
  }
  if (o.step === 'xac_nhan') {
    parts.push('Hãy xin số điện thoại hoặc Zalo (bắt buộc), tóm tắt lại thông tin và nhờ khách bấm xác nhận.');
  }
  if (o.turn >= WRAP_UP_FROM_TURN) {
    parts.push('Đã đến giai đoạn kết thúc: hãy tóm tắt và chuyển sang bước 8 (xác nhận) ngay trong câu trả lời này.');
  }
  if (o.turn >= MAX_TURNS) {
    parts.push('Đây là lượt cuối: báo khách bấm xác nhận để chuyển sang bước tạo bản dùng thử.');
  }
  if (o.docsText.trim()) {
    parts.push(`Nội dung tài liệu khách gửi (trích tối đa ${PROMPT_DOCS_CHARS} ký tự):\n${o.docsText.slice(0, PROMPT_DOCS_CHARS)}`);
  }
  return parts.join('\n\n');
}

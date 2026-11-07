export function slugify(s: string): string {
  const out = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 30)
    .replace(/-$/, '');
  return out || 'site';
}

export function normalizePhone(s: string): string | null {
  let d = s.replace(/\D/g, '');
  if (d.startsWith('84')) d = '0' + d.slice(2);
  return /^0\d{9}$/.test(d) ? d : null;
}

export function formatVnd(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.') + 'đ';
}

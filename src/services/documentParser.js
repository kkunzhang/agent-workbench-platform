import mammoth from 'mammoth';

const maxTextBytes = 2 * 1024 * 1024;

export async function extractDocumentText({ buffer, mimeType, fileName }) {
  if (!buffer?.length) throw new Error('上传文件为空');
  if (buffer.length > 20 * 1024 * 1024) throw new Error('文件不能超过 20MB');
  const lower = String(fileName || '').toLowerCase();
  if (mimeType?.startsWith('text/') || /\.(txt|md|csv)$/i.test(lower)) return buffer.toString('utf8').slice(0, maxTextBytes);
  if (mimeType === 'application/pdf' || lower.endsWith('.pdf')) {
    const module = await import('pdf-parse');
    const PDFParse = module.PDFParse || module.default?.PDFParse || module.default;
    const parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    await parser.destroy?.();
    return String(result.text || '').slice(0, maxTextBytes);
  }
  if (mimeType?.includes('wordprocessingml') || lower.endsWith('.docx')) {
    const result = await mammoth.extractRawText({ buffer });
    return String(result.value || '').slice(0, maxTextBytes);
  }
  throw new Error('仅支持 TXT、Markdown、CSV、PDF 和 DOCX 文件');
}

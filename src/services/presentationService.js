import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';
import { config } from '../config.js';

const BRAND = '个人 Agent 工作台';

function safeTopic(question) {
  const text = String(question || '')
    .replace(/请|帮我|麻烦|能否|可以|生成|制作|创建|做一份|做个|一个|一份/gi, '')
    .replace(/(?:pptx?|powerpoint|演示文稿|幻灯片|汇报稿)/gi, '')
    .replace(/[？?。！!：:，,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || /^(?:你)?(?:能|可以|能否)?(?:吗)?$/i.test(text)) return `${BRAND}能力概览`;
  return text.replace(/^关于\s*/i, '').replace(/的$/u, '').slice(0, 52);
}

function addTitle(slide, title, subtitle = '') {
  slide.addText(title, { x: 0.65, y: 0.45, w: 11.8, h: 0.48, fontFace: 'Microsoft YaHei', fontSize: 24, bold: true, color: '172033', margin: 0 });
  if (subtitle) slide.addText(subtitle, { x: 0.68, y: 1.02, w: 11.3, h: 0.28, fontFace: 'Microsoft YaHei', fontSize: 10, color: '6B7280', margin: 0 });
  slide.addShape('line', { x: 0.66, y: 1.42, w: 1.25, h: 0, line: { color: '4B7BFF', width: 2.5 } });
}

function addBullets(slide, bullets) {
  slide.addText(bullets.map((text) => ({ text, options: { bullet: { indent: 14 }, hanging: 3 } })), {
    x: 0.85, y: 1.78, w: 11.25, h: 4.85, fontFace: 'Microsoft YaHei', fontSize: 18,
    color: '263246', breakLine: true, paraSpaceAfterPt: 14, margin: 0.05,
  });
}

function buildSlides(topic) {
  return [
    { title: topic, subtitle: `${BRAND} · 自动生成演示稿`, bullets: null },
    { title: '背景与目标', bullets: [`说明“${topic}”要解决的业务或协作问题。`, '明确受众、预期成果和可衡量的成功标准。', '把问题拆成可验证、可交付的工作目标。'] },
    { title: '核心方案', bullets: ['用清晰的流程串联输入、处理、输出与反馈。', '优先交付最小可用版本，再用数据验证效果。', '对关键决策保留证据、负责人和时间节点。'] },
    { title: '实施路径', bullets: ['第一阶段：确认范围、资料与验收标准。', '第二阶段：实现核心流程并进行内部试运行。', '第三阶段：复盘结果，迭代体验与自动化能力。'] },
    { title: '风险与下一步', bullets: ['风险：目标不清、依赖不确定、数据质量不足。', '应对：提前确认边界，设置阶段性评审与回退方案。', '下一步：补充具体数据、案例和视觉素材后完善定稿。'] },
  ];
}

export function createArtifactLink(id, expiresAt) {
  const payload = `${id}.${expiresAt}`;
  const signature = crypto.createHmac('sha256', config.jwtSecret).update(payload).digest('base64url');
  return `/api/v1/artifacts/${id}/download?expires=${expiresAt}&signature=${signature}`;
}

export function verifyArtifactLink(id, expiresAt, signature) {
  if (!/^[a-f0-9-]{36}$/.test(String(id)) || !/^\d+$/.test(String(expiresAt)) || Number(expiresAt) < Math.floor(Date.now() / 1000)) return false;
  const expected = createArtifactLink(id, expiresAt).split('signature=')[1];
  const provided = Buffer.from(String(signature));
  const actual = Buffer.from(expected);
  return provided.length === actual.length && crypto.timingSafeEqual(provided, actual);
}

export async function generatePresentation(question) {
  const id = crypto.randomUUID();
  const topic = safeTopic(question);
  const fileName = `${topic.replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'presentation'}-${id.slice(0, 8)}.pptx`;
  const outputPath = path.join(config.artifactDir, `${id}.pptx`);
  await fs.mkdir(config.artifactDir, { recursive: true });

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = BRAND;
  pptx.subject = topic;
  pptx.title = topic;
  pptx.company = BRAND;
  pptx.lang = 'zh-CN';
  pptx.theme = { headFontFace: 'Microsoft YaHei', bodyFontFace: 'Microsoft YaHei', lang: 'zh-CN' };

  for (const [index, slideData] of buildSlides(topic).entries()) {
    const slide = pptx.addSlide();
    slide.background = { color: 'F8FAFF' };
    slide.addShape('rect', { x: 0, y: 0, w: 13.333, h: 0.12, fill: { color: '4B7BFF' }, line: { color: '4B7BFF' } });
    if (index === 0) {
      slide.addText(slideData.title, { x: 0.9, y: 2.1, w: 11.4, h: 0.8, fontFace: 'Microsoft YaHei', fontSize: 35, bold: true, color: '172033', align: 'center', margin: 0 });
      slide.addText(slideData.subtitle, { x: 1.1, y: 3.15, w: 11, h: 0.35, fontFace: 'Microsoft YaHei', fontSize: 16, color: '5D6B82', align: 'center', margin: 0 });
      slide.addText(BRAND, { x: 0.9, y: 6.55, w: 11.4, h: 0.25, fontFace: 'Microsoft YaHei', fontSize: 10, color: '8090AA', align: 'center', margin: 0 });
    } else {
      addTitle(slide, slideData.title, `${topic} · 第 ${index} 页`);
      addBullets(slide, slideData.bullets);
    }
  }

  await pptx.writeFile({ fileName: outputPath });
  const expiresAt = Math.floor(Date.now() / 1000) + config.artifactLinkTtlSeconds;
  return { id, topic, fileName, outputPath, expiresAt, downloadPath: createArtifactLink(id, expiresAt) };
}

export function artifactPath(id) {
  return path.join(config.artifactDir, `${id}.pptx`);
}

import { config } from '../config.js';

function toUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function cleanText(value, maxLength = 360) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function normalizeSearxngResults(payload, type, limit) {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  if (type === 'image') {
    return rows
      .map((item) => ({
        title: cleanText(item.title, 120) || '图片结果',
        imageUrl: toUrl(item.img_src) || toUrl(item.thumbnail_src),
        sourceUrl: toUrl(item.url),
        source: cleanText(item.engine || item.source, 80),
      }))
      .filter((item) => item.imageUrl && item.sourceUrl)
      .slice(0, limit);
  }
  return rows
    .map((item) => ({
      title: cleanText(item.title, 160) || '网页结果',
      url: toUrl(item.url),
      content: cleanText(item.content),
      source: cleanText(item.engine || item.source, 80),
    }))
    .filter((item) => item.url)
    .slice(0, limit);
}

async function requestSearxng({ query, type, limit }) {
  const endpoint = new URL('/search', config.searxngBaseUrl);
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('format', 'json');
  endpoint.searchParams.set('categories', type === 'image' ? 'images' : 'general');
  endpoint.searchParams.set('language', 'zh-CN');
  endpoint.searchParams.set('safesearch', '1');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.webSearchTimeoutMs);
  try {
    const response = await fetch(endpoint, { headers: { accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`SearXNG 返回 ${response.status}`);
    const payload = await response.json();
    return normalizeSearxngResults(payload, type, limit);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`联网搜索超时（${config.webSearchTimeoutMs}ms）`);
    throw new Error(`联网搜索不可用：${error.message}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function searchInternet({ query, type = 'web', limit = 5 }) {
  if (config.webSearchProvider !== 'searxng') throw new Error(`未支持的搜索提供方：${config.webSearchProvider}`);
  const normalizedType = type === 'image' ? 'image' : 'web';
  const results = await requestSearxng({ query: String(query).trim(), type: normalizedType, limit: Math.min(Math.max(Number(limit) || 5, 1), 8) });
  return { provider: 'searxng', type: normalizedType, query: String(query).trim(), results };
}

export function formatSearchForAgent(search) {
  if (!search.results.length) return `没有找到与“${search.query}”相关的公开${search.type === 'image' ? '图片' : '网页'}结果。`;
  if (search.type === 'image') {
    return [
      `已联网搜索“${search.query}”，以下是 ${search.results.length} 个图片结果：`,
      ...search.results.map((item, index) => `${index + 1}. ${item.title}\n图片：${item.imageUrl}\n来源：${item.sourceUrl}`),
    ].join('\n');
  }
  return [
    `已联网搜索“${search.query}”，以下是 ${search.results.length} 个可引用网页：`,
    ...search.results.map((item, index) => `${index + 1}. ${item.title}\n链接：${item.url}\n摘要：${item.content || '无摘要'}`),
  ].join('\n');
}

export function formatImageSearchAnswer(search) {
  return [
    `已联网搜索“${search.query}”，找到 ${search.results.length} 张可预览图片：`,
    ...search.results.map((item, index) => `${index + 1}. [${item.title}](${item.sourceUrl})\n\n![${item.title}](${item.imageUrl})`),
  ].join('\n\n');
}

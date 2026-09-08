import { embed } from './modelClient.js';

function tokenize(text) {
  return [...new Set(String(text).toLowerCase().match(/[\u4e00-\u9fff]|[a-z0-9_]+/g) || [])];
}

function lexicalScore(query, value) {
  const queryTokens = tokenize(query);
  const valueTokens = new Set(tokenize(value));
  return queryTokens.filter((token) => valueTokens.has(token)).length;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    aNorm += a[index] ** 2;
    bNorm += b[index] ** 2;
  }
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm) || 1);
}

export async function remember(store, account, text) {
  await store.load();
  const vector = await embed(text);
  store.state.memories.push({ id: crypto.randomUUID(), account, text, vector, createdAt: new Date().toISOString() });
  store.state.memories = store.state.memories.slice(-200);
  await store.save();
}

export async function recall(store, account, query, limit = 3) {
  await store.load();
  const queryVector = await embed(query);
  return store.state.memories
    .filter((item) => item.account === account)
    .map((item) => ({ ...item, score: queryVector && item.vector ? cosine(queryVector, item.vector) : lexicalScore(query, item.text) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

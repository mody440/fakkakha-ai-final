// POST /api/research
// Requires a configured server-side search provider. We never fabricate results.
// Supported provider response shapes: Brave-style {web:{results:[]}} or
// generic {results:[{title,url,description|snippet,publishedAt}]}.
const { requireUser } = require('../verifyAuth');
const { checkRateLimit } = require('../rateLimit');
const { withMetrics } = require('../withMetrics');
const { MAX_QUESTION_LEN } = require('../limits');
const { sanitizeForAI } = require('../guardrails');

function normalizeResult(item) {
  const url = typeof item?.url === 'string' ? item.url : (typeof item?.link === 'string' ? item.link : '');
  if (!url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:') return null;
  const title = typeof item?.title === 'string' ? item.title.trim() : '';
  const snippet = typeof item?.description === 'string' ? item.description.trim()
    : typeof item?.snippet === 'string' ? item.snippet.trim() : '';
  if (!title || !snippet) return null;
  return {
    title: title.slice(0, 300),
    url: parsed.toString(),
    snippet: snippet.slice(0, 1000),
    publishedAt: typeof item?.publishedAt === 'string' ? item.publishedAt.slice(0, 80) : null,
    domain: parsed.hostname
  };
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ code: 'method_not_allowed', message: 'الطريقة غير مسموحة.' });
  const { query, count = 5, subject, gradeLabel } = req.body || {};
  if (typeof query !== 'string' || !query.trim()) return res.status(400).json({ code: 'empty_query', message: 'اكتب سؤال البحث أولًا.' });
  if (query.length > MAX_QUESTION_LEN) return res.status(400).json({ code: 'query_too_long', message: `سؤال البحث طويل جدًا (الحد ${MAX_QUESTION_LEN} حرف).` });
  const safe = sanitizeForAI(query);
  if (safe.injectionDetected) return res.status(400).json({ code: 'unsafe_query', message: 'طلب البحث يحتوي على تعليمات غير آمنة.' });

  let userId;
  try { userId = await requireUser(req); } catch { return res.status(401).json({ code: 'unauthenticated', message: 'يجب تسجيل الدخول أولًا.' }); }
  const limit = await checkRateLimit(`research:${userId}`, 20, 600);
  if (!limit.allowed) return res.status(429).json({ code: 'rate_limited', message: `استنى ${limit.retryAfterSeconds} ثانية قبل بحث جديد.` });

  const endpoint = process.env.SEARCH_PROVIDER_URL;
  const apiKey = process.env.SEARCH_PROVIDER_API_KEY;
  if (!endpoint || !apiKey) {
    return res.status(503).json({ code: 'search_not_configured', message: 'البحث الحي غير مُعدّ بعد. أضف مزوّد بحث موثوق ومفتاحه في إعدادات الخادم.' });
  }

  let target;
  try {
    target = new URL(endpoint);
    if (target.protocol !== 'https:') throw new Error('search provider must use HTTPS');
    target.searchParams.set('q', safe.text);
    target.searchParams.set('count', String(Math.min(Math.max(Number(count) || 5, 1), 10)));
    if (subject) target.searchParams.set('subject', String(subject).slice(0, 100));
    if (gradeLabel) target.searchParams.set('grade', String(gradeLabel).slice(0, 100));
  } catch {
    return res.status(503).json({ code: 'search_provider_invalid', message: 'إعداد مزوّد البحث غير صالح.' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const upstream = await fetch(target, { headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey, Authorization: `Bearer ${apiKey}` }, signal: controller.signal });
    if (!upstream.ok) return res.status(503).json({ code: 'search_provider_unavailable', message: 'مزوّد البحث غير متاح حاليًا.' });
    const payload = await upstream.json();
    const raw = Array.isArray(payload?.web?.results) ? payload.web.results : Array.isArray(payload?.results) ? payload.results : [];
    const sources = raw.map(normalizeResult).filter(Boolean).slice(0, 10);
    if (!sources.length) return res.status(404).json({ code: 'no_sources', message: 'لم نجد مصادر قابلة للتحقق لهذا السؤال.' });
    return res.status(200).json({ query: safe.text, retrievedAt: new Date().toISOString(), sources });
  } catch (err) {
    if (err?.name === 'AbortError') return res.status(503).json({ code: 'search_timeout', message: 'البحث استغرق وقتًا طويلًا. حاول مرة أخرى.' });
    return res.status(503).json({ code: 'search_provider_unavailable', message: 'تعذر الوصول إلى مزوّد البحث.' });
  } finally { clearTimeout(timer); }
}

module.exports = withMetrics('research', handler);

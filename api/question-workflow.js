// Admin-only question workflow. No teacher/school identities are fabricated here.
// POST {action:'create'|'review', ...}; GET lists questions by status.
const { admin } = require('../lib/supabaseAdmin');
const { withMetrics } = require('../lib/withMetrics');

async function handler(req, res) {
  const expected = process.env.ADMIN_METRICS_KEY;
  if (!expected || req.headers['x-admin-key'] !== expected) {
    return res.status(401).json({ error: 'unauthorized', message: 'غير مصرح.' });
  }
  const db = admin();

  if (req.method === 'GET') {
    const status = typeof req.query?.status === 'string' ? req.query.status : 'draft';
    const { data, error } = await db.from('question_bank').select('*')
      .eq('workflow_status', status).order('created_at', { ascending: false }).limit(100);
    if (error) return res.status(503).json({ error: 'db_error', message: 'خدمة بنك الأسئلة غير متاحة.' });
    return res.status(200).json({ questions: data || [] });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const body = req.body || {};
  if (body.action === 'create') {
    const row = {
      subject_label: body.subjectLabel,
      grade_label: body.gradeLabel || null,
      topic: body.topic,
      prompt: body.prompt,
      type: body.type || 'mcq',
      options: body.options || null,
      correct_answer: body.correctAnswer ?? null,
      source_document_id: body.sourceDocumentId || null,
      workflow_status: 'draft'
    };
    if (![row.subject_label,row.topic,row.prompt].every(v => typeof v === 'string' && v.trim())) {
      return res.status(400).json({ error: 'missing_fields', message: 'المادة والموضوع ونص السؤال مطلوبة.' });
    }
    const { data, error } = await db.from('question_bank').insert(row).select().single();
    if (error) return res.status(503).json({ error: 'db_error', message: 'تعذر إنشاء مسودة السؤال.' });
    return res.status(201).json({ question: data });
  }

  if (body.action === 'review') {
    if (!body.questionId || !['approved','rejected','needs_edit'].includes(body.status)) {
      return res.status(400).json({ error: 'invalid_review', message: 'معطيات المراجعة غير صالحة.' });
    }
    const { data, error } = await db.from('question_bank').update({
      workflow_status: body.status,
      review_note: typeof body.note === 'string' ? body.note.slice(0, 2000) : null,
      updated_at: new Date().toISOString()
    }).eq('id', body.questionId).select().single();
    if (error) return res.status(503).json({ error: 'db_error', message: 'تعذر تحديث حالة السؤال.' });
    return res.status(200).json({ question: data });
  }

  return res.status(400).json({ error: 'invalid_action', message: 'الإجراء غير معروف.' });
}

module.exports = withMetrics('question-workflow', handler);

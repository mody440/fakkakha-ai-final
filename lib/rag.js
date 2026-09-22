// Curriculum-grounded retrieval. Uses pgvector when embeddings exist and a
// conservative keyword fallback before the curriculum index is populated.
const { admin } = require('./supabaseAdmin');
const { embedText } = require('./embeddings');
const { ServiceUnavailableError } = require('./apiResponse');

async function retrieveCurriculumContext({ question, subjectLabel, topic, gradeLabel, limit = 5 }) {
  const db = admin();
  const query = [subjectLabel, topic, gradeLabel, question].filter(Boolean).join(' — ').slice(0, 6000);

  let embedding = null;
  try {
    embedding = await embedText(query);
  } catch (_) {
    // Embeddings are an optimization; the keyword path below remains valid.
  }

  if (embedding) {
    const { data, error } = await db.rpc('match_curriculum_documents', {
      query_embedding: embedding,
      match_count: limit,
      filter_subject: subjectLabel || null,
      filter_grade: gradeLabel || null
    });
    // The vector RPC is optional. A missing RPC/index must not take down the
    // tutoring session; continue with the metadata fallback below.
    if (Array.isArray(data) && data.length) {
      return data.map((r, i) => ({
        id: r.id, title: r.title, content: r.content,
        subjectLabel: r.subject_label, topic: r.topic, similarity: r.similarity,
        rank: i + 1
      }));
    }
  }

  // The connected production project stores verified source metadata in
  // learning_sources (not the older curriculum_documents table). Use it as a
  // safe fallback so missing embeddings never become a generic DB outage.
  let q = db.from('curriculum_documents').select('id,title,content,subject_label,topic').limit(limit);
  if (subjectLabel) q = q.eq('subject_label', subjectLabel);
  if (gradeLabel) q = q.or(`grade_label.is.null,grade_label.eq.${gradeLabel.replace(/,/g, '')}`);
  let { data, error } = await q;
  if (error) {
    const sourceResult = await db.from('learning_sources')
      .select('id,title,provider,url,source_type,subjects,stages,license_note').eq('active', true).limit(limit);
    if (sourceResult.error) return [];
    data = (sourceResult.data || []).map(r => ({
      id: r.id, title: r.title, topic: null,
      content: `مصدر موثوق: ${r.provider || ''}\nالرابط الرسمي: ${r.url || ''}\nنوع المصدر: ${r.source_type || ''}`,
      subject_label: Array.isArray(r.subjects) ? r.subjects.join('، ') : ''
    }));
  }

  const rows = Array.isArray(data) ? data : [];
  const tokens = `${topic || ''} ${question || ''}`.toLowerCase().split(/\s+/).filter(x => x.length > 2);
  return rows.map(r => ({
    ...r,
    similarity: tokens.filter(t => `${r.title} ${r.topic} ${r.content}`.toLowerCase().includes(t)).length,
  })).filter(r => r.similarity > 0).sort((a, b) => b.similarity - a.similarity).slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 }));
}

function formatRAGContext(rows) {
  if (!rows.length) return 'لا يوجد محتوى منهجي مسترجع لهذه الجزئية. لا تدّعي أن إجابتك مطابقة للمنهج.';
  return rows.map((r, i) => `[مصدر ${i + 1}] ${r.title || r.topic}\n${r.content}`).join('\n\n');
}

module.exports = { retrieveCurriculumContext, formatRAGContext };

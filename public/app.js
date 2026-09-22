/* ==========================================================================
   CONFIG — fill these in before deploying.
   SUPABASE_URL / SUPABASE_ANON_KEY are safe to expose (protected by RLS).
   The Gemini key is NEVER referenced here — it only lives server-side in
   the /api functions, read from process.env.GEMINI_API_KEY.
   ========================================================================== */
const API_BASE = ""; // same-origin on Vercel; leave empty

// Public runtime config is served by /api/config so the deploy can be
// configured entirely through Vercel environment variables. The anon key is
// intentionally public; RLS is the security boundary. Never put the Gemini
// or Supabase service-role keys in this file.
let SUPABASE_URL = "";
let SUPABASE_ANON_KEY = "";
try {
  const configRes = await fetch('/api/config', { headers: { 'Accept': 'application/json' } });
  const config = await configRes.json().catch(() => ({}));
  if (!configRes.ok || !config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error('Supabase configuration is missing. Add SUPABASE_URL and SUPABASE_ANON_KEY in Vercel.');
  }
  SUPABASE_URL = config.supabaseUrl;
  SUPABASE_ANON_KEY = config.supabaseAnonKey;
} catch (err) {
  document.getElementById('app').innerHTML = `<div class="screen center-col"><div class="warn-emoji">⚙️</div><h1 class="h">الإعدادات ناقصة</h1><p class="sub">${String(err?.message || 'تعذر تحميل إعدادات التطبيق.')}</p></div>`;
  throw err;
}

// Loaded from /lib/i18n.js (plain <script>, before this module script) —
// every static UI string goes through t('key') instead of a hardcoded
// literal, so adding a language means adding a dictionary, not rewriting
// this file. AI-generated content is intentionally NOT part of this system
// (see lib/i18n.js header comment for why).
// A slow/cached mobile WebView must not take the whole app down if the plain
// i18n script was delayed or blocked. Keep a tiny safe fallback until the
// real dictionary is available.
const t = window.i18n?.t || ((key, vars = {}) => {
  const fallback = {
    retry: 'حاول تاني',
    app_name: 'فكّكها',
    app_name_full: 'Fakkakha AI',
    auth_setup_failed_title: 'مقدرناش نجهز حسابك',
  };
  let value = fallback[key] || key;
  for (const [name, replacement] of Object.entries(vars)) value = value.replace(`{${name}}`, String(replacement));
  return value;
});

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ---------------------------- identity / auth ---------------------------- */
// Real Supabase Auth (anonymous sign-in), NOT a client-generated random id.
// This is what row_id = auth.uid() in the RLS policies actually checks —
// without it, anyone holding the public anon key could read/write anyone's
// rows. supabase-js persists the session in localStorage itself, so the
// SAME anonymous identity (and therefore the same profiles) comes back
// after closing the tab or reopening the app.
let AUTH_USER_ID = null;
let AUTH_IS_ANONYMOUS = true;
let AUTH_EMAIL = null;
async function ensureAuth(){
  const { data: { session } } = await supabase.auth.getSession();
  if(session){
    AUTH_USER_ID = session.user.id;
    AUTH_IS_ANONYMOUS = session.user.is_anonymous ?? true;
    AUTH_EMAIL = session.user.email || null;
    return;
  }
  const { data, error } = await supabase.auth.signInAnonymously();
  if(error){
    // Most common cause: Anonymous Sign-ins isn't enabled on the Supabase project yet.
    throw new Error('التسجيل المجهول مش مفعّل في مشروع Supabase — فعّله من Authentication → Providers → Anonymous Sign-ins.');
  }
  AUTH_USER_ID = data.user.id;
  AUTH_IS_ANONYMOUS = true;
  AUTH_EMAIL = null;
}

/* ------------------------- optional account linking ------------------------ */
// A student's progress is tied to their anonymous auth id by default (no
// signup needed). If they want that SAME progress to follow them to a new
// phone/browser, they can optionally attach an email+password to it —
// Supabase keeps the same user id, so every row they already own (RLS-scoped
// by that id) stays theirs after linking. This is genuinely optional: the
// app works fully without it.
async function linkAccountToEmail(email, password){
  const { error } = await supabase.auth.updateUser({ email, password });
  if(error) throw new Error(error.message || 'مقدرناش نربط الحساب دلوقتي.');
  AUTH_EMAIL = email;
}
// Signing in with an existing linked email SWITCHES the active identity to
// that account (and its data) — used when the student is on a new device
// and wants their old progress back, replacing whatever anonymous session
// this browser currently has.
async function signInWithExistingEmail(email, password){
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if(error) throw new Error(error.message || 'الإيميل أو الباسورد غلط.');
  AUTH_USER_ID = data.user.id;
  AUTH_IS_ANONYMOUS = data.user.is_anonymous ?? false;
  AUTH_EMAIL = data.user.email || null;
}

/* ------------------------------ grade parsing ------------------------------ */
const GradeService = {
  ordinals: {"اول":1,"أول":1,"اولى":1,"أولى":1,"تاني":2,"ثاني":2,"ثانية":2,"تالت":3,"ثالث":3,"تالتة":3,"ثالثة":3,"رابع":4,"رابعة":4,"خامس":5,"خامسة":5,"سادس":6,"سادسة":6},
  stages: {"ابتدائي":"ابتدائي","ابتدائية":"ابتدائي","اعدادي":"إعدادي","إعدادي":"إعدادي","اعدادية":"إعدادي","ثانوي":"ثانوي","ثانوية":"ثانوي","prep":"إعدادي","primary":"ابتدائي","secondary":"ثانوي","high":"ثانوي"},
  normalize(text){
    if(!text) return "غير محدد";
    const t = text.trim(); const low = t.toLowerCase();
    let num=null, stage=null;
    for(const k in this.ordinals){ if(t.includes(k)){ num=this.ordinals[k]; break; } }
    const d = low.match(/(\d+)/); if(!num && d) num = parseInt(d[1]);
    for(const k in this.stages){ if(low.includes(k)){ stage=this.stages[k]; break; } }
    if(num && stage) return `${stage} — سنة ${num}`;
    if(stage) return stage;
    if(num) return `سنة ${num}`;
    return t;
  }
};

/* ------------------------------ data service ------------------------------ */
// Small write-durability helper: session/skill/mistake writes here happen
// right after Gemini has already answered (see TECHNICAL_REVIEW_AR.md,
// item 1) — a transient network blip on THIS insert, not on the AI call,
// is the realistic way a turn silently "disappears" even though the
// student saw the correct response on screen. Retrying a couple of times
// with backoff turns most of those blips into a no-op instead of data
// loss, without changing any behavior on the (overwhelmingly common)
// success path.
async function withRetry(label, fn, { retries = 2, baseDelayMs = 400 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { error } = await fn();
      if (!error) return true;
      lastErr = error;
    } catch (err) {
      lastErr = err;
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt)));
  }
  // Final failure after retries: this must be visible, not swallowed —
  // log it distinctly so it's easy to search for and to notice a real
  // outage vs. an occasional blip.
  console.error(`[fakkakha:save-failed] ${label}`, lastErr);
  return false;
}

const DataService = {
  async listProfiles(){
    // A device realistically has a handful of profiles (siblings sharing a
    // phone) — capped defensively so this never becomes an unbounded query.
    const { data, error } = await supabase.from('profiles').select('*').order('created_at', {ascending:false}).limit(20);
    if(error) throw new Error(error.message || 'الخدمة غير متاحة حاليًا. تعذر تحميل ملفك.');
    // The production schema uses display_name/education_level/school_year;
    // older UI code used name/grade_label. Normalize both shapes at the edge.
    return (data || []).map(profile => ({
      ...profile,
      name: String(profile.name ?? profile.display_name ?? 'طالب').trim() || 'طالب',
      grade_label: String(profile.grade_label ?? profile.school_year ?? profile.education_level ?? 'غير محدد').trim() || 'غير محدد',
    }));
  },
  async createProfile(name, gradeRaw, age = null, subject = '', language = 'ar'){
    const gradeLabel = GradeService.normalize(gradeRaw);
    const { data, error } = await supabase.from('profiles')
      // The production RLS policy is profiles_self: auth.uid() = id.
      // Use the anonymous user's UUID as the profile primary key and upsert,
      // so retrying after a network error remains safe and idempotent.
      .upsert({ id: AUTH_USER_ID, display_name: String(name || '').trim(), education_level: gradeLabel, school_year: gradeLabel, major: subject || null }, { onConflict: 'id' })
      .select().single();
    if(error) throw error;
    return {
      ...data,
      name: String(data.display_name || name || 'طالب').trim() || 'طالب',
      grade_label: String(data.school_year || data.education_level || gradeLabel).trim() || 'غير محدد',
    };
  },
  async listSkills(profileId){
    // Capped generously — a student could accumulate skill rows across
    // many topics over months, but an unbounded query isn't the right
    // default regardless of how unlikely hitting the cap is today.
    const { data, error } = await supabase.from('skill_reviews').select('*').eq('user_id', AUTH_USER_ID).order('mastery_score', {ascending:false}).limit(100);
    if(error) return [];
    return (data || []).map(row => ({
      ...row,
      mastery: Number(row.mastery ?? row.mastery_score ?? 0),
      attempts: Number(row.attempts ?? row.review_count ?? 0),
      correct: Number(row.correct ?? 0),
      subject_label: row.subject_label ?? row.subject ?? '',
    }));
  },
  async upsertSkillDelta(profileId, subjectLabel, topic, delta, verdict){
    const { data: existing } = await supabase.from('skill_reviews').select('*')
      .eq('user_id', AUTH_USER_ID).eq('subject', subjectLabel).eq('topic', topic).maybeSingle();
    if(existing){
      const mastery = Math.max(0.05, Math.min(1, Number(existing.mastery_score ?? 0.4) + delta));
      return withRetry('upsertSkillDelta(update)', () => supabase.from('skill_reviews').update({
        mastery_score: mastery, review_count: Number(existing.review_count || 0) + 1,
        last_result: verdict === 'correct', next_review_at: new Date(Date.now() + 86400000).toISOString()
      }).eq('id', existing.id));
    } else {
      return withRetry('upsertSkillDelta(insert)', () => supabase.from('skill_reviews').insert({
        user_id: AUTH_USER_ID, subject: subjectLabel, topic,
        mastery_score: Math.max(0.05, Math.min(1, 0.4 + delta)),
        review_count: 1, last_result: verdict === 'correct', next_review_at: new Date(Date.now() + 86400000).toISOString()
      }));
    }
  },
  async createSession(profileId, question, analysis){
    const { data, error } = await supabase.from('learning_sessions').insert({
      user_id: AUTH_USER_ID, question_text: question, subject: analysis.subjectLabel || analysis.subject,
      education_level: currentProfile?.grade_label || null, school_year: currentProfile?.grade_label || null, status: 'started'
    }).select().single();
    if(error) throw error;
    return { ...data, subject_label: data.subject, topic: analysis.topic, question: data.question_text };
  },
  async findActiveSession(profileId){
    const { data, error } = await supabase.from('learning_sessions').select('*')
      .eq('user_id', AUTH_USER_ID).in('status', ['started', 'in_progress'])
      .order('updated_at', {ascending:false}).limit(1).maybeSingle();
    if(error) return null;
    return data ? { ...data, subject_label: data.subject, topic: data.topic || data.subject, question: data.question_text } : null;
  },
  async completeSession(sessionId){
    const { error } = await supabase.from('learning_sessions').update({ status:'completed', updated_at:new Date().toISOString() }).eq('id', sessionId);
    if(error) throw new Error('الخدمة غير متاحة حاليًا. تعذر حفظ حالة الجلسة.');
  },
  async updateSessionState(sessionId, state){
    const { error } = await supabase.from('learning_sessions').update({ status: state === 'COMPLETED' ? 'completed' : 'in_progress', updated_at:new Date().toISOString() }).eq('id', sessionId);
    if(error) throw new Error('الخدمة غير متاحة حاليًا. تعذر تحديث الجلسة.');
  },
  async addMessage(sessionId, role, content){
    const mappedRole = role === 'ai' ? 'assistant' : role === 'student' ? 'user' : 'system';
    return withRetry(`addMessage(${role})`, () => supabase.from('session_messages').insert({ session_id: sessionId, user_id: AUTH_USER_ID, role: mappedRole, content }));
  },
  async listMessages(sessionId){
    // A very long-running session could accumulate a lot of messages —
    // fetch the most recent 200 (newest first, so LIMIT actually bounds the
    // right end), then restore chronological order for the UI.
    const { data, error } = await supabase.from('session_messages').select('*').eq('session_id', sessionId).order('created_at', {ascending:false}).limit(200);
    if(error) throw new Error('الخدمة غير متاحة حاليًا. تعذر تحميل المحادثة.');
    return (data || []).reverse().map(row => ({ ...row, role: row.role === 'assistant' ? 'ai' : row.role === 'user' ? 'student' : row.role }));
  },
  async logMistake(profileId, subjectLabel, topic, category, source){
    if(!category || category === 'NONE') return; // nothing wrong happened — don't log noise
    return withRetry('logMistake', () => supabase.from('skill_evidence').insert({
      user_id: AUTH_USER_ID, subject: subjectLabel, topic,
      evidence_type: category, result: false, confidence: 0.8, source
    }));
  },
  async getMistakeBreakdown(profileId){
    const { data, error } = await supabase.from('skill_evidence').select('evidence_type, topic').eq('user_id', AUTH_USER_ID).eq('result', false).order('created_at', {ascending:false}).limit(500);
    if(error) throw new Error('الخدمة غير متاحة حاليًا. تعذر تحميل تحليل الأخطاء.');
    const rows = data || [];
    const byCategory = {}, byTopic = {};
    for(const r of rows){
      byCategory[r.evidence_type] = (byCategory[r.evidence_type] || 0) + 1;
      byTopic[r.topic] = (byTopic[r.topic] || 0) + 1;
    }
    const sortEntries = (obj) => Object.entries(obj).sort((a,b) => b[1]-a[1]);
    return { total: rows.length, categories: sortEntries(byCategory), topics: sortEntries(byTopic) };
  },
};

/* -------------------------------- AI service ------------------------------- */
// The frontend NEVER calls Gemini directly — every call goes through our own
// backend under /api, which holds the real key server-side.
const AIService = {
  async post(path, body){
    const controller = new AbortController();
    const t = setTimeout(()=>controller.abort(), 25000);
    try{
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(API_BASE + path, {
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          ...(session?.access_token ? { 'Authorization': 'Bearer ' + session.access_token } : {})
        },
        body: JSON.stringify(body), signal: controller.signal
      });
      clearTimeout(t);
      if(!res.ok){
        const errBody = await res.json().catch(()=>({}));
        throw new Error(errBody.message || 'الخدمة غير متاحة حاليًا');
      }
      return await res.json();
    } catch(err){
      clearTimeout(t);
      if(err.name === 'AbortError') throw new Error('الاتصال أخد وقت طويل، جرب تاني.');
      throw new Error(err.message || 'حصل خطأ في الشبكة.');
    }
  },
  analyzeQuestion(question, gradeLabel){ return this.post('/api/analyze-question', { question, gradeLabel }); },
  sessionTurn(payload){ return this.post('/api/session-turn', payload); },
  async sessionTurnStream(payload, onDelta){
    const { data: { session: authSession } } = await supabase.auth.getSession();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 40000);
    try {
      const res = await fetch(API_BASE + '/api/session-turn-stream', {
        method:'POST',
        headers:{'Content-Type':'application/json', ...(authSession?.access_token ? {'Authorization':'Bearer '+authSession.access_token} : {})},
        body:JSON.stringify(payload), signal:controller.signal
      });
      if(!res.ok) throw new Error((await res.json().catch(()=>({}))).message || 'الخدمة مش متاحة دلوقتي');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', donePayload = null;
      const handleBlock = (block) => {
        const lines = block.split(/\r?\n/);
        const event = lines.find(l=>l.startsWith('event:'))?.slice(6).trim();
        const dataLine = lines.find(l=>l.startsWith('data:'))?.slice(5).trim();
        if(!dataLine) return;
        let data; try{ data=JSON.parse(dataLine); }catch{return;}
        if(event==='delta' && data.text) onDelta(data.text);
        if(event==='done') donePayload=data;
        if(event==='error') throw new Error(data.message || 'stream_error');
      };
      while(true){
        const {value,done}=await reader.read();
        if(done) break;
        buffer += decoder.decode(value,{stream:true});
        const blocks=buffer.split(/\r?\n\r?\n/); buffer=blocks.pop()||'';
        blocks.forEach(handleBlock);
      }
      if(buffer.trim()) handleBlock(buffer);
      if(!donePayload) throw new Error('الرد المتدفق اكتمل بدون نتيجة نهائية.');
      return donePayload;
    } catch(err){
      if(err.name==='AbortError') throw new Error('الاتصال أخد وقت طويل، جرب تاني.');
      throw err;
    } finally { clearTimeout(timeout); }
  },
  detectMistake(question, attempt){ return this.post('/api/detect-mistake', { question, attempt }); },
  analyzeImage(imageBase64, mimeType){ return this.post('/api/analyze-image', { imageBase64, mimeType }); },
  research(query, subject, gradeLabel){ return this.post('/api/research', { query, subject, gradeLabel, count: 6 }); },
  generateExam(payload){ return this.post('/api/generate-exam', payload); },
  scoreExam(payload){ return this.post('/api/score-exam', payload); },
  reportContent(context, aiMessage, reason){ return this.post('/api/report-content', { context, aiMessage, reason }); },
  trackEvent(eventName, metadata){ return this.post('/api/track-event', { eventName, metadata }).catch(()=>{}); } // analytics must never break the UI
};

/* ================================== UI ================================== */
const app = document.getElementById('app');
let currentProfile = null;
let session = null; // { id, subject, subjectLabel, topic, gradeLabel, history:[], stepCount }

function render(html){
  app.innerHTML = html;
  window.scrollTo(0,0);
  // Percentage bars carry their value in data-pct instead of an inline
  // style="width:...", so this is plain CSSOM assignment (el.style.width = ...)
  // — CSP's style-src only governs style written in markup, not this, so it
  // works even with a strict style-src 'self' (no 'unsafe-inline').
  app.querySelectorAll('.bar-fill[data-pct]').forEach(el => {
    el.style.width = el.dataset.pct + '%';
  });
}
function escapeHtml(s){ const d=document.createElement('div'); d.innerText=s??''; return d.innerHTML; }
function cryptoRandomId(){
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
}

app.addEventListener('keydown', (e) => {
  if(e.key !== 'Enter' && e.key !== ' ') return;
  const target = e.target.closest('[role="button"]');
  if(target){ e.preventDefault(); target.click(); }
});

async function boot(){
  render(`<div class="screen center-col-full"><span class="spinner spinner-lg"></span></div>`);
  try{
    await ensureAuth();
    if(typeof window.initPush === 'function') window.initPush(supabase); // no-op outside the native app
    await go(screenProfiles);
  } catch(err){
    render(`<div class="screen center-col">
      <div class="warn-emoji">⚠️</div>
      <h1 class="h">${t('auth_setup_failed_title')}</h1>
      <p class="sub">${escapeHtml(err.message)}</p>
      <button class="btn btn-primary btn-block" id="retryBootBtn">${t('retry')}</button>
    </div>`);
  }
}

function renderLoading(){
  render(`<div class="screen center-col-full" aria-live="polite" aria-busy="true">
    <div class="loading-skeleton skeleton-logo"></div>
    <div class="loading-skeleton skeleton-title"></div>
    <div class="loading-skeleton skeleton-line"></div>
    <div class="loading-skeleton skeleton-card"></div>
    <div class="loading-skeleton skeleton-card"></div>
  </div>`);
}
async function go(fn){
  renderLoading();
  try {
    render(await fn());
  } catch(err) {
    render(`<div class="screen center-col" role="alert">
      <div class="warn-emoji">⚠️</div>
      <h1 class="h">الخدمة غير متاحة</h1>
      <p class="sub">${escapeHtml(err?.message || 'تعذر تحميل هذه الصفحة.')}</p>
      <button class="btn btn-primary btn-block" id="retryScreenBtn">${t('retry')}</button>
    </div>`);
    window.__fakkakhaRetry = fn;
  }
}
app.addEventListener('click', (e) => {
  if(e.target.closest('#retryBootBtn')) location.reload();
  if(e.target.closest('#retryScreenBtn') && window.__fakkakhaRetry) return go(window.__fakkakhaRetry);
});

/* ---- profiles ---- */
async function screenProfiles(){
  let profiles;
  try {
    profiles = await DataService.listProfiles();
  } catch (err) {
    return `<div class="screen center-col"><div class="warn-emoji">⚠️</div><h1 class="h">الخدمة غير متاحة</h1><p class="sub">${escapeHtml(err.message)}</p><button class="btn btn-primary btn-block" id="retryProfilesBtn">${t('retry')}</button></div>`;
  }
  return `
  <div class="screen">
    <div class="topbar"><div class="brand"><div class="mark">ف</div><div class="name">${t('app_name')} <span>${t('app_name_full')}</span></div></div></div>
    <h1 class="h">${t('who_is_studying')}</h1>
    <p class="sub">${t('profiles_sub')}</p>
    ${profiles.map(p => `
      <div class="profile-row" data-id="${p.id}" role="button" tabindex="0">
        <div class="avatar">${escapeHtml(p.name.trim()[0] || '?')}</div>
        <div><div class="pn">${escapeHtml(p.name)}</div><div class="pg">${escapeHtml(p.grade_label)}</div></div>
      </div>`).join('')}
    <div class="card ${profiles.length ? 'mt-14' : 'mt-4'}">
      <div class="field"><label class="field-lbl">${t('your_name')}</label><input type="text" id="npName" placeholder="${t('your_name_ph')}"></div>
      <div class="field"><label class="field-lbl">السن</label><input type="number" id="npAge" min="5" max="100" inputmode="numeric" placeholder="مثلاً: 15"></div>
      <div class="field"><label class="field-lbl">المادة الأساسية (اختياري)</label><input type="text" id="npSubject" placeholder="مثلاً: رياضيات"></div>
      <div class="field mb-12"><label class="field-lbl">${t('your_grade')}</label><input type="text" id="npGrade" placeholder="${t('your_grade_ph')}"></div>
      <button class="btn btn-primary btn-block" id="createProfileBtn">${t('start')}</button>
    </div>

    <div id="profileErr"></div>
  </div>`;
}
app.addEventListener('click', async (e) => {
  if(e.target.closest('#retryProfilesBtn')) return go(screenProfiles);
  const row = e.target.closest('.profile-row');
  if(row){
    const p = (await DataService.listProfiles()).find(x => x.id === row.dataset.id);
    if(p) await selectProfile(p);
    return;
  }
  if(e.target.id === 'createProfileBtn') return createProfile();
});
async function createProfile(){
  const name = document.getElementById('npName').value.trim();
  const grade = document.getElementById('npGrade').value.trim();
  const age = document.getElementById('npAge')?.value.trim() || '';
  const subject = document.getElementById('npSubject')?.value.trim() || '';
  if(!name){ document.getElementById('profileErr').innerHTML = `<div class="banner">${t('name_required')}</div>`; return; }
  try{
    const p = await DataService.createProfile(name, grade || 'غير محدد', age || null, subject, 'ar');
    AIService.trackEvent('profile_created');
    await selectProfile(p);
  } catch(err){
    console.error('[fakkakha:profile-save-failed]', err);
    document.getElementById('profileErr').innerHTML = `<div class="banner">مقدرناش نحفظ البروفايل: ${escapeHtml(err?.message || 'خطأ غير معروف')}. جرّب تاني.</div>`;
  }
}
async function selectProfile(p){
  currentProfile = p;
  const active = await DataService.findActiveSession(p.id);
  if(active) currentProfile._activeSessionRow = active;
  await go(screenHome);
}

/* ---- home ---- */
async function screenHome(){
  const p = currentProfile;
  const skills = await DataService.listSkills(p.id);
  const insight = skills.length === 0
    ? t('no_insight_yet')
    : (() => {
        const best = skills.reduce((a,b)=> a.mastery>b.mastery?a:b);
        const worst = skills.reduce((a,b)=> a.mastery<b.mastery?a:b);
        return skills.length === 1
          ? `فهمك لـ ${best.topic} بيتحسن — استمر شوية كمان عشان تثبّته.`
          : `تحسّنت في ${best.topic}. ركّز شوية على ${worst.topic}، لسه محتاج مذاكرة.`;
      })();
  const active = p._activeSessionRow;
  return `
  <div class="screen">
    <div class="topbar">
      <div class="brand"><div class="mark">ف</div><div class="name">${t('app_name')} <span>${t('app_name_full')}</span></div></div>
      <div class="icon-group">
        <div class="icon-btn" id="switchProfileBtn" role="button" tabindex="0" aria-label="${t('switch_profile')}" title="${t('switch_profile')}">⇄</div>
        <div class="icon-btn" id="accountBtn" role="button" tabindex="0" aria-label="${t('account')}" title="${t('account')}">👤</div>
      </div>
    </div>
    <h1 class="h">${t('welcome', {name: escapeHtml(p.name)})} 👋</h1>
    <p class="sub">${escapeHtml(p.grade_label)}</p>
    ${active ? `
    <div class="continue-card" id="resumeBtn" role="button" tabindex="0">
      <div class="lbl">${t('continue_where_left')}</div>
      <div class="ttl">${escapeHtml(active.topic)}</div>
      <div class="meta">${escapeHtml(active.subject_label)}</div>
    </div>` : ``}
    <div class="action" id="goImage" role="button" tabindex="0"><div class="emoji">📸</div><div class="txt"><div class="t">${t('action_image_title')}</div><div class="d">${t('action_image_desc')}</div></div></div>
    <div class="action" id="goAsk" role="button" tabindex="0"><div class="emoji">✍️</div><div class="txt"><div class="t">${t('action_ask_title')}</div><div class="d">${t('action_ask_desc')}</div></div></div>
    <div class="action" id="goResearch" role="button" tabindex="0"><div class="emoji">🔎</div><div class="txt"><div class="t">بحث بالمصادر</div><div class="d">ابحث في مصادر حية واعرض الرابط والملخص والتاريخ بوضوح</div></div></div>
    <div class="action" id="goExplore" role="button" tabindex="0"><div class="emoji">🧠</div><div class="txt"><div class="t">${t('action_explore_title')}</div><div class="d">${t('action_explore_desc')}</div></div></div>
    <div class="insight">${escapeHtml(insight)}</div>
  </div>`;
}
app.addEventListener('click', (e) => {
  if(e.target.closest('#switchProfileBtn')) return go(screenProfiles);
  if(e.target.closest('#accountBtn')) return go(screenAccount);
  if(e.target.closest('#goImage')) return go(screenImage);
  if(e.target.closest('#goAsk')) return go(screenAsk);
  if(e.target.closest('#goResearch')) return go(screenResearch);
  if(e.target.closest('#goExplore')) return go(screenExplore);
  if(e.target.closest('#resumeBtn')) return resumeSession();
});

async function resumeSession(){
  const row = currentProfile._activeSessionRow;
  const msgs = await DataService.listMessages(row.id);
  session = {
    id: row.id, subject: row.subject, subjectLabel: row.subject_label, topic: row.topic,
    gradeLabel: currentProfile.grade_label,
    history: msgs.filter(m=>m.role!=='system').map(m=>({role:m.role, text:m.content}))
  };
  render(screenSessionShell());
  renderThreadFrom(session.history);
  updateStateBar('GUIDED_STEP');
}

/* ---- image screen ---- */
/* ---- account: optional email linking, so progress can follow a device change ---- */
async function screenAccount(){
  return `
  <div class="screen">
    <div class="topbar"><div class="icon-btn" id="backHome" role="button" tabindex="0" aria-label="${t('back')}">→</div><div class="brand"><div class="name">${t('account_title')}</div></div><div class="w-38"></div></div>
    ${AUTH_IS_ANONYMOUS ? `
      <div class="banner info">${t('account_anon_banner')}</div>
      <div class="card mb-12">
        <div class="field"><label class="field-lbl">${t('account_email_label')}</label><input type="text" id="linkEmail" placeholder="you@example.com"></div>
        <div class="field mb-12"><label class="field-lbl">${t('account_password_label')}</label><input type="text" id="linkPassword" placeholder="••••••"></div>
        <button class="btn btn-primary btn-block" id="linkAccountBtn">${t('account_link_btn')}</button>
        <div id="linkStatus"></div>
      </div>
      <p class="sub mb-10">${t('account_have_account')}</p>
      <div class="card">
        <div class="field"><label class="field-lbl">${t('account_email_label')}</label><input type="text" id="signinEmail" placeholder="you@example.com"></div>
        <div class="field mb-12"><label class="field-lbl">${t('account_password_label')}</label><input type="text" id="signinPassword" placeholder="••••••"></div>
        <button class="btn btn-ghost btn-block" id="signinAccountBtn">${t('account_signin_btn')}</button>
        <div id="signinStatus"></div>
      </div>
    ` : `
      <div class="banner info">${t('account_linked_banner', {email: escapeHtml(AUTH_EMAIL || '')})}</div>
    `}
  </div>`;
}
app.addEventListener('click', async (e) => {
  if(e.target.closest('#linkAccountBtn')) return handleLinkAccount();
  if(e.target.closest('#signinAccountBtn')) return handleSigninExisting();
});
async function handleLinkAccount(){
  const email = document.getElementById('linkEmail').value.trim();
  const password = document.getElementById('linkPassword').value;
  const statusEl = document.getElementById('linkStatus');
  if(!email || password.length < 6){ statusEl.innerHTML = `<div class="banner mt-10">اكتب إيميل صحيح وباسورد 6 حروف على الأقل</div>`; return; }
  statusEl.innerHTML = `<div class="banner info mt-10"><span class="spinner"></span> بيربط...</div>`;
  try{
    await linkAccountToEmail(email, password);
    AIService.trackEvent('account_linked');
    statusEl.innerHTML = `<div class="banner info mt-10">اتبعتلك إيميل تأكيد — افتحه من نفس الجهاز عشان الربط يتفعّل بالكامل.</div>`;
  } catch(err){
    statusEl.innerHTML = `<div class="banner mt-10">${escapeHtml(err.message)}</div>`;
  }
}
async function handleSigninExisting(){
  const email = document.getElementById('signinEmail').value.trim();
  const password = document.getElementById('signinPassword').value;
  const statusEl = document.getElementById('signinStatus');
  if(!email || !password){ statusEl.innerHTML = `<div class="banner mt-10">اكتب الإيميل والباسورد</div>`; return; }
  statusEl.innerHTML = `<div class="banner info mt-10"><span class="spinner"></span> بيسجّل دخول...</div>`;
  try{
    await signInWithExistingEmail(email, password);
    currentProfile = null;
    await go(screenProfiles);
  } catch(err){
    statusEl.innerHTML = `<div class="banner mt-10">${escapeHtml(err.message)}</div>`;
  }
}

async function screenImage(){
  return `
  <div class="screen">
    <div class="topbar"><div class="icon-btn" id="backHome" role="button" tabindex="0" aria-label="${t('back')}">→</div><div class="brand"><div class="name">${t('image_title')}</div></div><div class="w-38"></div></div>
    <div class="banner info">${t('image_banner')}</div>
    <div class="field"><label class="field-lbl">${t('choose_image')}</label><input type="file" id="imgFile" accept="image/*"></div>
    <button class="btn btn-primary btn-block" id="analyzeImgBtn">${t('start_analysis')}</button>
    <div id="imgStatus"></div>
  </div>`;
}
app.addEventListener('click', async (e) => {
  if(e.target.closest('#backHome')) return go(screenHome);
  if(e.target.closest('#analyzeImgBtn')) return handleImageAnalyze();
});
async function handleImageAnalyze(){
  const fileInput = document.getElementById('imgFile');
  const file = fileInput.files[0];
  const statusEl = document.getElementById('imgStatus');
  if(!file){ statusEl.innerHTML = `<div class="banner">${t('choose_image_first')}</div>`; return; }
  statusEl.innerHTML = `<div class="banner info"><span class="spinner"></span> ${t('analyzing_image')}</div>`;
  try{
    const { base64, mimeType } = await compressImage(file);
    const result = await AIService.analyzeImage(base64, mimeType);
    if(!result.readable){
      statusEl.innerHTML = `<div class="banner">${escapeHtml(result.extractedText)}</div>`;
      return;
    }
    AIService.trackEvent('image_question_used');
    await startSession(result.extractedText, result);
  } catch(err){
    statusEl.innerHTML = `<div class="banner">${escapeHtml(err.message)}</div>`;
  }
}
// Resizes to a max dimension and re-encodes as JPEG before sending — per the
// "compress images before processing, avoid huge base64 payloads" requirement.
function compressImage(file, maxDim = 1600, quality = 0.82){
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = () => reject(new Error('مقدرناش نقرأ الصورة'));
    img.onload = () => {
      let { width, height } = img;
      if(width > maxDim || height > maxDim){
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale); height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      resolve({ base64: dataUrl.split(',')[1], mimeType: 'image/jpeg' });
    };
    img.onerror = () => reject(new Error('الصورة دي مش مدعومة، جرب صورة تانية'));
    reader.readAsDataURL(file);
  });
}

/* ---- ask screen ---- */
async function screenAsk(){
  return `
  <div class="screen">
    <div class="topbar"><div class="icon-btn" id="backHome" role="button" tabindex="0" aria-label="${t('back')}">→</div><div class="brand"><div class="name">${t('ask_title')}</div></div><div class="w-38"></div></div>
    <p class="sub">${t('ask_sub')}</p>
    <div class="field"><textarea id="askQuestion" maxlength="3000" class="ta-tall" placeholder="${t('ask_placeholder')}"></textarea></div>
    <button class="btn btn-primary btn-block" id="submitAskBtn">${t('send_question')}</button>
    <div id="askStatus"></div>
  </div>`;
}

async function screenResearch(){
  return `
  <div class="screen">
    <div class="topbar"><div class="icon-btn" id="backHome" role="button" tabindex="0" aria-label="${t('back')}">→</div><div class="brand"><div class="name">بحث بالمصادر</div></div><div class="w-38"></div></div>
    <div class="banner info">لن نعرض نتائج مخترعة. يلزم إعداد مزوّد بحث HTTPS على الخادم، وكل نتيجة ستظهر برابطها وملخصها الأصلي.</div>
    <div class="field"><label class="field-lbl" for="researchQuery">سؤال البحث</label><textarea id="researchQuery" maxlength="3000" class="ta-tall" placeholder="مثلاً: ما أحدث إرشادات الإسعاف الأولي للحروق؟"></textarea></div>
    <button class="btn btn-primary btn-block" id="runResearchBtn">ابحث وأظهر الاستشهادات</button>
    <div id="researchStatus" aria-live="polite"></div>
  </div>`;
}
app.addEventListener('click', async (e) => {
  if(e.target.closest('#runResearchBtn')){
    const q = document.getElementById('researchQuery')?.value.trim();
    const out = document.getElementById('researchStatus');
    if(!q){ out.innerHTML = `<div class="banner">اكتب سؤال البحث أولًا.</div>`; return; }
    out.innerHTML = `<div class="banner info"><span class="spinner"></span> جارٍ البحث والتحقق من الروابط…</div>`;
    try {
      const result = await AIService.research(q, currentProfile?.subject, currentProfile?.grade_label);
      out.innerHTML = `<div class="research-results"><p class="sub">تم الاسترجاع: ${escapeHtml(new Date(result.retrievedAt).toLocaleString())}</p>${result.sources.map((source, i) => `<article class="card citation-card"><div class="chip mb-8">مصدر ${i + 1} · ${escapeHtml(source.domain)}</div><h2 class="fs-13-5 mb-8">${escapeHtml(source.title)}</h2><p class="note-line mb-8">${escapeHtml(source.snippet)}</p><a class="source-link" href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer">فتح المصدر الرسمي ↗</a></article>`).join('')}</div>`;
    } catch(err) { out.innerHTML = `<div class="banner">${escapeHtml(err.message)}</div>`; }
  }
});
app.addEventListener('click', async (e) => {
  if(e.target.closest('#submitAskBtn')) return submitAsk();
});
async function submitAsk(){
  const q = document.getElementById('askQuestion').value.trim();
  const statusEl = document.getElementById('askStatus');
  if(!q){ statusEl.innerHTML = `<div class="banner">${t('write_question_first')}</div>`; return; }
  statusEl.innerHTML = `<div class="banner info"><span class="spinner"></span> ${t('analyzing_question')}</div>`;
  try{
    const analysis = await AIService.analyzeQuestion(q, currentProfile.grade_label, currentProfile.age, currentProfile.subject, currentProfile.language);
    await startSession(q, analysis);
  } catch(err){
    statusEl.innerHTML = `<div class="banner">${escapeHtml(err.message)}</div>`;
  }
}

/* ---- explore / progress / mistake detective ---- */
async function screenExplore(){
  return `
  <div class="screen">
    <div class="topbar"><div class="icon-btn" id="backHome" role="button" tabindex="0" aria-label="${t('back')}">→</div><div class="brand"><div class="name">${t('explore_title')}</div></div><div class="w-38"></div></div>
    <div class="action" id="goAsk2" role="button" tabindex="0"><div class="emoji">🧪</div><div class="txt"><div class="t">${t('problem_lab')}</div><div class="d">${t('problem_lab_desc')}</div></div></div>
    <div class="action" id="goMistake" role="button" tabindex="0"><div class="emoji">🕵️</div><div class="txt"><div class="t">${t('mistake_detective')}</div><div class="d">${t('mistake_detective_desc')}</div></div></div>
    <div class="action" id="goProgress" role="button" tabindex="0"><div class="emoji">📈</div><div class="txt"><div class="t">${t('progress_title')}</div><div class="d">${t('progress_desc')}</div></div></div>
    <div class="action" id="goMistakeAnalysis" role="button" tabindex="0"><div class="emoji">🔁</div><div class="txt"><div class="t">${t('mistake_analysis_title')}</div><div class="d">${t('mistake_analysis_desc')}</div></div></div>
    <div class="action" id="goExam" role="button" tabindex="0"><div class="emoji">⏱️</div><div class="txt"><div class="t">${t('exam_mode')}</div><div class="d">${t('exam_mode_desc')}</div></div></div>
  </div>`;
}
app.addEventListener('click', (e) => {
  if(e.target.closest('#goAsk2')) return go(screenAsk);
  if(e.target.closest('#goMistake')) return go(screenMistake);
  if(e.target.closest('#goProgress')) return go(screenProgress);
  if(e.target.closest('#goMistakeAnalysis')) return go(screenMistakeAnalysis);
  if(e.target.closest('#goExam')) return go(screenExamConfig);
});

async function screenProgress(){
  const skills = await DataService.listSkills(currentProfile.id);
  return `
  <div class="screen">
    <div class="topbar"><div class="icon-btn" id="backExplore" role="button" tabindex="0" aria-label="${t('back')}">→</div><div class="brand"><div class="name">${t('progress_title')}</div></div><div class="w-38"></div></div>
    ${skills.length===0 ? `<p class="sub">${t('progress_empty')}</p>` : skills.map(s => `
      <div class="skill-item">
        <div class="top"><span class="name">${escapeHtml(s.topic)}</span><span class="pct">${Math.round(s.mastery*100)}%</span></div>
        <div class="bar-track"><div class="bar-fill" data-pct="${Math.round(s.mastery*100)}"></div></div>
      </div>`).join('')}
  </div>`;
}
app.addEventListener('click', (e) => { if(e.target.closest('#backExplore')) go(screenExplore); });

async function screenMistakeAnalysis(){
  const data = await DataService.getMistakeBreakdown(currentProfile.id);
  if(data.total === 0){
    return `
    <div class="screen">
      <div class="topbar"><div class="icon-btn" id="backExplore4" role="button" tabindex="0" aria-label="${t('back')}">→</div><div class="brand"><div class="name">${t('mistake_analysis_title')}</div></div><div class="w-38"></div></div>
      <p class="sub">${t('mistake_analysis_empty')}</p>
    </div>`;
  }
  return `
  <div class="screen">
    <div class="topbar"><div class="icon-btn" id="backExplore4" role="button" tabindex="0" aria-label="${t('back')}">→</div><div class="brand"><div class="name">${t('mistake_analysis_title')}</div></div><div class="w-38"></div></div>
    <p class="sub mb-10">${t('mistake_analysis_categories')}</p>
    ${data.categories.slice(0,6).map(([cat,count]) => `
      <div class="skill-item">
        <div class="top"><span class="name">${escapeHtml(MISTAKE_LABELS[cat] || cat)}</span><span class="pct">${count}</span></div>
        <div class="bar-track"><div class="bar-fill" data-pct="${Math.round(count/data.categories[0][1]*100)}"></div></div>
      </div>`).join('')}
    <p class="sub mt-16 mb-10">${t('mistake_analysis_topics')}</p>
    ${data.topics.slice(0,6).map(([topic,count]) => `
      <div class="skill-item">
        <div class="top"><span class="name">${escapeHtml(topic)}</span><span class="pct">${count}</span></div>
        <div class="bar-track"><div class="bar-fill" data-pct="${Math.round(count/data.topics[0][1]*100)}"></div></div>
      </div>`).join('')}
  </div>`;
}
app.addEventListener('click', (e) => { if(e.target.closest('#backExplore4')) go(screenExplore); });

async function screenMistake(){
  return `
  <div class="screen">
    <div class="topbar"><div class="icon-btn" id="backExplore2" role="button" tabindex="0" aria-label="${t('back')}">→</div><div class="brand"><div class="name">${t('mistake_detective')}</div></div><div class="w-38"></div></div>
    <div class="field"><label class="field-lbl">${t('md_question_label')}</label><textarea id="mdQ" maxlength="3000" placeholder="${t('md_question_ph')}"></textarea></div>
    <div class="field"><label class="field-lbl">${t('md_attempt_label')}</label><textarea id="mdA" maxlength="4000" placeholder="${t('md_attempt_ph')}"></textarea></div>
    <button class="btn btn-primary btn-block" id="runMdBtn">${t('md_run')}</button>
    <div id="mdResult"></div>
  </div>`;
}
const MISTAKE_LABELS = {
  CONCEPT_MISUNDERSTANDING:'سوء فهم للمفهوم', WRONG_FORMULA:'قانون غلط', WRONG_RULE:'قاعدة غلط',
  CALCULATION_ERROR:'خطأ حسابي', SIGN_ERROR:'خطأ في الإشارة', UNIT_ERROR:'خطأ في الوحدات',
  READING_ERROR:'خطأ في قراءة السؤال', LOGIC_ERROR:'خطأ منطقي', INCOMPLETE_REASONING:'حل غير مكتمل',
  CARELESS_ERROR:'خطأ سهو', NONE:'من غير خطأ واضح'
};
app.addEventListener('click', async (e) => {
  if(e.target.closest('#backExplore2')) return go(screenExplore);
  if(e.target.closest('#runMdBtn')) return runMistakeDetective();
});
async function runMistakeDetective(){
  const q = document.getElementById('mdQ').value.trim();
  const a = document.getElementById('mdA').value.trim();
  const resultEl = document.getElementById('mdResult');
  if(!q || !a){ resultEl.innerHTML = `<div class="banner">${t('md_fill_both')}</div>`; return; }
  resultEl.innerHTML = `<div class="banner info"><span class="spinner"></span> ${t('md_analyzing')}</div>`;
  try{
    const r = await AIService.detectMistake(q, a);
    AIService.trackEvent('mistake_detective_used');
    if(r.category && r.category !== 'NONE'){
      const topicGuess = q.length > 60 ? q.slice(0, 57) + '…' : q;
      await DataService.logMistake(currentProfile.id, 'عام (Mistake Detective)', topicGuess, r.category, 'detect-mistake');
    }
    resultEl.innerHTML = `
      <div class="card mt-16">
        <div class="chip mb-12">${MISTAKE_LABELS[r.category] || r.category}</div>
        <p class="note-line mb-10"><b class="hl">${t('md_first_step')}</b> ${escapeHtml(r.firstStep)}</p>
        <p class="note-line mb-10"><b class="hl">${t('md_why')}</b> ${escapeHtml(r.why)}</p>
        <p class="note-line mb-10"><b class="hl">${t('md_tiny')}</b> ${escapeHtml(r.tiny)}</p>
        <p class="note-line"><b class="hl">${t('md_practice')}</b> ${escapeHtml(r.practice)}</p>
      </div>`;
  } catch(err){
    resultEl.innerHTML = `<div class="banner">${escapeHtml(err.message)}</div>`;
  }
}

/* ============================== exam mode ============================== */
let examState = null; // { examSessionId, questions, index, answers:[], secondsLeft, timerId }

async function screenExamConfig(){
  const skills = await DataService.listSkills(currentProfile.id);
  const subjects = [...new Set(skills.map(s => s.subject_label))];
  return `
  <div class="screen">
    <div class="topbar"><div class="icon-btn" id="backExplore3" role="button" tabindex="0" aria-label="${t('back')}">→</div><div class="brand"><div class="name">${t('exam_mode')}</div></div><div class="w-38"></div></div>
    <p class="sub">${t('exam_config_sub')}</p>
    ${subjects.length ? `
    <div class="field">
      <label class="field-lbl">${t('exam_subject_label')}</label>
      <input type="text" id="examSubject" list="subjectList" value="${escapeHtml(subjects[0])}">
      <datalist id="subjectList">${subjects.map(s=>`<option value="${escapeHtml(s)}">`).join('')}</datalist>
    </div>` : `
    <div class="field"><label class="field-lbl">${t('exam_subject_label')}</label><input type="text" id="examSubject" placeholder="${t('exam_subject_ph')}"></div>`}
    <div class="field"><label class="field-lbl">${t('exam_topics_label')}</label><input type="text" id="examTopics" maxlength="500" placeholder="${t('exam_topics_ph')}"></div>
    <div class="field">
      <label class="field-lbl">${t('exam_count_label')}</label>
      <input type="text" id="examCount" value="5">
    </div>
    <div class="field">
      <label class="field-lbl">${t('exam_difficulty_label')}</label>
      <input type="text" id="examDifficulty" value="medium" placeholder="easy / medium / hard">
    </div>
    <button class="btn btn-primary btn-block" id="startExamBtn">${t('exam_start')}</button>
    <div id="examConfigStatus"></div>
  </div>`;
}
app.addEventListener('click', (e) => {
  if(e.target.closest('#backExplore3')) return go(screenExplore);
  if(e.target.closest('#startExamBtn')) return startExam();
});
async function startExam(){
  const subjectLabel = document.getElementById('examSubject').value.trim();
  const topicsRaw = document.getElementById('examTopics').value.trim();
  const count = document.getElementById('examCount').value.trim();
  const difficulty = document.getElementById('examDifficulty').value.trim() || 'medium';
  const statusEl = document.getElementById('examConfigStatus');
  if(!subjectLabel || !topicsRaw){ statusEl.innerHTML = `<div class="banner">${t('exam_fill_first')}</div>`; return; }
  statusEl.innerHTML = `<div class="banner info"><span class="spinner"></span> ${t('exam_preparing')}</div>`;
  try{
    const topics = topicsRaw.split(/[,،]/).map(t=>t.trim()).filter(Boolean);
    const result = await AIService.generateExam({
      profileId: currentProfile.id, subjectLabel, topics, difficulty, count, gradeLabel: currentProfile.grade_label
    });
    examState = {
      examSessionId: result.examSessionId, questions: result.questions,
      index: 0, answers: [], secondsLeft: result.questions.length * 45, timerId: null
    };
    AIService.trackEvent('exam_started', { subjectLabel, questionCount: result.questions.length });
    render(screenExamRunning());
    startExamTimer();
  } catch(err){
    statusEl.innerHTML = `<div class="banner">${escapeHtml(err.message)}</div>`;
  }
}

function screenExamRunning(){
  const q = examState.questions[examState.index];
  return `
  <div class="screen">
    <div class="topbar">
      <div class="icon-btn" id="exitExamBtn" role="button" tabindex="0" aria-label="إنهاء الاختبار">→</div>
      <span class="chip">سؤال ${examState.index+1} / ${examState.questions.length}</span>
      <span class="chip" id="examTimer">⏱ --:--</span>
    </div>
    <h1 class="h fs-17">${escapeHtml(q.text)}</h1>
    ${q.type === 'short_answer' ? `
    <div class="mt-16">
      <textarea id="examTextAnswer" maxlength="500" placeholder="اكتب إجابتك هنا…" class="ta-tall"></textarea>
    </div>` : `
    <div id="examOptions" class="mt-16">
      ${q.options.map((opt,i)=>`<div class="action exam-opt mb-10" data-i="${i}" role="button" tabindex="0"><div class="txt"><div class="t">${escapeHtml(opt)}</div></div></div>`).join('')}
    </div>`}
    <button class="btn btn-primary btn-block" id="examNextBtn" ${q.type === 'short_answer' ? '' : 'disabled'}>${t('exam_next')}</button>
  </div>`;
}
let examSelectedIndex = null;
app.addEventListener('input', (e) => {
  if(e.target.id === 'examTextAnswer'){
    const btn = document.getElementById('examNextBtn');
    if(btn) btn.disabled = !e.target.value.trim();
  }
});
app.addEventListener('click', (e) => {
  if(e.target.closest('#exitExamBtn')){
    if(examState){ clearInterval(examState.timerId); examState = null; }
    return go(screenHome);
  }
  const opt = e.target.closest('.exam-opt');
  if(opt && examState){
    document.querySelectorAll('.exam-opt').forEach(el => el.style.borderColor = 'var(--border)');
    opt.style.borderColor = 'var(--purple)';
    examSelectedIndex = parseInt(opt.dataset.i);
    document.getElementById('examNextBtn').disabled = false;
    return;
  }
  if(e.target.closest('#examNextBtn')) return examAdvance();
});
function startExamTimer(){
  updateExamTimerLabel();
  examState.timerId = setInterval(() => {
    examState.secondsLeft--;
    updateExamTimerLabel();
    if(examState.secondsLeft <= 0){ clearInterval(examState.timerId); finishExam(); }
  }, 1000);
}
function updateExamTimerLabel(){
  const el = document.getElementById('examTimer');
  if(!el) return;
  const m = Math.floor(examState.secondsLeft/60), s = examState.secondsLeft%60;
  el.textContent = `⏱ ${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}
function examAdvance(){
  const q = examState.questions[examState.index];
  if(q.type === 'short_answer'){
    const val = document.getElementById('examTextAnswer').value.trim();
    examState.answers.push({ questionId: q.id, textAnswer: val });
  } else {
    examState.answers.push({ questionId: q.id, selectedIndex: examSelectedIndex });
  }
  examSelectedIndex = null;
  examState.index++;
  if(examState.index >= examState.questions.length){
    clearInterval(examState.timerId);
    finishExam();
  } else {
    render(screenExamRunning());
  }
}
async function finishExam(){
  render(`<div class="screen"><div class="banner info"><span class="spinner"></span> ${t('exam_scoring')}</div></div>`);
  try{
    const report = await AIService.scoreExam({ examSessionId: examState.examSessionId, answers: examState.answers });
    AIService.trackEvent('exam_completed', { score: report.score, total: report.total });
    for(const b of report.breakdown){
      const delta = (b.correct / b.total - 0.5) * 0.3;
      await DataService.upsertSkillDelta(currentProfile.id, examState.questions[0] ? guessSubjectLabel() : '', b.topic, delta, b.correct === b.total ? 'correct' : 'partial');
    }
    render(screenExamReport(report));
  } catch(err){
    render(`<div class="screen"><div class="banner">${escapeHtml(err.message)}</div><button class="btn btn-ghost btn-block mt-14" id="examBackHome">${t('home')}</button></div>`);
  }
}
function guessSubjectLabel(){ return document.getElementById('examSubject')?.value || ''; }
function screenExamReport(report){
  const pct = Math.round((report.score/report.total)*100);
  return `
  <div class="screen">
    <div class="topbar"><div class="brand"><div class="name">${t('exam_report_title')}</div></div></div>
    <div class="card center-col mb-18">
      <div class="score-display">${report.score} / ${report.total}</div>
      <div class="muted fs-13 mt-4">${t('exam_percent_correct', {pct})}</div>
    </div>
    <p class="sub mb-10">${t('exam_breakdown_title')}</p>
    ${report.breakdown.map(b => `
      <div class="skill-item">
        <div class="top"><span class="name">${escapeHtml(b.topic)}</span><span class="pct">${b.correct}/${b.total}</span></div>
        <div class="bar-track"><div class="bar-fill" data-pct="${Math.round((b.correct/b.total)*100)}"></div></div>
      </div>`).join('')}
    ${report.mistakes.length ? `
    <p class="sub mt-14 mb-10">${t('exam_review_title')}</p>
    ${report.mistakes.map(m => `
      <div class="card mb-10">
        <div class="fs-13-5 mb-8">${escapeHtml(m.question)}</div>
        <div class="fs-12-5 wrong-line mb-4">${t('exam_your_answer')} ${escapeHtml(m.yourAnswer)}</div>
        <div class="fs-12-5 correct-line">${t('exam_correct_answer')} ${escapeHtml(m.correctAnswer)}</div>
      </div>`).join('')}` : `<div class="banner info">${t('exam_all_correct')}</div>`}
    <button class="btn btn-ghost btn-block mt-10" id="examBackHome">${t('home')}</button>
  </div>`;
}
app.addEventListener('click', (e) => { if(e.target.closest('#examBackHome')) go(screenHome); });

/* ============================ session engine ============================ */
async function startSession(questionText, analysis){
  const row = await DataService.createSession(currentProfile.id, questionText, analysis);
  session = {
    id: row.id, subject: analysis.subject, subjectLabel: analysis.subjectLabel,
    topic: analysis.topic, gradeLabel: currentProfile.grade_label, history: []
  };
  AIService.trackEvent('session_started', { subject: analysis.subject, topic: analysis.topic });
  render(screenSessionShell());
  updateStateBar('UNDERSTANDING');
  addAiMsg(`تمام، السؤال ده في ${session.subjectLabel} — موضوع "${session.topic}". خلينا نفككها سوا خطوة خطوة.`);
  await DataService.addMessage(session.id, 'ai', session.history[session.history.length-1].text);
  await runTurn('start', null);
}

function screenSessionShell(){
  return `
  <div class="screen pb-14">
    <div class="topbar"><div class="icon-btn" id="exitSessionBtn" role="button" tabindex="0" aria-label="خروج من الجلسة">→</div><div class="brand"><div class="name">${t('session_title')}</div></div><div class="w-38"></div></div>
    <div class="chip-row"><span class="chip">${escapeHtml(session.subjectLabel)}</span><span class="chip">${escapeHtml(session.topic)}</span></div>
    <div class="state-bar" id="stateBar"></div><div class="state-label" id="stateLabel"></div>
    <div id="thread"></div>
    <div class="composer">
      <div class="tool-row">
        <button class="btn btn-ghost btn-sm" id="hintBtn">💡 ${t('request_hint').replace('💡 ','')}</button>
        <button class="btn btn-ghost btn-sm" id="simplifyBtn">🔎 ${t('simplify_more').replace('🔎 ','')}</button>
      </div>
      <div class="composer-row">
        <textarea id="studentInput" maxlength="2000" placeholder="${t('answer_placeholder')}"></textarea>
        <button class="round-btn" id="voiceInputBtn" title="اكتب بصوتك" aria-label="اكتب بصوتك">🎙️</button>
        <button class="round-btn" id="submitAnswerBtn">↩</button>
      </div>
    </div>
  </div>`;
}
app.addEventListener('click', (e) => {
  if(e.target.closest('#exitSessionBtn')) return go(screenHome);
  if(e.target.closest('#hintBtn')) return runTurn('hint', null);
  if(e.target.closest('#simplifyBtn')) return runTurn('simplify', null);
  if(e.target.closest('#submitAnswerBtn')) return submitAnswer();
  if(e.target.closest('#voiceInputBtn')) return startVoiceInput();
  if(e.target.closest('.speak-btn')) return speakText(e.target.closest('.speak-btn').dataset.text || '');
});

const STATE_SEQUENCE = ['ANALYZING','UNDERSTANDING','GUIDED_STEP','EVALUATING','MASTERY'];
const STATE_TEXT = { ANALYZING:'بيحلل السؤال', UNDERSTANDING:'بيفهم المطلوب', GUIDED_STEP:'خطوة موجّهة', EVALUATING:'بيقيّم إجابتك', HINT_AVAILABLE:'محتاج تلميح؟', MASTERY:'قريب من الإتقان', COMPLETED:'خلصنا الجلسة' };
function updateStateBar(state){
  const idx = Math.max(0, STATE_SEQUENCE.indexOf(state));
  const bar = document.getElementById('stateBar');
  if(bar) bar.innerHTML = STATE_SEQUENCE.map((s,i)=>`<div class="dot ${i<=idx?'done':''}"></div>`).join('');
  const lbl = document.getElementById('stateLabel');
  if(lbl) lbl.textContent = STATE_TEXT[state] || '';
}
function addAiMsg(text){
  session.history.push({role:'ai', text});
  const threadEl = document.getElementById('thread');
  if(!threadEl) return;
  const wrap = document.createElement('div'); wrap.className='msg ai';
  const textSpan = document.createElement('span'); textSpan.textContent = text;
  const reportBtn = document.createElement('button');
  reportBtn.type = 'button';
  reportBtn.className = 'report-btn';
  reportBtn.setAttribute('aria-label', 'بلّغ عن الرد ده');
  reportBtn.textContent = t('report_message');
  reportBtn.addEventListener('click', () => reportAiMessage(text, reportBtn));
  wrap.appendChild(textSpan);
  wrap.appendChild(reportBtn);
  const speakBtn = document.createElement('button'); speakBtn.type='button'; speakBtn.className='speak-btn'; speakBtn.textContent='🔊'; speakBtn.title='اقرأ الرد بصوت'; speakBtn.dataset.text=text;
  wrap.appendChild(speakBtn);
  threadEl.appendChild(wrap); threadEl.scrollTop = threadEl.scrollHeight;
}
async function reportAiMessage(text, btn){
  btn.disabled = true;
  btn.textContent = '...';
  try{
    await AIService.reportContent(session?.subjectLabel || 'session', text);
    btn.textContent = t('report_sent');
  } catch(err){
    btn.textContent = t('report_failed');
    btn.disabled = false;
  }
}
function addStudentMsg(text){
  session.history.push({role:'student', text});
  const t = document.getElementById('thread');
  const el = document.createElement('div'); el.className='msg student'; el.textContent=text;
  t.appendChild(el); t.scrollTop = t.scrollHeight;
}
function addSystemLine(text){
  const t = document.getElementById('thread');
  const el = document.createElement('div'); el.className='msg system'; el.id='sys-last'; el.textContent=text;
  t.appendChild(el); t.scrollTop = t.scrollHeight;
}
function renderThreadFrom(history){
  const threadEl = document.getElementById('thread'); threadEl.innerHTML='';
  history.forEach(m => {
    if(m.role === 'ai'){
      const wrap = document.createElement('div'); wrap.className='msg ai';
      const textSpan = document.createElement('span'); textSpan.textContent = m.text;
      const reportBtn = document.createElement('button');
      reportBtn.type = 'button'; reportBtn.className = 'report-btn';
      reportBtn.setAttribute('aria-label', 'بلّغ عن الرد ده'); reportBtn.textContent = t('report_message');
      reportBtn.addEventListener('click', () => reportAiMessage(m.text, reportBtn));
      wrap.appendChild(textSpan); wrap.appendChild(reportBtn);
      threadEl.appendChild(wrap);
    } else {
      const el = document.createElement('div'); el.className='msg student'; el.textContent=m.text;
      threadEl.appendChild(el);
    }
  });
  threadEl.scrollTop = threadEl.scrollHeight;
}

async function submitAnswer(){
  const box = document.getElementById('studentInput');
  const val = box.value.trim();
  if(!val){ box.style.borderColor = 'var(--rose)'; box.placeholder = t('answer_required'); return; }
  box.style.borderColor = '';
  addStudentMsg(val);
  await DataService.addMessage(session.id, 'student', val);
  box.value = '';
  await runTurn('answer', val);
}

async function runTurn(action, studentAnswer){
  updateStateBar(action === 'answer' ? 'EVALUATING' : 'GUIDED_STEP');
  addSystemLine(action === 'answer' ? t('thinking') : t('preparing_next_step'));
  const submitBtn = document.getElementById('submitAnswerBtn');
  if(submitBtn) submitBtn.disabled = true;
  try{
    const turnId = globalThis.crypto?.randomUUID?.() || ('turn-' + Date.now() + '-' + cryptoRandomId());
    const payload = {
      subject: session.subject, subjectLabel: session.subjectLabel, topic: session.topic,
      gradeLabel: session.gradeLabel, age: currentProfile?.age ?? null,
      profileSubject: currentProfile?.subject || '', language: currentProfile?.language || 'ar',
      history: session.history, action, studentAnswer,
      sessionId: session.id, turnId
    };
    let result;
    try {
      let streamed = '';
      result = await AIService.sessionTurnStream(payload, (delta) => {
        document.getElementById('sys-last')?.remove();
        streamed += delta;
        let live = document.getElementById('streaming-ai');
        if(!live){ live=document.createElement('div'); live.className='msg ai'; live.id='streaming-ai'; document.getElementById('thread')?.appendChild(live); }
        const visible = streamed.split('@@META')[0].trim();
        live.textContent = visible;
        document.getElementById('thread')?.scrollTo(0, document.getElementById('thread').scrollHeight);
      });
      document.getElementById('streaming-ai')?.remove();
    } catch(streamErr) {
      document.getElementById('streaming-ai')?.remove();
      result = await AIService.sessionTurn(payload);
    }
    document.getElementById('sys-last')?.remove();
    addAiMsg(result.aiMessage);

    if(result.verdict){
      await DataService.upsertSkillDelta(currentProfile.id, session.subjectLabel, session.topic, result.masteryDelta || 0, result.verdict);
      if(result.verdict === 'incorrect' && result.mistakeCategory){
        await DataService.logMistake(currentProfile.id, session.subjectLabel, session.topic, result.mistakeCategory, 'session-turn');
      }
    }
    if(result.sessionComplete){
      updateStateBar('MASTERY');
      await DataService.completeSession(session.id);
      AIService.trackEvent('session_completed', { subject: session.subject, topic: session.topic });
      setTimeout(() => render(screenSessionDone()), 700);
    } else {
      updateStateBar(result.verdict === 'incorrect' ? 'HINT_AVAILABLE' : 'GUIDED_STEP');
      await DataService.updateSessionState(session.id, 'GUIDED_STEP');
    }
  } catch(err){
    document.getElementById('sys-last')?.remove();
    if(!navigator.onLine && window.FakkakhaOffline){
      const local = await window.FakkakhaOffline.reply(session.topic, studentAnswer || '');
      addAiMsg('📴 ' + local);
      try{ localStorage.setItem('fakkakha_pending_turn', JSON.stringify({topic:session.topic, action, studentAnswer, at:Date.now()})); }catch(_){}
    } else {
      addAiMsg('⚠️ ' + err.message);
    }
  } finally {
    if(submitBtn) submitBtn.disabled = false;
  }
}

function startVoiceInput(){
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if(!SpeechRecognition){ alert('الإدخال الصوتي غير مدعوم في المتصفح ده.'); return; }
  const input = document.getElementById('studentInput');
  const recognition = new SpeechRecognition();
  recognition.lang = /[A-Za-z]/.test(input?.value || '') ? 'en-US' : 'ar-EG';
  recognition.interimResults = true; recognition.continuous = false;
  const btn = document.getElementById('voiceInputBtn'); if(btn) btn.textContent='⏺️';
  let finalText='';
  recognition.onresult = (event) => {
    finalText = Array.from(event.results).map(r=>r[0].transcript).join(' ');
    if(input) input.value = finalText;
  };
  recognition.onerror = () => { if(btn) btn.textContent='🎙️'; };
  recognition.onend = () => { if(btn) btn.textContent='🎙️'; };
  recognition.start();
}
function speakText(text){
  if(!('speechSynthesis' in window)){ alert('قراءة النص بصوت غير مدعومة في المتصفح ده.'); return; }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = /[A-Za-z]/.test(text) ? 'en-US' : 'ar-EG';
  utterance.rate = 0.95;
  window.speechSynthesis.speak(utterance);
}

function screenSessionDone(){
  return `
  <div class="screen center-col">
    <div class="big-emoji">✅</div>
    <h1 class="h">${t('session_done_title')}</h1>
    <p class="sub">${t('session_done_sub')}</p>
    <button class="btn btn-primary btn-block" id="newQBtn">${t('new_question')}</button>
    <div class="spacer-10"></div>
    <button class="btn btn-ghost btn-block" id="homeBtn2">${t('home')}</button>
  </div>`;
}
app.addEventListener('click', (e) => {
  if(e.target.closest('#newQBtn')) return go(screenAsk);
  if(e.target.closest('#homeBtn2')) return go(screenHome);
});

boot();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(err => console.warn('SW registration failed', err));
  });
}

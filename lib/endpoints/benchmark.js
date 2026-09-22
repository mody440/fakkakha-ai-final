const { withMetrics } = require('../withMetrics');
// POST /api/benchmark — admin-only evaluation. Default: routing + rubric checks.
// mode=full additionally asks a judge model to estimate groundedness and hallucination.
const cases = require('../../tests/benchmark.cases');
const { callGemini } = require('../gemini');
const { FAST_MODEL, SMART_MODEL } = require('../models');
const { sanitizeForAI } = require('../guardrails');

function containsAny(text, terms){
  const s=(text||'').toLowerCase();
  return (terms||[]).filter(t=>s.includes(String(t).toLowerCase()));
}
function safeJson(raw){ try{return JSON.parse(raw)}catch{return null} }

async function handler(req,res){
  if(req.method!=='POST') return res.status(405).json({error:'method_not_allowed'});
  const expected=process.env.ADMIN_METRICS_KEY;
  if(!expected || req.headers['x-admin-key']!==expected) return res.status(401).json({error:'unauthorized'});
  const limit=Math.min(Math.max(Number(req.body?.limit)||50,1),50);
  const mode=req.body?.mode==='full'?'full':'routing';
  const results=[];
  for(const item of cases.slice(0,limit)){
    try{
      const q=sanitizeForAI(item.question).text;
      const raw=await callGemini(
        'Return valid JSON only. Answer as a careful school tutor. Never invent curriculum facts. JSON: {"subject":"رياضيات|فيزياء|كيمياء|عام","answer":"short Arabic answer"}.',
        [{text:`Classify and answer this educational question.\nQuestion: ${q}\nReference concept: ${item.referenceAnswer}`}],
        {model:FAST_MODEL,temperature:0}
      );
      const parsed=safeJson(raw)||{};
      const answer=String(parsed.answer||'');
      const subjectOk=parsed.subject===item.expectedSubject;
      const matched=containsAny(answer,item.mustInclude);
      const rubricPass=matched.length>=Math.min(2,item.mustInclude.length);
      const row={id:item.id,question:item.question,expected:item.expectedSubject,got:parsed.subject||null,subjectCorrect:subjectOk,requiredTermsMatched:matched,groundingRubricPass:rubricPass,answer};
      if(mode==='full'){
        const judgeRaw=await callGemini(
          'You are an evaluation judge. Return JSON only: {"grounded":true|false,"hallucination":true|false,"score":0-100,"reason":"brief"}. Grounded means the answer stays consistent with the supplied reference concept and does not invent facts.',
          [{text:`Reference concept: ${item.referenceAnswer}\nStudent-facing answer: ${answer}`}],
          {model:SMART_MODEL,temperature:0}
        );
        const j=safeJson(judgeRaw)||{};
        row.judge=j;
      }
      results.push(row);
    }catch(err){results.push({id:item.id,question:item.question,error:err.message,subjectCorrect:false,groundingRubricPass:false});}
  }
  const n=results.length;
  const subjectCorrect=results.filter(r=>r.subjectCorrect).length;
  const rubricCorrect=results.filter(r=>r.groundingRubricPass).length;
  const judged=results.filter(r=>r.judge);
  const grounded=judged.filter(r=>r.judge.grounded===true).length;
  const hallucinations=judged.filter(r=>r.judge.hallucination===true).length;
  return res.status(200).json({
    version:'2.0',mode,total:n,subjectAccuracy:n?subjectCorrect/n:0,
    groundedRubricAccuracy:n?rubricCorrect/n:0,
    judgeGroundedRate:judged.length?grounded/judged.length:null,
    judgeHallucinationRate:judged.length?hallucinations/judged.length:null,
    averageJudgeScore:judged.length?judged.reduce((a,r)=>a+(Number(r.judge.score)||0),0)/judged.length:null,
    cases:results
  });
};

module.exports = withMetrics('benchmark', handler);

// Optional local AI layer. It uses Transformers.js feature extraction in the browser
// to rank a tiny curriculum card set. The first model load needs internet; after
// the model is cached by the browser, ranking can continue offline.
(function(){
  const MODEL='Xenova/paraphrase-multilingual-MiniLM-L12-v2';
  const cards=[
    {keys:['نيوتن','القوة','f = m','physics'],reply:'فكّر في العلاقة بين محصلة القوة والكتلة والتسارع. اكتب القيم والوحدات أولًا، وبعدها جرّب التعويض.'},
    {keys:['أكسدة','اختزال','oxidation','reduction'],reply:'افتكر القاعدة الأساسية: الأكسدة ترتبط بفقد الإلكترونات، والاختزال باكتسابها. جرّب تحدد مين فقد ومين اكتسب.'},
    {keys:['معادلة','3x','linear','الدرجة الأولى'],reply:'ابدأ بعزل المجهول. اعمل العملية نفسها على الطرفين، وبعدها عوّض بالنتيجة للتأكد.'},
    {keys:['وحدة','unit','تحويل'],reply:'قبل الحساب، راجع الوحدات. هل كل القيم متوافقة مع القانون؟ لو لا، حوّلها الأول.'},
    {keys:['كيمياء','معادلات','موازنة'],reply:'راجع عدد ذرات كل عنصر في الطرفين، ثم غيّر المعاملات لا الصيغ الكيميائية حتى تتساوى الأعداد.'}
  ];
  let extractorPromise=null;
  async function getExtractor(){
    if(!extractorPromise){
      extractorPromise=import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2').then(m=>m.pipeline('feature-extraction',MODEL,{quantized:true}));
    }
    return extractorPromise;
  }
  function cosine(a,b){let dot=0,na=0,nb=0;for(let i=0;i<a.length;i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i]}return dot/(Math.sqrt(na)*Math.sqrt(nb)||1)}
  async function rank(text){
    const extractor=await getExtractor();
    const q=(await extractor(text,{pooling:'mean',normalize:true})).data;
    let best=null;
    for(const card of cards){
      const c=(await extractor(card.keys.join(' '),{pooling:'mean',normalize:true})).data;
      const score=cosine(q,c);
      if(!best||score>best.score) best={card,score};
    }
    return best;
  }
  window.FakkakhaLocalAI={model:MODEL,rank};
})();

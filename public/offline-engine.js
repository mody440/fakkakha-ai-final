// Hybrid offline fallback: local semantic model first, deterministic cards second.
(function(){
  const cards=[
    {keys:['نيوتن','القوة','f = m','physics'],reply:'فكّر في العلاقة بين محصلة القوة والكتلة والتسارع. اكتب القيم والوحدات الأول، وبعدها جرّب التعويض.'},
    {keys:['أكسدة','اختزال','oxidation','reduction'],reply:'افتكر القاعدة الأساسية: الأكسدة ترتبط بفقد الإلكترونات، والاختزال باكتسابها. جرّب تحدد مين فقد ومين اكتسب.'},
    {keys:['معادلة','3x','linear','الدرجة الأولى'],reply:'ابدأ بعزل المجهول. اعمل العملية نفسها على الطرفين، وبعدها عوّض بالنتيجة للتأكد.'},
    {keys:['وحدة','unit','تحويل'],reply:'قبل الحساب، راجع الوحدات. هل كل القيم متوافقة مع القانون؟ لو لا، حوّلها الأول.'},
    {keys:['كيمياء','معادلات','موازنة'],reply:'راجع عدد ذرات كل عنصر في الطرفين، ثم غيّر المعاملات لا الصيغ الكيميائية حتى تتساوى الأعداد.'}
  ];
  window.FakkakhaOffline={
    async reply(topic,answer){
      const text=`${topic||''} ${answer||''}`.trim();
      try{
        if(window.FakkakhaLocalAI){
          const best=await window.FakkakhaLocalAI.rank(text);
          if(best && best.score>=0.28) return `نمط Offline ذكي: ${best.card.reply}`;
        }
      }catch(_){/* local model unavailable; continue with deterministic fallback */}
      const low=text.toLowerCase();
      const hit=cards.find(c=>c.keys.some(k=>low.includes(k.toLowerCase())));
      return hit?hit.reply:'أنا شغال Offline دلوقتي. احفظ محاولتك وكمل التفكير، ولما الاتصال يرجع هكمّل معاك التحليل الكامل.';
    }
  };
})();

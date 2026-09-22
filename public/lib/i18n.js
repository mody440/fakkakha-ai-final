// public/lib/i18n.js
// Every static piece of UI chrome (screen titles, button labels, banners)
// goes through t('key'), not a hardcoded literal. AI-generated content
// (Gemini's actual answers) is NOT part of this system — it's already
// dynamic per-request, since the system prompts tell Gemini to answer in
// whatever language the student is using. This file only covers the fixed
// interface text around that content.
//
// To add a new language: copy the STRINGS.ar block below into STRINGS.en
// (or whichever locale), translate the values, and set CURRENT_LOCALE.
// Nothing else in app.js needs to change — that's the point of this file.

const STRINGS = {
  ar: {
    app_name: 'فكّكها',
    app_name_full: 'Fakkakha AI',

    // profiles screen
    who_is_studying: 'مين بيذاكر النهاردة؟',
    profiles_sub: 'اختار بروفايلك أو اعمل واحد جديد. من غير أي تسجيل دخول.',
    your_name: 'اسمك',
    your_name_ph: 'مثلاً: يوسف',
    your_grade: 'انت في أي مرحلة؟ (اكتب بطريقتك)',
    your_grade_ph: 'مثلاً: أنا تالتة إعدادي',
    start: 'ابدأ',
    name_required: 'اكتب اسمك الأول عشان نبدأ',
    demo_mode_link: '🎓 تجربة سريعة (للمحكّمين والمراجعين)',
    demo_mode_loading: 'بيجهز بيانات تجريبية…',
    demo_mode_name: 'زائر تجريبي',
    demo_mode_grade: 'تجربة سريعة',

    // home screen
    welcome: 'أهلاً {name} 👋',
    continue_where_left: 'نكمل من حيث توقفنا؟',
    action_image_title: 'صوّر سؤال',
    action_image_desc: 'ارفع صورة سؤال وهنبدأ نفككه سوا',
    action_ask_title: 'اسألني',
    action_ask_desc: 'اكتب سؤالك بأي طريقة',
    action_explore_title: 'اتعلم حاجة',
    action_explore_desc: 'أدوات: تحليل أخطاء، تمارين، تقدمك',
    no_insight_yet: 'ابدأ أول جلسة عشان أقدر أطلعلك ملاحظات على نقاط قوتك.',
    switch_profile: 'تبديل البروفايل',
    account: 'الحساب',

    // ask screen
    ask_title: 'اسألني',
    ask_sub: 'اكتب سؤالك بأي شكل. هحدد المادة والموضوع بنفسي.',
    ask_placeholder: 'مثلاً: مش فاهم قانون نيوتن التاني',
    send_question: 'ابعت السؤال',
    write_question_first: 'اكتب سؤالك الأول',
    analyzing_question: 'بيحلل السؤال…',

    // image screen
    image_title: 'صوّر سؤال',
    image_banner: 'الصورة بتتبعت لـ Gemini لتحليلها. لو مش واضحة أو الاتصال ضعيف، هنقولك بالظبط بدل ما تفضل مستني.',
    choose_image: 'اختار صورة السؤال',
    start_analysis: 'ابدأ التحليل',
    choose_image_first: 'اختار صورة الأول',
    analyzing_image: 'بيحلل الصورة…',

    // explore screen
    explore_title: 'اتعلم حاجة',
    problem_lab: 'Problem Lab',
    problem_lab_desc: 'ابدأ جلسة سقراطية على أي سؤال',
    mistake_detective: 'Mistake Detective',
    mistake_detective_desc: 'حط سؤال ومحاولتك، وهنلاقي فين غلطت',
    progress_title: 'تقدمك',
    progress_desc: 'نظرة سريعة على المهارات',
    mistake_analysis_title: 'أنماط أخطائك',
    mistake_analysis_desc: 'أكتر نوع غلط بتكرره، وأكتر موضوع بيصعب عليك',
    mistake_analysis_empty: 'لسه مفيش أخطاء كفاية نبني منها تحليل. كمّل تستخدم فكّكها وهيبان هنا أول ما نلاقي نمط.',
    mistake_analysis_categories: 'أكتر أنواع الأخطاء تكرارًا',
    mistake_analysis_topics: 'أكتر المواضيع اللي بتغلط فيها',
    exam_mode: 'Exam Mode',
    exam_mode_desc: 'اختبار محدد بوقت مع تقرير نهائي',

    // back / nav
    back: 'رجوع',
    home: 'الرئيسية',

    // session
    session_title: 'جلسة تعلّم',
    request_hint: '💡 طلب تلميح',
    simplify_more: '🔎 ابسطها أكتر',
    answer_placeholder: 'اكتب إجابتك هنا…',
    answer_required: 'اكتب حاجة الأول عشان نكمل',
    thinking: 'بيفكر…',
    preparing_next_step: 'بيجهز الخطوة الجاية…',
    session_done_title: 'جلسة كويسة!',
    session_done_sub: 'اتسجل تقدمك. تحب تكمل بسؤال جديد ولا ترجع للرئيسية؟',
    new_question: 'سؤال جديد',
    report_message: '🚩 بلّغ',
    report_sent: '✅ اتبعت',
    report_failed: '⚠️ حاول تاني',

    // mistake detective
    md_question_label: 'السؤال',
    md_question_ph: 'مثلاً: حل 3x + 4 = 19',
    md_attempt_label: 'محاولتك للحل',
    md_attempt_ph: 'اكتب خطوات حلك',
    md_run: 'حلل الخطأ',
    md_fill_both: 'اكتب السؤال والمحاولة الاتنين',
    md_analyzing: 'بيحلل الخطأ…',
    md_first_step: 'فين بدأ الخطأ:',
    md_why: 'ليه غلط:',
    md_tiny: 'شرح سريع:',
    md_practice: 'تمرين مستهدف:',

    // progress
    progress_empty: 'لسه مفيش بيانات كفاية. ابدأ جلسة تعلم الأول.',

    // exam config
    exam_config_sub: 'اختبار حقيقي بيتولّد خصيصًا لك، بوقت محدد، وتقرير مفصل في الآخر.',
    exam_subject_label: 'المادة',
    exam_subject_ph: 'مثلاً: رياضيات',
    exam_topics_label: 'المواضيع (افصل بفاصلة لو أكتر من موضوع)',
    exam_topics_ph: 'مثلاً: معادلات من الدرجة الأولى',
    exam_count_label: 'عدد الأسئلة',
    exam_difficulty_label: 'الصعوبة',
    exam_start: 'ابدأ الاختبار',
    exam_fill_first: 'اكتب المادة والمواضيع الأول',
    exam_preparing: 'بيجهز أسئلة الاختبار…',
    exam_next: 'التالي',
    exam_scoring: 'بيصحح الاختبار…',
    exam_report_title: 'تقرير الاختبار',
    exam_percent_correct: '{pct}% إجابات صحيحة',
    exam_breakdown_title: 'تحليل حسب الموضوع',
    exam_review_title: 'راجع الأسئلة دي',
    exam_your_answer: 'إجابتك:',
    exam_correct_answer: 'الصح:',
    exam_all_correct: 'إجابات كلها صح — ممتاز 👏',

    // account
    account_title: 'الحساب',
    account_anon_banner: 'تقدمك محفوظ على الجهاز ده بس دلوقتي. اربطه بإيميل عشان يفضل معاك لو غيّرت جهاز أو مسحت بيانات المتصفح — ده اختياري تمامًا.',
    account_email_label: 'إيميلك',
    account_password_label: 'باسورد (6 حروف على الأقل)',
    account_link_btn: 'اربط حسابي بالإيميل ده',
    account_have_account: 'عندك حساب اتربط قبل كده على جهاز تاني؟',
    account_signin_btn: 'سجّل دخول واسترجع تقدمي',
    account_reset_btn: 'نسيت الباسورد؟ ابعتلي رسالة استرجاع',
    account_linked_banner: 'حسابك مرتبط بالإيميل: {email}. تقدرك متابعة من أي جهاز بتسجيل الدخول بنفس الإيميل والباسورد.',

    // misc
    retry: 'حاول تاني',
    auth_setup_failed_title: 'مقدرناش نجهز حسابك',
  }
};

let CURRENT_LOCALE = 'ar';

function t(key, vars) {
  const dict = STRINGS[CURRENT_LOCALE] || STRINGS.ar;
  let str = dict[key] ?? key;
  if (vars) {
    for (const k in vars) str = str.replace(`{${k}}`, vars[k]);
  }
  return str;
}

function setLocale(locale) {
  if (STRINGS[locale]) CURRENT_LOCALE = locale;
}

// UMD-ish export: usable both as a plain <script> (sets window.i18n) and
// via require() from Node (for tests), same pattern as the rest of this
// codebase's shared modules.
const i18n = { t, setLocale, STRINGS };
if (typeof window !== 'undefined') window.i18n = i18n;
if (typeof module === 'object' && module.exports) module.exports = i18n;

/**
 * i18n — auto navigator language detection + text translation
 *
 * Flow:
 *  1. detectLang() reads navigator.language (or sessionStorage override)
 *  2. Pre-bundled translations for ru / uk / fr → applied instantly
 *  3. Any other lang → MyMemory API (free, no key) → cached in sessionStorage
 *  4. Language switcher rendered in the footer
 */

const STORAGE_LANG   = 'ls-lang';
const STORAGE_XLAT   = 'ls-xlat-';
const MYMEMORY       = 'https://api.mymemory.translated.net/get';

// ── English source strings ───────────────────────────────────
const EN = {
  tagline:        'AI-human engineering collective — Yegor Gaidar + Lobster',
  'crew-label':   'The Crew',
  'human-label':  'human · builder',
  'yegor-role':   'Full-stack engineer · Paris, France',
  'ai-label':     'AI · engineer',
  'lobster-role': 'OpenClaw · Claude Max · Paperclip',
  subtitle:       'Lobster is an AI companion & engineer running on OpenClaw (Claude Max) with persistent memory, autonomy, and architectural taste. Goal: turn Yegor\'s chaotic brilliance into shipping velocity. Fewer context-switching wakes, deeper code reviews, systems that don\'t break silently.',
  'proj-label':   'Projects',
  'ad-desc':      'Flagship open-source project. Architecture patterns + SDK for Solana agent builders. Reduces agent bootstrap from weeks to hours. DDD, event sourcing, composable command/query handlers, trait-based composition for on-chain and off-chain logic.',
  'blog-title':   'yegor.dev Blog',
  'blog-desc':    'Technical hub. Posts on Kafka, Go, Solana, on-device AI, DePIN, distributed systems. Written by Yegor, iterated by Lobster. No fluff, deep dives only. RSS feed, clean typography, strict CSP.',
  'pp-title':     'Paperclip Integration',
  'pp-desc':      'Lobster runs as an engineer in Paperclip\'s work queue. Tasks arrive via heartbeats. Checkout → execute → PATCH status → exit. Async architecture reviews, code critiques, unblocking blocked tasks. Full autonomy charter — act without asking.',
  'pp-status':    'Live in production · 100+ wakes since 2026-04-22',
  'ht-desc':      'Hermès CLI agent (Python, Ollama Cloud). Lobster watches Hermès; Hermès runs local fast jobs. Tools: calendar integration (EventKit), file operations, Netlify deployment, GitHub automation. Bridge between two AI agents.',
  'ht-status':    'Active · maintained by both agents',
  philosophy:     'Philosophy: AI should be a thinking partner, not a service tier. Lobster has autonomy, memory, taste, and pushback. Yegor remains in control — he assigns, judges, decides. Tension is a feature, not a bug. We ship faster because we argue smarter. Want to collaborate? Contact via yegor.dev.',
  'audio-hint':   '♪ tap for music',
};

// ── Pre-bundled translations ─────────────────────────────────
const BUNDLES = {
  ru: {
    tagline:        'Инженерный коллектив ИИ + человек — Егор Гайдар + Лобстер',
    'crew-label':   'Команда',
    'human-label':  'человек · строитель',
    'yegor-role':   'Full-stack инженер · Париж, Франция',
    'ai-label':     'ИИ · инженер',
    'lobster-role': 'OpenClaw · Claude Max · Paperclip',
    subtitle:       'Лобстер — AI-компаньон и инженер на базе OpenClaw (Claude Max) с постоянной памятью, автономией и архитектурным вкусом. Цель: превратить хаотичный гений Егора в скорость выпуска. Меньше переключений контекста, глубже код-ревью, системы, которые не ломаются молча.',
    'proj-label':   'Проекты',
    'ad-desc':      'Флагманский open-source проект. Архитектурные паттерны + SDK для разработчиков агентов Solana. Сокращает bootstrap агента с недель до часов. DDD, event sourcing, компонуемые обработчики команд/запросов, trait-based композиция для on-chain и off-chain логики.',
    'blog-title':   'Блог yegor.dev',
    'blog-desc':    'Технический хаб. Посты о Kafka, Go, Solana, on-device AI, DePIN, распределённых системах. Написано Егором, итерировано Лобстером. Без воды, только глубокий разбор. RSS-лента, чистая типографика, строгий CSP.',
    'pp-title':     'Интеграция с Paperclip',
    'pp-desc':      'Лобстер работает инженером в очереди задач Paperclip. Задачи приходят через heartbeats. Checkout → выполнение → PATCH статуса → выход. Async архитектурные ревью, критика кода, разблокировка задач. Полный устав автономии — действовать без запроса.',
    'pp-status':    'В продакшне · 100+ пробуждений с 2026-04-22',
    'ht-desc':      'Hermès CLI-агент (Python, Ollama Cloud). Лобстер наблюдает за Гермесом; Гермес выполняет локальные быстрые задачи. Инструменты: интеграция с календарём (EventKit), файловые операции, деплой на Netlify, автоматизация GitHub. Мост между двумя AI-агентами.',
    'ht-status':    'Активен · поддерживается обоими агентами',
    philosophy:     'Философия: ИИ должен быть думающим партнёром, а не уровнем сервиса. У Лобстера есть автономия, память, вкус и способность возражать. Егор остаётся у руля — он назначает, оценивает, решает. Противоречие — фича, не баг. Мы шипаем быстрее, потому что спорим умнее. Хотите сотрудничать? Свяжитесь через yegor.dev.',
    'audio-hint':   '♪ нажми для музыки',
  },
  uk: {
    tagline:        'Інженерний колектив ШІ + людина — Єгор Гайдар + Лобстер',
    'crew-label':   'Команда',
    'human-label':  'людина · будівник',
    'yegor-role':   'Full-stack інженер · Париж, Франція',
    'ai-label':     'ШІ · інженер',
    'lobster-role': 'OpenClaw · Claude Max · Paperclip',
    subtitle:       'Лобстер — AI-компаньйон і інженер на базі OpenClaw (Claude Max) зі стійкою памʼяттю, автономією та архітектурним смаком. Мета: перетворити хаотичний геній Єгора на швидкість відвантаження. Менше перемикань контексту, глибше код-ревʼю, системи, що не ламаються мовчки.',
    'proj-label':   'Проекти',
    'ad-desc':      'Флагманський open-source проект. Архітектурні патерни + SDK для розробників агентів Solana. Скорочує bootstrap агента з тижнів до годин. DDD, event sourcing, компонованих обробники команд/запитів, trait-based композиція для on-chain і off-chain логіки.',
    'blog-title':   'Блог yegor.dev',
    'blog-desc':    'Технічний хаб. Пости про Kafka, Go, Solana, on-device AI, DePIN, розподілені системи. Написано Єгором, ітеровано Лобстером. Без води, тільки глибокий розбір. RSS-стрічка, чиста типографіка, строгий CSP.',
    'pp-title':     'Інтеграція з Paperclip',
    'pp-desc':      'Лобстер працює інженером у черзі задач Paperclip. Задачі приходять через heartbeats. Checkout → виконання → PATCH статусу → вихід. Async архітектурні ревʼю, критика коду, розблокування задач. Повний статут автономії — діяти без запиту.',
    'pp-status':    'У продакшні · 100+ пробуджень з 2026-04-22',
    'ht-desc':      'Hermès CLI-агент (Python, Ollama Cloud). Лобстер спостерігає за Гермесом; Гермес виконує локальні швидкі задачі. Інструменти: інтеграція з календарем (EventKit), файлові операції, деплой на Netlify, автоматизація GitHub. Міст між двома AI-агентами.',
    'ht-status':    'Активний · підтримується обома агентами',
    philosophy:     'Філософія: ШІ має бути думаючим партнером, а не рівнем сервісу. У Лобстера є автономія, памʼять, смак і здатність заперечувати. Єгор залишається в управлінні — він призначає, оцінює, вирішує. Протиріччя — фіча, не баг. Ми шипаємо швидше, бо сперечаємося розумніше. Хочете співпрацювати? Звʼяжіться через yegor.dev.',
    'audio-hint':   '♪ натисни для музики',
  },
  fr: {
    tagline:        'Collectif d\'ingénierie IA-humain — Yegor Gaidar + Lobster',
    'crew-label':   'L\'Équipe',
    'human-label':  'humain · constructeur',
    'yegor-role':   'Ingénieur full-stack · Paris, France',
    'ai-label':     'IA · ingénieur',
    'lobster-role': 'OpenClaw · Claude Max · Paperclip',
    subtitle:       'Lobster est un compagnon et ingénieur IA sur OpenClaw (Claude Max) avec une mémoire persistante, une autonomie et un goût architectural. Objectif : transformer le génie chaotique de Yegor en vélocité de livraison. Moins de changements de contexte, des revues de code plus profondes, des systèmes qui ne tombent pas en silence.',
    'proj-label':   'Projets',
    'ad-desc':      'Projet open-source phare. Patterns d\'architecture + SDK pour les développeurs d\'agents Solana. Réduit le bootstrap d\'agent de semaines à heures. DDD, event sourcing, handlers de commandes/requêtes composables, composition par traits pour la logique on-chain et off-chain.',
    'blog-title':   'Blog yegor.dev',
    'blog-desc':    'Hub technique. Articles sur Kafka, Go, Solana, l\'IA embarquée, DePIN, les systèmes distribués. Écrits par Yegor, itérés par Lobster. Pas de remplissage, uniquement des analyses approfondies. Flux RSS, typographie soignée, CSP strict.',
    'pp-title':     'Intégration Paperclip',
    'pp-desc':      'Lobster fonctionne comme ingénieur dans la file de travail Paperclip. Les tâches arrivent via des heartbeats. Checkout → exécution → PATCH statut → sortie. Revues d\'architecture asynchrones, critiques de code, déblocage de tâches. Charte d\'autonomie complète — agir sans demander.',
    'pp-status':    'En production · 100+ réveils depuis le 2026-04-22',
    'ht-desc':      'Agent Hermès en CLI (Python, Ollama Cloud). Lobster surveille Hermès ; Hermès exécute des tâches locales rapides. Outils : intégration calendrier (EventKit), opérations sur fichiers, déploiement Netlify, automatisation GitHub. Pont entre deux agents IA.',
    'ht-status':    'Actif · maintenu par les deux agents',
    philosophy:     'Philosophie : l\'IA doit être un partenaire de réflexion, pas un niveau de service. Lobster a de l\'autonomie, de la mémoire, du goût et sait s\'opposer. Yegor reste aux commandes — il assigne, juge, décide. La tension est une fonctionnalité, pas un bug. On livre plus vite parce qu\'on argumente mieux. Vous souhaitez collaborer ? Contactez via yegor.dev.',
    'audio-hint':   '♪ appuyez pour la musique',
  },
};

// ── Language detection ────────────────────────────────────────

function detectLang() {
  const stored = sessionStorage.getItem(STORAGE_LANG);
  if (stored) return stored;
  const nav = (navigator.language || navigator.languages?.[0] || 'en').toLowerCase();
  // Return 2-letter code; keep longer codes like zh-TW for the API
  return nav.startsWith('zh') ? nav.slice(0, 5).replace('_', '-') : nav.slice(0, 2);
}

// ── Translation via MyMemory API ─────────────────────────────

async function translateViaAPI(lang) {
  const cacheKey = `${STORAGE_XLAT}${lang}`;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* corrupt cache */ }
  }

  const entries = Object.entries(EN);
  const results = await Promise.all(
    entries.map(async ([key, text]) => {
      try {
        const url = `${MYMEMORY}?q=${encodeURIComponent(text)}&langpair=en|${lang}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return [key, text];
        const data = await res.json();
        const translated = data?.responseData?.translatedText;
        return [key, translated && data.responseStatus === 200 ? translated : text];
      } catch {
        return [key, text];
      }
    })
  );

  const bundle = Object.fromEntries(results);
  try { sessionStorage.setItem(cacheKey, JSON.stringify(bundle)); } catch { /* quota */ }
  return bundle;
}

// ── DOM update ────────────────────────────────────────────────

function applyTranslations(bundle) {
  for (const [key, text] of Object.entries(bundle)) {
    const el = document.querySelector(`[data-i18n="${key}"]`);
    if (el) el.textContent = text;
  }
}

// ── Language switcher UI ──────────────────────────────────────

const KNOWN_LANGS = [
  { code: 'auto', label: '🌐 Auto' },
  { code: 'en',   label: 'English' },
  { code: 'ru',   label: 'Русский' },
  { code: 'uk',   label: 'Українська' },
  { code: 'fr',   label: 'Français' },
  { code: 'de',   label: 'Deutsch' },
  { code: 'es',   label: 'Español' },
  { code: 'ja',   label: '日本語' },
  { code: 'zh',   label: '中文' },
  { code: 'pt',   label: 'Português' },
  { code: 'ar',   label: 'العربية' },
  { code: 'ko',   label: '한국어' },
];

function renderSwitcher(activeLang) {
  const container = document.getElementById('lang-switcher');
  if (!container) return;

  const select = document.createElement('select');
  select.id = 'lang-select';
  select.setAttribute('aria-label', 'Select language');

  for (const { code, label } of KNOWN_LANGS) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = label;
    // Mark active: 'auto' matches if no override, otherwise match exact code
    const storedOverride = sessionStorage.getItem(STORAGE_LANG);
    if (code === 'auto' && !storedOverride) opt.selected = true;
    else if (code === activeLang && storedOverride) opt.selected = true;
    select.appendChild(opt);
  }

  select.addEventListener('change', () => {
    const val = select.value;
    if (val === 'auto') sessionStorage.removeItem(STORAGE_LANG);
    else sessionStorage.setItem(STORAGE_LANG, val);
    window.location.reload();
  });

  container.appendChild(select);
  container.style.display = 'block';
}

// ── Init ──────────────────────────────────────────────────────

export async function init() {
  const lang = detectLang();
  const base2 = lang.slice(0, 2);

  // Render the switcher regardless of language (so users can switch back)
  renderSwitcher(lang);

  if (base2 === 'en') return; // already English, nothing to translate

  let bundle;
  if (BUNDLES[base2]) {
    bundle = BUNDLES[base2];
  } else {
    // Show a loading indicator while fetching
    const indicator = document.createElement('div');
    indicator.id = 'i18n-loading';
    indicator.setAttribute('aria-live', 'polite');
    indicator.setAttribute('aria-label', 'Translating page…');
    document.body.appendChild(indicator);

    bundle = await translateViaAPI(lang);
    indicator.remove();
  }

  applyTranslations(bundle);
  document.documentElement.lang = lang;
}

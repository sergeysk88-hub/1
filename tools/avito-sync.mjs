// Привязывает профиль Авито к сайту: вписывает в index.html отзывы, рейтинг, объявления
// с ценами и контакты из официального API Авито.
//
// Запуск из корня проекта (Node.js 20.6+):
//   node --env-file=.env tools/avito-sync.mjs            — обновить index.html
//   node --env-file=.env tools/avito-sync.mjs --dry-run  — только показать, что изменится
// Файл .env (в git и на хостинг его не кладите — он в .gitignore):
//   AVITO_CLIENT_ID=...
//   AVITO_CLIENT_SECRET=...
// Ключи выдаются в личном кабинете Авито: https://www.avito.ru/professionals/api
//
// Что обновляется:
//  • отзывы с ответами на них — между метками <!-- avito:reviews --> и <!-- /avito:reviews -->,
//    рейтинг — между <!-- avito:rating -->, список всех объявлений с ценами — между <!-- avito:items -->;
//  • цены в карточках услуг: карточка сама привязывается к объявлению с тем же названием
//    (в ценник записывается data-avito-item="номер"), дальше меняется число перед «₽».
//    Номер можно поставить и вручную, а data-avito-item="нет" запрещает привязку карточки;
//  • контакты — пустые phone, avito и address в site-config, телефон, адрес и ссылка
//    на профиль в микроразметке JSON-LD (вписанное вручную не трогается — см. OVERWRITE_CONTACTS).
//
// Браузер посетителя к Авито не обращается: данные вписываются в HTML заранее,
// поэтому ключи не попадают на сайт, а CSP (connect-src 'none') остаётся строгой.
// Если запрос к какому-то разделу не удался, этот блок сайта остаётся прежним.
// Описаний и фото объявлений в API Авито нет — их на сайте нужно вести вручную.
import { readFileSync, writeFileSync } from 'node:fs';

// ✏️ Настройки
const MAX_REVIEWS = 30;           // сколько отзывов показать (остальные — по кнопке «Все отзывы на Авито»)
const MIN_SCORE = 4;              // отзывы с оценкой ниже не показываются (1 — показывать все)
const MIN_TEXT = 15;              // отзывы без текста или короче — пропускаются
const MAX_TEXT = 360;             // длинный текст отзыва обрезается (чтобы карточки не растягивались)
const SHOW_ANSWERS = true;        // показывать опубликованные ответы на отзывы
const ANSWER_TITLE = 'Ответ Цырены';
const AUTO_LINK = true;           // привязывать карточки услуг к объявлениям с тем же названием
const OVERWRITE_CONTACTS = false; // true — телефон, ссылка и адрес с Авито заменяют вписанные вручную

const API = 'https://api.avito.ru';
const file = new URL('../index.html', import.meta.url);
const DRY = process.argv.includes('--dry-run');
const GH = Boolean(process.env.GITHUB_ACTIONS);

let warnings = 0;
const warn = msg => { warnings++; console.warn(GH ? `::warning::${msg}` : `⚠️  ${msg}`); };
const fail = msg => { console.error(GH ? `::error::${msg}` : `Ошибка: ${msg}`); process.exit(1); };

/* ---------- Текст ---------- */
// Управляющие, невидимые и «переворачивающие» текст символы (соединитель U+200D в эмодзи оставляем)
const JUNK = /[\u0000-\u0008\u000B-\u001F\u007F\u00AD\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const clean = (v, max) => {
  const s = (typeof v === 'string' || typeof v === 'number' ? String(v) : '').replace(JUNK, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, max).join('').replace(/\s+\S*$/, '').replace(/[\s,.;:–—-]+$/, '') + '…';
};
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);
const UNESC = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };
const unesc = s => String(s).replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => UNESC[e]);

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const monthYear = ts => {
  const d = new Date(Number(ts) * 1000 + 3 * 3600e3); // по Москве
  return Number(ts) > 0 && Number.isFinite(d.getTime()) ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : '';
};
const plural = (n, [one, few, many]) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many;
const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
const fmtPrice = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

// Номер объявления: «4123456789» или ссылка …/botoks_4123456789?context=…
const itemId = ref => (String(ref).replace(/[?#].*$/, '').match(/(\d{6,})\D*$/) || [])[1] || '';
const optedOut = ref => /^\s*(нет|no|-)\s*$/i.test(String(ref));
const normPhone = v => {
  const d = String(v || '').replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7');
  return /^7[3489]\d{9}$/.test(d) ? d : '';
};
const avitoUrl = (v, keepQuery) => {
  let s = clean(v, 500).replace(/^http:\/\//i, 'https://');
  if (!keepQuery) s = s.replace(/[?#].*$/, '');
  return /^https:\/\/(?:www\.|m\.)?avito\.ru\/[A-Za-z0-9_\-./?=&%]+$/.test(s) ? s : '';
};

// HTML-комментарии прячем, чтобы примеры в них не приняли за настоящую разметку
const withoutComments = (html, fn) => {
  const saved = [];
  const masked = html.replace(/<!--[\s\S]*?-->/g, m => `\u0000${saved.push(m) - 1}\u0000`);
  return fn(masked).replace(/\u0000(\d+)\u0000/g, (_, i) => saved[i]);
};

/* ---------- API Авито ---------- */
async function request(path, { token, method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(API + path, { method, headers, body, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  try { return JSON.parse(text); } catch { throw new Error('ответ не в формате JSON'); }
}

const explain = err =>
  err.status === 403 ? 'нет доступа к этому разделу API (проверьте тариф и права приложения в кабинете Авито)'
    : err.status === 429 ? 'Авито ограничил частоту запросов — повторите позже'
      : err.name === 'TimeoutError' ? 'Авито не ответил за 20 секунд'
        : err.message === 'fetch failed' ? `нет связи с api.avito.ru (${(err.cause && err.cause.code) || 'сеть недоступна'})`
          : err.message;

async function fetchReviews(token) {
  const out = [];
  for (let offset = 0, page = 0; page < 20 && out.length < MAX_REVIEWS; page++) {
    const data = await request(`/ratings/v1/reviews?offset=${offset}&limit=50`, { token });
    const list = Array.isArray(data && data.reviews) ? data.reviews : [];
    out.push(...list.filter(r => r && Number(r.score) >= MIN_SCORE && Array.from(clean(r.text, 1e4)).length >= MIN_TEXT));
    offset += list.length;
    if (!list.length || offset >= Number(data.total || 0)) break;
  }
  return out.slice(0, MAX_REVIEWS);
}

async function fetchItems(token) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const data = await request(`/core/v1/items?status=active&per_page=50&page=${page}`, { token });
    const list = Array.isArray(data && data.resources) ? data.resources : [];
    out.push(...list.filter(it => it && itemId(it.id)));
    if (list.length < 50) break;
  }
  // Порядок от API может меняться — сортируем, чтобы без изменений на Авито не менялся и сайт
  return out.sort((a, b) => clean(a.title, 200).localeCompare(clean(b.title, 200), 'ru') || String(a.id).localeCompare(String(b.id)));
}

/* ---------- Обновление index.html ---------- */
function region(html, name, inner) {
  const re = new RegExp(`(<!-- avito:${name}\\b[^>]*-->)[\\s\\S]*?(\\n[ \\t]*<!-- /avito:${name} -->)`);
  if (!re.test(html)) { warn(`метки avito:${name} не найдены — блок не обновлён`); return html; }
  return html.replace(re, (m, open, close) => open + (inner ? '\n' + inner : '') + close);
}

const CARD = /<article class="card">[\s\S]*?<\/article>/g;
const cardInfo = card => {
  const title = card.match(/class="card__title">([^<]*)</);
  const ref = card.match(/\bdata-avito-item="([^"]*)"/);
  return { title: title ? unesc(title[1]).trim() : '', ref: ref ? ref[1] : null };
};

// Номер объявления → название процедуры в карточке, к которой оно привязано
function cardTitles(html) {
  const titles = new Map();
  for (const [card] of html.replace(/<!--[\s\S]*?-->/g, '').matchAll(CARD)) {
    const { title, ref } = cardInfo(card);
    if (title && ref && itemId(ref)) titles.set(itemId(ref), title);
  }
  return titles;
}

// Совпадение названий без учёта регистра, знаков и окончаний:
// «Химические пилинги» ↔ «Пилинг химический», «Контурная пластика губ» ↔ «Контурная пластика губ, гиалурон»
const norm = s => unesc(String(s)).toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim();
const words = s => norm(s).split(' ').filter(w => w.length >= 3);
const stem = w => (w.length <= 4 ? w.slice(0, 3) : w.slice(0, Math.max(4, w.length - 2)));
const sameWord = (a, b) => b.startsWith(stem(a)) || a.startsWith(stem(b));
const titleFits = (card, ad) => {
  const cw = words(card);
  const aw = words(ad);
  return cw.length > 0 && cw.every(c => aw.some(a => sameWord(c, a)));
};

// Карточка привязывается, только если ей подходит ровно одно объявление и это объявление
// не подходит другим карточкам (точное совпадение названия важнее частичного)
function autoLink(html, items, report) {
  const cards = [...html.replace(/<!--[\s\S]*?-->/g, '').matchAll(CARD)].map(([card]) => cardInfo(card));
  const taken = new Set(cards.filter(c => c.ref !== null).map(c => itemId(c.ref)).filter(Boolean));
  const free = items.filter(it => !taken.has(String(it.id)));
  const candidates = new Map();
  for (const c of cards) {
    if (c.ref !== null || !c.title) continue;
    const exact = free.filter(it => norm(it.title) === norm(c.title));
    const list = exact.length ? exact : free.filter(it => titleFits(c.title, it.title));
    if (list.length) candidates.set(c.title, list);
  }
  const claims = new Map();
  for (const list of candidates.values()) if (list.length === 1) claims.set(String(list[0].id), (claims.get(String(list[0].id)) || 0) + 1);
  const links = new Map();
  for (const [title, list] of candidates) {
    if (list.length === 1 && claims.get(String(list[0].id)) === 1) links.set(title, list[0]);
    else console.log(`  «${title}»: подходят несколько объявлений (${list.map(it => it.id).join(', ')}) — укажите нужное в data-avito-item`);
  }
  if (!links.size) return html;
  return withoutComments(html, masked => masked.replace(CARD, card => {
    const { title, ref } = cardInfo(card);
    const it = ref === null && links.get(title);
    if (!it || !/<p class="price"/.test(card)) return card;
    report.push(`карточка «${title}» привязана к объявлению ${it.id} «${clean(it.title, 60)}»`);
    return card.replace(/<p class="price"/, `<p class="price" data-avito-item="${esc(String(it.id))}"`);
  }));
}

function reviewHtml(r, titles) {
  const score = Math.min(5, Math.max(1, Math.round(Number(r.score)) || 5));
  // Только имя, без фамилии
  const name = clean(clean(r.sender && r.sender.name, 60).split(' ')[0], 30) || 'Клиент Авито';
  const item = r.item || {};
  const service = titles.get(String(item.id)) || clean(item.title, 48);
  const meta = [service, monthYear(r.createdAt)].filter(Boolean).join(' · ') || 'Отзыв на Авито';
  const a = r.answer;
  const answer = SHOW_ANSWERS && a && (!a.status || a.status === 'published') ? clean(a.text, MAX_TEXT) : '';
  return [
    '          <article class="review">',
    '            <div class="review__quote" aria-hidden="true">“</div>',
    '            <span class="review__src"><svg class="i"><use href="#i-avito"/></svg>Авито</span>',
    `            <div class="stars" role="img" aria-label="Оценка ${score} из 5">${stars(score)}</div>`,
    `            <p class="review__text">${esc(clean(r.text, MAX_TEXT))}</p>`,
    answer && `            <p class="review__answer"><strong>${esc(ANSWER_TITLE)}</strong>${esc(answer)}</p>`,
    `            <div class="review__author"><span class="avatar">${esc(Array.from(name)[0].toUpperCase())}</span><div><strong>${esc(name)}</strong><span>${esc(meta)}</span></div></div>`,
    '          </article>',
  ].filter(Boolean).join('\n');
}

function ratingHtml(info) {
  const r = info && info.isEnabled !== false ? info.rating : null;
  const score = Number(r && r.score);
  const count = Math.round(Number(r && r.reviewsCount));
  if (!(score > 0 && score <= 5 && count > 0)) return '';
  const value = score.toFixed(1).replace('.', ',');
  return `          <p class="reviews__rating"><span class="stars" aria-hidden="true">${stars(Math.round(score))}</span>` +
    `<span><strong>${value}</strong> из 5 · ${count} ${plural(count, ['отзыв', 'отзыва', 'отзывов'])} на Авито</span></p>`;
}

// Все активные объявления — раскрывающийся список под карточками услуг
function itemsHtml(items) {
  const rows = items.map(it => {
    const title = esc(clean(it.title, 120) || 'Объявление ' + it.id);
    const url = avitoUrl(it.url);
    const name = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${title}</a>` : `<span>${title}</span>`;
    const price = Number(it.price) > 0 ? `${fmtPrice(it.price)} ₽` : 'по запросу';
    return `            <li>${name}<strong>${price}</strong></li>`;
  });
  if (!rows.length) return '';
  return [
    '        <details class="avito-list">',
    `          <summary><svg class="i"><use href="#i-avito"/></svg>Все услуги и цены на Авито<span>${rows.length}</span></summary>`,
    '          <ul>',
    ...rows,
    '          </ul>',
    '        </details>',
  ].join('\n');
}

function updatePrices(html, items, titles, report) {
  const byId = new Map(items.map(it => [String(it.id), it]));
  return withoutComments(html, masked => masked.replace(
    /(<([a-z][a-z0-9]*)\b[^>]*?\bdata-avito-item="([^"]*)"[^>]*>)([\s\S]*?)(<\/\2>)/gi,
    (m, open, tag, ref, inner, close) => {
      if (optedOut(ref)) return m;
      const id = itemId(ref);
      if (!id) { warn(`data-avito-item="${ref}" — это не номер и не ссылка объявления`); return m; }
      const label = titles.get(id) || id;
      const item = byId.get(id);
      if (!item) { warn(`${label}: объявление ${id} не найдено среди активных — цена не изменена`); return m; }
      const price = Number(item.price);
      if (!(price > 0)) { warn(`${label}: в объявлении ${id} не указана цена — цена не изменена`); return m; }
      const num = /\d(?:[\d\s]*\d)?(?=\s*(?:&nbsp;)?₽)/;
      const old = inner.match(num);
      if (!old) { warn(`${label}: в ценнике нет числа перед «₽» — цена не изменена`); return m; }
      const next = fmtPrice(price);
      if (old[0] !== next) report.push(`цена «${label}»: ${old[0]} → ${next} ₽`);
      return open + inner.replace(num, next) + close;
    }));
}

// Контакты с Авито: первый подтверждённый телефон, ссылка на профиль, адрес первого объявления с адресом
function contactsFrom(profile, items) {
  const phones = profile ? [profile.phone].concat(Array.isArray(profile.phones) ? profile.phones : []) : [];
  const withAddress = (items || []).find(it => clean(it.address, 200));
  return {
    phone: phones.map(normPhone).find(Boolean) || '',
    avito: avitoUrl(profile && profile.profile_url, true),
    address: withAddress ? clean(withAddress.address, 160) : '',
  };
}

// Блок JSON внутри <script>: «<» мог бы закрыть блок — экранируем; отступы — как в файле
const jsonBlock = obj => '\n  ' + JSON.stringify(obj, null, 2).replace(/</g, '\\u003c').replace(/\n/g, '\n  ') + '\n  ';
function editJson(html, re, label, edit) {
  const m = html.match(re);
  if (!m) { warn(`блок ${label} не найден — не обновлён`); return html; }
  let obj;
  try { obj = JSON.parse(m[2]); } catch (err) { warn(`в ${label} ошибка JSON (${err.message}) — не обновлён`); return html; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { warn(`${label} не является объектом — не обновлён`); return html; }
  return edit(obj) ? html.replace(re, (all, open, body, close) => open + jsonBlock(obj) + close) : html;
}

function updateContacts(html, found, report) {
  const PLACEHOLDER = { address: /Примерная/ };
  return editJson(html, /(<script type="application\/json" id="site-config">)([\s\S]*?)(<\/script>)/, 'site-config', cfg => {
    let changed = false;
    for (const [k, v] of Object.entries(found)) {
      if (!v) continue;
      const cur = typeof cfg[k] === 'string' || typeof cfg[k] === 'number' ? String(cfg[k]).trim() : '';
      const blank = !cur || (PLACEHOLDER[k] && PLACEHOLDER[k].test(cur));
      if ((k === 'phone' ? normPhone(cur) === v : cur === v) || (!blank && !OVERWRITE_CONTACTS)) continue;
      cfg[k] = v;
      changed = true;
      report.push(`site-config ${k}: ${cur || '(пусто)'} → ${v}`);
    }
    return changed;
  });
}

// Микроразметка для поисковиков: телефон и адрес заменяются, если там заглушка; профиль добавляется в sameAs
function updateJsonLd(html, found, report) {
  return editJson(html, /(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/, 'JSON-LD', ld => {
    let changed = false;
    const tel = found.phone && '+' + found.phone;
    if (tel && ld.telephone !== tel && (OVERWRITE_CONTACTS || !normPhone(ld.telephone))) {
      report.push(`JSON-LD telephone: ${ld.telephone || '(пусто)'} → ${tel}`);
      ld.telephone = tel;
      changed = true;
    }
    const addr = ld.address && typeof ld.address === 'object' ? ld.address : {};
    const placeholder = !ld.address || /Примерная/.test(String(addr.streetAddress || '')) || addr.addressLocality === 'Город';
    if (found.address && addr.streetAddress !== found.address && (OVERWRITE_CONTACTS || placeholder)) {
      report.push(`JSON-LD address: ${addr.streetAddress || '(пусто)'} → ${found.address}`);
      ld.address = { '@type': 'PostalAddress', streetAddress: found.address };
      changed = true;
    }
    if (found.avito) {
      const same = Array.isArray(ld.sameAs) ? ld.sameAs : ld.sameAs ? [ld.sameAs] : [];
      if (!same.includes(found.avito)) {
        ld.sameAs = same.filter(u => !/^https:\/\/(?:www\.|m\.)?avito\.ru\//.test(u)).concat(found.avito);
        report.push(`JSON-LD sameAs: + ${found.avito}`);
        changed = true;
      }
    }
    return changed;
  });
}

/* ---------- Запуск ---------- */
if (typeof fetch !== 'function') fail('нужен Node.js 18 или новее');
const id = (process.env.AVITO_CLIENT_ID || '').trim();
const secret = (process.env.AVITO_CLIENT_SECRET || '').trim();
if (!id || !secret) {
  fail('не заданы AVITO_CLIENT_ID и AVITO_CLIENT_SECRET. Создайте файл .env с ними и запустите: ' +
    'node --env-file=.env tools/avito-sync.mjs');
}

let token;
try {
  const auth = await request('/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
  });
  token = auth && auth.access_token;
} catch (err) {
  fail(err.status === 400 || err.status === 401 || err.status === 403
    ? 'Авито не принял ключи — проверьте AVITO_CLIENT_ID и AVITO_CLIENT_SECRET'
    : 'не удалось получить токен Авито: ' + explain(err));
}
if (!token) fail('Авито не вернул токен доступа');

let failed = 0;
const part = async (label, fn) => {
  try { return await fn(); } catch (err) { failed++; warn(`${label}: ${explain(err)} — этот блок сайта не обновлён`); return null; }
};
const profile = await part('профиль', () => request('/core/v1/accounts/self', { token }));
const rating = await part('рейтинг', () => request('/ratings/v1/info', { token }));
const reviews = await part('отзывы', () => fetchReviews(token));
const items = await part('объявления', () => fetchItems(token));
if (failed === 4) fail('ни один раздел API Авито не ответил — index.html не изменён');

const before = readFileSync(file, 'utf8');
let html = before;
const report = [];
const step = (next, line) => { if (next !== html && line) report.push(line); html = next; };

if (items) {
  console.log(`\nАктивные объявления на Авито: ${items.length}`);
  if (AUTO_LINK) html = autoLink(html, items, report);
}
const titles = cardTitles(html);

if (reviews) {
  if (reviews.length) step(region(html, 'reviews', reviews.map(r => reviewHtml(r, titles)).join('\n')), `отзывы: ${reviews.length} шт. (оценка от ${MIN_SCORE}, с текстом)`);
  else warn(`подходящих отзывов нет (нужна оценка от ${MIN_SCORE} и текст) — блок отзывов не изменён`);
}
if (rating) {
  const r = ratingHtml(rating);
  step(region(html, 'rating', r), 'рейтинг: ' + (r ? `${Number(rating.rating.score).toFixed(1)} из 5, отзывов ${rating.rating.reviewsCount}` : 'скрыт (на Авито рейтинга пока нет)'));
}
if (items) {
  html = updatePrices(html, items, titles, report);
  step(region(html, 'items', itemsHtml(items)), `список услуг с Авито: ${items.length} шт.`);
  for (const it of items) {
    const mark = titles.has(String(it.id)) ? `  ✓ «${titles.get(String(it.id))}»` : '';
    console.log(`  ${it.id} · ${Number(it.price) > 0 ? fmtPrice(it.price) + ' ₽' : 'без цены'} · ${clean(it.title, 70)}${mark}`);
  }
}
if (profile || items) {
  const found = contactsFrom(profile, items);
  html = updateContacts(html, found, report);
  html = updateJsonLd(html, found, report);
}

console.log('');
if (html === before) {
  console.log('Изменений нет — index.html уже совпадает с Авито.');
} else {
  report.forEach(line => console.log('• ' + line));
  if (DRY) console.log('\n--dry-run: index.html не изменён.');
  else { writeFileSync(file, html); console.log('\nindex.html обновлён.'); }
}
if (warnings) console.log(`Предупреждений: ${warnings} (см. выше).`);

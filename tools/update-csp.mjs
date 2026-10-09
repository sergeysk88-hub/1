// Пересчитывает sha256-хеши встроенных скриптов index.html и записывает их в CSP.
// Запуск из корня проекта: node tools/update-csp.mjs
// Нужен после любого изменения кода в скриптах с атрибутом data-csp (site-config и JSON-LD хешировать не нужно).
// Хешируются только скрипты с data-csp; любой другой исполняемый <script> — ошибка, а не «добавить в список».
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const EXPECTED = 2;
const file = new URL('../index.html', import.meta.url);
let html = readFileSync(file, 'utf8');
const fail = msg => { console.error('Ошибка: ' + msg); process.exit(1); };

// HTML-комментарии убираем, чтобы слово «script» в них не приняли за тег
const code = html.replace(/<!--[\s\S]*?-->/g, '');

// Блоки данных: корректный JSON и без последовательностей, ломающих разметку
for (const m of code.matchAll(/<script type="application\/(?:ld\+)?json"[^>]*>([\s\S]*?)<\/script>/gi)) {
  if (/<!--|<\/?script/i.test(m[1])) fail('в блоке данных встретилось «<!--» или «<script» — замените знак «<» на \\u003c');
  try { JSON.parse(m[1]); } catch (err) { fail('блок данных не является корректным JSON: ' + err.message); }
}

// Любой <script>, кроме data-csp и блоков данных, — посторонний
const stray = [...code.matchAll(/<script\b([^>]*)>/gi)]
  .filter(m => !/^\s*data-csp\s*$/.test(m[1]) && !/type="application\/(?:ld\+)?json"/i.test(m[1]));
if (stray.length) fail('посторонние теги script: ' + stray.map(m => m[0]).join(' ') + ' — удалите их или проверьте, откуда они взялись');

const blocks = [...code.matchAll(/<script data-csp>([\s\S]*?)<\/script>/g)];
if (blocks.length !== EXPECTED) fail(`ожидалось ${EXPECTED} скрипта с data-csp, найдено ${blocks.length}`);

// Браузер хеширует текст скрипта с переводами строк, приведёнными к \n
const hashes = blocks.map(m =>
  `'sha256-${createHash('sha256').update(m[1].replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`);

const re = /(<meta http-equiv="Content-Security-Policy" content="[^"]*?script-src )[^;"]*/;
if (!re.test(html)) fail('CSP <meta> не найдена');
html = html.replace(re, `$1${hashes.join(' ')}`);
writeFileSync(file, html);
console.log(`script-src ${hashes.join(' ')}`);

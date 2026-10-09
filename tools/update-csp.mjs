// Пересчитывает sha256-хеши встроенных скриптов index.html и записывает их в CSP.
// Запуск из корня проекта: node tools/update-csp.mjs
// Нужен после любого изменения кода внутри <script>…</script> (site-config и JSON-LD хешировать не нужно).
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = new URL('../index.html', import.meta.url);
let html = readFileSync(file, 'utf8');

// Браузер хеширует текст скрипта с переводами строк, приведёнными к \n
// HTML-комментарии убираем, чтобы слово «script» в них не приняли за тег
const code = html.replace(/<!--[\s\S]*?-->/g, '');
const hashes = [...code.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m =>
  `'sha256-${createHash('sha256').update(m[1].replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`);

const re = /(<meta http-equiv="Content-Security-Policy" content="[^"]*?script-src )[^;"]*/;
if (!re.test(html)) { console.error('CSP <meta> не найдена'); process.exit(1); }
html = html.replace(re, `$1${hashes.join(' ')}`);
writeFileSync(file, html);
console.log(`script-src ${hashes.join(' ')}`);

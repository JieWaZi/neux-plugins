import { readFile, writeFile } from 'node:fs/promises';
const template = await readFile(new URL('./templates/setup.mjs', import.meta.url), 'utf8');
for (const [key, business] of Object.entries({ 'feishu-office': 'lark-cli', 'wecom-office': 'wecom-cli', github: '' })) {
  await writeFile(new URL(`../plugins/${key}/setup.mjs`, import.meta.url), template.replace('__BUSINESS_COMMAND__', business));
  await writeFile(new URL(`../plugins/${key}/LICENSE`, import.meta.url), await readFile(new URL('../LICENSE', import.meta.url)));
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateSchema } from '../schema.mjs';

for (const key of ['github', 'feishu-office', 'wecom-office']) {
  test(`${key}: authorization is declared once per real component, independent of CLI`, async () => {
    const manifest = JSON.parse(await readFile(`plugins/${key}/plugin.json`, 'utf8'));
    const extension = manifest.extensions['com.neuxbot'];
    validateSchema('neuxbot-extension.schema.json', extension);
    const bindings = [...extension.authentication.bindings ?? [], ...extension.authentication.skillBindings ?? []];
    assert.ok(bindings.length);
    assert.ok(bindings.every(binding => !Object.hasOwn(binding, 'runtime')));
    assert.equal(new Set(bindings.map(binding => binding.skill ?? binding.server)).size, bindings.length);
    const schema = JSON.parse(await readFile('schemas/neuxbot-extension.schema.json', 'utf8'));
    for (const kind of ['bindings', 'skillBindings']) {
      assert.ok(!schema.properties.authentication.properties[kind].items.required.includes('runtime'));
    }
  });
}

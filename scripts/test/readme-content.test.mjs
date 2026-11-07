import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 插件说明不能重新混入宿主身份、安装步骤或聊天引导；维护说明保留在仓库开发指南。
test('维护包中英文业务说明不包含宿主角色或聊天安装引导', async () => {
  for (const plugin of ['github', 'feishu-office', 'wecom-office']) {
    for (const name of ['README.md', 'README.zh-CN.md']) {
      const file = new URL(`../../plugins/${plugin}/${name}`, import.meta.url);
      const content = await readFile(file, 'utf8');
      assert.doesNotMatch(content, /^\[English\].*\[简体中文\]/mu, `${plugin}/${name}: locale is selected by the host`);
      assert.doesNotMatch(content, /伙伴|\bpartners?\b|NeuxBot|插件库|plugin library|打开对话|在对话中|试着这样说|try asking|\bconversation\b/iu, `${plugin}/${name}`);
    }
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseChallengePresentation, loadChallengePresentation } from '../../plugins/feishu-office/.neuxbot/auth/presentation.mjs';

const value = { schemaVersion: 1, notices: { initialSetup: { messages: { en: 'After setup, scan again to authorize your account.', 'zh-CN': '完成应用设置后，还需再次扫码完成账号与权限授权。' } } } };
const bytes = value => Buffer.from(JSON.stringify(value));

test('包内声明可靠读取中英文提示，消息字节与原声明一致', async () => {
  const raw = await readFile(new URL('../../plugins/feishu-office/.neuxbot/auth/presentation.json', import.meta.url));
  assert.deepEqual(await loadChallengePresentation(), JSON.parse(raw));
  assert.equal(parseChallengePresentation(raw).notices.initialSetup.messages['zh-CN'], '首次扫码完成应用设置后，还需再次扫码完成账号与权限授权。');
  assert.deepEqual(parseChallengePresentation(bytes(value)), value);
});

test('拒绝额外语言、空消息、超过UTF8字节限制及未知执行字段', () => {
  for (const change of [d=>d.notices.initialSetup.messages.fr='Extra',d=>delete d.notices.initialSetup.messages.en,d=>d.notices.initialSetup.messages.en=' ',d=>d.notices.initialSetup.messages['zh-CN']='汉'.repeat(683),d=>d.notices.initialSetup.messages.en='a'.repeat(2049),d=>d.notices.initialSetup.messages.en='a\u0000b',d=>d.command='node',d=>d.notices.initialSetup.url='https://example.com',d=>d.schemaVersion=2]) {
    const copy=structuredClone(value);change(copy);assert.throws(()=>parseChallengePresentation(bytes(copy)),/invalid_auth_presentation/);
  }
  assert.throws(()=>parseChallengePresentation(Buffer.alloc(16*1024+1)),/invalid_auth_presentation/);
  assert.throws(()=>parseChallengePresentation(Buffer.from([0xff])),/invalid_auth_presentation/);
});

test('读取器拒绝符号链接和超限文件，不读取其他文件内容', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'auth-presentation-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const actual=path.join(root,'actual.json'),link=path.join(root,'link.json');await writeFile(actual,bytes(value));await symlink(actual,link);
  await assert.rejects(loadChallengePresentation(link),/invalid_auth_presentation/);
  await writeFile(actual,Buffer.alloc(16*1024+1));await assert.rejects(loadChallengePresentation(actual),/invalid_auth_presentation/);
});

test('通用展示声明接受其他插件自定义的具名提示，不绑定首次设置或供应商', () => {
  const messages = { en: 'An additional approval step is required before this authorization can complete.', 'zh-CN': '完成本次授权前，还需继续完成后续审批步骤。' };
  const declaration = { schemaVersion: 1, notices: { additionalApproval: { messages }, organizationReview: { messages } } };
  assert.deepEqual(parseChallengePresentation(bytes(declaration)), declaration);
  const invalid = structuredClone(declaration);invalid.notices['../invalid']={messages};assert.throws(()=>parseChallengePresentation(bytes(invalid)),/invalid_auth_presentation/);
});

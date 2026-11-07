import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { packageDetails, encodeDetails, maxDetailsBytes } from '../details.mjs';

function fixture() {
  const files = new Map([
    ['plugins/example/README.md', Buffer.from('# Example\nEnglish content.\n')],
    ['plugins/example/README.zh-CN.md', Buffer.from('# 示例\n中文内容。\n')],
    ['plugins/example/skills/example/SKILL.md', Buffer.from('---\nname: example\ndescription: >-\n  First line: includes a colon.\n  Second line.\nmetadata:\n  usage: public build metadata\n---\n\n# Exact skill bytes\n')],
    ['plugins/example/mcp.json', Buffer.from(JSON.stringify({ mcpServers: { remote: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: 'DO_NOT_COPY_HEADER' }, env: { TOKEN: 'DO_NOT_COPY_ENV' }, args: ['DO_NOT_COPY_ARGS'], extension: 'DO_NOT_COPY_EXTENSION' }, local: { type:'stdio', command: 'DO_NOT_COPY_COMMAND', args: ['DO_NOT_COPY_LOCAL_ARGS'] } } }))],
  ]);
  return { files, options: { sourceCommit: 'a'.repeat(40), archiveSHA256: 'b'.repeat(64), packagePath: 'plugins/example', manifest: { $schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'example', version: '0.1.0', description: 'Example', author: { name: 'Maintainer', token: 'DO_NOT_COPY_AUTHOR' }, interface: { displayName: 'Example', private: 'DO_NOT_COPY_INTERFACE' }, extensions: { private: {value:'DO_NOT_COPY_MANIFEST_EXTENSION'},'com.neuxbot': {schemaVersion:1,authentication:{strategy:'plugin-command',protocol:'neuxbot-auth/1',preferredAction:'show-qr',scopes:['read'],command:'DO_NOT_COPY_AUTH_COMMAND',args:['DO_NOT_COPY_AUTH_ARGS'],bindings:[{secret:'DO_NOT_COPY_BINDINGS'}]}} } }, presentation: { displayNames: { en: 'Example', 'zh-CN': '示例' }, icon: 'data:image/png;base64,AAAA' }, provenance: { upstream: { author: 'Original author', tag: 'v1.2.3', commit:'a'.repeat(40),distribution:{mode:'vendored-source'}, repository: 'https://example.com/source', license: 'MIT' } }, names: () => [...files.keys()], has: name => files.has(name), read: name => { assert.ok(files.has(name), name); return files.get(name); } } };
}

test('侧车绑定固定归档，保持双语README与完整SKILL原始字节', () => {
  const f = fixture(), d = packageDetails(f.options);
  assert.equal(d.schemaVersion, 1); assert.equal(d.sourceCommit, 'a'.repeat(40)); assert.equal(d.archiveSHA256, 'b'.repeat(64)); assert.equal(d.packagePath, 'plugins/example');
  assert.deepEqual(d.readmes, { en: '# Example\nEnglish content.\n', 'zh-CN': '# 示例\n中文内容。\n' });
  assert.deepEqual(d.package.skills, [{ key: 'skills/example', name: 'example', description: 'First line: includes a colon. Second line.', path: 'skills/example' }]);
  assert.equal(d.skillContents['skills/example'], f.files.get('plugins/example/skills/example/SKILL.md').toString());
  assert.deepEqual(d.package.upstream, f.options.provenance.upstream); assert.equal(d.package.icon, f.options.presentation.icon);
});

test('公开侧车仅投射白名单，不复制执行入口、凭据及未声明扩展', () => {
  const d=packageDetails(fixture().options), pkg=d.package;
  const sidecar=JSON.stringify({ ...d, skillContents: {} });
  assert.doesNotMatch(sidecar, /DO_NOT_COPY/);
  assert.deepEqual(pkg.servers, [{key:'local',type:'stdio'}, {key:'remote',type:'streamable-http',url:'https://example.com/mcp'}]);
  assert.deepEqual(pkg.integration, { authentication: { strategy:'plugin-command',protocol:'neuxbot-auth/1',preferredAction:'show-qr',scopes:['read'] } });
  assert.equal(pkg.readme, undefined); assert.equal(pkg.skills[0].digest, undefined);
});

for (const [label, yaml] of [['重复键','name: one\nname: two\ndescription: Test'],['非法YAML','name: [\ndescription: Test'],['非字符串描述','name: example\ndescription: [one, two]']]) {
  test(`可靠YAML解析拒绝${label}，不发布误解析技能`, () => {
    const f=fixture();f.files.set('plugins/example/skills/example/SKILL.md',Buffer.from(`---\n${yaml}\n---\nBody`));
    assert.throws(()=>packageDetails(f.options),/skill|YAML/i);
  });
}

test('只发现标准固定技能子目录，侧车无完整资源文件副本', () => {
  const f=fixture();
  f.files.set('plugins/example/skills/example/references/secret.md', Buffer.from('DO_NOT_COPY_REFERENCE'));
  f.files.set('plugins/example/custom/other/SKILL.md',Buffer.from('---\nname: other\ndescription: Another skill\n---\nOther bytes'));
  const d=packageDetails(f.options); assert.equal(d.package.skills.length,1);assert.deepEqual(Object.keys(d.skillContents),['skills/example']);
  assert.doesNotMatch(JSON.stringify(d),/DO_NOT_COPY_REFERENCE/);
});

test('拒绝带账号或查询参数的远程服务地址与超限侧车', () => {
  const f=fixture();f.files.set('plugins/example/mcp.json',Buffer.from(JSON.stringify({mcpServers:{a:{type:'streamable-http',url:'https://user:secret@example.com/mcp'},b:{type:'streamable-http',url:'https://example.com/mcp?token=secret'},c:{type:'streamable-http',url:'https://example.com/mcp#token'}}})));
  assert.deepEqual(packageDetails(f.options).package.servers,[{key:'a',type:'streamable-http',url:'https://example.com/mcp'},{key:'b',type:'streamable-http',url:'https://example.com/mcp'},{key:'c',type:'streamable-http',url:'https://example.com/mcp'}]);
  assert.equal(maxDetailsBytes,4*1024*1024);assert.throws(()=>encodeDetails({readmes:{en:'x'.repeat(maxDetailsBytes)}}),/details|size|large/i);
});

// 维护包直接从标准源派生展示，没有第二份人工技能清单。
test('真实维护包标准声明完整生成侧车，飞书和企业微信技能与原文一致', async () => {
  for(const key of ['github','feishu-office','wecom-office']) {
    const packagePath=`plugins/${key}`, root=new URL(`../../${packagePath}/`,import.meta.url), files=new Map();
    async function visit(dir,prefix='') { for(const e of await readdir(dir,{withFileTypes:true})) {const name=prefix+e.name;if(e.isDirectory())await visit(new URL(e.name+'/',dir),name+'/');else files.set(`${packagePath}/${name}`,await readFile(new URL(e.name,dir)));} }
    await visit(root);const manifest=JSON.parse(files.get(`${packagePath}/plugin.json`)); const {catalogPresentation}=await import('../presentation.mjs'); const presentation=catalogPresentation({manifest,packagePath,has:n=>files.has(n),read:n=>files.get(n)});const provenance=JSON.parse(files.get(`${packagePath}/provenance.json`));
    const d=packageDetails({sourceCommit:'a'.repeat(40),archiveSHA256:'b'.repeat(64),packagePath,manifest,presentation,provenance,names:()=>[...files.keys()],has:n=>files.has(n),read:n=>files.get(n)});
    assert.equal(d.package.skills.length,key==='feishu-office'?28:key==='wecom-office'?15:0);assert.equal(d.package.servers.length,key==='github'?1:0);assert.equal(d.readmes.en,files.get(`${packagePath}/README.md`).toString());assert.equal(d.readmes['zh-CN'],files.get(`${packagePath}/README.zh-CN.md`).toString());
    for(const skill of d.package.skills) assert.equal(d.skillContents[skill.key],files.get(`${packagePath}/${skill.path}/SKILL.md`).toString());
    assert.ok(encodeDetails(d).length<maxDetailsBytes);
  }
});


test('来源声明地址含凭据或令牌查询时拒绝生成公开资料', () => {
  for(const url of ['https://user:secret@example.com/source','https://example.com/source?token=secret']) {
    const f=fixture();f.options.provenance.upstream.repository=url;assert.throws(()=>packageDetails(f.options),/public|source|upstream/);
  }
});

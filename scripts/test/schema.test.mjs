import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateStandardPackage } from '../schema.mjs';
const schema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', mcpSchema = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
function fixture(extra = {}, servers) { const manifest = {$schema:schema,name:'example',...extra}, files = new Map(); if (servers) files.set('plugins/example/mcp.json',Buffer.from(JSON.stringify({$schema:mcpSchema,mcpServers:servers}))); return {manifest,files,run(){return validateStandardPackage({manifest,packagePath:'plugins/example',names:()=>[...files.keys()],has:n=>files.has(n),read:n=>{assert.ok(files.has(n),n);return files.get(n)}})}}; }

test('标准纯技能与匿名MCP不要求宿主账号或展示资料',()=>{fixture().run();fixture({}, {remote:{type:'streamable-http',url:'https://example.com/mcp',extensions:{'com.openai':{auth:{type:'none'}}}}}).run()});
test('标准api_key必须有显式required secret精确头绑定',()=>{const server={type:'streamable-http',url:'https://example.com/mcp',extensions:{'com.openai':{auth:{type:'api_key',headerScheme:'bearer'}}}};const f=fixture({extensions:{'com.neuxbot':{schemaVersion:1,configuration:{fields:[{key:'TOKEN',secret:true,required:true}],bindings:[{server:'remote',target:'header',name:'Authorization',value:'Bearer ${TOKEN}'}]}}}},{remote:server});f.run();f.manifest.extensions['com.neuxbot'].configuration.fields[0].required=false;assert.throws(()=>f.run(),/required secret|binding/);assert.throws(()=>fixture({}, {remote:server}).run(),/explicit|binding/)});
test('OAuth/mixed和阶段二management明确unsupported，不降级匿名',()=>{for(const type of ['oauth','mixed'])assert.throws(()=>fixture({}, {remote:{type:'streamable-http',url:'https://example.com/mcp',extensions:{'com.openai':{auth:{type}}}}}).run(),/unsupported MCP authentication/);assert.throws(()=>fixture({extensions:{'com.neuxbot':{schemaVersion:1,management:{}}}}).run(),/unsupported management/)});
test('新授权驱动和技能环境绑定以实际固定技能为准',()=>{const f=fixture({extensions:{'com.neuxbot':{schemaVersion:1,authentication:{strategy:'plugin-command',protocol:'neuxbot-auth/1',command:'node',args:['./.neuxbot/auth.mjs'],skillBindings:[{runtime:'codex',skill:'skills/tool',environmentKeys:['TOOL_HOME','PATH'],privatePathKeys:['TOOL_HOME','PATH']}]}}}});f.files.set('plugins/example/.neuxbot/auth.mjs',Buffer.from('// driver'));f.files.set('plugins/example/skills/tool/SKILL.md',Buffer.from('---\nname: tool\ndescription: Tool\n---\n'));f.run();f.manifest.extensions['com.neuxbot'].authentication.skillBindings[0].environmentKeys.push('HOME');assert.throws(()=>f.run(),/unsafe skill environment/)});
test('提示词翻译错长、旧命名空间、旧manifest和旧wire被拒绝',()=>{const f=fixture({extensions:{'com.openai':{interface:{defaultPrompt:['One']}},'com.neuxbot':{schemaVersion:1,presentation:'.neuxbot/presentation.json'}}});f.files.set('plugins/example/.neuxbot/presentation.json',Buffer.from(JSON.stringify({defaultPromptLocalizations:{'zh-CN':['一','二']}})));assert.throws(()=>f.run(),/length differs/);assert.throws(()=>fixture({extensions:{'com.ally':{}}}).run(),/legacy namespace/);const old=fixture();old.files.set('plugins/example/.codex-plugin/plugin.json',Buffer.from('{}'));assert.throws(()=>old.run(),/legacy/);assert.throws(()=>fixture({extensions:{'com.neuxbot':{schemaVersion:1,authentication:{strategy:'plugin-command',protocol:'neuxally-auth/1',command:'node'}}}}).run(),/neuxbot-extension/)});

test('MCP传输、组件命令与工作目录遵守Core路径边界', () => {
  for (const url of ['http://example.com/mcp', 'https://user:secret@example.com/mcp', 'https://example.com/mcp#token']) {
    assert.throws(() => fixture({}, { remote: { type: 'streamable-http', url } }).run(), /transport boundary/);
  }
  fixture({}, { remote: { type: 'streamable-http', url: 'http://127.0.0.1:9000/mcp' } }).run();
  for (const command of ['node --eval', '../escape', '${COMMAND}', '/usr/bin/node']) {
    assert.throws(() => fixture({}, { local: { type: 'stdio', command } }).run(), /command|component path/);
  }
  const local = fixture({}, { local: { type: 'stdio', command: './bin/tool', cwd: './assets' } });
  local.files.set('plugins/example/bin/tool', Buffer.from('tool'));
  assert.throws(() => local.run(), /working directory/);
  local.files.set('plugins/example/assets/resource.json', Buffer.from('{}'));
  local.run();
  assert.throws(() => fixture({}, { local: { type: 'stdio', command: 'node', cwd: '${PLUGIN_DATA}/../escape' } }).run(), /persistent MCP cwd/);
  assert.throws(() => fixture({}, { remote: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { 'X-Token': 'value\r\ninjected' } } }).run(), /HTTP header/);
});


test('官方interface明暗字段必须为独立字符串，拒绝自造theme对象', () => {
  for (const key of ['logo', 'logoDark', 'composerIcon', 'composerIconDark', 'brandColor', 'brandColorDark']) {
    assert.throws(() => fixture({ extensions: { 'com.openai': { interface: { [key]: { default: './assets/icon.png', dark: './assets/icon-dark.png' } } } } }).run(), /openai-plugin/);
  }
  fixture({ extensions: { 'com.openai': { interface: { logo: './assets/icon.png', logoDark: './assets/icon-dark.png', composerIcon: './assets/icon.png', composerIconDark: './assets/icon-dark.png', brandColor: '#123456', brandColorDark: '#abcdef' } } } }).run();
});

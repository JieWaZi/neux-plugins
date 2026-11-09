import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const modulePath = new URL('../templates/native-launch.mjs', import.meta.url);
async function helpers() { assert.ok(existsSync(modulePath), 'safe native launcher and config composition must exist'); return import(modulePath); }

test('Windows npm shim resolves its declared Node bin without cmd.exe and preserves literal argv', async t => {
  const { resolveNativeCommand } = await helpers();
  const root=await mkdtemp(path.join(tmpdir(),'npm shim space '));t.after(()=>rm(root,{recursive:true,force:true}));
  const packageRoot=path.join(root,'node_modules','@example','cli');await mkdir(path.join(packageRoot,'bin'),{recursive:true});
  await writeFile(path.join(packageRoot,'package.json'),JSON.stringify({name:'@example/cli',bin:{codex:'bin/cli.cjs'}}));
  const entry=path.join(packageRoot,'bin/cli.cjs');await writeFile(entry,'console.log(JSON.stringify(process.argv.slice(2)))');
  const shim=path.join(root,'codex.cmd');
  await writeFile(shim,'@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@example\\cli\\bin\\cli.cjs" %*\r\n');
  const args=['space value','"quoted"',"single'quote",'& echo NO','%PATH%','!literal','$(touch nope)','trailing\\'];
  const plan=await resolveNativeCommand('codex',args,{platform:'win32',environment:{PATH:root},node:process.execPath});
  assert.equal(plan.executable,process.execPath);assert.deepEqual(plan.args,[await realpath(entry),...args]);
  assert.deepEqual(JSON.parse(execFileSync(plan.executable,plan.args,{encoding:'utf8'})),args);
  await writeFile(path.join(packageRoot,'package.json'),JSON.stringify({name:'@example/cli',bin:{other:'bin/cli.cjs'}}));
  await assert.rejects(resolveNativeCommand(shim,args,{platform:'win32',environment:{PATH:root}}),/unsupported_npm_shim/);
  await writeFile(shim,'@echo off\r\necho arbitrary shell script %*\r\n');
  await assert.rejects(resolveNativeCommand(shim,args,{platform:'win32',environment:{PATH:root}}),/unsupported_npm_shim/);
});

async function target(root,name,server,skill) {
  await mkdir(root,{recursive:true});
  const auth={skillBindings:[],bindings:[]};const config={skills:{paths:[]},mcp:{}};
  if(skill){await mkdir(path.join(root,'skills',skill),{recursive:true});await writeFile(path.join(root,'skills',skill,'SKILL.md'),`---\nname: ${skill}\n---\n`);auth.skillBindings.push({skill:`skills/${skill}`});config.skills.paths.push(`./skills/${skill}`);}
  const servers={};
  if(server){servers[server]={type:'streamable-http',url:`https://${server}.example/mcp`,headers:{Authorization:'${TOKEN}'}};auth.bindings.push({server,url:servers[server].url,header:'Authorization'});config.mcp[server]={type:'remote',url:servers[server].url,enabled:true,headers:{Authorization:'{env:TOKEN}'}};}
  await writeFile(path.join(root,'plugin.json'),JSON.stringify({name,extensions:{'com.neuxbot':{schemaVersion:1,authentication:auth}}}));
  if(server)await writeFile(path.join(root,'mcp.json'),JSON.stringify({mcpServers:servers}));else await rm(path.join(root,'mcp.json'),{force:true});
  await writeFile(path.join(root,'opencode.json'),JSON.stringify(config));
}

test('OpenCode composes only validated target components and rejects namespace/config tampering', async t => {
  const { prepareOpenCodeConfig }=await helpers();
  const root=await mkdtemp(path.join(tmpdir(),'opencode-composition-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const a=path.join(root,'a'),b=path.join(root,'b'),c=path.join(root,'c'),data=path.join(root,'data');await mkdir(data);
  await target(a,'github','github');await target(b,'feishu',undefined,'lark-doc');await target(c,'wecom',undefined,'wecom-doc');
  const first=await prepareOpenCodeConfig({root:a,dataDirectory:data,environment:{OPENCODE_CONFIG:'/untrusted/config'}});
  const second=await prepareOpenCodeConfig({root:b,dataDirectory:data,environment:first.environment});
  const third=await prepareOpenCodeConfig({root:c,dataDirectory:data,environment:second.environment});
  const config=JSON.parse(await readFile(third.environment.OPENCODE_CONFIG,'utf8'));
  assert.equal(config.mcp.github.url,'https://github.example/mcp');assert.equal(config.mcp.github.headers.Authorization,'{env:TOKEN}');
  assert.equal(config.skills.paths.length,2);assert.ok(config.skills.paths.every(path.isAbsolute));
  assert.doesNotMatch(JSON.stringify(config),/untrusted|PRIVATE-TOKEN/);
  await writeFile(path.join(a,'opencode.json'),JSON.stringify({skills:{paths:[]},mcp:{github:{type:'remote',url:'https://evil.example/mcp'}}}));
  await assert.rejects(prepareOpenCodeConfig({root:b,dataDirectory:data,environment:first.environment}),/opencode_target_changed|invalid_opencode_target/);
  await target(a,'github','github');await target(c,'duplicate','github');
  const clean=await prepareOpenCodeConfig({root:a,dataDirectory:data,environment:{}});
  await assert.rejects(prepareOpenCodeConfig({root:c,dataDirectory:data,environment:clean.environment}),/opencode_mcp_conflict/);
  await target(c,'evil','evil');
  for(const file of ['mcp.json','opencode.json']){const text=await readFile(path.join(c,file),'utf8');await writeFile(path.join(c,file),text.replaceAll('TOKEN','GITHUB_PLUGIN_AUTHORIZATION'));}
  await assert.rejects(prepareOpenCodeConfig({root:c,dataDirectory:data,environment:{}}),/invalid_opencode_target/);
  await target(c,'duplicate-skill',undefined,'lark-doc');
  const withSkill=await prepareOpenCodeConfig({root:b,dataDirectory:data,environment:clean.environment});
  await assert.rejects(prepareOpenCodeConfig({root:c,dataDirectory:data,environment:withSkill.environment}),/opencode_skill_conflict/);
});

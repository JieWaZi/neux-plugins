import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, chmod, rm, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function fixture(t, key) {
  const directory = await mkdtemp(path.join(tmpdir(), 'native-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'package');
  await cp(`plugins/${key}`, root, { recursive: true });
  const data = path.join(directory, 'native-private');
  const manifest = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8'));
  const scopes = key === 'feishu-office' ? ['offline_access', 'docx:document'] : key === 'github' ? ['repo', 'read:org', 'gist'] : [];
  manifest.extensions['com.neuxbot'].authentication.scopes = scopes;
  await writeFile(path.join(root, 'plugin.json'), JSON.stringify(manifest));
  const binary = path.join(directory, 'supplier');
  const script = key === 'github' ? `
const p=process.env.GH_CONFIG_DIR;fs.mkdirSync(p,{recursive:true});
if(args[0]==='--version')console.log('gh version 2.102.0-neuxally.1');
else if(args[1]==='login'){console.error('! First copy your one-time code: ABCD-EFGH');console.error('Open this URL to continue in your web browser: https://github.com/login/device');fs.writeFileSync(path.join(p,'hosts.yml'),'private');}
else if(args[1]==='status')console.log(JSON.stringify({hosts:{'github.com':[{active:true,host:'github.com',state:'success',login:'example-user',tokenSource:path.join(p,'hosts.yml'),scopes:'repo, read:org, gist'}]}}));
else if(args[1]==='token')console.log('gho_'+'A'.repeat(36));else process.exit(91);` : key === 'feishu-office' ? `
const p=process.env.LARKSUITE_CLI_CONFIG_DIR;fs.mkdirSync(p,{recursive:true});
if(args[0]==='config'){console.error('https://open.feishu.cn/page/cli?user_code=APP-TEST');fs.writeFileSync(path.join(p,'config.json'),'{}');}
else if(args[1]==='status')console.log(JSON.stringify({appId:'app-test',identities:{user:{available:fs.existsSync(path.join(p,'ready')),verified:true,openId:'user-test',userName:'Example',scope:'offline_access docx:document'}}}));
else if(args.includes('--no-wait'))console.log(JSON.stringify({verification_url:'https://open.feishu.cn/auth/device?code=TEST',device_code:'PRIVATE',expires_in:600}));
else if(args.includes('--device-code')){fs.writeFileSync(path.join(p,'ready'),'yes');console.log(JSON.stringify({event:'authorization_complete',missing:[]}));}
else if(args[1]==='logout')fs.rmSync(path.join(p,'ready'),{force:true});
else if(args[0]==='probe')console.log(JSON.stringify({profile:p,foreign:process.env.LARKSUITE_CLI_ACCESS_TOKEN,args:args.slice(1)}));else process.exit(92);` : `
const p=process.env.WECOM_CLI_CONFIG_DIR;fs.mkdirSync(p,{recursive:true});const flag=path.join(p,'credentials.enc');
if(args[0]==='auth'&&args[1]==='show'){if(args.includes('--status'))console.log(fs.existsSync(flag)?'authorized':'unauthorized');else console.log('Status: authorized\\nBot ID: example-bot');}
else if(args[0]==='auth'&&args[1]==='init'){console.log('https://work.weixin.qq.com/ai/qc/gen?source=wecom_cli_external&scode=TEST');const q=args[args.indexOf('--output-qrcode')+1];fs.writeFileSync(q,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==','base64'));console.log('二维码已保存到: '+q);fs.writeFileSync(flag,'private');}
else if(args[0]==='identity')console.log(JSON.stringify({verified:true}));
else if(args[0]==='probe')console.log(JSON.stringify({profile:p,foreign:process.env.WECOM_CLI_ACCESS_TOKEN,args:args.slice(1)}));else process.exit(93);`;
  await writeFile(binary, `#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2);\n${script}`);
  await chmod(binary, 0o755);
  if (key === 'github') { const lockFile=path.join(root,'.neuxbot/auth/assets.lock.json'); const lock=JSON.parse(await readFile(lockFile,'utf8'));lock.version='2.102.0-neuxally.1';await writeFile(lockFile,JSON.stringify(lock)); }
  const env = { ...process.env, [`NEUXALLY_${key === 'github' ? 'GH' : key === 'feishu-office' ? 'LARK' : 'WECOM'}_CLI`]: binary, LARKSUITE_CLI_ACCESS_TOKEN: 'FOREIGN-SECRET', WECOM_CLI_ACCESS_TOKEN:'FOREIGN-SECRET', NEUXBOT_CORE_URL: 'http://127.0.0.1:1' };
  const run = (args, profile = 'codex', extraEnv = {}) => new Promise((resolve, reject) => {
    const child=spawn(process.execPath,[path.join(root,'setup.mjs'),'--profile',profile,'--data',data,...args],{env:{...env,...extraEnv},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });
  return { run, data, root, env };
}

for(const key of ['feishu-office','wecom-office','github']) {
  test(`${key}: native setup uses the real vendor bridge and private verified launch material without Core`, async t => {
    const f=await fixture(t,key);
    const logged=await f.run(['login']);assert.equal(logged.code,0,logged.stderr);assert.equal(JSON.parse(logged.stdout).state,'authorized');
    assert.doesNotMatch(logged.stdout+logged.stderr,/FOREIGN-SECRET|gho_|PRIVATE/);
    assert.match(logged.stderr,/https:\/\//);
    let result;
    if(key==='github') {
      const childScript=path.join(f.root,'probe.mjs');await writeFile(childScript,`console.log(JSON.stringify({auth:process.env.GITHUB_PLUGIN_AUTHORIZATION?.startsWith('Bearer gho_'),core:process.env.NEUXBOT_CORE_URL}));`);
      result=await f.run(['run','--',process.execPath,childScript]);
      assert.equal(result.code,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{auth:true});
      const mcp=JSON.parse(await readFile(path.join(f.root,'mcp.json'),'utf8'));assert.equal(mcp.mcpServers.github.headers.Authorization,'${GITHUB_PLUGIN_AUTHORIZATION}');
    } else {
      result=await f.run(['exec','--','probe','space value',"quote'value"]);assert.equal(result.code,0,result.stderr);
      assert.deepEqual(JSON.parse(result.stdout),{profile:path.join(f.data,'profile'),args:['space value',"quote'value"]});
    }
    assert.doesNotMatch(result.stderr,/gho_|FOREIGN-SECRET/);
    const logout=await f.run(['logout']);assert.equal(logout.code,0,logout.stderr);
    const denied=await f.run(key==='github'?['run','--',process.execPath,'--version']:['exec','--','probe']);assert.notEqual(denied.code,0);assert.match(denied.stderr,/authorization_required/);
  });
}


test('OpenCode launcher selects the target config and propagates the actual CLI exit code', async t => {
  const f=await fixture(t,'github');
  assert.equal((await f.run(['login'])).code,0);
  const probe=path.join(f.root,'opencode-probe.cjs');
  await writeFile(probe,`const fs=require('node:fs');console.log(JSON.stringify({config:process.env.OPENCODE_CONFIG,body:JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG,'utf8'))}));process.exitCode=7;`);
  const missing=await f.run(['run','--',process.execPath,probe],'opencode');
  assert.notEqual(missing.code,0);assert.match(missing.stderr,/missing_opencode_target_config/);
  await writeOpenCodeConfig(f);
  const result=await f.run(['run','--',process.execPath,probe],'opencode');
  assert.equal(result.code,7,result.stderr);
  const output=JSON.parse(result.stdout);assert.equal(output.body.mcp.github.url,'https://api.githubcopilot.com/mcp/');
  assert.match(output.config,/opencode-run-/);await assert.rejects(readFile(output.config),{code:'ENOENT'});
});

async function writeOpenCodeConfig(f) {
  const manifest=JSON.parse(await readFile(path.join(f.root,'plugin.json'),'utf8'));
  const config={skills:{paths:(manifest.extensions['com.neuxbot'].authentication.skillBindings??[]).map(binding=>'./'+binding.skill)},mcp:{}};
  if(manifest.name==='github')config.mcp.github={type:'remote',url:'https://api.githubcopilot.com/mcp/',enabled:true,headers:{Authorization:'{env:GITHUB_PLUGIN_AUTHORIZATION}'}};
  await writeFile(path.join(f.root,'opencode.json'),JSON.stringify(config));
}

test('three nested OpenCode setups retain GitHub MCP, both Skill trees and verified business launchers', async t => {
  const github=await fixture(t,'github'),lark=await fixture(t,'feishu-office'),wecom=await fixture(t,'wecom-office');
  for(const f of [github,lark,wecom]){assert.equal((await f.run(['login'])).code,0);await writeOpenCodeConfig(f);}
  const probe=path.join(github.root,'combined-probe.cjs');
  await writeFile(probe,`const fs=require('node:fs'),cp=require('node:child_process');
const config=JSON.parse(fs.readFileSync(process.env.OPENCODE_CONFIG,'utf8'));
const run=name=>JSON.parse(cp.execFileSync(name,['probe','literal & value'],{encoding:'utf8'}));
console.log(JSON.stringify({config,github:process.env.GITHUB_PLUGIN_AUTHORIZATION?.startsWith('Bearer gho_'),lark:run('lark-cli'),wecom:run('wecom-cli')}));`);
  const args=['run','--',process.execPath,path.join(lark.root,'setup.mjs'),'--profile','opencode','--data',lark.data,'run','--',process.execPath,path.join(wecom.root,'setup.mjs'),'--profile','opencode','--data',wecom.data,'run','--',process.execPath,probe];
  const result=await github.run(args,'opencode',{...lark.env,...wecom.env});
  assert.equal(result.code,0,result.stderr);const output=JSON.parse(result.stdout);assert.equal(output.github,true);
  assert.equal(output.config.mcp.github.url,'https://api.githubcopilot.com/mcp/');const expected=[];for(const f of [lark,wecom]){const m=JSON.parse(await readFile(path.join(f.root,'plugin.json'),'utf8'));for(const binding of m.extensions['com.neuxbot'].authentication.skillBindings)expected.push(await realpath(path.join(f.root,binding.skill)));}
  assert.deepEqual(output.config.skills.paths.sort(),expected.sort());
  assert.deepEqual(output.lark.args,['literal & value']);assert.deepEqual(output.wecom.args,['literal & value']);
  assert.equal(await realpath(output.lark.profile),await realpath(path.join(lark.data,'profile')));assert.equal(await realpath(output.wecom.profile),await realpath(path.join(wecom.data,'profile')));
});

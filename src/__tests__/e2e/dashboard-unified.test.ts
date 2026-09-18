import { afterEach, describe, expect, it } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import YAML from 'yaml';

const cli = path.resolve('dist/index.js');
let child: ChildProcess | undefined;
let sandbox = '';
afterEach(async () => {
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; }
  child = undefined;
  if (sandbox) await fs.rm(sandbox, { recursive: true, force: true });
});
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

describe('built dashboard CLI (offline provider fixtures)', () => {
  for (const provider of ['git', 'gitlab', 'github']) {
    it(`${provider}: serves four agents, full KB report, cost cohorts and live SSE updates`, async () => {
      sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'teamai-dashboard-e2e-'));
      const home = path.join(sandbox, 'home'), teamHome = path.join(home, '.teamai'), repo = path.join(teamHome, 'team-repo');
      await fs.mkdir(path.join(teamHome, 'dashboard'), { recursive: true });
      await fs.mkdir(path.join(repo, 'docs'), { recursive: true });
      await fs.writeFile(path.join(repo, 'teamai.yaml'), YAML.stringify({ team: 'dashboard-test', repo: 'https://example.invalid/team.git', provider }));
      await fs.writeFile(path.join(repo, 'docs', 'guide.md'), '---\ntitle: Provider guide\nauthor: test-author\n---\nExample team knowledge.\n');
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' });
      git('init','-b','main');git('config','user.name','Dashboard Test');git('config','user.email','test@example.invalid');git('add','.');git('commit','-m','fixture');
      git('branch','teamai-reports');git('worktree','add',path.join(teamHome,'reports-wt'),'teamai-reports');
      await fs.mkdir(path.join(teamHome,'reports-wt','votes'),{recursive:true});
      await fs.writeFile(path.join(teamHome,'reports-wt','votes','fixture.yaml'),'version: 2\nvotes: {}\ndeltas: {}\n');
      await fs.writeFile(path.join(teamHome,'config.yaml'),YAML.stringify({repo:{kind:'git',localPath:repo,remote:'https://example.invalid/team.git'},username:'fixture',scope:'user'}));
      const now = Date.now(), stamp=(offset: number)=>new Date(now+offset).toISOString();
      const events = ['claude','codex','codebuddy','opencode'].flatMap((tool,index)=>[
        {type:'session_start',sessionId:tool,tool,cwd:path.join(sandbox,tool),timestamp:stamp(-60_000)},
        {type:'prompt_submit',sessionId:tool,tool,promptSummary:`Inspect ${tool} <script>not-code</script>`,timestamp:stamp(-59_000)},
        {type:'stop',sessionId:tool,tool,timestamp:stamp(-1000),stoppedOutput:'# Result\n\n**Ready**\n\n```js\nconst ready = true;\n```',prompts:1,
          interventions:{interrupt:index,toolReject:1},tokens:{input:100,output:20,cacheRead:30,cacheCreation:0},
          ...(index===0?{requestMetrics:{pricedRequests:4,costMicros:800_000,cacheReadTokens:30,cacheEligibleInputTokens:130,priceVersion:'fixture'}}:{})},
      ]);
      const eventsPath=path.join(teamHome,'dashboard','events.jsonl');
      await fs.writeFile(eventsPath,events.map(e=>JSON.stringify(e)).join('\n')+'\n');
      const port=await freePort(),base=`http://127.0.0.1:${port}`;
      child=spawn(process.execPath,[cli,'dashboard','--port',String(port)],{cwd:home,env:{...process.env,HOME:home,USERPROFILE:home,NO_COLOR:'1'},stdio:'pipe'});
      let output='';child.stdout?.on('data',b=>output+=b);child.stderr?.on('data',b=>output+=b);
      const deadline=Date.now()+15000;
      while(!output.includes('Dashboard running')&&Date.now()<deadline){if(child.exitCode!==null)throw Error(output);await new Promise(r=>setTimeout(r,50));}
      expect(output).toContain('Dashboard running');
      const html=await (await fetch(base)).text();expect(html).toContain('Team Execution');expect(html).not.toContain('SAMPLE DATA');
      const sessions=await (await fetch(base+'/api/sessions')).json();
      expect(sessions.map((s:{tool:string})=>s.tool).sort()).toEqual(['claude','codebuddy','codex','opencode']);
      for(const session of sessions){expect(session.prompts).toHaveLength(1);expect(session.tokens.input).toBe(100);expect(session.stoppedOutput).toContain('**Ready**');}
      const trends=await (await fetch(base+'/api/trends')).json();
      expect(trends.current.avgSessionCostMicros).toBe(800_000);
      expect(trends.current.avgRequestCostMicros).toBe(200_000);
      expect(trends.current.pricedSessions).toBe(1);
      expect(trends.current.sessionsEnded).toBe(4);
      // Cache-read share is pricing-independent: all four sessions carry cacheRead 30
      // of eligible 130, so the unpriced three contribute too (would be null if coupled to pricing).
      expect(trends.current.cacheReadShare).toBeCloseTo(30 / 130, 5);
      const context=await (await fetch(base+'/api/context')).json();
      expect(context.source.scope).toBe('team');expect(context.totalEntries).toBeGreaterThan(0);
      expect(context.context).toContain('Provider guide');expect(context.context).toContain('Author Contributions');
      expect(context.maintenance).toContain('teamai recall maintenance --prune --archive');
      expect(await (await fetch(base+'/kb-report')).text()).toContain('Knowledge Base');
      expect((await (await fetch(base+'/api/kb-summary')).json()).source.scope).toBe('team');
      const stream=await fetch(base+'/events',{signal:AbortSignal.timeout(5000)}),reader=stream.body!.getReader();
      await reader.read();
      await fs.appendFile(eventsPath,JSON.stringify({type:'prompt_submit',timestamp:stamp(0),sessionId:'claude',tool:'claude',promptSummary:'wrong, check again'})+'\n');
      let live='';while(!live.includes('wrong, check again')){const {value,done}=await reader.read();if(done)break;live+=new TextDecoder().decode(value);}
      await reader.cancel();expect(live).toContain('wrong, check again');expect(live).toContain('"status":"running"');
    });
  }
});

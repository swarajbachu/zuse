import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("provisioning is idempotent, preserves existing memberships, and sets correct aggregation and funnel order", () => {
	const code = `
 import assert from 'node:assert/strict';
 const data = new Map(['actions','cohorts','dashboards','insights'].map(kind=>[kind,[]]));
 let nextId=1;
 globalThis.fetch=async (url,init={})=>{
  const [,kind,id]=new URL(url).pathname.match(/\\/api\\/projects\\/test\\/(\\w+)\\/(\\d+)?/) ?? [];
  assert(data.has(kind),url);
  const list=data.get(kind);
  let result;
  if(!init.method || init.method==='GET') result={results:list,next:null};
  else if(init.method==='POST') {result={id:nextId++,...JSON.parse(init.body)};list.push(result);}
  else if(init.method==='PATCH') {result=list.find(item=>item.id===Number(id));Object.assign(result,JSON.parse(init.body));}
  else assert.fail(init.method);
  return new Response(JSON.stringify(result),{status:200});
 };
 await import('./scripts/provision-analytics.mjs?first');
 const counts=[...data].map(([kind,items])=>[kind,items.length]);
 const active=data.get('insights').find(item=>item.name==='Desktop - Daily active users');
 active.dashboards.push(999);
 await import('./scripts/provision-analytics.mjs?second');
 assert.deepEqual([...data].map(([kind,items])=>[kind,items.length]),counts);
 assert(active.dashboards.includes(999));
 const legacyActive=data.get('insights').find(item=>item.name==='Daily active users');
 assert.equal(legacyActive.filters.events[0].math,'dau');
 const sum=data.get('insights').find(item=>item.name==='Active seconds');
 assert.equal(sum.filters.events[0].math,'sum');
 assert.equal(sum.filters.events[0].math_property,'active_seconds');
 const funnel=data.get('insights').find(item=>item.name==='First value funnel');
 assert.deepEqual(funnel.filters.events.map(event=>event.order),[0,1,2,3,4]);
 console.log('verified');
 `;
	const output = execFileSync(
		process.execPath,
		["--input-type=module", "-e", code],
		{
			cwd: new URL("..", import.meta.url),
			encoding: "utf8",
			env: {
				...process.env,
				POSTHOG_PERSONAL_API_KEY: "test",
				POSTHOG_PROJECT_ID: "test",
			},
		},
	);
	assert(output.includes("verified"));
});

test("managed dashboard layouts put summaries first without overlapping charts", async () => {
	const { analyticsDashboards, layoutAnalyticsDashboard } = await import(
		"./analytics-dashboards.mjs"
	);
	for (const definition of analyticsDashboards) {
		const tiles = definition.tiles.map((insight, index) => ({
			id: index + 1,
			insight: { name: insight.name },
		}));
		const layouts = layoutAnalyticsDashboard(definition, tiles);
		assert.equal(layouts.length, tiles.length);
		assert.deepEqual(layouts[0].layouts.sm, { x: 0, y: 0, w: 12, h: 3 });
		for (let a = 0; a < layouts.length; a++)
			for (let b = a + 1; b < layouts.length; b++) {
				const first = layouts[a].layouts.sm,
					second = layouts[b].layouts.sm;
				assert(
					first.x + first.w <= second.x ||
						second.x + second.w <= first.x ||
						first.y + first.h <= second.y ||
						second.y + second.h <= first.y,
				);
			}
	}
});

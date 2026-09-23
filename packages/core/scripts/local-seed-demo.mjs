import { createHash } from "node:crypto";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import console from "node:console";
import pg from "pg";

// Explicit, repeatable local fixtures. Never invoked during application startup.
if (!process.env.DATABASE_URL) {
  process.loadEnvFile(fileURLToPath(new URL("../../../.env.local", import.meta.url)));
}
const databaseUrl = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname)) {
  throw new Error("Demo data can only be seeded into a loopback database.");
}
const email = process.argv[2];
if (!email) throw new Error("Usage: local-seed-demo.mjs <existing-local-user-email>");
const id = (key) => {
  const hex = createHash("sha256").update(`responder-local-demo:${email}:${key}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const client = new pg.Client({ connectionString: databaseUrl.href });
const json = JSON.stringify;
const organizationId = id("workspace");
const accountId = id("slack");
const examples = [
  ["Video uploads fail during transient storage errors", "SEV-2", "A completed video is lost when storage returns a temporary service error.", "The upload path performs one request and treats temporary errors as permanent.", "Retry transient upload failures with bounded backoff."],
  ["Checkout requests exhaust the database pool", "SEV-1", "Checkout requests time out during a traffic burst.", "A transaction remains open while waiting for a remote payment response.", "Move the remote request outside the database transaction."],
  ["Webhook retries create duplicate notifications", "SEV-3", "Some customers receive the same notification twice.", "The webhook handler does not deduplicate repeated event IDs.", "Persist an idempotency key before delivering a notification."],
  ["Search results include outdated inventory", "SEV-2", "Search returns items that are no longer available.", "The indexing job skips updates that contain an empty availability list.", "Apply empty availability updates to remove stale inventory."],
  ["Scheduled reports arrive late", "SEV-3", "Daily reports are delayed when a large export shares the worker queue.", "Exports and short scheduled jobs share the same concurrency limit.", "Separate long-running exports from scheduled report jobs."],
  ["Expired sessions are not cleared after sign-out", "SEV-3", "A stale session badge remains visible after signing out in another tab.", "The client caches the session without listening for sign-out events.", "Invalidate cached sessions when another tab signs out."],
];
try {
  await client.connect();
  const { rows: users } = await client.query('select id from "user" where email = $1', [email]);
  if (!users[0]) throw new Error("Create a local account before seeding its demo workspace.");
  await client.query("begin");
  await client.query(`insert into organization(id,name,slug,created_at,metadata) values($1,'Demo workspace',$2,now(),$3) on conflict(id) do nothing`, [organizationId, `local-demo-${organizationId.slice(0,8)}`, json({localDemo:true})]);
  await client.query(`insert into member(id,organization_id,user_id,role,created_at) values($1,$2,$3,'admin',now()) on conflict(id) do update set role='admin' where member.role='owner'`, [id("member"),organizationId,users[0].id]);
  await client.query(`insert into integration_accounts(id,organization_id,provider,external_account_id,display_name,status,metadata) values($1,$2,'slack',$3,'Demo Slack (local fixture)','connected',$4) on conflict(id) do nothing`, [accountId,organizationId,`LOCAL_DEMO_${accountId}`,json({localDemo:true,userScopes:["search:read"]})]);
  for (const channel of ["incidents","support","infrastructure"]) {
    await client.query(`insert into integration_resources(id,integration_account_id,kind,external_id,display_name,metadata) values($1,$2,'slack_channel',$3,$4,$5) on conflict(id) do nothing`, [id(channel),accountId,`LOCAL_DEMO_${channel}`,channel,json({localDemo:true,isMember:true,isPrivate:false})]);
  }
  for (const [i,name] of ["Production alerts","Customer support","Infrastructure checks"].entries()) {
    const agentId=id(`agent-${i}`),versionId=id(`version-${i}`);
    await client.query(`insert into agents(id,organization_id,name,description,enabled) values($1,$2,$3,'Local demo agent with synthetic alert history.',false) on conflict(id) do nothing`, [agentId,organizationId,name]);
    await client.query(`insert into agent_config_versions(id,agent_id,version,prompt,model,trigger,trigger_config,report_config,created_by) values($1,$2,1,$3,'instance/default','slack_channel',$4,$5,$6) on conflict(id) do nothing`, [versionId,agentId,"Investigate the alert, identify its root cause, and recommend a focused fix. Support findings with evidence.",json({integrationAccountId:accountId,channelId:`LOCAL_DEMO_${["incidents","support","infrastructure"][i]}`}),json({mode:"thread"}),users[0].id]);
    await client.query("update agents set active_version_id=$1 where id=$2 and active_version_id is null",[versionId,agentId]);
  }
  for (const [i,[title,severity,description,rootCause,remediation]] of examples.entries()) {
    const investigationId=id(`run-${i}`),issueId=id(`issue-${i}`),agentId=id(`agent-${i%3}`);
    const createdAt=new Date(Date.now()-(i<3 ? (i+1)*18 : 1440+(i-3)*65)*60000);
    const evidence=[{source:"alert",title:"Synthetic alert",detail:`Local demo data: ${description}`},{source:"github",title:"Relevant code path",detail:rootCause,file:"src/service.ts",line:12}];
    const remediations=i===0 ? [{id:"retry-storage",type:"code_change",title:"Retry transient storage failures",description:remediation,changes:[{repository:"demo/video-service",diff:"diff --git a/src/storage.ts b/src/storage.ts\n--- a/src/storage.ts\n+++ b/src/storage.ts\n@@ -1,3 +1,5 @@\n export async function saveVideo(file: Blob) {\n-  return storage.upload(file);\n+  return retry(() => storage.upload(file), {\n+    attempts: 3, delay: 1000,\n+  });\n }\n"}]}] : [{id:`action-${i}`,type:"external_action",title:"Recommended remediation",description:remediation,agentPrompt:remediation}];
    await client.query(`insert into investigations(id,organization_id,agent_id,agent_config_version_id,status,title,input,finding,report_markdown,created_at,started_at,completed_at) values($1,$2,$3,$4,'resolved',$5,$6,$7,$8,$9,$9,$9) on conflict(id) do nothing`, [investigationId,organizationId,agentId,id(`version-${i%3}`),title,json({provider:"slack",externalEventId:`LOCAL_DEMO_${i}`,title,body:description}),json({summary:description,severity,rootCause,evidence,remediation}),`## Summary\n${description}\n\n## Root cause\n${rootCause}\n\n## Remediation\n${remediation}`,createdAt]);
    await client.query(`insert into issues(id,organization_id,title,description,root_cause,timeline,severity,remediation,remediations,evidence,source_investigation_id,created_at,archived_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict(id) do nothing`, [issueId,organizationId,title,description,rootCause,json([{title:"Alert received",description:"Synthetic alert created for local testing."},{title:"Investigation completed",description:rootCause}]),severity,remediation,json(remediations),json(evidence),investigationId,createdAt,i===5?new Date():null]);
    await client.query("update investigations set eve_session_id=$1 where id=$2 and eve_session_id is null", [`openai-daytona:local-demo-${investigationId}`, investigationId]);
    await client.query(`insert into investigation_trace_events(investigation_id,event,created_at) select $1,$2,$3 where not exists(select 1 from investigation_trace_events where investigation_id=$1)`, [investigationId,json({type:"message.completed",data:{message:`Synthetic demo investigation: ${rootCause} Recommended next step: ${remediation}`},meta:{at:createdAt.toISOString()}}),createdAt]);
    await client.query(`insert into investigation_issues(investigation_id,issue_id,relationship,evidence,created_at) values($1,$2,'new',$3,$4) on conflict do nothing`,[investigationId,issueId,json(evidence),createdAt]);
  }
  for (const [i, title] of ["Record storage errors before retrying uploads", "Measure database connection pool wait time", "Track duplicate webhook deliveries"].entries()) {
    const detail = "## Why this matters\n\nStructured context helps distinguish transient failures from repeated application errors.\n\n## Validate\n\nReproduce the failure locally and confirm the event includes the operation and error code.";
    const change = i === 0 ? { id: "demo-observability-change", type: "code_change", title: "Include operation context in upload errors", description: "Preserve the original error and record the operation before retrying.", changes: [{ repository: "superloglabs/responder-oss", diff: "diff --git a/src/service.ts b/src/service.ts\n--- a/src/service.ts\n+++ b/src/service.ts\n@@ -1,3 +1,4 @@\n function handleError(error) {\n+  logger.error({ operation: 'upload', error }, 'Upload failed');\n   throw error;\n }\n" }] } : null;
    await client.query(`insert into suggestions(id,organization_id,investigation_id,agent_config_version_id,title,subtitle,detail,code_change,fingerprint,created_at,dismissed_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(id) do nothing`, [id(`suggestion-${i}`), organizationId, id(`run-${i}`), id(`version-${i%3}`), title, "The current logs omit context needed to explain the failure and verify the fix.", detail, change ? json(change) : null, `LOCAL_DEMO_${id(`suggestion-${i}`)}`, new Date(Date.now() - (i+1)*3600000), i === 2 ? new Date() : null]);
  }
  const scanAgentId = id("scan-agent"), scanVersionId = id("scan-version");
  await client.query(`insert into agents(id,organization_id,name,description,enabled,purpose) values($1,$2,'Demo scheduled scans','Local scan history fixture',false,'scan') on conflict(id) do nothing`, [scanAgentId,organizationId]);
  await client.query(`insert into agent_config_versions(id,agent_id,version,prompt,model,trigger,trigger_config,report_config,created_by) values($1,$2,1,'Inspect the configured sources.','instance/default','slack_channel',$3,$4,$5) on conflict(id) do nothing`, [scanVersionId,scanAgentId,json({integrationAccountId:accountId,channelId:"LOCAL_DEMO_incidents"}),json({mode:"thread"}),users[0].id]);
  await client.query("update agents set active_version_id=$1 where id=$2 and active_version_id is null",[scanVersionId,scanAgentId]);
  for (const i of [0,1]) {
    const scanId = id(`scan-history-${i}`), startedAt = new Date(Date.now()-(i+1)*3600000);
    await client.query(`insert into investigations(id,organization_id,agent_id,agent_config_version_id,status,title,input,created_at,started_at,completed_at) values($1,$2,$3,$4,'resolved','Local demo scan',$5,$6,$6,$7) on conflict(id) do nothing`, [scanId,organizationId,scanAgentId,scanVersionId,json({provider:"scan",externalEventId:`LOCAL_DEMO_SCAN_${i}`,title:"Local demo scan",body:"Synthetic completed scan; no job was run.",attributes:{sourceCount:1,slackChannelName:"incidents"}}),startedAt,new Date(startedAt.getTime()+138000)]);
    await client.query(`insert into investigation_issues(investigation_id,issue_id,relationship,evidence,created_at) values($1,$2,'recurrence','[]',$3) on conflict do nothing`,[scanId,id(`issue-${i}`),startedAt]);
  }
  await client.query("commit");
  console.log(json({workspaceId:organizationId,agents:3,issues:6,investigations:6,suggestions:3,scans:2,note:"Demo integrations have no credentials. Agents start paused; no jobs or outbound messages are created."}));
} catch(error) {
  await client.query("rollback").catch(()=>{});
  throw error;
} finally {
  await client.end();
}

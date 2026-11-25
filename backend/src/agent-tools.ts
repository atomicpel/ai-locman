import { createSign } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";

export type GitHubToolContext = { token: string; owner: string; repo: string };
const base = "https://api.github.com";
const version = "2026-03-10";
const safePath = z.string().min(1).max(1000).refine((value) => {
  if (
    value.startsWith("/") ||
    value.includes("\\\\") ||
    value.includes(String.fromCharCode(0)) ||
    /^[A-Za-z]:/.test(value)
  ) return false;
  return value.split("/").every((segment) =>
    segment.length > 0 && segment !== "." && segment !== ".."
  );
}, "Invalid repository path");

export function isSafeGitHubPath(value: string): boolean {
  return safePath.safeParse(value).success;
}
const schemas = {
  "github.list_branches": z.object({}).strict(),
  "github.list_files": z.object({ path: safePath.optional(), ref: z.string().min(1).max(255).optional() }).strict(),
  "github.read_file": z.object({ path: safePath, ref: z.string().min(1).max(255).optional() }).strict(),
  "github.list_commits": z.object({ perPage: z.number().int().min(1).max(50).optional() }).strict(),
  "github.list_pull_requests": z.object({ state: z.enum(["open","closed","all"]).optional(), perPage: z.number().int().min(1).max(50).optional() }).strict(),
  "github.list_actions_runs": z.object({ perPage: z.number().int().min(1).max(50).optional() }).strict(),
  "github.compare_branches": z.object({ base: z.string().min(1).max(255), head: z.string().min(1).max(255) }).strict()
};
export const githubToolSpecs = [
 { type:"function", function:{name:"github.list_branches",description:"List repository branches.",parameters:{type:"object",properties:{},additionalProperties:false}}},
 { type:"function", function:{name:"github.list_files",description:"List files and directories in a path.",parameters:{type:"object",properties:{path:{type:"string"},ref:{type:"string"}},additionalProperties:false}}},
 { type:"function", function:{name:"github.read_file",description:"Read a text file up to 600 KB.",parameters:{type:"object",properties:{path:{type:"string"},ref:{type:"string"}},required:["path"],additionalProperties:false}}},
 { type:"function", function:{name:"github.list_commits",description:"List recent commits.",parameters:{type:"object",properties:{perPage:{type:"integer",minimum:1,maximum:50}},additionalProperties:false}}},
 { type:"function", function:{name:"github.list_pull_requests",description:"List pull requests.",parameters:{type:"object",properties:{state:{type:"string",enum:["open","closed","all"]},perPage:{type:"integer",minimum:1,maximum:50}},additionalProperties:false}}},
 { type:"function", function:{name:"github.list_actions_runs",description:"List Actions workflow runs.",parameters:{type:"object",properties:{perPage:{type:"integer",minimum:1,maximum:50}},additionalProperties:false}}},
 { type:"function", function:{name:"github.compare_branches",description:"Read a branch diff.",parameters:{type:"object",properties:{base:{type:"string"},head:{type:"string"}},required:["base","head"],additionalProperties:false}}}
] as const;

function appJwt() {
 const clientId=process.env.GITHUB_APP_CLIENT_ID??process.env.GITHUB_APP_ID;
 const key=process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g,"\n");
 if(!clientId||!key) throw new Error("GitHub App credentials are not configured");
 const now=Math.floor(Date.now()/1000);
 const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString("base64url");
 const unsigned=encode({alg:"RS256",typ:"JWT"})+"."+encode({iat:now-60,exp:now+540,iss:clientId});
 const signer=createSign("RSA-SHA256"); signer.update(unsigned); signer.end();
 return unsigned+"."+signer.sign(key,"base64url");
}
export async function createGitHubToolContext(pool:Pool,ownerId:string,fullName:string):Promise<GitHubToolContext|null>{
 const match=/^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(fullName);
 if(!match)return null;
 const [owner,repo]=[match[1],match[2]];
 const {rows}=await pool.query("SELECT installation_id FROM github_installations WHERE owner_id=$1 ORDER BY updated_at DESC",[ownerId]);
 for(const row of rows){
  const response=await fetch(base+"/app/installations/"+Number(row.installation_id)+"/access_tokens",{
   method:"POST",headers:{Accept:"application/vnd.github+json",Authorization:"Bearer "+appJwt(),"X-GitHub-Api-Version":version,"Content-Type":"application/json"},
   body:JSON.stringify({repositories:[repo]})
  });
  const raw=await response.text();
  if(!response.ok){if([404,422].includes(response.status))continue;throw new Error("GitHub token error "+response.status+": "+raw.slice(0,500));}
  const token=(JSON.parse(raw) as {token?:string}).token;
  if(!token)continue;
  const verify=await fetch(base+"/repos/"+encodeURIComponent(owner)+"/"+encodeURIComponent(repo),{headers:{Authorization:"Bearer "+token,Accept:"application/vnd.github+json","X-GitHub-Api-Version":version}});
  if(verify.ok)return {token,owner,repo};
  if(verify.status!==404&&verify.status!==403)throw new Error("GitHub repository verification failed: "+verify.status);
 }
 return null;
}
async function api(ctx:GitHubToolContext,path:string,accept="application/vnd.github+json"){
 const response=await fetch(base+path,{headers:{Authorization:"Bearer "+ctx.token,Accept:accept,"X-GitHub-Api-Version":version}});
 const raw=await response.text();
 if(!response.ok)throw new Error("GitHub API "+response.status+": "+raw.slice(0,800));
 return raw;
}
const root=(ctx:GitHubToolContext)=>"/repos/"+encodeURIComponent(ctx.owner)+"/"+encodeURIComponent(ctx.repo);
export async function executeGitHubTool(name:string,rawArgs:string,ctx:GitHubToolContext):Promise<unknown>{
 let args:unknown; try{args=JSON.parse(rawArgs||"{}");}catch{throw new Error("Invalid JSON arguments");}
 switch(name){
  case "github.list_branches":{
   schemas[name].parse(args);
   const data=JSON.parse(await api(ctx,root(ctx)+"/branches?per_page=100")) as Array<Record<string,unknown>>;
   return data.map(x=>({name:x.name,protected:x.protected}));
  }
  case "github.list_files":{
   const input=schemas[name].parse(args); const path=input.path?"/"+input.path.split("/").map(encodeURIComponent).join("/"):"";
   const ref=input.ref?"?ref="+encodeURIComponent(input.ref):"";
   const data=JSON.parse(await api(ctx,root(ctx)+"/contents"+path+ref)) as Array<Record<string,unknown>>|Record<string,unknown>;
   if(!Array.isArray(data))return {name:data.name,path:data.path,type:data.type,size:data.size};
   return data.slice(0,100).map(x=>({name:x.name,path:x.path,type:x.type,size:x.size}));
  }
  case "github.read_file":{
   const input=schemas[name].parse(args);const path=input.path.split("/").map(encodeURIComponent).join("/");
   const ref=input.ref?"?ref="+encodeURIComponent(input.ref):"";
   const data=JSON.parse(await api(ctx,root(ctx)+"/contents/"+path+ref)) as {encoding?:string;content?:string;path?:string};
   if(data.encoding!=="base64"||!data.content)throw new Error("Not a readable text file");
   const bytes=Buffer.from(data.content.replace(/\s/g,""),"base64");if(bytes.byteLength>600000)throw new Error("File exceeds 600 KB");
   return {path:data.path,content:bytes.toString("utf8")};
  }
  case "github.list_commits":{
   const input=schemas[name].parse(args);const data=JSON.parse(await api(ctx,root(ctx)+"/commits?per_page="+(input.perPage??25))) as Array<Record<string,unknown>>;
   return data.map(x=>{const c=x.commit as Record<string,unknown>|undefined;const a=c?.author as Record<string,unknown>|undefined;return {sha:x.sha,message:String(c?.message??"").split("\n")[0],author:a?.name,date:a?.date};});
  }
  case "github.list_pull_requests":{
   const input=schemas[name].parse(args);const data=JSON.parse(await api(ctx,root(ctx)+"/pulls?state="+(input.state??"open")+"&per_page="+(input.perPage??25))) as Array<Record<string,unknown>>;
   return data.map(x=>{const h=x.head as Record<string,unknown>|undefined;const b=x.base as Record<string,unknown>|undefined;const u=x.user as Record<string,unknown>|undefined;return {number:x.number,title:x.title,state:x.state,head:h?.ref,base:b?.ref,author:u?.login,html_url:x.html_url};});
  }
  case "github.list_actions_runs":{
   const input=schemas[name].parse(args);const data=JSON.parse(await api(ctx,root(ctx)+"/actions/runs?per_page="+(input.perPage??25))) as {workflow_runs?:Array<Record<string,unknown>>};
   return (data.workflow_runs??[]).map(x=>({name:x.name,status:x.status,conclusion:x.conclusion,branch:x.head_branch,created_at:x.created_at}));
  }
  case "github.compare_branches":{
   const input=schemas[name].parse(args);return (await api(ctx,root(ctx)+"/compare/"+encodeURIComponent(input.base)+"..."+encodeURIComponent(input.head),"application/vnd.github.diff")).slice(0,40000);
  }
  default:throw new Error("Unregistered GitHub tool");
 }
}
export const createOpenRouterToolCalls=()=>githubToolSpecs;

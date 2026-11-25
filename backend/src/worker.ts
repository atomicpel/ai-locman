import "dotenv/config";
import { Worker, type Job } from "bullmq";
import { Pool } from "pg";
import { createGitHubToolContext, createOpenRouterToolCalls, executeGitHubTool } from "./agent-tools.js";

type TaskJob={taskId:string};
type ToolCall={id:string;function:{name:string;arguments:string}};
type Message={role:"system"|"user"|"assistant"|"tool";content:string|null;tool_calls?:ToolCall[];tool_call_id?:string};
type ModelMessage={content?:string|Array<{text?:string}>;tool_calls?:ToolCall[]};
type ModelResponse={choices?:Array<{message?:ModelMessage}>};

const pool=new Pool({connectionString:process.env.DATABASE_URL});
const redisUrl=new URL(process.env.REDIS_URL??"redis://127.0.0.1:6379");
const connection={host:redisUrl.hostname,port:Number(redisUrl.port||6379),username:redisUrl.username||undefined,password:redisUrl.password||undefined,maxRetriesPerRequest:null,...(redisUrl.protocol==="rediss:"?{tls:{}}:{})};
const baseUrl=process.env.OPENROUTER_BASE_URL??"https://openrouter.ai/api/v1";
const MAX_TURNS=8,MAX_TOOLS=12;

function contentOf(m?:ModelMessage):string{const c=m?.content;if(typeof c==="string")return c;if(Array.isArray(c))return c.map(x=>x.text??"").join("");return "";}
async function callModel(model:string,messages:Message[],withTools=false){
 const key=process.env.OPENROUTER_API_KEY;if(!key)throw new Error("OPENROUTER_API_KEY is not configured");
 const body:Record<string,unknown>={model,messages,stream:false,temperature:0.2};
 if(withTools){body.tools=createOpenRouterToolCalls();body.tool_choice="auto";body.parallel_tool_calls=false;}
 const res=await fetch(baseUrl+"/chat/completions",{method:"POST",headers:{Authorization:"Bearer "+key,"Content-Type":"application/json","HTTP-Referer":process.env.APP_PUBLIC_URL??"http://localhost:8080","X-Title":"AI Locman Background Agent"},body:JSON.stringify(body)});
 const raw=await res.text();if(!res.ok)return {status:res.status,details:raw.slice(0,1200),payload:undefined as ModelResponse|undefined};
 return {status:res.status,details:"",payload:JSON.parse(raw) as ModelResponse};
}
async function isCancelled(id:string){const r=await pool.query("SELECT cancel_requested FROM agent_tasks WHERE id=$1",[id]);return Boolean(r.rows[0]?.cancel_requested);}
async function cancel(id:string){await pool.query("UPDATE agent_tasks SET status='cancelled',completed_at=now(),updated_at=now() WHERE id=$1",[id]);}
async function logEvent(id:string,type:"plan"|"tool"|"review"|"notice",tool:string,args:unknown,result:string){
 await pool.query("INSERT INTO agent_task_events (task_id,event_type,tool_name,arguments,result) VALUES ($1,$2,$3,$4::jsonb,$5)",[id,type,tool,JSON.stringify(args??{}),result.slice(0,40000)]);
}
async function execute(job:Job<TaskJob>){
 const id=job.data.taskId;
 const result=await pool.query("SELECT t.id,t.project_id,t.conversation_id,t.prompt,t.model,t.cancel_requested,p.name AS project_name,p.instructions,p.owner_id,p.github_repository FROM agent_tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=$1",[id]);
 const task=result.rows[0];if(!task)throw new Error("Task not found");
 if(task.cancel_requested){await cancel(id);return {status:"cancelled"};}
 await pool.query("UPDATE agent_tasks SET status='planning',started_at=COALESCE(started_at,now()),updated_at=now(),error=NULL WHERE id=$1",[id]);
 let conversationId:string;
 if(task.conversation_id)conversationId=String(task.conversation_id);
 else{const c=await pool.query("INSERT INTO conversations (project_id,title) VALUES ($1,$2) RETURNING id",[task.project_id,task.prompt.slice(0,70)]);conversationId=String(c.rows[0].id);await pool.query("UPDATE agent_tasks SET conversation_id=$2 WHERE id=$1",[id,conversationId]);}
 await pool.query("INSERT INTO messages (conversation_id,role,content,model,task_id) VALUES ($1,'user',$2,$3,$4) ON CONFLICT (task_id,role) WHERE task_id IS NOT NULL DO NOTHING",[conversationId,task.prompt,task.model,id]);
 if(await isCancelled(id)){await cancel(id);return {status:"cancelled"};}
 const mem=await pool.query("SELECT section,content FROM project_memory WHERE project_id=$1 AND content<>'' ORDER BY section",[task.project_id]);
 const memory=mem.rows.map(x=>"["+x.section+"]\n"+x.content).join("\n\n");
 const hist=await pool.query("SELECT role,content FROM messages WHERE conversation_id=$1 AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 30",[conversationId]);
 const gh=task.github_repository?await createGitHubToolContext(pool,String(task.owner_id),String(task.github_repository)):null;
 const sys="Ты — AI Locman, фоновый агент разработки. Проект: "+task.project_name+". Инструкции: "+(task.instructions||"нет")+".\n\nПамять этого проекта:\n"+(memory||"Пока пуста.")+"\n\n"+
 (gh?"К проекту привязан GitHub "+gh.owner+"/"+gh.repo+". Используй read-only GitHub tools для исследования реального кода. ":"GitHub репозиторий недоступен; не заявляй, что изучил код. ")+
 "Планируй, исследуй, затем отвечай и проверяй ответ. Не смешивай проекты. Запись в GitHub, shell и запуск кода запрещены. Не выдумывай выполненные действия.";
 const messages:Message[]=[{role:"system",content:sys},...hist.rows.reverse().map(x=>({role:x.role as "user"|"assistant",content:String(x.content)}))];
 const planner=await callModel(task.model,[...messages,{role:"user",content:"Сначала составь план конкретных шагов, не давай финальный ответ."}]);
 if(planner.status<200||planner.status>=300)throw new Error("Planner HTTP "+planner.status+": "+planner.details);
 const plan=contentOf(planner.payload?.choices?.[0]?.message).trim();
 if(plan){messages.push({role:"assistant",content:"План:\n"+plan});await logEvent(id,"plan","",{},plan);}
 if(await isCancelled(id)){await cancel(id);return {status:"cancelled"};}
 await pool.query("UPDATE agent_tasks SET status='running',updated_at=now() WHERE id=$1",[id]);
 let tools=Boolean(gh),toolCount=0,answer="";
 for(let turn=0;turn<MAX_TURNS;turn++){
  if(await isCancelled(id)){await cancel(id);return {status:"cancelled"};}
  const completion=await callModel(task.model,messages,tools);
  if(completion.status<200||completion.status>=300){
   if(tools&&completion.status===400){tools=false;const warning="Модель не поддерживает tools; продолжаю без чтения репозитория.";messages.push({role:"system",content:warning});await logEvent(id,"notice","",{},warning);continue;}
   throw new Error("Agent HTTP "+completion.status+": "+completion.details);
  }
  const assistant=completion.payload?.choices?.[0]?.message,calls=assistant?.tool_calls??[];
  if(calls.length){
   messages.push({role:"assistant",content:typeof assistant?.content==="string"?assistant.content:null,tool_calls:calls});
   for(const call of calls){
    if(await isCancelled(id)){await cancel(id);return {status:"cancelled"};}
    toolCount++;let args:unknown={},output:unknown;
    try{args=JSON.parse(call.function.arguments||"{}");if(toolCount>MAX_TOOLS)throw new Error("Tool-call limit reached");if(!gh)throw new Error("GitHub tools not available");output=await executeGitHubTool(call.function.name,call.function.arguments,gh);}
    catch(e){output={error:e instanceof Error?e.message:"Tool failed"};}
    await logEvent(id,"tool",call.function.name,args,JSON.stringify(output));
    messages.push({role:"tool",tool_call_id:call.id,content:JSON.stringify(output).slice(0,50000)});
   }
   continue;
  }
  answer=contentOf(assistant).trim();if(answer)break;
 }
 if(!answer)throw new Error("Agent did not produce a final answer within the tool-call limit");
 if(await isCancelled(id)){await cancel(id);return {status:"cancelled"};}
 await pool.query("UPDATE agent_tasks SET status='reviewing',updated_at=now() WHERE id=$1",[id]);
 const evidence=messages.filter(m=>m.role==="tool").map(m=>String(m.content)).join("\n\n").slice(0,30000);
 const review=await callModel(task.model,[
  {role:"system",content:"Ты независимый ревьюер AI Locman. Проверь черновик относительно задачи и реальных результатов инструментов. Убери неподтверждённые заявления, обозначь ограничения. Не заявляй об изменении файлов, запуске кода или сборке, если этого не было."},
  {role:"user",content:"Задача:\n"+task.prompt+"\n\nРезультаты инструментов:\n"+(evidence||"Инструменты не использовались.")+"\n\nЧерновик:\n"+answer}
 ]);
 if(review.status>=200&&review.status<300){const checked=contentOf(review.payload?.choices?.[0]?.message).trim();if(checked){answer=checked;await logEvent(id,"review","",{},checked);}}
 else await logEvent(id,"notice","",{},"Независимое ревью недоступно; использован ответ агента.");
 if(await isCancelled(id)){await cancel(id);return {status:"cancelled"};}
 await pool.query("INSERT INTO messages (conversation_id,role,content,model,task_id) VALUES ($1,'assistant',$2,$3,$4) ON CONFLICT (task_id,role) WHERE task_id IS NOT NULL DO NOTHING",[conversationId,answer,task.model,id]);
 await pool.query("UPDATE agent_tasks SET status='completed',result=$2,error=NULL,completed_at=now(),updated_at=now() WHERE id=$1",[id,answer]);
 return {status:"completed",conversationId,toolCalls:toolCount};
}
const worker=new Worker<TaskJob>("ai-locman-tasks",execute,{connection,concurrency:Number(process.env.AGENT_WORKER_CONCURRENCY??2),lockDuration:300000});
worker.on("completed",(job,result)=>console.info("AI Locman agent completed",{taskId:job.id,result}));
worker.on("failed",(job,error)=>{if(!job)return;if(job.attemptsMade>=Number(job.opts.attempts??1)){void pool.query("UPDATE agent_tasks SET status='failed',error=$2,completed_at=now(),updated_at=now() WHERE id=$1 AND status NOT IN ('completed','cancelled')",[job.data.taskId,error.message.slice(0,2000)]).catch(e=>console.error("Task failure update failed",e));}console.error("AI Locman task failed",{taskId:job.id,error});});
console.info("AI Locman background agent started");
async function shutdown(){await worker.close();await pool.end();process.exit(0);}
process.on("SIGINT",()=>{void shutdown();});process.on("SIGTERM",()=>{void shutdown();});

// KART38 Game Sync — Cloudflare Worker
// Bind KV namespace as SESSIONS. Configure GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET,
// GITHUB_OWNER, GITHUB_REPO, SITE_URL. Do not place secrets in this file.
const API = "https://api.github.com";
const STATUSES = new Set(["Unmarked","Want to play","Playing","Finished","Not interested"]);
const enc = new TextEncoder();
function random() { const a = crypto.getRandomValues(new Uint8Array(32)); return [...a].map(v=>v.toString(16).padStart(2,"0")).join(""); }
function response(body,status=200,headers={}) { return new Response(status===204?null:(typeof body==="string"?body:JSON.stringify(body)),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...headers}}); }
function redirect(url,headers={}) { return new Response(null,{status:302,headers:{Location:url,"cache-control":"no-store",...headers}}); }
function cors(req,env) { const origin=req.headers.get("Origin"); return origin===new URL(env.SITE_URL).origin?{"Access-Control-Allow-Origin":origin,"Access-Control-Allow-Headers":"Authorization, Content-Type","Access-Control-Allow-Methods":"GET, PUT, OPTIONS","Vary":"Origin"}:{}; }
async function gh(path,token,options={}) { return fetch(API+path,{...options,headers:{"Authorization":"Bearer "+token,"Accept":"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","User-Agent":"kart38-game-sync",...(options.headers||{})}}); }
function b64(s){return btoa(unescape(encodeURIComponent(s)));}
function unb64(s){return decodeURIComponent(escape(atob(s)));}
async function getFile(token,env) {
 const path="/repos/"+encodeURIComponent(env.GITHUB_OWNER)+"/"+encodeURIComponent(env.GITHUB_REPO)+"/contents/game-statuses.json";
 const r=await gh(path,token);
 if(r.status===404)return {sha:null,items:{}};
 if(!r.ok)throw Error("GitHub read failed ("+r.status+")");
 const data=await r.json(); const obj=JSON.parse(unb64(data.content.replace(/\s/g,"")));
 return {sha:data.sha,items:obj.items||{}};
}
function validate(input) {
 if(!input||typeof input!=="object"||Array.isArray(input))throw Error("Invalid data");
 const result={};
 for(const [title,entry] of Object.entries(input)) {
  if(title.length>250||!entry||!STATUSES.has(entry.status)||!Number.isFinite(entry.updated)||entry.updated<0)throw Error("Invalid entry");
  result[title]={status:entry.status,updated:entry.updated};
 }
 if(Object.keys(result).length>1000)throw Error("Too many entries");
 return result;
}
export default {async fetch(req,env) {
 try {
 const url=new URL(req.url),p=url.pathname,site=new URL(env.SITE_URL);
 if(req.method==="OPTIONS"&&p.startsWith("/api/"))return response("",204,cors(req,env));
 if(p==="/health")return response({ok:true,service:"KART38 Game Sync"});
 if(p==="/auth/login") {
  const state=random();await env.SESSIONS.put("state:"+state,"1",{expirationTtl:600});
  const auth=new URL("https://github.com/login/oauth/authorize");
  auth.searchParams.set("client_id",env.GITHUB_CLIENT_ID);auth.searchParams.set("redirect_uri",url.origin+"/auth/callback");auth.searchParams.set("state",state);
  return redirect(auth.toString());
 }
 if(p==="/auth/callback") {
  const state=url.searchParams.get("state"),code=url.searchParams.get("code");
  if(!state||!code||!await env.SESSIONS.get("state:"+state))return response("Invalid or expired login",400);
  await env.SESSIONS.delete("state:"+state);
  const r=await fetch("https://github.com/login/oauth/access_token",{method:"POST",headers:{"Accept":"application/json","Content-Type":"application/json"},body:JSON.stringify({client_id:env.GITHUB_CLIENT_ID,client_secret:env.GITHUB_CLIENT_SECRET,code,redirect_uri:url.origin+"/auth/callback"})});
  const result=await r.json();if(!r.ok||!result.access_token)return response("GitHub sign-in failed",401);
  const user=await gh("/user",result.access_token);if(!user.ok)return response("Cannot verify GitHub user",401);
  const info=await user.json();if(info.login.toLowerCase()!==env.GITHUB_OWNER.toLowerCase())return response("This sync service is restricted to its owner",403);
  // Confirm the user's token can read the designated private repository.
  const access=await gh("/repos/"+encodeURIComponent(env.GITHUB_OWNER)+"/"+encodeURIComponent(env.GITHUB_REPO),result.access_token);if(!access.ok)return response("GitHub App needs access to the private tracking repository",403);
  const session=random();await env.SESSIONS.put("session:"+session,JSON.stringify({token:result.access_token,login:info.login}),{expirationTtl:86400*14});
  const dest=new URL(env.SITE_URL);dest.hash="sync_token="+session;return redirect(dest.toString());
 }
 if(p.startsWith("/api/")) {
  const headers=cors(req,env);if(req.headers.get("Origin")!==site.origin)return response({error:"Origin not allowed"},403,headers);
  const token=(req.headers.get("Authorization")||"").match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  const session=token&&await env.SESSIONS.get("session:"+token,"json");
  if(!session)return response({error:"Sign in required"},401,headers);
  if(p==="/api/logout"&&req.method==="PUT"){await env.SESSIONS.delete("session:"+token);return response({ok:true},200,headers);}
  if(p==="/api/status"&&req.method==="GET"){const data=await getFile(session.token,env);return response({items:data.items},200,headers);}
  if(p==="/api/status"&&req.method==="PUT") {
   const payload=await req.json();const incoming=validate(payload.items);
   for(let attempt=0;attempt<4;attempt++) {
    const current=await getFile(session.token,env);const merged={...current.items};
    for(const [title,entry] of Object.entries(incoming))if(!merged[title]||entry.updated>=merged[title].updated)merged[title]=entry;
    const path="/repos/"+encodeURIComponent(env.GITHUB_OWNER)+"/"+encodeURIComponent(env.GITHUB_REPO)+"/contents/game-statuses.json";
    const data={message:"Sync game tracking",content:b64(JSON.stringify({version:1,items:merged},null,2))};
    if(current.sha)data.sha=current.sha;
    const saved=await gh(path,session.token,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});
    if(saved.ok)return response({items:merged},200,headers);
    if(saved.status!==409&&saved.status!==422)throw Error("GitHub write failed ("+saved.status+")");
   }
   return response({error:"Concurrent update; retry"},409,headers);
  }
  return response({error:"Not found"},404,headers);
 }
 return response({error:"Not found"},404);
 }catch(e){return response({error:e.message||"Unexpected error"},500,req.url.includes("/api/")?cors(req,env):{});}
}};

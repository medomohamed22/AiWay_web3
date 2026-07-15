import { createClient } from '@supabase/supabase-js';
import { SignJWT, jwtVerify } from 'jose';

const supabaseUrl=process.env.SUPABASE_URL;
const serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
const jwtSecret=process.env.APP_JWT_SECRET;
export function requireEnv(){const m=[];if(!supabaseUrl)m.push('SUPABASE_URL');if(!serviceRoleKey)m.push('SUPABASE_SERVICE_ROLE_KEY');if(!jwtSecret||jwtSecret.length<32)m.push('APP_JWT_SECRET');if(m.length)throw new Error(`Missing environment variables: ${m.join(', ')}`)}
export function db(){requireEnv();return createClient(supabaseUrl,serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false}})}
export function json(res,status,body){res.status(status).setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');return res.end(JSON.stringify(body))}
export function allowMethods(req,res,methods){if(methods.includes(req.method))return true;res.setHeader('Allow',methods.join(', '));json(res,405,{error:'Method not allowed'});return false}
export async function signAppToken(user){requireEnv();return new SignJWT({username:user.username,pi_uid:user.pi_uid,role:user.role}).setProtectedHeader({alg:'HS256'}).setSubject(user.id).setIssuedAt().setExpirationTime('7d').sign(new TextEncoder().encode(jwtSecret))}
export async function requireUser(req){requireEnv();const auth=req.headers.authorization||'';const token=auth.startsWith('Bearer ')?auth.slice(7):'';if(!token)throw new Error('UNAUTHORIZED');const {payload}=await jwtVerify(token,new TextEncoder().encode(jwtSecret));if(!payload.sub)throw new Error('UNAUTHORIZED');return{id:payload.sub,username:payload.username,pi_uid:payload.pi_uid,role:payload.role||'user'}}
export function cleanText(v,max=500){return String(v??'').trim().slice(0,max)}
export function handleError(error,res,fallback='Server error'){console.error(error);if(error.message==='UNAUTHORIZED')return json(res,401,{error:'Sign in with Pi first'});if(error.message==='INSUFFICIENT_CREDITS')return json(res,402,{error:'Insufficient credits. Buy a Pi package first.'});return json(res,500,{error:fallback})}
export const PACKAGES={starter:{pi:0.1,credits:100},plus:{pi:0.5,credits:650},pro:{pi:1,credits:1500}};
export const MODELS=[
 {id:'deepseek/deepseek-chat-v3-0324',name:'DeepSeek V3',tag:'Fast & smart'},
 {id:'deepseek/deepseek-r1',name:'DeepSeek R1',tag:'Reasoning'},
 {id:'openai/gpt-4o-mini',name:'GPT-4o mini',tag:'Everyday'},
 {id:'openai/gpt-4o',name:'GPT-4o',tag:'Multimodal'},
 {id:'anthropic/claude-3.5-sonnet',name:'Claude 3.5 Sonnet',tag:'Writing & code'},
 {id:'google/gemini-2.0-flash-001',name:'Gemini 2.0 Flash',tag:'Fast'},
 {id:'meta-llama/llama-3.3-70b-instruct',name:'Llama 3.3 70B',tag:'Open model'},
 {id:'qwen/qwen-2.5-72b-instruct',name:'Qwen 2.5 72B',tag:'Multilingual'}
];

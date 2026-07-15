import { allowMethods, cleanText, db, handleError, json, requireUser, safeUrl } from './_lib.js';
const categories=new Set(['Shop','AI','Games','Business','Tools','Finance','Social','Sports']);
const MEDIA_BUCKET='app-media';

function mediaPathFromUrl(value,ownerId){
 try{
  const url=new URL(String(value||''));
  const marker=`/storage/v1/object/public/${MEDIA_BUCKET}/`;
  const index=url.pathname.indexOf(marker);
  if(index<0)return null;
  const path=decodeURIComponent(url.pathname.slice(index+marker.length));
  if(!path||path.includes('..')||!path.startsWith(`${ownerId}/`))return null;
  return path;
 }catch{return null}
}
function appMediaPaths(app,ownerId){
 const urls=[app?.icon_url,...(Array.isArray(app?.screenshot_urls)?app.screenshot_urls:[])];
 return [...new Set(urls.map(url=>mediaPathFromUrl(url,ownerId)).filter(Boolean))];
}
async function removeMedia(supabase,paths){
 if(!paths.length)return [];
 const {data,error}=await supabase.storage.from(MEDIA_BUCKET).remove(paths);
 if(error)throw error;
 return (data||[]).map(item=>item.name).filter(Boolean);
}

export default async function handler(req,res){
 if(!allowMethods(req,res,['PATCH','DELETE']))return;
 try{
  const user=await requireUser(req),id=String(req.query?.id||'');
  if(!id)return json(res,400,{error:'Missing app id'});
  const supabase=db();
  const {data:existing,error:readError}=await supabase.from('apps').select('*').eq('id',id).eq('owner_id',user.id).maybeSingle();
  if(readError)throw readError;
  if(!existing)return json(res,404,{error:'App not found'});

  if(req.method==='DELETE'){
   const oldPaths=appMediaPaths(existing,user.id);
   await removeMedia(supabase,oldPaths);
   const {error}=await supabase.from('apps').delete().eq('id',id).eq('owner_id',user.id);
   if(error)throw error;
   return json(res,200,{deleted:true,deletedMedia:oldPaths.length});
  }

  const b=req.body||{},patch={status:'pending',admin_note:null,published_at:null};
  for(const [k,max] of [['name',80],['short_description',500],['developer_name',100]])if(b[k]!=null)patch[k]=cleanText(b[k],max);
  if(b.contact_email!=null)patch.contact_email=cleanText(b.contact_email,160).toLowerCase();
  if(b.category!=null){const v=cleanText(b.category,30);if(!categories.has(v))return json(res,400,{error:'Invalid category'});patch.category=v}
  if(b.network!=null){const v=cleanText(b.network,10);if(!['mainnet','testnet'].includes(v))return json(res,400,{error:'Invalid network'});patch.network=v}
  if(b.website_url!=null)patch.website_url=safeUrl(b.website_url);
  if(b.icon_url!=null)patch.icon_url=safeUrl(b.icon_url);
  if(Array.isArray(b.screenshot_urls)){if(b.screenshot_urls.length<1||b.screenshot_urls.length>3)return json(res,400,{error:'Upload between 1 and 3 screenshots'});patch.screenshot_urls=b.screenshot_urls.map(safeUrl)}
  const merged={...existing,...patch};
  if(!merged.name||!merged.short_description||merged.short_description.length<10||!merged.developer_name||!merged.website_url||!merged.icon_url||!Array.isArray(merged.screenshot_urls)||merged.screenshot_urls.length<1)return json(res,400,{error:'Complete required fields, logo, and screenshot 1'});

  const {data,error}=await supabase.from('apps').update(patch).eq('id',id).eq('owner_id',user.id).select('*').single();
  if(error)throw error;

  // Delete only media that belonged to this user and is no longer referenced after the update.
  const oldPaths=appMediaPaths(existing,user.id);
  const currentPaths=new Set(appMediaPaths(data,user.id));
  const obsoletePaths=oldPaths.filter(path=>!currentPaths.has(path));
  let mediaCleanupWarning=null;
  try{await removeMedia(supabase,obsoletePaths)}catch(cleanupError){
   console.error('Obsolete media cleanup failed',cleanupError);
   mediaCleanupWarning='App updated, but one or more old images could not be removed automatically.';
  }
  return json(res,200,{app:data,deletedMedia:mediaCleanupWarning?0:obsoletePaths.length,warning:mediaCleanupWarning});
 }catch(e){return handleError(e,res,req.method==='DELETE'?'Unable to delete app and its images':'Unable to update app')}
}

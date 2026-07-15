import { allowMethods, db, handleError, json, requireAdmin, requireUser, cleanText } from './_lib.js';
export default async function handler(req,res){
 if(!allowMethods(req,res,['GET','PATCH']))return;
 try{
  const user=await requireUser(req);requireAdmin(user);const supabase=db();
  if(req.method==='GET'){
   if(String(req.query?.mode||'')==='stats'){
    const [{data:payments,error:pErr},{count:pending,error:aErr}]=await Promise.all([
     supabase.from('payments').select('amount_pi,purpose,status,created_at').eq('status','completed').order('created_at',{ascending:false}),
     supabase.from('apps').select('*',{count:'exact',head:true}).eq('status','pending')
    ]);
    if(pErr||aErr)throw pErr||aErr;
    const total=(payments||[]).reduce((sum,payment)=>sum+Number(payment.amount_pi||0),0);
    return json(res,200,{totalRevenuePi:total,pendingApps:pending||0,payments:payments||[]});
   }
   const [{data:apps,error},{data:reports,error:rErr}]=await Promise.all([
    supabase.from('apps').select('*,users!apps_owner_id_fkey(username)').order('created_at',{ascending:false}),
    supabase.from('app_reports').select('id,app_id,reason,details,status,created_at,users!app_reports_reporter_id_fkey(username)').order('created_at',{ascending:false})
   ]);
   if(error||rErr)throw error||rErr;
   return json(res,200,{apps:(apps||[]).map(a=>({...a,reports:(reports||[]).filter(r=>r.app_id===a.id)}))});
  }
  const {id,status,isFeatured,adminNote,isVerified,reportStatus}=req.body||{};
  if(!id)return json(res,400,{error:'Missing app id'});
  if(reportStatus){
   if(!['reviewed','dismissed','resolved'].includes(reportStatus))return json(res,400,{error:'Invalid report status'});
   const {error}=await supabase.from('app_reports').update({status:reportStatus,reviewed_by:user.id,reviewed_at:new Date().toISOString()}).eq('app_id',id).eq('status','open');
   if(error)throw error;return json(res,200,{updated:true});
  }
  const patch={};
  if(status!=null){if(!['pending','published','rejected','suspended'].includes(status))return json(res,400,{error:'Invalid review action'});const note=cleanText(adminNote,500);if(status==='rejected'&&note.length<8)return json(res,400,{error:'Write a clear rejection reason'});Object.assign(patch,{status,admin_note:status==='rejected'?note:'',published_at:status==='published'?new Date().toISOString():null});}
  if(isFeatured!=null)patch.is_featured=Boolean(isFeatured);
  if(isVerified!=null)Object.assign(patch,{is_verified:Boolean(isVerified),verified_at:isVerified?new Date().toISOString():null,verified_by:isVerified?user.id:null});
  if(!Object.keys(patch).length)return json(res,400,{error:'No changes supplied'});
  const {data,error}=await supabase.from('apps').update(patch).eq('id',id).select('*').single();if(error)throw error;
  return json(res,200,{app:data});
 }catch(e){return handleError(e,res,'Unable to review apps')}
}

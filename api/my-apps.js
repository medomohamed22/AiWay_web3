import { allowMethods, db, handleError, json, requireUser } from './_lib.js';
export default async function handler(req,res){
  if(!allowMethods(req,res,['GET']))return;
  try{
    const user=await requireUser(req),supabase=db();
    const {data,error}=await supabase.from('apps').select('*').eq('owner_id',user.id).order('created_at',{ascending:false});
    if(error)throw error;
    const ids=(data||[]).map(x=>x.id);
    let reports=[];
    if(ids.length){const r=await supabase.from('app_reports').select('app_id,status').in('app_id',ids);if(r.error)throw r.error;reports=r.data||[]}
    const apps=(data||[]).map(app=>({...app,open_reports_count:reports.filter(r=>r.app_id===app.id&&r.status==='open').length,total_reports_count:reports.filter(r=>r.app_id===app.id).length}));
    return json(res,200,{apps});
  }catch(e){return handleError(e,res,'Unable to load your apps')}
}

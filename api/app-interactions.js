import { allowMethods, cleanText, db, handleError, json, requireUser } from './_lib.js';

const REPORT_REASONS=['not_working','scam','wrong_link','impersonation','inappropriate','other'];

export default async function handler(req,res){
  if(!allowMethods(req,res,['GET','POST']))return;
  try{
    const supabase=db();
    if(req.method==='GET'){
      const user=await requireUser(req);
      const appId=String(req.query?.appId||'');
      if(!appId)return json(res,400,{error:'Missing app id'});
      const {data,error}=await supabase.from('app_ratings').select('stars').eq('app_id',appId).eq('user_id',user.id).maybeSingle();
      if(error)throw error;
      return json(res,200,{stars:data?.stars||0});
    }
    const body=req.body||{};
    const action=String(body.action||'');
    const appId=String(body.appId||'');
    if(!appId)return json(res,400,{error:'Missing app id'});
    const {data:app,error:appError}=await supabase.from('apps').select('id,status').eq('id',appId).maybeSingle();
    if(appError)throw appError;
    if(!app||app.status!=='published')return json(res,404,{error:'App not found'});

    if(action==='view'||action==='get_click'){
      const visitorId=cleanText(body.visitorId,100);
      if(!/^[a-zA-Z0-9_-]{16,100}$/.test(visitorId))return json(res,400,{error:'Invalid visitor id'});
      const {error}=await supabase.from('app_events').insert({app_id:appId,visitor_id:visitorId,event_type:action});
      if(error&&error.code!=='23505')throw error;
      const {data:counts}=await supabase.from('apps').select('views_count,get_clicks_count').eq('id',appId).single();
      return json(res,200,{recorded:!error,counts});
    }

    const user=await requireUser(req);
    if(action==='rate'){
      const stars=Number(body.stars);
      if(!Number.isInteger(stars)||stars<1||stars>5)return json(res,400,{error:'Choose 1 to 5 stars'});
      const {error}=await supabase.from('app_ratings').upsert({app_id:appId,user_id:user.id,stars},{onConflict:'app_id,user_id'});
      if(error)throw error;
      const {data:rating}=await supabase.from('apps').select('rating,ratings_count').eq('id',appId).single();
      return json(res,200,{rating,userStars:stars});
    }
    if(action==='report'){
      const reason=String(body.reason||'');
      if(!REPORT_REASONS.includes(reason))return json(res,400,{error:'Choose a report reason'});
      const details=cleanText(body.details,500);
      const {error}=await supabase.from('app_reports').upsert({app_id:appId,reporter_id:user.id,reason,details,status:'open',reviewed_by:null,reviewed_at:null},{onConflict:'app_id,reporter_id'});
      if(error)throw error;
      return json(res,200,{reported:true});
    }
    return json(res,400,{error:'Invalid action'});
  }catch(error){return handleError(error,res,'Unable to save interaction')}
}

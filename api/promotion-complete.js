import { allowMethods, db, handleError, json, requireUser } from './_lib.js';

const plans = new Map([[3,10],[14,20],[30,30]]);

export default async function handler(req,res){
  if(!allowMethods(req,res,['POST']))return;
  try{
    const user=await requireUser(req);
    const {paymentId,txid,appId,days,amountPi}=req.body||{};
    const planDays=Number(days), expected=plans.get(planDays);
    if(!paymentId||!txid||!appId||!expected||Number(amountPi)!==expected)return json(res,400,{error:'Invalid promotion plan'});
    const supabase=db();
    const {data:app,error:appError}=await supabase.from('apps').select('id,owner_id,status,featured_until').eq('id',appId).eq('owner_id',user.id).single();
    if(appError||!app)return json(res,404,{error:'App not found'});
    if(app.status!=='published')return json(res,400,{error:'Only published apps can be promoted'});
    const {data:payment,error:paymentError}=await supabase.from('payments').select('*').eq('payment_id',paymentId).eq('user_id',user.id).maybeSingle();
    if(paymentError)throw paymentError;
    const purpose=`feature_${planDays}_days`;
    if(!payment||payment.purpose!==purpose||Number(payment.amount_pi)!==expected)return json(res,400,{error:'Payment was not approved for this promotion'});
    if(payment.status==='completed')return json(res,200,{completed:true,alreadyCompleted:true});
    const key=process.env.PI_SECRET_KEY;if(!key)throw new Error('PI_SECRET_KEY is not configured');
    const piRes=await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}/complete`,{method:'POST',headers:{Authorization:`Key ${key}`,'Content-Type':'application/json'},body:JSON.stringify({txid})});
    const piData=await piRes.json().catch(()=>null);
    if(!piRes.ok)return json(res,piRes.status,{error:piData?.error||piData||'Pi complete request failed'});
    const now=new Date();
    const current=app.featured_until&&new Date(app.featured_until)>now?new Date(app.featured_until):now;
    current.setUTCDate(current.getUTCDate()+planDays);
    const {data:updated,error:updateError}=await supabase.from('apps').update({is_featured:true,featured_until:current.toISOString()}).eq('id',app.id).eq('owner_id',user.id).select('*').single();
    if(updateError)throw updateError;
    const {error:payUpdateError}=await supabase.from('payments').update({app_id:app.id,txid,status:'completed',raw_response:piData,completed_at:new Date().toISOString()}).eq('payment_id',paymentId).eq('user_id',user.id);
    if(payUpdateError)throw payUpdateError;
    return json(res,200,{completed:true,app:updated});
  }catch(e){return handleError(e,res,'Unable to activate promotion')}
}

import {allowMethods,db,handleError,json,PACKAGES,requireUser} from './_lib.js';

const piHeaders=()=>({Authorization:`Key ${process.env.PI_SECRET_KEY}`,'Content-Type':'application/json'});

async function getPiPayment(paymentId){
  const response=await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}`,{headers:piHeaders()});
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(data?.error_message||data?.message||'Unable to read Pi payment');
  return data;
}

export default async function handler(req,res){
  if(!allowMethods(req,res,['POST']))return;
  try{
    const user=await requireUser(req);
    let {paymentId,txid,packageId,recover}=req.body||{};
    if(!paymentId)return json(res,400,{error:'Invalid payment'});

    const s=db();
    let {data:p}=await s.from('payments').select('*').eq('payment_id',paymentId).eq('user_id',user.id).maybeSingle();
    if(p?.status==='completed')return json(res,200,{completed:true,tokens:p.ai_tokens,alreadyCompleted:true});

    let remote=null;
    if(recover||!p||!txid||!packageId){
      remote=await getPiPayment(paymentId);
      packageId=packageId||remote?.metadata?.packageId||remote?.metadata?.package_id;
      txid=txid||remote?.transaction?.txid;
    }

    const pack=PACKAGES[packageId];
    if(!pack)return json(res,400,{error:'تعذر تحديد باقة الدفعة المعلقة'});
    if(!txid)return json(res,409,{error:'الدفعة موجودة لكنها لم تصل بعد إلى الشبكة. افتح المحفظة وأكملها ثم اضغط إنهاء الدفعات المعلقة'});

    if(!p){
      const amountPi=Number(remote?.amount||0);
      const {error:insertError}=await s.from('payments').upsert({
        user_id:user.id,
        payment_id:paymentId,
        package_id:packageId,
        amount_pi:amountPi||null,
        usd_amount:pack.usd,
        pi_usd_rate:amountPi>0?Number((pack.usd/amountPi).toFixed(8)):null,
        ai_tokens:pack.tokens,
        status:'approved',
        raw_response:remote
      },{onConflict:'payment_id'});
      if(insertError)throw insertError;
      ({data:p}=await s.from('payments').select('*').eq('payment_id',paymentId).eq('user_id',user.id).single());
    }

    if(p.package_id!==packageId)return json(res,400,{error:'بيانات الباقة لا تطابق الدفعة'});

    const response=await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}/complete`,{
      method:'POST',headers:piHeaders(),body:JSON.stringify({txid})
    });
    const data=await response.json().catch(()=>null);
    if(!response.ok){
      const message=data?.error_message||data?.message||'';
      if(!/already|completed/i.test(message))return json(res,response.status,{error:message||'Pi completion failed'});
    }

    const {error}=await s.rpc('complete_token_purchase',{
      p_user_id:user.id,p_payment_id:paymentId,p_txid:txid,p_tokens:p.ai_tokens,p_raw:data||remote||{}
    });
    if(error){
      if(/already completed|not approved/i.test(error.message||'')){
        const {data:done}=await s.from('payments').select('status,ai_tokens').eq('payment_id',paymentId).eq('user_id',user.id).maybeSingle();
        if(done?.status==='completed')return json(res,200,{completed:true,tokens:done.ai_tokens,alreadyCompleted:true});
      }
      throw error;
    }
    return json(res,200,{completed:true,tokens:p.ai_tokens,recovered:Boolean(recover)});
  }catch(e){return handleError(e,res,'Unable to complete payment')}
}

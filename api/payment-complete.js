import { allowMethods, appError, db, fetchWithTimeout, handleError, json, localize, PACKAGES, piApiError, requestLocale, requireUser, requestIp, enforceRateLimit } from './_lib.js';
const piHeaders=()=>({Authorization:`Key ${process.env.PI_SECRET_KEY}`,'Content-Type':'application/json'});
async function getPiPayment(paymentId){const r=await fetchWithTimeout(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}`,{headers:piHeaders()},20000);const d=await r.json().catch(()=>null);if(!r.ok)throw piApiError(r.status,d,{operation:'payment'});return d;}
function owner(r){return String(r?.user_uid||r?.user?.uid||r?.metadata?.pi_uid||'');}
function pkg(r){return String(r?.metadata?.packageId||r?.metadata?.package_id||'');}
function closeEnough(a,b){const x=Number(a),y=Number(b);return Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x-y)<=Math.max(0.0000001,y*0.000001);}
export default async function handler(req,res){
 if(!allowMethods(req,res,['POST']))return;const locale=requestLocale(req);
 try{
  const user=await requireUser(req);await enforceRateLimit(db(),`payment:${user.id}:${requestIp(req)}`,12,60);const paymentId=String(req.body?.paymentId||'').trim();if(!paymentId)throw appError('PAYMENT_INVALID');if(!process.env.PI_SECRET_KEY)throw appError('MISSING_CONFIGURATION');
  const supabase=db();const found=await supabase.from('payments').select('*').eq('payment_id',paymentId).maybeSingle();if(found.error)throw appError('DATABASE_ERROR',{},found.error);const payment=found.data;
  if(!payment||payment.user_id!==user.id)throw appError('PAYMENT_MISMATCH');if(payment.status==='completed')return json(res,200,{completed:true,tokens:payment.ai_tokens,alreadyCompleted:true});
  const remote=await getPiPayment(paymentId);const remotePackage=pkg(remote);const remoteTx=String(remote?.transaction?.txid||'');
  if(remotePackage!==payment.package_id||!PACKAGES[remotePackage])throw appError('PAYMENT_MISMATCH');
  const remoteOwner=owner(remote);if(remoteOwner&&remoteOwner!==String(user.pi_uid))throw appError('PAYMENT_MISMATCH');
  if(!closeEnough(remote.amount,payment.amount_pi)||Number(payment.ai_tokens)!==Number(PACKAGES[remotePackage].tokens))throw appError('PAYMENT_MISMATCH');
  if(!remoteTx)throw appError('PAYMENT_PENDING');
  const clientTx=String(req.body?.txid||'');if(clientTx&&clientTx!==remoteTx)throw appError('PAYMENT_MISMATCH');
  const response=await fetchWithTimeout(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}/complete`,{method:'POST',headers:piHeaders(),body:JSON.stringify({txid:remoteTx})},20000);
  const data=await response.json().catch(()=>null);if(!response.ok&&!/already|completed/i.test(String(data?.error_message||data?.message||'')))throw piApiError(response.status,data,{operation:'payment'});
  const {error}=await supabase.rpc('complete_token_purchase',{p_user_id:user.id,p_payment_id:paymentId,p_txid:remoteTx,p_tokens:payment.ai_tokens,p_raw:{completion:data,payment:remote}});
  if(error){const done=await supabase.from('payments').select('status,ai_tokens').eq('payment_id',paymentId).eq('user_id',user.id).maybeSingle();if(done.data?.status==='completed')return json(res,200,{completed:true,tokens:done.data.ai_tokens,alreadyCompleted:true});throw appError('DATABASE_ERROR',{},error);}
  return json(res,200,{completed:true,tokens:payment.ai_tokens});
 }catch(error){return handleError(error,res,localize(locale,'تعذر إكمال الدفع عبر Pi. حاول مرة أخرى.','Could not complete the Pi payment. Try again.'),locale);}
}

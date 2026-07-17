import { allowMethods, appError, db, fetchWithTimeout, handleError, json, localize, PACKAGES, piApiError, requestLocale, requireUser, requestIp, enforceRateLimit } from './_lib.js';
const piHeaders=()=>({Authorization:`Key ${process.env.PI_SECRET_KEY}`,'Content-Type':'application/json'});
async function getPiPayment(paymentId){const r=await fetchWithTimeout(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}`,{headers:piHeaders()},20000);const d=await r.json().catch(()=>null);if(!r.ok)throw piApiError(r.status,d,{operation:'payment'});return d;}
function owner(r){return String(r?.user_uid||r?.user?.uid||r?.metadata?.pi_uid||'');}
function pkg(r){return String(r?.metadata?.packageId||r?.metadata?.package_id||'');}
function closeEnough(a,b){const x=Number(a),y=Number(b);return Number.isFinite(x)&&Number.isFinite(y)&&Math.abs(x-y)<=0.00000011;}
function norm(v){return String(v||'').trim();}
function mismatch(reason,details={}){console.error('[PAYMENT_MISMATCH]',{reason,...details});throw appError('PAYMENT_MISMATCH');}
export default async function handler(req,res){
 if(!allowMethods(req,res,['POST']))return;const locale=requestLocale(req);
 try{
  const user=await requireUser(req);await enforceRateLimit(db(),`payment:${user.id}:${requestIp(req)}`,12,60);const paymentId=String(req.body?.paymentId||'').trim();if(!paymentId)throw appError('PAYMENT_INVALID');if(!process.env.PI_SECRET_KEY)throw appError('MISSING_CONFIGURATION');
  const supabase=db();const found=await supabase.from('payments').select('*').eq('payment_id',paymentId).maybeSingle();if(found.error)throw appError('DATABASE_ERROR',{},found.error);const payment=found.data;
  if(!payment)mismatch('PAYMENT_NOT_FOUND',{paymentId,userId:user.id});
  if(norm(payment.user_id)!==norm(user.id))mismatch('PAYMENT_OWNER_DB',{paymentId,storedUserId:payment.user_id,currentUserId:user.id});if(payment.status==='completed')return json(res,200,{completed:true,tokens:payment.ai_tokens,alreadyCompleted:true});
  const remote=await getPiPayment(paymentId);const remotePackage=pkg(remote);const remoteTx=String(remote?.transaction?.txid||'');
  if(remotePackage!==norm(payment.package_id)||!PACKAGES[remotePackage])mismatch('PACKAGE',{paymentId,remotePackage,storedPackage:payment.package_id});
  const remoteOwner=owner(remote);if(remoteOwner&&norm(remoteOwner)!==norm(user.pi_uid))mismatch('PI_OWNER',{paymentId,remoteOwner,currentPiUid:user.pi_uid});
  if(!closeEnough(remote.amount,payment.amount_pi))mismatch('AMOUNT',{paymentId,remoteAmount:remote.amount,storedAmount:payment.amount_pi});
  if(Number(payment.ai_tokens)!==Number(PACKAGES[remotePackage].tokens))mismatch('TOKENS',{paymentId,storedTokens:payment.ai_tokens,expectedTokens:PACKAGES[remotePackage].tokens});
  if(!remoteTx)throw appError('PAYMENT_PENDING');
  const clientTx=norm(req.body?.txid);
  // Pi's server response is the source of truth. Some SDK versions/callbacks may format
  // or delay the callback txid differently, so a mismatch is logged but never trusted
  // to override the verified server-side transaction id.
  if(clientTx&&clientTx.toLowerCase()!==norm(remoteTx).toLowerCase())console.warn('[PAYMENT_TXID_CALLBACK_DIFFERENCE]',{paymentId,clientTx,remoteTx});
  const response=await fetchWithTimeout(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}/complete`,{method:'POST',headers:piHeaders(),body:JSON.stringify({txid:remoteTx})},20000);
  const data=await response.json().catch(()=>null);if(!response.ok&&!/already|completed/i.test(String(data?.error_message||data?.message||'')))throw piApiError(response.status,data,{operation:'payment'});
  const {error}=await supabase.rpc('complete_token_purchase',{p_user_id:user.id,p_payment_id:paymentId,p_txid:remoteTx,p_tokens:payment.ai_tokens,p_raw:{completion:data,payment:remote}});
  if(error){const done=await supabase.from('payments').select('status,ai_tokens').eq('payment_id',paymentId).eq('user_id',user.id).maybeSingle();if(done.data?.status==='completed')return json(res,200,{completed:true,tokens:done.data.ai_tokens,alreadyCompleted:true});throw appError('DATABASE_ERROR',{},error);}
  return json(res,200,{completed:true,tokens:payment.ai_tokens});
 }catch(error){return handleError(error,res,localize(locale,'تعذر إكمال الدفع عبر Pi. حاول مرة أخرى.','Could not complete the Pi payment. Try again.'),locale);}
}

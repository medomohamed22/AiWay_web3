import { allowMethods, appError, db, fetchWithTimeout, handleError, json, localize, PACKAGES, piApiError, requestLocale, requireUser } from './_lib.js';

const piHeaders = () => ({ Authorization: `Key ${process.env.PI_SECRET_KEY}`, 'Content-Type': 'application/json' });

async function getPiPayment(paymentId) {
  const response = await fetchWithTimeout(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}`, { headers: piHeaders() }, 20000);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    console.error('Unable to read Pi payment:', response.status, data);
    throw piApiError(response.status, data, { operation: 'payment' });
  }
  return data;
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  const locale = requestLocale(req);
  try {
    const user = await requireUser(req);
    let { paymentId, txid, packageId, recover } = req.body || {};
    if (!paymentId) throw appError('PAYMENT_INVALID');
    if (!process.env.PI_SECRET_KEY) throw appError('MISSING_CONFIGURATION');

    const supabase = db();
    let paymentResult = await supabase.from('payments').select('*')
      .eq('payment_id', paymentId).eq('user_id', user.id).maybeSingle();
    if (paymentResult.error) throw appError('DATABASE_ERROR', {}, paymentResult.error);
    let payment = paymentResult.data;
    if (payment?.status === 'completed') return json(res, 200, { completed: true, tokens: payment.ai_tokens, alreadyCompleted: true });

    let remote = null;
    if (recover || !payment || !txid || !packageId) {
      remote = await getPiPayment(paymentId);
      packageId = packageId || remote?.metadata?.packageId || remote?.metadata?.package_id;
      txid = txid || remote?.transaction?.txid;
    }

    const pack = PACKAGES[packageId];
    if (!pack) throw appError('PAYMENT_INVALID');
    if (!txid) throw appError('PAYMENT_PENDING');

    if (!payment) {
      const amountPi = Number(remote?.amount || 0);
      const { error: insertError } = await supabase.from('payments').upsert({
        user_id: user.id,
        payment_id: paymentId,
        package_id: packageId,
        amount_pi: amountPi || null,
        usd_amount: pack.usd,
        pi_usd_rate: amountPi > 0 ? Number((pack.usd / amountPi).toFixed(8)) : null,
        ai_tokens: pack.tokens,
        status: 'approved',
        raw_response: remote
      }, { onConflict: 'payment_id' });
      if (insertError) throw appError('DATABASE_ERROR', {}, insertError);
      paymentResult = await supabase.from('payments').select('*')
        .eq('payment_id', paymentId).eq('user_id', user.id).single();
      if (paymentResult.error || !paymentResult.data) throw appError('DATABASE_ERROR', {}, paymentResult.error);
      payment = paymentResult.data;
    }

    if (payment.package_id !== packageId) throw appError('PAYMENT_INVALID');

    const response = await fetchWithTimeout(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}/complete`, {
      method: 'POST', headers: piHeaders(), body: JSON.stringify({ txid })
    }, 20000);
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const providerMessage = String(data?.error_message || data?.message || '');
      if (!/already|completed/i.test(providerMessage)) {
        console.error('Pi completion failed:', response.status, data);
        throw piApiError(response.status, data, { operation: 'payment' });
      }
    }

    const { error } = await supabase.rpc('complete_token_purchase', {
      p_user_id: user.id,
      p_payment_id: paymentId,
      p_txid: txid,
      p_tokens: payment.ai_tokens,
      p_raw: data || remote || {}
    });
    if (error) {
      if (/already completed|not approved/i.test(error.message || '')) {
        const { data: done } = await supabase.from('payments').select('status,ai_tokens')
          .eq('payment_id', paymentId).eq('user_id', user.id).maybeSingle();
        if (done?.status === 'completed') return json(res, 200, { completed: true, tokens: done.ai_tokens, alreadyCompleted: true });
      }
      throw appError('DATABASE_ERROR', {}, error);
    }
    return json(res, 200, { completed: true, tokens: payment.ai_tokens, recovered: Boolean(recover) });
  } catch (error) {
    return handleError(error, res, localize(locale, 'تعذر إكمال الدفع عبر Pi. حاول مرة أخرى.', 'Could not complete the Pi payment. Try again.'), locale);
  }
}

import { allowMethods, appError, db, fetchWithTimeout, handleError, json, localize, packageQuote, piApiError, requestLocale, requireUser } from './_lib.js';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  const locale = requestLocale(req);
  try {
    const user = await requireUser(req);
    const { paymentId, packageId } = req.body || {};
    const quote = await packageQuote(packageId);
    if (!paymentId || !quote) throw appError('PAYMENT_INVALID');
    if (!process.env.PI_SECRET_KEY) throw appError('MISSING_CONFIGURATION');

    const response = await fetchWithTimeout(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}/approve`, {
      method: 'POST',
      headers: { Authorization: `Key ${process.env.PI_SECRET_KEY}`, 'Content-Type': 'application/json' }
    }, 20000);
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      console.error('Pi approval failed:', response.status, data);
      throw piApiError(response.status, data, { operation: 'payment' });
    }

    const { error } = await db().from('payments').upsert({
      user_id: user.id,
      payment_id: paymentId,
      package_id: packageId,
      amount_pi: quote.amountPi,
      usd_amount: quote.usd,
      pi_usd_rate: quote.piUsd,
      ai_tokens: quote.tokens,
      status: 'approved',
      raw_response: data
    }, { onConflict: 'payment_id' });
    if (error) throw appError('DATABASE_ERROR', {}, error);
    return json(res, 200, { approved: true, amountPi: quote.amountPi });
  } catch (error) {
    return handleError(error, res, localize(locale, 'تعذر اعتماد الدفعة عبر Pi. حاول مرة أخرى.', 'Could not approve the Pi payment. Try again.'), locale);
  }
}

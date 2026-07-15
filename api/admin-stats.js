import { allowMethods, db, json, requireAdminToken, MARKUP, getPiUsd } from './_lib.js';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    await requireAdminToken(req);
    const s = db();
    const [{ count: users }, { count: buyers }, { count: purchaseRequests }, paymentsResult] = await Promise.all([
      s.from('users').select('*', { count: 'exact', head: true }).eq('role', 'user'),
      s.from('users').select('*', { count: 'exact', head: true }).eq('role', 'user').eq('has_purchased', true),
      s.from('payments').select('*', { count: 'exact', head: true }),
      s.from('payments').select('amount_pi,usd_amount,status,package_id,created_at').eq('status', 'completed')
    ]);
    if (paymentsResult.error) throw paymentsResult.error;
    const completed = paymentsResult.data || [];
    const totalPi = completed.reduce((n, p) => n + Number(p.amount_pi || 0), 0);
    const totalUsd = completed.reduce((n, p) => n + Number(p.usd_amount || 0), 0);
    const openRouterRechargeUsd = totalUsd / MARKUP;
    const profitUsd = totalUsd - openRouterRechargeUsd;
    const profitPi = totalPi * (1 - 1 / MARKUP);
    let currentPiUsd = null;
    try { currentPiUsd = await getPiUsd(); } catch {}
    return json(res, 200, {
      users: users || 0,
      buyers: buyers || 0,
      purchaseRequests: purchaseRequests || 0,
      completedPurchases: completed.length,
      totalPi,
      totalUsd,
      markup: MARKUP,
      profitMarginPercent: (1 - 1 / MARKUP) * 100,
      openRouterRechargeUsd,
      profitUsd,
      profitPi,
      currentPiUsd,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error(error);
    const status = error.message === 'UNAUTHORIZED' ? 401 : error.message === 'FORBIDDEN' ? 403 : 500;
    return json(res, status, { error: status === 500 ? 'Could not load statistics' : 'Admin session expired' });
  }
}

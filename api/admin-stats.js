import { allowMethods, db, json, requireUser, requireAdmin, MARKUP, TOKEN_USD, getPiUsd } from './_lib.js';

const number = value => {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
};


async function fetchAll(queryFactory, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await queryFactory().range(from, from + pageSize - 1);
    if (error) throw error;
    const page = data || [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function providerCostFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const direct = number(usage.providerUsd || usage.cost);
  return direct > 0 ? direct : 0;
}

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['GET'])) return;
  try {
    const user = await requireUser(req);
    requireAdmin(user);
    const s = db();
    const [usersResult, buyersResult, requestsResult, completed, usageRows, balanceRows] = await Promise.all([
      s.from('users').select('*', { count: 'exact', head: true }).eq('role', 'user'),
      s.from('users').select('*', { count: 'exact', head: true }).eq('role', 'user').eq('has_purchased', true),
      s.from('payments').select('*', { count: 'exact', head: true }),
      fetchAll(() => s.from('payments').select('amount_pi,usd_amount,status,package_id,ai_tokens,created_at').eq('status', 'completed').order('created_at', { ascending: true })),
      fetchAll(() => s.from('messages').select('id,token_usage').eq('role', 'assistant').order('id', { ascending: true })),
      fetchAll(() => s.from('users').select('id,ai_tokens').eq('role', 'user').order('id', { ascending: true }))
    ]);

    const totalPi = completed.reduce((sum, row) => sum + number(row.amount_pi), 0);
    const totalUsd = completed.reduce((sum, row) => sum + number(row.usd_amount), 0);
    const issuedPaidTokens = completed.reduce((sum, row) => sum + number(row.ai_tokens), 0);
    const providerCostUsd = usageRows.reduce((sum, row) => sum + providerCostFromUsage(row.token_usage), 0);
    const remainingUserTokens = balanceRows.reduce((sum, row) => sum + number(row.ai_tokens), 0);
    const remainingProviderLiabilityUsd = remainingUserTokens * TOKEN_USD;
    const soldProviderCapacityUsd = issuedPaidTokens * TOKEN_USD;
    const expectedGrossProfitUsd = totalUsd - soldProviderCapacityUsd;
    const realizedGrossProfitUsd = totalUsd - providerCostUsd;
    const realizedGrossProfitPi = totalUsd > 0 && totalPi > 0 ? realizedGrossProfitUsd * (totalPi / totalUsd) : 0;

    let currentPiUsd = null;
    try { currentPiUsd = await getPiUsd(); } catch {}

    return json(res, 200, {
      users: usersResult.count || 0,
      buyers: buyersResult.count || 0,
      purchaseRequests: requestsResult.count || 0,
      completedPurchases: completed.length,
      totalPi,
      totalUsd,
      markup: MARKUP,
      expectedMarkupPercent: (MARKUP - 1) * 100,
      expectedMarginPercent: (1 - 1 / MARKUP) * 100,
      tokenUsd: TOKEN_USD,
      issuedPaidTokens,
      soldProviderCapacityUsd,
      providerCostUsd,
      remainingUserTokens,
      remainingProviderLiabilityUsd,
      expectedGrossProfitUsd,
      realizedGrossProfitUsd,
      realizedGrossProfitPi,
      currentPiUsd,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error(error);
    const status = error.message === 'UNAUTHORIZED' ? 401 : error.message === 'FORBIDDEN' ? 403 : 500;
    return json(res, status, { error: status === 500 ? 'تعذر تحميل الإحصاءات' : 'انتهت جلسة المشرف' });
  }
}

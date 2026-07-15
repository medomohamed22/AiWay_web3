import { allowMethods, db, json, signAdminToken, verifyPassword } from './_lib.js';

export default async function handler(req, res) {
  if (!allowMethods(req, res, ['POST'])) return;
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return json(res, 400, { error: 'Email and password are required' });
    const supabase = db();
    const { data: admin, error } = await supabase.from('admin_accounts').select('id,email,password_hash,display_name,is_active').eq('email', email).maybeSingle();
    if (error) throw error;
    if (!admin?.is_active || !verifyPassword(password, admin.password_hash)) return json(res, 401, { error: 'Invalid admin credentials' });
    await supabase.from('admin_accounts').update({ last_login_at: new Date().toISOString() }).eq('id', admin.id);
    const token = await signAdminToken(admin);
    return json(res, 200, { token, admin: { email: admin.email, displayName: admin.display_name } });
  } catch (error) {
    console.error(error);
    return json(res, 500, { error: 'Admin login failed' });
  }
}

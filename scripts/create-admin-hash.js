import { hashPassword } from '../api/_lib.js';
const password = process.argv[2];
if (!password) { console.error('Usage: node scripts/create-admin-hash.js "StrongPassword"'); process.exit(1); }
console.log(hashPassword(password));

import Database from 'better-sqlite3';
import { getConfig } from '../src/db.js';

const db = new Database(process.env.HOME + '/.prime/prime.db');

const tokens = getConfig(db, 'gmail_tokens');
if (!tokens) {
  console.log('✗ gmail_tokens: NOT SET — Gmail is disconnected');
  console.log('  Fix: Run "npx tsx src/index.ts connect gmail" on the Mac Mini');
} else {
  console.log('✓ gmail_tokens: EXISTS');
  if (typeof tokens === 'object') {
    console.log('  access_token:', tokens.access_token ? `${String(tokens.access_token).slice(0, 20)}...` : 'MISSING');
    console.log('  refresh_token:', tokens.refresh_token ? `${String(tokens.refresh_token).slice(0, 20)}...` : 'MISSING');
    console.log('  expiry_date:', tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : 'MISSING');
    console.log('  token_type:', tokens.token_type || 'MISSING');
    console.log('  scope:', tokens.scope || 'MISSING');
  } else {
    console.log('  Raw value:', String(tokens).slice(0, 100));
  }
}

// Check for service account
const saConfig = getConfig(db, 'gmail_service_account');
console.log('\nService account config:', saConfig ? 'EXISTS' : 'NOT SET');

// Check for multi-account config
const accounts = getConfig(db, 'gmail_accounts');
console.log('Multi-account config:', accounts ? JSON.stringify(accounts).slice(0, 200) : 'NOT SET');

// Check what scanGmail is actually called with in the shift daemon
const connectorConfig = getConfig(db, 'connector_gmail');
console.log('Connector config:', connectorConfig ? JSON.stringify(connectorConfig).slice(0, 200) : 'NOT SET');

db.close();

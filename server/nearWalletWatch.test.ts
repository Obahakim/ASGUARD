import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isValidNearAccountId, NearWalletWatcher, NearWalletWatchStore, registerAgentNearAccounts } from './nearWalletWatch';

test('validates named and implicit NEAR account IDs', () => {
  assert.equal(isValidNearAccountId('bot.near'), true);
  assert.equal(isValidNearAccountId('a'.repeat(64)), true);
  assert.equal(isValidNearAccountId('.bot.near'), false);
  assert.equal(isValidNearAccountId('bot..near'), false);
  assert.equal(isValidNearAccountId('A.near'), false);
});

test('agent connection registers unique public accounts and validates the whole list first', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-agent-connect-test-'));
  const store = new NearWalletWatchStore(path.join(directory, 'watches.json'));
  try {
    const wallets = registerAgentNearAccounts(store, {
      agent_id: 'swap-agent', agent_name: 'Swap Agent', network: 'near:testnet',
      account_ids: ['bot.testnet', 'bot.testnet', 'treasury.testnet'],
    });
    assert.deepEqual(wallets.map((wallet) => wallet.account_id), ['bot.testnet', 'treasury.testnet']);
    assert.equal(store.list('swap-agent').length, 2);
    assert.throws(() => registerAgentNearAccounts(store, {
      agent_id: 'bad-agent', agent_name: 'Bad Agent', network: 'near:testnet', account_ids: ['valid.testnet', 'invalid/account'],
    }), /valid public NEAR account IDs/i);
    assert.equal(store.list('bad-agent').length, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('wallet watches persist registrations, deactivation, and bounded observed activity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-watch-store-'));
  const file = path.join(directory, 'watches.json');
  try {
    const store = new NearWalletWatchStore(file);
    const registered = store.register({ agent_id: 'swap-bot', account_id: 'bot.near', network: 'near:testnet' });
    assert.equal(registered.created, true);
    const duplicate = store.register({ agent_id: 'swap-bot', account_id: 'bot.near', network: 'near:testnet', label: 'Trading bot' });
    assert.equal(duplicate.created, false);
    assert.equal(new NearWalletWatchStore(file).list('swap-bot')[0].label, 'Trading bot');
    assert.ok(store.deactivate(registered.wallet.id));
    assert.equal(new NearWalletWatchStore(file).list()[0].active, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('polls real NEAR RPC response shapes, records matching public transactions, and survives RPC failure', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asguard-watch-poller-'));
  try {
    const store = new NearWalletWatchStore(path.join(directory, 'watches.json'));
    const { wallet } = store.register({ agent_id: 'swap-bot', account_id: 'bot.near', network: 'near:testnet' });
    const auditTypes: string[] = [];
    const watcher = new NearWalletWatcher({
      store, intervalMs: 5_000, audit: (type) => auditTypes.push(type),
      rpc: async (_network, method, params) => {
        if (method === 'status') return { chain_id: 'testnet' };
        if (method === 'block' && params.finality === 'final') return { header: { height: 2 }, chunks: [] };
        if (method === 'block' && params.block_id === 2) return { header: { height: 2 }, chunks: [{ chunk_hash: 'chunk-2' }] };
        if (method === 'block') return { header: { height: params.block_id }, chunks: [] };
        if (method === 'chunk') return {
          transactions: [{ hash: 'tx-public-1', signer_id: 'bot.near', receiver_id: 'dex.near', actions: [{ FunctionCall: {} }] }],
          receipts: [{ receipt_id: 'receipt-public-1', predecessor_id: 'bot.near', receiver_id: 'dex.near', receipt: { Action: { actions: [{ Transfer: {} }] } } }],
        };
        throw new Error(`unexpected method ${method}`);
      },
    });
    await watcher.pollOnce();
    const observed = store.recentActivity({ watch_id: wallet.id });
    assert.equal(observed.length, 1);
    assert.equal(observed[0].transaction_hash, 'tx-public-1');
    assert.equal(observed[0].direction, 'outbound');
    assert.equal(watcher.status().healthy, true);
    assert.ok(auditTypes.includes('wallet_watch_activity'));

    const failing = new NearWalletWatcher({ store, intervalMs: 5_000, audit: (type) => auditTypes.push(type), rpc: async () => { throw new Error('RPC unavailable'); } });
    await failing.pollOnce();
    assert.equal(failing.status().healthy, false);
    assert.match(failing.status().last_error ?? '', /RPC unavailable/);
    assert.ok(auditTypes.includes('wallet_watch_error'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

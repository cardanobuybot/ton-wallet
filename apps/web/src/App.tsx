import { useState } from 'react';
import {
  generateMnemonic,
  getWalletAddress,
  mnemonicToKeyPair,
  type WalletAddress,
} from '@ton-wallet/core';

interface GeneratedWallet {
  // Только память вкладки: никакого localStorage/IndexedDB (правило спринта 0).
  mnemonic: string[];
  address: WalletAddress;
}

export function App() {
  const [wallet, setWallet] = useState<GeneratedWallet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onGenerate() {
    setBusy(true);
    setError(null);
    try {
      const mnemonic = await generateMnemonic();
      const keyPair = await mnemonicToKeyPair(mnemonic);
      const address = getWalletAddress(keyPair, { version: 'v5r1', network: 'testnet' });
      setWallet({ mnemonic, address });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ fontFamily: 'monospace', maxWidth: 640, margin: '2rem auto', padding: 16 }}>
      <p
        style={{
          background: '#b00',
          color: '#fff',
          padding: 8,
          fontWeight: 'bold',
          textAlign: 'center',
        }}
      >
        DEV ONLY — testnet. Не использовать с реальными средствами.
      </p>
      <h1>ton-wallet</h1>
      <button onClick={onGenerate} disabled={busy}>
        {busy ? 'Генерация…' : 'Сгенерировать кошелёк (W5, testnet)'}
      </button>
      {error && <p style={{ color: 'red' }}>Ошибка: {error}</p>}
      {wallet && (
        <>
          <h2>Мнемоника (24 слова)</h2>
          <ol style={{ columns: 2 }}>
            {wallet.mnemonic.map((word, i) => (
              <li key={i}>{word}</li>
            ))}
          </ol>
          <h2>Адрес W5 (testnet)</h2>
          <dl>
            <dt>non-bounceable</dt>
            <dd style={{ wordBreak: 'break-all' }}>{wallet.address.nonBounceable}</dd>
            <dt>bounceable</dt>
            <dd style={{ wordBreak: 'break-all' }}>{wallet.address.bounceable}</dd>
            <dt>raw</dt>
            <dd style={{ wordBreak: 'break-all' }}>{wallet.address.raw}</dd>
          </dl>
        </>
      )}
    </main>
  );
}

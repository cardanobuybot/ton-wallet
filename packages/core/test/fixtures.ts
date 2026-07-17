// Публичные тестовые векторы. НИКОГДА не использовать с реальными средствами.

export const TEST_MNEMONIC =
  'dial equal roof hole bamboo chest stock swear fetch behave fatigue biology increase neglect office shiver regret upset caution jelly shy case helmet cloth'.split(
    ' ',
  );

export const EXPECTED_TESTNET = {
  raw: '0:a13fc2b770396f4dd0984d3bf9098ee7506246e674072dff5fb3092e707fa81b',
  bounceable: 'kQChP8K3cDlvTdCYTTv5CY7nUGJG5nQHLf9fswkucH-oGzKc',
  nonBounceable: '0QChP8K3cDlvTdCYTTv5CY7nUGJG5nQHLf9fswkucH-oG29Z',
};

export const EXPECTED_MAINNET = {
  raw: '0:31b41281f1bee3817f454e39740eac30a0763913fa4f9e24a7d6d178fd322684',
  bounceable: 'EQAxtBKB8b7jgX9FTjl0DqwwoHY5E_pPniSn1tF4_TImhD63',
  nonBounceable: 'UQAxtBKB8b7jgX9FTjl0DqwwoHY5E_pPniSn1tF4_TImhGNy',
};

// v4r2/v3r2: walletId стандартный (698983191), адрес не зависит от сети
export const EXPECTED_V4R2 = {
  raw: '0:e58fd0554dbdb1d19018c253b15efb0edc42d3e00b6cb47ab20aac67986e2005',
  testnetNonBounceable: '0QDlj9BVTb2x0ZAYwlOxXvsO3ELT4AtstHqyCqxnmG4gBTzD',
};

export const EXPECTED_V3R2 = {
  raw: '0:f09893a591e74ee679689425041334fd09144d0a73d81a30c98e7c194aab73f6',
  testnetNonBounceable: '0QDwmJOlkedO5nlolCUEEzT9CRRNCnPYGjDJjnwZSqtz9k9R',
};

// Валидная BIP39-фраза (стандартный тестовый вектор) — должна быть
// невалидной по TON-схеме мнемоники.
export const BIP39_MNEMONIC = [...Array(23).fill('abandon'), 'art'] as string[];

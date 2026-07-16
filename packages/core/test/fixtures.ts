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

// Валидная BIP39-фраза (стандартный тестовый вектор) — должна быть
// невалидной по TON-схеме мнемоники.
export const BIP39_MNEMONIC = [...Array(23).fill('abandon'), 'art'] as string[];

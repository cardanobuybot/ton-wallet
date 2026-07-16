// Единственный Node-полифилл проекта: @ton/crypto ожидает глобальный Buffer.
// Другие Node-полифиллы (crypto, stream, process) запрещены — см. CLAUDE.md.
import { Buffer } from 'buffer';

globalThis.Buffer ??= Buffer;

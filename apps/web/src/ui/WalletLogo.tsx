// Лого grampocket — тёмный кошелёк с торчащей карточкой, на карточке —
// свечной график и подпись GRAM. Инлайн-SVG, ноль зависимостей.
export function WalletLogo(props: { size?: number; radius?: number }) {
  const size = props.size ?? 32;
  const radius = props.radius ?? 22;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="grampocket"
      role="img"
    >
      <defs>
        <linearGradient id="wl-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7c5cff" />
          <stop offset="100%" stopColor="#3e8bff" />
        </linearGradient>
        <linearGradient id="wl-card" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f6f7ff" />
          <stop offset="100%" stopColor="#dadfef" />
        </linearGradient>
        <linearGradient id="wl-wallet" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#252b45" />
          <stop offset="100%" stopColor="#151a2b" />
        </linearGradient>
      </defs>

      <rect width="100" height="100" rx={radius} ry={radius} fill="url(#wl-bg)" />

      {/* Карточка (за кошельком, торчит сверху) */}
      <g>
        <rect x="25" y="16" width="50" height="50" rx="6" fill="url(#wl-card)" />
        {/* Свечи на карточке */}
        <g strokeLinecap="round">
          <line x1="35" y1="44" x2="35" y2="55" stroke="#8b92b6" strokeWidth="1.2" />
          <rect x="32" y="46" width="6" height="8" rx="1" fill="#3ddc97" />
          <line x1="48" y1="35" x2="48" y2="55" stroke="#8b92b6" strokeWidth="1.2" />
          <rect x="45" y="39" width="6" height="14" rx="1" fill="#ff6b7a" />
          <line x1="61" y1="28" x2="61" y2="55" stroke="#8b92b6" strokeWidth="1.2" />
          <rect x="58" y="31" width="6" height="17" rx="1" fill="#3ddc97" />
        </g>
        {/* Мини-подпись */}
        <text
          x="50"
          y="62"
          textAnchor="middle"
          fontSize="7"
          fontWeight="800"
          letterSpacing="0.5"
          fill="#7c5cff"
          fontFamily="Manrope, -apple-system, sans-serif"
        >
          GRAM
        </text>
      </g>

      {/* Кошелёк — тёмный корпус поверх нижней части карточки */}
      <g>
        <rect x="8" y="58" width="84" height="34" rx="9" fill="url(#wl-wallet)" />
        {/* Верхний срез: тень «щели» */}
        <rect x="14" y="57" width="72" height="2.5" rx="1.2" fill="#000" fillOpacity="0.7" />
        {/* Тонкая строчка-шов */}
        <rect x="8" y="64" width="84" height="1" fill="#ffffff" fillOpacity="0.07" />
        {/* Застёжка */}
        <circle cx="76" cy="77" r="4" fill="#3e8bff" />
        <circle cx="76" cy="77" r="1.6" fill="#7c5cff" />
      </g>
    </svg>
  );
}

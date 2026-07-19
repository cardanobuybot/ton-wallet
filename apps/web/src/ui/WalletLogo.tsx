// Лого grampocket — минималистичный кошелёк одной линией (outline) на
// градиентном round-square фоне. Никаких свечей. Инлайн-SVG, без деп.
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
      </defs>

      <rect width="100" height="100" rx={radius} ry={radius} fill="url(#wl-bg)" />

      {/* Кошелёк — тонкой белой обводкой */}
      <g
        fill="none"
        stroke="#ffffff"
        strokeWidth="4"
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        {/* Корпус */}
        <rect x="20" y="30" width="60" height="44" rx="7" />
        {/* Клапан-крышка (верхняя треть с изгибом) */}
        <path d="M 20 44 L 80 44" />
        {/* Кармашек-застёжка справа */}
        <rect x="56" y="54" width="18" height="10" rx="2.5" />
      </g>
    </svg>
  );
}

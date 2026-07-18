// Лого grampocket — три биржевые свечи (bull/bear/bull) на градиентном
// закруглённом фоне. Инлайн-SVG, ноль зависимостей.
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

      {/* фитили */}
      <line x1="24" y1="30" x2="24" y2="70" stroke="#eef0fb" strokeWidth="2" strokeOpacity="0.85" strokeLinecap="round" />
      <line x1="50" y1="22" x2="50" y2="82" stroke="#eef0fb" strokeWidth="2" strokeOpacity="0.85" strokeLinecap="round" />
      <line x1="76" y1="18" x2="76" y2="72" stroke="#eef0fb" strokeWidth="2" strokeOpacity="0.85" strokeLinecap="round" />

      {/* тела свечей: bull(зелёная маленькая) → bear(красная средняя) → bull(зелёная большая) */}
      <rect x="18" y="42" width="12" height="20" rx="2.5" fill="#3ddc97" />
      <rect x="44" y="34" width="12" height="36" rx="2.5" fill="#ff6b7a" />
      <rect x="70" y="26" width="12" height="42" rx="2.5" fill="#3ddc97" />
    </svg>
  );
}

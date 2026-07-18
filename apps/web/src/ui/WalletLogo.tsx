// Лого grampocket — бумажник с торчащими из его прорези тремя биржевыми
// свечами (bull/bear/bull). Инлайн-SVG, ноль зависимостей.
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
        <linearGradient id="wl-wallet" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f3f4ff" />
          <stop offset="100%" stopColor="#c9cff0" />
        </linearGradient>
      </defs>

      <rect width="100" height="100" rx={radius} ry={radius} fill="url(#wl-bg)" />

      {/* Свечи (позади кошелька, нижняя часть будет скрыта его корпусом) */}
      <g>
        {/* wick + body: bull (маленькая зелёная) */}
        <line x1="27" y1="24" x2="27" y2="70" stroke="#ffffff" strokeWidth="2" strokeOpacity="0.9" strokeLinecap="round" />
        <rect x="21" y="34" width="12" height="30" rx="2.5" fill="#3ddc97" />
        {/* wick + body: bear (средняя красная) */}
        <line x1="50" y1="16" x2="50" y2="70" stroke="#ffffff" strokeWidth="2" strokeOpacity="0.9" strokeLinecap="round" />
        <rect x="44" y="26" width="12" height="38" rx="2.5" fill="#ff6b7a" />
        {/* wick + body: bull (большая зелёная) */}
        <line x1="73" y1="10" x2="73" y2="70" stroke="#ffffff" strokeWidth="2" strokeOpacity="0.9" strokeLinecap="round" />
        <rect x="67" y="20" width="12" height="44" rx="2.5" fill="#3ddc97" />
      </g>

      {/* Кошелёк-корпус, поверх свечей — скрывает их нижнюю часть */}
      <g>
        <rect x="10" y="60" width="80" height="32" rx="7" ry="7" fill="url(#wl-wallet)" />
        {/* Прорезь-щель, из которой «торчат» свечи */}
        <rect x="16" y="59" width="68" height="3" rx="1.5" fill="#0a0c14" fillOpacity="0.55" />
        {/* Кармашек-застёжка справа */}
        <rect x="60" y="74" width="24" height="9" rx="2.5" fill="#0a0c14" fillOpacity="0.14" />
        {/* Точка-кнопка на застёжке */}
        <circle cx="76" cy="78.5" r="2" fill="#3e8bff" />
      </g>
    </svg>
  );
}

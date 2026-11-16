/**
 * The landing signature: a small two-layer USB board rendered the way a board viewer shows it.
 * Solder mask, plated holes, copper under mask, silkscreen, back-layer traces through vias,
 * and the USB pair highlighted as the selected net with a signal travelling it.
 * Pure SVG + CSS; under reduced motion it is shown complete and still.
 */

type Trace = { d: string; w?: number; net?: 'usb' | 'pwr'; layer?: 'B' };

// 45°-mitred routing on a 0.5-unit grid. Pads are placed at the endpoints below.
const TRACES: Trace[] = [
  // USB differential pair: J1 → U1 (the highlighted net)
  { d: 'M104 206 H190 L196.5 199.5 H262', net: 'usb', w: 3 },
  { d: 'M104 218 H192 L196.5 213.5 H262', net: 'usb', w: 3 },
  // VBUS → regulator, 3V3 → MCU and decoupling
  { d: 'M104 182 H128 L152 158 V124', net: 'pwr', w: 6 },
  { d: 'M168 124 V136 L180 148 H346 V155', net: 'pwr', w: 5 },
  { d: 'M262 148 V155', net: 'pwr', w: 5 },
  { d: 'M303.5 148 V172', net: 'pwr', w: 4 },
  // MCU → header
  { d: 'M338 192.5 H392 L404.5 180 H508' },
  { d: 'M338 206.5 H400 L403.5 210 H508' },
  { d: 'M338 220.5 H388 L407.5 240 H508' },
  { d: 'M338 234.5 H374 L409.5 270 H508' },
  // LED: MCU → R1 → D1
  { d: 'M338 185.5 H360 L392 153.5 V124.5 L402 114.5 H412' },
  { d: 'M428 114.5 H450' },
  // Crystal and load caps
  { d: 'M296.5 248 V276 L288 284.5 V292' },
  { d: 'M303.5 248 V276 L312 284.5 V292' },
  { d: 'M282 300 H272' },
  { d: 'M318 300 H328' },
  // Reset: switch → via → MCU (back copper)
  { d: 'M182 322 H224 L265 281', layer: 'B' },
  { d: 'M265 281 L282.5 263.5 V248' },
  // Header 3V3 return on the back
  { d: 'M508 150 H496 L468 122 V76 H206 L188 94', layer: 'B', w: 4 },
  { d: 'M188 94 V140 L180 148', net: 'pwr', w: 4 },
];

const VIAS: [number, number][] = [
  [265, 281], [188, 94], [240, 176], [362, 252], [232, 252], [382, 132], [470, 334], [120, 262], [428, 302], [246, 300], [354, 300], [480, 114.5], [262, 172], [346, 172], [494, 318], [212, 340], [420, 72], [140, 96],
];

const QFN_OFFSETS = [-24.5, -17.5, -10.5, -3.5, 3.5, 10.5, 17.5, 24.5];

const MASK = '#103b28';
const COPPER = '#2c7a50'; // copper seen through green mask
const BACK = '#c9962f';
const PAD = '#d9ad55'; // ENIG gold
const SILK = '#ebe7dd';

function Cap({ x, y, vertical, label, lx, ly }: { x: number; y: number; vertical?: boolean; label: string; lx: number; ly: number }) {
  return (
    <g className="bd-part">
      <g transform={`translate(${x} ${y}) ${vertical ? 'rotate(90)' : ''}`}>
        <rect x={-10} y={-4} width={6} height={8} fill={PAD} />
        <rect x={4} y={-4} width={6} height={8} fill={PAD} />
        <rect x={-5} y={-3} width={10} height={6} fill="#bfa77a" />
        <rect x={-6} y={-3} width={2} height={6} fill="#c9ccd0" />
        <rect x={4} y={-3} width={2} height={6} fill="#c9ccd0" />
      </g>
      <text x={lx} y={ly} className="bd-silk-text">
        {label}
      </text>
    </g>
  );
}

export function BoardDrawing({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 600 420"
      className={className}
      role="img"
      aria-label="A small two-layer USB board: USB-C connector, QFN microcontroller, crystal, regulator, decoupling capacitors, LED, reset switch and a 6-pin header, joined by 45-degree routed traces. The USB data pair is highlighted."
    >
      <defs>
        <pattern id="bd-pour" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="5" stroke="#1c5a3b" strokeWidth="1" />
        </pattern>
        <linearGradient id="bd-mask" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#14482f" />
          <stop offset="1" stopColor={MASK} />
        </linearGradient>
        <linearGradient id="bd-metal" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d9dde1" />
          <stop offset="1" stopColor="#8f959b" />
        </linearGradient>
        <filter id="bd-shadow" x="-10%" y="-10%" width="120%" height="130%">
          <feDropShadow dx="0" dy="14" stdDeviation="16" floodColor="#000" floodOpacity="0.45" />
        </filter>
        <clipPath id="bd-board">
          <rect x="40" y="40" width="520" height="340" rx="14" />
        </clipPath>
      </defs>

      {/* Dimensions */}
      <g className="bd-dim" stroke="var(--pcb-fg-subtle)" fill="var(--pcb-fg-subtle)" strokeWidth="0.75">
        <path d="M40 24 V16 M560 24 V16 M40 20 H560" fill="none" />
        <path d="M40 20 l6 -2.5 v5 z M560 20 l-6 -2.5 v5 z" stroke="none" />
        <text x="300" y="13" textAnchor="middle" stroke="none" className="bd-dim-text">
          52.00 mm
        </text>
        <path d="M576 40 H584 M576 380 H584 M580 40 V380" fill="none" />
        <path d="M580 40 l-2.5 6 h5 z M580 380 l-2.5 -6 h5 z" stroke="none" />
        <text x="592" y="210" textAnchor="middle" stroke="none" className="bd-dim-text" transform="rotate(90 592 210)">
          34.00 mm
        </text>
      </g>

      {/* Board */}
      <g className="bd-board">
        <rect x="40" y="40" width="520" height="340" rx="14" fill="url(#bd-mask)" filter="url(#bd-shadow)" />
        <g clipPath="url(#bd-board)">
          {/* Ground pour, hatched under the mask */}
          <rect x="40" y="40" width="520" height="340" fill="url(#bd-pour)" opacity="0.55" />
          <rect x="40.5" y="40.5" width="519" height="339" rx="13.5" fill="none" stroke="#d7c79a" strokeOpacity="0.35" />
        </g>
      </g>

      {/* Back copper (seen through the board) */}
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {TRACES.filter((t) => t.layer === 'B').map((t, i) => (
          <path key={i} d={t.d} stroke={BACK} strokeOpacity="0.55" strokeWidth={t.w ?? 3} pathLength={1} className="bd-trace" style={{ ['--i' as string]: i + 2 }} />
        ))}
      </g>

      {/* Front copper */}
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        {TRACES.filter((t) => t.layer !== 'B').map((t, i) => (
          <path
            key={i}
            d={t.d}
            stroke={t.net === 'usb' ? 'var(--pcb-trace)' : COPPER}
            strokeWidth={t.w ?? 3}
            pathLength={1}
            className="bd-trace"
            style={{ ['--i' as string]: i }}
          />
        ))}
        {/* Signal on the selected net */}
        {TRACES.filter((t) => t.net === 'usb').map((t, i) => (
          <path key={`sig${i}`} d={t.d} stroke="#ffe2cc" strokeWidth={2} pathLength={1} className="bd-signal" style={{ ['--i' as string]: i }} />
        ))}
      </g>

      {/* Vias */}
      <g className="bd-part">
        {VIAS.map(([x, y]) => (
          <g key={`${x},${y}`}>
            <circle cx={x} cy={y} r="4.2" fill={COPPER} />
            <circle cx={x} cy={y} r="1.8" fill="#0a0c0b" />
          </g>
        ))}
      </g>

      {/* Mounting holes and fiducials */}
      <g className="bd-part">
        {[
          [66, 66],
          [534, 66],
          [66, 354],
          [534, 354],
        ].map(([x, y]) => (
          <g key={`${x}${y}`}>
            <circle cx={x} cy={y} r="11" fill={PAD} />
            <circle cx={x} cy={y} r="6" fill="var(--pcb-page)" />
          </g>
        ))}
        {[
          [104, 352],
          [500, 66],
        ].map(([x, y]) => (
          <g key={`f${x}`}>
            <circle cx={x} cy={y} r="6" fill={MASK} stroke="#0b2a1c" />
            <circle cx={x} cy={y} r="2.6" fill={PAD} />
          </g>
        ))}
      </g>

      {/* J1: USB-C receptacle at the board edge */}
      <g className="bd-part">
        <rect x="30" y="168" width="62" height="84" rx="6" fill="url(#bd-metal)" stroke="#5f656b" />
        <rect x="36" y="196" width="10" height="28" rx="4" fill="#2a2d30" />
        {[182, 194, 206, 218, 230, 242].map((y) => (
          <rect key={y} x="94" y={y - 3} width="12" height="6" fill={PAD} />
        ))}
        <text x="62" y="160" textAnchor="middle" className="bd-silk-text">
          J1
        </text>
      </g>

      {/* U2: SOT-23-5 regulator */}
      <g className="bd-part">
        {[152, 160, 168].map((x) => (
          <rect key={x} x={x - 2.5} y="116" width="5" height="8" fill={PAD} />
        ))}
        {[154, 166].map((x) => (
          <rect key={x} x={x - 2.5} y="96" width="5" height="8" fill={PAD} />
        ))}
        <rect x="148" y="102" width="24" height="16" rx="1.5" fill="#17191a" />
        <text x="160" y="112.5" textAnchor="middle" className="bd-mark">
          3V3
        </text>
        <text x="132" y="113" textAnchor="middle" className="bd-silk-text">
          U2
        </text>
      </g>

      {/* U1: QFN-32 */}
      <g className="bd-part">
        {QFN_OFFSETS.map((o) => (
          <g key={o} fill={PAD}>
            <rect x={300 + o - 1.6} y="170" width="3.2" height="8" />
            <rect x={300 + o - 1.6} y="242" width="3.2" height="8" />
            <rect x="260" y={210 + o - 1.6} width="8" height="3.2" />
            <rect x="332" y={210 + o - 1.6} width="8" height="3.2" />
          </g>
        ))}
        <rect x="268" y="178" width="64" height="64" rx="2" fill="#17191a" stroke="#2c2f31" />
        <circle cx="276" cy="186" r="2" fill="#3a3e41" />
        <text x="300" y="207" textAnchor="middle" className="bd-mark">
          MCU
        </text>
        <text x="300" y="219" textAnchor="middle" className="bd-mark bd-mark-sm">
          QFN-32
        </text>
        {/* Silkscreen corner marks and pin-1 */}
        <path d="M256 174 V166 H264 M336 166 H344 V174 M344 246 V254 H336 M264 254 H256 V246" fill="none" stroke={SILK} strokeWidth="1.2" />
        <circle cx="252" cy="170" r="2" fill={SILK} />
        <text x="350" y="264" className="bd-silk-text">
          U1
        </text>
      </g>

      {/* Decoupling and load caps */}
      <Cap x={262} y={160} vertical label="C1" lx={244} ly={164} />
      <Cap x={346} y={160} vertical label="C2" lx={354} ly={164} />
      <Cap x={262} y={300} label="C3" lx={255} ly={318} />
      <Cap x={338} y={300} label="C4" lx={331} ly={318} />
      <Cap x={140} y={140} vertical label="C5" lx={116} ly={144} />

      {/* Y1: crystal */}
      <g className="bd-part">
        <rect x="279" y="291" width="10" height="18" fill={PAD} />
        <rect x="311" y="291" width="10" height="18" fill={PAD} />
        <rect x="284" y="292" width="32" height="16" rx="2" fill="url(#bd-metal)" stroke="#6b7177" />
        <text x="300" y="328" textAnchor="middle" className="bd-silk-text">
          Y1
        </text>
      </g>

      {/* R1, D1: status LED */}
      <g className="bd-part">
        <rect x="408" y="110.5" width="6" height="8" fill={PAD} />
        <rect x="426" y="110.5" width="6" height="8" fill={PAD} />
        <rect x="413" y="111.5" width="14" height="6" fill="#1d1f20" />
        <text x="420" y="104" textAnchor="middle" className="bd-silk-text">
          R1
        </text>
        <rect x="446" y="110" width="7" height="9" fill={PAD} />
        <rect x="468" y="110" width="7" height="9" fill={PAD} />
        <rect x="452" y="110.5" width="17" height="8" fill="#f0eee6" />
        <rect x="455" y="111.5" width="11" height="6" className="bd-led" />
        <path d="M444 106 H477 M444 123 H477 M444 106 V123" fill="none" stroke={SILK} strokeWidth="1" />
        <text x="461" y="102" textAnchor="middle" className="bd-silk-text">
          D1
        </text>
      </g>

      {/* SW1: reset */}
      <g className="bd-part">
        {(
          [
            [138, 298],
            [182, 298],
            [138, 322],
            [182, 322],
          ] as const
        ).map(([x, y]) => (
          <rect key={`${x}${y}`} x={x - 6} y={y - 4} width="12" height="8" fill={PAD} />
        ))}
        <rect x="142" y="292" width="36" height="36" rx="2" fill="#1b1d1e" stroke="#33373a" />
        <circle cx="160" cy="310" r="10" fill="#2a2d30" stroke="#44494d" />
        <text x="160" y="346" textAnchor="middle" className="bd-silk-text">
          SW1 RESET
        </text>
      </g>

      {/* J2: 1×6 header */}
      <g className="bd-part">
        <rect x="496" y="136" width="28" height="178" fill="none" stroke={SILK} strokeWidth="1.2" />
        {[150, 180, 210, 240, 270, 300].map((y, i) =>
          i === 0 ? (
            <g key={y}>
              <rect x="501" y={y - 9} width="18" height="18" fill={PAD} />
              <circle cx="510" cy={y} r="4.2" fill="#0a0c0b" />
            </g>
          ) : (
            <g key={y}>
              <circle cx="510" cy={y} r="9" fill={PAD} />
              <circle cx="510" cy={y} r="4.2" fill="#0a0c0b" />
            </g>
          ),
        )}
        <text x="510" y="128" textAnchor="middle" className="bd-silk-text">
          J2
        </text>
        {['3V3', 'TX', 'RX', 'SCL', 'SDA', 'GND'].map((n, i) => (
          <text key={n} x="532" y={153 + i * 30} className="bd-silk-text bd-silk-sm">
            {n}
          </text>
        ))}
      </g>

      {/* Board silkscreen */}
      <g className="bd-part">
        <text x="300" y="368" textAnchor="middle" className="bd-silk-text bd-silk-sm">
          USB-UART BRIDGE · REV B · JUMPER
        </text>
        <path d="M86 100 h12 l6 6 v12 h-18z" fill="none" stroke={SILK} strokeWidth="1" />
        <path d="M90 114 v-3 l4 -4 h3" fill="none" stroke="var(--pcb-trace)" strokeWidth="1.6" />
      </g>

      {/* Net label for the selected pair */}
      <g className="bd-callout">
        <path d="M228 199.5 V140" stroke="var(--pcb-trace)" strokeWidth="0.75" strokeDasharray="2 2" />
        <rect x="200" y="122" width="58" height="16" rx="1" fill="var(--pcb-page)" stroke="var(--pcb-trace)" strokeWidth="0.75" />
        <text x="229" y="133.5" textAnchor="middle" className="bd-net-text">
          USB_D±
        </text>
      </g>

      <style>{`
        .bd-silk-text { font: 500 9px var(--font-mono); fill: ${SILK}; letter-spacing: .04em; }
        .bd-silk-sm { font-size: 7px; opacity: .85; }
        .bd-mark { font: 500 8px var(--font-mono); fill: #8c9195; letter-spacing: .08em; }
        .bd-mark-sm { font-size: 6px; fill: #6b7075; }
        .bd-dim-text { font: 400 9px var(--font-mono); letter-spacing: .04em; }
        .bd-net-text { font: 500 8.5px var(--font-mono); fill: var(--pcb-trace); letter-spacing: .04em; }
        .bd-led { fill: var(--pcb-trace); animation: bd-led 2.4s ease-in-out infinite; }

        .bd-board { animation: bd-fade .9s cubic-bezier(.2,.7,0,1) both; }
        .bd-part { animation: bd-fade .7s cubic-bezier(.2,.7,0,1) .25s both; }
        .bd-dim { animation: bd-fade .7s ease .2s both; opacity: .7; }
        .bd-trace { stroke-dasharray: 1; stroke-dashoffset: 1; animation: bd-route .9s cubic-bezier(.6,0,.2,1) both; animation-delay: calc(500ms + var(--i) * 55ms); }
        .bd-signal { stroke-dasharray: .08 .92; stroke-dashoffset: 1; opacity: 0; animation: bd-signal 2.6s linear infinite; animation-delay: calc(1.8s + var(--i) * 140ms); }
        .bd-callout { animation: bd-fade .6s ease 1.6s both; }

        @keyframes bd-fade { from { opacity: 0; } }
        @keyframes bd-route { to { stroke-dashoffset: 0; } }
        @keyframes bd-signal { 0% { stroke-dashoffset: 1; opacity: 0; } 8% { opacity: 1; } 85% { opacity: 1; } 100% { stroke-dashoffset: 0; opacity: 0; } }
        @keyframes bd-led { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
        @media (prefers-reduced-motion: reduce) {
          .bd-trace { stroke-dasharray: none; stroke-dashoffset: 0; animation: none; }
          .bd-signal { display: none; }
          .bd-led, .bd-board, .bd-part, .bd-dim, .bd-callout { animation: none; }
        }
      `}</style>
    </svg>
  );
}

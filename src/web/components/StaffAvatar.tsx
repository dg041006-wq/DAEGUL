// 정장 차림 AI 직원 일러스트 (오리지널 2D 벡터). 실제 인물을 모방하지 않는다.
interface Props {
  suit: string;
  hair?: string;
  size?: number;
  working?: boolean;
  label?: string;
}

function shade(hex: string, amt: number) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, v + amt));
  const r = c((n >> 16) & 255), g = c((n >> 8) & 255), b = c(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

export function StaffAvatar({ suit, hair = "short", size = 120, working, label }: Props) {
  const lapel = shade(suit, -28);
  const tie = shade(suit, -45);
  const hairColor = "#2a221d";
  const skin = "#efd2b9";
  return (
    <svg viewBox="0 0 120 140" width={size} height={(size * 140) / 120} role="img" aria-label={label ?? "AI 직원"} className={working ? "avatar working" : "avatar"}>
      <defs>
        <clipPath id={`clip-${suit.slice(1)}-${hair}`}>
          <circle cx="60" cy="68" r="58" />
        </clipPath>
      </defs>
      <circle cx="60" cy="68" r="58" fill="var(--avatar-bg)" />
      <g clipPath={`url(#clip-${suit.slice(1)}-${hair})`}>
        {/* 뒷머리 (긴 머리/단발) */}
        {hair === "long" && <path d="M34 50 Q34 22 60 22 Q86 22 86 50 L90 96 L30 96 Z" fill={hairColor} />}
        {hair === "bob" && <path d="M33 52 Q33 22 60 22 Q87 22 87 52 L88 74 Q80 78 74 72 L46 72 Q40 78 32 74 Z" fill={hairColor} />}
        {/* 목 */}
        <rect x="52" y="70" width="16" height="16" rx="4" fill={shade(skin, -14)} />
        {/* 몸통: 정장 */}
        <path d="M14 140 Q16 100 40 92 L60 88 L80 92 Q104 100 106 140 Z" fill={suit} />
        {/* 셔츠 V */}
        <path d="M48 90 L60 118 L72 90 L60 86 Z" fill="#fbfaf7" />
        {/* 넥타이 */}
        <path d="M57 90 L63 90 L64 96 L61 99 L59 99 L56 96 Z" fill={tie} />
        <path d="M59 99 L61 99 L64 118 L60 123 L56 118 Z" fill={tie} />
        {/* 라펠 */}
        <path d="M40 92 L48 90 L60 120 L52 132 L46 112 L50 106 Z" fill={lapel} />
        <path d="M80 92 L72 90 L60 120 L68 132 L74 112 L70 106 Z" fill={lapel} />
        {/* 포켓스퀘어 */}
        <path d="M78 112 L88 110 L87 114 L79 116 Z" fill="var(--brass)" />
        {/* 얼굴 */}
        <ellipse cx="60" cy="54" rx="21" ry="24" fill={skin} />
        <ellipse cx="39.5" cy="56" rx="3.5" ry="5" fill={skin} />
        <ellipse cx="80.5" cy="56" rx="3.5" ry="5" fill={skin} />
        {/* 앞머리 */}
        {hair === "short" && <path d="M38 50 Q36 26 60 27 Q84 26 82 50 Q78 38 66 37 Q56 42 44 40 Q40 44 38 50 Z" fill={hairColor} />}
        {hair === "crop" && <path d="M39 46 Q40 28 60 28 Q80 28 81 46 Q72 36 60 36 Q48 36 39 46 Z" fill={hairColor} />}
        {hair === "side" && <path d="M38 52 Q34 26 62 26 Q86 28 82 50 Q80 40 72 36 Q60 44 46 38 Q41 44 38 52 Z" fill={hairColor} />}
        {(hair === "bob" || hair === "long") && <path d="M37 52 Q36 28 60 28 Q84 28 83 52 Q76 36 58 38 Q46 40 37 52 Z" fill={hairColor} />}
        {/* 눈·입 (차분한 표정) */}
        <ellipse cx="52" cy="56" rx="2" ry="2.4" fill="#2f2724" />
        <ellipse cx="68" cy="56" rx="2" ry="2.4" fill="#2f2724" />
        <path d="M48 50 Q52 48 56 50" stroke="#3b302a" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        <path d="M64 50 Q68 48 72 50" stroke="#3b302a" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        <path d="M55 67 Q60 70 65 67" stroke="#a5604f" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  );
}

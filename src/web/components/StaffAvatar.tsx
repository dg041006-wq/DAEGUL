// AI 직원 일러스트 — 가상의 성인 한국인 여성 캐릭터(오리지널 벡터). 실존 인물·사진을 사용하지 않는다.
// 세 캐릭터는 헤어(웨이브 롱 / 단발 / 업스타일)와 액세서리(진주 / 실버 / 골드)로 구분하고 화풍은 통일한다.
interface Props {
  suit: string;
  hair?: string; // wave | bob | updo | long | ponytail
  accent?: string; // pearl | silver | gold
  size?: number;
  working?: boolean;
  label?: string;
}

function shade(hex: string, amt: number) {
  const n = parseInt(hex.replace("#", ""), 16);
  const c = (v: number) => Math.max(0, Math.min(255, v + amt));
  const r = c((n >> 16) & 255),
    g = c((n >> 8) & 255),
    b = c(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

const HAIR = "#2b1d18";
const HAIR_HI = "#4a3229";
const SKIN = "#f3d9c6";
const SKIN_SH = "#e6c2aa";

export function StaffAvatar({ suit, hair = "wave", accent, size = 120, working, label }: Props) {
  const id = `${suit.replace("#", "")}${hair}`;
  const lapel = shade(suit, -26);
  const jacketHi = shade(suit, 18);
  const metal = accent === "gold" ? "#c9a24e" : accent === "silver" ? "#c7ccd3" : "#f4efe6";
  const blouse = accent === "gold" ? "#f6efe2" : accent === "silver" ? "#eef0f3" : "#fbf8f2";
  return (
    <svg viewBox="0 0 120 140" width={size} height={(size * 140) / 120} role="img" aria-label={label ?? "AI 직원"} className={working ? "avatar working" : "avatar"}>
      <defs>
        <clipPath id={`c-${id}`}>
          <circle cx="60" cy="68" r="58" />
        </clipPath>
        <linearGradient id={`bg-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--avatar-bg)" />
          <stop offset="1" stopColor="var(--avatar-bg2, var(--avatar-bg))" />
        </linearGradient>
        <linearGradient id={`hair-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={HAIR_HI} />
          <stop offset="0.6" stopColor={HAIR} />
        </linearGradient>
      </defs>
      <circle cx="60" cy="68" r="58" fill={`url(#bg-${id})`} />
      <g clipPath={`url(#c-${id})`}>
        {/* 뒷머리 */}
        {hair === "wave" && <path d="M33 50 Q30 22 60 20 Q90 22 87 50 Q90 70 94 86 Q88 100 78 98 L42 98 Q32 100 26 86 Q30 70 33 50 Z" fill={`url(#hair-${id})`} />}
        {hair === "long" && <path d="M34 50 Q32 22 60 21 Q88 22 86 50 L90 104 L30 104 Z" fill={`url(#hair-${id})`} />}
        {hair === "bob" && <path d="M33 54 Q31 22 60 21 Q89 22 87 54 Q88 70 84 78 Q74 82 70 74 L50 74 Q46 82 36 78 Q32 70 33 54 Z" fill={`url(#hair-${id})`} />}
        {hair === "updo" && (
          <>
            <circle cx="60" cy="20" r="11" fill={`url(#hair-${id})`} />
            <path d="M36 52 Q34 26 60 25 Q86 26 84 52 Q80 40 60 38 Q40 40 36 52 Z" fill={`url(#hair-${id})`} />
          </>
        )}
        {hair === "ponytail" && <path d="M80 34 Q98 44 92 80 Q88 70 84 52 Z" fill={`url(#hair-${id})`} />}

        {/* 목 */}
        <path d="M53 70 L67 70 L68 86 Q60 90 52 86 Z" fill={SKIN_SH} />
        {/* 블라우스 + 재킷 */}
        <path d="M12 140 Q14 104 38 95 L60 90 L82 95 Q106 104 108 140 Z" fill={suit} />
        <path d="M38 95 Q30 100 24 112 L22 140 L30 140 Q30 116 40 100 Z" fill={jacketHi} opacity="0.35" />
        <path d="M47 92 L60 112 L73 92 L60 88 Z" fill={blouse} />
        <path d="M53 90 Q60 99 67 90" stroke={shade(blouse, -22)} strokeWidth="1.1" fill="none" />
        {/* 라펠 (여성 재킷: 숄 라펠) */}
        <path d="M38 95 L48 91 Q52 104 60 118 L54 134 Q44 116 40 104 Z" fill={lapel} />
        <path d="M82 95 L72 91 Q68 104 60 118 L66 134 Q76 116 80 104 Z" fill={lapel} />
        <circle cx="60" cy="124" r="1.6" fill={metal} />
        {/* 목걸이 */}
        <path d="M51 88 Q60 97 69 88" stroke={metal} strokeWidth="1" fill="none" />
        <circle cx="60" cy="95" r="1.8" fill={metal} />

        {/* 얼굴 (부드러운 턱선) */}
        <path d="M39 50 Q39 30 60 29 Q81 30 81 50 Q81 66 70 75 Q65 79 60 79 Q55 79 50 75 Q39 66 39 50 Z" fill={SKIN} />
        <ellipse cx="38.5" cy="54" rx="3" ry="4.6" fill={SKIN_SH} />
        <ellipse cx="81.5" cy="54" rx="3" ry="4.6" fill={SKIN_SH} />
        {/* 귀걸이 */}
        <circle cx="38.6" cy="60" r={accent === "gold" ? 1.9 : 1.6} fill={metal} stroke={shade(metal, -40)} strokeWidth="0.3" />
        <circle cx="81.4" cy="60" r={accent === "gold" ? 1.9 : 1.6} fill={metal} stroke={shade(metal, -40)} strokeWidth="0.3" />

        {/* 앞머리 */}
        {hair === "wave" && <path d="M37 54 Q34 28 60 27 Q86 28 83 54 Q80 40 70 36 Q66 44 52 42 Q44 42 40 48 Q38 50 37 54 Z" fill={`url(#hair-${id})`} />}
        {hair === "long" && <path d="M38 52 Q36 28 60 27 Q84 28 82 52 Q76 38 62 37 Q48 37 38 52 Z" fill={`url(#hair-${id})`} />}
        {hair === "bob" && <path d="M37 56 Q35 27 60 27 Q85 27 83 56 Q82 44 76 40 L44 40 Q38 44 37 56 Z M44 40 Q52 47 60 46 Q68 47 76 40 Z" fill={`url(#hair-${id})`} />}
        {hair === "updo" && <path d="M39 50 Q40 33 60 32 Q80 33 81 50 Q74 38 64 39 Q58 41 50 40 Q43 42 39 50 Z" fill={`url(#hair-${id})`} />}
        {hair === "ponytail" && <path d="M39 50 Q40 30 60 29 Q80 30 81 50 Q72 37 60 37 Q48 37 39 50 Z" fill={`url(#hair-${id})`} />}
        {hair === "wave" && <path d="M33 60 Q30 74 34 86" stroke={HAIR_HI} strokeWidth="1.2" fill="none" opacity="0.6" />}

        {/* 눈썹 */}
        <path d="M46.5 48.5 Q51 46.6 55.5 48" stroke="#3b2a23" strokeWidth="1.3" fill="none" strokeLinecap="round" />
        <path d="M64.5 48 Q69 46.6 73.5 48.5" stroke="#3b2a23" strokeWidth="1.3" fill="none" strokeLinecap="round" />
        {/* 눈 + 속눈썹 */}
        <path d="M46.5 55 Q51 51.8 55.5 55 Q51 57 46.5 55 Z" fill="#fff" />
        <path d="M64.5 55 Q69 51.8 73.5 55 Q69 57 64.5 55 Z" fill="#fff" />
        <circle cx="51" cy="54.6" r="2.1" fill="#2a1e1a" />
        <circle cx="69" cy="54.6" r="2.1" fill="#2a1e1a" />
        <circle cx="51.7" cy="53.9" r="0.6" fill="#fff" />
        <circle cx="69.7" cy="53.9" r="0.6" fill="#fff" />
        <path d="M45.8 54.6 Q51 51 56 54.4" stroke="#1f1612" strokeWidth="1.1" fill="none" strokeLinecap="round" />
        <path d="M64 54.4 Q69 51 74.2 54.6" stroke="#1f1612" strokeWidth="1.1" fill="none" strokeLinecap="round" />
        {/* 코·볼·입술 */}
        <path d="M60 57 Q59 62 58.2 64 Q60 65 61.6 64" stroke={SKIN_SH} strokeWidth="1" fill="none" strokeLinecap="round" />
        <ellipse cx="47.5" cy="63" rx="4" ry="2.2" fill="#f2a9a0" opacity="0.35" />
        <ellipse cx="72.5" cy="63" rx="4" ry="2.2" fill="#f2a9a0" opacity="0.35" />
        <path d="M55 69 Q57.5 67.6 60 68.4 Q62.5 67.6 65 69 Q62.5 72.2 60 72.2 Q57.5 72.2 55 69 Z" fill="#c76a6a" />
        <path d="M55.6 69.1 Q60 70.2 64.4 69.1" stroke="#a85454" strokeWidth="0.5" fill="none" />
      </g>
    </svg>
  );
}

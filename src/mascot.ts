// Маскот ShredingerBox: кот-мальчик в коробке. Настроение повторяет состояние VPN:
//   sleep — VPN выключен: кот спрятался в коробку и спит;
//   peek  — VPN включён: выглядывает, оба глаза открыты;
//   wink  — подключаемся: один глаз открыт, другой закрыт — «и подключён, и нет».
// Те же рисунки лежат в src-tauri/icons/state-*.svg — из них сделаны иконки окна.
export type Mood = "sleep" | "peek" | "wink";

const OPEN_LEFT = `<ellipse cx="214" cy="256" rx="17" ry="21" fill="#F5B83D"/>
<ellipse cx="214" cy="258" rx="6" ry="14" fill="#151922"/>
<circle cx="221" cy="247" r="4.5" fill="#FFFFFF"/>`;
const OPEN_RIGHT = `<ellipse cx="298" cy="256" rx="17" ry="21" fill="#F5B83D"/>
<ellipse cx="298" cy="258" rx="6" ry="14" fill="#151922"/>
<circle cx="305" cy="247" r="4.5" fill="#FFFFFF"/>`;
const CLOSED_LEFT = `<path d="M197,258 Q214,272 231,258" fill="none" stroke="#232838" stroke-width="6" stroke-linecap="round"/>`;
const CLOSED_RIGHT = `<path d="M281,258 Q298,272 315,258" fill="none" stroke="#232838" stroke-width="6" stroke-linecap="round"/>`;

const EYES: Record<Mood, string> = {
  sleep: CLOSED_LEFT + CLOSED_RIGHT,
  peek: OPEN_LEFT + OPEN_RIGHT,
  wink: OPEN_LEFT + CLOSED_RIGHT,
};
// Насколько голова выше или ниже обычного: спящий утонул в коробке, бодрый вытянулся.
const LIFT: Record<Mood, number> = { sleep: 18, peek: -10, wink: 0 };

export function mascotSvg(mood: Mood): string {
  const paws = mood === "sleep" ? "" : `<rect x="158" y="272" width="48" height="32" rx="16" fill="#F3DCC8"/>
<rect x="306" y="272" width="48" height="32" rx="16" fill="#F3DCC8"/>
<path d="M174,276v10M190,276v10M322,276v10M338,276v10" stroke="#D9BFA9" stroke-width="3" stroke-linecap="round"/>`;
  const zzz = mood === "sleep"
    ? `<text x="372" y="168" font-family="Segoe UI, system-ui, sans-serif" font-size="44" font-weight="700" fill="#8B93A3">z</text>
<text x="404" y="124" font-family="Segoe UI, system-ui, sans-serif" font-size="60" font-weight="700" fill="#8B93A3">Z</text>`
    : "";
  return `<rect width="512" height="512" rx="112" fill="#1C212B"/>
<polygon points="96,290 150,290 110,238 52,262" fill="#343B4A"/>
<polygon points="416,290 362,290 402,238 460,262" fill="#343B4A"/>
<g transform="translate(0 ${LIFT[mood]})">
<polygon points="168,196 176,108 230,170" fill="#E4E8EF" stroke="#AEB6C4" stroke-width="5" stroke-linejoin="round"/>
<polygon points="344,196 336,108 282,170" fill="#E4E8EF" stroke="#AEB6C4" stroke-width="5" stroke-linejoin="round"/>
<polygon points="184,180 188,132 216,166" fill="#E9A7B5"/>
<polygon points="328,180 324,132 296,166" fill="#E9A7B5"/>
<ellipse cx="256" cy="252" rx="100" ry="88" fill="#F3DCC8"/>
<path d="M156,252 C150,172 208,150 256,150 C304,150 362,172 356,252 L342,224 L324,240 L304,206 L280,230 L256,200 L232,230 L208,206 L188,240 L170,224 Z" fill="#E4E8EF" stroke="#AEB6C4" stroke-width="5" stroke-linejoin="round"/>
${EYES[mood]}
<ellipse cx="184" cy="280" rx="14" ry="7" fill="#E9A7B5" opacity="0.7"/>
<ellipse cx="328" cy="280" rx="14" ry="7" fill="#E9A7B5" opacity="0.7"/>
<path d="M244,278 Q250,285 256,278 Q262,285 268,278" fill="none" stroke="#232838" stroke-width="4" stroke-linecap="round"/>
</g>
${zzz}
<rect x="96" y="290" width="320" height="140" rx="12" fill="#2A303C"/>
<rect x="96" y="290" width="320" height="12" fill="#3A4252"/>
${paws}
<text x="256" y="396" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="80" font-weight="700" fill="${mood === "sleep" ? "#5A6273" : "#3DDC97"}">?</text>`;
}

const LABEL: Record<Mood, string> = {
  sleep: "Маскот спит: VPN выключен",
  peek: "Маскот выглядывает: VPN включён",
  wink: "Маскот подмигивает: подключаемся",
};

export function mascot(size: number, mood: Mood = "wink"): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 512 512" role="img" aria-label="${LABEL[mood]}">${mascotSvg(mood)}</svg>`;
}

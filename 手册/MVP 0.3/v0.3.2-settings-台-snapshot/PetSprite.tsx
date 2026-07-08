import type { PetDefinition, PetState } from '@shared/types'

/**
 * 3 只原创 SVG 宠物：团子（奶油猫）、布丁（小鸡）、墨墨（小墨团）。
 * 眼睛/嘴巴随状态切换，肢体动画由外层 CSS 负责。
 */

interface SpriteProps {
  state: PetState
}

interface EyesProps {
  state: PetState
  cx1: number
  cx2: number
  cy: number
  color: string
  glint?: boolean
}

/** 状态化的眼睛：idle 圆眼 / happy 弯月 / sleepy 合眼 / attention 睁大 / thinking 上瞟 / failed 朝下 */
function Eyes({ state, cx1, cx2, cy, color, glint = true }: EyesProps): JSX.Element {
  if (state === 'sleepy') {
    return (
      <g stroke={color} strokeWidth={3.2} strokeLinecap="round" fill="none">
        <path d={`M${cx1 - 7} ${cy} q7 5 14 0`} />
        <path d={`M${cx2 - 7} ${cy} q7 5 14 0`} />
      </g>
    )
  }
  if (state === 'happy') {
    return (
      <g stroke={color} strokeWidth={3.6} strokeLinecap="round" fill="none">
        <path d={`M${cx1 - 7} ${cy + 2} q7 -9 14 0`} />
        <path d={`M${cx2 - 7} ${cy + 2} q7 -9 14 0`} />
      </g>
    )
  }
  if (state === 'failed') {
    // 失败：半闭、眼角朝下的沮丧眼（上弧线）
    return (
      <g stroke={color} strokeWidth={3.2} strokeLinecap="round" fill="none">
        <path d={`M${cx1 - 7} ${cy + 3} q7 -5 14 0`} />
        <path d={`M${cx2 - 7} ${cy + 3} q7 -5 14 0`} />
      </g>
    )
  }
  const r = state === 'attention' ? 6.5 : 5
  // thinking：圆眼但瞳孔上瞟一点（glint 偏移向上），像在琢磨
  if (state === 'thinking') {
    return (
      <g fill={color}>
        <circle cx={cx1} cy={cy} r={r} />
        <circle cx={cx2} cy={cy} r={r} />
        {glint && (
          <g fill="#FFFFFF" opacity={0.9}>
            <circle cx={cx1 + 1.6} cy={cy - 2.4} r={1.6} />
            <circle cx={cx2 + 1.6} cy={cy - 2.4} r={1.6} />
          </g>
        )}
      </g>
    )
  }
  return (
    <g fill={color}>
      <circle cx={cx1} cy={cy} r={r} />
      <circle cx={cx2} cy={cy} r={r} />
      {glint && (
        <g fill="#FFFFFF" opacity={0.9}>
          <circle cx={cx1 - 1.8} cy={cy - 1.8} r={1.6} />
          <circle cx={cx2 - 1.8} cy={cy - 1.8} r={1.6} />
        </g>
      )}
    </g>
  )
}

/** 团子：软乎乎的奶油小猫 */
function Dango({ state }: SpriteProps): JSX.Element {
  const line = '#4A3B32'
  return (
    <svg viewBox="0 0 140 140" width="100%" height="100%" role="img" aria-label="团子">
      {/* 耳朵 */}
      <path d="M32 64 Q24 24 62 42 Z" fill="#FFF4E3" stroke="#EED9BC" strokeWidth="3" strokeLinejoin="round" />
      <path d="M108 64 Q116 24 78 42 Z" fill="#FFF4E3" stroke="#EED9BC" strokeWidth="3" strokeLinejoin="round" />
      <path d="M38 58 Q34 36 54 46 Z" fill="#FFD9CC" />
      <path d="M102 58 Q106 36 86 46 Z" fill="#FFD9CC" />
      {/* 身体 */}
      <ellipse cx="70" cy="92" rx="52" ry="44" fill="#FFF4E3" stroke="#EED9BC" strokeWidth="3" />
      {/* 胡须 */}
      <g stroke="#E3C9A8" strokeWidth="2" strokeLinecap="round">
        <path d="M12 88 L28 90" />
        <path d="M13 98 L28 96" />
        <path d="M128 88 L112 90" />
        <path d="M127 98 L112 96" />
      </g>
      {/* 脸 */}
      <Eyes state={state} cx1={52} cx2={88} cy={88} color={line} />
      {state === 'happy' ? (
        <path d="M63 100 q7 9 14 0 z" fill="#E98973" />
      ) : (
        <path d="M64 100 q3 3 6 0 q3 3 6 0" stroke={line} strokeWidth="2.4" strokeLinecap="round" fill="none" />
      )}
      {/* 腮红 */}
      <ellipse cx="40" cy="101" rx="7" ry="4.5" fill="#FFC9B8" opacity="0.8" />
      <ellipse cx="100" cy="101" rx="7" ry="4.5" fill="#FFC9B8" opacity="0.8" />
    </svg>
  )
}

/** 布丁：圆滚滚的小鸡 */
function Pudding({ state }: SpriteProps): JSX.Element {
  const line = '#5A4632'
  return (
    <svg viewBox="0 0 140 140" width="100%" height="100%" role="img" aria-label="布丁">
      {/* 呆毛 */}
      <path d="M70 44 Q64 26 78 22" stroke="#EBB84F" strokeWidth="4" fill="none" strokeLinecap="round" />
      {/* 翅膀 */}
      <ellipse cx="24" cy="96" rx="10" ry="17" fill="#FFD36B" stroke="#EBB84F" strokeWidth="3" transform="rotate(14 24 96)" />
      <ellipse cx="116" cy="96" rx="10" ry="17" fill="#FFD36B" stroke="#EBB84F" strokeWidth="3" transform="rotate(-14 116 96)" />
      {/* 身体 */}
      <circle cx="70" cy="90" r="48" fill="#FFD36B" stroke="#EBB84F" strokeWidth="3" />
      <ellipse cx="70" cy="110" rx="30" ry="18" fill="#FFE9B0" />
      {/* 脸 */}
      <Eyes state={state} cx1={54} cx2={86} cy={84} color={line} />
      {state === 'happy' ? (
        <path d="M62 96 L78 96 L70 107 Z" fill="#F5A25D" stroke="#E08C43" strokeWidth="2" strokeLinejoin="round" />
      ) : (
        <path d="M64 95 L76 95 L70 103 Z" fill="#F5A25D" stroke="#E08C43" strokeWidth="2" strokeLinejoin="round" />
      )}
      {/* 腮红 */}
      <ellipse cx="42" cy="98" rx="7" ry="4.5" fill="#FFB88C" opacity="0.85" />
      <ellipse cx="98" cy="98" rx="7" ry="4.5" fill="#FFB88C" opacity="0.85" />
    </svg>
  )
}

/** 墨墨：安安静静的小墨团 */
function Momo({ state }: SpriteProps): JSX.Element {
  return (
    <svg viewBox="0 0 140 140" width="100%" height="100%" role="img" aria-label="墨墨">
      {/* 波浪底边的墨团身体 */}
      <path
        d="M22 98
           C22 62 42 42 70 42
           C98 42 118 62 118 98
           C118 110 111 119 104 114
           C100 123 91 126 87 119
           C81 127 59 127 53 119
           C49 126 40 123 36 114
           C29 119 22 110 22 98 Z"
        fill="#7C8DB0"
        stroke="#66779B"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      {/* 高光 */}
      <ellipse cx="52" cy="62" rx="14" ry="8" fill="#98A7C6" opacity="0.7" transform="rotate(-20 52 62)" />
      {/* 脸 */}
      <Eyes state={state} cx1={52} cx2={88} cy={88} color="#F4F7FF" glint={false} />
      {state === 'happy' ? (
        <path d="M63 102 q7 8 14 0" stroke="#2E3A52" strokeWidth="3" strokeLinecap="round" fill="none" />
      ) : (
        <path d="M66 102 q4 4 8 0" stroke="#2E3A52" strokeWidth="2.6" strokeLinecap="round" fill="none" />
      )}
      {/* 腮红 */}
      <ellipse cx="40" cy="100" rx="6.5" ry="4" fill="#9FB0D0" opacity="0.9" />
      <ellipse cx="100" cy="100" rx="6.5" ry="4" fill="#9FB0D0" opacity="0.9" />
    </svg>
  )
}

/**
 * image-pack 的状态素材 URL 选择 + fallback（对齐我们的 PetState，无独立 done）：
 * 优先当前状态；failed 缺失时退 attention；再不行退 idle。
 */
function resolveStateUrl(pet: PetDefinition, state: PetState): string | undefined {
  const s = pet.states
  if (!s) return undefined
  return s[state] ?? (state === 'failed' ? s.attention : undefined) ?? s.idle
}

interface PetSpriteProps {
  pet: PetDefinition
  state: PetState
}

export default function PetSprite({ pet, state }: PetSpriteProps): JSX.Element {
  // v0.3：皮肤包用 <img> 渲染当前状态素材；draggable=false 避免拖图片干扰桌宠拖拽
  if (pet.kind === 'image-pack') {
    const src = resolveStateUrl(pet, state)
    if (src) {
      return (
        <img className="pet-pack-image" src={src} draggable={false} alt={pet.name} />
      )
    }
    // 极端兜底：素材都缺，退回内置团子，保证不空白
    return <Dango state={state} />
  }
  // 内置 SVG 宠物：按 id 分派
  switch (pet.id) {
    case 'pudding':
      return <Pudding state={state} />
    case 'momo':
      return <Momo state={state} />
    case 'dango':
    default:
      return <Dango state={state} />
  }
}

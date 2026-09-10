# Values lifted from the running app

Source: `src/app/globals.css`, `src/components/modal.tsx`, `src/components/ui.tsx`,
`src/app/layout.tsx`. Copied exactly — no rounding to a 4/8px grid.

Surfaces   --bg #f4f9fc · --bg-subtle #eaf4fa · --panel #ffffff · --panel-2 #eef6fa
Borders    --border rgba(13,110,140,0.1) · --border-strong rgba(13,110,140,0.18)
Ink        --text #0f2536 · --muted #5c7386 · --muted-2 #8ba0b0
Brand      --accent #0ea5e9 · --accent-2 #22d3ee · --accent-soft rgba(14,165,233,0.1)
           --accent-ring rgba(14,165,233,0.25)
Semantic   --danger #e0455a / soft rgba(224,69,90,0.1)
           --warn #d98a2b / soft rgba(217,138,43,0.12)
           --ok #10b981 / soft rgba(16,185,129,0.12)

Shadows    --shadow-xs 0 1px 2px rgba(13,60,82,0.05)
           --shadow-sm 0 1px 2px rgba(13,60,82,0.04), 0 8px 20px -10px rgba(13,60,82,0.12)
           --shadow-md 0 2px 6px rgba(13,60,82,0.05), 0 20px 40px -14px rgba(13,60,82,0.16)

Easing     --ease-premium cubic-bezier(0.22, 1, 0.36, 1)

Type       Inter (next/font, self-hosted), JetBrains Mono for codes.
           Modal title 15px/600 tracking-tight. Body 14px. Table head 11px/600
           uppercase 0.06em, colour --muted-2. Stat label 11px uppercase 0.06em.
           Stat value 1.75rem/600 tabular-nums.

Geometry   .panel  radius 1rem (rounded-2xl), border 1px, shadow-sm
           .btn    radius 0.75rem, padding 0.5rem 0.875rem, 14px/500, shadow-xs
           .btn-primary linear-gradient(135deg, --accent, --accent-2), white text
           .input  radius 0.75rem, padding 0.5rem 0.875rem, bg --panel-2
                   focus: bg --panel, border --accent, ring 3px --accent-ring
           .surface-2 radius 0.75rem, bg --panel-2, border 1px --border
           Modal   max-width 36rem, header px-5 py-4 border-b, body p-5,
                   scrim rgba(10,20,30,0.35) + blur(3px), rise-in 0.18s
           Status badge radius-full, px 0.625rem, py 0.25rem, 12px/500, 6px dot

Icons      lucide-react, 2px stroke, round caps. Drawn inline here to match.

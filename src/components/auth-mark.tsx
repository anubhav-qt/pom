export function AuthMark() {
  return (
    <span
      className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl text-base font-bold text-white"
      style={{
        background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
        boxShadow: "0 8px 20px -6px color-mix(in srgb, var(--accent) 55%, transparent)",
      }}
      aria-hidden
    >
      P
    </span>
  );
}

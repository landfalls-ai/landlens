// The Landlens mark: a rounded square in the iris gradient with a lens ring, its centre, and a highlight.
export function Mark({ className = "mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="landlens-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#B4ACFF" />
          <stop offset="1" stopColor="#6C5EF0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#landlens-mark)" />
      <circle cx="16" cy="16" r="8.2" fill="none" stroke="#fff" strokeWidth="2.2" />
      <circle cx="16" cy="16" r="3" fill="#fff" />
      <path d="M11.2 12.6a6 6 0 0 1 3.6-2.4" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" opacity=".55" fill="none" />
    </svg>
  );
}

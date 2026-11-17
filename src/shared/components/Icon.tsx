export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    code: (
      <>
        <path d="m5 5-4 3 4 3m6-6 4 3-4 3M9 2 7 14" />
      </>
    ),
    repo: (
      <>
        <path d="M3 1.5h10v13H3a2 2 0 0 1 0-4h10M3 1.5v9M6 4h4" />
      </>
    ),
    issue: (
      <>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 4.5v4M8 11v.1" />
      </>
    ),
    pull: (
      <>
        <circle cx="4" cy="3" r="1.5" />
        <circle cx="4" cy="13" r="1.5" />
        <circle cx="12" cy="13" r="1.5" />
        <path d="M4 4.5v7M12 11.5V6a3 3 0 0 0-3-3H7m2-2L7 3l2 2" />
      </>
    ),
    branch: (
      <>
        <circle cx="4" cy="3" r="1.5" />
        <circle cx="4" cy="13" r="1.5" />
        <circle cx="12" cy="3" r="1.5" />
        <path d="M4 4.5v7M12 4.5A5.5 5.5 0 0 1 6.5 10H4" />
      </>
    ),
    history: (
      <>
        <path d="M2 5a6 6 0 1 1-0 6M2 1v4h4M8 4v4l3 2" />
      </>
    ),
    folder: <path d="M1 4h14v10H1zM1 4V2h5l2 2" />,
    file: (
      <>
        <path d="M3 1h6l4 4v10H3zM9 1v4h4" />
      </>
    ),
    plus: <path d="M8 2v12M2 8h12" />,
    settings: (
      <>
        <circle cx="8" cy="8" r="2.5" />
        <path d="m6 1-1 2-2 1-2 2 1 2-1 2 2 2 2 1 1 2h4l1-2 2-1 2-2-1-2 1-2-2-2-2-1-1-2z" />
      </>
    ),
    mcp: (
      <>
        <path d="m2 6 4-4a2 2 0 0 1 3 3l-5 5m3-3 3-3a2 2 0 0 1 3 3l-5 5 2 2M1 8l3 3" />
      </>
    ),
    search: (
      <>
        <circle cx="6.5" cy="6.5" r="4.5" />
        <path d="m10 10 4 4" />
      </>
    ),
    check: <path d="m2 8 4 4 8-9" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.file}
    </svg>
  );
}

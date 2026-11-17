import ReactMarkdown from "react-markdown";
export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      skipHtml
      components={{
        img: ({ alt }) => <span className="muted">[Image: {alt}]</span>,
        a: ({ children, href }) => (
          <a
            href={href?.startsWith("https://") ? href : undefined}
            target="_blank"
            rel="noreferrer"
          >
            {children}
          </a>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

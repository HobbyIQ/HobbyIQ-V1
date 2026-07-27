export function ComingSoon({ title, body }: { title: string; body: string }) {
  return (
    <div className="max-w-3xl mx-auto px-6 py-16">
      <div className="hiq-card p-10 text-center">
        <div
          className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold mb-6"
          style={{
            background: "color-mix(in oklab, var(--color-accent) 15%, transparent)",
            color: "var(--color-accent)",
          }}
        >
          COMING SOON
        </div>
        <h1 className="text-3xl font-bold mb-3">{title}</h1>
        <p className="text-[color:var(--color-muted)] leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

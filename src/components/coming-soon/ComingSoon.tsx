import { useEffect, type ReactNode } from 'react'
import './comingSoon.css'

/* ────────────────────────────────────────────────────────────────────────────
 * Configuration — the only things you should need to touch.
 * ────────────────────────────────────────────────────────────────────────── */

/** Community channels. Swap these for your real invite links before shipping. */
const SOCIALS: Array<{
  key: string
  label: string
  handle: string
  href: string
  icon: ReactNode
}> = [
  {
    key: 'telegram',
    label: 'Telegram',
    handle: 'Join the room',
    href: 'https://t.me/+MUnWYma5l9s5NGQ9',
    icon: <TelegramIcon />,
  },
  {
    key: 'discord',
    label: 'Discord',
    handle: 'Join the server',
    href: 'https://discord.gg/cQthYMAY5',
    icon: <DiscordIcon />,
  },
  {
    key: 'x',
    label: 'X',
    handle: 'Follow along',
    href: 'https://x.com/satoshistable',
    icon: <XIcon />,
  },
]

/* ────────────────────────────────────────────────────────────────────────── */

export function ComingSoon() {
  useEffect(() => {
    document.title = "Satoshi's Table — coming soon"
  }, [])

  return (
    <main className="cs" aria-label="Satoshi's Table — coming soon">
      <div className="cs-scrim cs-scrim--top" aria-hidden="true" />
      <div className="cs-scrim cs-scrim--bottom" aria-hidden="true" />

      {/* ── Hero ───────────────────────────────────────────── */}
      <header className="cs-top">
        <p className="cs-eyebrow cs-rise" style={delay(0)}>
          <span className="cs-eyebrow-dot" /> Coming soon · MMXXVI
        </p>

        <h1 className="cs-wordmark cs-rise" style={delay(1)}>
          Satoshi&rsquo;s Table
        </h1>
      </header>

      {/* ── Footer block: join the table ───────────────────── */}
      <footer className="cs-bottom">
        <div className="cs-rule cs-rise" aria-hidden="true" style={delay(2)}>
          <span className="cs-rule-line" />
          <span className="cs-rule-gem">◆</span>
          <span className="cs-rule-line" />
        </div>

        <div className="cs-cta cs-rise" style={delay(3)}>
          <div className="cs-join">
            <p className="cs-join-lead">Pull up a chair</p>
            <p className="cs-join-sub">Join the conversation</p>
          </div>

          <nav className="cs-socials" aria-label="Community channels">
            {SOCIALS.map((s) => (
              <a
                className="cs-social"
                key={s.key}
                href={s.href}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`${s.label} — ${s.handle}`}
              >
                <span className="cs-social-coin">{s.icon}</span>
                <span className="cs-social-meta">
                  <span className="cs-social-label">{s.label}</span>
                  <span className="cs-social-handle">{s.handle}</span>
                </span>
              </a>
            ))}
          </nav>
        </div>

        <p className="cs-foot cs-rise" style={delay(4)}>
          <span>© MMXXVI Satoshi&rsquo;s Table</span>
          <span className="cs-foot-sep">·</span>
          <span>Play responsibly</span>
          <span className="cs-foot-sep">·</span>
          <span>18+</span>
        </p>
      </footer>
    </main>
  )
}

/** Stagger helper — turns an index into an entrance delay. */
function delay(i: number) {
  return { animationDelay: `${0.15 + i * 0.12}s` } as const
}

/* ── Brand glyphs (inline SVG, 24×24) ─────────────────────────────────────── */

function TelegramIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"
      />
    </svg>
  )
}

function DiscordIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.291.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"
      />
    </svg>
  )
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
      />
    </svg>
  )
}

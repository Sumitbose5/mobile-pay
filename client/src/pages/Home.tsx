import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { formatPaise } from '@/lib/money';
import { cn } from '@/lib/utils';

/*
 * Design tokens (used as Tailwind arbitrary values below)
 *   ink      #0B2B2E  text + dark surfaces
 *   teal     #0E7C7B  primary brand, "connected" state
 *   marigold #F4A62A  calls to action
 *   mist     #EEF4F2  quiet section background
 *   paper    #FAFCFB  light surface
 *   slate    #4B6266  secondary text
 *   line     #D9E5E2  borders
 *
 * Type: Bricolage Grotesque (display) + Figtree (body).
 * Move FONT_CSS into index.css if you prefer; it is inlined here so the
 * component works as a drop-in.
 */
const FONT_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Figtree:wght@400..700&display=swap');
.mp-home { font-family: 'Figtree', ui-sans-serif, system-ui, sans-serif; color: #0B2B2E; }
.mp-display { font-family: 'Bricolage Grotesque', 'Figtree', ui-sans-serif, system-ui, sans-serif; letter-spacing: -0.025em; }
@keyframes mp-chip-in { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
@keyframes mp-draw { to { stroke-dashoffset: 0; } }
.mp-chip { animation: mp-chip-in .6s .5s cubic-bezier(.2,.8,.2,1) both; }
.mp-check { stroke-dasharray: 24; stroke-dashoffset: 24; animation: mp-draw .45s 1.05s ease-out forwards; }
@media (prefers-reduced-motion: reduce) {
  .mp-chip { animation: none; }
  .mp-check { animation: none; stroke-dashoffset: 0; }
}
`;

type Health = { success: boolean; data: { status: string; checks?: Record<string, string> } };
type ServiceState = 'up' | 'down' | 'pending';

async function fetchReady(): Promise<Health> {
  const res = await fetch('/health/ready');
  return res.json();
}

/* ------------------------------------------------------------------ */
/* SVG illustrations                                                   */
/* ------------------------------------------------------------------ */

const recentActivity = [
  { name: 'Rohan Mehta', note: 'Dinner split', amount: 45000n, dir: 'out' as const, initial: 'R' },
  { name: 'Ananya Rao', note: 'Rent share', amount: 250000n, dir: 'in' as const, initial: 'A' },
  { name: 'Metro recharge', note: 'Yesterday', amount: 30000n, dir: 'out' as const, initial: 'M' },
];

function PhoneIllustration() {
  return (
    <svg
      viewBox="0 0 320 560"
      className="h-auto w-full max-w-[300px]"
      role="img"
      aria-label="MobilePay app showing a wallet balance and recent payments"
    >
      {/* Device */}
      <rect x="8" y="8" width="304" height="544" rx="46" fill="#0B2B2E" />
      <rect x="18" y="18" width="284" height="524" rx="37" fill="#FAFCFB" />
      <rect x="122" y="28" width="76" height="20" rx="10" fill="#0B2B2E" />

      <text x="38" y="86" fontSize="15" fontWeight="600" fill="#0B2B2E">
        Wallet
      </text>

      {/* Balance card */}
      <rect x="34" y="104" width="252" height="150" rx="26" fill="#0E7C7B" />
      <circle cx="268" cy="124" r="64" fill="none" stroke="#FAFCFB" strokeOpacity="0.14" strokeWidth="1.5" />
      <circle cx="268" cy="124" r="40" fill="none" stroke="#FAFCFB" strokeOpacity="0.14" strokeWidth="1.5" />
      <text x="56" y="148" fontSize="13" fill="#FAFCFB" fillOpacity="0.8">
        Available balance
      </text>
      <text x="56" y="192" fontSize="34" fontWeight="700" fill="#FAFCFB" className="mp-display">
        {formatPaise(1250075n)}
      </text>
      <text x="56" y="232" fontSize="12" fill="#FAFCFB" fillOpacity="0.75">
        MobilePay wallet
      </text>

      {/* Actions */}
      <rect x="34" y="272" width="120" height="44" rx="22" fill="#F4A62A" />
      <text x="94" y="299" fontSize="14" fontWeight="700" fill="#0B2B2E" textAnchor="middle">
        Send
      </text>
      <rect x="166" y="272" width="120" height="44" rx="22" fill="#EEF4F2" stroke="#D9E5E2" />
      <text x="226" y="299" fontSize="14" fontWeight="700" fill="#0B2B2E" textAnchor="middle">
        Request
      </text>

      {/* Activity */}
      <text x="34" y="354" fontSize="13" fontWeight="700" fill="#0B2B2E">
        Recent activity
      </text>
      {recentActivity.map((tx, i) => {
        const cy = 392 + i * 56;
        return (
          <g key={tx.name}>
            <circle cx="52" cy={cy} r="18" fill={tx.dir === 'in' ? '#D7EFEA' : '#EEF4F2'} />
            <text x="52" y={cy + 5} fontSize="14" fontWeight="700" fill="#0E7C7B" textAnchor="middle">
              {tx.initial}
            </text>
            <text x="80" y={cy - 2} fontSize="13" fontWeight="600" fill="#0B2B2E">
              {tx.name}
            </text>
            <text x="80" y={cy + 14} fontSize="11" fill="#4B6266">
              {tx.note}
            </text>
            <text
              x="286"
              y={cy + 4}
              fontSize="13"
              fontWeight="700"
              textAnchor="end"
              fill={tx.dir === 'in' ? '#0E7C7B' : '#0B2B2E'}
            >
              {tx.dir === 'in' ? '+' : '−'}
              {formatPaise(tx.amount)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function SendIllustration() {
  return (
    <svg viewBox="0 0 360 120" className="h-auto w-full" aria-hidden="true">
      <circle cx="46" cy="76" r="26" fill="#F4A62A" />
      <text x="46" y="83" fontSize="20" fontWeight="700" fill="#0B2B2E" textAnchor="middle">
        Y
      </text>
      <circle cx="314" cy="76" r="26" fill="#FAFCFB" />
      <text x="314" y="83" fontSize="20" fontWeight="700" fill="#0B2B2E" textAnchor="middle">
        R
      </text>
      <path
        d="M78 70 C 130 6, 230 6, 278 66"
        fill="none"
        stroke="#FAFCFB"
        strokeOpacity="0.55"
        strokeWidth="2"
        strokeDasharray="2 7"
        strokeLinecap="round"
      />
      <path d="M270 58 L282 68 L267 72 Z" fill="#FAFCFB" fillOpacity="0.8" />
      <rect x="126" y="14" width="108" height="32" rx="16" fill="#F4A62A" />
      <text x="180" y="35" fontSize="14" fontWeight="700" fill="#0B2B2E" textAnchor="middle">
        {formatPaise(120000n)}
      </text>
    </svg>
  );
}

function HistoryIllustration() {
  const bars = [38, 62, 30, 78, 50, 92, 58];
  return (
    <svg viewBox="0 0 280 110" className="h-auto w-full" aria-hidden="true">
      {bars.map((h, i) => (
        <rect
          key={i}
          x={8 + i * 39}
          y={104 - h}
          width="26"
          height={h}
          rx="8"
          fill={i === 5 ? '#0E7C7B' : '#BFD8D3'}
        />
      ))}
      <line x1="0" y1="105" x2="280" y2="105" stroke="#D9E5E2" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 48 48" className="size-12" aria-hidden="true">
      <path
        d="M24 5 8 11v11c0 10 6.6 18.2 16 21 9.4-2.8 16-11 16-21V11L24 5Z"
        fill="#D7EFEA"
        stroke="#0E7C7B"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="m16.5 24.5 5 5 10-11" fill="none" stroke="#0E7C7B" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ReceiveIcon() {
  return (
    <svg viewBox="0 0 48 48" className="size-12" aria-hidden="true">
      <rect x="6" y="10" width="36" height="28" rx="8" fill="#FDECCB" stroke="#F4A62A" strokeWidth="2" />
      <path d="M24 17v13m0 0-5-5m5 5 5-5" fill="none" stroke="#0B2B2E" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

/** MobilePay home page with live service health checks. */
export function Home() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['health'],
    queryFn: fetchReady,
    retry: false,
  });
  const checks = data?.data.checks ?? {};
  const rows: { label: string; detail: string; state: ServiceState }[] = [
    {
      label: 'API server',
      detail: 'Handles payments and accounts',
      state: isError ? 'down' : isLoading ? 'pending' : 'up',
    },
    {
      label: 'PostgreSQL',
      detail: 'Stores balances and transactions',
      state: isLoading ? 'pending' : checks.database === 'up' ? 'up' : 'down',
    },
    {
      label: 'Redis',
      detail: 'Keeps sessions fast',
      state: isLoading ? 'pending' : checks.redis === 'up' ? 'up' : 'down',
    },
  ];

  const anyDown = rows.some((r) => r.state === 'down');
  const anyPending = rows.some((r) => r.state === 'pending');
  const summary = anyDown
    ? 'Some services are unreachable'
    : anyPending
      ? 'Checking services…'
      : 'All services are running';

  return (
    <div className="mp-home space-y-20 pb-8 md:space-y-28">
      <style>{FONT_CSS}</style>

      {/* Hero */}
      <section className="grid items-center gap-12 pt-4 lg:grid-cols-[1.15fr_0.85fr] lg:gap-8 lg:pt-10">
        <div className="max-w-xl space-y-8">
          <h1 className="mp-display text-5xl font-extrabold leading-[1.03] text-[#0B2B2E] sm:text-6xl lg:text-7xl">
            Pay anyone.
            <br />
            Track everything.
          </h1>
          <p className="max-w-md text-lg leading-relaxed text-[#4B6266]">
            MobilePay is a digital wallet for sending, receiving and keeping an eye on your money, all in one place.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button
              size="lg"
              asChild
              className="h-12 rounded-full bg-[#F4A62A] px-8 text-base font-bold text-[#0B2B2E] shadow-none hover:bg-[#F7B64C]"
            >
              <Link to="/register">Create your wallet</Link>
            </Button>
            <Button
              size="lg"
              variant="outline"
              asChild
              className="h-12 rounded-full border-[#0B2B2E]/20 bg-transparent px-8 text-base font-semibold text-[#0B2B2E] hover:bg-[#EEF4F2]"
            >
              <Link to="/login">Sign in</Link>
            </Button>
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-[340px] lg:max-w-none">
          <div className="absolute inset-x-4 inset-y-10 rounded-[2.5rem] bg-[#EEF4F2] lg:inset-x-10" aria-hidden="true" />
          <div className="relative flex justify-center">
            <PhoneIllustration />
          </div>
          {/* The one animated moment: a payment confirmation settles in. */}
          <div
            className="mp-chip absolute bottom-24 left-0 flex items-center gap-3 rounded-2xl border border-[#D9E5E2] bg-white py-3 pl-3 pr-5 shadow-[0_12px_32px_-12px_rgba(11,43,46,0.35)] sm:-left-4"
            role="status"
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-[#0E7C7B]">
              <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
                <path
                  className="mp-check"
                  d="m6 12.5 4 4 8-9"
                  fill="none"
                  stroke="#FAFCFB"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="text-sm leading-tight">
              <span className="block font-bold text-[#0B2B2E]">{formatPaise(120000n)} sent</span>
              <span className="text-[#4B6266]">to Rohan Mehta</span>
            </span>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="space-y-10">
        <div className="max-w-2xl space-y-3">
          <h2 className="mp-display text-3xl font-bold sm:text-4xl">Everything your money does, in one wallet</h2>
          <p className="text-[#4B6266]">Move money, get paid and look back at where it went.</p>
        </div>

        <div className="grid gap-5 md:grid-cols-12">
          {/* Send: dark, wide */}
          <article className="flex flex-col justify-between gap-8 rounded-[2rem] bg-[#0B2B2E] p-8 text-[#FAFCFB] md:col-span-7">
            <SendIllustration />
            <div className="space-y-2">
              <h3 className="mp-display text-2xl font-bold">Send money</h3>
              <p className="max-w-sm text-[#FAFCFB]/70">
                Pick a person, enter an amount and send. Funds reach any MobilePay user instantly.
              </p>
            </div>
          </article>

          {/* Receive */}
          <article className="flex flex-col justify-between gap-8 rounded-2xl border border-[#D9E5E2] bg-white p-8 md:col-span-5">
            <ReceiveIcon />
            <div className="space-y-2">
              <h3 className="mp-display text-2xl font-bold">Receive payments</h3>
              <p className="text-[#4B6266]">Collect from friends and family without sharing any bank details.</p>
            </div>
          </article>

          {/* Security */}
          <article className="flex flex-col justify-between gap-8 rounded-2xl border border-[#D9E5E2] bg-white p-8 md:col-span-5">
            <ShieldIcon />
            <div className="space-y-2">
              <h3 className="mp-display text-2xl font-bold">Protected by design</h3>
              <p className="text-[#4B6266]">Your balance only moves when you approve a payment.</p>
            </div>
          </article>

          {/* History: tinted, wide */}
          <article className="flex flex-col justify-between gap-8 rounded-[2rem] bg-[#EEF4F2] p-8 md:col-span-7">
            <HistoryIllustration />
            <div className="space-y-2">
              <h3 className="mp-display text-2xl font-bold">Full transaction history</h3>
              <p className="max-w-sm text-[#4B6266]">
                Every payment in one list, so you always know where your money went.
              </p>
            </div>
          </article>
        </div>
      </section>

      {/* Service status */}
      <section aria-labelledby="status-heading" className="rounded-2xl border border-[#D9E5E2] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#D9E5E2] px-6 py-5 sm:px-8">
          <div>
            <h2 id="status-heading" className="mp-display text-xl font-bold">
              Service status
            </h2>
            <p className="text-sm text-[#4B6266]">Live check of the services behind MobilePay</p>
          </div>
          <p
            className={cn(
              'rounded-full px-3.5 py-1.5 text-sm font-semibold',
              anyDown
                ? 'bg-destructive/10 text-destructive'
                : anyPending
                  ? 'bg-[#EEF4F2] text-[#4B6266]'
                  : 'bg-[#D7EFEA] text-[#0A5E5D]',
            )}
            role="status"
            aria-live="polite"
          >
            {summary}
          </p>
        </div>
        <ul className="grid divide-y divide-[#D9E5E2] md:grid-cols-3 md:divide-x md:divide-y-0">
          {rows.map((r) => (
            <li key={r.label} className="flex items-start gap-3 px-6 py-5 sm:px-8">
              <span
                className={cn(
                  'mt-1.5 inline-block size-2.5 shrink-0 rounded-full',
                  r.state === 'up' && 'bg-[#0E7C7B]',
                  r.state === 'down' && 'bg-destructive',
                  r.state === 'pending' && 'animate-pulse bg-[#4B6266]/50 motion-reduce:animate-none',
                )}
                aria-hidden="true"
              />
              <div className="min-w-0">
                <p className="font-semibold">{r.label}</p>
                <p className="text-sm text-[#4B6266]">{r.detail}</p>
                <p
                  className={cn(
                    'mt-1 text-sm font-semibold',
                    r.state === 'up' && 'text-[#0A5E5D]',
                    r.state === 'down' && 'text-destructive',
                    r.state === 'pending' && 'text-[#4B6266]',
                  )}
                >
                  {r.state === 'up' ? 'Connected' : r.state === 'down' ? 'Unreachable' : 'Checking'}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Closing call to action */}
      <section className="flex flex-col items-start justify-between gap-8 rounded-[2rem] bg-[#0E7C7B] p-8 text-[#FAFCFB] sm:p-12 md:flex-row md:items-center">
        <div className="max-w-lg space-y-3">
          <h2 className="mp-display text-3xl font-bold sm:text-4xl">Set up your wallet in a few minutes</h2>
          <p className="text-[#FAFCFB]/80">Create an account, add money and send your first payment.</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Button
            size="lg"
            asChild
            className="h-12 rounded-full bg-[#F4A62A] px-8 text-base font-bold text-[#0B2B2E] shadow-none hover:bg-[#F7B64C]"
          >
            <Link to="/register">Create your wallet</Link>
          </Button>
          <Link
            to="/login"
            className="rounded-sm text-base font-semibold underline decoration-[#FAFCFB]/50 underline-offset-4 hover:decoration-[#FAFCFB] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#FAFCFB]"
          >
            I already have an account
          </Link>
        </div>
      </section>
    </div>
  );
}
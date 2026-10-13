import { Link, NavLink, Outlet } from 'react-router-dom';
import { BrandStyles } from '@/components/common/BrandStyles';
import { NotificationBell } from '@/components/common/NotificationBell';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/auth/context';
import { cn } from '@/lib/utils';

const LOGO_URL =
  'https://res.cloudinary.com/dgxc8nspo/image/upload/v1791788542/Mobile_Pay__Dark_Glow_Logo-removebg-preview_ga7eja.png';

const links = [
  { to: '/dashboard', label: 'Wallet' },
  { to: '/transactions', label: 'Transactions' },
  { to: '/requests', label: 'Requests' },
  { to: '/beneficiaries', label: 'Beneficiaries' },
  { to: '/security', label: 'Security' },
];

/** Authenticated user shell; mounted under <RequireAuth /> so a user is always present. */
export function AppLayout() {
  const { user, logout } = useAuth();
  const initial = user?.name?.trim().charAt(0).toUpperCase() || '?';

  return (
    <div className="mp-home min-h-screen bg-[#F3F7F6]">
      <BrandStyles />

      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-[#F4A62A] focus:px-5 focus:py-2 focus:font-semibold focus:text-[#0B2B2E]"
      >
        Skip to content
      </a>

      <header className="sticky top-0 z-40 bg-[#0B2B2E] text-[#FAFCFB]">
        <nav
          className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 px-4 sm:px-6"
          aria-label="Main"
        >
          <Link
            to="/dashboard"
            className="flex h-16 shrink-0 items-center rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#F4A62A]"
          >
            <img src={LOGO_URL} alt="MobilePay" className="h-11 w-auto rounded-sm" />
          </Link>

          {/* Links: own row on small screens, inline from md up */}
          <div className="order-3 -mx-4 flex w-[calc(100%+2rem)] items-center gap-1 overflow-x-auto border-t border-white/10 px-4 py-2 sm:-mx-6 sm:w-[calc(100%+3rem)] sm:px-6 md:order-none md:mx-0 md:w-auto md:flex-1 md:border-0 md:px-0 md:py-0 md:pl-4">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                className={({ isActive }) =>
                  cn(
                    'shrink-0 whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold text-[#FAFCFB]/70 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#F4A62A]',
                    isActive && 'bg-white/15 text-white',
                  )
                }
              >
                {l.label}
              </NavLink>
            ))}
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
            {user?.role === 'ADMIN' && (
              <Button
                asChild
                size="sm"
                variant="outline"
                className="rounded-full border-[#F4A62A]/50 bg-transparent font-semibold text-[#F4A62A] hover:bg-[#F4A62A]/10 hover:text-[#F4A62A]"
              >
                <NavLink to="/admin">Admin</NavLink>
              </Button>
            )}

            {/* Bell is restyled from outside because it sits on a dark header */}
            <div className="text-[#FAFCFB] [&_button]:text-[#FAFCFB] [&_button]:hover:bg-black/15">
              <NotificationBell />
            </div>

            <div className="hidden items-center gap-2.5 pl-1 sm:flex">
              <span
                className="flex size-8 items-center justify-center rounded-full bg-[#F4A62A] text-sm font-bold text-[#0B2B2E]"
                aria-hidden="true"
              >
                {initial}
              </span>
              <span className="max-w-[10rem] truncate text-sm font-medium">{user?.name}</span>
            </div>

            <Button
              size="sm"
              variant="outline"
              onClick={() => void logout()}
              className="rounded-full border-white/25 bg-transparent font-semibold text-[#FAFCFB] hover:bg-white/10 hover:text-white cursor-pointer"
            >
              Log out
            </Button>
          </div>
        </nav>
      </header>

      <main id="main" className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        <Outlet />
      </main>
    </div>
  );
}
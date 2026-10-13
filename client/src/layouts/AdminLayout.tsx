import { Suspense } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { cn } from '@/lib/utils';

const links = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/transactions', label: 'Transactions' },
  { to: '/admin/audit-logs', label: 'Audit logs' },
  { to: '/admin/suspicious', label: 'Suspicious' },
  { to: '/admin/reconciliation', label: 'Reconciliation' },
];

/** Admin shell. Mounted under <RequireAuth role="ADMIN" />; the server re-checks the role on every request. */
export function AdminLayout() {
  return (
    <div className="min-h-screen">
      <header className="border-b bg-primary text-primary-foreground">
        <nav
          className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4"
          aria-label="Admin"
        >
          <Link to="/admin" className="flex items-center gap-2 font-semibold shrink-0">
            <img 
              src="https://res.cloudinary.com/dgxc8nspo/image/upload/v1791787578/Modern_Mobilepay_Logo_Banner_mley7r.png" 
              alt="MobilePay" 
              className="h-6 w-auto"
            />
            <span className="text-sm">Admin</span>
          </Link>

          <div className="flex h-full items-center gap-1 overflow-x-auto flex-1">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.end}
                className={({ isActive }) =>
                  cn(
                    'rounded-md px-3 py-1.5 text-sm opacity-75 hover:opacity-100',
                    isActive && 'bg-white/10 opacity-100',
                  )
                }
              >
                {l.label}
              </NavLink>
            ))}
          </div>

          <NavLink
            to="/dashboard"
            className="ml-auto shrink-0 rounded-md px-3 py-1.5 text-sm opacity-75 hover:opacity-100"
          >
            Back to wallet
          </NavLink>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading...</p>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}

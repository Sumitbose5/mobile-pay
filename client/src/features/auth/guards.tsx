import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './context';

function FullPageSpinner() {
  return (
    <div className="grid min-h-screen place-items-center" role="status" aria-label="Loading">
      <div className="size-8 animate-spin rounded-full border-2 border-muted border-t-accent" />
    </div>
  );
}

/** Logged-in users only; remembers where they were headed. */
export function RequireAuth({ role }: { role?: 'ADMIN' }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <FullPageSpinner />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (role && user.role !== role) return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}

/** Login/register pages bounce signed-in users to the app. */
export function GuestOnly() {
  const { user, loading } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (user) return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}

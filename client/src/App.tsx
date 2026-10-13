import { lazy } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { GuestOnly, RequireAuth } from '@/features/auth/guards';
import { AdminLayout } from '@/layouts/AdminLayout';
import { AppLayout } from '@/layouts/AppLayout';
import { PublicLayout } from '@/layouts/PublicLayout';
import { AddMoney } from '@/pages/AddMoney';
import { Beneficiaries } from '@/pages/Beneficiaries';
import { Requests } from '@/pages/Requests';
import { ResetPin } from '@/pages/ResetPin';
import { Withdraw } from '@/pages/Withdraw';
import { Dashboard } from '@/pages/Dashboard';
import { ForgotPassword } from '@/pages/ForgotPassword';
import { Home } from '@/pages/Home';
import { Notifications } from '@/pages/Notifications';
import { Login } from '@/pages/Login';
import { PayGateway } from '@/pages/PayGateway';
import { NotFound } from '@/pages/NotFound';
import { Register } from '@/pages/Register';
import { ResetPassword } from '@/pages/ResetPassword';
import { SendMoney } from '@/pages/SendMoney';
import { TransactionDetail } from '@/pages/TransactionDetail';
import { Transactions } from '@/pages/Transactions';
import { Security } from '@/pages/Security';
import { VerifyEmail } from '@/pages/VerifyEmail';

// Admin screens are only ever needed by administrators, so they load on demand instead of weighing down everyone's bundle.
const AdminAudit = lazy(() =>
  import('@/pages/admin/AdminAudit').then((m) => ({ default: m.AdminAudit })),
);
const AdminDashboard = lazy(() =>
  import('@/pages/admin/AdminDashboard').then((m) => ({ default: m.AdminDashboard })),
);
const AdminReconciliation = lazy(() =>
  import('@/pages/admin/AdminReconciliation').then((m) => ({ default: m.AdminReconciliation })),
);
const AdminTransactionDetail = lazy(() =>
  import('@/pages/admin/AdminTransactionDetail').then((m) => ({
    default: m.AdminTransactionDetail,
  })),
);
const AdminTransactions = lazy(() =>
  import('@/pages/admin/AdminTransactions').then((m) => ({ default: m.AdminTransactions })),
);
const AdminUserDetail = lazy(() =>
  import('@/pages/admin/AdminUserDetail').then((m) => ({ default: m.AdminUserDetail })),
);
const AdminUsers = lazy(() =>
  import('@/pages/admin/AdminUsers').then((m) => ({ default: m.AdminUsers })),
);

const router = createBrowserRouter([
  {
    element: <PublicLayout />,
    children: [
      { path: '/', element: <Home /> },
      // Link targets from emails work whether or not the user is signed in.
      { path: '/verify-email', element: <VerifyEmail /> },
      { path: '/reset-password', element: <ResetPassword /> },
      {
        element: <GuestOnly />,
        children: [
          { path: '/login', element: <Login /> },
          { path: '/register', element: <Register /> },
          { path: '/forgot-password', element: <ForgotPassword /> },
        ],
      },
    ],
  },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { path: '/dashboard', element: <Dashboard /> },
          { path: '/wallet/add', element: <AddMoney /> },
          { path: '/send', element: <SendMoney /> },
          { path: '/wallet/withdraw', element: <Withdraw /> },
          { path: '/requests', element: <Requests /> },
          { path: '/beneficiaries', element: <Beneficiaries /> },
          { path: '/reset-pin', element: <ResetPin /> },
          { path: '/transactions', element: <Transactions /> },
          { path: '/notifications', element: <Notifications /> },
          { path: '/transactions/:id', element: <TransactionDetail /> },
          { path: '/pay/:id', element: <PayGateway /> },
          { path: '/security', element: <Security /> },
        ],
      },
    ],
  },
  {
    path: '/admin',
    element: <RequireAuth role="ADMIN" />,
    children: [
      {
        element: <AdminLayout />,
        children: [
          { index: true, element: <AdminDashboard /> },
          { path: 'users', element: <AdminUsers /> },
          { path: 'users/:id', element: <AdminUserDetail /> },
          { path: 'transactions', element: <AdminTransactions /> },
          { path: 'transactions/:id', element: <AdminTransactionDetail /> },
          { path: 'audit-logs', element: <AdminAudit /> },
          { path: 'suspicious', element: <AdminAudit suspicious /> },
          { path: 'reconciliation', element: <AdminReconciliation /> },
        ],
      },
    ],
  },
  { path: '*', element: <PublicLayout />, children: [{ path: '*', element: <NotFound /> }] },
]);

export default function App() {
  return <RouterProvider router={router} />;
}

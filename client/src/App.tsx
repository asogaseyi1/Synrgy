import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router';
import { api, atLeast, type Role } from './api.ts';
import { AuthProvider, useAuth } from './auth.tsx';
import { Brand } from './Brand.tsx';
import { AcceptInvitePage, LoginPage, RegisterPage } from './pages/AuthPages.tsx';
import { ClockPage } from './pages/ClockPage.tsx';
import { APPROVALS_CHANGED, ApprovalsPage, MyRequestsPage, NewRequestPage } from './pages/ExceptionPages.tsx';
import { MembersPage } from './pages/MembersPage.tsx';
import { TeamPage, TimesheetPage } from './pages/TimePages.tsx';

function RequireAuth({ min, children }: { min?: Role; children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <p className="loading">Loading…</p>;
  if (!me) return <Navigate to="/login" replace />;
  if (min && !atLeast(me.user.role, min)) return <Navigate to="/" replace />;
  return children;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <p className="loading">Loading…</p>;
  return me ? <Navigate to="/" replace /> : children;
}

/** Pending approvals for the nav badge; refreshed on navigation, decisions, and every minute. */
function usePendingApprovals(enabled: boolean) {
  const [count, setCount] = useState(0);
  const location = useLocation();
  useEffect(() => {
    if (!enabled) return;
    const load = () =>
      api
        .get<{ pending: number }>('/exceptions/review-count')
        .then((r) => setCount(r.pending))
        .catch(() => {});
    void load();
    const id = setInterval(load, 60_000);
    window.addEventListener(APPROVALS_CHANGED, load);
    return () => {
      clearInterval(id);
      window.removeEventListener(APPROVALS_CHANGED, load);
    };
  }, [enabled, location.pathname]);
  return count;
}

function Layout() {
  const { me, logout } = useAuth();
  const pending = usePendingApprovals(!!me && atLeast(me.user.role, 'manager'));
  if (!me) return null;
  const role = me.user.role;
  return (
    <div className="shell">
      <header>
        <div>
          <Brand />
          <span className="org">{me.organization.name}</span>
        </div>
        <nav>
          <NavLink to="/" end>
            Clock
          </NavLink>
          <NavLink to="/timesheet">Timesheet</NavLink>
          <NavLink to="/requests">Requests</NavLink>
          {atLeast(role, 'manager') && <NavLink to="/team">Team</NavLink>}
          {atLeast(role, 'manager') && (
            <NavLink to="/approvals">
              Approvals{pending > 0 && <span className="count">{pending}</span>}
            </NavLink>
          )}
          {atLeast(role, 'admin') && <NavLink to="/people">People</NavLink>}
        </nav>
        <div className="user-chip">
          <span className="avatar" title={`${me.user.firstName} ${me.user.lastName} · ${role}`}>
            {me.user.firstName[0]}
            {me.user.lastName[0]}
          </span>
          <button className="link" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
          <Route path="/register" element={<GuestOnly><RegisterPage /></GuestOnly>} />
          <Route path="/invite/:token" element={<GuestOnly><AcceptInvitePage /></GuestOnly>} />
          <Route element={<RequireAuth><Layout /></RequireAuth>}>
            <Route index element={<ClockPage />} />
            <Route path="timesheet" element={<TimesheetPage />} />
            <Route path="requests" element={<MyRequestsPage />} />
            <Route path="requests/new" element={<NewRequestPage />} />
            <Route path="approvals" element={<RequireAuth min="manager"><ApprovalsPage /></RequireAuth>} />
            <Route path="team" element={<RequireAuth min="manager"><TeamPage /></RequireAuth>} />
            <Route path="team/:userId" element={<RequireAuth min="manager"><TimesheetPage /></RequireAuth>} />
            <Route path="people" element={<RequireAuth min="admin"><MembersPage /></RequireAuth>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

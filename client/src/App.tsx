import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes } from 'react-router';
import { atLeast, type Role } from './api.ts';
import { AuthProvider, useAuth } from './auth.tsx';
import { Brand } from './Brand.tsx';
import { useCounts } from './counts.ts';
import { ApprovalsPage } from './pages/ApprovalsPage.tsx';
import { AcceptInvitePage, LoginPage, RegisterPage } from './pages/AuthPages.tsx';
import { ClockPage } from './pages/ClockPage.tsx';
import { MyRequestsPage, NewRequestPage } from './pages/ExceptionPages.tsx';
import { MembersPage } from './pages/MembersPage.tsx';
import { SchedulePage } from './pages/SchedulePage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';
import { SwapsPage } from './pages/SwapPages.tsx';
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

const Count = ({ n }: { n: number }) => (n > 0 ? <span className="count">{n}</span> : null);

function Layout() {
  const { me, logout } = useAuth();
  const isManager = !!me && atLeast(me.user.role, 'manager');
  const counts = useCounts(isManager);
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
          <NavLink to="/schedule">Schedule</NavLink>
          <NavLink to="/swaps">
            Swaps
            <Count n={counts.swapIncoming} />
          </NavLink>
          <NavLink to="/timesheet">Timesheet</NavLink>
          <NavLink to="/requests">Requests</NavLink>
          {isManager && <NavLink to="/team">Team</NavLink>}
          {isManager && (
            <NavLink to="/approvals">
              Approvals
              <Count n={counts.exceptions + counts.swapReview} />
            </NavLink>
          )}
          {atLeast(role, 'admin') && <NavLink to="/people">People</NavLink>}
        </nav>
        <div className="user-chip">
          {atLeast(role, 'admin') && (
            <NavLink to="/settings" className="icon-link" title="Workspace settings" aria-label="Workspace settings">
              ⚙
            </NavLink>
          )}
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
            <Route path="schedule" element={<SchedulePage />} />
            <Route path="swaps" element={<SwapsPage />} />
            <Route path="timesheet" element={<TimesheetPage />} />
            <Route path="requests" element={<MyRequestsPage />} />
            <Route path="requests/new" element={<NewRequestPage />} />
            <Route path="approvals" element={<RequireAuth min="manager"><ApprovalsPage /></RequireAuth>} />
            <Route path="team" element={<RequireAuth min="manager"><TeamPage /></RequireAuth>} />
            <Route path="team/:userId" element={<RequireAuth min="manager"><TimesheetPage /></RequireAuth>} />
            <Route path="people" element={<RequireAuth min="admin"><MembersPage /></RequireAuth>} />
            <Route path="settings" element={<RequireAuth min="admin"><SettingsPage /></RequireAuth>} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}

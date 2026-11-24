import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, NavLink, Outlet, Route, Routes } from 'react-router';
import { atLeast, type Role } from './api.ts';
import { AuthProvider, useAuth } from './auth.tsx';
import { AcceptInvitePage, LoginPage, RegisterPage } from './pages/AuthPages.tsx';
import { ClockPage } from './pages/ClockPage.tsx';
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

function Layout() {
  const { me, logout } = useAuth();
  if (!me) return null;
  const role = me.user.role;
  return (
    <div className="shell">
      <header>
        <div className="brand">
          Synrgy <span className="muted">· {me.organization.name}</span>
        </div>
        <nav>
          <NavLink to="/" end>
            Clock
          </NavLink>
          <NavLink to="/timesheet">Timesheet</NavLink>
          {atLeast(role, 'manager') && <NavLink to="/team">Team</NavLink>}
          {atLeast(role, 'admin') && <NavLink to="/people">People</NavLink>}
        </nav>
        <button className="link" onClick={() => void logout()}>
          Sign out
        </button>
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

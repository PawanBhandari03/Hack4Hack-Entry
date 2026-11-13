import { BrowserRouter, Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { AppProvider } from './state.jsx';
import { useApp } from './appContext.js';
import Auth from './pages/Auth.jsx';
import Board from './pages/Board.jsx';
import TeamPage from './pages/Team.jsx';
import Profile from './pages/Profile.jsx';
import { Spinner } from './components/common.jsx';

function Header() {
  const { user, logout, connected, mine } = useApp();
  return (
    <header className="topbar">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Link to="/" className="brand" aria-label="TeamUp home">
        <span className="brand-mark" aria-hidden="true">
          H4
        </span>
        <span>TeamUp</span>
      </Link>
      {user && (
        <nav aria-label="Main" className="nav">
          <NavLink to="/" end>
            Board
          </NavLink>
          {mine?.team && <NavLink to={`/teams/${mine.team.id}`}>My team</NavLink>}
          <NavLink to="/profile">Profile</NavLink>
          <span className={`live-dot ${connected ? 'on' : ''}`} title={connected ? 'Live updates on' : 'Reconnecting…'}>
            <span className="sr-only">{connected ? 'Live updates connected' : 'Live updates reconnecting'}</span>
          </span>
          <button className="btn btn-ghost btn-sm" onClick={logout}>
            Log out
          </button>
        </nav>
      )}
    </header>
  );
}

function Protected({ children }) {
  const { user, token, booting } = useApp();
  if (booting || (token && !user)) return <Spinner />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <AppProvider>
        <Header />
        <Routes>
          <Route path="/login" element={<Auth mode="login" />} />
          <Route path="/register" element={<Auth mode="register" />} />
          <Route path="/" element={<Protected><Board /></Protected>} />
          <Route path="/teams/:teamId" element={<Protected><TeamPage /></Protected>} />
          <Route path="/profile" element={<Protected><Profile /></Protected>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppProvider>
    </BrowserRouter>
  );
}

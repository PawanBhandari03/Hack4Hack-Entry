import { BrowserRouter, Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppProvider } from './state.jsx';
import { useApp } from './appContext.js';
import Auth from './pages/Auth.jsx';
import Board from './pages/Board.jsx';
import TeamPage from './pages/Team.jsx';
import Profile from './pages/Profile.jsx';
import { Spinner } from './components/common.jsx';

const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

function Header() {
  const { user, logout, connected, mine, hackathon } = useApp();
  const { pathname } = useLocation();
  const compact = pathname !== '/' && pathname !== '/login' && pathname !== '/register';
  return (
    <header>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="dateline">
        <div className="wrap">
          <div className="dateline-left">
            <span className="date">{today}</span>
            {user && (
              <span className={`live ${connected ? 'on' : ''}`} title={connected ? 'Live updates on' : 'Reconnecting…'}>
                {connected ? 'Live edition' : 'Reconnecting'}
                <span className="sr-only">{connected ? ': live updates connected' : ': live updates reconnecting'}</span>
              </span>
            )}
          </div>
          {user ? (
            <nav aria-label="Main" className="nav">
              <NavLink to="/" end>
                Board
              </NavLink>
              {mine?.team && <NavLink to={`/teams/${mine.team.id}`}>My team</NavLink>}
              <NavLink to="/profile">
                <span className="user-chip">{user.name.split(' ')[0]}</span>
              </NavLink>
              <button onClick={logout}>Log out</button>
            </nav>
          ) : (
            <span>{hackathon?.name ?? 'Hack4Hack'}</span>
          )}
        </div>
      </div>
      <div className={`nameplate wrap ${compact ? 'compact' : ''}`}>
        {!compact && (
          <div className="nameplate-tags" aria-hidden="true">
            <span className="seal">Hack4Hack 2026</span>
            <span className="seal">Vol. I · Team desk</span>
            <span className="seal">Race-proof since day one</span>
          </div>
        )}
        <Link to="/" className="brand-title" aria-label="TeamUp home">
          Team<em>Up</em>
        </Link>
        {!compact && <p className="motto">The live classifieds of the hackathon: find your people, fill the last seat, fairly.</p>}
      </div>
      <div className="wrap">
        <hr className="double-rule" />
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="site-foot">
      <div className="wrap">
        <span>TeamUp · Hack4Hack Crew Hiring Challenge 2026 · Problem statement 1</span>
        <span>Every seat claimed in a MongoDB transaction · live over WebSockets</span>
      </div>
    </footer>
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
        <Footer />
      </AppProvider>
    </BrowserRouter>
  );
}

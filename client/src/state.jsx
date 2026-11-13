/**
 * App-wide state: logged-in user, the current hackathon, "my state" (my team, my requests),
 * the Socket.io connection and toast notifications.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, API_URL, tokenStore, errorText } from './api.js';

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export function AppProvider({ children }) {
  const [token, setToken] = useState(() => tokenStore.get());
  const [user, setUser] = useState(null);
  const [hackathon, setHackathon] = useState(null);
  const [mine, setMine] = useState(null); // { me, team, pendingRequests }
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [booting, setBooting] = useState(true);
  const toastId = useRef(0);

  const toast = useCallback((text, kind = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  const toastError = useCallback((err) => toast(errorText(err), 'error'), [toast]);

  const login = useCallback((t, u) => {
    tokenStore.set(t);
    setToken(t);
    setUser(u);
  }, []);

  const logout = useCallback(() => {
    tokenStore.set(null);
    setToken(null);
    setUser(null);
    setMine(null);
  }, []);

  useEffect(() => {
    const onExpired = () => logout();
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, [logout]);

  // Load hackathon (public) + me (if logged in).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { items } = await api('/api/hackathons');
        if (!cancelled) setHackathon(items[0] ?? null);
        if (token) {
          const { user: u } = await api('/api/auth/me');
          if (!cancelled) setUser(u);
        }
      } catch {
        /* handled by auth:expired or shown as empty state */
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const refreshMine = useCallback(async () => {
    if (!hackathon || !token) return;
    try {
      setMine(await api(`/api/hackathons/${hackathon.id}/me`));
    } catch {
      /* ignore */
    }
  }, [hackathon, token]);

  useEffect(() => {
    refreshMine();
  }, [refreshMine]);

  // One socket per login session.
  useEffect(() => {
    if (!token) return;
    const s = io(API_URL, { auth: { token }, transports: ['websocket', 'polling'] });
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    setSocket(s);
    return () => {
      s.close();
      setSocket(null);
      setConnected(false);
    };
  }, [token]);

  // Private notifications.
  useEffect(() => {
    if (!socket) return;
    const onMe = () => refreshMine();
    const onNotify = (n) => {
      if (n.type === 'join_request') toast(`${n.from} asked to join your team`);
      if (n.type === 'request_accepted') toast(`You're in! ${n.teamName} accepted your request`, 'success');
      if (n.type === 'request_declined') toast(`${n.teamName} declined your request`);
    };
    socket.on('me:updated', onMe);
    socket.on('notify', onNotify);
    socket.on('connect', onMe); // after a reconnect, resync anything we missed
    return () => {
      socket.off('me:updated', onMe);
      socket.off('notify', onNotify);
      socket.off('connect', onMe);
    };
  }, [socket, refreshMine, toast]);

  const value = useMemo(
    () => ({ token, user, setUser, hackathon, mine, refreshMine, socket, connected, login, logout, toast, toastError, booting }),
    [token, user, hackathon, mine, refreshMine, socket, connected, login, logout, toast, toastError, booting]
  );

  return (
    <AppCtx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </AppCtx.Provider>
  );
}

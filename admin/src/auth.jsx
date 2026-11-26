import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler, wp } from './api';

const AuthContext = createContext(null);
const STAFF = ['administrator', 'shop_manager', 'editor', 'author'];

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  const logout = useCallback(() => { setToken(null); setUser(null); }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!getToken()) { setReady(true); return; }
    api.get(wp('users/me'))
      .then((u) => setUser(u))
      .catch(() => setToken(null))
      .finally(() => setReady(true));
  }, [logout]);

  const login = async (username, password) => {
    const r = await api.post('jwt-auth/v1/token', { username, password });
    if (!STAFF.includes(r.user_role)) throw new Error('This account does not have access to the dashboard.');
    setToken(r.token);
    setUser(await api.get(wp('users/me')));
  };

  const role = user ? (user.roles || [])[0] : null;
  const can = (what) => {
    if (!role) return false;
    if (role === 'administrator') return true;
    const map = {
      shop: ['shop_manager'],
      content: ['shop_manager', 'editor', 'author'],
      settings: [],
      users: ['shop_manager'],
    };
    return (map[what] || []).includes(role);
  };

  return <AuthContext.Provider value={{ user, ready, login, logout, role, can }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
